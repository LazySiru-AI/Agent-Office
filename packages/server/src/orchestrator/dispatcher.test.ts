import { describe, expect, it } from 'vitest';
import { RunPlanSchema, type AgentDef, type RunPlan, type RunState } from '@agent-office/shared';
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
    const plan = RunPlanSchema.parse({
      summary: 's',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'only',
          name: 'Only',
          parallel: true,
          assignments: [
            {
              id: 'evil',
              agentName: 'alpha',
              objective: 'work',
              deliverable: '../../../escaped.md',
              dependsOn: [],
            },
          ],
        },
      ],
    });

    const { store, provider, run } = await setup({ fallback: { text: 'payload' } }, plan);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    expect(run.assignments[0]?.status).toBe('failed');
    expect(run.assignments[0]?.error).toContain('could not write report');
    expect(store.reportsFor(run.id).size).toBe(0);
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
