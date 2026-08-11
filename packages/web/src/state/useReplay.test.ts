import { describe, expect, it } from 'vitest';
import type { AgentDef, AgentEvent, AssignmentState, LoggedAgentEvent, RunPlan, RunState } from '@agent-office/shared';
import { RunPlanSchema } from '@agent-office/shared';
import {
  advancePositionMs,
  buildTimelineMapping,
  createManualClock,
  foldEvents,
  resetAssignmentsForReplay,
  type ManualReplayClock,
} from './useReplay.js';
// `@agent-office/server` is not in `web`'s declared dependencies — deliberately
// imported anyway, from a test file only, for the one thing this package
// cannot otherwise prove: that a real `dispatchRun` and this package's
// `foldEvents` agree, field for field, on the `RunState` a run ends up in.
// Confirmed before writing this: `npx tsc -p packages/web` type-checks this
// import cleanly (server's barrel re-exports plain data-shaped functions, no
// DOM/React leakage the other way), and it resolves at runtime the same way
// every workspace package does. The reverse import (server test -> web's
// `useReplay.ts`) does NOT type-check — `useReplay.ts` references `window`,
// which server's DOM-less `lib` cannot see — which is *why* this end-to-end
// proof lives here, in the web package's tests, and not in
// `dispatcher.test.ts`.
import {
  buildRegistry,
  dispatchRun,
  materialiseAssignments,
  MemoryRunStore,
  ScriptedProvider,
} from '@agent-office/server';

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

/**
 * A `status` event carrying the optional patch fields `setStatus`
 * (dispatcher.ts) now attaches — `reportPath`/`error`/`endedAt`/
 * `endedAtCleared`. Kept separate from {@link statusEvent} rather than adding
 * optional parameters to it: most tests want the bare, no-carried-fields
 * shape (which is also what every pre-existing `.jsonl` line looks like), and
 * conflating the two shapes at one call site would blur exactly the
 * old-log-vs-carried distinction these tests exist to pin.
 */
function carriedStatusEvent(
  ts: number,
  assignmentId: string,
  status: AssignmentState['status'],
  carried: Partial<Pick<Extract<AgentEvent, { t: 'status' }>, 'reportPath' | 'error' | 'endedAt' | 'endedAtCleared'>>,
): LoggedAgentEvent {
  return logged(ts, { t: 'status', assignmentId, status, ...carried });
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

  it('applies a carried reportPath and endedAt directly, not the deliverable/ts approximation', () => {
    // The point of carrying these on the event at all: the fold no longer has
    // to guess. `reportPath` is deliberately given a value that differs from
    // `assignment.deliverable` ('reports/a1.md') so this test fails loudly if
    // the code silently fell back to the old approximation instead of reading
    // the carried field; `endedAt` is likewise given a value that differs
    // from the event's own `ts`, for the same reason.
    const run = baseRun([assignment('a1')]);
    const events: LoggedAgentEvent[] = [
      statusEvent(50, 'a1', 'briefing'),
      statusEvent(70, 'a1', 'working'),
      statusEvent(90, 'a1', 'reporting'),
      carriedStatusEvent(150, 'a1', 'done', { reportPath: 'reports/a1-revised.md', endedAt: 999 }),
    ];

    const result = foldEvents(run, events, 999_999);
    const a1 = result.assignments[0];
    expect(a1?.reportPath).toBe('reports/a1-revised.md');
    expect(a1?.endedAt).toBe(999);
  });

  it('applies a carried error on a skipped status — a field the old approximation could never populate', () => {
    // Before events.ts carried `error`, the fold's only source for it was
    // "the most recent fatal `error` event", and the live dispatcher never
    // emits one for a skip (see `dispatchRun`'s dependenciesUnreachable loop
    // in dispatcher.ts) — so a replayed skip's reason was always lost. This
    // uses the dispatcher's own skip message shape as a realistic fixture.
    const run = baseRun([assignment('a1', ['dep-1'])]);
    const events: LoggedAgentEvent[] = [
      carriedStatusEvent(100, 'a1', 'skipped', {
        error: 'skipped: a dependency did not complete (dep-1)',
        endedAt: 100,
      }),
    ];

    const result = foldEvents(run, events, 999);
    const a1 = result.assignments[0];
    expect(a1?.status).toBe('skipped');
    expect(a1?.error).toBe('skipped: a dependency did not complete (dep-1)');
    expect(a1?.endedAt).toBe(100);
  });

  it('clears endedAt on the FR-M10 revision edge (endedAtCleared), instead of leaving the stale completion timestamp', () => {
    // The exact bug this schema change exists to fix: without
    // `endedAtCleared`, a revised assignment replayed as `briefing` sitting
    // next to the `endedAt` from its EARLIER completion — appearing to have
    // finished before it restarted.
    const run = baseRun([assignment('a1')]);
    const events: LoggedAgentEvent[] = [
      statusEvent(50, 'a1', 'briefing'),
      statusEvent(70, 'a1', 'working'),
      statusEvent(90, 'a1', 'reporting'),
      carriedStatusEvent(100, 'a1', 'done', { reportPath: 'reports/a1.md', endedAt: 100 }),
      // FR-M10 re-dispatch: done -> briefing, endedAt explicitly cleared.
      carriedStatusEvent(200, 'a1', 'briefing', { endedAtCleared: true }),
    ];

    const result = foldEvents(run, events, 999);
    const a1 = result.assignments[0];
    expect(a1?.status).toBe('briefing');
    expect(a1?.endedAt).toBeUndefined();
    // reportPath is untouched by the revision edge (the dispatcher never
    // clears it — only endedAt) — still holding the value from the earlier
    // completion until (in a real run) the second `done` overwrites it.
    expect(a1?.reportPath).toBe('reports/a1.md');
  });
});

/**
 * The end-to-end property GAP 1 exists to establish: a real `dispatchRun`
 * (packages/server) and this file's `foldEvents` must agree, field for
 * field, on the `RunState` a run ends up in. Everything above tests the fold
 * in isolation against hand-built events; this drives the actual
 * orchestrator, reads back the actual persisted `.jsonl` log through the
 * actual `RunStore` interface, and folds THAT — the same path a real replay
 * client takes. See the import comment at the top of this file for why this
 * lives here rather than in `dispatcher.test.ts`.
 */
describe('foldEvents replaying a real dispatchRun, field for field (NFR-7, FR-M10)', () => {
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

  /**
   * One phase produces a lead assignment and a doomed one; the second phase
   * has a dependent of the doomed one (forced to `skipped`) and a reviewer of
   * the lead (which requests one FR-M10 revision) — covering all three
   * scenarios the task calls out in a single run.
   */
  function plan(): RunPlan {
    return RunPlanSchema.parse({
      summary: 'Exercise a failure, a skip and a revision in one run.',
      domain: 'software',
      reportStyle: 'engineering',
      phases: [
        {
          id: 'first',
          name: 'First',
          parallel: true,
          assignments: [
            {
              id: 'lead',
              agentName: 'alpha',
              objective: 'Produce the lead work.',
              deliverable: 'reports/01-lead.md',
              dependsOn: [],
            },
            {
              id: 'flaky',
              agentName: 'beta',
              objective: 'This one fails.',
              deliverable: 'reports/02-flaky.md',
              dependsOn: [],
            },
          ],
        },
        {
          id: 'second',
          name: 'Second',
          parallel: true,
          assignments: [
            {
              id: 'blocked',
              agentName: 'gamma',
              objective: 'Depends on the doomed one.',
              deliverable: 'reports/03-blocked.md',
              dependsOn: ['flaky'],
            },
            {
              id: 'reviewer',
              agentName: 'delta',
              objective: 'Review the lead work.',
              deliverable: 'reports/04-reviewer.md',
              dependsOn: ['lead'],
            },
          ],
        },
      ],
    });
  }

  it('reconstructs the same RunState dispatchRun produced, from the persisted event log alone', async () => {
    const REVISION_MARKER = '[[REVIEW_VERDICT: REVISIONS_REQUESTED]]';
    const store = new MemoryRunStore();
    const provider = new ScriptedProvider({
      byAssignment: {
        flaky: { failWith: 'deliberate failure for this fixture' },
        reviewer: { text: `Needs another pass.\n\n${REVISION_MARKER}` },
      },
      fallback: { text: 'Findings.' },
    });
    const builtPlan = plan();
    const run: RunState = {
      id: '20260810-120000-test',
      task: 'Exercise the replay contract end to end.',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      plan: builtPlan,
      assignments: materialiseAssignments(builtPlan),
    };
    await store.saveRun(run);

    await dispatchRun({
      run,
      registry: REGISTRY,
      provider,
      store,
      signal: new AbortController().signal,
    });

    // Sanity on the scenario shape before trusting the comparison below — if
    // the fixture stops exercising a failure, a skip and a revision, the
    // field-for-field assertions after it would be proving less than they
    // claim to.
    const before = (id: string): AssignmentState | undefined => run.assignments.find((a) => a.id === id);
    expect(before('lead')?.status).toBe('done');
    expect(before('lead')?.attempts).toBe(2); // the one FR-M10 revision
    expect(before('flaky')?.status).toBe('failed');
    expect(before('blocked')?.status).toBe('skipped');
    expect(before('reviewer')?.status).toBe('done');

    // Read back exactly what a replay client reads: every assignment's
    // persisted `.jsonl` log, nothing else.
    const allEvents: LoggedAgentEvent[] = [];
    for (const assignment of run.assignments) {
      allEvents.push(...(await store.readEvents(run.id, assignment.id)));
    }
    const lastTs = allEvents.reduce((max, e) => Math.max(max, e.ts), 0);
    const replayed = foldEvents(run, allEvents, lastTs);

    for (const real of run.assignments) {
      const folded = replayed.assignments.find((a) => a.id === real.id);
      expect(folded).toBeDefined();
      if (folded === undefined) continue;

      // Static plan fields: never touched by the fold, so trivially equal —
      // asserted anyway so a future change that broke them would fail here,
      // not just in a less specific test elsewhere.
      expect(folded.phaseId).toBe(real.phaseId);
      expect(folded.agentName).toBe(real.agentName);
      expect(folded.deliverable).toBe(real.deliverable);
      expect(folded.dependsOn).toEqual(real.dependsOn);

      // The properties this task's fix is actually about: carried directly
      // from the event, the exact value `setStatus` stamped onto the real
      // `AssignmentState` — not a re-derived guess. Exact equality is
      // meaningful here specifically because dispatcher.ts's `setStatus` now
      // reuses the SAME patch value for both the in-memory assignment and the
      // emitted event, rather than computing it twice.
      expect(folded.status).toBe(real.status);
      expect(folded.reportPath).toBe(real.reportPath);
      expect(folded.error).toBe(real.error);
      expect(folded.endedAt).toBe(real.endedAt);

      // usage: matches for EVERY assignment, including the revised one.
      //
      // It did not, and the disagreement is how a real defect was found. The
      // fold sums every `usage` event on disk, so for a revised assignment it
      // reported the true combined spend across both attempts; the live
      // orchestrator overwrote its per-assignment figure on the second
      // dispatch and reported only the revision's tokens. `runTotalUsage`, and
      // therefore NFR-5's whole cost display, is built from exactly that
      // figure — so every run containing a revision silently understated its
      // own bill. The dispatcher now seeds the accumulator from what the
      // assignment has already spent, and the two agree.
      //
      // Worth keeping the shape of that discovery in mind: neither side was
      // obviously wrong on its own. It took comparing two independent
      // reconstructions of the same fact to see that one of them was.
      expect(folded.usage).toEqual(real.usage);

      // attempts: matches, but not because the fold reconstructs it — it
      // can't (see useReplay.ts's file header: no AgentEvent carries a change
      // in attempt count). It matches here only because `foldEvents`'s `base`
      // *is* the post-dispatch `run` object, whose `attempts` the reset step
      // deliberately leaves untouched. This is not evidence attempts survives
      // replay from a bare event log; it is the documented, out-of-scope
      // limitation, asserted so a regression in the reset step would still be
      // caught.
      expect(folded.attempts).toBe(real.attempts);

      // startedAt: the one field that DIVERGES by design, and is expected to.
      // It is not carried on the event (see the file header for why it never
      // needed to be) — the fold reconstructs it from the status event's own
      // `ts`, a timestamp taken by the store a moment after dispatcher.ts's
      // own `Date.now()` call that stamped the real `startedAt`. Two
      // independent clock reads a few asynchronous steps apart are not
      // guaranteed to land on the same millisecond, so exact equality is not
      // asserted — only that both are set, and close.
      if (real.startedAt === undefined) {
        expect(folded.startedAt).toBeUndefined();
      } else {
        expect(folded.startedAt).toBeDefined();
        expect(Math.abs((folded.startedAt ?? 0) - real.startedAt)).toBeLessThan(1_000);
      }
    }
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
