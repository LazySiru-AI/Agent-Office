import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../env.js';
import { AUTH_TOKEN_QUERY_PARAM, resolveAuthToken } from '../http/authToken.js';
import { buildServer } from '../http/server.js';
import { DEFAULT_MAX_CONCURRENT_RUNS, RunSupervisor } from '../http/supervisor.js';
import { shellIsAllowed } from '../providers/claude-code/provider.js';
import { AVAILABLE_PROVIDER_IDS, DEFAULT_PROVIDER } from '../providers/factory.js';
import { DiagnosticsLog } from '../diagnostics/log.js';
import { loadRegistry, watchRegistry, type RegistryWatcher } from '../registry/index.js';
import { FileRunStore, defaultRunsRoot } from '../store/fileStore.js';

/**
 * Phase 3 entrypoint: the local web server.
 *
 *   npm run serve
 *   npm run serve -- --provider scripted --concurrency 2 --port 5179
 *
 * Flags mirror the run CLI where they mean the same thing, so switching between
 * headless and browser use does not mean learning a second vocabulary.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/scripts` -> src -> server -> packages -> project root, which holds `categories/`. */
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/**
 * Where the web package's build lands, so this one process can serve it and a
 * user needs neither a second terminal nor a second port (`buildServer`'s
 * `webDistDir` — see `http/staticClient.ts`'s module comment for the whole
 * design, including why the bundle it serves needs no token).
 *
 * Derived from `DEFAULT_REPO_ROOT` rather than `options.repoRoot`: the
 * `--repo-root` flag exists to point the *agent catalog* somewhere else for
 * testing (see `USAGE` above), which has nothing to do with where this very
 * checkout's own web package was built. Tying the two together would mean
 * `--repo-root /tmp/scratch-catalog` also silently stopped the local UI from
 * loading.
 */
const WEB_DIST_DIR = path.join(DEFAULT_REPO_ROOT, 'packages', 'web', 'dist');

/**
 * NFR-6: loopback only, never `0.0.0.0`.
 *
 * The startup token (AO-6, `authToken.ts`) is what keeps another account *on
 * this machine* from driving the API; it is not a reason to loosen this
 * constant. A token sent over plain HTTP to a wildcard bind would be sniffable
 * by anything on the same network segment, and the API would still start
 * processes and read files for anyone who captured one packet. Binding to
 * loopback keeps the token meaningful by keeping it off the wire entirely
 * outside this machine. This is a constant rather than an option on purpose —
 * there is no flag to get this wrong with.
 */
const HOST = '127.0.0.1';

const DEFAULT_PORT = 5179;

/**
 * Where this process leaves its token for `npm run web`'s Vite dev server to
 * find (AO-6), namespaced by port. See the long comment at the write site in
 * `main()` for why a file works here at all and what its actual protection
 * is; see `vite.config.ts` for the reader.
 *
 * The FUNCTION (not just a path string) is duplicated in `vite.config.ts`
 * rather than imported from a shared module — the web package does not (and
 * should not start to) depend on `@agent-office/server` for one function, the
 * same reasoning that already kept the old single-path-string constant this
 * replaces duplicated rather than shared. Each side carries a comment naming
 * the other; if the two ever drift, the symptom is every proxied request
 * coming back 401 with a token file `serve.ts` is writing somewhere
 * `vite.config.ts` isn't reading.
 *
 * Namespaced by port because two `npm run serve` instances started with
 * different `--port` values are two independent servers with two independent
 * tokens. Sharing one file name meant the second process to start silently
 * overwrote the first's token — the first server's own Vite client, still
 * pointed at the first token, then started failing every request with a 401
 * it had no way to explain, for a reason with nothing to do with anything the
 * developer watching that terminal had just changed. This is not a
 * hypothetical: a UAT agent hit exactly this shape of failure because the
 * default port was already taken by another session.
 *
 * The default port keeps the original, unsuffixed file name on purpose: the
 * ordinary single-instance workflow (`npm run serve` plus `npm run web`, no
 * flags on either side) is byte-for-byte the same file path it always was, so
 * nobody running the common case is asked to think about namespacing at all.
 * Only a non-default `--port` earns a suffix, because that is the only case
 * where a second concurrent instance sharing the unsuffixed name could
 * actually collide with a first instance still on the default port.
 */
export function devTokenFilePath(port: number): string {
  const suffix = port === DEFAULT_PORT ? '' : `-${port}`;
  return path.join(os.tmpdir(), 'agent-office', `dev-token${suffix}`);
}

export interface CliOptions {
  provider: string;
  port: number;
  repoRoot: string;
  runsRoot: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Slows the scripted provider so live status and reattach are observable. */
  stepDelayMs?: number;
  /** AO-6: caps runs executing at once. Defaults to `DEFAULT_MAX_CONCURRENT_RUNS`. */
  maxConcurrentRuns?: number;
}

// Exported for `serve.test.ts`'s alignment check on the `Options:` block
// (defect: `--max-concurrent-runs <n>` used to be wider than the fixed
// padding column, throwing off every description after it).
export const USAGE = `
Usage: npm run serve [-- options]

Options:
  --provider <id>          Default provider for new runs (default: ${DEFAULT_PROVIDER}).
                           Use 'scripted' for a free, no-model dry run.
  --port <n>               Listen port (default ${DEFAULT_PORT}, or $PORT).
                           A non-default port only moves the server — also set
                           AGENT_OFFICE_SERVER_PORT to the same value before
                           'npm run web', or its Vite proxy keeps targeting
                           ${DEFAULT_PORT} (see packages/web/vite.config.ts).
  --concurrency <n>        Default parallel assignments per phase (default 3).
  --timeout <ms>           Default per-assignment timeout (default 1200000).
  --max-concurrent-runs <n>
                           How many runs may execute at once before a new
                           POST /api/runs is refused with 429 (default
                           ${DEFAULT_MAX_CONCURRENT_RUNS}). Every run spawns real,
                           billed child processes — this is a cost control.
  --step-delay <ms>        Slow the scripted provider by this much per event, so
                           live status and reattach are observable by hand.
  --repo-root <path>       Subagent catalog root (default: this repository).
  --runs-root <path>       Where run artifacts are written.
  -h, --help               Show this message.

The server binds to ${HOST} only (NFR-6) and requires the startup token
printed below on every request (AO-6). Set \`AGENT_OFFICE_TOKEN\` to pin it
instead of generating a fresh one.
`.trim();

/**
 * Returns `'help'`, rather than printing and calling `process.exit(0)`
 * itself, so `serve.test.ts` can call this directly and assert on the
 * result — the same shape `run.ts`, `traceability.ts`, and
 * `verifyCatalogManifest.ts` already use `parseArgs` for, and for the same
 * reason: a `process.exit` reached from inside a test would kill the whole
 * vitest worker, not just fail one assertion. `main()` below is what turns
 * `'help'` into the actual `stdout` write.
 */
export function parseArgs(argv: string[]): CliOptions | 'help' {
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') {
      return 'help';
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument "${arg}".\n\n${USAGE}`);
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`option ${arg} needs a value`);
    }
    flags.set(arg.slice(2), value);
    i += 1;
  }

  const numeric = (key: string, fallback?: string): number | undefined => {
    const raw = flags.get(key) ?? fallback;
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${key} must be a positive number, got "${raw}"`);
    }
    return value;
  };

  const concurrency = numeric('concurrency');
  const stepDelayMs = numeric('step-delay');
  const timeoutMs = numeric('timeout');
  const maxConcurrentRuns = numeric('max-concurrent-runs');

  return {
    provider: flags.get('provider') ?? DEFAULT_PROVIDER,
    port: numeric('port', process.env['PORT']) ?? DEFAULT_PORT,
    repoRoot: path.resolve(
      flags.get('repo-root') ?? process.env['AGENT_OFFICE_REPO_ROOT'] ?? DEFAULT_REPO_ROOT,
    ),
    runsRoot: path.resolve(flags.get('runs-root') ?? defaultRunsRoot()),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(stepDelayMs === undefined ? {} : { stepDelayMs }),
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parsed;

  // Namespaced by `options.port` — see `devTokenFilePath`'s own comment for
  // why two `--port`-separated instances must not share a token file.
  const devTokenFile = devTokenFilePath(options.port);

  // Before anything reads `process.env`: the provider adapters resolve their
  // keys at construction, and a `.env` loaded after that would be ignored.
  const env = loadDotEnv(options.repoRoot);
  if (env.path !== undefined && env.applied.length > 0) {
    // Names only, never values — a terminal scrollback is the one place people
    // paste from without reading.
    process.stdout.write(`Loaded ${env.applied.length} variable(s) from .env: ${env.applied.join(', ')}\n`);
  }

  if (!AVAILABLE_PROVIDER_IDS.includes(options.provider as (typeof AVAILABLE_PROVIDER_IDS)[number])) {
    // Checked at startup rather than on the first request: a typo in a flag
    // should fail immediately, not once someone has typed a task into the UI.
    throw new Error(
      `unknown provider "${options.provider}". Known: ${AVAILABLE_PROVIDER_IDS.join(', ')}.`,
    );
  }

  // AO-6: resolved once, before `listen()`, exactly like `reconcileCrashedRuns`
  // below has to be — a token decided after the server starts accepting
  // connections would leave a window where the first requests in are answered
  // by a process not yet enforcing anything.
  const { token, pinned, weak } = resolveAuthToken();

  /**
   * FR-R5. The watcher owns the catalog now: it does the initial load, and
   * replaces it in place on every successful re-index.
   *
   * Both the server and the supervisor are given an ACCESSOR rather than the
   * value, because a reload produces a NEW `Registry` — the old object's maps
   * are readonly and cannot be updated. Handing over the value would have left
   * hot-reload observable by nothing, which is what it was until this line.
   *
   * A failed re-index keeps the last good catalog and prints why; it does not
   * stop the server. See `registry/watch.ts`.
   */
  const watcher = await watchRegistry(options.repoRoot, {
    onEvent: (event) => {
      if (event.type === 'reloaded') {
        process.stdout.write(`registry reloaded: ${event.registry.agents.length} agents
`);
      } else if (event.type === 'reload-error') {
        process.stderr.write(`registry reload failed, keeping the previous catalog: ${describe(event.error)}
`);
      } else if (event.type === 'degraded') {
        process.stderr.write(`registry watch degraded: ${event.reason}
`);
      } else {
        process.stderr.write(`registry watch error: ${describe(event.error)}
`);
      }
    },
  });
  const registry = watcher.current;
  const store = new FileRunStore(options.runsRoot);

  /**
   * Appended to runs/diagnostics.jsonl and read with `npm run diagnostics`.
   *
   * Given the server's own warning channel so a write failure is visible here
   * rather than silent — this process has somewhere to print it, unlike a CLI
   * run mid-report.
   *
   * ONE log, shared by the supervisor and by `buildServer`. It was the
   * supervisor's alone at first, and that left the HTTP layer as the one part
   * of this process whose failures reached nothing durable: a route throwing
   * produced a 500 for the client and, with no logger passed below either, not
   * so much as a line in this terminal. An operator's "what has gone wrong
   * lately" should not have to know which half of the process it happened in.
   */
  const diagnostics = new DiagnosticsLog({
    runsRoot: options.runsRoot,
    onWarning: (message: string, cause?: unknown) =>
      process.stderr.write(`${message}${cause === undefined ? '' : `: ${String(cause)}`}
`),
  });

  const supervisor = new RunSupervisor({
    registry,
    getRegistry: () => watcher.current,
    store,
    diagnostics,
    defaultProviderId: options.provider,
    ...(options.stepDelayMs === undefined ? {} : { stepDelayMs: options.stepDelayMs }),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    dispatchDefaults: {
      ...(options.concurrency === undefined ? {} : { maxConcurrency: options.concurrency }),
      ...(options.timeoutMs === undefined ? {} : { assignmentTimeoutMs: options.timeoutMs }),
    },
  });

  // NFR-2 (server-restart half): close out any run a previous process left
  // non-terminal — e.g. `status: 'running'` from a crash mid-dispatch — before
  // this one accepts a single request. Must happen before `listen()`: once the
  // server is accepting connections, a client's own `POST /api/runs` could
  // create a genuinely-live run that `store.listRuns()` would then observe and
  // misfile as crashed, because nothing yet in `supervisor.entries` marks it as
  // this process's own. See `RunSupervisor.reconcileCrashedRuns` for what this
  // does and, just as importantly, what it deliberately does not do (resuming
  // dispatch, which the doc comment there explains is a materially larger
  // feature than "the server did not lose the run").
  const reconciled = await supervisor.reconcileCrashedRuns();
  if (reconciled.length > 0) {
    process.stdout.write(
      `Marked ${reconciled.length} run(s) failed: left non-terminal by a previous process (${reconciled.join(', ')}).\n`,
    );
  }

  const webBuilt = existsSync(path.join(WEB_DIST_DIR, 'index.html'));
  const app = await buildServer({
    registry,
    getRegistry: () => watcher.current,
    store,
    supervisor,
    token,
    webDistDir: WEB_DIST_DIR,
    diagnostics,
    /**
     * `warn`, not `true` and not the default `false` this had until now.
     *
     * `false` was the accident: `buildServer` defaults its logger off so tests
     * driving it with `.inject()` are not drowned in JSON, and the production
     * entrypoint simply never overrode that — so `request.log.error(...)` in the
     * 500 handler wrote to a logger that discards everything, and a route
     * throwing was silent in the one place a person is actually watching.
     *
     * `true` is the other wrong answer: pino's default level prints an `incoming
     * request` and a `request completed` line for every poll of `/api/runs`,
     * which on this UI is a couple of lines a second forever. `warn` prints
     * nothing during a healthy session and prints the failure when there is one,
     * which is the only reason a local server's log is worth having open.
     */
    logger: { level: 'warn' },
  });

  await app.listen({ host: HOST, port: options.port });

  /**
   * AO-6, the `npm run web` half: drop the token where the Vite dev server's
   * proxy (`packages/web/vite.config.ts`) can read it and attach it to every
   * proxied request, so the ordinary two-terminal workflow — `npm run serve`
   * in one, `npm run web` in the other — needs nobody to paste anything.
   * `devTokenFilePath` above is what namespaces this file by port; this
   * comment is the rest of the story — why a file at all, what actually
   * protects it, and what happens to it across a restart.
   *
   * A file is what makes the handshake possible without the two processes
   * sharing any other channel (no IPC, no agreed port to poll, and a fresh
   * random token per `serve` invocation means an environment variable set
   * once would go stale the next run). The file lives under `os.tmpdir()`,
   * which on every platform this runs on is already scoped to the current OS
   * user account — not `0.0.0.0`-reachable, not readable by a different local
   * account any more than the rest of this user's files already are. That is
   * the same boundary AO-6's own finding leans on ("a low-privilege [account]
   * that could not otherwise read your files"): this file adds nothing a
   * same-account process couldn't already get by asking this very server for
   * it with the right header, and it is unreachable to exactly the attacker
   * AO-6 is about.
   *
   * Two more layers sit on top of that account-scoping, both aimed at a
   * *different* local account or process racing this one for the same path —
   * a narrower threat than AO-6's remote attacker, but a real one on a shared
   * `/tmp`:
   *
   *  - The directory is created `0o700` and the file `0o600` — advisory on
   *    Windows (as before), but real and meaningful everywhere else this runs.
   *    `mkdirSync`'s `mode` only applies when it actually creates the
   *    directory; an already-existing, more permissive `agent-office/` from
   *    an older run of this same code is not retroactively tightened here —
   *    a pre-existing condition this line does not regress, not one it claims
   *    to fix.
   *  - Before writing, whatever currently sits at the token path is removed
   *    with `rmSync(..., { force: true })`, and the file is then created
   *    fresh with the `wx` flag (create-exclusive: fail rather than silently
   *    open whatever is already there). A plain `writeFileSync` would miss
   *    two things this catches: a symlink left at this path — by another
   *    local account, or by a previous crash — that would otherwise be
   *    followed transparently and have this token written through it to
   *    wherever it points; and a pre-existing regular file whose permission
   *    bits predate this process, which a `writeFileSync` mode option does
   *    NOT reset on an existing file (Node only applies `mode` when the call
   *    itself creates the file). Removing first means every write takes the
   *    "create fresh" branch: a brand new file, permissions chosen by this
   *    process, never inherited from whatever used to be at that path.
   *
   * This is emphatically a DEVELOPMENT convenience, not a claim that the Vite
   * port is as protected as this one. Anything that can reach the Vite dev
   * server's port gets the exact same access this token grants, because the
   * proxy forwards its requests here with the token already attached — Vite's
   * dev server has no `Host`/`Origin` checks of its own. That is an accepted,
   * documented trade for local development ergonomics, not an oversight; see
   * `vite.config.ts` for the other half of this same comment.
   *
   * The file is also removed on the way out, best-effort — see
   * `installShutdown` — so a server that exits cleanly does not leave a stale
   * token sitting in `tmpdir()` after the process that could still redeem it
   * is gone.
   */
  try {
    mkdirSync(path.dirname(devTokenFile), { recursive: true, mode: 0o700 });
    rmSync(devTokenFile, { force: true });
    writeFileSync(devTokenFile, token, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // The dev convenience failing must never take the server down: worst case,
    // `npm run web` falls back to needing the token pasted in by hand (see
    // `packages/web/src/api.ts`'s query-parameter bootstrap), which is exactly
    // how every other loopback tool without this file already works.
    process.stderr.write(
      `warning: could not write the dev token file for the Vite proxy (${describe(error)}); ` +
        `npm run web may need the token pasted manually.\n`,
    );
  }

  process.stdout.write(`agent office server\n`);
  process.stdout.write(`  url:      http://${HOST}:${options.port}/?${AUTH_TOKEN_QUERY_PARAM}=${token}\n`);
  process.stdout.write(`  registry: ${registry.agents.length} agents from ${options.repoRoot}\n`);
  process.stdout.write(`  runs:     ${store.root}\n`);
  process.stdout.write(`  provider: ${options.provider}\n`);
  /**
   * FR-T2's answer, stated at startup rather than discovered at denial time.
   *
   * `shellIsAllowed()` reads `AGENT_OFFICE_ALLOW_SHELL` from THIS process's
   * environment, and the only way to change it is to restart — so it is a fact
   * about this deployment, exactly like `provider` and `token` above, and it
   * belongs beside them.
   *
   * It was not here, and the gap was not cosmetic. An operator who set the
   * variable had no way to confirm it had actually been inherited: the shell
   * grant is invisible until an agent asks for a tool and is refused, which
   * happens minutes into a billed run, in that assignment's own event log. The
   * failure mode this closes is a launcher that drops the variable (a wrapper
   * script, an IDE run configuration, a process manager) leaving a server that
   * looks correctly configured and silently is not — which is the same shape as
   * the supervisor dropping `diagnostics`, found earlier today, and the reason
   * to state a capability rather than let it be inferred from its absence.
   */
  process.stdout.write(
    `  shell:    ${
      shellIsAllowed()
        ? 'GRANTED via AGENT_OFFICE_ALLOW_SHELL — agents on this server may run commands'
        : 'denied (default) — set AGENT_OFFICE_ALLOW_SHELL=1 and restart to grant'
    }\n`,
  );
  process.stdout.write(
    `  token:    ${pinned ? 'pinned from AGENT_OFFICE_TOKEN' : 'generated for this process only'}` +
      `${weak ? ' — WARNING: weak/low-entropy token, brute-forceable; fine for CI/tests only, not for a reachable server' : ''}\n`,
  );
  process.stdout.write(
    webBuilt
      ? `  client:   ${WEB_DIST_DIR} (built — the url above opens the app)\n`
      : `  client:   not built yet (${WEB_DIST_DIR} has no index.html)\n` +
          `            build the web package, then reload the url above; until then\n` +
          `            only /api is reachable here, or run 'npm run web' separately.\n`,
  );
  process.stdout.write(
    `\nAO-6: every /api request and the /ws upgrade need the token above (header ` +
      `\`x-agent-office-token\`, or \`?${AUTH_TOKEN_QUERY_PARAM}=...\` once, for a browser's ` +
      `first load only — see packages/web/src/api.ts for why the header is preferred ` +
      `everywhere else). The app's own HTML/JS is not gated by the token — see ` +
      `packages/server/src/http/staticClient.ts for why.\n` +
      `npm run web needs no token pasted in: its Vite proxy reads it from ${devTokenFile}.\n` +
      (options.port === DEFAULT_PORT
        ? ''
        : `This is a non-default port: also set AGENT_OFFICE_SERVER_PORT=${options.port} before ` +
          `starting npm run web, or its proxy keeps targeting ${DEFAULT_PORT} and nothing here ` +
          `answers it (see packages/web/vite.config.ts).\n`),
  );
  process.stdout.write(`\nCtrl+C to stop.\n`);

  installShutdown(app, supervisor, watcher, devTokenFile);
}

/**
 * Graceful shutdown.
 *
 * Ctrl+C cancels in-flight runs and waits for them to unwind before closing the
 * server. Exiting immediately would kill the process mid-`saveRun`, and the
 * store's temp-file-plus-rename can only guarantee that a reader sees either the
 * old file or the new one — not that the rename ever happens. A second Ctrl+C
 * gives up waiting, because a wedged provider must not make the server
 * unkillable.
 */
function installShutdown(
  app: Awaited<ReturnType<typeof buildServer>>,
  supervisor: RunSupervisor,
  /**
   * FR-R5's watcher. Passed in rather than closed over because this function is
   * deliberately outside `main`'s scope — and it must be closed on the way out:
   * an fs watcher and a pending debounce timer are both handles that would keep
   * the process alive after everything else had stopped.
   */
  watcher: RegistryWatcher,
  /** The path `main()` wrote the dev token to — see the cleanup below. */
  devTokenFile: string,
): void {
  let stopping = false;

  const stop = (signal: string): void => {
    if (stopping) {
      process.stderr.write('\nforcing exit.\n');
      process.exit(130);
    }
    stopping = true;
    process.stderr.write(`\n${signal}: cancelling in-flight runs (again to force quit)...\n`);

    void (async () => {
      try {
        await supervisor.shutdown();
        // Stops the fs watchers and clears any pending debounce timer, so the
        // process can actually exit rather than being held open by a handle.
        await watcher.close();
        await app.close();
      } catch (error) {
        process.stderr.write(`shutdown error: ${describe(error)}\n`);
        process.exitCode = 1;
      }
      // Best-effort removal of the dev-token file this process wrote at
      // startup (see the write site in `main()`). Deliberately its own
      // try/catch, outside the one above and swallowing its own errors: a
      // token file this process fails to delete — tmpdir already cleared it,
      // a permissions quirk, whatever — must never flip `process.exitCode`
      // or otherwise change how this process exits. Worst case it behaves
      // exactly as it did before this cleanup existed: a stale file sitting
      // in the temp directory until the next `npm run serve` on this port
      // overwrites it (now with guaranteed-fresh permissions regardless, per
      // the create-fresh logic at the write site, not merely "whatever this
      // token's write mode happened to be").
      try {
        rmSync(devTokenFile, { force: true });
      } catch {
        // intentionally ignored — see comment above.
      }
      process.exit(process.exitCode ?? 0);
    })();
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A remedy line for the one startup failure common enough to deserve its own
 * words: the port was already taken. Without this, `main().catch` below
 * printed only Node's raw `Error: listen EADDRINUSE: address already in use
 * 127.0.0.1:5179` — accurate, but it never mentions that `--port <n>` exists,
 * so a reader who doesn't already know this CLI's flags has no next step,
 * only a syscall error to go search for. That raw message is left fully
 * intact by this function (removing it would throw away the exact
 * address/port Node tried); this only ever APPENDS a second line, following
 * the same "say what happened, then what to do" shape already used for
 * actionable failures elsewhere in this codebase (e.g. the
 * `AGENT_OFFICE_ALLOW_SHELL` denial in `providers/claude-code/tools.ts`).
 *
 * The port comes off the error itself (`net.Server`'s listen failures carry
 * `.port`/`.address` directly on the `Error`, via Node's own
 * `exceptionWithHostPort` helper) rather than by threading `options.port` out
 * of `main`'s local scope into this module-level catch — `.port` is trusted
 * when present, and `DEFAULT_PORT` is the fallback for the narrow case of
 * some other EADDRINUSE-coded error reaching this catch without one.
 *
 * Returns `undefined` for anything that is not this specific failure, so the
 * catch below can append the hint only when it actually applies rather than
 * risk printing an irrelevant "port is taken" line under, say, a registry
 * load failure or a bad `--provider`.
 */
export function addrInUseHint(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return undefined;

  const port = (error as NodeJS.ErrnoException & { port?: number }).port ?? DEFAULT_PORT;
  return (
    `Port ${port} is already in use — likely another 'npm run serve' still running. ` +
    `Pick a free one with --port <n> (see --help), and if 'npm run web' is already pointed at ` +
    `${port}, set AGENT_OFFICE_SERVER_PORT to the new port too before starting it.`
  );
}

/**
 * Only run `main()` when this file is the process entry point — the same
 * guard `purge.ts`, `run.ts`, `traceability.ts`, and
 * `verifyCatalogManifest.ts` already use, and for the same reason:
 * `serve.test.ts` imports this module for `parseArgs`, `devTokenFilePath`,
 * and `addrInUseHint` to exercise them directly, without shelling out to a
 * subprocess or — the part that actually matters for this file — binding a
 * real port. Without this guard, a plain `import` for testing would also
 * execute `main()` against vitest's own `argv`, which calls `app.listen()`:
 * a real network bind, exactly what this file's test suite must not do.
 */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`\nserver failed to start.\n\n${describe(error)}\n`);
    const hint = addrInUseHint(error);
    if (hint !== undefined) process.stderr.write(`${hint}\n`);
    process.exitCode = 1;
  });
}
