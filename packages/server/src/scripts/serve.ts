import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../env.js';
import { AUTH_TOKEN_QUERY_PARAM, resolveAuthToken } from '../http/authToken.js';
import { buildServer } from '../http/server.js';
import { DEFAULT_MAX_CONCURRENT_RUNS, RunSupervisor } from '../http/supervisor.js';
import { AVAILABLE_PROVIDER_IDS, DEFAULT_PROVIDER } from '../providers/factory.js';
import { loadRegistry } from '../registry/index.js';
import { FileRunStore, defaultRunsRoot } from '../store/fileStore.js';

/**
 * Where this process leaves its token for `npm run web`'s Vite dev server to
 * find (AO-6). See the long comment at the write site in `main()` for why a
 * file works here and what its actual protection is; see `vite.config.ts` for
 * the reader. The two are not derived from a shared module because the web
 * package does not (and should not start to) depend on `@agent-office/server`
 * for one path string — so this constant is duplicated there, deliberately,
 * with a comment on each side pointing at the other.
 */
const DEV_TOKEN_FILE = path.join(os.tmpdir(), 'agent-office', 'dev-token');

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

interface CliOptions {
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

const USAGE = `
Usage: npm run serve [-- options]

Options:
  --provider <id>          Default provider for new runs (default: ${DEFAULT_PROVIDER}).
                           Use 'scripted' for a free, no-model dry run.
  --port <n>               Listen port (default ${DEFAULT_PORT}, or $PORT).
  --concurrency <n>        Default parallel assignments per phase (default 3).
  --timeout <ms>           Default per-assignment timeout (default 600000).
  --max-concurrent-runs <n> How many runs may execute at once before a new
                           POST /api/runs is refused with 429 (default
                           ${DEFAULT_MAX_CONCURRENT_RUNS}). Every run spawns real,
                           billed child processes — this is a cost control.
  --step-delay <ms>        Slow the scripted provider by this much per event, so
                           live status and reattach are observable by hand.
  --repo-root <path>       Subagent catalog root (default: this repository).
  --runs-root <path>       Where run artifacts are written.
  -h, --help                Show this message.

The server binds to ${HOST} only (NFR-6) and requires the startup token
printed below on every request (AO-6). Set \`AGENT_OFFICE_TOKEN\` to pin it
instead of generating a fresh one.
`.trim();

function parseArgs(argv: string[]): CliOptions {
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
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
  const options = parseArgs(process.argv.slice(2));

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
  const { token, pinned } = resolveAuthToken();

  const registry = await loadRegistry(options.repoRoot);
  const store = new FileRunStore(options.runsRoot);

  const supervisor = new RunSupervisor({
    registry,
    store,
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

  const app = await buildServer({ registry, store, supervisor, token });

  await app.listen({ host: HOST, port: options.port });

  /**
   * AO-6, the `npm run web` half: drop the token where the Vite dev server's
   * proxy (`packages/web/vite.config.ts`) can read it and attach it to every
   * proxied request, so the ordinary two-terminal workflow — `npm run serve`
   * in one, `npm run web` in the other — needs nobody to paste anything.
   *
   * A file is what makes that possible without the two processes sharing any
   * other channel (no IPC, no agreed port to poll, and a fresh random token
   * per `serve` invocation means an environment variable set once would go
   * stale the next run). The file lives under `os.tmpdir()`, which on every
   * platform this runs on is already scoped to the current OS user account —
   * not `0.0.0.0`-reachable, not readable by a different local account any
   * more than the rest of this user's files already are. That is the same
   * boundary AO-6's own finding leans on ("a low-privilege [account] that
   * could not otherwise read your files"): this file adds nothing a same-
   * account process couldn't already get by asking this very server for it
   * with the right header, and it is unreachable to exactly the attacker
   * AO-6 is about. `0o600` is applied as a second layer where the platform
   * honours Unix permission bits at all — advisory on Windows, but free, and
   * meaningful on every other target.
   *
   * This is emphatically a DEVELOPMENT convenience, not a claim that the Vite
   * port is as protected as this one. Anything that can reach the Vite dev
   * server's port gets the exact same access this token grants, because the
   * proxy forwards its requests here with the token already attached — Vite's
   * dev server has no `Host`/`Origin` checks of its own. That is an accepted,
   * documented trade for local development ergonomics, not an oversight; see
   * `vite.config.ts` for the other half of this same comment.
   */
  try {
    mkdirSync(path.dirname(DEV_TOKEN_FILE), { recursive: true });
    writeFileSync(DEV_TOKEN_FILE, token, { mode: 0o600 });
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
  process.stdout.write(
    `  token:    ${pinned ? 'pinned from AGENT_OFFICE_TOKEN' : 'generated for this process only'}\n`,
  );
  process.stdout.write(
    `\nAO-6: every request needs the token above (header \`x-agent-office-token\`, or ` +
      `\`?${AUTH_TOKEN_QUERY_PARAM}=...\` once, for a browser's first load only — see ` +
      `packages/web/src/api.ts for why the header is preferred everywhere else).\n` +
      `npm run web needs no token pasted in: its Vite proxy reads it from ${DEV_TOKEN_FILE}.\n`,
  );
  process.stdout.write(`\nCtrl+C to stop.\n`);

  installShutdown(app, supervisor);
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
        await app.close();
      } catch (error) {
        process.stderr.write(`shutdown error: ${describe(error)}\n`);
        process.exitCode = 1;
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

main().catch((error: unknown) => {
  process.stderr.write(`\nserver failed to start.\n\n${describe(error)}\n`);
  process.exitCode = 1;
});
