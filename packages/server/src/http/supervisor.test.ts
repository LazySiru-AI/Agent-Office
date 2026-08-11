import { describe, expect, it, vi } from 'vitest';
import {
  EVENT_BUFFER_LIMIT,
  type RunState,
  type ServerMessage,
} from '@agent-office/shared';
import { MemoryRunStore } from '../store/memoryStore.js';
import type { RunStore } from '../store/types.js';
import { RingBuffer, RunSupervisor } from './supervisor.js';
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
vi.setConfig({ testTimeout: SLOW_RUN_TIMEOUT_MS });
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
