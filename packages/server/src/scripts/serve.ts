import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../env.js';
import { buildServer } from '../http/server.js';
import { RunSupervisor } from '../http/supervisor.js';
import { AVAILABLE_PROVIDER_IDS, DEFAULT_PROVIDER } from '../providers/factory.js';
import { loadRegistry } from '../registry/index.js';
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
 * NFR-6: loopback only, never `0.0.0.0`.
 *
 * There is no authentication anywhere in this application. Binding to a
 * wildcard address would expose an unauthenticated API that starts processes
 * and reads files to every machine on the network. This is a constant rather
 * than an option on purpose — there is no flag to get this wrong with.
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
}

const USAGE = `
Usage: npm run serve [-- options]

Options:
  --provider <id>      Default provider for new runs (default: ${DEFAULT_PROVIDER}).
                       Use 'scripted' for a free, no-model dry run.
  --port <n>           Listen port (default ${DEFAULT_PORT}, or $PORT).
  --concurrency <n>    Default parallel assignments per phase (default 3).
  --timeout <ms>       Default per-assignment timeout (default 600000).
  --step-delay <ms>    Slow the scripted provider by this much per event, so
                       live status and reattach are observable by hand.
  --repo-root <path>   Subagent catalog root (default: this repository).
  --runs-root <path>   Where run artifacts are written.
  -h, --help           Show this message.

The server binds to ${HOST} only. There is no authentication (NFR-6).
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

  const registry = await loadRegistry(options.repoRoot);
  const store = new FileRunStore(options.runsRoot);

  const supervisor = new RunSupervisor({
    registry,
    store,
    defaultProviderId: options.provider,
    ...(options.stepDelayMs === undefined ? {} : { stepDelayMs: options.stepDelayMs }),
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

  const app = await buildServer({ registry, store, supervisor });

  await app.listen({ host: HOST, port: options.port });

  process.stdout.write(`agent office server\n`);
  process.stdout.write(`  url:      http://${HOST}:${options.port}\n`);
  process.stdout.write(`  registry: ${registry.agents.length} agents from ${options.repoRoot}\n`);
  process.stdout.write(`  runs:     ${store.root}\n`);
  process.stdout.write(`  provider: ${options.provider}\n`);
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
