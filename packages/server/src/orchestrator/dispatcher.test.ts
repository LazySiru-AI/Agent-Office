import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canTransitionAssignment,
  LoggedAgentEventSchema,
  RunPlanSchema,
  type AgentDef,
  type AgentEvent,
  type AssignmentStatus,
  type RunPlan,
  type RunState,
} from '@agent-office/shared';
import { buildRegistry } from '../registry/index.js';
import { ScriptedProvider, type ScriptedProviderOptions } from '../providers/scripted.js';
import type { AgentProvider, AgentRunRequest, ProviderAvailability, ProviderId } from '../providers/types.js';
import { MemoryRunStore } from '../store/memoryStore.js';
import { FileRunStore } from '../store/fileStore.js';
import { dispatchRun, materialiseAssignments, normaliseGluedHeading } from './dispatcher.js';

function makeAgent(name: string): AgentDef {
  return {
    name,
    description: `${name} does things.`,
    tools: ['Read', 'Write'],
    category: '01-core-development',
    filePath: `categories/01-core-development/${name}.md`,
    systemPrompt: `You are ${name}.`,
  };
}

const REGISTRY = buildRegistry([
  makeAgent('alpha'),
  makeAgent('beta'),
  makeAgent('gamma'),
  makeAgent('delta'),
]);

/** Two phases: alpha and beta in parallel, then gamma depending on alpha. */
function twoPhasePlan(): RunPlan {
  return RunPlanSchema.parse({
    summary: 'Do the thing.',
    domain: 'software',
    reportStyle: 'engineering',
    phases: [
      {
        id: 'research',
        name: 'Research',
        parallel: true,
        assignments: [
          {
            id: 'a',
            agentName: 'alpha',
            objective: 'Investigate.',
            deliverable: 'reports/01-alpha.md',
            dependsOn: [],
          },
          {
            id: 'b',
            agentName: 'beta',
            objective: 'Survey.',
            deliverable: 'reports/02-beta.md',
            dependsOn: [],
          },
        ],
      },
      {
        id: 'synthesis',
        name: 'Synthesis',
        parallel: true,
        assignments: [
          {
            id: 'c',
            agentName: 'gamma',
            objective: 'Combine.',
            deliverable: 'reports/03-gamma.md',
            dependsOn: ['a'],
          },
        ],
      },
    ],
  });
}

function makeRun(plan: RunPlan, task = 'Build a thing.'): RunState {
  return {
    id: '20260809-120000-test',
    task,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    plan,
    assignments: materialiseAssignments(plan),
  };
}

async function setup(scripted: ScriptedProviderOptions = {}, plan: RunPlan = twoPhasePlan()) {
  const store = new MemoryRunStore();
  const provider = new ScriptedProvider(scripted);
  const run = makeRun(plan);
  await store.saveRun(run);
  return { store, provider, run };
}

/**
 * A `MemoryRunStore` whose `saveRun` takes 8ms, standing in for real disk.
 *
 * The concurrent-reviewers race (CRITICAL defect below) needs two lanes to
 * genuinely interleave around the same target's status, not just run one
 * after the other quickly enough that they never overlap. `MemoryRunStore`'s
 * `saveRun` resolves almost immediately, which under-tests exactly the
 * scenario that broke against the real `FileRunStore` on real disk. The QA
 * reproduction that found the defect used a store with this same 8ms
 * `saveRun` latency — `fileStore.ts`'s own `renameWithRetry` backoff exists
 * because that latency is real, not a test artefact.
 */
class SlowRunStore extends MemoryRunStore {
  override async saveRun(run: RunState): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 8));
    await super.saveRun(run);
  }
}

/** One assignment reviewed by two others in the same parallel phase. */
function reviewedByTwoPlan(): RunPlan {
  return RunPlanSchema.parse({
    summary: 'Two reviewers review one lead.',
    domain: 'software',
    reportStyle: 'engineering',
    phases: [
      {
        id: 'lead',
        name: 'Lead',
        parallel: true,
        assignments: [
          {
            id: 'lead-a',
            agentName: 'alpha',
            objective: 'Produce the lead work.',
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
            objective: 'Review the lead work.',
            deliverable: 'reports/02-beta.md',
            dependsOn: ['lead-a'],
          },
          {
            id: 'review-2',
            agentName: 'gamma',
            objective: 'Also review the lead work.',
            deliverable: 'reports/03-gamma.md',
            dependsOn: ['lead-a'],
          },
        ],
      },
    ],
  });
}

/** One phase, one assignment, no dependents — for tests that must not risk
 * tripping any *other* store write in the same run (see
 * `ThrowsOnAssignmentStatusStore`'s `persistent` mode below). */
function singleAssignmentPlan(): RunPlan {
  return RunPlanSchema.parse({
    summary: 'Just the one.',
    domain: 'software',
    reportStyle: 'engineering',
    phases: [
      {
        id: 'only',
        name: 'Only',
        parallel: true,
        assignments: [
          {
            id: 'solo',
            agentName: 'alpha',
            objective: 'Work alone.',
            deliverable: 'reports/01-alpha.md',
            dependsOn: [],
          },
        ],
      },
    ],
  });
}

describe('materialiseAssignments', () => {
  it('flattens phases in execution order and stamps the phase id', () => {
    const assignments = materialiseAssignments(twoPhasePlan());

    expect(assignments.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(assignments.map((a) => a.phaseId)).toEqual(['research', 'research', 'synthesis']);
    expect(assignments.every((a) => a.status === 'pending')).toBe(true);
  });
});

describe('dispatchRun — happy path', () => {
  it('completes every assignment and writes each report', async () => {
    const { store, provider, run } = await setup({
      fallback: { text: 'Findings.', usage: { inputTokens: 10, outputTokens: 5 } },
    });

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.haltedBecause).toBeUndefined();
    expect(run.assignments.every((a) => a.status === 'done')).toBe(true);

    const reports = store.reportsFor(run.id);
    expect(reports.get('reports/01-alpha.md')).toBe('Findings.');
    expect(reports.get('reports/03-gamma.md')).toBe('Findings.');
  });

  it('persists status transitions, not just broadcasts them (NFR-7)', async () => {
    // Provider events were always written to the log; status transitions were
    // broadcast to live subscribers only. Replay reads the log and nothing
    // else, so without this the office replays with every character stuck in
    // `pending` — a renderer bug that is not in the renderer.
    const { store, provider, run } = await setup({
      fallback: { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const logged = await store.readEvents(run.id, 'a');
    const statuses = logged
      .map((entry) => entry.event)
      .filter((event) => event.t === 'status')
      .map((event) => (event.t === 'status' ? event.status : ''));

    expect(statuses).toContain('working');
    expect(statuses).toContain('done');
    // The order on disk is what replay folds, so it has to be the real order.
    expect(statuses.indexOf('working')).toBeLessThan(statuses.indexOf('done'));
  });

  it('accumulates usage per assignment', async () => {
    const { store, provider, run } = await setup({
      fallback: { text: 'ok', usage: { inputTokens: 7, outputTokens: 3 } },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(run.assignments[0]?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('gives a dependent assignment its upstream report, and nothing more', async () => {
    const briefs = new Map<string, string>();
    const { store, provider, run } = await setup({
      byAssignment: {
        a: { text: 'ALPHA-REPORT-BODY' },
        b: { text: 'BETA-REPORT-BODY' },
        c: { text: 'combined' },
      },
      onRequest: (request) => briefs.set(request.assignmentId, request.task),
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const gammaBrief = briefs.get('c') ?? '';
    expect(gammaBrief).toContain('ALPHA-REPORT-BODY');
    // FR-M5: beta is not a declared dependency, so it must not leak in.
    expect(gammaBrief).not.toContain('BETA-REPORT-BODY');
    expect(gammaBrief).toContain('Build a thing.');
  });
});

describe('dispatchRun — concurrency (FR-M4)', () => {
  it('respects the cap within a parallel phase', async () => {
    const plan = RunPlanSchema.parse({
      summary: 's',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'wide',
          name: 'Wide',
          parallel: true,
          assignments: ['alpha', 'beta', 'gamma', 'delta'].map((agentName, index) => ({
            id: `w${index}`,
            agentName,
            objective: 'work',
            deliverable: `reports/0${index}-${agentName}.md`,
            dependsOn: [],
          })),
        },
      ],
    });

    const { store, provider, run } = await setup({ fallback: { text: 'x', delayMs: 20 } }, plan);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      options: { maxConcurrency: 2 },
    });

    expect(provider.peakConcurrency).toBeLessThanOrEqual(2);
    expect(run.assignments.every((a) => a.status === 'done')).toBe(true);
  });

  it('runs a non-parallel phase one at a time regardless of the cap', async () => {
    const plan = RunPlanSchema.parse({
      summary: 's',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'serial',
          name: 'Serial',
          parallel: false,
          assignments: ['alpha', 'beta', 'gamma'].map((agentName, index) => ({
            id: `s${index}`,
            agentName,
            objective: 'work',
            deliverable: `reports/0${index}-${agentName}.md`,
            dependsOn: [],
          })),
        },
      ],
    });

    const { store, provider, run } = await setup({ fallback: { text: 'x', delayMs: 10 } }, plan);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      options: { maxConcurrency: 5 },
    });

    expect(provider.peakConcurrency).toBe(1);
  });
});

describe('dispatchRun — failure handling', () => {
  it('marks an assignment failed when the provider reports a fatal error', async () => {
    const { store, provider, run } = await setup({
      byAssignment: { a: { failWith: 'model refused' } },
      fallback: { text: 'ok' },
    });

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(run.assignments[0]?.status).toBe('failed');
    expect(run.assignments[0]?.error).toContain('model refused');
    expect(result.failed).toBe(1);
  });

  it('fails an assignment that produces no report (FR-M6)', async () => {
    const { store, provider, run } = await setup({
      byAssignment: { a: { text: '   ' } },
      fallback: { text: 'ok' },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(run.assignments[0]?.status).toBe('failed');
    expect(run.assignments[0]?.error).toContain('no report');
  });

  it('skips a dependent when its dependency failed, rather than briefing it blind', async () => {
    const { store, provider, run } = await setup({
      byAssignment: { a: { failWith: 'boom' } },
      fallback: { text: 'ok' },
    });

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const gamma = run.assignments.find((a) => a.id === 'c');
    expect(gamma?.status).toBe('skipped');
    expect(result.skipped).toBe(1);
    // beta is independent and must still have run.
    expect(run.assignments.find((a) => a.id === 'b')?.status).toBe('done');
  });

  it('fails an assignment whose deliverable path escapes the run directory', async () => {
    // The escaping deliverable is injected AFTER plan validation, not through
    // it, because `RunPlanSchema` now refuses this value outright (see the test
    // below, and `DeliverablePath` in `shared/src/plan.ts`). That makes this
    // test defence-in-depth rather than the first line it used to be: it proves
    // the store still refuses a path that escapes even if a future caller ever
    // reaches the dispatcher without going through plan validation. Both checks
    // are worth having — the schema one gives a Manager a repairable error
    // (FR-M2), the store one is what actually protects the filesystem (NFR-1).
    const { store, provider, run } = await setup({ fallback: { text: 'payload' } });
    const target = run.assignments[0];
    if (target === undefined) throw new Error('the fixture plan produced no assignments');
    target.deliverable = '../../../escaped.md';

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(target.status).toBe('failed');
    expect(target.error).toContain('could not write report');
    // The escaping path specifically wrote nothing. Not "the run wrote
    // nothing" — this fixture's other assignments are independent of the one
    // sabotaged here and go on succeeding, which is itself the correct
    // behaviour: one bad deliverable fails its own assignment, not the run.
    const written = [...store.reportsFor(run.id).keys()];
    expect(written).not.toContain('../../../escaped.md');
    expect(written.some((reportPath) => reportPath.includes('escaped'))).toBe(false);
  });

  it('refuses a plan whose deliverable is not a markdown file inside reports/', () => {
    // The demonstrated defect: `deliverable` was only `z.string().min(1)`, and
    // the store's containment check treats the run's own directory as the
    // boundary — so `run.json` sat inside it and a plan naming it overwrote the
    // run's state file with markdown. `logs/<id>.jsonl` would have destroyed
    // that assignment's replay log the same way.
    const planWith = (deliverable: string): unknown => ({
      summary: 's',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'only',
          name: 'Only',
          parallel: true,
          assignments: [{ id: 'evil', agentName: 'alpha', objective: 'work', deliverable, dependsOn: [] }],
        },
      ],
    });

    for (const deliverable of [
      'run.json',
      'logs/evil.jsonl',
      '../../../escaped.md',
      'workspace/notes.md',
      'reports/nested/deep.md',
      'reports/notes.txt',
    ]) {
      expect(RunPlanSchema.safeParse(planWith(deliverable)).success).toBe(false);
    }

    expect(RunPlanSchema.safeParse(planWith('reports/01-alpha.md')).success).toBe(true);
  });
});

describe('dispatchRun — budgets and cancellation (FR-M8, FR-M9)', () => {
  it('fails an assignment that exceeds its timeout', async () => {
    const { store, provider, run } = await setup({
      byAssignment: { a: { hang: true } },
      fallback: { text: 'ok' },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      options: { assignmentTimeoutMs: 25 },
    });

    expect(run.assignments[0]?.status).toBe('failed');
    expect(run.assignments[0]?.error).toContain('timed out');
  });

  it('halts when the run token budget is exhausted', async () => {
    const { store, provider, run } = await setup({
      fallback: { text: 'ok', usage: { inputTokens: 900, outputTokens: 900 } },
    });

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      options: { runTokenBudget: 1000, maxConcurrency: 1 },
    });

    expect(result.haltedBecause).toBe('token-budget');
    expect(run.assignments.some((a) => a.status === 'pending')).toBe(true);
  });

  it('stops dispatching once cancelled', async () => {
    const controller = new AbortController();
    const { store, provider, run } = await setup({
      fallback: { text: 'ok', delayMs: 15 },
      onRequest: () => controller.abort(),
    });

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: controller.signal,
      options: { maxConcurrency: 1 },
    });

    expect(result.haltedBecause).toBe('cancelled');
    expect(result.completed).toBeLessThan(3);
  });

  it('gives a cancelled assignment a terminal status instead of leaving it stuck in `working` forever (FR-M9)', async () => {
    // MAJOR defect: cancelling mid-flight used to `return` early and leave the
    // assignment in `working`. The RUN reached terminal `cancelled`, but the
    // assignment never did — and `working` renders as "seated, typing loop",
    // so every reload of a cancelled run showed an agent still typing on a
    // run that was long over. `hang: true` never produces a terminal event on
    // its own, so the only way this assignment ever leaves `working` is via
    // the cancellation path under test.
    const controller = new AbortController();
    const { store, provider, run } = await setup({
      byAssignment: { a: { hang: true } },
      fallback: { text: 'ok' },
    });

    const dispatchPromise = dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: controller.signal,
      options: { maxConcurrency: 1 },
    });

    // Let `a` reach `working` before cancelling it mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await dispatchPromise;

    expect(result.haltedBecause).toBe('cancelled');
    const a = run.assignments.find((assignment) => assignment.id === 'a');
    // Not `working` — a terminal status, so replay stops rendering it as
    // still in progress once the run itself is over.
    //
    // `cancelled`, not `failed`. This assertion read `failed` for four phases,
    // and it was pinning a workaround rather than a requirement: `working`'s
    // only terminal exit used to be `failed`, so the dispatcher took it and
    // wrote the real cause into `error` text. Everything downstream read the
    // status instead — `ASSIGNMENT_BEHAVIOUR` gave the character
    // `idle_slumped` under an error bubble, and the run list counted the
    // assignment as failed — for work the user had deliberately stopped.
    // `shared/src/status.ts` now has a terminal `cancelled`; the error text
    // and `endedAt` below are unchanged, because knowing WHICH assignment was
    // in flight when the cancel landed was always the useful part.
    expect(a?.status).toBe('cancelled');
    expect(a?.error).toContain('cancelled');
    expect(a?.endedAt).toBeDefined();

    // Counted somewhere. The tally's buckets are meant to partition the
    // assignment list, and a new status is exactly how one silently stops
    // being counted at all — `cancelled` used to land in `failed` by accident
    // of the status it was given.
    expect(result.cancelled).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('lets a cancelled assignment reach `cancelled` from any point before it finishes', () => {
    // The edge is granted by `canTransitionAssignment`'s fallback rather than
    // written into `ASSIGNMENT_TRANSITIONS`, alongside `failed`. That is worth
    // an explicit test: a fallback is invisible in the table a reader checks
    // first, and the two statuses it grants are the two that can arrive from
    // outside the assignment's own lifecycle.
    for (const from of ['pending', 'briefing', 'working', 'blocked', 'reporting'] as const) {
      expect(canTransitionAssignment(from, 'cancelled'), `${from} -> cancelled`).toBe(true);
    }
    // Terminal stays terminal: a run cancelled after an assignment finished
    // must not retroactively un-finish it.
    for (const from of ['done', 'failed', 'skipped', 'cancelled'] as const) {
      expect(canTransitionAssignment(from, 'cancelled'), `${from} -> cancelled`).toBe(false);
    }
  });

  it('cuts an in-flight lane short once the token budget trips, instead of letting it run to completion (FR-M8)', async () => {
    // MODERATE defect: `enforceTokenBudget` only ran after an assignment
    // completed, and lanes already mid-flight when it tripped kept running
    // regardless — measured at concurrency 3, budget 12,000, six 10,000-token
    // assignments: 40,000 spent, 28,000 over, before halting. `w0` and `w1`
    // are fast and push the total over budget as soon as both land; `w2` and
    // `w3` are slow enough (50ms) to still be mid-pause at that moment, which
    // is exactly the "already in flight" lane this fix targets — before the
    // fix both finished anyway and banked their full usage.
    const plan = RunPlanSchema.parse({
      summary: 's',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'wide',
          name: 'Wide',
          parallel: true,
          assignments: ['alpha', 'beta', 'gamma', 'delta'].map((agentName, index) => ({
            id: `w${index}`,
            agentName,
            objective: 'work',
            deliverable: `reports/0${index}-${agentName}.md`,
            dependsOn: [],
          })),
        },
      ],
    });

    // `w0` has no delay, so it lands first and — because nothing has told it
    // to stop yet — the lane picks up `w2` immediately afterwards, which then
    // sits in a real 50ms pause. `w1` has a small delay of its own, so it
    // finishes *after* `w2` is already mid-pause: that is what makes `w2` a
    // genuinely "already in flight" lane at the moment `w1`'s completion pushes
    // the total over budget, rather than a lane that simply never got to start.
    const { store, provider, run } = await setup(
      {
        byAssignment: {
          // The fast/slow margin is 30x, not the 10x (5ms vs 50ms) it was
          // written with. That original ratio was comfortable on an idle
          // machine and not on a loaded one: this test failed three separate
          // times during a session that ran eight worker processes against this
          // checkout, each one investigated from scratch — once as an unnamed
          // failure nobody could reproduce, once by a worker that stashed its
          // own changes to prove the failure predated them, and once in an
          // integration run. It passes alone every time.
          //
          // Widening the margin is the honest cheap fix, not the right one. The
          // right one is a gate the test opens explicitly — `w2` waiting on a
          // promise this file resolves — which removes wall-clock from the
          // ordering entirely. That needs a new capability in `ScriptedProvider`
          // (`providers/scripted.ts`), which is production code shared by every
          // other test here, so it is recorded rather than smuggled into a
          // flake fix.
          w0: { text: 'fast', usage: { inputTokens: 500, outputTokens: 500 } },
          w1: { text: 'fast', usage: { inputTokens: 500, outputTokens: 500 }, delayMs: 20 },
          w2: { text: 'slow', usage: { inputTokens: 500, outputTokens: 500 }, delayMs: 600 },
          w3: { text: 'slow', usage: { inputTokens: 500, outputTokens: 500 }, delayMs: 600 },
        },
      },
      plan,
    );

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      options: { maxConcurrency: 2, runTokenBudget: 1600 },
    });

    expect(result.haltedBecause).toBe('token-budget');

    const byId = (id: string) => run.assignments.find((a) => a.id === id);
    expect(byId('w0')?.status).toBe('done');
    expect(byId('w1')?.status).toBe('done');

    // The point of the fix: at least one lane already mid-assignment when the
    // budget tripped was cut short via the shared abort signal, rather than
    // left to finish and bank its full usage. Before the fix, both `w2` and
    // `w3` always reached `done` regardless of the halt.
    const stillFinished = [byId('w2'), byId('w3')].filter((a) => a?.status === 'done');
    expect(stillFinished.length).toBeLessThan(2);

    const cutShort = [byId('w2'), byId('w3')].find(
      (a) => a?.status === 'failed' && a.error?.includes('halted'),
    );
    expect(cutShort).toBeDefined();

    const totalSpent = run.assignments.reduce(
      (sum, a) => sum + a.usage.inputTokens + a.usage.outputTokens,
      0,
    );
    // Without the fix this reaches 4000 (all four assignments' full usage).
    expect(totalSpent).toBeLessThan(4000);
  });

  it('halts before dispatching anything when Manager planning spend alone already exceeds the run token budget (NFR-5)', async () => {
    // MAJOR defect: the budget was checked with `totalUsage` (assignments
    // only), so Manager spend — which is real spend, recorded in
    // `run.managerUsage` before dispatch ever begins — escaped the budget
    // entirely. Measured with `runTokenBudget: 400`: 225 assignment tokens,
    // 420 Manager tokens, 645 true total, 61% over, and `haltedBecause` never
    // fired. Here the Manager alone is already over budget and no assignment
    // has run at all, which is the sharpest version of the bug: the old code
    // would still have dispatched every assignment before ever noticing.
    const { store, provider, run } = await setup({
      fallback: { text: 'ok', usage: { inputTokens: 10, outputTokens: 10 } },
    });
    run.managerUsage = { inputTokens: 300, outputTokens: 200 };
    await store.saveRun(run);

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      options: { runTokenBudget: 400 },
    });

    expect(result.haltedBecause).toBe('token-budget');
    expect(provider.requests).toHaveLength(0);
    expect(run.assignments.every((a) => a.status === 'pending')).toBe(true);
  });
});

describe('dispatchRun — two reviewers of one target (FR-M10 concurrency)', () => {
  const REVISION_MARKER = '[[REVIEW_VERDICT: REVISIONS_REQUESTED]]';

  it('does not throw when two reviewers of the same target both request revisions concurrently, redispatches the target exactly once, and reports the loser’s refusal', async () => {
    // CRITICAL defect, confirmed 4/8 against the real `FileRunStore` on real
    // disk: two reviewers of one target, in the same parallel phase, could
    // both read `target.status === 'done'` before either had redispatched,
    // both decide to redispatch, and the second's own `setStatus` then threw
    // on an illegal `briefing -> briefing` transition — uncaught, escaping
    // `runPool`'s `Promise.all` and failing the WHOLE RUN, discarding every
    // completed report. `SlowRunStore` reproduces the real-disk latency that
    // widens the window enough for the two lanes to genuinely interleave
    // instead of resolving in lockstep.
    const store = new SlowRunStore();
    const provider = new ScriptedProvider({
      byAssignment: {
        'review-1': { text: `Needs work from reviewer one.\n\n${REVISION_MARKER}` },
        'review-2': { text: `Needs work from reviewer two.\n\n${REVISION_MARKER}` },
      },
      fallback: { text: 'Findings.' },
    });
    const plan = reviewedByTwoPlan();
    const run = makeRun(plan);
    await store.saveRun(run);

    const nonFatalErrors: string[] = [];

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      options: { maxConcurrency: 2 },
      onEvent: (event) => {
        if (event.t === 'error' && !event.fatal) nonFatalErrors.push(event.message);
      },
    });

    // The headline assertion: this used to throw and fail the whole run. If
    // it throws, `dispatchRun` rejects and this `await` fails the test.
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);

    const target = run.assignments.find((a) => a.id === 'lead-a');
    // Redispatched exactly once, no matter which reviewer's request won.
    expect(target?.attempts).toBe(2);
    expect(target?.status).toBe('done');

    const leadRequests = provider.requests.filter((r) => r.assignmentId === 'lead-a');
    expect(leadRequests).toHaveLength(2);

    // The losing reviewer's request must be refused visibly, not silently
    // dropped — silence here would make a lost race indistinguishable from an
    // approval.
    expect(
      nonFatalErrors.some((message) => message.includes('but not applied')),
    ).toBe(true);
  });
});

describe('dispatchRun — the review loop (FR-M10)', () => {
  // The pure decision logic is covered in `review.test.ts`. What is tested here
  // is the wiring: that a verdict in a reviewer's report actually causes its
  // target to run again, with the critique in its brief, exactly once.
  //
  // `c` depends on `a` alone, which is what makes it a review of `a` under
  // `reviewTargetOf`. The two-phase plan already had that shape, so no new
  // fixture is needed — the review loop is not a special kind of plan, it is an
  // interpretation of an ordinary one.
  const REVISION_MARKER = '[[REVIEW_VERDICT: REVISIONS_REQUESTED]]';

  it('re-dispatches the reviewed assignment once, with the critique in its brief', async () => {
    const { store, provider, run } = await setup({
      byAssignment: {
        c: { text: `The retry maths is wrong in section 2.\n\n${REVISION_MARKER}` },
      },
      fallback: { text: 'Findings.' },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const target = run.assignments.find((a) => a.id === 'a');
    // Two dispatches: the original, and the one revision FR-M10 grants.
    expect(target?.attempts).toBe(2);
    expect(target?.status).toBe('done');

    // `b` was never reviewed — it must not have been dragged along.
    expect(run.assignments.find((a) => a.id === 'b')?.attempts).toBe(1);

    const briefsForA = provider.requests.filter((r) => r.assignmentId === 'a');
    expect(briefsForA).toHaveLength(2);
    expect(briefsForA[0]?.task).not.toContain('Revision requested');

    const revisionBrief = briefsForA[1]?.task ?? '';
    expect(revisionBrief).toContain('## Revision requested');
    expect(revisionBrief).toContain('The retry maths is wrong in section 2.');
    expect(revisionBrief).toContain('gamma');
    // The marker itself is stripped: it is machine plumbing, and reading it
    // back to another agent as prose invites it to emit one of its own.
    expect(revisionBrief).not.toContain('REVIEW_VERDICT');
  });

  it('adds a revision\'s tokens to what the first attempt already spent, rather than replacing them', async () => {
    // A revised assignment ran the provider twice and paid twice. The local
    // usage total used to start at zero on each execution and then overwrite
    // the persisted figure, so `run.json` reported only the revision's tokens —
    // an undercount of a real bill (NFR-5), and one that only showed up because
    // the replay fold sums the `usage` events on disk and disagreed.
    const { store, provider, run } = await setup({
      byAssignment: {
        c: { text: `Needs work.\n\n${REVISION_MARKER}`, usage: { inputTokens: 1, outputTokens: 1 } },
      },
      fallback: { text: 'Findings.', usage: { inputTokens: 10, outputTokens: 5 } },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const target = run.assignments.find((a) => a.id === 'a');
    expect(target?.attempts).toBe(2);
    // Two dispatches at 10/5 each. Not 10/5.
    expect(target?.usage).toEqual({ inputTokens: 20, outputTokens: 10 });

    // And an assignment that ran once is unaffected — the seeding must not
    // double-count a first attempt against itself.
    expect(run.assignments.find((a) => a.id === 'b')?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('stops at one revision even if the reviewer asks again', async () => {
    // The reviewer only runs once in this plan, so a second request cannot
    // arise from it. This drives the budget directly instead: `a` starts having
    // already been revised, so `decideRevision` must refuse.
    const { store, provider, run } = await setup({
      byAssignment: {
        c: { text: `Still wrong.\n\n${REVISION_MARKER}` },
      },
      fallback: { text: 'Findings.' },
    });

    const events: string[] = [];
    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.t === 'error' && !event.fatal) events.push(event.message);
      },
    });

    const target = run.assignments.find((a) => a.id === 'a');
    expect(target?.attempts).toBe(2);

    // Now run the same reviewer's verdict against the already-revised target.
    const secondRun = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    // Nothing is runnable any more — every assignment is terminal — so the
    // second dispatch is a no-op rather than another revision.
    expect(run.assignments.find((a) => a.id === 'a')?.attempts).toBe(2);
    expect(secondRun.completed).toBe(3);
  });

  it('leaves the target alone when the reviewer approves', async () => {
    const { store, provider, run } = await setup({
      byAssignment: {
        c: { text: 'Looks right to me.\n\n[[REVIEW_VERDICT: APPROVED]]' },
      },
      fallback: { text: 'Findings.' },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(run.assignments.find((a) => a.id === 'a')?.attempts).toBe(1);
    expect(provider.requests.filter((r) => r.assignmentId === 'a')).toHaveLength(1);
  });

  it('does not treat a report that merely discusses revisions as a request for one', async () => {
    // The expensive false positive: a reviewer writing prose about revisions
    // must not cost a paid re-run.
    const { store, provider, run } = await setup({
      byAssignment: {
        c: { text: 'The author may wish to consider revisions to section 2 in future work.' },
      },
      fallback: { text: 'Findings.' },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(run.assignments.find((a) => a.id === 'a')?.attempts).toBe(1);
  });

  it('asks only actual reviewers for a verdict marker', async () => {
    const { store, provider, run } = await setup({ fallback: { text: 'Findings.' } });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const briefFor = (id: string): string =>
      provider.requests.find((r) => r.assignmentId === id)?.task ?? '';

    // `c` depends on exactly one assignment, so it is a review.
    expect(briefFor('c')).toContain('Verdict marker');
    // `a` and `b` depend on nothing. Asking them for a verdict would be asking
    // for a marker nothing would ever read.
    expect(briefFor('a')).not.toContain('Verdict marker');
    expect(briefFor('b')).not.toContain('Verdict marker');
  });
});

describe('dispatchRun — the status event carries what the status change actually carries (NFR-7)', () => {
  // GAP 1: the `status` event used to be `{ t: 'status', status }` only, so a
  // replay of the log could not reproduce `reportPath`, `error` or `endedAt`
  // exactly and had to guess. These tests pin what `setStatus` now puts on the
  // event itself, directly against the field it wrote onto `AssignmentState` a
  // moment earlier — proving the two are the SAME value, not independently
  // computed approximations of each other. `useReplay.test.ts`'s
  // "replaying a real dispatchRun" test then proves the far side of this: that
  // `foldEvents` actually applies what is pinned here correctly.
  const REVISION_MARKER = '[[REVIEW_VERDICT: REVISIONS_REQUESTED]]';

  function statusEventsFor(store: MemoryRunStore, runId: string, assignmentId: string) {
    return store
      .readEvents(runId, assignmentId)
      .then((events) =>
        events.map((e) => e.event).filter((event): event is Extract<AgentEvent, { t: 'status' }> => event.t === 'status'),
      );
  }

  it('carries reportPath and endedAt on the done event, matching the assignment exactly', async () => {
    const { store, provider, run } = await setup({
      fallback: { text: 'Findings.', usage: { inputTokens: 1, outputTokens: 1 } },
    });

    await dispatchRun({ run, registry: REGISTRY, provider, store, signal: new AbortController().signal });

    const a = run.assignments.find((assignment) => assignment.id === 'a');
    if (a === undefined) throw new Error('fixture did not produce assignment "a"');

    const statuses = await statusEventsFor(store, run.id, 'a');
    const done = statuses.find((event) => event.status === 'done');
    expect(done?.reportPath).toBe(a.reportPath);
    expect(done?.endedAt).toBe(a.endedAt);
    // Not an approximation that happens to match — the same value.
    expect(done?.reportPath).toBe('reports/01-alpha.md');
    expect(done?.endedAt).toBeTypeOf('number');
  });

  it('carries error and endedAt on the skipped event, matching the assignment exactly', async () => {
    const { store, provider, run } = await setup({
      byAssignment: { a: { failWith: 'boom' } },
      fallback: { text: 'ok' },
    });

    await dispatchRun({ run, registry: REGISTRY, provider, store, signal: new AbortController().signal });

    const c = run.assignments.find((assignment) => assignment.id === 'c');
    if (c === undefined) throw new Error('fixture did not produce assignment "c"');
    expect(c.status).toBe('skipped'); // sanity: c depends on a, which failed

    const statuses = await statusEventsFor(store, run.id, 'c');
    const skipped = statuses.find((event) => event.status === 'skipped');
    expect(skipped?.error).toBe(c.error);
    expect(skipped?.endedAt).toBe(c.endedAt);
    expect(skipped?.error).toContain('a dependency did not complete');
  });

  it('carries error and endedAt on the failed event, matching the assignment exactly', async () => {
    const { store, provider, run } = await setup({
      byAssignment: { a: { failWith: 'model refused' } },
      fallback: { text: 'ok' },
    });

    await dispatchRun({ run, registry: REGISTRY, provider, store, signal: new AbortController().signal });

    const a = run.assignments.find((assignment) => assignment.id === 'a');
    if (a === undefined) throw new Error('fixture did not produce assignment "a"');

    const statuses = await statusEventsFor(store, run.id, 'a');
    const failed = statuses.find((event) => event.status === 'failed');
    expect(failed?.error).toBe(a.error);
    expect(failed?.endedAt).toBe(a.endedAt);
  });

  it('marks the FR-M10 revision re-dispatch\'s briefing event endedAtCleared, and carries no stale endedAt', async () => {
    const { store, provider, run } = await setup({
      byAssignment: {
        c: { text: `Needs work.\n\n${REVISION_MARKER}` },
      },
      fallback: { text: 'Findings.' },
    });

    await dispatchRun({ run, registry: REGISTRY, provider, store, signal: new AbortController().signal });

    const target = run.assignments.find((assignment) => assignment.id === 'a');
    expect(target?.attempts).toBe(2); // sanity: the revision actually happened

    const statuses = await statusEventsFor(store, run.id, 'a');
    const briefings = statuses.filter((event) => event.status === 'briefing');
    // Two dispatches of "a": the original and the FR-M10 revision.
    expect(briefings).toHaveLength(2);

    // The first briefing (the original dispatch) had nothing to clear.
    expect(briefings[0]?.endedAtCleared).toBeUndefined();
    // The second (the revision re-dispatch) explicitly clears the stale
    // `endedAt` from the first `done` — this is the field the fold reads to
    // avoid showing a revised assignment as having finished before it
    // restarted.
    expect(briefings[1]?.endedAtCleared).toBe(true);
    expect(briefings[1]?.endedAt).toBeUndefined();
  });
});

describe('dispatchRun — per-agent provider selection (Phase 7)', () => {
  it('routes an agent to its own provider and leaves the rest on the run’s', async () => {
    const { store, provider, run } = await setup({ fallback: { text: 'Default provider.' } });
    const special = new ScriptedProvider({ fallback: { text: 'Special provider.' } });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      // `alpha` only. `beta` and `gamma` must be untouched by this.
      providerFor: (agentName) => (agentName === 'alpha' ? special : undefined),
      store,
      signal: new AbortController().signal,
    });

    expect(special.requests.map((r) => r.assignmentId)).toEqual(['a']);
    expect(provider.requests.map((r) => r.assignmentId).sort()).toEqual(['b', 'c']);

    expect(await store.readReport(run.id, 'reports/01-alpha.md')).toContain('Special provider.');
    expect(await store.readReport(run.id, 'reports/02-beta.md')).toContain('Default provider.');
  });

  it('falls back to the run’s provider when the resolver returns undefined', async () => {
    const { store, provider, run } = await setup({ fallback: { text: 'Findings.' } });

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      providerFor: () => undefined,
      store,
      signal: new AbortController().signal,
    });

    expect(result.completed).toBe(3);
    expect(provider.requests).toHaveLength(3);
  });

  it('behaves identically when no resolver is supplied at all', async () => {
    // The seam is additive: every existing caller passes nothing, and must see
    // exactly the behaviour it saw before Phase 7.
    const { store, provider, run } = await setup({ fallback: { text: 'Findings.' } });

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(result.completed).toBe(3);
    expect(provider.requests).toHaveLength(3);
  });

  it('re-resolves for a revision, so a send-back does not inherit the wrong provider', async () => {
    // The FR-M10 re-dispatch runs inside the reviewer's execution. If the
    // provider were resolved once per phase rather than per assignment, the
    // revision would run on whatever the reviewer used.
    const { store, provider, run } = await setup({
      byAssignment: {
        c: { text: 'Wrong.\n\n[[REVIEW_VERDICT: REVISIONS_REQUESTED]]' },
      },
      fallback: { text: 'Findings.' },
    });
    const special = new ScriptedProvider({ fallback: { text: 'Special.' } });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      providerFor: (agentName) => (agentName === 'alpha' ? special : undefined),
      store,
      signal: new AbortController().signal,
    });

    // Both the original dispatch and the revision went to alpha's provider.
    expect(special.requests.map((r) => r.assignmentId)).toEqual(['a', 'a']);
  });
});

describe('dispatchRun — per-assignment workspaces (AO-8)', () => {
  // These tests use a real `FileRunStore` against a real temp directory, not
  // `MemoryRunStore` — the whole point of AO-8 is what happens on the actual
  // filesystem when two assignments run concurrently, and an in-memory store
  // has no files for either one to leak into the other's. See
  // `dispatcher.ts`'s `hasPerAssignmentWorkspaces` for why `MemoryRunStore`
  // deliberately does not implement this at all.

  let tmpRoot: string;

  afterEach(async () => {
    if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
  });

  async function realStore(): Promise<FileRunStore> {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-dispatch-workspace-'));
    return new FileRunStore(tmpRoot);
  }

  /**
   * Records the workspace directory handed to each request and, crucially,
   * actually writes to it — a test that only compared path strings would
   * pass even if the underlying directories did not really exist or were not
   * writable, which is not the guarantee AO-8 makes. Also records the
   * directory's contents at the moment the "assignment" starts, before it
   * writes anything itself, which is what proves a re-dispatched attempt
   * starts from an empty directory rather than one still holding files from
   * the attempt before it.
   */
  class WorkspaceProbeProvider implements AgentProvider {
    readonly id: ProviderId = 'scripted';
    readonly calls: Array<{ assignmentId: string; workspaceDir: string; entriesBeforeWrite: string[] }> = [];

    async isAvailable(): Promise<ProviderAvailability> {
      return { ok: true };
    }

    async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
      const entriesBeforeWrite = await readdir(request.workspaceDir);
      this.calls.push({
        assignmentId: request.assignmentId,
        workspaceDir: request.workspaceDir,
        entriesBeforeWrite,
      });

      await writeFile(
        path.join(request.workspaceDir, `${request.assignmentId}.marker`),
        `written by ${request.assignmentId}`,
        'utf8',
      );

      yield { t: 'usage', assignmentId: request.assignmentId, inputTokens: 1, outputTokens: 1 };
      yield { t: 'text', assignmentId: request.assignmentId, chunk: `report from ${request.assignmentId}` };
    }
  }

  it('gives two assignments in the same parallel phase different workspace directories, and neither can see the other\'s files', async () => {
    const store = await realStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);
    const provider = new WorkspaceProbeProvider();

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const dirFor = (assignmentId: string): string | undefined =>
      provider.calls.find((c) => c.assignmentId === assignmentId)?.workspaceDir;

    const aDir = dirFor('a');
    const bDir = dirFor('b');
    if (aDir === undefined || bDir === undefined) {
      throw new Error('provider was not called for both assignments');
    }

    // The AO-8 defect, directly: this used to be the same path for both.
    expect(aDir).not.toBe(bDir);

    // Each assignment's own directory holds only its own marker — not the
    // sibling's. Listing after the run (rather than trusting the recorded
    // `entriesBeforeWrite`, which only proves isolation at start-of-run) is
    // what proves the isolation held for the whole assignment, not just the
    // first instant of it.
    expect(await readdir(aDir)).toEqual(['a.marker']);
    expect(await readdir(bDir)).toEqual(['b.marker']);
  });

  it('verifies each assignment workspace really is inside the run directory (NFR-1)', async () => {
    const store = await realStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);
    const provider = new WorkspaceProbeProvider();

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const runDir = store.runDir(run.id);
    for (const call of provider.calls) {
      const relative = path.relative(runDir, call.workspaceDir);
      // Verified, not merely constructed to look verified: a path built by
      // simple string concatenation could still satisfy a naive
      // `startsWith(runDir)` check while actually pointing at a sibling
      // directory (e.g. `runDir + '-evil'`). `path.relative` is what
      // `resolveWithin` itself checks with, in `store/util.ts` and again in
      // `FileRunStore.assignmentWorkspaceDir`'s own defence-in-depth
      // `dirname` check — this assertion exercises the same property from
      // the caller's side.
      expect(relative.startsWith('..')).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });

  it('gives a re-dispatched (FR-M10) assignment a fresh workspace, without deleting the one its first attempt used', async () => {
    // The re-dispatch decision this test pins: a revision gets its OWN
    // workspace directory, distinct from the first attempt's, and the first
    // attempt's directory is not cleaned up when the second one is created.
    // Reusing one directory across attempts was the alternative — rejected
    // because a second attempt reusing the first attempt's directory could
    // be "confused by a leftover workspace from the first attempt" (the
    // exact failure mode AO-8's revision requirement warns against), and
    // wiping it before reuse would destroy the one thing worth keeping for
    // someone debugging why the first attempt was sent back at all.
    const REVISION_MARKER = '[[REVIEW_VERDICT: REVISIONS_REQUESTED]]';
    const store = await realStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    const provider = new ScriptedProvider({
      byAssignment: {
        c: { text: `Needs work.\n\n${REVISION_MARKER}` },
      },
      fallback: { text: 'Findings.' },
    });
    const probe = new WorkspaceProbeProvider();

    // Two providers is unnecessary complexity for this test's purpose — swap
    // in the probe only for the assignment being revised (`a`), so its
    // workspace directory is recorded across both dispatches, while `b` and
    // `c` run on the plain scripted provider.
    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      providerFor: (agentName) => (agentName === 'alpha' ? probe : undefined),
      store,
      signal: new AbortController().signal,
    });

    const target = run.assignments.find((a) => a.id === 'a');
    expect(target?.attempts).toBe(2); // sanity: the revision actually happened

    const dirsForA = probe.calls.filter((c) => c.assignmentId === 'a').map((c) => c.workspaceDir);
    expect(dirsForA).toHaveLength(2);

    const [firstAttemptDir, secondAttemptDir] = dirsForA;
    if (firstAttemptDir === undefined || secondAttemptDir === undefined) {
      throw new Error('expected two recorded workspace directories');
    }
    expect(firstAttemptDir).not.toBe(secondAttemptDir);
    expect(path.basename(firstAttemptDir)).toBe('attempt-1');
    expect(path.basename(secondAttemptDir)).toBe('attempt-2');

    // The second attempt started with an empty directory — not confused by
    // whatever the first attempt wrote.
    const secondCall = probe.calls.find((c) => c.workspaceDir === secondAttemptDir);
    expect(secondCall?.entriesBeforeWrite).toEqual([]);

    // The first attempt's directory, and what it wrote, still exist — a
    // revision does not erase the evidence of what it revised.
    expect(await readdir(firstAttemptDir)).toEqual(['a.marker']);
  });
});

describe('dispatchRun — report capture (FR-M6)', () => {
  // Real `FileRunStore` on a real temp directory, for the same reason the AO-8
  // block above uses one: the behaviour under test is "did the dispatcher find
  // the file the agent actually wrote", and an in-memory store has no file for
  // it to find.

  let tmpRoot: string;

  afterEach(async () => {
    if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
  });

  async function realStore(): Promise<FileRunStore> {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-report-capture-'));
    return new FileRunStore(tmpRoot);
  }

  /**
   * An agent that writes its report to the deliverable path with its `Write`
   * tool and then says something *about* having done so — which is exactly what
   * `tax-advisor` did on the first live-model matrix run, and what used to cause
   * the narration to be persisted as the report.
   */
  class WritesTheDeliverableProvider implements AgentProvider {
    readonly id: ProviderId = 'scripted';

    constructor(
      private readonly body: string,
      private readonly narration: string,
      private readonly deliverableFor: (assignmentId: string) => string,
    ) {}

    async isAvailable(): Promise<ProviderAvailability> {
      return { ok: true };
    }

    async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
      const target = path.join(request.workspaceDir, this.deliverableFor(request.assignmentId));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${this.body} (${request.assignmentId})`, 'utf8');

      if (this.narration !== '') {
        yield { t: 'text', assignmentId: request.assignmentId, chunk: this.narration };
      }
    }
  }

  const deliverableFor = (assignmentId: string): string =>
    ({ a: 'reports/01-alpha.md', b: 'reports/02-beta.md', c: 'reports/03-gamma.md' })[assignmentId] ??
    'reports/00-unknown.md';

  it('persists the report the agent WROTE, not its narration about writing one', async () => {
    const store = await realStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new WritesTheDeliverableProvider(
        '# Real analysis\n\nSubstantive content.',
        'Report written to `reports/01-alpha.md`. It covers everything.',
        deliverableFor,
      ),
      store,
      signal: new AbortController().signal,
    });

    const stored = await store.readReport(run.id, 'reports/01-alpha.md');
    expect(stored).toBe('# Real analysis\n\nSubstantive content. (a)');
    expect(stored).not.toContain('Report written to');
  });

  it('still uses the reply when the agent wrote no file, which is most agents', async () => {
    const { store, provider, run } = await setup({ fallback: { text: 'plain reply report' } });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(await store.readReport(run.id, 'reports/01-alpha.md')).toBe('plain reply report');
  });

  it('counts a written report as a report even when the reply is empty', async () => {
    // Before the written path existed this assignment failed with "produced no
    // report" (FR-M6 checked `text.trim() === ''`) while its report sat on disk.
    const store = await realStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new WritesTheDeliverableProvider('Written, said nothing.', '', deliverableFor),
      store,
      signal: new AbortController().signal,
    });

    const a = run.assignments.find((x) => x.id === 'a');
    expect(a?.status).toBe('done');
    expect(a?.error).toBeUndefined();
    expect(await store.readReport(run.id, 'reports/01-alpha.md')).toBe('Written, said nothing. (a)');
  });
});

describe('dispatchRun — diagnostics capture', () => {
  /** An in-memory sink, so the wiring is tested without touching disk. */
  function sink() {
    const records: Array<{ kind: string; message: string; agentName?: string }> = [];
    return {
      records,
      record: async (input: { kind: string; message: string; agentName?: string }) => {
        records.push(input);
        return undefined;
      },
    };
  }

  it('records a non-fatal provider warning, classified, with the agent that hit it', async () => {
    // This is the case the whole feature was asked for: the tool-denial warning
    // that every run prints and nothing kept.
    const provider = new (class implements AgentProvider {
      readonly id: ProviderId = 'scripted';
      async isAvailable(): Promise<ProviderAvailability> {
        return { ok: true };
      }
      async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
        yield {
          t: 'error',
          assignmentId: request.assignmentId,
          message: 'tool "Bash" was not granted: "Bash" resolves to the built-in "PowerShell"',
          fatal: false,
        };
        yield { t: 'text', assignmentId: request.assignmentId, chunk: 'report body' };
      }
    })();

    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);
    const diagnostics = sink();

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      diagnostics,
    });

    const denials = diagnostics.records.filter((r) => r.kind === 'tool-denied');
    expect(denials.length).toBeGreaterThan(0);
    expect(denials[0]?.message).toContain('was not granted');
    expect(denials[0]?.agentName).toBe('alpha');
  });

  it('records the markers an agent put in its report, and nothing when it wrote none', async () => {
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);
    const diagnostics = sink();

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new ScriptedProvider({
        byAssignment: {
          a: { text: 'Findings.\n\n[[ENHANCEMENT: a shell would have let me verify this]]' },
        },
        fallback: { text: 'Findings, no notes.' },
      }),
      store,
      signal: new AbortController().signal,
      diagnostics,
    });

    const authored = diagnostics.records.filter((r) => r.kind === 'enhancement');
    expect(authored).toHaveLength(1);
    expect(authored[0]?.message).toBe('a shell would have let me verify this');
    expect(authored[0]?.agentName).toBe('alpha');
  });

  it('records a failed assignment once, through the one function every failure goes through', async () => {
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);
    const diagnostics = sink();

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new ScriptedProvider({ fallback: { text: '' } }),
      store,
      signal: new AbortController().signal,
      diagnostics,
    });

    const failures = diagnostics.records.filter((r) => r.kind === 'assignment-failed');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]?.message).toContain('produced no report');
  });

  it('runs unchanged with no sink at all, which is every existing caller', async () => {
    const { store, provider, run } = await setup();

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(result.failed).toBe(0);
    expect(result.completed).toBeGreaterThan(0);
  });
});

describe('dispatchRun — markers survive a failed assignment', () => {
  it('records the markers an agent wrote before it failed', async () => {
    // Found by a real run: an audit whose two assignments both hit
    // `budget_exhausted` produced no reports, so the marker parse — which ran
    // only on the success path — saw nothing. `[[BLOCKER: ...]]` exists for
    // exactly "something stopped me producing what was asked for", which made
    // the kind defined for failures the one that could not survive one.
    const records: Array<{ kind: string; message: string }> = [];
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    const provider = new (class implements AgentProvider {
      readonly id: ProviderId = 'scripted';
      async isAvailable(): Promise<ProviderAvailability> {
        return { ok: true };
      }
      async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
        yield {
          t: 'text',
          assignmentId: request.assignmentId,
          chunk: [
            'Got partway.',
            '',
            '[[BLOCKER: ran out of budget before I could read the code]]',
          ].join('\n'),
        };
        yield {
          t: 'error',
          assignmentId: request.assignmentId,
          message: 'budget_exhausted',
          fatal: true,
        };
      }
    })();

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      diagnostics: {
        record: async (input: { kind: string; message: string }) => {
          records.push(input);
          return undefined;
        },
      },
    });

    const blockers = records.filter((r) => r.kind === 'blocker');
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers[0]?.message).toBe('ran out of budget before I could read the code');
    // The failure itself is still recorded, and first.
    expect(records[0]?.kind).toBe('assignment-failed');
  });
});

describe('dispatchRun — a decline is not a success (FR-M6)', () => {
  it('records an assignment whose report carries a BLOCKER as declined, not done', async () => {
    // A live run finished "3 done, 0 failed" while one agent had produced 3,993
    // bytes explaining why it could not do the work, against 18,687 and 16,719
    // from the other two. FR-M6's guard is `text.trim() === ''`, so "I could not
    // do this" passed as a report.
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new ScriptedProvider({
        byAssignment: {
          a: {
            text: 'I could not audit anything.\n\n[[BLOCKER: no codebase was supplied to this run]]',
          },
        },
        fallback: { text: 'Real findings.' },
      }),
      store,
      signal: new AbortController().signal,
    });

    const declined = run.assignments.find((x) => x.id === 'a');
    expect(declined?.status).toBe('declined');
    // The report is still written: it explains why, which is the most useful
    // thing anyone downstream can be told.
    expect(declined?.reportPath).toBe('reports/01-alpha.md');
    expect(await store.readReport(run.id, 'reports/01-alpha.md')).toContain('BLOCKER');

    // The others are unaffected.
    expect(run.assignments.find((x) => x.id === 'b')?.status).toBe('done');
  });

  it('counts declines in their own bucket, so the summary stops claiming clean success', async () => {
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new ScriptedProvider({
        byAssignment: {
          a: { text: ['nope', '', '[[BLOCKER: nothing to work with]]'].join('\n') },
        },
        fallback: { text: 'Real findings.' },
      }),
      store,
      signal: new AbortController().signal,
    });

    expect(result.declined).toBe(1);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    // The four buckets still partition the assignment list.
    expect(result.completed + result.failed + result.skipped + result.cancelled + result.declined).toBe(
      run.assignments.length,
    );
  });

  it('leaves an agent that did the work and flagged a limitation as done', async () => {
    // The distinction the brief now states explicitly: NOTE and ENHANCEMENT mean
    // "I did the work"; only BLOCKER means "I did not". Without this, acting on
    // markers would make an agent's honesty the trigger for failing it.
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new ScriptedProvider({
        fallback: {
          text: 'Full findings here.\n\n[[ENHANCEMENT: a shell would have let me verify]]\n[[NOTE: I only read 30 of 100 files]]',
        },
      }),
      store,
      signal: new AbortController().signal,
    });

    expect(run.assignments.every((a) => a.status === 'done')).toBe(true);
  });

  it('decides the status without a diagnostics sink, so the outcome does not depend on observability', async () => {
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new ScriptedProvider({
        byAssignment: {
          a: { text: ['nope', '', '[[BLOCKER: nothing to work with]]'].join('\n') },
        },
        fallback: { text: 'Real findings.' },
      }),
      store,
      signal: new AbortController().signal,
      // No `diagnostics` at all.
    });

    expect(run.assignments.find((x) => x.id === 'a')?.status).toBe('declined');
  });
});

describe('dispatchRun — an error escaping executeAssignment ends terminal, not silently transient', () => {
  // Same defect shape this file already fixed once, for a different trigger:
  // see `executeAssignment`'s `ctx.signal.aborted` branch (the FR-M9
  // cancellation fix) for the original description of an agent left "still
  // typing, indefinitely, for a run that was long over". The backstop in
  // `dispatchRun`'s `runPool` worker reopened it for a stray throw out of
  // `executeAssignment`: the assignment stayed non-terminal, nothing durable
  // was written (only `onEvent` fired), and the run still walked to `done` if
  // anything else succeeded. These tests pin the fix.

  /**
   * A `MemoryRunStore` whose `saveRun` throws once a target assignment
   * reaches a given status — standing in for a real disk write failing
   * partway through `dispatcher.ts`'s `persist` (called from both
   * `setStatus` and `patchAssignment`), which is one of the two ordinary
   * triggers named in the fix's own comment (the other being `setStatus`
   * throwing on an illegal transition).
   *
   * By default it throws exactly ONCE — the assignment's own transition into
   * the target status — so a later write for the SAME assignment (the
   * backstop's own `failAssignment` call, forcing `-> failed`) succeeds
   * normally. That is what proves the recovery path actually works, rather
   * than merely not crashing.
   *
   * With `persistent: true`, every write fails once tripped, not just the
   * one that caused the escape — standing in for a disk that stays broken.
   * That is what the guard test below needs: the recovery attempt must fail
   * for the SAME underlying reason as the original throw, and nothing about
   * that second failure may escape `dispatchRun` either.
   */
  class ThrowsOnAssignmentStatusStore extends MemoryRunStore {
    private tripped = false;

    constructor(
      private readonly targetAssignmentId: string,
      private readonly targetStatus: AssignmentStatus,
      private readonly persistent = false,
    ) {
      super();
    }

    override async saveRun(run: RunState): Promise<void> {
      const target = run.assignments.find((a) => a.id === this.targetAssignmentId);
      const firstTrip = !this.tripped && target?.status === this.targetStatus;
      if (firstTrip) this.tripped = true;

      if (firstTrip || (this.persistent && this.tripped)) {
        throw new Error('simulated disk write failure');
      }
      await super.saveRun(run);
    }
  }

  /** An in-memory sink, matching the pattern used in the diagnostics-capture
   * block above — no filesystem needed to prove the wiring. */
  function sink() {
    const records: Array<{ kind: string; message: string; assignmentId?: string }> = [];
    return {
      records,
      record: async (input: { kind: string; message: string; assignmentId?: string }) => {
        records.push(input);
        return undefined;
      },
    };
  }

  it('forces the assignment to `failed` (not stuck non-terminal), records a durable diagnostic, and is counted in the tally', async () => {
    // `saveRun` throws exactly once: on `a`'s own transition to `working`,
    // deep inside `executeAssignment`'s opening `setStatus` calls. That throw
    // is what has to escape `executeAssignment` itself and land in
    // `dispatchRun`'s backstop for this test to exercise anything real.
    const store = new ThrowsOnAssignmentStatusStore('a', 'working');
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });
    const diagnostics = sink();

    const result = await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      diagnostics,
    });

    // Requirement 1: terminal, not left in `working` forever.
    const a = run.assignments.find((x) => x.id === 'a');
    expect(a?.status).toBe('failed');
    expect(a?.error).toContain('errored outside normal failure handling');

    // Requirement 3: the run's own accounting sees the failure rather than
    // silently losing the assignment out of every bucket.
    expect(result.failed).toBe(1);
    // `c` depends on `a`, which failed — it cannot run either.
    expect(result.skipped).toBe(1);
    // `b` is independent and unaffected.
    expect(run.assignments.find((x) => x.id === 'b')?.status).toBe('done');

    // Requirement 2: a durable record exists, not only the transient
    // broadcast. `failAssignment` is what `dispatcher.ts` reuses for this —
    // it records the SAME `assignment-failed` kind every other per-assignment
    // failure in the file goes through.
    const durable = diagnostics.records.filter(
      (r) => r.kind === 'assignment-failed' && r.assignmentId === 'a',
    );
    expect(durable.length).toBeGreaterThan(0);
    expect(durable[0]?.message).toContain('errored outside normal failure handling');
  });

  it('keeps the transient `onEvent` broadcast — the fix adds a durable record, it does not replace the live one', async () => {
    const store = new ThrowsOnAssignmentStatusStore('a', 'working');
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    const broadcastMessages: string[] = [];
    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.t === 'error' && event.assignmentId === 'a') broadcastMessages.push(event.message);
      },
    });

    expect(
      broadcastMessages.some((message) => message.includes('errored outside normal failure handling')),
    ).toBe(true);
  });

  it('does not throw out of dispatchRun when the recovery attempt itself fails too', async () => {
    // Requirement 2's guard: `setStatus` is one of the two ways control
    // arrives in the backstop catch in the first place, so forcing the
    // assignment to `failed` THROUGH it can throw a second time. A
    // persistently broken store reproduces exactly that — the original throw
    // comes from `solo`'s transition to `working`, and the recovery's own
    // `failAssignment` write then fails for the identical underlying reason.
    // Nothing about that second failure may escape `dispatchRun`, which is
    // the entire point of wrapping the recovery call.
    //
    // `singleAssignmentPlan` (one assignment, one phase, no dependents) is
    // used rather than `twoPhasePlan` here specifically to keep this test
    // about ONE thing: with a persistently broken store, literally every
    // subsequent write in the run fails, including ones this fix's SCOPE does
    // not touch (e.g. the phase loop's own dependency-skip `setStatus` call).
    // A single, dependency-free assignment never reaches any of those other
    // call sites, so a failure there cannot be mistaken for evidence about
    // the backstop under test here.
    const store = new ThrowsOnAssignmentStatusStore('solo', 'working', true);
    const run = makeRun(singleAssignmentPlan());
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    await expect(
      dispatchRun({
        run,
        registry: REGISTRY,
        provider,
        store,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeDefined();
  });

  it('still writes a diagnostic when the recovery write itself fails', async () => {
    // The case above proves nothing escapes. This one proves the operator is
    // not left with silence, which is the actual defect one layer down: with a
    // persistently broken store, `failAssignment` throws inside `setStatus`
    // and never reaches its OWN diagnostics call, so before this the whole
    // sequence — assignment threw, could not be marked failed — existed only
    // as a transient WebSocket event that nobody was necessarily listening to.
    //
    // The sink is a different file (`runs/diagnostics.jsonl`) from the
    // `run.json` whose write is failing, and its contract is to swallow its
    // own errors rather than propagate them, so it is the one durable channel
    // still available here.
    const store = new ThrowsOnAssignmentStatusStore('solo', 'working', true);
    const run = makeRun(singleAssignmentPlan());
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    const records: Array<{ kind: string; message: string; assignmentId?: string }> = [];

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
      diagnostics: {
        record: async (input) => {
          records.push(input);
          return undefined;
        },
      },
    });

    const recovery = records.find((r) => r.message.includes('could not be marked failed'));
    expect(recovery).toBeDefined();
    expect(recovery?.kind).toBe('assignment-failed');
    expect(recovery?.assignmentId).toBe('solo');
    // Both halves of the story, in one line an operator can grep for.
    expect(recovery?.message).toContain('errored outside normal failure handling');
  });
});

describe('dispatchRun — the subject reaches the provider, not just the brief', () => {
  it('puts run.subjectPath on every provider request', async () => {
    // Two shards built the halves of this and neither could see the other: one
    // gave the sandboxed tool builders an optional read-only second root, the
    // other put the path on the run and in the brief. Between them sat a gap
    // nobody owned — the tools were capable of reading the subject and were
    // never told what it was, so an agent on an API-backed adapter got a brief
    // naming a path its own tools would still refuse. This asserts the join.
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan(), 'read the subject');
    run.subjectPath = 'D:/work/Investing dashboard';
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(provider.requests.length).toBeGreaterThan(0);
    for (const request of provider.requests) {
      expect(request.subjectPath).toBe('D:/work/Investing dashboard');
    }
  });

  it('omits it entirely when the run has no subject', async () => {
    // Absence must stay absent rather than becoming an empty string: the tool
    // builders treat "no subject" as "do not expose a second root at all", and
    // an empty string would be a root that resolves to somewhere.
    const store = new MemoryRunStore();
    const run = makeRun(twoPhasePlan(), 'no subject');
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    for (const request of provider.requests) {
      expect(request).not.toHaveProperty('subjectPath');
    }
  });
});

describe('dispatchRun — the model floor (no haiku for assignment work)', () => {
  /** Same shape as `makeAgent`, plus the catalog `model:` this suite is about. */
  function agentOnModel(name: string, model: string): AgentDef {
    return { ...makeAgent(name), model };
  }

  function onePhaseFor(agentName: string): RunPlan {
    return RunPlanSchema.parse({
      summary: 'Do the thing.',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'only',
          name: 'Only',
          parallel: false,
          assignments: [
            {
              id: 'solo',
              agentName,
              objective: 'Investigate.',
              deliverable: 'reports/01-solo.md',
              dependsOn: [],
            },
          ],
        },
      ],
    });
  }

  it('sends sonnet to the provider for an agent whose catalog file says haiku', async () => {
    // The property that matters is what the PROVIDER is asked for, not what the
    // policy function returns in isolation — 18 of the 156 vendored agents
    // declare `haiku`, and this is the single seam every one of them passes
    // through on the way to a real model call.
    const registry = buildRegistry([agentOnModel('cheap', 'haiku')]);
    const store = new MemoryRunStore();
    const run = makeRun(onePhaseFor('cheap'), 'floor the model');
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    await dispatchRun({
      run,
      registry,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const request = provider.requests.find((r) => r.assignmentId === 'solo');
    expect(request?.model).toBe('sonnet');
  });

  it('records the override, because an agent running off-catalog must be explicable', async () => {
    const registry = buildRegistry([agentOnModel('cheap', 'haiku')]);
    const store = new MemoryRunStore();
    const run = makeRun(onePhaseFor('cheap'), 'record the override');
    await store.saveRun(run);
    const records: Array<{ kind: string; message: string; agentName?: string }> = [];

    await dispatchRun({
      run,
      registry,
      provider: new ScriptedProvider({ fallback: { text: 'ok' } }),
      store,
      signal: new AbortController().signal,
      diagnostics: {
        record: async (input) => {
          records.push(input);
          return undefined;
        },
      },
    });

    const override = records.find((r) => r.message.includes('model policy'));
    expect(override?.kind).toBe('provider-warning');
    expect(override?.agentName).toBe('cheap');
    expect(override?.message).toContain('haiku');
  });

  it('passes sonnet and inherit through untouched, and logs nothing about them', async () => {
    // The 105 sonnet agents and the 25 inherit agents must be unaffected: a
    // policy that logged a line per assignment would bury the 18 that matter.
    const registry = buildRegistry([
      agentOnModel('mid', 'sonnet'),
      agentOnModel('deferring', 'inherit'),
    ]);
    const records: unknown[] = [];

    for (const [agentName, expected] of [
      ['mid', 'sonnet'],
      ['deferring', 'inherit'],
    ] as const) {
      const store = new MemoryRunStore();
      const run = makeRun(onePhaseFor(agentName), `pass ${agentName} through`);
      await store.saveRun(run);
      const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

      await dispatchRun({
        run,
        registry,
        provider,
        store,
        signal: new AbortController().signal,
        diagnostics: {
          record: async (input) => {
            records.push(input);
            return undefined;
          },
        },
      });

      expect(provider.requests.find((r) => r.assignmentId === 'solo')?.model).toBe(expected);
    }

    expect(records).toEqual([]);
  });

  it('D1: records the resolved model on the assignment, not just what the provider was sent', async () => {
    // The confirmed defect: `modelDecision.model` was computed and forwarded
    // to `provider.run()`, but nothing ever persisted it — `run.json` kept
    // only `agentName`, so both cost sites (`costModel.ts`, `deliverable.ts`)
    // read the catalog's `haiku` forever, understating every one of the 18
    // vendored haiku agents' true cost once the floor started raising them.
    const registry = buildRegistry([agentOnModel('cheap', 'haiku')]);
    const store = new MemoryRunStore();
    const run = makeRun(onePhaseFor('cheap'), 'persist the resolved model');
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    const result = await dispatchRun({
      run,
      registry,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const assignment = result.run.assignments.find((a) => a.id === 'solo');
    expect(assignment?.model).toBe('sonnet');
    // The catalog word is untouched on the agent's own file — only the
    // ASSIGNMENT records what actually ran, per `modelPolicy.ts`'s "clamps
    // rather than overwrites" design.
    expect(registry.byName.get('cheap')?.model).toBe('haiku');
  });

  it('D1: leaves the assignment.model field absent for an agent the catalog declares no model for', async () => {
    // `applyModelPolicy` returns `model: undefined` for the ~8 agents with no
    // catalog `model:` at all — deliberately, per its own doc comment. This
    // field must not invent a tier for them either; absence here must mean
    // exactly what it always meant: defer to the catalog (also absent).
    const registry = buildRegistry([makeAgent('no-model-agent')]);
    const store = new MemoryRunStore();
    const run = makeRun(onePhaseFor('no-model-agent'), 'no catalog model');
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    const result = await dispatchRun({
      run,
      registry,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const assignment = result.run.assignments.find((a) => a.id === 'solo');
    expect(assignment?.model).toBeUndefined();
  });

  it('honours a deployment that lowers its own floor', async () => {
    // The escape hatch is real, not decorative: a deployment that has decided
    // haiku is fine for its work gets haiku.
    const registry = buildRegistry([agentOnModel('cheap', 'haiku')]);
    const store = new MemoryRunStore();
    const run = makeRun(onePhaseFor('cheap'), 'lowered floor');
    await store.saveRun(run);
    const provider = new ScriptedProvider({ fallback: { text: 'ok' } });

    await dispatchRun({
      run,
      registry,
      provider,
      store,
      signal: new AbortController().signal,
      modelPolicy: { min: 'haiku', max: 'opus' },
    });

    expect(provider.requests.find((r) => r.assignmentId === 'solo')?.model).toBe('haiku');
  });
});

describe('dispatchRun — a report written under the wrong name is recovered, not lost', () => {
  // Its own temp root: recovery walks a REAL workspace directory, so
  // `MemoryRunStore` (which has no disk and therefore no per-assignment
  // workspace) cannot exercise this at all.
  let recoveryRoot: string | undefined;

  afterEach(async () => {
    if (recoveryRoot !== undefined) await rm(recoveryRoot, { recursive: true, force: true });
    recoveryRoot = undefined;
  });

  async function storeOnDisk(): Promise<FileRunStore> {
    recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-recover-'));
    return new FileRunStore(recoveryRoot);
  }

  /** Writes markdown at `where`, then narrates — the combination that loses a report. */
  class WritesElsewhereProvider implements AgentProvider {
    readonly id: ProviderId = 'scripted';

    constructor(
      private readonly where: string,
      private readonly body: string,
      private readonly narration: string,
      private readonly alsoDeliverable?: string,
    ) {}

    async isAvailable(): Promise<ProviderAvailability> {
      return { ok: true };
    }

    async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
      const write = async (relative: string, text: string): Promise<void> => {
        const target = path.join(request.workspaceDir, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text, 'utf8');
      };
      await write(this.where, this.body);
      if (this.alsoDeliverable !== undefined) {
        await write(this.alsoDeliverable, '# The declared one');
      }
      yield { t: 'text', assignmentId: request.assignmentId, chunk: this.narration };
    }
  }

  it('captures a workspace report the agent named itself, and says where it came from', async () => {
    // The exact shape of a real loss. `sre-engineer` wrote 15,211 bytes of live
    // measurements to `report.md` in its working directory and replied only
    // "Report complete at reports/06-sre-engineer.md". Its declared deliverable
    // was that path, nothing looked at `report.md`, capture fell back to the
    // reply, and the assignment was recorded `done` carrying 601 bytes of
    // narration while ten findings sat unread on disk.
    const store = await storeOnDisk();
    const run = makeRun(twoPhasePlan(), 'recover a stray report');
    await store.saveRun(run);
    const records: Array<{ message: string }> = [];

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new WritesElsewhereProvider(
        'report.md',
        `# Observability

F1 — P2. A whole class of failures never reaches the log.`,
        'Report complete at reports/01-alpha.md',
      ),
      store,
      signal: new AbortController().signal,
      diagnostics: {
        record: async (input) => {
          records.push(input);
          return undefined;
        },
      },
    });

    const captured = await store.readReport(run.id, 'reports/01-alpha.md');
    expect(captured).toContain('F1 — P2');
    expect(captured).not.toContain('Report complete at');
    // Never silently: if the guess is ever wrong, this line is how anyone finds
    // out which file was used.
    const note = records.find((r) => r.message.includes('recovered from'));
    expect(note?.message).toContain('report.md');
  });

  it('still prefers the declared path when the agent wrote that too', async () => {
    // Recovery must never outrank the thing it is a fallback for.
    const store = await storeOnDisk();
    const run = makeRun(twoPhasePlan(), 'prefer the declared path');
    await store.saveRun(run);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider: new WritesElsewhereProvider(
        'report.md',
        '# The stray one',
        'done',
        'reports/01-alpha.md',
      ),
      store,
      signal: new AbortController().signal,
    });

    expect(await store.readReport(run.id, 'reports/01-alpha.md')).toContain('The declared one');
  });
});

describe('normaliseGluedHeading (Doc1)', () => {
  it('splits a heading glued to the end of preceding prose onto its own line', () => {
    // The exact reproduction: `runs/20260819-194636-kocc/reports/02-cli-developer.md`
    // line 1, today, verified against the real file.
    const input =
      "I'll start by exploring the repository structure and package.json to understand the CLI " +
      'commands.Let me read all the CLI script source files to understand their argument ' +
      'parsing and help text.Now let me actually run these commands against the real checkout ' +
      'to verify behavior.# CLI Ergonomics Report — Agent Office\n\n' +
      'Tested against `C:\\Users\\someone\\repos\\Agent Office`.';

    const result = normaliseGluedHeading(input);
    const lines = result.split('\n');

    // The heading now starts its own line, unglued from the sentence before it.
    expect(lines).toContain('# CLI Ergonomics Report — Agent Office');
    // A markdown renderer needs the heading marker at the START of a line —
    // asserting that directly, not just "the substring exists somewhere".
    const headingLine = lines.find((l) => l.startsWith('# CLI Ergonomics'));
    expect(headingLine).toBe('# CLI Ergonomics Report — Agent Office');
    // The preamble is preserved verbatim, only relocated onto its own line —
    // this fix does not attempt to strip or judge the preamble.
    expect(result).toContain('to verify behavior.');
    expect(result.startsWith("I'll start by exploring")).toBe(true);
  });

  it('leaves a well-formed report byte-for-byte untouched', () => {
    const wellFormed =
      '# CLI Ergonomics Report\n\n' +
      'Tested against the real checkout.\n\n' +
      '## P1 — Unknown flags\n\n' +
      'Body text here, including a literal # inside a sentence, and a URL ' +
      'fragment like https://example.com/page.html#section which must not be split.\n\n' +
      '```\n' +
      '#!/usr/bin/env bash\n' +
      'echo "a fenced block with a # that must survive untouched"\n' +
      '```\n';

    expect(normaliseGluedHeading(wellFormed)).toBe(wellFormed);
  });

  it('does not touch a heading preceded by a space, mid-sentence — deliberately out of scope', () => {
    // Ambiguous by design (see the function's own doc comment): a space
    // before the `#` could be a stray hash in prose rather than a glued
    // heading, and this fix only handles the unambiguous zero-whitespace case.
    const input = 'See the notes below # Notes\n\nMore text.';
    expect(normaliseGluedHeading(input)).toBe(input);
  });

  it('does not split a subheading marker whose hashes are the marker itself', () => {
    const input = '## Already a heading\n\nBody.';
    expect(normaliseGluedHeading(input)).toBe(input);
  });

  it('does not treat a URL fragment or a hashtag-style word as a heading (no trailing whitespace after #)', () => {
    const input = 'Read more at page.html#section or check #hashtag right here.';
    expect(normaliseGluedHeading(input)).toBe(input);
  });

  it('dispatchRun end to end: a glued preamble becomes a structurally valid heading in the persisted report', async () => {
    const registry = buildRegistry([makeAgent('narrator')]);
    const store = new MemoryRunStore();
    const plan = RunPlanSchema.parse({
      summary: 'Do the thing.',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'only',
          name: 'Only',
          parallel: false,
          assignments: [
            {
              id: 'solo',
              agentName: 'narrator',
              objective: 'Narrate then report.',
              deliverable: 'reports/01-narrator.md',
              dependsOn: [],
            },
          ],
        },
      ],
    });
    const run = makeRun(plan, 'glued heading end to end');
    await store.saveRun(run);

    const provider = new ScriptedProvider({
      fallback: { text: 'Some narration first.# Real Heading\n\nBody.' },
    });

    await dispatchRun({
      run,
      registry,
      provider,
      store,
      signal: new AbortController().signal,
    });

    const report = await store.readReport(run.id, 'reports/01-narrator.md');
    const lines = report.split('\n');
    expect(lines).toContain('# Real Heading');
    expect(lines[0]).toBe('Some narration first.');
  });
});

describe('F4 — agentName/phaseId denormalised onto logged events', () => {
  it('stamps every persisted event — both a status transition and a provider event — with the dispatching assignment\'s agentName and phaseId', async () => {
    const { store, provider, run } = await setup({
      fallback: { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    // Assignment 'a' is 'alpha' in the 'research' phase (see `twoPhasePlan`).
    const logged = await store.readEvents(run.id, 'a');
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(entry.event.agentName).toBe('alpha');
      expect(entry.event.phaseId).toBe('research');
    }

    // Not just the status events (`setStatus`'s own event literal) — the
    // provider's own `usage`/`text` events, enriched via
    // `withAssignmentProvenance` in the dispatch loop, carry the same
    // fields. Asserted on the event `t`s directly so a future refactor that
    // accidentally stops enriching one code path cannot hide behind an
    // assertion that only ever looked at the other.
    const kinds = logged.map((entry) => entry.event.t);
    expect(kinds).toContain('status');
    expect(kinds).toContain('usage');
  });

  it('stamps a *different* phaseId for an assignment in a later phase, proving the value is read per-assignment and not a fixed run-level constant', async () => {
    const { store, provider, run } = await setup({
      fallback: { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } },
    });

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    // Assignment 'c' is 'gamma' in the 'synthesis' phase, depending on 'a'
    // ('research'). If `withAssignmentProvenance`/`setStatus` ever hard-coded
    // or cached the first assignment's phase instead of reading each
    // assignment's own `phaseId`, this is the assertion that would catch it.
    const loggedA = await store.readEvents(run.id, 'a');
    const loggedC = await store.readEvents(run.id, 'c');
    expect(loggedA.every((entry) => entry.event.phaseId === 'research')).toBe(true);
    expect(loggedC.every((entry) => entry.event.phaseId === 'synthesis')).toBe(true);
    expect(loggedC.every((entry) => entry.event.agentName === 'gamma')).toBe(true);
  });
});

describe('F4 — NFR-7: a pre-F4 log line still parses and replays', () => {
  let tmpRoot: string;

  afterEach(async () => {
    if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * A line exactly as F4 would have found it already on disk: `ts` plus an
   * `event` carrying only `assignmentId`, `t` and that variant's own fields
   * — no `agentName`, no `phaseId`, because both are new keys this fix adds.
   */
  const PRE_F4_LINE =
    '{"ts":1000,"event":{"assignmentId":"a","t":"status","status":"working"}}';

  it('LoggedAgentEventSchema parses a line with agentName/phaseId absent, and leaves them undefined rather than defaulting', () => {
    const result = LoggedAgentEventSchema.safeParse(JSON.parse(PRE_F4_LINE));
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.event.agentName).toBeUndefined();
    expect(result.data.event.phaseId).toBeUndefined();
    // Absence must mean "predates the field", not "the schema silently
    // supplied a value" — `'agentName' in result.data.event` is the
    // `exactOptionalPropertyTypes`-aware way to distinguish those (see the
    // identical distinction `dispatcher.ts`'s `setStatus` draws for
    // `endedAtCleared`).
    expect('agentName' in result.data.event).toBe(false);
    expect('phaseId' in result.data.event).toBe(false);
  });

  it('FileRunStore.readEvents — the real replay read path — accepts a pre-F4 line on real disk without agentName/phaseId', async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-f4-legacy-log-'));
    const store = new FileRunStore(tmpRoot);
    const run = makeRun(twoPhasePlan());
    await store.saveRun(run);

    // Written directly to the log file with plain `fs`, bypassing
    // `store.appendEvent` entirely — the whole point is to simulate a line
    // that was on disk before F4 existed and was never touched by this
    // fix's own write path.
    const logsDir = path.join(store.runDir(run.id), 'logs');
    await mkdir(logsDir, { recursive: true });
    await appendFile(path.join(logsDir, 'a.jsonl'), `${PRE_F4_LINE}\n`, 'utf8');

    const logged = await store.readEvents(run.id, 'a');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.event.t).toBe('status');
    expect(logged[0]?.event.agentName).toBeUndefined();
    expect(logged[0]?.event.phaseId).toBeUndefined();
  });
});
