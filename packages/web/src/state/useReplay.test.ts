import { describe, expect, it } from 'vitest';
import type { AgentEvent, AssignmentState, LoggedAgentEvent, RunState } from '@agent-office/shared';
import {
  advancePositionMs,
  buildTimelineMapping,
  createManualClock,
  foldEvents,
  resetAssignmentsForReplay,
  type ManualReplayClock,
} from './useReplay.js';

/**
 * `foldEvents` is the heart of NFR-7 replay (see the design notes atop
 * `useReplay.ts`): everything here tests it, `buildTimelineMapping` (idle-gap
 * compression, also NFR-7) and the injectable clock (`createManualClock`) as
 * plain functions, with no React render involved — this file runs in Node
 * with no DOM, per the task constraints, so hook-level behaviour is exercised
 * only through the pure primitives the hook is built from.
 */

function assignment(id: string, dependsOn: string[] = []): AssignmentState {
  return {
    id,
    phaseId: 'phase-1',
    agentName: `agent-${id}`,
    objective: 'do the thing',
    deliverable: `reports/${id}.md`,
    dependsOn,
    status: 'pending',
    attempts: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function baseRun(assignments: AssignmentState[]): RunState {
  return {
    id: 'run-1',
    task: 'a test task',
    status: 'running',
    createdAt: 0,
    updatedAt: 0,
    assignments,
  };
}

function logged(ts: number, event: AgentEvent): LoggedAgentEvent {
  return { ts, event };
}

function statusEvent(ts: number, assignmentId: string, status: AssignmentState['status']): LoggedAgentEvent {
  return logged(ts, { t: 'status', assignmentId, status });
}

function usageEvent(ts: number, assignmentId: string, inputTokens: number, outputTokens: number): LoggedAgentEvent {
  return logged(ts, { t: 'usage', assignmentId, inputTokens, outputTokens });
}

describe('foldEvents (NFR-7 replay, NFR-5 cost mid-replay)', () => {
  it('reproduces the expected assignment statuses at several points in time', () => {
    const run = baseRun([assignment('a1'), assignment('a2', ['a1'])]);
    const events: LoggedAgentEvent[] = [
      statusEvent(100, 'a1', 'briefing'),
      statusEvent(200, 'a1', 'working'),
      statusEvent(300, 'a1', 'reporting'),
      statusEvent(400, 'a1', 'done'),
      statusEvent(450, 'a2', 'briefing'),
    ];

    expect(foldEvents(run, events, 0).assignments.map((a) => a.status)).toEqual(['pending', 'pending']);
    expect(foldEvents(run, events, 150).assignments.map((a) => a.status)).toEqual(['briefing', 'pending']);
    expect(foldEvents(run, events, 250).assignments.map((a) => a.status)).toEqual(['working', 'pending']);
    expect(foldEvents(run, events, 400).assignments.map((a) => a.status)).toEqual(['done', 'pending']);
    expect(foldEvents(run, events, 1000).assignments.map((a) => a.status)).toEqual(['done', 'briefing']);
  });

  it('sets startedAt/endedAt from the first non-pending and first terminal status event', () => {
    const run = baseRun([assignment('a1')]);
    // A legal full path (pending -> briefing -> working -> reporting -> done)
    // — see the "impossible transition" tests below for why a shortcut like
    // `briefing -> done` no longer stands in for one, now that the fold
    // checks `canTransitionAssignment`.
    const events = [
      statusEvent(100, 'a1', 'briefing'),
      statusEvent(150, 'a1', 'working'),
      statusEvent(180, 'a1', 'reporting'),
      statusEvent(400, 'a1', 'done'),
    ];

    const result = foldEvents(run, events, 1000);
    const a1 = result.assignments[0];
    expect(a1?.startedAt).toBe(100);
    expect(a1?.endedAt).toBe(400);
  });

  it('approximates reportPath from `deliverable` when status becomes done, per dispatcher.ts (documented approximation)', () => {
    const run = baseRun([assignment('a1')]);
    // Legal path to `done` — see the note on the previous test.
    const events = [
      statusEvent(50, 'a1', 'briefing'),
      statusEvent(70, 'a1', 'working'),
      statusEvent(90, 'a1', 'reporting'),
      statusEvent(100, 'a1', 'done'),
    ];
    const result = foldEvents(run, events, 100);
    expect(result.assignments[0]?.reportPath).toBe('reports/a1.md');
  });

  it('accumulates usage mid-replay, not only at the end (NFR-5)', () => {
    const run = baseRun([assignment('a1')]);
    const events: LoggedAgentEvent[] = [
      usageEvent(150, 'a1', 10, 5),
      usageEvent(250, 'a1', 20, 7),
      usageEvent(350, 'a1', 1, 1),
    ];

    expect(foldEvents(run, events, 0).assignments[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(foldEvents(run, events, 150).assignments[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(foldEvents(run, events, 200).assignments[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(foldEvents(run, events, 300).assignments[0]?.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
    expect(foldEvents(run, events, 999).assignments[0]?.usage).toEqual({ inputTokens: 31, outputTokens: 13 });
  });

  it('seeking backwards gives exactly the same state as playing forward to that point', () => {
    const run = baseRun([assignment('a1'), assignment('a2')]);
    const events: LoggedAgentEvent[] = [
      statusEvent(100, 'a1', 'briefing'),
      usageEvent(150, 'a1', 40, 12),
      statusEvent(200, 'a1', 'working'),
      statusEvent(220, 'a2', 'briefing'),
      usageEvent(300, 'a1', 100, 30),
      statusEvent(400, 'a1', 'reporting'),
      statusEvent(500, 'a1', 'done'),
    ];

    // "Play forward" to an early point, capture it, then keep playing to the
    // end, then "seek back" to the same early point. Because foldEvents is a
    // pure function of (base, events, atTs) with no incremental/cached state,
    // this must reproduce the exact same RunState — that purity is the whole
    // design decision documented in useReplay.ts under "Seeking backwards".
    const midPoint = 250;
    const forward = foldEvents(run, events, midPoint);
    const atEnd = foldEvents(run, events, 999);
    const seekedBack = foldEvents(run, events, midPoint);

    expect(seekedBack).toEqual(forward);
    expect(atEnd).not.toEqual(forward); // sanity: the end really is a different state

    // The base RunState passed in must never be mutated by any of these calls
    // — each fold resets from it independently.
    expect(run.assignments[0]?.status).toBe('pending');
    expect(run.assignments[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('yields the base run unchanged for an empty event list', () => {
    const run = baseRun([assignment('a1'), assignment('a2', ['a1'])]);
    expect(foldEvents(run, [], 0)).toEqual(run);
    expect(foldEvents(run, [], 999_999)).toEqual(run);
    // Directly against the documented reset primitive too.
    expect(foldEvents(run, [], 0)).toEqual(resetAssignmentsForReplay(run));
  });

  it('is not corrupted by out-of-order or duplicate-timestamp events', () => {
    const run = baseRun([assignment('a1')]);
    // A legal path to `done` (see the "impossible transition" tests below) —
    // the duplicate-ts pairs are what this test is actually about.
    const sorted: LoggedAgentEvent[] = [
      statusEvent(100, 'a1', 'briefing'),
      usageEvent(100, 'a1', 5, 1), // duplicate ts with the event above
      statusEvent(200, 'a1', 'working'),
      usageEvent(200, 'a1', 5, 1), // duplicate ts again
      statusEvent(250, 'a1', 'reporting'),
      statusEvent(300, 'a1', 'done'),
    ];
    const shuffled = [sorted[5], sorted[1], sorted[3], sorted[0], sorted[4], sorted[2]].filter(
      (e): e is LoggedAgentEvent => e !== undefined,
    );

    const fromSorted = foldEvents(run, sorted, 999);
    const fromShuffled = foldEvents(run, shuffled, 999);
    expect(fromShuffled).toEqual(fromSorted);
    expect(fromSorted.assignments[0]?.status).toBe('done');
    expect(fromSorted.assignments[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('does not double-count usage when the exact same logged entry appears twice (duplicate log line)', () => {
    // A crash mid-append (or a retry) can leave the same `{ts, event}` JSON
    // written twice into the `.jsonl` log. Feeding foldEvents that literal
    // duplicate must not double the token count it folds into NFR-5's cost
    // figure — see the file header's "Duplicate log lines" note.
    const run = baseRun([assignment('a1')]);
    const line = usageEvent(100, 'a1', 100, 50);
    const events: LoggedAgentEvent[] = [line, { ...line, event: { ...line.event } }];

    const result = foldEvents(run, events, 999);
    expect(result.assignments[0]?.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('also collapses two separately-emitted usage events that happen to be byte-identical (the accepted trade-off of exact-entry dedupe)', () => {
    // This pins the known limitation documented in the file header: because
    // there is no idempotency key to tell "the same line, twice" apart from
    // "two different emissions that happen to match", a genuinely legitimate
    // repeat (same assignment, same millisecond, same token counts) is
    // indistinguishable from a duplicated log line and gets collapsed too.
    // A value-based fold would total 20/10 here; exact-entry dedupe totals
    // 10/5. If this assertion ever needs to change, the trade-off note in
    // useReplay.ts needs to change with it, not just this test.
    const run = baseRun([assignment('a1')]);
    const events: LoggedAgentEvent[] = [usageEvent(100, 'a1', 10, 5), usageEvent(100, 'a1', 10, 5)];

    const result = foldEvents(run, events, 999);
    expect(result.assignments[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('ignores a status transition impossible per canTransitionAssignment, rather than applying it blindly', () => {
    // `done -> working` is not in shared/src/status.ts's transition table
    // (only `done -> briefing`, the FR-M10 revision edge, is). Before this
    // guard, the fold applied it anyway: status flipped to 'working' while
    // `endedAt` — set once, by design, on the first terminal status — was
    // never cleared, producing a `{status: 'working', endedAt: <set>}`
    // combination the live orchestrator can never emit.
    const run = baseRun([assignment('a1')]);
    const events: LoggedAgentEvent[] = [
      statusEvent(50, 'a1', 'briefing'),
      statusEvent(70, 'a1', 'working'),
      statusEvent(90, 'a1', 'reporting'),
      statusEvent(100, 'a1', 'done'),
      statusEvent(200, 'a1', 'working'), // impossible: canTransitionAssignment('done', 'working') is false
    ];

    const result = foldEvents(run, events, 999);
    const a1 = result.assignments[0];
    expect(a1?.status).toBe('done'); // the illegal entry is dropped; last known-good status holds
    expect(a1?.endedAt).toBe(100); // stays coherent with a terminal status, not left dangling
  });

  it('still applies the FR-M10 revision edge (done -> briefing), the one legal escape from a terminal status', () => {
    // Guards against the transition check above becoming too strict and
    // rejecting the one edge shared/src/status.ts explicitly permits.
    const run = baseRun([assignment('a1')]);
    const events: LoggedAgentEvent[] = [
      statusEvent(50, 'a1', 'briefing'),
      statusEvent(70, 'a1', 'working'),
      statusEvent(90, 'a1', 'reporting'),
      statusEvent(100, 'a1', 'done'),
      statusEvent(200, 'a1', 'briefing'), // legal: canTransitionAssignment('done', 'briefing') is true
    ];

    const result = foldEvents(run, events, 999);
    expect(result.assignments[0]?.status).toBe('briefing');
  });

  it('ignores events referencing an unknown assignment id rather than throwing', () => {
    const run = baseRun([assignment('a1')]);
    const events: LoggedAgentEvent[] = [
      statusEvent(100, 'ghost-assignment', 'working'),
      usageEvent(100, 'ghost-assignment', 999, 999),
      // pending -> briefing: a legal transition, so this test exercises only
      // the unknown-id branch, not the transition-legality guard tested
      // separately below.
      statusEvent(200, 'a1', 'briefing'),
    ];

    expect(() => foldEvents(run, events, 999)).not.toThrow();
    const result = foldEvents(run, events, 999);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.status).toBe('briefing');
    expect(result.assignments[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('records error text only from a preceding fatal error event, per the documented approximation', () => {
    const run = baseRun([assignment('a1')]);
    const withFatal: LoggedAgentEvent[] = [
      logged(100, { t: 'error', assignmentId: 'a1', message: 'boom', fatal: true }),
      statusEvent(200, 'a1', 'failed'),
    ];
    const withoutFatal: LoggedAgentEvent[] = [statusEvent(200, 'a1', 'failed')];
    const withNonFatal: LoggedAgentEvent[] = [
      logged(100, { t: 'error', assignmentId: 'a1', message: 'recoverable hiccup', fatal: false }),
      statusEvent(200, 'a1', 'failed'),
    ];

    expect(foldEvents(run, withFatal, 999).assignments[0]?.error).toBe('boom');
    expect(foldEvents(run, withoutFatal, 999).assignments[0]?.error).toBeUndefined();
    expect(foldEvents(run, withNonFatal, 999).assignments[0]?.error).toBeUndefined();
  });
});

describe('resetAssignmentsForReplay', () => {
  it('keeps static plan fields and clears event-derived fields', () => {
    const finished: AssignmentState = {
      ...assignment('a1'),
      status: 'done',
      attempts: 2,
      usage: { inputTokens: 500, outputTokens: 200 },
      startedAt: 10,
      endedAt: 20,
      reportPath: 'reports/a1.md',
      error: undefined,
    };
    const run = baseRun([finished]);
    const result = resetAssignmentsForReplay(run).assignments[0];

    expect(result?.id).toBe('a1');
    expect(result?.agentName).toBe('agent-a1');
    expect(result?.deliverable).toBe('reports/a1.md');
    expect(result?.dependsOn).toEqual([]);
    // attempts cannot be derived from the event contract (no AgentEvent
    // carries it) — documented in useReplay.ts as an intentional non-reset.
    expect(result?.attempts).toBe(2);

    expect(result?.status).toBe('pending');
    expect(result?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result?.startedAt).toBeUndefined();
    expect(result?.endedAt).toBeUndefined();
    expect(result?.reportPath).toBeUndefined();
  });
});

describe('buildTimelineMapping (idle-gap compression)', () => {
  it('caps a long idle gap at maxGapMs on the playback clock', () => {
    const events: LoggedAgentEvent[] = [
      statusEvent(0, 'a1', 'briefing'),
      statusEvent(60_000, 'a1', 'working'), // a real 60s gap
    ];
    const timeline = buildTimelineMapping(events, 5_000);

    // Without compression this would be 60_000; with a 5s cap it is 5_000.
    expect(timeline.durationMs).toBe(5_000);
  });

  it('does not compress gaps shorter than maxGapMs', () => {
    const events: LoggedAgentEvent[] = [statusEvent(0, 'a1', 'briefing'), statusEvent(2_000, 'a1', 'working')];
    const timeline = buildTimelineMapping(events, 5_000);
    expect(timeline.durationMs).toBe(2_000);
  });

  it('maps a playback position back to the real timestamp of the last event reached', () => {
    const events: LoggedAgentEvent[] = [
      statusEvent(1_000, 'a1', 'briefing'),
      statusEvent(61_000, 'a1', 'working'), // 60s real gap, capped to 5s playback
      statusEvent(62_000, 'a1', 'done'), // 1s real gap, uncompressed
    ];
    const timeline = buildTimelineMapping(events, 5_000);

    expect(timeline.realTsAt(0)).toBe(1_000); // before playback starts moving past event 0
    expect(timeline.realTsAt(4_999)).toBe(1_000); // still inside the compressed gap: event 1 hasn't happened yet
    expect(timeline.realTsAt(5_000)).toBe(61_000); // compressed gap fully elapsed: event 1 has happened
    expect(timeline.realTsAt(6_000)).toBe(62_000); // the uncompressed 1s gap plays out normally
    expect(timeline.durationMs).toBe(6_000);
  });

  it('is zero-duration for zero or one events, and never throws', () => {
    expect(buildTimelineMapping([]).durationMs).toBe(0);
    expect(buildTimelineMapping([]).realTsAt(500)).toBe(0);
    expect(buildTimelineMapping([statusEvent(42, 'a1', 'briefing')]).durationMs).toBe(0);
  });
});

describe('advancePositionMs', () => {
  it('advances by delta * speed, clamped to [0, durationMs]', () => {
    expect(advancePositionMs(0, 100, 1, 1_000)).toBe(100);
    expect(advancePositionMs(0, 100, 4, 1_000)).toBe(400);
    expect(advancePositionMs(0, 100, 0.25, 1_000)).toBe(25);
    expect(advancePositionMs(950, 100, 1, 1_000)).toBe(1_000); // clamps at the end
    expect(advancePositionMs(5, -10, 1, 1_000)).toBe(5); // non-positive delta is a no-op, clamped
  });
});

describe('createManualClock (the injectable test clock)', () => {
  it('drives a scheduled callback synchronously via tick(), with no real waiting', () => {
    const clock: ManualReplayClock = createManualClock(0);
    const seen: number[] = [];

    clock.schedule((nowMs) => seen.push(nowMs));
    expect(seen).toEqual([]); // nothing fires until tick() is called

    clock.tick(16);
    expect(seen).toEqual([16]);

    // Re-schedule after the first tick, matching how the playback loop
    // chains frames (schedule -> tick -> schedule again).
    clock.schedule((nowMs) => seen.push(nowMs));
    clock.tick(16);
    expect(seen).toEqual([16, 32]);
  });

  it('does not fire a cancelled callback', () => {
    const clock = createManualClock();
    const seen: number[] = [];
    const handle = clock.schedule(() => seen.push(1));
    clock.cancel(handle);
    clock.tick(1_000);
    expect(seen).toEqual([]);
  });

  it('now() reflects only elapsed tick() time', () => {
    const clock = createManualClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.tick(500);
    expect(clock.now()).toBe(1_500);
  });
});
