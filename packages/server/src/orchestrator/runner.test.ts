import { describe, expect, it } from 'vitest';
import { runTotalUsage, totalUsage, type RunState, type TeamOperation } from '@agent-office/shared';
import { MemoryRunStore } from '../store/memoryStore.js';
import { stubDeliverable, testProviderFactory, testRegistry, waitFor } from '../http/fixtures.js';
import { MANAGER_PLAN_ASSIGNMENT_ID, MANAGER_SYNTHESIS_ASSIGNMENT_ID } from './manager.js';
import { executeRun } from './runner.js';

/**
 * A promise this file can settle from the outside, standing in for the real
 * `awaitTeamApproval` implementation (the HTTP layer, owned elsewhere, which
 * resolves it when a `POST .../team` request lands). Every FR-M11 test below
 * needs to control exactly when — or whether — the pause ends.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Run-level bookkeeping that only `executeRun` can do (NFR-5).
 *
 * The dispatcher records usage per assignment, but the Manager's own turns are
 * not assignments — nothing below this layer ever sees them. These tests exist
 * because a cost display built on assignment usage alone silently understated
 * every run: on a three-agent run the Manager outspends the whole team.
 */

describe('executeRun — run provenance', () => {
  it('records the provider that executed the run', async () => {
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'record the provider',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    // Without this, cost falls back to each agent's catalog model and a
    // scripted run — which calls no model at all — reports money as spent.
    expect(run.provider).toBe('scripted');
  });
});

describe('executeRun — manager token accounting (NFR-5)', () => {
  it('accumulates planning and synthesis usage into managerUsage', async () => {
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'count the manager',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    // The fixture scripts planning at 120/40 and synthesis at 200/60.
    expect(run.managerUsage).toEqual({ inputTokens: 320, outputTokens: 100 });
  });

  it('keeps manager usage out of the dispatch budget total', async () => {
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'separate the totals',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    // `totalUsage` is assignments-only; `runTotalUsage` adds the Manager's own
    // turns. This test is about that difference existing at all — that manager
    // spend is recorded somewhere rather than vanishing.
    //
    // It used to add that `totalUsage` "scopes the FR-M8 dispatch budget and
    // must stay assignments-only". It no longer does, and the claim was the
    // defect: a run whose Manager alone blew the budget completed anyway. The
    // budget now checks `runTotalUsage`, which is what "per-run token budget"
    // meant all along.
    const assignments = totalUsage(run);
    const whole = runTotalUsage(run);

    expect(whole.inputTokens).toBe(assignments.inputTokens + 320);
    expect(whole.outputTokens).toBe(assignments.outputTokens + 100);
    expect(whole.inputTokens).toBeGreaterThan(assignments.inputTokens);
  });

  it('records manager usage even when the run never reaches synthesis', async () => {
    // Planning succeeds and bills tokens; the lead assignment then fails, which
    // strands both reviewers that depend on it. Nothing produces a report, so
    // the run ends without a synthesis turn — but the planning spend was real.
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory({
        lead: { failWith: 'provider exploded' },
      })(),
      store: new MemoryRunStore(),
      task: 'bill planning anyway',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('failed');
    expect(run.managerUsage?.inputTokens).toBe(120);
    expect(run.managerUsage?.outputTokens).toBe(40);
  });
});

describe('executeRun — manager event log (NFR-7 replay)', () => {
  // Before this fix, `manager.ts`'s `runManagerTurn` never called
  // `store.appendEvent` — only `dispatcher.ts` did, and only for the
  // assignments it dispatches. Planning and synthesis streamed `usage` and
  // `text` events live through `onEvent`, but none of them ever reached
  // `logs/*.jsonl`, so `GET /api/runs/:id/events` (NFR-7 replay) reconstructed
  // total silence for the two turns that, on this very fixture, spend more
  // tokens (320 in / 100 out) than the whole team combined.

  it('persists the planning turn into logs/manager-plan.jsonl', async () => {
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'log the planning turn',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    const planEvents = await store.readEvents(run.id, MANAGER_PLAN_ASSIGNMENT_ID);
    expect(planEvents.length).toBeGreaterThan(0);
    expect(planEvents.some((logged) => logged.event.t === 'usage')).toBe(true);
    expect(planEvents.some((logged) => logged.event.t === 'text')).toBe(true);
    expect(planEvents.every((logged) => logged.event.assignmentId === MANAGER_PLAN_ASSIGNMENT_ID)).toBe(
      true,
    );
  });

  it('persists the synthesis turn into logs/manager-synthesis.jsonl', async () => {
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'log the synthesis turn',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    const synthesisEvents = await store.readEvents(run.id, MANAGER_SYNTHESIS_ASSIGNMENT_ID);
    expect(synthesisEvents.length).toBeGreaterThan(0);
    expect(synthesisEvents.some((logged) => logged.event.t === 'usage')).toBe(true);
    expect(synthesisEvents.some((logged) => logged.event.t === 'text')).toBe(true);
  });

  it('keeps manager events out of every real assignment\'s own log', async () => {
    // The reserved ids must land in their own files, never mixed into an
    // assignment's log — otherwise replay would attribute the Manager's text
    // to whichever agent happens to log around the same moment.
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'keep manager and assignment logs separate',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.assignments.length).toBeGreaterThan(0);
    for (const assignment of run.assignments) {
      const events = await store.readEvents(run.id, assignment.id);
      expect(events.every((logged) => logged.event.assignmentId === assignment.id)).toBe(true);
    }
  });
});

describe('executeRun — FR-M11 team review pause', () => {
  it('parks in awaiting_approval with the proposed team visible, then dispatches once approved', async () => {
    // The core of FR-M11: the run must actually stop and wait, not merely
    // pass the plan through a no-op hook. `statuses` proves the pause was
    // real (the run sat in `awaiting_approval` before ever reaching
    // `dispatching`), and `capturedRun` proves the pause happens AFTER the
    // proposed team is persisted and visible — a client reconnecting while
    // parked must see the team, per `awaiting_approval`'s doc comment in
    // `shared/src/status.ts` ("so the client can render the proposed team").
    const store = new MemoryRunStore();
    const statuses: string[] = [];
    const approval = deferred<readonly TeamOperation[]>();
    let capturedRun: RunState | undefined;

    const runPromise = executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'review before dispatch',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      onStateChange: (r) => statuses.push(r.status),
      awaitTeamApproval: async ({ run }) => {
        capturedRun = run;
        return approval.promise;
      },
    });

    await waitFor(() => statuses.includes('awaiting_approval'), 'run to reach awaiting_approval');

    expect(capturedRun?.plan).toBeDefined();
    expect(capturedRun?.assignments.map((a) => a.id)).toEqual(['lead', 'review-1', 'review-2']);
    expect(capturedRun?.assignments.every((a) => a.status === 'pending')).toBe(true);

    // Approve with no edits — the "the Manager's team is right, go" case.
    approval.resolve([]);
    const { run } = await runPromise;

    expect(run.status).toBe('done');
    expect(statuses).toContain('awaiting_approval');
    expect(statuses.indexOf('awaiting_approval')).toBeLessThan(statuses.indexOf('dispatching'));
    expect(run.assignments.map((a) => a.id)).toEqual(['lead', 'review-1', 'review-2']);
  });

  it('applies the approved operations before dispatch, so a dropped assignment is never run', async () => {
    // Not just "the run parks and resumes" — the edits themselves have to
    // reach the assignments the dispatcher actually executes. If
    // `runner.ts` re-materialised from the ORIGINAL plan instead of
    // `applyTeamOperations`'s result, this would dispatch `review-2` anyway
    // and this test would catch it via both the assignment list and the
    // empty event log.
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'drop review-2 before dispatch',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      awaitTeamApproval: async () => [{ op: 'drop', assignmentId: 'review-2' }],
    });

    expect(run.status).toBe('done');
    expect(run.assignments.map((a) => a.id)).toEqual(['lead', 'review-1']);
    expect(run.plan?.phases.find((p) => p.id === 'review')?.assignments.map((a) => a.id)).toEqual([
      'review-1',
    ]);

    // Nothing was ever dispatched for the dropped assignment.
    const dropped = await store.readEvents(run.id, 'review-2');
    expect(dropped).toEqual([]);
  });

  it('fails the run cleanly, without dispatching, when the approved operations do not apply', async () => {
    // `applyTeamOperations` is total and returns `{ error }` rather than
    // throwing; this is the test that the runner actually reads that shape
    // and fails the run instead of either crashing or silently dispatching
    // the Manager's original, unedited plan as if the bad edit had never
    // been requested.
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'approve a swap to an unknown agent',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      awaitTeamApproval: async () => [{ op: 'swap', assignmentId: 'review-1', agentName: 'no-such-agent' }],
    });

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/no-such-agent/);
    const events = await store.readEvents(run.id, 'lead');
    expect(events).toEqual([]);
  });

  it('goes planning -> dispatching exactly as before when awaitTeamApproval is absent', async () => {
    // FR-M11 is opt-in, and `RUN_TRANSITIONS['planning']` allows both
    // `awaiting_approval` and `dispatching` for exactly this reason: every
    // run that does not ask to review its team — which, before this
    // feature, was every run — must be unable to tell the pause exists at
    // all. This test is the negative space the other three don't cover: no
    // `awaitTeamApproval` in `deps` means `awaiting_approval` must never
    // appear in the status history.
    const store = new MemoryRunStore();
    const statuses: string[] = [];

    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'no review requested',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      onStateChange: (r) => statuses.push(r.status),
    });

    expect(run.status).toBe('done');
    expect(statuses).not.toContain('awaiting_approval');
    expect(run.assignments.map((a) => a.id)).toEqual(['lead', 'review-1', 'review-2']);
  });

  it('cancels cleanly with nothing dispatched when the run is stopped while parked (FR-M9)', async () => {
    // The pause can "sit here indefinitely" by design, which makes it the
    // one await most exposed to a cancel landing while nothing else is
    // happening. `hang.promise` never resolves on its own — the only thing
    // that ends the wait is `controller.abort()` — so if the runner did not
    // race the approval promise against `signal` (see
    // `raceApprovalAgainstAbort`), this test would time out instead of
    // observing `cancelled`.
    const store = new MemoryRunStore();
    const statuses: string[] = [];
    const hang = deferred<readonly TeamOperation[]>();
    const controller = new AbortController();

    const runPromise = executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'cancel while awaiting approval',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      signal: controller.signal,
      onStateChange: (r) => statuses.push(r.status),
      awaitTeamApproval: () => hang.promise,
    });

    await waitFor(() => statuses.includes('awaiting_approval'), 'run to reach awaiting_approval');
    controller.abort();
    const { run, dispatch } = await runPromise;

    expect(run.status).toBe('cancelled');
    // Never reached the dispatcher at all — `dispatchResult` stays
    // `undefined` in `executeRun` unless `dispatchRun` was actually called.
    expect(dispatch).toBeUndefined();
    expect(run.assignments.every((a) => a.status === 'pending')).toBe(true);

    for (const assignment of run.assignments) {
      const events = await store.readEvents(run.id, assignment.id);
      expect(events).toEqual([]);
    }
  });
});
