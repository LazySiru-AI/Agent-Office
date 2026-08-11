import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@agent-office/shared';
import { loadRegistry } from '../registry/index.js';
import { loadDotEnv } from '../env.js';
import { DEFAULT_PROVIDER, makeProvider, type MakeProviderOptions } from '../providers/factory.js';
import { FileRunStore, defaultRunsRoot } from '../store/fileStore.js';
import { executeRun } from '../orchestrator/runner.js';

/**
 * Phase 2 exit-criterion CLI: run one task end to end.
 *
 *   npm run run -- "Review the auth module for security issues"
 *   npm run run -- "..." --provider scripted --concurrency 2
 *
 * `scripted` costs nothing and is the default. `claude-code` calls the real CLI
 * and spends real money; it reports itself unavailable, with the reason, if the
 * CLI is missing or not signed in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/scripts` -> src -> server -> packages -> project root, which holds `categories/`. */
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

interface CliOptions {
  task: string;
  provider: string;
  repoRoot: string;
  runsRoot: string;
  concurrency?: number;
  timeoutMs?: number;
  tokenBudget?: number;
  maxCostUsd?: number;
  quiet: boolean;
}

const USAGE = `
Usage: npm run run -- "<task>" [options]

Options:
  --provider <id>      Engine to run agents through (default: claude-code,
                       which spends real money). 'scripted' is free.
  --concurrency <n>    Parallel assignments per phase (default 3).
  --timeout <ms>       Per-assignment timeout (default 600000).
  --budget <tokens>    Total run token budget. Unlimited when omitted.
  --max-cost <usd>     Per-assignment spend cap (FR-M8). Unlimited when omitted.
  --repo-root <path>   Subagent catalog root (default: this repository).
  --runs-root <path>   Where run artifacts are written.
  --quiet              Only print the final summary.
  -h, --help           Show this message.
`.trim();

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === '--quiet') {
      flags.set('quiet', 'true');
      continue;
    }
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`option ${arg} needs a value`);
      }
      flags.set(arg.slice(2), value);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  const task = positional.join(' ').trim();
  if (task === '') {
    throw new Error(`no task given.\n\n${USAGE}`);
  }

  const numeric = (key: string): number | undefined => {
    const raw = flags.get(key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${key} must be a positive number, got "${raw}"`);
    }
    return value;
  };

  const concurrency = numeric('concurrency');
  const timeoutMs = numeric('timeout');
  const tokenBudget = numeric('budget');
  // Same `numeric` helper, same "positive or reject" rule as every other flag
  // here — the CLI path gets the same defence-in-depth `buildArgs` also
  // applies (see `providers/claude-code/provider.ts`), rather than trusting
  // this parser to be the only gate.
  const maxCostUsd = numeric('max-cost');

  return {
    task,
    provider: flags.get('provider') ?? DEFAULT_PROVIDER,
    repoRoot: path.resolve(flags.get('repo-root') ?? process.env['AGENT_OFFICE_REPO_ROOT'] ?? DEFAULT_REPO_ROOT),
    runsRoot: path.resolve(flags.get('runs-root') ?? defaultRunsRoot()),
    quiet: flags.get('quiet') === 'true',
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Before any provider resolves its key from the environment.
  loadDotEnv(options.repoRoot);

  // The registry loads first: the scripted provider's canned plan has to name
  // agents that actually exist, and is validated against these names.
  const registry = await loadRegistry(options.repoRoot);
  const knownAgentNames = new Set(registry.agents.map((agent) => agent.name));

  // DEFECT FIXED (FR-M8): this call used to pass no options, so `--max-cost`
  // — the flag `agent.ts` (the single-agent debug probe) has always honoured
  // — was accepted by `parseArgs` here and then dropped on the floor before
  // reaching `makeProvider`. `--budget` and `--timeout` already flowed into
  // `dispatch` below; this gives `--max-cost` the same real path, through the
  // same `MakeProviderOptions` shape `supervisor.ts` uses for the HTTP side.
  const providerOptions: MakeProviderOptions = {
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
  };
  const provider = makeProvider(options.provider, options.task, knownAgentNames, providerOptions);

  const availability = await provider.isAvailable();
  if (!availability.ok) {
    throw new Error(`provider "${options.provider}" unavailable: ${availability.reason ?? 'unknown'}`);
  }

  const store = new FileRunStore(options.runsRoot);

  // Ctrl+C cancels the run rather than killing the process mid-write, so the
  // persisted state stays consistent (FR-M9, NFR-2).
  const controller = new AbortController();
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write('\ncancelling run (Ctrl+C again to force quit)...\n');
    controller.abort();
  });

  const log = (message: string): void => {
    if (!options.quiet) process.stdout.write(`${message}\n`);
  };

  const onEvent = (event: AgentEvent): void => {
    if (options.quiet) return;
    if (event.t === 'status') {
      log(`  ${event.assignmentId.padEnd(24)} ${event.status}`);
    } else if (event.t === 'error') {
      log(`  ${event.assignmentId.padEnd(24)} ${event.fatal ? 'ERROR' : 'warn'}: ${event.message}`);
    }
  };

  log(`registry: ${registry.agents.length} agents from ${options.repoRoot}`);
  log(`provider: ${options.provider}`);
  log('');

  const result = await executeRun({
    registry,
    provider,
    store,
    task: options.task,
    signal: controller.signal,
    onEvent,
    logger: log,
    dispatch: {
      ...(options.concurrency === undefined ? {} : { maxConcurrency: options.concurrency }),
      ...(options.timeoutMs === undefined ? {} : { assignmentTimeoutMs: options.timeoutMs }),
      ...(options.tokenBudget === undefined ? {} : { runTokenBudget: options.tokenBudget }),
    },
  });

  const { run } = result;
  const runDir = store.runDir(run.id);

  process.stdout.write('\n');
  process.stdout.write(`${'='.repeat(60)}\n`);
  process.stdout.write(`run ${run.id} — ${run.status}\n`);
  process.stdout.write(`${'='.repeat(60)}\n`);

  if (run.plan !== undefined) {
    process.stdout.write(`  domain:      ${run.plan.domain}\n`);
    process.stdout.write(`  team:        ${[...new Set(run.assignments.map((a) => a.agentName))].join(', ')}\n`);
  }
  if (result.dispatch !== undefined) {
    const { completed, failed, skipped } = result.dispatch;
    process.stdout.write(`  assignments: ${completed} done, ${failed} failed, ${skipped} skipped\n`);
  }
  if (run.error !== undefined) {
    process.stdout.write(`  error:       ${run.error}\n`);
  }
  process.stdout.write(`  artifacts:   ${runDir}\n`);
  if (run.reportPath !== undefined) {
    process.stdout.write(`  report:      ${path.join(runDir, run.reportPath)}\n`);
  }

  if (run.status !== 'done') process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nrun failed.\n\n${message}\n`);
  process.exitCode = 1;
});
