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
 * leak — 114 of the 166 vendored catalog agents request `Bash`, which on
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
]);

/** Case-insensitive: Windows env var names are case-insensitive, and a fixture built for a test should not depend on matching case to be caught. */
function isCredentialShaped(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith('AGENT_OFFICE_')) return true;
  const segments = upper.split('_');
  const last = segments[segments.length - 1];
  return last !== undefined && DENIED_ENV_SEGMENTS.has(last);
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
 * Windows, and none of them are credential-shaped, so the denylist above
 * already keeps them without needing to be named as a separate allowlist.
 */
export function sanitiseInheritedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (isCredentialShaped(name)) continue;
    if (value === undefined) continue;
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
