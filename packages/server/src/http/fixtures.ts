import {
  isRunTerminal,
  type AgentDef,
  type RunState,
} from '@agent-office/shared';
import {
  MANAGER_PLAN_ASSIGNMENT_ID,
  MANAGER_SYNTHESIS_ASSIGNMENT_ID,
} from '../orchestrator/manager.js';
import { ScriptedProvider, type ScriptedResponse } from '../providers/scripted.js';
import type { AgentProvider } from '../providers/types.js';
import { buildRegistry, type Registry } from '../registry/index.js';
import type { ExecuteRunDeps } from '../orchestrator/runner.js';
import type { RunSupervisor } from './supervisor.js';

/**
 * Shared fixtures for the HTTP tests.
 *
 * Hermetic on purpose: the real catalog is 154 agents, and loading it would
 * couple every assertion about routing and buffering to whichever agents happen
 * to be in the repo that week. Not a `.test.ts` file, so vitest does not try to
 * run it — it is imported by the two that it serves.
 */

function agent(name: string, category: string): AgentDef {
  return {
    name,
    description: `${name} does things.`,
    tools: ['Read', 'Grep'],
    category,
    filePath: `categories/${category}/${name}.md`,
    systemPrompt: `You are ${name}.`,
  };
}

/**
 * Includes the three orchestration agents the Manager's own system prompt is
 * composed from (FR-M1); without them `planRun` refuses to start at all.
 */
export function testRegistry(): Registry {
  return buildRegistry([
    agent('agent-organizer', '09-meta-orchestration'),
    agent('multi-agent-coordinator', '09-meta-orchestration'),
    agent('task-distributor', '09-meta-orchestration'),
    agent('alpha', '01-core-development'),
    agent('beta', '04-quality-security'),
    agent('gamma', '10-research-analysis'),
  ]);
}

/**
 * Three assignments across two phases with a real dependency edge, so a run
 * exercises phase sequencing rather than a flat fan-out. The assignment count
 * is asserted on directly, so changing it means changing the tests.
 */
export const TEST_PLAN = {
  summary: 'Test plan.',
  domain: 'software',
  reportStyle: 'engineering',
  phases: [
    {
      id: 'analysis',
      name: 'Analysis',
      parallel: false,
      assignments: [
        {
          id: 'lead',
          agentName: 'alpha',
          objective: 'Produce the primary analysis.',
          deliverable: 'reports/01-alpha.md',
          dependsOn: [],
        },
      ],
    },
    {
      id: 'review',
      name: 'Review',
      parallel: true,
      assignments: [
        {
          id: 'review-1',
          agentName: 'beta',
          objective: 'Review the analysis.',
          deliverable: 'reports/02-beta.md',
          dependsOn: ['lead'],
        },
        {
          id: 'review-2',
          agentName: 'gamma',
          objective: 'Review the analysis again.',
          deliverable: 'reports/03-gamma.md',
          dependsOn: ['lead'],
        },
      ],
    },
  ],
};

export const TEST_SYNTHESIS = '# Synthesis\n\nEvery report was collected.';

/**
 * A `makeProvider` for {@link RunSupervisor}, scripted to return
 * {@link TEST_PLAN}.
 *
 * `overrides` is keyed by assignment id, which is how a test makes one
 * assignment hang (for cancellation) or fail without affecting the others.
 */
export function testProviderFactory(
  overrides: Record<string, ScriptedResponse> = {},
): () => AgentProvider {
  return () =>
    new ScriptedProvider({
      byAssignment: {
        [MANAGER_PLAN_ASSIGNMENT_ID]: {
          text: JSON.stringify(TEST_PLAN),
          usage: { inputTokens: 120, outputTokens: 40 },
        },
        [MANAGER_SYNTHESIS_ASSIGNMENT_ID]: {
          text: TEST_SYNTHESIS,
          usage: { inputTokens: 200, outputTokens: 60 },
        },
        ...overrides,
      },
      fallback: {
        text: '## Findings\n\nScripted placeholder.',
        usage: { inputTokens: 50, outputTokens: 25 },
      },
    });
}

/**
 * Vitest budget for any test that drives a whole run end to end.
 *
 * Lives here, beside the helpers those tests wait on, because it used to live
 * in two test files as a private constant while the helpers carried their own
 * separate, tighter defaults — and the two drifted in exactly the way that
 * arrangement invites. Three tests were given an explicit 20s budget in Phase 7
 * to stop them failing under load; they went on failing, because
 * {@link waitForTerminal} gave up at its own hardcoded 10s first and no call
 * site passed anything else. The raised budget changed the error message and
 * nothing else. One constant, one place, so that cannot happen again.
 *
 * 45s is set from measurement rather than taste: across five full-suite runs
 * the slowest end-to-end test was observed at 20.2s, and it is the aggregate
 * load of ~1,000 other tests contending for the same disk that puts it there,
 * not any single slow operation. Roughly 2x the worst observation leaves room
 * for a machine busier than the one this was measured on, while still failing
 * a genuine hang in under a minute.
 */
export const SLOW_RUN_TIMEOUT_MS = 45_000;

/**
 * How long the pollers below wait before giving up.
 *
 * Deliberately BELOW {@link SLOW_RUN_TIMEOUT_MS}, and that ordering is the
 * point rather than an accident: whichever deadline fires first is the one that
 * writes the failure message, and "did not finish within 40000ms (status:
 * designing)" tells you where a run got stuck, whereas vitest's own timeout
 * tells you only that something took too long. The helper should always win
 * that race — but it must not win it so early that a merely-loaded machine
 * looks like a hang, which is what the old 10s did.
 */
export const RUN_POLL_TIMEOUT_MS = 40_000;

/**
 * Poll until the run reaches a terminal status.
 *
 * Polling rather than a subscription because the point of most of these tests is
 * the *outcome*, and a test that hangs forever on a missing event is far harder
 * to diagnose than one that fails with the status it got stuck on.
 */
export async function waitForTerminal(
  supervisor: RunSupervisor,
  runId: string,
  timeoutMs = RUN_POLL_TIMEOUT_MS,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await supervisor.getRunState(runId);
    if (isRunTerminal(run.status)) return run;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} did not finish within ${timeoutMs}ms (status: ${run.status})`);
    }
    await sleep(5);
  }
}

/**
 * Poll until `predicate` holds, so tests never wait on a fixed sleep.
 *
 * The predicate may be async, because most of what these tests wait on is
 * behind a promise-returning accessor.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = RUN_POLL_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `produceDeliverable` stand-in for tests (Phase 5).
 *
 * The real one launches headless Chrome, which costs a couple of seconds per
 * run and needs a browser installed. Neither is appropriate for tests about
 * dispatch, event fan-out or run state, so those inject this instead. The
 * deliverable pipeline has its own coverage in `src/reports/`, against a real
 * browser.
 *
 * It reports no `pdfPath`, which is the honest shape of "no PDF was produced" —
 * so any test asserting on a PDF has to opt into the real thing rather than
 * accidentally passing against a fake one.
 */
export function stubDeliverable(): NonNullable<ExecuteRunDeps['produceDeliverable']> {
  return async () => ({
    theme: 'engineering',
    rationale: 'stubbed in tests; no model was called and no browser was launched',
  });
}
