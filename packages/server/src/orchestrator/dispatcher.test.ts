import { describe, expect, it } from 'vitest';
import {
  canTransitionAssignment,
  RunPlanSchema,
  type AgentDef,
  type AgentEvent,
  type RunPlan,
  type RunState,
} from '@agent-office/shared';
import { buildRegistry } from '../registry/index.js';
import { ScriptedProvider, type ScriptedProviderOptions } from '../providers/scripted.js';
import { MemoryRunStore } from '../store/memoryStore.js';
import { dispatchRun, materialiseAssignments } from './dispatcher.js';

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
          w0: { text: 'fast', usage: { inputTokens: 500, outputTokens: 500 } },
          w1: { text: 'fast', usage: { inputTokens: 500, outputTokens: 500 }, delayMs: 5 },
          w2: { text: 'slow', usage: { inputTokens: 500, outputTokens: 500 }, delayMs: 50 },
          w3: { text: 'slow', usage: { inputTokens: 500, outputTokens: 500 }, delayMs: 50 },
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
