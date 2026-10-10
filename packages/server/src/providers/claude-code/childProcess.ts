import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { resolveSpawnTarget } from './windowsSpawn.js';

/**
 * Child-process lifecycle for the Claude Code adapter.
 *
 * Split out from the adapter because killing a process reliably on Windows is a
 * problem in its own right, and because FR-M9 (cancel) and FR-M8 (timeout) both
 * depend on it working. If this is wrong, a cancelled run leaves a model call
 * billing in the background — the failure is invisible and it costs money.
 */

/**
 * `child.kill()` does not kill descendants on Windows.
 *
 * Node's `kill` maps to `TerminateProcess` on the direct child only. The CLI
 * shells out (ripgrep, git, whatever a tool call needs), and those grandchildren
 * survive, holding the pipes open — so the adapter's stdout stream never ends
 * and a cancelled assignment hangs instead of finishing. `taskkill /T` walks the
 * tree, which is the only thing that actually stops it.
 *
 * POSIX gets the same guarantee from a process group: `detached: true` makes the
 * child a group leader, and killing `-pid` signals the whole group.
 */
/*
 * Typed against `ChildProcess` rather than `ChildProcessWithoutNullStreams`
 * because only `pid`/`exitCode`/`signalCode`/`kill` are touched, and the auth
 * preflight in `resolveBinary.ts` needs the same tree kill for a child it
 * spawned without the full pipe triple.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    // Fire-and-forget: taskkill failing means the tree is already gone, which is
    // the outcome we wanted. Surfacing that as an error would turn a successful
    // cancel into a reported failure.
    try {
      spawn(resolveTaskkillPath(), ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
    } catch {
      /* ignore — see above */
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may already be gone, or we may not have been able to detach.
    // Fall back to the direct child rather than leaving it running.
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Absolute path to the real `taskkill.exe`, rather than the bare name
 * `killTree` used to pass to `spawn`.
 *
 * SEC-06: `spawn('taskkill', args)` makes Windows resolve the name itself,
 * and `CreateProcess`'s search order checks the *current working directory*
 * before it checks `PATH` or the system directories. This process's cwd is
 * `options.cwd` from whichever assignment is running — an agent's own
 * workspace — and AO-1's shell tool (granted under `acceptEdits`, see
 * `provider.ts`'s `permissionMode` doc comment) is exactly the write
 * primitive that could drop a file named `taskkill.exe` there. The next
 * cancel would then run that file, not the system one, with this server's
 * own privileges. There is no argument-injection angle here — the only
 * argument is `String(child.pid)` — the whole exposure is which binary the
 * bare name resolves to, so qualifying the path is the entire fix.
 *
 * `%SystemRoot%\System32\taskkill.exe` is used directly rather than
 * searched for and `stat`-checked the way `resolveBinary.ts` and `pdf.ts`
 * locate *their* binaries. Those two are hunting for a third-party tool that
 * may or may not be installed in one of several plausible places; taskkill is
 * a fixed component of every Windows install, always at this one path
 * relative to the system root, so there is nothing to search for — only a
 * cwd-relative lookup to avoid. If `SystemRoot` is unset (unusual, but not
 * impossible in a stripped-down environment), `C:\Windows` is the documented
 * default and is used instead of falling back to the bare name, which would
 * silently reopen this exact hole.
 *
 * Exported (only) so a test can assert the resolved path directly, without
 * mocking `child_process.spawn` — which the tests at the top of the sibling
 * `.test.ts` file already explain the house objection to: it would prove the
 * mock was called correctly, not that the real path is what actually gets
 * resolved and run.
 */
export function resolveTaskkillPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'taskkill.exe');
}

export interface SpawnOptions {
  binary: string;
  args: string[];
  cwd: string;
  /**
   * Written to the child's stdin, which is then closed.
   *
   * The brief goes here rather than into argv deliberately. Windows caps a
   * command line near 32,767 characters, and an FR-M5 brief carries the task,
   * the objective and every upstream report — it grows with the team, so argv
   * would work in testing and fail on the run that matters. stdin has no such
   * limit and needs no shell quoting.
   */
  stdin: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Env var names that must never reach a spawned agent process.
 *
 * AO-2: before this, `spawnClaude`'s default path (no `options.env` given —
 * which is every real call; `provider.ts` never sets it) let Node inherit
 * `process.env` wholesale. Server startup merges `.env` into `process.env`
 * (see `env.ts`), so `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
 * `DEEPSEEK_API_KEY` sat in *every* spawned agent's environment even though
 * this adapter never reads them itself — they belong to the separate
 * Anthropic and OpenAI provider classes (`apiConfig.ts`'s `keyVar`). NFR-1
 * scopes what an agent can touch to its own workspace; a live credential in
 * its environment defeats that as completely as a writable path outside the
 * workspace would, and the agent does not have to be malicious for it to
 * leak — 114 of the 156 catalog agents request `Bash`, which on
 * Windows is the CLI's real `PowerShell` built-in, granted without a pause
 * under the default `acceptEdits` permission mode (`provider.ts`). An agent
 * debugging its own environment for an unrelated reason is enough to put a
 * billing key into its report, and from there into the JSONL log, the
 * WebSocket stream and the exported PDF.
 *
 * A denylist rather than an allowlist, deliberately. This project spawns a
 * real, evolving third-party CLI that itself shells out to more tools
 * (ripgrep, git, whatever a tool call needs) — an allowlist would have to be
 * *exactly* right about every variable any of those might ever read, and
 * getting it wrong fails silently and expensively (a build tool that stops
 * finding its cache, a git that stops finding its config, discovered only
 * when someone's run behaves strangely on one machine and not another). A
 * denylist only has to be right about what a credential *looks like* — a much
 * smaller, more stable claim — and an unanticipated future env var passes
 * through instead of silently breaking some CLI feature. That also matches
 * NFR-1's own posture here: the workspace `cwd` sandbox is deny-by-default
 * for *paths*, but env inheritance was accidentally allow-by-default, which
 * is the actual defect.
 *
 * Matched by trailing underscore-delimited segment (so `ANTHROPIC_API_KEY`,
 * `AWS_SECRET_ACCESS_KEY` and `NPM_TOKEN` all match on their last segment)
 * rather than a fixed suffix list, plus an `AGENT_OFFICE_` prefix rule for
 * this project's own internal config (e.g. `AGENT_OFFICE_CLAUDE_BIN` —
 * consumed by `resolveBinary.ts` in *this* process before spawning, so the
 * spawned child never needed it in the first place).
 *
 * Open question this finding asked to be resolved rather than assumed: does
 * the Claude Code CLI need an env-based token for its own auth? In how this
 * adapter uses it, no — `resolveBinary.ts`'s preflight shells out to
 * `claude auth status`, and README.md/SETUP.md's setup path is entirely
 * `claude auth login`, both about a signed-in session recorded outside
 * `process.env`. That is a real-but-bounded finding: it covers this
 * adapter's own usage, not every way the upstream CLI can be configured
 * elsewhere. Confidence is high, not absolute, which is exactly why this is
 * a denylist rather than an allowlist that would have had to bake in a
 * "no token needed" assumption as unstated fact — if a future deployment
 * does need to hand the CLI a token, the fix is one named allow rule here,
 * not an argument about whether wholesale inheritance should come back.
 *
 * S5: the original eight segments were reverse-engineered from a handful of
 * example vendor keys and missed whole classes of credential. This list adds
 * the ones a review found reachable through the same default path:
 * `DSN` (Sentry and friends embed a full credentialed URL behind that name —
 * `SENTRY_DSN=https://key@sentry.io/...`) and `PAT` (the conventional
 * abbreviation for a personal access token, e.g. `GH_PAT`, `AZURE_DEVOPS_PAT`
 * — distinct enough from `TOKEN` that projects that already avoid the word
 * "token" in the name still use this one). `AUTH` is added too: on its own a
 * generic word, but as a *last* segment (`PROXY_AUTH`, the mangled
 * `NPM_CONFIG__AUTH` below) it is reliably a credential and never one of the
 * documented survivors (none of `PATH`/`HOME`/`APPDATA`/`TEMP`/`SystemRoot`/
 * `ComSpec`/`LANG`/`LC_*`/`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` end in it).
 *
 * Three more gaps do not fit the "last underscore segment" shape at all, so
 * they are handled separately rather than forced into this set:
 *
 * - `AWS_ACCESS_KEY_ID` ends in `ID`, not `KEY` — adding `ID` as a segment
 *   would deny every `*_ID` variable (`RUN_ID`, `WORKSPACE_ID`, a `CLIENT_ID`
 *   that is often not secret on its own), which is exactly the "starves the
 *   child" failure mode this file's own module comment warns against. It is
 *   listed by exact name in {@link DENIED_ENV_NAMES} instead, alongside
 *   `SSH_AUTH_SOCK` — a Unix-socket *path*, not a `KEY`/`TOKEN`/`SECRET`
 *   string, but holding it is equivalent to holding every private key loaded
 *   into the user's running `ssh-agent`, so it belongs on the same list even
 *   though nothing about its literal name says "credential".
 * - `NPM_CONFIG_*` auth fields: npm mangles special characters in scoped
 *   registry config keys (`//registry.npmjs.org/:_authToken`) into the env
 *   var name, so the credential-bearing ones do not land on a clean
 *   underscore segment either. Handled by a dedicated prefix+substring check
 *   below rather than folded into the segment set, because most of the
 *   `NPM_CONFIG_*` namespace (`NPM_CONFIG_REGISTRY`, `_CACHE`, `_LOGLEVEL`,
 *   `_PREFIX`, ...) is ordinary, non-secret configuration the CLI's own
 *   package-manager calls may depend on — denying the whole prefix would be
 *   exactly the over-wide filter the module comment warns against.
 * - `DATABASE_URL` and other `*_URL` variables carrying `scheme://user:pass@
 *   host`: a name-based rule here cannot distinguish those from a harmless
 *   `DOCS_URL` or `HEALTHCHECK_URL`, and denying every `*_URL` name to be safe
 *   would be the over-wide failure again. This is precisely the case a name
 *   check cannot solve — handled by {@link looksLikeCredentialedUrl} below,
 *   which inspects the *value* instead and does not care what the variable
 *   is named.
 *
 * Rejected alternative for all of the above: threading the list of variable
 * names `loadDotEnv` (`env.ts`) actually *applied* from `.env` into this
 * filter, so `.env`-sourced values are denied by provenance instead of by
 * guessing at their names — catching an operator's own oddly-named secret
 * that matches no segment here. That is the more principled fix, but the
 * plumbing does not fit in this file: `loadDotEnv` runs once in the
 * entrypoint (`scripts/serve.ts`, `scripts/run.ts`, `scripts/agent.ts`), and
 * the applied names would have to travel through `RunSupervisor` and the
 * `ClaudeCodeProvider` construction path before reaching the per-spawn call
 * here — none of which this change touches. Doing it properly is a
 * cross-cutting change to the provider construction path, not a filter
 * tweak, so it is left as a follow-up rather than done partially.
 */
const DENIED_ENV_SEGMENTS = new Set([
  'KEY',
  'TOKEN',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'DSN',
  'PAT',
  'AUTH',
]);

/**
 * Full env var names that are credential-shaped despite not ending in one of
 * {@link DENIED_ENV_SEGMENTS}'s segments — see the S5 comment above for why
 * each one earns a name-exact rather than a segment rule.
 */
const DENIED_ENV_NAMES = new Set(['AWS_ACCESS_KEY_ID', 'SSH_AUTH_SOCK']);

/**
 * `NPM_CONFIG_*` variables whose (mangled) name contains one of these
 * substrings are the credential-bearing ones — `_authToken`, `_auth`,
 * `_password` and similar registry-auth keys become `NPM_CONFIG__AUTHTOKEN`,
 * `NPM_CONFIG__AUTH`, `NPM_CONFIG__PASSWORD` once npm's special characters
 * are folded into an env var name. Substring rather than exact-segment
 * matching specifically because that folding does not preserve clean
 * underscore boundaries the way an ordinary var name does.
 */
const NPM_CONFIG_AUTH_SUBSTRINGS = ['AUTH', 'TOKEN', 'PASSWORD', 'SECRET', 'KEY', 'CREDENTIAL'];

/** Case-insensitive: Windows env var names are case-insensitive, and a fixture built for a test should not depend on matching case to be caught. */
function isCredentialShaped(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith('AGENT_OFFICE_')) return true;
  if (DENIED_ENV_NAMES.has(upper)) return true;
  if (upper.startsWith('NPM_CONFIG_') && NPM_CONFIG_AUTH_SUBSTRINGS.some((s) => upper.includes(s))) {
    return true;
  }
  const segments = upper.split('_');
  const last = segments[segments.length - 1];
  return last !== undefined && DENIED_ENV_SEGMENTS.has(last);
}

/**
 * Value-shaped credential check: `scheme://user:pass@host` (or
 * `scheme://:pass@host`, the "no username" form used by e.g. Redis).
 *
 * A variable name can be entirely innocent — `DATABASE_URL`, a bespoke
 * `UPSTREAM_URL` — while the value it holds is a live password. This is the
 * name check's blind spot by construction: no segment list can cover a name
 * an operator was free to choose. Matching requires seeing a `:` between the
 * scheme and the `@`, not just a bare `user@host` (an SSH-style remote or a
 * mailto-shaped value with no password is not denied by this rule; the
 * `user`-only form leaks a lot less than `user:pass` and, more importantly,
 * scheme-only-with-username values are a common, legitimate shape — e.g. a
 * git remote — that this filter should not have to swallow to catch the
 * genuinely dangerous case).
 *
 * Deliberately applied to every variable's value, regardless of name —
 * including `HTTP_PROXY`/`HTTPS_PROXY`, which the survivors list above
 * otherwise passes through unconditionally. If an operator's proxy URL
 * genuinely embeds `user:pass@`, that is a live credential sitting in the
 * child's environment exactly like a `DATABASE_URL` would be, and the
 * documented "proxy settings survive" guarantee is about the *variable*
 * being let through when it is not carrying a credential, not a promise to
 * pass a password through unfiltered because of which name it happened to
 * be attached to. A proxy configured this way loses proxy access for the
 * spawned agent; a proxy configured the ordinary way (bare host:port, with
 * any auth handled by the CLI's own config) is unaffected.
 */
function looksLikeCredentialedUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s@/]*:[^\s@/]*@/.test(value);
}

/**
 * Build the environment for a spawned agent process from `source` (normally
 * `process.env`), with credential-shaped variables removed.
 *
 * Everything that is not credential-shaped passes through unchanged —
 * `PATH`, `HOME`/`USERPROFILE`, `APPDATA`/`LOCALAPPDATA`, `TEMP`/`TMP`,
 * `SystemRoot`, `ComSpec`, locale (`LANG`, `LC_*`) and proxy settings
 * (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and lower-case variants) are all
 * things a real CLI and the tools it shells out to need to function on
 * Windows, and none of them are credential-shaped by name or by value, so
 * the denylist above already keeps them without needing to be named as a
 * separate allowlist.
 */
export function sanitiseInheritedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (isCredentialShaped(name)) continue;
    if (value === undefined) continue;
    if (looksLikeCredentialedUrl(value)) continue;
    result[name] = value;
  }
  return result;
}

export interface SpawnedChild {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the exit code once the process and its streams are done. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything the child wrote to stderr, for error reporting. */
  stderr: Promise<string>;
}

export function spawnClaude(options: SpawnOptions): SpawnedChild {
  // A `.cmd`/`.bat` shim cannot be spawned directly on Windows — Node throws
  // synchronously rather than returning a child. `resolveSpawnTarget` reroutes
  // that one case through `cmd.exe` with its own quoting; everything else passes
  // through unchanged. See `windowsSpawn.ts` for why not `shell: true`.
  const target = resolveSpawnTarget(options.binary, options.args);

  const child = spawn(target.command, target.args, {
    cwd: options.cwd,
    ...(target.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: target.windowsVerbatimArguments }),
    // NFR-1: the child is anchored to the run's workspace as its working
    // directory, so a relative path a tool writes cannot land in the user's
    // own repos. `options.env` stays an explicit, unfiltered override — tests
    // depend on constructing an exact fixture environment, and a caller that
    // builds one has already made a deliberate choice this layer should not
    // second-guess. The default path (no `options.env`, which is every real
    // call today — see `sanitiseInheritedEnv`'s doc comment for why) used to
    // hand the child `process.env` untouched; that was AO-2, and this is the
    // one place in the codebase every spawn funnels through, so it is the one
    // place the fix has to live.
    env: options.env ?? sanitiseInheritedEnv(process.env),
    windowsHide: true,
    // Group leadership on POSIX, so `killTree` can signal the whole group.
    // Meaningless on Windows, where `taskkill /T` does the walking instead.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Bounded: a broken CLI can write to stderr indefinitely, and this string is
    // only ever used to explain a failure. Keeping the tail matters more than
    // the head — the last thing written is usually the actual error.
    stderrText = (stderrText + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  const stderr = exit.then(() => stderrText, () => stderrText);

  // Writing the brief and closing stdin is what tells the CLI the turn is
  // complete; without the close it waits for more input and never starts.
  child.stdin.on('error', () => undefined); // EPIPE if the child died early.
  child.stdin.end(options.stdin, 'utf8');

  return { child, exit, stderr };
}

/** Keep the last 16 KB of stderr. Enough for a stack trace, bounded for a loop. */
const STDERR_TAIL_LIMIT = 16 * 1024;
