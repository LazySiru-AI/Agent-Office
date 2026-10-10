import { describe, expect, it } from 'vitest';
import type { RunState, RunSummary, ServerMessage } from '@agent-office/shared';
import {
  applyServerMessage,
  INITIAL_SESSION_STATE,
  MAX_CLIENT_EVENTS,
  MAX_CLIENT_LOGS,
  selectionReset,
  type RunSessionState,
} from './useRun.js';

/**
 * `applyServerMessage` is the whole transition table `useAgentOffice` is
 * built from (see the file header in `useRun.ts` for why it is a pure fold
 * rather than a `useEffect` closure calling several `useState` setters). It
 * is exercised here as a plain function — no render, no DOM, matching this
 * package's Node-only test convention (`useReplay.test.ts`,
 * `useSettings.test.ts`) — which is also the only way to pin down the two
 * behaviours the task called out as easy to get wrong silently: a `snapshot`
 * arriving after live `event`s must replace history wholesale rather than
 * append to it, and a `truncated: true` snapshot must actually be reflected.
 */

function run(id: string, status: RunState['status'] = 'running'): RunState {
  return { id, task: 'a test task', status, createdAt: 0, updatedAt: 0, assignments: [] };
}

function summary(id: string): RunSummary {
  return { id, task: 'a test task', status: 'running', createdAt: 0, updatedAt: 0, live: true };
}

describe('applyServerMessage — hello and pong are no-ops', () => {
  it('returns the state unchanged for hello (liveRunIds is not surfaced yet)', () => {
    const msg: ServerMessage = { t: 'hello', serverTime: 0, liveRunIds: ['run-1'] };
    expect(applyServerMessage(INITIAL_SESSION_STATE, msg, undefined)).toEqual(INITIAL_SESSION_STATE);
  });

  it('returns the state unchanged for pong', () => {
    const msg: ServerMessage = { t: 'pong' };
    expect(applyServerMessage(INITIAL_SESSION_STATE, msg, 'run-1')).toEqual(INITIAL_SESSION_STATE);
  });
});

describe('applyServerMessage — snapshot (NFR-2 reattach)', () => {
  it('replaces run, events, live and truncated wholesale for the subscribed run', () => {
    const r = run('run-1');
    const msg: ServerMessage = {
      t: 'snapshot',
      run: r,
      events: [{ ts: 100, event: { t: 'status', assignmentId: 'a1', status: 'working' } }],
      live: true,
      truncated: false,
    };

    const result = applyServerMessage(INITIAL_SESSION_STATE, msg, 'run-1');
    expect(result.run).toEqual(r);
    expect(result.events).toEqual(msg.events);
    expect(result.live).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('replaces (does not append to) events already accumulated from live event messages — the ordering defect this must not regress', () => {
    // Sequence that matters: live events arrive first (e.g. from a socket
    // subscribed before this snapshot's request resolved), *then* the
    // snapshot for a fresh reattach arrives. wire.ts is explicit that
    // snapshot/state are full replacements, never merged — appending here
    // would duplicate history on every reconnect, defeating NFR-2.
    const liveEvent: ServerMessage = {
      t: 'event',
      runId: 'run-1',
      event: { ts: 50, event: { t: 'status', assignmentId: 'a1', status: 'briefing' } },
    };
    const afterLive = applyServerMessage(INITIAL_SESSION_STATE, liveEvent, 'run-1');
    expect(afterLive.events).toHaveLength(1);

    const snapshotEvents = [{ ts: 200, event: { t: 'status', assignmentId: 'a1', status: 'working' } } as const];
    const snapshotMsg: ServerMessage = { t: 'snapshot', run: run('run-1'), events: snapshotEvents, live: true, truncated: false };
    const afterSnapshot = applyServerMessage(afterLive, snapshotMsg, 'run-1');

    expect(afterSnapshot.events).toEqual(snapshotEvents); // exactly the snapshot's events, not [liveEvent, ...snapshotEvents]
    expect(afterSnapshot.events).toHaveLength(1);
  });

  it('reflects truncated: true on the resulting state (server buffer had already dropped older history)', () => {
    const msg: ServerMessage = { t: 'snapshot', run: run('run-1'), events: [], live: true, truncated: true };
    const result = applyServerMessage(INITIAL_SESSION_STATE, msg, 'run-1');
    expect(result.truncated).toBe(true);
  });

  it('clears logs on a snapshot, since the wire carries no log-line history in it', () => {
    const withLogs: RunSessionState = { ...INITIAL_SESSION_STATE, logs: [{ ts: 1, line: 'hello' }] };
    const msg: ServerMessage = { t: 'snapshot', run: run('run-1'), events: [], live: true, truncated: false };
    expect(applyServerMessage(withLogs, msg, 'run-1').logs).toEqual([]);
  });

  it('ignores a snapshot for a run other than the currently-selected one (a stale reply)', () => {
    const msg: ServerMessage = { t: 'snapshot', run: run('run-2'), events: [], live: true, truncated: true };
    const result = applyServerMessage(INITIAL_SESSION_STATE, msg, 'run-1');
    expect(result).toEqual(INITIAL_SESSION_STATE);
  });
});

describe('applyServerMessage — state (full RunState replacement)', () => {
  it('replaces run and derives live from isRunTerminal', () => {
    const running = applyServerMessage(INITIAL_SESSION_STATE, { t: 'state', run: run('run-1', 'running') }, 'run-1');
    expect(running.live).toBe(true);

    const done = applyServerMessage(INITIAL_SESSION_STATE, { t: 'state', run: run('run-1', 'done') }, 'run-1');
    expect(done.live).toBe(false);

    const cancelled = applyServerMessage(INITIAL_SESSION_STATE, { t: 'state', run: run('run-1', 'cancelled') }, 'run-1');
    expect(cancelled.live).toBe(false);
  });

  it('ignores a state update for a run other than the currently-selected one', () => {
    const result = applyServerMessage(INITIAL_SESSION_STATE, { t: 'state', run: run('run-2') }, 'run-1');
    expect(result).toEqual(INITIAL_SESSION_STATE);
  });
});

describe('applyServerMessage — event and log are append-only deltas', () => {
  it('appends events in arrival order and ignores ones for a different run', () => {
    const first: ServerMessage = { t: 'event', runId: 'run-1', event: { ts: 1, event: { t: 'text', assignmentId: 'a1', chunk: 'a' } } };
    const second: ServerMessage = { t: 'event', runId: 'run-1', event: { ts: 2, event: { t: 'text', assignmentId: 'a1', chunk: 'b' } } };
    const foreign: ServerMessage = { t: 'event', runId: 'run-2', event: { ts: 3, event: { t: 'text', assignmentId: 'a1', chunk: 'c' } } };

    let state = INITIAL_SESSION_STATE;
    state = applyServerMessage(state, first, 'run-1');
    state = applyServerMessage(state, second, 'run-1');
    state = applyServerMessage(state, foreign, 'run-1');

    expect(state.events.map((e) => e.ts)).toEqual([1, 2]);
  });

  it('caps accumulated events at MAX_CLIENT_EVENTS, dropping the oldest first', () => {
    let state = INITIAL_SESSION_STATE;
    for (let i = 0; i < MAX_CLIENT_EVENTS + 5; i++) {
      state = applyServerMessage(
        state,
        { t: 'event', runId: 'run-1', event: { ts: i, event: { t: 'text', assignmentId: 'a1', chunk: String(i) } } },
        'run-1',
      );
    }
    expect(state.events).toHaveLength(MAX_CLIENT_EVENTS);
    expect(state.events[0]?.ts).toBe(5); // the first 5 were pushed out
    expect(state.events.at(-1)?.ts).toBe(MAX_CLIENT_EVENTS + 4);
  });

  it('appends log lines in order, scoped to the selected run', () => {
    let state = INITIAL_SESSION_STATE;
    state = applyServerMessage(state, { t: 'log', runId: 'run-1', line: 'first', ts: 1 }, 'run-1');
    state = applyServerMessage(state, { t: 'log', runId: 'run-2', line: 'ignored', ts: 2 }, 'run-1');
    state = applyServerMessage(state, { t: 'log', runId: 'run-1', line: 'second', ts: 3 }, 'run-1');
    expect(state.logs.map((l) => l.line)).toEqual(['first', 'second']);
  });

  it('caps accumulated log lines at MAX_CLIENT_LOGS', () => {
    let state = INITIAL_SESSION_STATE;
    for (let i = 0; i < MAX_CLIENT_LOGS + 3; i++) {
      state = applyServerMessage(state, { t: 'log', runId: 'run-1', line: String(i), ts: i }, 'run-1');
    }
    expect(state.logs).toHaveLength(MAX_CLIENT_LOGS);
    expect(state.logs[0]?.line).toBe('3');
  });
});

describe('applyServerMessage — runs (sidebar list), independent of selection', () => {
  it('replaces the run list regardless of which run is currently selected', () => {
    const msg: ServerMessage = { t: 'runs', runs: [summary('run-1'), summary('run-2')] };
    const result = applyServerMessage(INITIAL_SESSION_STATE, msg, 'some-other-run');
    expect(result.runs.map((r) => r.id)).toEqual(['run-1', 'run-2']);
  });
});

describe('applyServerMessage — error', () => {
  it('sets socketError for an error scoped to the selected run', () => {
    const result = applyServerMessage(INITIAL_SESSION_STATE, { t: 'error', message: 'boom', runId: 'run-1' }, 'run-1');
    expect(result.socketError).toBe('boom');
  });

  it('sets socketError for a global error with no runId, regardless of selection', () => {
    const result = applyServerMessage(INITIAL_SESSION_STATE, { t: 'error', message: 'transport lost' }, 'run-1');
    expect(result.socketError).toBe('transport lost');
  });

  it('ignores an error scoped to a different run than the one selected', () => {
    const result = applyServerMessage(INITIAL_SESSION_STATE, { t: 'error', message: 'boom', runId: 'run-2' }, 'run-1');
    expect(result.socketError).toBeUndefined();
  });
});

describe('selectionReset', () => {
  it('clears everything about the previously-selected run but keeps the sidebar run list', () => {
    const populated: RunSessionState = {
      run: run('run-1'),
      events: [{ ts: 1, event: { t: 'text', assignmentId: 'a1', chunk: 'x' } }],
      logs: [{ ts: 1, line: 'hi' }],
      live: true,
      truncated: true,
      runs: [summary('run-1'), summary('run-2')],
      socketError: 'previous error',
    };

    const result = selectionReset(populated);

    expect(result.run).toBeUndefined();
    expect(result.events).toEqual([]);
    expect(result.logs).toEqual([]);
    expect(result.live).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.socketError).toBeUndefined();
    expect(result.runs).toEqual(populated.runs); // survives — not scoped to any one selection
  });
});
