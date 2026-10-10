import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  EVENT_BUFFER_LIMIT,
  type AgentDef,
  type RunState,
  type ServerMessage,
} from '@agent-office/shared';
import { MANAGER_PLAN_ASSIGNMENT_ID } from '../orchestrator/manager.js';
import { buildRegistry } from '../registry/index.js';
import { MemoryRunStore } from '../store/memoryStore.js';
import type { RunStore } from '../store/types.js';
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  RingBuffer,
  RunConcurrencyLimitError,
  RunSupervisor,
  withCreateRunHook,
} from './supervisor.js';
import {
  SLOW_RUN_TIMEOUT_MS,
  stubDeliverable,
  testProviderFactory,
  testRegistry,
  waitFor,
  waitForTerminal,
} from './fixtures.js';

/**
 * The supervisor is the only part of Phase 3 that owns *time*: a run outlives
 * the request that started it. These tests are therefore mostly about what is
 * true at particular moments â€” right after `startRun` returns, while a run is
 * hanging, and after it has ended.
 */

function makeSupervisor(
  overrides: Parameters<typeof testProviderFactory>[0] = {},
  store: RunStore = new MemoryRunStore(),
): { supervisor: RunSupervisor; store: RunStore; warnings: string[] } {
  const warnings: string[] = [];
  const supervisor = new RunSupervisor({
    registry: testRegistry(),
    store,
    makeProvider: testProviderFactory(overrides),
    onWarning: (message) => warnings.push(message),
    produceDeliverable: stubDeliverable(),
  });
  return { supervisor, store, warnings };
}

/**
 * Applied to this whole file rather than to hand-picked tests.
 *
 * The previous approach was to mark "the handful of tests that drive a whole
 * run end to end" individually, on the reasoning that a blanket raise would
 * hide a real hang. The reasoning was sound; the execution was not, twice over.
 * Tests were missed — "returns the run id before the run has finished" awaits
 * `waitForTerminal` exactly like its neighbours and never got the marker, and
 * it failed in all five runs of a measurement pass. And the marker did not
 * work anyway, because `waitForTerminal` gave up at its own tighter deadline
 * first (see `fixtures.ts`).
 *
 * Nearly every test in this file starts a supervisor and drives a real run, so
 * choosing which ones are "the slow ones" was always a per-test judgement that
 * had to be made correctly fifteen times and repeated on every new test. A
 * file-level budget makes it once. The hang-detection this gives up is
 * recovered elsewhere and better: `RUN_POLL_TIMEOUT_MS` fires first and names
 * the status the run was stuck in, which is a far more useful failure than a
 * bare vitest timeout ever was.
 */
// `hookTimeout` is set for any hook added below this line — note that it does
// not reach one registered ABOVE it, since a hook takes its budget when it is
// registered. This file has no hooks today; when one is added, check which side
// of this line it lands on. See the fuller note in `server.test.ts`, where that
// ordering cost two misdiagnosed full-suite runs.
vi.setConfig({ testTimeout: SLOW_RUN_TIMEOUT_MS, hookTimeout: SLOW_RUN_TIMEOUT_MS });
describe('RingBuffer', () => {
  it('keeps the newest entries and reports that it dropped the rest', () => {
    // The dropped flag is what `snapshot.truncated` is built from. Without it a
    // client shown the tail of a run would present it as the whole run.
    const buffer = new RingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(value);

    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.size).toBe(3);
    expect(buffer.truncated).toBe(true);
  });

  it('reports no truncation while it is still within its limit', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);

    expect(buffer.toArray()).toEqual([1, 2]);
    expect(buffer.truncated).toBe(false);
  });

  it('hands out copies, so a caller cannot mutate the buffer it was given', () => {
    // Snapshots are handed to sockets that may sit on them; a shared array would
    // let one client's rendering change another's history.
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    const first = buffer.toArray();
    buffer.push(2);

    expect(first).toEqual([1]);
  });

  it('refuses a non-positive limit rather than silently dropping everything', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(/positive/);
  });
});

describe('RunSupervisor.startRun', () => {
  it('returns the run id before the run has finished', async () => {
    // The whole reason this class exists: `POST /api/runs` must answer in
    // milliseconds even when the run behind it takes ten minutes.
    const { supervisor } = makeSupervisor();

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });

    expect(runId).toMatch(/^[a-z0-9-]+$/);
    expect(supervisor.liveRunIds()).toContain(runId);
    expect((await supervisor.getRunState(runId)).status).not.toBe('done');

    await waitForTerminal(supervisor, runId);
  });

  it('drives the run to done with every assignment in the plan', async () => {
    const { supervisor } = makeSupervisor();

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    const run = await waitForTerminal(supervisor, runId);

    expect(run.status).toBe('done');
    expect(run.assignments).toHaveLength(3);
    expect(run.assignments.every((assignment) => assignment.status === 'done')).toBe(true);
    expect(run.reportPath).toBe('report.md');
    expect(supervisor.liveRunIds()).not.toContain(runId);
  }, SLOW_RUN_TIMEOUT_MS);

  it('passes request.maxCostUsd through to makeProvider as an options object (FR-M8)', async () => {
    // DEFECT FIXED: `startRun` used to call `this.deps.makeProvider(id, task,
    // knownAgentNames)` with no fourth argument at all, so `maxCostUsd` had no
    // path off the request even though the schema now accepts it. This pins
    // the shape it travels in: the same `MakeProviderOptions` object
    // `providers/factory.ts` already declares, not a second bespoke shape.
    const store = new MemoryRunStore();
    const received: unknown[] = [];
    const supervisor = new RunSupervisor({
      registry: testRegistry(),
      store,
      makeProvider: (_id, _task, _known, options) => {
        received.push(options);
        // `testProviderFactory()` returns a zero-argument stub — it ignores
        // id/task/known — so nothing is lost by not forwarding them.
        return testProviderFactory()();
      },
      produceDeliverable: stubDeliverable(),
    });

    const runId = await supervisor.startRun({ task: 'Analyse the thing.', maxCostUsd: 1.25 });
    await waitForTerminal(supervisor, runId);

    // One provider is built per run, up front, and reused for the Manager's
    // planning and synthesis turns as well as every agent's — so one call is
    // the whole contract here.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ maxCostUsd: 1.25 });
  });

  it('omits maxCostUsd from the options object when the request does not set it', async () => {
    const store = new MemoryRunStore();
    const received: unknown[] = [];
    const supervisor = new RunSupervisor({
      registry: testRegistry(),
      store,
      makeProvider: (_id, _task, _known, options) => {
        received.push(options);
        // `testProviderFactory()` returns a zero-argument stub — it ignores
        // id/task/known — so nothing is lost by not forwarding them.
        return testProviderFactory()();
      },
      produceDeliverable: stubDeliverable(),
    });

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    await waitForTerminal(supervisor, runId);

    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty('maxCostUsd');
  });

  it('rejects an unknown provider without creating a run', async () => {
    const store = new MemoryRunStore();
    const supervisor = new RunSupervisor({ registry: testRegistry(), store });

    await expect(supervisor.startRun({ task: 'x', provider: 'no-such-provider' })).rejects.toThrow(
      /unknown provider/,
    );
    expect(await store.listRuns()).toHaveLength(0);
  });
});

describe('RunSupervisor buffering and snapshots (NFR-2)', () => {
  it('serves a live run from memory with its buffered events', async () => {
    // `lead` hangs, so the run is guaranteed to still be executing when the
    // snapshot is taken â€” which is the state a mid-run refresh lands in.
    const { supervisor } = makeSupervisor({ lead: { hang: true } });

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    await waitFor(() => supervisor.isLive(runId), 'the run to be live');
    // Wait for the orchestrator to actually get going, so the assertions below
    // are about a run with history rather than one still allocating its id.
    await waitFor(async () => {
      const current = await supervisor.snapshot(runId);
      return current.events.length > 0 && current.logs.length > 0;
    }, 'the first buffered event and log line');

    const snapshot = await supervisor.snapshot(runId);

    expect(snapshot.live).toBe(true);
    expect(snapshot.run.id).toBe(runId);
    expect(snapshot.truncated).toBe(false);
    // Planning alone emits status events, so a live snapshot is never empty.
    expect(snapshot.events.length).toBeGreaterThan(0);
    expect(snapshot.logs.length).toBeGreaterThan(0);

    supervisor.cancelRun(runId);
    await waitForTerminal(supervisor, runId);
  });

  it('keeps a just-finished run in memory so a reconnect still gets its history', async () => {
    // The reattach window a page reload opens is exactly wide enough for a run
    // to end inside it. Falling straight back to disk would hand that client an
    // empty event list for a run it was watching a second earlier.
    const { supervisor } = makeSupervisor();

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    await waitForTerminal(supervisor, runId);

    const snapshot = await supervisor.snapshot(runId);

    expect(snapshot.live).toBe(false);
    expect(snapshot.events.length).toBeGreaterThan(0);
    expect(snapshot.truncated).toBe(false);
  });

  it('marks a store-loaded run as truncated, because none of its history is replayed', async () => {
    // A run this process never executed has its events on disk and nowhere else.
    // Reporting `truncated: false` with an empty list would claim the client has
    // the whole story when it has none of it.
    const store = new MemoryRunStore();
    const { supervisor } = makeSupervisor({}, store);

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    const finished = await waitForTerminal(supervisor, runId);

    // A second supervisor stands in for a server restart: same store, no memory.
    const restarted = new RunSupervisor({ registry: testRegistry(), store });
    const snapshot = await restarted.snapshot(runId);

    expect(snapshot.live).toBe(false);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.run.status).toBe(finished.status);
  });

  it('rejects a snapshot for a run that exists nowhere', async () => {
    const { supervisor } = makeSupervisor();

    await expect(supervisor.snapshot('20260101-000000-zzzz')).rejects.toThrow();
  });

  it('never lets one buffered run grow past the contract limit', () => {
    // Proving the wiring rather than the arithmetic: the buffer the supervisor
    // allocates is the one the contract sizes, so a change to EVENT_BUFFER_LIMIT
    // cannot quietly stop applying here.
    const buffer = new RingBuffer<number>(EVENT_BUFFER_LIMIT);
    for (let i = 0; i < EVENT_BUFFER_LIMIT + 10; i += 1) buffer.push(i);

    expect(buffer.size).toBe(EVENT_BUFFER_LIMIT);
    expect(buffer.truncated).toBe(true);
    expect(buffer.toArray()[0]).toBe(10);
  });
});

describe('RunSupervisor subscriptions', () => {
  it('fans events, state and log lines out to subscribers, and stops on unsubscribe', async () => {
    const { supervisor } = makeSupervisor();

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    const received: ServerMessage[] = [];
    const off = supervisor.subscribe(runId, (message) => received.push(message));

    await waitForTerminal(supervisor, runId);

    expect(received.some((message) => message.t === 'event')).toBe(true);
    expect(received.some((message) => message.t === 'state')).toBe(true);
    expect(received.some((message) => message.t === 'log')).toBe(true);

    const countAtUnsubscribe = received.length;
    off();

    const second = await supervisor.startRun({ task: 'Analyse another thing.' });
    await waitForTerminal(supervisor, second);

    // A subscription is per-run: the second run must not reach the first's
    // listener, or a tab watching one run gets every other run's firehose.
    expect(received).toHaveLength(countAtUnsubscribe);
    // Two full orchestrator runs, back to back. Vitest's 5s default is tight
    // for that on its own, and Phase 5 added a suite that launches a real
    // browser in a parallel worker â€” enough CPU contention to tip this over.
    // The generous budget is about scheduling, not about waiting for anything:
    // every wait in here polls at 5ms and returns as soon as its condition holds.
  }, 30_000);

  it('carries on when a subscriber throws', async () => {
    // One socket failing mid-send must not abort the run producing the events,
    // nor rob the other subscribers of them.
    const { supervisor, warnings } = makeSupervisor();

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    supervisor.subscribe(runId, () => {
      throw new Error('subscriber exploded');
    });
    const survivor: ServerMessage[] = [];
    supervisor.subscribe(runId, (message) => survivor.push(message));

    const run = await waitForTerminal(supervisor, runId);

    expect(run.status).toBe('done');
    expect(survivor.length).toBeGreaterThan(0);
    expect(warnings.some((message) => message.includes('subscriber'))).toBe(true);
  });

  it('notifies run-list listeners when a run starts and when it ends', async () => {
    const { supervisor } = makeSupervisor();
    let notifications = 0;
    supervisor.onRunListChanged(() => {
      notifications += 1;
    });

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    expect(notifications).toBeGreaterThanOrEqual(1);

    await waitForTerminal(supervisor, runId);
    await waitFor(() => notifications >= 2, 'the terminal run-list notification');
  });
});

describe('RunSupervisor cancellation (FR-M9)', () => {
  it('cancels a run that is hanging in an assignment', async () => {
    const { supervisor } = makeSupervisor({ lead: { hang: true } });

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    await waitFor(() => supervisor.isLive(runId), 'the run to be live');

    expect(supervisor.cancelRun(runId)).toBe(true);

    const run = await waitForTerminal(supervisor, runId);
    expect(run.status).toBe('cancelled');
  });

  it('reports false for a run it is not executing', async () => {
    // The HTTP layer turns this into a 409 rather than pretending a run in a
    // previous server process was stopped.
    const { supervisor } = makeSupervisor();

    expect(supervisor.cancelRun('20260101-000000-zzzz')).toBe(false);

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    await waitForTerminal(supervisor, runId);
    expect(supervisor.cancelRun(runId)).toBe(false);
  });

  it('cancels everything in flight on shutdown and waits for it to unwind', async () => {
    const { supervisor } = makeSupervisor({ lead: { hang: true } });

    const first = await supervisor.startRun({ task: 'Analyse the thing.' });
    const second = await supervisor.startRun({ task: 'Analyse the other thing.' });
    await waitFor(() => supervisor.liveRunIds().length === 2, 'both runs to be live');

    await supervisor.shutdown();

    expect(supervisor.liveRunIds()).toEqual([]);
    expect((await supervisor.getRunState(first)).status).toBe('cancelled');
    expect((await supervisor.getRunState(second)).status).toBe('cancelled');
  });
});

describe('RunSupervisor concurrency cap (AO-6)', () => {
  it('refuses the (N+1)th run once N are already executing, and allows a new one once a slot frees', async () => {
    // WHAT THIS PREVENTS: `startRun` used to accept every request
    // unconditionally and start `executeRun` in the background — no ceiling
    // on how many could be going at once. Each run spawns real, billed
    // provider child processes, several per phase, so on a loopback server
    // with no user boundary that is an unbounded-cost primitive: anything
    // that could reach the port could keep starting runs forever.
    // `--max-budget-usd` caps what ONE run spends; nothing capped how many
    // could be spending it simultaneously.
    const store = new MemoryRunStore();
    const supervisor = new RunSupervisor({
      registry: testRegistry(),
      store,
      // Hung so both slots stay occupied until the test releases one on
      // purpose, rather than the scripted provider finishing before the
      // assertions below get a chance to run.
      makeProvider: testProviderFactory({ lead: { hang: true } }),
      onWarning: () => undefined,
      produceDeliverable: stubDeliverable(),
      maxConcurrentRuns: 2,
    });

    const first = await supervisor.startRun({ task: 'first' });
    const second = await supervisor.startRun({ task: 'second' });
    await waitFor(() => supervisor.liveRunIds().length === 2, 'both runs to be live');

    await expect(supervisor.startRun({ task: 'one too many' })).rejects.toThrow(RunConcurrencyLimitError);
    // The refusal happens before a run is ever created for it — `startRun`
    // checks the cap before touching the provider or the store at all.
    expect((await store.listRuns()).map((run) => run.task)).not.toContain('one too many');
    expect(supervisor.liveRunIds()).toHaveLength(2);

    // Free a slot the way a real run ends, then confirm the cap actually
    // tracks live count rather than a total-ever-started counter.
    supervisor.cancelRun(first);
    await waitForTerminal(supervisor, first);

    const third = await supervisor.startRun({ task: 'now there is room' });
    expect(supervisor.liveRunIds()).toContain(third);

    supervisor.cancelRun(second);
    supervisor.cancelRun(third);
    await waitForTerminal(supervisor, second);
    await waitForTerminal(supervisor, third);
  });

  it('counts a run parked at awaiting_approval against the cap', async () => {
    // A parked run is still `live` from the supervisor's point of view (see
    // `shutdown`'s doc comment for the same point made about cancellation),
    // and it has already spent one planning call's worth of provider cost to
    // get there — this pins that the cap agrees, rather than quietly only
    // counting runs mid-dispatch.
    const store = new MemoryRunStore();
    const supervisor = new RunSupervisor({
      registry: testRegistry(),
      store,
      makeProvider: testProviderFactory(),
      onWarning: () => undefined,
      produceDeliverable: stubDeliverable(),
      maxConcurrentRuns: 1,
    });

    const parked = await supervisor.startRun({ task: 'first', reviewTeam: true });
    await waitFor(
      async () => (await supervisor.getRunState(parked)).status === 'awaiting_approval',
      'the run to park for team approval',
    );

    await expect(supervisor.startRun({ task: 'blocked' })).rejects.toThrow(RunConcurrencyLimitError);

    supervisor.cancelRun(parked);
    await waitForTerminal(supervisor, parked);
  });

  it('defaults to DEFAULT_MAX_CONCURRENT_RUNS when the deps do not override it', async () => {
    const { supervisor } = makeSupervisor({ lead: { hang: true } });

    const ids: string[] = [];
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_RUNS; i += 1) {
      ids.push(await supervisor.startRun({ task: `run ${i}` }));
    }
    await waitFor(
      () => supervisor.liveRunIds().length === DEFAULT_MAX_CONCURRENT_RUNS,
      'every run up to the default cap to be live',
    );

    await expect(supervisor.startRun({ task: 'past the default cap' })).rejects.toThrow(
      RunConcurrencyLimitError,
    );

    for (const id of ids) supervisor.cancelRun(id);
    for (const id of ids) await waitForTerminal(supervisor, id);
  });
});

describe('RunSupervisor team approval (FR-M11)', () => {
  it('parks a reviewTeam run at awaiting_approval with the proposed plan already visible, and releases it on an empty decision', async () => {
    // This is the whole point of the pause: a client that reconnects or
    // subscribes while the run is parked has to be able to render the
    // Manager's proposed team, not an empty plan waiting for one to appear.
    // `run.plan`/`run.assignments` are stamped by `runner.ts` and persisted
    // via the `awaiting_approval` transition itself, before anything is
    // awaited, so they must already be on the state this test reads.
    const { supervisor } = makeSupervisor();

    const runId = await supervisor.startRun({ task: 'Analyse the thing.', reviewTeam: true });
    await waitFor(async () => (await supervisor.getRunState(runId)).status === 'awaiting_approval', 'the run to park for team approval');

    const parked = await supervisor.getRunState(runId);
    expect(parked.plan).toBeDefined();
    expect(parked.plan?.phases.length).toBeGreaterThan(0);
    expect(parked.assignments).toHaveLength(3);
    // Still "live" from the supervisor's point of view: nothing here has
    // finished, it is only waiting on a human rather than a provider — the
    // same fact `cancelRun`/`shutdown` below lean on to abort a parked run.
    expect(supervisor.isLive(runId)).toBe(true);

    // An empty array is a meaningful decision, not a no-op skipped by the
    // route or the runner — see `TeamDecisionSchema`'s own doc comment.
    expect(supervisor.submitTeamDecision(runId, [])).toBe(true);

    const finished = await waitForTerminal(supervisor, runId);
    expect(finished.status).toBe('done');
    expect(finished.assignments).toHaveLength(3);
  });

  it('applies an approved edit to the team before dispatch, so a drop actually removes the work', async () => {
    // Proves the wiring end to end, not just that the promise unblocks:
    // `submitTeamDecision`'s operations have to reach `applyTeamOperations`
    // inside `runner.ts` and change what gets materialised into assignments,
    // or FR-M11 would let a user "approve" edits that are silently discarded.
    const { supervisor } = makeSupervisor();

    const runId = await supervisor.startRun({ task: 'Analyse the thing.', reviewTeam: true });
    await waitFor(async () => (await supervisor.getRunState(runId)).status === 'awaiting_approval', 'the run to park for team approval');

    expect(supervisor.submitTeamDecision(runId, [{ op: 'drop', assignmentId: 'review-2' }])).toBe(true);

    const finished = await waitForTerminal(supervisor, runId);
    expect(finished.status).toBe('done');
    expect(finished.assignments.map((assignment) => assignment.id)).not.toContain('review-2');
    expect(finished.assignments).toHaveLength(2);
  });

  it('never pauses when the request did not ask for a review, so every pre-FR-M11 caller is unaffected', async () => {
    // `reviewTeam` is opt-in (see `CreateRunRequestSchema`'s doc comment); a
    // run that omits it must never be observed at `awaiting_approval`, or
    // every existing caller — the CLI, every other fixture in this file —
    // would have quietly grown an extra pause it never asked for.
    const { supervisor } = makeSupervisor();
    const statuses: string[] = [];
    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    supervisor.subscribe(runId, (message) => {
      if (message.t === 'state') statuses.push(message.run.status);
    });

    await waitForTerminal(supervisor, runId);

    expect(statuses).not.toContain('awaiting_approval');
  });

  it('reports false for a decision on a run that never asked to pause', async () => {
    const { supervisor } = makeSupervisor();
    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    await waitForTerminal(supervisor, runId);

    // The HTTP route turns this into a 409: the run exists, it simply has
    // nothing parked to resolve, and approving it must not silently do
    // nothing while implying success.
    expect(supervisor.submitTeamDecision(runId, [])).toBe(false);
  });

  it('reports false for a decision on a run id that does not exist at all', () => {
    // The route's 404 case: `submitTeamDecision` cannot tell "unknown run"
    // apart from "known but not parked" on its own (see its doc comment) — it
    // is the caller's job to have already loaded the run — but either way it
    // must refuse rather than throw.
    const { supervisor } = makeSupervisor();
    expect(supervisor.submitTeamDecision('20260101-000000-zzzz', [])).toBe(false);
  });

  it('refuses a second decision for the same run, rather than resolving or crashing twice', async () => {
    // Exactly-once. A client double-clicking Approve, or a retry after a
    // dropped response, must not be able to resolve the same parked promise
    // twice — `PendingTeamApproval.resolve`'s `settled` guard is what this
    // pins down from the outside.
    const { supervisor } = makeSupervisor();
    const runId = await supervisor.startRun({ task: 'Analyse the thing.', reviewTeam: true });
    await waitFor(async () => (await supervisor.getRunState(runId)).status === 'awaiting_approval', 'the run to park for team approval');

    expect(supervisor.submitTeamDecision(runId, [])).toBe(true);
    expect(supervisor.submitTeamDecision(runId, [])).toBe(false);

    await waitForTerminal(supervisor, runId);
  });

  it('cancels a parked run cleanly and leaves nothing pending for a later decision to resolve', async () => {
    // DEFECT THIS PREVENTS: without an abort listener inside
    // `awaitTeamApproval`, cancelling a run parked here would call
    // `entry.controller.abort()` and nothing downstream would ever notice —
    // the promise `executeRun` is awaiting would sit unsettled forever, the
    // background task would never reach its `finally`, and `pendingTeamApprovals`
    // would keep an entry alive for a run that no longer exists as far as the
    // rest of the supervisor is concerned.
    const { supervisor } = makeSupervisor();
    const runId = await supervisor.startRun({ task: 'Analyse the thing.', reviewTeam: true });
    await waitFor(async () => (await supervisor.getRunState(runId)).status === 'awaiting_approval', 'the run to park for team approval');

    expect(supervisor.cancelRun(runId)).toBe(true);

    const finished = await waitForTerminal(supervisor, runId);
    expect(finished.status).toBe('cancelled');
    // Nothing left to resolve: the abort already tore the pending entry down,
    // so a decision arriving late (a slow client, an in-flight request that
    // lost the race) is refused instead of reviving a run that is over.
    expect(supervisor.submitTeamDecision(runId, [])).toBe(false);
  });

  it('does not hang shutdown when a run is parked awaiting approval', async () => {
    // `shutdown()` awaits every in-flight background task. Before the abort
    // listener existed, a parked run's task would never settle, and this
    // `await supervisor.shutdown()` would hang for the lifetime of the test
    // process rather than failing fast with a useful message.
    const { supervisor } = makeSupervisor();
    const runId = await supervisor.startRun({ task: 'Analyse the thing.', reviewTeam: true });
    await waitFor(async () => (await supervisor.getRunState(runId)).status === 'awaiting_approval', 'the run to park for team approval');

    await supervisor.shutdown();

    expect(supervisor.liveRunIds()).toEqual([]);
    expect((await supervisor.getRunState(runId)).status).toBe('cancelled');
  });
});

describe('RunSupervisor.reconcileCrashedRuns — a live owner is not a corpse', () => {
  it('leaves a non-terminal run alone while the process that owns it is alive', async () => {
    // Reproduces a real incident. A UAT agent asked to exercise this app started
    // a second server against the same runs/ root; startup reconciliation swept
    // every non-terminal run it found, and four live assignments belonging to a
    // CLI run in another process were marked failed with "the server process
    // restarted while this run was in progress" — a restart that never happened,
    // reported about a run that was working.
    const registry = testRegistry();
    const store = new MemoryRunStore();
    const live = await store.createRun('a run owned by something still alive');
    live.status = 'running';
    // This test process is alive by definition, and `isOwnedByLiveProcess`
    // treats OUR pid as dead (a supervisor knows what it is executing), so the
    // owner has to be a different living process. The parent is the safest one
    // available: it is alive, it is not us, and it is not a pid we invented.
    live.ownerPid = process.ppid;
    await store.saveRun(live);

    const supervisor = new RunSupervisor({ registry, store, onWarning: () => undefined });
    const reconciled = await supervisor.reconcileCrashedRuns();

    expect(reconciled).not.toContain(live.id);
    expect((await store.loadRun(live.id)).status).toBe('running');
  });

  it('still reconciles a run whose owner is gone', async () => {
    const registry = testRegistry();
    const store = new MemoryRunStore();
    const dead = await store.createRun('a run whose process died');
    dead.status = 'running';
    // A pid that cannot be running: the kernel never allocates 0 as a user
    // process, and Node rejects it as a target, which lands in the same
    // "not alive" branch a genuinely exited pid does.
    dead.ownerPid = 999_999_999;
    await store.saveRun(dead);

    const supervisor = new RunSupervisor({ registry, store, onWarning: () => undefined });
    const reconciled = await supervisor.reconcileCrashedRuns();

    expect(reconciled).toContain(dead.id);
    expect((await store.loadRun(dead.id)).status).toBe('failed');
  });

  it('reconciles a run with no owner recorded, exactly as before the field existed', async () => {
    // Every run written before `ownerPid` — unknown must keep meaning what it
    // meant, or this fix would quietly strand every historical crashed run.
    const registry = testRegistry();
    const store = new MemoryRunStore();
    const old = await store.createRun('a run from before ownership was recorded');
    old.status = 'running';
    await store.saveRun(old);

    const supervisor = new RunSupervisor({ registry, store, onWarning: () => undefined });

    expect(await supervisor.reconcileCrashedRuns()).toContain(old.id);
  });
});

describe('RunSupervisor.reconcileCrashedRuns (NFR-2, server restart)', () => {
  it('marks a run left non-terminal by a crash as failed, instead of leaving it running forever', async () => {
    const store = new MemoryRunStore();
    // The exact on-disk shape a crash leaves: `run.json` still says `running`,
    // with an assignment stuck at `working`, because the process died
    // mid-dispatch rather than failing cleanly through `setStatus`.
    const crashed = await store.createRun('a task interrupted by a crash');
    await store.saveRun({
      ...crashed,
      status: 'running',
      assignments: [
        {
          id: 'lead',
          phaseId: 'analysis',
          agentName: 'alpha',
          objective: 'do the work',
          deliverable: 'reports/01-alpha.md',
          dependsOn: [],
          status: 'working',
          attempts: 1,
          usage: { inputTokens: 0, outputTokens: 0 },
          startedAt: Date.now(),
        },
      ],
    });

    // A fresh supervisor, exactly as a restarted process constructs one: no
    // memory of the run above (its `entries` map starts empty), only the store
    // it shares with the process that crashed.
    const { supervisor } = makeSupervisor({}, store);

    // Before this fix, nothing ever called `store.listRuns()` here or in
    // `serve.ts`'s `main()`, so this run stayed `running` — on disk
    // indistinguishable from a run this process is genuinely executing.
    const reconciled = await supervisor.reconcileCrashedRuns();

    expect(reconciled).toEqual([crashed.id]);
    const after = await supervisor.getRunState(crashed.id);
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/restart/i);
    // Reconciling never adopts the run as this process's own: it was never
    // started here, so cancelling it must still read as "not executing in
    // this server process" rather than pretending a cancel actually happened.
    expect(supervisor.cancelRun(crashed.id)).toBe(false);
    expect(supervisor.liveRunIds()).not.toContain(crashed.id);
  });

  it('leaves finished runs alone', async () => {
    const store = new MemoryRunStore();
    const { supervisor } = makeSupervisor({}, store);
    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    const finished = await waitForTerminal(supervisor, runId);

    const restarted = new RunSupervisor({ registry: testRegistry(), store });
    const reconciled = await restarted.reconcileCrashedRuns();

    expect(reconciled).toEqual([]);
    expect((await store.loadRun(runId)).status).toBe(finished.status);
  });

  it('reports no runs to reconcile against an empty store', async () => {
    const { supervisor } = makeSupervisor();
    await expect(supervisor.reconcileCrashedRuns()).resolves.toEqual([]);
  });
});

describe('RunSupervisor failure containment', () => {
  it('survives a store that cannot persist, instead of taking the process down', async () => {
    // The background task is awaited by nobody, so an escaping rejection would
    // be an unhandled rejection â€” which ends the Node process and every other
    // run with it. This test would fail as an unhandled rejection, not an
    // assertion, if that containment were removed.
    const store = new MemoryRunStore();
    const failing: RunStore = {
      ...bindStore(store),
      saveRun: async (run: RunState) => {
        if (run.status !== 'queued') throw new Error('disk is on fire');
        return store.saveRun(run);
      },
    };

    const { supervisor, warnings } = makeSupervisor({}, failing);

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    await waitFor(() => !supervisor.isLive(runId), 'the run to stop executing');

    expect(warnings.some((message) => message.includes('outside the pipeline'))).toBe(true);
  });
});

/**
 * A `MemoryRunStore` extended with `assignmentWorkspaceDir`, the AO-8 method
 * `RunStore` deliberately does not declare (see `dispatcher.ts`'s
 * `hasPerAssignmentWorkspaces` and its own doc comment for why). Plain
 * `MemoryRunStore` has no reason to grow it — real `mkdir` calls against a
 * real path is exactly the disk I/O this store exists to avoid — so this is
 * the "small stub" the task description allows for testing the wrapper's
 * forwarding: least new machinery, no temp directory, no cleanup, and every
 * other `MemoryRunStore` behaviour (`saveRun`, `listRuns`, ...) is reused
 * untouched via `extends`.
 */
class StoreWithAssignmentWorkspaces extends MemoryRunStore {
  readonly calls: Array<{ runId: string; assignmentId: string; attempt: number; dir: string }> = [];

  async assignmentWorkspaceDir(runId: string, assignmentId: string, attempt: number): Promise<string> {
    // Mirrors FileRunStore's own per-assignment, per-attempt layout closely
    // enough to prove the point: one directory per assignment, so two
    // assignments in the same run never resolve to the same path.
    const dir = path.join(this.runDir(runId), 'workspace', assignmentId, `attempt-${attempt}`);
    this.calls.push({ runId, assignmentId, attempt, dir });
    return dir;
  }
}

describe('withCreateRunHook (AO-8)', () => {
  // `withCreateRunHook` is not part of the supervisor's public surface —
  // nothing outside this module calls it directly, `startRun` builds and uses
  // it internally. It is exported anyway, purely so this file can pin its
  // forwarding behaviour directly rather than only ever observing it through
  // a full `RunSupervisor.startRun` run. The last test in this block still
  // drives a real run end to end, because a direct test of the wrapper alone
  // would not catch a break in how `dispatcher.ts` actually reaches the
  // method through it.
  it('still exposes assignmentWorkspaceDir when the wrapped store has it, and forwards to the real store', async () => {
    const store = new StoreWithAssignmentWorkspaces();
    const wrapped = withCreateRunHook(store, () => undefined) as RunStore & {
      assignmentWorkspaceDir(runId: string, assignmentId: string, attempt: number): Promise<string>;
    };

    expect(typeof wrapped.assignmentWorkspaceDir).toBe('function');

    const dir = await wrapped.assignmentWorkspaceDir('run-1', 'assignment-1', 1);

    expect(dir).toBe(path.join(store.runDir('run-1'), 'workspace', 'assignment-1', 'attempt-1'));
    // Went through to the real store, once, with the exact arguments given to
    // the wrapper — not a detached copy or a no-op stand-in.
    expect(store.calls).toEqual([{ runId: 'run-1', assignmentId: 'assignment-1', attempt: 1, dir }]);
  });

  it('does not fabricate assignmentWorkspaceDir when the wrapped store lacks it, matching plain MemoryRunStore', () => {
    const store = new MemoryRunStore();
    const wrapped = withCreateRunHook(store, () => undefined) as RunStore & {
      assignmentWorkspaceDir?: unknown;
    };

    // `dispatcher.ts`'s `hasPerAssignmentWorkspaces` reads exactly this
    // property to decide whether to fall back to the run-level
    // `workspaceDir` — the wrapper must not accidentally invent the method
    // for a store that never had it.
    expect(wrapped.assignmentWorkspaceDir).toBeUndefined();
  });

  it('still calls onCreated exactly once with the created run and still returns it (hook behaviour unchanged)', async () => {
    const store = new MemoryRunStore();
    const created: RunState[] = [];
    const wrapped = withCreateRunHook(store, (run) => created.push(run));

    const run = await wrapped.createRun('a task');

    expect(created).toEqual([run]);
    expect(run.task).toBe('a task');
  });

  it('forwards a method the RunStore interface does not know about, guarding against a hand-enumerated literal creeping back in', () => {
    // DEFECT THIS PREVENTS: `withCreateRunHook` used to return a hand-written
    // object literal listing the twelve `RunStore` interface methods by name.
    // That literal type-checked fine against `RunStore` no matter what the
    // real store passed in also had, because a literal is checked against the
    // DECLARED type it is assigned to, not the concrete object's actual
    // shape — which is exactly how `assignmentWorkspaceDir` got silently
    // dropped. A store with some OTHER extra method the interface has never
    // heard of, and never will, is what actually proves the fix generalises:
    // nothing in the current implementation reads a fixed property list, so
    // this passes for any future addition, not merely the one AO-8 method
    // this file happens to already know the name of. If someone reintroduces
    // an enumerated literal, `wrapped.totallyUnrelatedFutureMethod` is simply
    // absent and calling it throws a `TypeError`, failing this test.
    class StoreWithSomeFutureMethod extends MemoryRunStore {
      probeCalls: number[] = [];
      totallyUnrelatedFutureMethod(x: number): number {
        this.probeCalls.push(x);
        return x * 2;
      }
    }

    const store = new StoreWithSomeFutureMethod();
    const wrapped = withCreateRunHook(store, () => undefined) as RunStore & {
      totallyUnrelatedFutureMethod(x: number): number;
    };

    expect(wrapped.totallyUnrelatedFutureMethod(21)).toBe(42);
    // Ran against the real store, not a detached copy of its state — proof
    // `this` stayed bound to `store` rather than to the wrapper object.
    expect(store.probeCalls).toEqual([21]);
  });

  it('resolves different assignment workspace directories for two assignments in the same run, started through RunSupervisor (end to end)', async () => {
    // THE PROPERTY THAT ACTUALLY MATTERS: not that `withCreateRunHook`
    // forwards the method in isolation, but that a run started the way
    // `POST /api/runs` starts one — through `RunSupervisor.startRun`, which
    // wraps `deps.store` in `withCreateRunHook` before handing it to
    // `executeRun` — reaches `assignmentWorkspaceDir` on the real store for
    // each assignment separately. `TEST_PLAN`'s review phase runs `review-1`
    // and `review-2` in parallel, both depending on `lead`, which is exactly
    // the AO-8 case two assignments have something to collide over.
    const store = new StoreWithAssignmentWorkspaces();
    const { supervisor } = makeSupervisor({}, store);

    const runId = await supervisor.startRun({ task: 'Analyse the thing.' });
    const finished = await waitForTerminal(supervisor, runId);

    expect(finished.status).toBe('done');

    const byAssignment = new Map(store.calls.map((call) => [call.assignmentId, call]));
    const lead = byAssignment.get('lead');
    const review1 = byAssignment.get('review-1');
    const review2 = byAssignment.get('review-2');

    // If the old bug were back, `hasPerAssignmentWorkspaces` would see no
    // `assignmentWorkspaceDir` on the wrapped store, `store.calls` would stay
    // empty, and every one of these would be `undefined` — failing loudly
    // rather than quietly passing on a comparison between two `undefined`s.
    expect(lead).toBeDefined();
    expect(review1).toBeDefined();
    expect(review2).toBeDefined();
    expect(review1?.dir).not.toBe(review2?.dir);
    expect(review1?.dir).not.toBe(lead?.dir);
    expect(review1?.runId).toBe(runId);
    expect(review2?.runId).toBe(runId);
  });
});

/**
 * The constructor forwards every optional dep, not a hand-picked subset.
 *
 * These exist because `RunSupervisor`'s constructor built `this.deps` as an
 * enumerated literal that was three keys short: `diagnostics`, `getRegistry`
 * and `produceDeliverable` were declared, documented, passed by `serve.ts`, and
 * read later in the same file — but never copied in, so every read got
 * `undefined` for the life of the process.
 *
 * The reason no existing test caught it is worth stating, because it decides the
 * shape of these three. All three deps are OPTIONAL and every read site handles
 * the absent case gracefully, so the bug produced no error anywhere — it made
 * three features silently do nothing. A test that constructs a supervisor and
 * checks it still works therefore passes either way. The only assertion that can
 * fail is one that watches for the dep's OBSERVABLE EFFECT, which is what each
 * of these does: a record in the log, a fresh agent name in the plan, a call on
 * the injected double.
 *
 * They are deliberately three separate tests rather than one construction check
 * with three `expect`s on a private field. `this.deps` is private and reaching
 * into it would assert the fix's current implementation (a spread) rather than
 * the behaviour anyone depends on; a later refactor back to an enumerated
 * literal that happened to list all four keys would be equally correct and
 * should not fail.
 */
describe('RunSupervisor constructor forwarding', () => {
  it(
    'forwards `diagnostics`, so a non-fatal provider warning reaches the cross-run log',
    async () => {
      const records: Array<{ kind: string; message: string }> = [];
      const supervisor = new RunSupervisor({
        registry: testRegistry(),
        store: new MemoryRunStore(),
        makeProvider: testProviderFactory({
          lead: {
            warnWith: 'tool "Bash" was not granted: scripted for this test',
            text: ['## Findings', '', 'Scripted.'].join('\n'),
          },
        }),
        produceDeliverable: stubDeliverable(),
        // An array-backed sink rather than the real `DiagnosticsLog`: this is
        // about whether the supervisor HANDS the dep down, and a temp directory
        // would add a filesystem to a question that has nothing to do with one.
        diagnostics: {
          record: async (input) => {
            records.push({ kind: input.kind, message: input.message });
            return undefined;
          },
        },
      });

      const runId = await supervisor.startRun({ task: 'forwarding check: diagnostics' });
      await waitForTerminal(supervisor, runId);

      // The event itself must have been emitted, or this test would pass for the
      // wrong reason on a day `warnWith` stops working.
      const snapshot = await supervisor.snapshot(runId);
      const nonFatal = snapshot.events.filter(
        (logged) => logged.event.t === 'error' && logged.event.fatal === false,
      );
      expect(nonFatal).toHaveLength(1);

      expect(records.map((record) => record.kind)).toContain('tool-denied');
    },
    SLOW_RUN_TIMEOUT_MS,
  );

  it(
    'forwards `getRegistry`, so a run started after a catalog edit sees the edit (FR-R5)',
    async () => {
      const initial = testRegistry();
      // The post-edit catalog: everything the startup one had, plus an agent
      // that did not exist when the supervisor was constructed. This is what
      // editing a file under `categories/` and letting the watcher reload looks
      // like from the supervisor's side.
      const added: AgentDef = {
        ...initial.agents[0]!,
        name: 'added-after-construction',
        description: 'Exists only in the post-edit catalog.',
      };
      const edited = buildRegistry([...initial.agents, added]);

      // A plan that names ONLY the new agent, so the run cannot complete unless
      // the fresh catalog is the one dispatch resolves against. Asserting on
      // `knownAgentNames` instead would have proved nothing: that set is built
      // once in the constructor from `deps.registry` and is only ever read by
      // the scripted provider's fake planner, so it is stale by design and
      // stays stale with or without this fix.
      const plan = {
        summary: 'One assignment, one agent, added after construction.',
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
                agentName: added.name,
                objective: 'Produce the primary analysis.',
                deliverable: 'reports/01-added.md',
                dependsOn: [],
              },
            ],
          },
        ],
      };

      const supervisor = new RunSupervisor({
        registry: initial,
        getRegistry: () => edited,
        store: new MemoryRunStore(),
        makeProvider: testProviderFactory({
          [MANAGER_PLAN_ASSIGNMENT_ID]: {
            text: JSON.stringify(plan),
            usage: { inputTokens: 120, outputTokens: 40 },
          },
        }),
        produceDeliverable: stubDeliverable(),
      });

      const runId = await supervisor.startRun({ task: 'forwarding check: getRegistry' });
      const final = await waitForTerminal(supervisor, runId);

      // With `getRegistry` dropped, planning validates the proposed team against
      // the startup catalog, `added-after-construction` is not in it, and the run
      // never reaches dispatch at all.
      expect(final.status).toBe('done');
      expect(final.assignments.map((assignment) => assignment.agentName)).toEqual([added.name]);
    },
    SLOW_RUN_TIMEOUT_MS,
  );

  it(
    'forwards `produceDeliverable`, so an injected double is the one that runs',
    async () => {
      let calls = 0;
      const real = stubDeliverable();
      const supervisor = new RunSupervisor({
        registry: testRegistry(),
        store: new MemoryRunStore(),
        makeProvider: testProviderFactory(),
        produceDeliverable: (async (...args: Parameters<typeof real>) => {
          calls += 1;
          return real(...args);
        }) as typeof real,
      });

      const runId = await supervisor.startRun({ task: 'forwarding check: produceDeliverable' });
      await waitForTerminal(supervisor, runId);

      // Zero here is the old bug exactly: `runner.ts` falls back to the real
      // renderer when the override is absent, so the run still finished and the
      // only visible difference was that the double was never consulted.
      expect(calls).toBeGreaterThan(0);
    },
    SLOW_RUN_TIMEOUT_MS,
  );
});

/** Re-bind a store's methods so they survive being spread into an object literal. */
function bindStore(store: RunStore): RunStore {
  return {
    createRun: (task) => store.createRun(task),
    loadRun: (runId) => store.loadRun(runId),
    saveRun: (run) => store.saveRun(run),
    listRuns: () => store.listRuns(),
    runDir: (runId) => store.runDir(runId),
    workspaceDir: (runId) => store.workspaceDir(runId),
    writeReport: (runId, relativePath, content) => store.writeReport(runId, relativePath, content),
    readReport: (runId, relativePath) => store.readReport(runId, relativePath),
    readBinary: (runId, relativePath) => store.readBinary(runId, relativePath),
    appendEvent: (runId, assignmentId, event) => store.appendEvent(runId, assignmentId, event),
    readEvents: (runId, assignmentId) => store.readEvents(runId, assignmentId),
  };
}
