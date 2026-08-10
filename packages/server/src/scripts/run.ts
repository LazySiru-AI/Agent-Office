import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@agent-office/shared';
import { loadRegistry } from '../registry/index.js';
import { ScriptedProvider } from '../providers/scripted.js';
import type { AgentProvider } from '../providers/types.js';
import { FileRunStore, defaultRunsRoot } from '../store/fileStore.js';
import { executeRun } from '../orchestrator/runner.js';
import {
  MANAGER_PLAN_ASSIGNMENT_ID,
  MANAGER_SYNTHESIS_ASSIGNMENT_ID,
} from '../orchestrator/manager.js';

/**
 * Phase 2 exit-criterion CLI: run one task end to end.
 *
 *   npm run run -- "Review the auth module for security issues"
 *   npm run run -- "..." --provider scripted --concurrency 2
 *
 * Only the `scripted` provider exists today; the Claude Code adapter is Phase 1,
 * which is blocked on the CLI not being installed. Asking for it fails with an
 * explanation rather than a confusing stack trace.
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
  quiet: boolean;
}

const USAGE = `
Usage: npm run run -- "<task>" [options]

Options:
  --provider <id>      scripted (default). claude-code arrives in Phase 1.
  --concurrency <n>    Parallel assignments per phase (default 3).
  --timeout <ms>       Per-assignment timeout (default 600000).
  --budget <tokens>    Total run token budget. Unlimited when omitted.
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

  return {
    task,
    provider: flags.get('provider') ?? 'scripted',
    repoRoot: path.resolve(flags.get('repo-root') ?? process.env['AGENT_OFFICE_REPO_ROOT'] ?? DEFAULT_REPO_ROOT),
    runsRoot: path.resolve(flags.get('runs-root') ?? defaultRunsRoot()),
    quiet: flags.get('quiet') === 'true',
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

/**
 * Domain presets for the scripted provider's canned plan.
 *
 * The scripted provider cannot reason, so the "Manager" has to be told which
 * team to field. Keyword matching is crude on purpose — its only job is to make
 * the no-cost dry run exercise more than one domain, which is the Phase 2 exit
 * criterion. A real provider ignores all of this.
 *
 * Every `lead`/`reviewers` name is checked against the registry before use.
 */
interface ScriptedDomain {
  domain: string;
  reportStyle: string;
  keywords: string[];
  lead: string;
  reviewers: string[];
}

const SCRIPTED_DOMAINS: ScriptedDomain[] = [
  {
    domain: 'legal',
    reportStyle: 'legal-memo',
    keywords: ['nda', 'contract', 'legal', 'clause', 'agreement', 'vendor', 'liability', 'terms'],
    lead: 'legal-advisor',
    reviewers: ['compliance-auditor', 'risk-manager'],
  },
  {
    domain: 'tax',
    reportStyle: 'advisory',
    keywords: ['tax', 'vat', 'deduction', 'filing', 'audit', 'accounting'],
    lead: 'business-analyst',
    reviewers: ['risk-manager', 'research-analyst'],
  },
  {
    domain: 'software',
    reportStyle: 'engineering',
    keywords: ['code', 'api', 'bug', 'refactor', 'auth', 'service', 'module', 'performance'],
    lead: 'backend-developer',
    reviewers: ['security-auditor', 'code-reviewer'],
  },
];

/** Used when the task matches no preset, and as the shape of every preset. */
const SCRIPTED_FALLBACK_DOMAIN: ScriptedDomain = {
  domain: 'general',
  reportStyle: 'briefing',
  keywords: [],
  lead: 'research-analyst',
  reviewers: ['business-analyst', 'technical-writer'],
};

function chooseScriptedDomain(task: string, known: ReadonlySet<string>): ScriptedDomain {
  const haystack = task.toLowerCase();
  const matched = SCRIPTED_DOMAINS.find((candidate) =>
    candidate.keywords.some((keyword) => haystack.includes(keyword)),
  );

  for (const candidate of [matched, SCRIPTED_FALLBACK_DOMAIN]) {
    if (candidate === undefined) continue;
    const team = [candidate.lead, ...candidate.reviewers];
    if (team.every((name) => known.has(name))) return candidate;
  }

  throw new Error(
    'the scripted provider\'s canned teams reference agents that are not in the registry. ' +
      'Update SCRIPTED_DOMAINS in src/scripts/run.ts.',
  );
}

/**
 * The plan the scripted "Manager" returns. Two phases with a real dependency
 * edge, so the dry run covers phase sequencing, `dependsOn` briefing and
 * intra-phase parallelism rather than just a flat fan-out.
 */
function scriptedPlanJson(task: string, known: ReadonlySet<string>): string {
  const choice = chooseScriptedDomain(task, known);

  const plan = {
    summary: `Scripted dry run for: ${task}`,
    domain: choice.domain,
    reportStyle: choice.reportStyle,
    phases: [
      {
        id: 'analysis',
        name: 'Analysis',
        parallel: false,
        assignments: [
          {
            id: 'lead-analysis',
            agentName: choice.lead,
            objective: `Produce the primary analysis for: ${task}`,
            deliverable: `reports/01-${choice.lead}.md`,
            dependsOn: [],
          },
        ],
      },
      {
        id: 'review',
        name: 'Review',
        parallel: true,
        assignments: choice.reviewers.map((agentName, index) => ({
          id: `review-${index + 1}`,
          agentName,
          objective: `Review the primary analysis from a ${agentName} perspective.`,
          deliverable: `reports/0${index + 2}-${agentName}.md`,
          dependsOn: ['lead-analysis'],
        })),
      },
    ],
  };

  return JSON.stringify(plan, null, 2);
}

function makeProvider(id: string, task: string, knownAgentNames: ReadonlySet<string>): AgentProvider {
  if (id === 'scripted') {
    // The Manager's planning and synthesis turns go through the provider too, so
    // a single placeholder for everything can never complete a run: planning
    // would get prose where it requires JSON and burn the whole repair budget.
    // Both manager turns are scripted by assignment id; agents get the fallback.
    return new ScriptedProvider({
      byAssignment: {
        [MANAGER_PLAN_ASSIGNMENT_ID]: {
          text: scriptedPlanJson(task, knownAgentNames),
          usage: { inputTokens: 1200, outputTokens: 400 },
        },
        [MANAGER_SYNTHESIS_ASSIGNMENT_ID]: {
          text: [
            '# Scripted synthesis',
            '',
            'This document was assembled by the scripted provider. No model was',
            'called, so the section below is structural proof only — it shows the',
            'orchestrator collected every report and reached the synthesis step.',
            '',
            'Replace `--provider scripted` with a real provider once Phase 1 lands.',
          ].join('\n'),
          usage: { inputTokens: 2000, outputTokens: 600 },
        },
      },
      fallback: {
        text: [
          '## Findings',
          '',
          'Placeholder report from the scripted provider. No model was called.',
          '',
          'Replace `--provider scripted` with a real provider once Phase 1 lands.',
        ].join('\n'),
        usage: { inputTokens: 500, outputTokens: 250 },
      },
    });
  }

  if (id === 'claude-code') {
    throw new Error(
      'the claude-code provider is not implemented yet (Phase 1).\n' +
        'It is blocked on the Claude Code CLI not being installed — see SETUP.md.',
    );
  }

  throw new Error(`unknown provider "${id}". Known: scripted.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // The registry loads first: the scripted provider's canned plan has to name
  // agents that actually exist, and is validated against these names.
  const registry = await loadRegistry(options.repoRoot);
  const knownAgentNames = new Set(registry.agents.map((agent) => agent.name));

  const provider = makeProvider(options.provider, options.task, knownAgentNames);

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
