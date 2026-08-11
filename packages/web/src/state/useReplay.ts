import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canTransitionAssignment,
  isAssignmentTerminal,
  EMPTY_USAGE,
  type AssignmentState,
  type LoggedAgentEvent,
  type RunState,
} from '@agent-office/shared';
import { fetchRun, fetchRunEvents } from '../api.js';

/**
 * Offline replay of a finished (or in-progress) run, driven entirely from its
 * event log (PLAN.md NFR-7).
 *
 * PLAN.md §4 names "sim iteration burns tokens" as a project risk and this
 * feature as its mitigation: iterating on the office animation must not mean
 * re-running agents and paying for them. Once a run's `.jsonl` logs exist on
 * disk, this hook can reconstruct `RunState` at *any* point in the run,
 * offline, with zero provider calls — a designer can scrub a real run over
 * and over for free.
 *
 * ## The core problem
 *
 * The office sim (Phase 4, `../sim/**`) renders from `RunState.assignments[]`
 * — a snapshot. The event log (`LoggedAgentEvent[]`, `@agent-office/shared`
 * `events.ts`) is a *stream*. Replay's job is to fold that stream up to an
 * arbitrary timestamp and produce the `RunState` that would have existed at
 * that moment. {@link foldEvents} is that fold — the heart of this file,
 * exported and unit-tested independently of React, the DOM, and time itself.
 *
 * ## Design decisions
 *
 * **Wall-clock gaps are compressed, not replayed 1:1.** A real run can idle
 * 30+ seconds between events (model latency, a long tool call). Replaying
 * that faithfully would mean 30 seconds of a static office doing nothing,
 * which is unwatchable and defeats the entire point of a *reviewable*
 * replay. {@link buildTimelineMapping} caps every idle gap at
 * {@link DEFAULT_MAX_GAP_MS} on the *playback* clock, producing a shorter
 * "playback timeline" that still visits every event in the same order and
 * still reconstructs the exact same `RunState` at each one — compression
 * only changes pacing, never which events have "happened" at a given
 * `RunState`. Speed multipliers (0.25x-4x) then scale how fast playback
 * moves through that compressed timeline, so "4x" means "4x the compressed
 * pace", not "4x real time" (which would still make long gaps enormous at
 * a 30s : 4 = 7.5s wait).
 *
 * **Clock: `requestAnimationFrame`, injectable.** The browser default
 * ({@link createRafClock}) ticks on the display's paint cadence, which is
 * the right driver for a canvas animation. But `useReplay.test.ts` runs in
 * Node with no DOM and must not sleep, so the timing source is a parameter
 * ({@link ReplayClock}) rather than a hard-coded `requestAnimationFrame`
 * call. Tests inject {@link createManualClock}, which advances only when the
 * test calls `.tick(ms)` — deterministic, synchronous, no real waiting.
 *
 * **Seeking backwards: always re-fold from the base state.** The tempting
 * alternative is periodic snapshots (fold to a checkpoint, then only fold
 * the delta) to avoid re-walking the whole event array on every seek. That
 * is real complexity — cache invalidation, snapshot placement, "which
 * checkpoint is <= this timestamp" bookkeeping — for a problem this app
 * doesn't have: a run's event log is, at most, a few thousand entries
 * (`EVENT_BUFFER_LIMIT` bounds the *live* buffer at 2,000; replay reads
 * further but agent-office runs are not high-frequency-trading feeds).
 * `foldEvents` is a single linear scan; re-running it on every seek —
 * forwards or backwards — is simplest-thing-that-works, and it is also what
 * makes "seek backwards" trivially correct: it is not a special code path,
 * it is the same pure function called with a smaller `atTs`. See
 * `useReplay.test.ts`'s "seeking backwards" test.
 *
 * **Duplicate log lines: exact-entry dedupe, and the trade-off it accepts.**
 * A `.jsonl` line can appear twice — a crash mid-append that gets retried on
 * restart, or a provider that re-emits an identical `usage` payload. Folding
 * it twice silently doubles that entry's contribution, which for a `usage`
 * event means a doubled token count feeding straight into NFR-5's cost
 * figure. Nothing in `events.ts` carries an idempotency key, so there is no
 * principled way to say "this is a re-send of that" — the only signal
 * available is that the two log lines are identical. `foldEvents` therefore
 * treats two `{ts, event}` entries as "the same line" when they are
 * field-for-field identical, and applies only the first occurrence. This is
 * deliberately whole-entry equality, not a looser key like "same assignment
 * + same ts": a looser key would also collapse two *different* events that
 * merely happen to land in the same millisecond, which is not a duplicate at
 * all and would be a worse bug than the one being fixed. The trade-off this
 * does accept: two genuinely separate emissions that happen to be
 * byte-identical (same assignment, same millisecond, same token counts — not
 * impossible for a provider that reports usage in fixed-size chunks) are
 * indistinguishable from a duplicated line and get collapsed to one,
 * silently *under*-counting by exactly that entry. `useReplay.test.ts` pins
 * both sides of this: the duplicate case (must not double-count) and the
 * collision case (documents that a legitimate byte-identical repeat is, in
 * fact, collapsed too).
 *
 * ## Static vs derived-from-events fields
 *
 * `AssignmentState` mixes two kinds of field, and the fold must not confuse
 * them:
 *
 * - **Static (plan data, never touched by the fold):** `id`, `phaseId`,
 *   `agentName`, `objective`, `deliverable`, `dependsOn`. These come from
 *   the Manager's plan, not from execution, so they are carried through
 *   from the base `RunState` unchanged.
 * - **Derived from events (reset, then folded):** `status`, `usage`,
 *   `startedAt`, `endedAt`, `reportPath`, `error`. Directly backed by
 *   `status`/`usage` events.
 * - **`endedAt`, `reportPath`, `error` — carried, not guessed.** The
 *   dispatcher (`packages/server/src/orchestrator/dispatcher.ts`'s
 *   `setStatus`) attaches these to the *persisted* `RunState` at the same
 *   moment it emits the `status` event, and — this is the point of the
 *   change that added this paragraph — the event now carries the same
 *   values, not just `{ t: 'status', status }`. The fold below applies them
 *   directly rather than inferring them, which used to be wrong in two
 *   ways: a `reportPath` guessed as `deliverable` was stale the moment a
 *   revised assignment's report path could ever legitimately differ, and an
 *   `error` guessed from "the most recent fatal `error` event" was simply
 *   absent for `skipped` (the dispatcher never emits a fatal `error` event
 *   for a skip; the reason lives only in the `status` event's own patch).
 *   `endedAt` additionally needed a THIRD signal, `endedAtCleared`, for
 *   FR-M10's `done -> briefing` revision re-dispatch: that transition clears
 *   `endedAt` (the work is not finished any more) without setting a new one,
 *   and an absent `endedAt` on the event already means "unchanged" for every
 *   other transition — so "cleared" needed a signal absence could not carry.
 *   Without it, a revised assignment replayed as `briefing` beside the STALE
 *   `endedAt` from its earlier completion, appearing to finish before it
 *   restarted.
 *   A log written before this change carries none of these three fields, and
 *   must keep replaying exactly as it always did (NFR-7) — so the fold falls
 *   back, for each field independently, to its old approximation whenever the
 *   event does not carry it: `reportPath = deliverable` on `done`, `error`
 *   from the last fatal `error` event seen, `endedAt` from the status event's
 *   own `ts`. `startedAt` has no carried field at all, and does not need one:
 *   dispatcher.ts stamps it from exactly one transition — the FIRST
 *   `briefing` a given assignment ever reaches — so the fold sets it from the
 *   `ts` of that specific event (not, as an earlier version of this code did,
 *   "the first non-pending status of any kind": a dependency failure sends an
 *   assignment straight `pending -> skipped` without ever briefing it, and
 *   that broader rule fabricated a `startedAt` for a skip the live
 *   orchestrator never stamped one for at all). What remains is only the gap
 *   between two independent clock reads a few lines apart — the event's `ts`
 *   versus the dispatcher's own `Date.now()` — not exact equality; see
 *   `useReplay.test.ts`'s field-for-field replay test for that in practice.
 * - **Not covered by the event contract at all:** `attempts`. No
 *   `AgentEvent` variant records a change in dispatch attempt count, so it
 *   cannot be folded from anything. It is left at whatever the fetched base
 *   `RunState` recorded (normally the run's final value) for the entire
 *   replay — a known, documented approximation rather than a silent one.
 * - **Run-level fields with no event representation:** `status`,
 *   `managerUsage`, `reportPath` (the Manager's synthesis), `pdfPath`,
 *   `error` all live on `RunState` itself, not on any per-assignment event,
 *   so they too are carried through from the base `RunState` unchanged
 *   throughout playback (see {@link resetAssignmentsForReplay} — it resets
 *   only `assignments[]`). In particular `managerUsage` (planning/synthesis
 *   spend, NFR-5) cannot be shown "as of" a replay position; it is a
 *   run-level total the Manager's own turns are not assignment-scoped
 *   events at all.
 */

// ---------------------------------------------------------------------------
// 1. The fold — pure, exported, the heart of replay
// ---------------------------------------------------------------------------

/**
 * Resets every assignment's event-derived fields to their pre-run defaults,
 * keeping the static plan fields (and `attempts` — see file header) as
 * fetched. This is the base every {@link foldEvents} call folds onto; calling
 * it directly (with zero events applied) is what "an empty event list yields
 * the base run unchanged" means in the test file — unchanged relative to a
 * run whose assignments already sit at these defaults.
 */
export function resetAssignmentsForReplay(run: RunState): RunState {
  return {
    ...run,
    assignments: run.assignments.map(
      (a): AssignmentState => ({
        ...a,
        status: 'pending',
        usage: { ...EMPTY_USAGE },
        startedAt: undefined,
        endedAt: undefined,
        reportPath: undefined,
        error: undefined,
      }),
    ),
  };
}

/**
 * Sorts a copy of `events` by `ts` ascending. `Array#sort` is stable
 * (spec-guaranteed since ES2019), so events sharing a `ts` keep their
 * original relative order rather than being shuffled — this is what keeps
 * duplicate-timestamp input from corrupting the fold. The server
 * (`collectRunEvents` in `packages/server/src/http/runEvents.ts`) already
 * sorts before this reaches the client, but `foldEvents` is also exercised
 * directly by tests and must not assume its input is pre-sorted.
 */
function sortEventsForReplay(events: readonly LoggedAgentEvent[]): LoggedAgentEvent[] {
  return [...events].sort((a, b) => a.ts - b.ts);
}

/**
 * Applies one event onto the assignment it targets. Mutates `assignment` in
 * place — safe only because callers (`foldEvents`) operate on a fresh object
 * produced by {@link resetAssignmentsForReplay} for this call, never on a
 * shared instance.
 */
function applyEvent(
  assignment: AssignmentState,
  logged: LoggedAgentEvent,
  lastFatalErrorByAssignment: Map<string, string>,
): void {
  const { ts, event } = logged;
  switch (event.t) {
    case 'status': {
      if (!canTransitionAssignment(assignment.status, event.status)) {
        // The live orchestrator only ever emits edges `canTransitionAssignment`
        // allows (shared/src/status.ts owns that table precisely so the sim
        // never has to invent a behaviour for a state it can't reach). An
        // event claiming an edge outside that table — e.g. `done -> working`,
        // which is not the FR-M10 `done -> briefing` revision — did not
        // happen on a real run; it is a corrupted or hand-edited log entry.
        // Per the fold's "never throws" contract (see the unknown-assignment
        // branch in `foldEvents`), this degrades rather than crashes replay:
        // the illegal entry is dropped and the assignment holds its last
        // known-good status. The alternative — apply it anyway but clear
        // `startedAt`/`endedAt` to match — was rejected because it fabricates
        // a state with even less basis in reality than simply not moving:
        // there is no way to know what a corrupted entry's "real" status
        // would have been, only that this one isn't it. Dropping it also
        // closes the specific bug this guards against: `endedAt`, once set on
        // a terminal status, is cleared again by exactly one *legal* edge
        // (FR-M10's `done -> briefing`, via `endedAtCleared` below) and by
        // nothing else — so applying an illegal regression away from a
        // terminal status used to leave a non-terminal `status` sitting next
        // to a stale `endedAt` that no legal transition would have produced —
        // a combination the live system can never produce.
        break;
      }
      // `briefing` specifically, not merely "any non-pending status": that is
      // the ONLY transition dispatcher.ts ever stamps `startedAt` from
      // (`executeAssignment`'s opening `setStatus(..., 'briefing', {
      // startedAt: assignment.startedAt ?? Date.now(), ... })`). A dependency
      // failure sends an assignment straight `pending -> skipped` without
      // ever briefing it (`dispatchRun`'s dependenciesUnreachable loop), and
      // the live orchestrator leaves THAT assignment's `startedAt` unset —
      // correctly, since it never started. The broader "any non-pending
      // status" rule this replaced set a fabricated `startedAt` on exactly
      // that skip, which nothing had walked and nothing had asserted against
      // until `useReplay.test.ts`'s field-for-field replay test compared a
      // real skip's `RunState` against its fold and caught the mismatch.
      if (assignment.startedAt === undefined && event.status === 'briefing') {
        assignment.startedAt = ts;
      }

      // endedAt: `setStatus` never sets more than one of `endedAtCleared` /
      // `endedAt` on the same event, so at most one of the first two branches
      // fires; the third is the old-log fallback and must come last. FR-M10's
      // `done -> briefing` revision is a real, legal transition that leaves
      // `endedAt` set from the assignment's EARLIER completion (folding
      // events in order, that first `done` already ran and set it) unless
      // this event explicitly clears it — which is exactly what
      // `endedAtCleared` is for; omitting `endedAt` here would be read as
      // "unchanged" and leave the stale value in place.
      if (event.endedAtCleared === true) {
        assignment.endedAt = undefined;
      } else if (event.endedAt !== undefined) {
        // Carried explicitly — the exact value the dispatcher stamped onto
        // `AssignmentState`, not the event's own `ts` (a separate clock read
        // a few lines away in dispatcher.ts; see the file header).
        assignment.endedAt = event.endedAt;
      } else if (isAssignmentTerminal(event.status) && assignment.endedAt === undefined) {
        // Old log, written before `endedAt` was carried — approximate from
        // this event's own `ts`, as before (NFR-7: must still replay).
        assignment.endedAt = ts;
      }

      if (event.reportPath !== undefined) {
        assignment.reportPath = event.reportPath;
      } else if (event.status === 'done') {
        // Old log without the carried field — approximate as before, mirroring
        // dispatcher.ts's own `deliverable` rule.
        assignment.reportPath = assignment.deliverable;
      }

      if (event.error !== undefined) {
        assignment.error = event.error;
      } else if (event.status === 'failed') {
        // Old log without the carried field — approximate from the last fatal
        // `error` event seen, as before. (Note this fallback never fires for
        // `skipped`: the live dispatcher never emitted a fatal `error` event
        // for a skip, carried field or not — a skip's reason lived only in
        // this now-carried `error`, which is exactly the gap this change
        // closes for `skipped` specifically.)
        const message = lastFatalErrorByAssignment.get(assignment.id);
        if (message !== undefined) assignment.error = message;
      }

      assignment.status = event.status;
      break;
    }
    case 'usage': {
      assignment.usage = {
        inputTokens: assignment.usage.inputTokens + event.inputTokens,
        outputTokens: assignment.usage.outputTokens + event.outputTokens,
      };
      break;
    }
    case 'error': {
      if (event.fatal) lastFatalErrorByAssignment.set(assignment.id, event.message);
      // Non-fatal errors, like text/tool/artifact below, are activity for
      // the inspect panel (`visibleEvents` on the hook), not RunState.
      break;
    }
    case 'text':
    case 'tool':
    case 'artifact':
      break; // activity-only; no RunState field represents these.
    default: {
      // Exhaustiveness guard: a new AgentEvent variant must be handled above
      // (or explicitly ignored) rather than silently falling through.
      const exhaustive: never = event;
      throw new Error(`unhandled AgentEvent type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Reconstructs `RunState` as of `atTs` (inclusive), by folding every event
 * with `ts <= atTs` onto a freshly reset copy of `base`.
 *
 * Pure: same inputs, same output, every time — no snapshot cache, no
 * incremental state. That purity is what makes seeking (forward *or*
 * backward) trivially correct; see the "Seeking backwards" design note
 * above.
 *
 * Events referencing an assignment id absent from `base.assignments` are
 * ignored rather than throwing (NFR-8-style degradation: one malformed or
 * stale log entry must not break the whole replay). An event for an
 * assignment id that *is* present in `base.assignments` but has not yet
 * appeared in the log leaves that assignment at its reset defaults until its
 * first event — which is what "an assignment first seen in the log must
 * appear" means: it appears the moment its first event is folded in.
 */
export function foldEvents(base: RunState, events: readonly LoggedAgentEvent[], atTs: number): RunState {
  const result = resetAssignmentsForReplay(base);
  const byId = new Map(result.assignments.map((a) => [a.id, a]));
  const lastFatalErrorByAssignment = new Map<string, string>();
  // Exact-entry idempotency guard — see the file header's "Duplicate log
  // lines" note for why this is whole-entry equality rather than a looser,
  // value-based key, and what that trade-off gets wrong.
  const seenEntries = new Set<string>();

  for (const logged of sortEventsForReplay(events)) {
    if (logged.ts > atTs) break; // ascending sort: nothing after this can qualify either
    const dedupeKey = JSON.stringify(logged);
    if (seenEntries.has(dedupeKey)) continue; // a byte-identical line already applied — see file header
    seenEntries.add(dedupeKey);
    const assignment = byId.get(logged.event.assignmentId);
    if (assignment === undefined) continue; // unknown assignment id: ignored, not thrown
    applyEvent(assignment, logged, lastFatalErrorByAssignment);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. Playback pacing — idle-gap compression (independent of the fold)
// ---------------------------------------------------------------------------

/**
 * Idle gaps longer than this are compressed to this many *playback* ms. See
 * the "Wall-clock gaps" design note above for why compression exists at all.
 * 5s is long enough that a viewer still perceives "the office paused here"
 * without the replay stalling for the real 30s+ some tool calls take.
 */
export const DEFAULT_MAX_GAP_MS = 5_000;

export interface TimelineMapping {
  /** Total playback-clock duration after compression, in ms. Zero events -> zero. */
  durationMs: number;
  /**
   * The real event timestamp "reached" after `playbackMs` of compressed
   * playback — i.e. the `atTs` to pass to {@link foldEvents} for this
   * playback position. Monotonic non-decreasing; clamps to the first/last
   * event's `ts` outside `[0, durationMs]`.
   */
  realTsAt: (playbackMs: number) => number;
}

/**
 * Builds the playback-time <-> real-time mapping used to pace replay.
 * Deliberately separate from {@link foldEvents}: pacing is a UI concern
 * (how fast to move the scrub bar), while the fold is a pure function of a
 * real timestamp. Keeping them apart means the fold's tests never need to
 * think about gap compression, and this function's tests never need to
 * think about `RunState`.
 */
export function buildTimelineMapping(
  events: readonly LoggedAgentEvent[],
  maxGapMs: number = DEFAULT_MAX_GAP_MS,
): TimelineMapping {
  const sorted = sortEventsForReplay(events);

  if (sorted.length === 0) {
    return { durationMs: 0, realTsAt: () => 0 };
  }

  const breakpoints: { realTs: number; playbackMs: number }[] = [];
  let playbackMs = 0;
  let prevRealTs: number | undefined;
  for (const logged of sorted) {
    if (prevRealTs !== undefined) {
      const gap = Math.max(0, logged.ts - prevRealTs);
      playbackMs += Math.min(gap, maxGapMs);
    }
    breakpoints.push({ realTs: logged.ts, playbackMs });
    prevRealTs = logged.ts;
  }

  // `?? 0` is a safe fallback, not a type-escape: `breakpoints` is provably
  // non-empty here (built one entry per element of non-empty `sorted`), but
  // `noUncheckedIndexedAccess` cannot see that through the loop above.
  const durationMs = breakpoints[breakpoints.length - 1]?.playbackMs ?? 0;

  function realTsAt(atPlaybackMs: number): number {
    let result = breakpoints[0]?.realTs ?? 0;
    for (const bp of breakpoints) {
      if (bp.playbackMs > atPlaybackMs) break;
      result = bp.realTs;
    }
    return result;
  }

  return { durationMs, realTsAt };
}

// ---------------------------------------------------------------------------
// 3. Clock abstraction — injectable timing source
// ---------------------------------------------------------------------------

/**
 * Abstracts "what drives the playback loop" so it can be swapped for a
 * deterministic fake in tests. `schedule` is one-shot, like
 * `requestAnimationFrame`: callers re-`schedule` after each tick if they want
 * another one.
 */
export interface ReplayClock {
  /** Current time in ms. Only deltas between calls matter — not epoch time. */
  now: () => number;
  /** Runs `cb` on the next tick; returns a handle for {@link cancel}. */
  schedule: (cb: (nowMs: number) => void) => number;
  cancel: (handle: number) => void;
}

/** Browser default: paced by the display's paint cadence, right for a canvas animation. */
export function createRafClock(): ReplayClock {
  return {
    now: () => performance.now(),
    schedule: (cb) => window.requestAnimationFrame(cb),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  };
}

/** Fallback for environments without `requestAnimationFrame` (defensive; the app is browser-only). */
export function createIntervalClock(intervalMs = 16): ReplayClock {
  return {
    now: () => Date.now(),
    schedule: (cb) => window.setTimeout(() => cb(Date.now()), intervalMs),
    cancel: (handle) => window.clearTimeout(handle),
  };
}

function createDefaultClock(): ReplayClock {
  const hasRaf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
  return hasRaf ? createRafClock() : createIntervalClock();
}

export interface ManualReplayClock extends ReplayClock {
  /** Test-only: advances the fake clock by `deltaMs` and fires the pending callback, if any. */
  tick: (deltaMs: number) => void;
}

/**
 * Deterministic clock for tests: time only moves when `.tick()` is called,
 * synchronously, in-process — no real waiting, no flakiness from scheduler
 * jitter. Supports exactly one pending callback at a time, matching how the
 * playback loop below actually uses a `ReplayClock` (schedule -> tick ->
 * re-schedule).
 */
export function createManualClock(startMs = 0): ManualReplayClock {
  let current = startMs;
  let pending: ((nowMs: number) => void) | undefined;
  let nextHandle = 1;
  return {
    now: () => current,
    schedule: (cb) => {
      pending = cb;
      return nextHandle++;
    },
    cancel: (handle) => {
      void handle;
      pending = undefined;
    },
    tick: (deltaMs) => {
      current += deltaMs;
      const cb = pending;
      pending = undefined;
      cb?.(current);
    },
  };
}

/**
 * Pure step: advances a playback position by `deltaRealMs` of wall-clock
 * time at `speed`x, clamped to `[0, durationMs]`. Exported so playback
 * pacing can be tested as ordinary arithmetic, with no clock or hook
 * involved at all.
 */
export function advancePositionMs(
  currentMs: number,
  deltaRealMs: number,
  speed: number,
  durationMs: number,
): number {
  if (deltaRealMs <= 0) return Math.min(Math.max(currentMs, 0), durationMs);
  const next = currentMs + deltaRealMs * speed;
  return Math.min(Math.max(next, 0), durationMs);
}

// ---------------------------------------------------------------------------
// 4. The hook
// ---------------------------------------------------------------------------

export const REPLAY_SPEEDS = [0.25, 1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export type ReplayLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface UseReplayOptions {
  /** Injectable timing source (the test seam described above). Defaults to `requestAnimationFrame`. */
  clock?: ReplayClock;
  /** Idle-gap cap fed to {@link buildTimelineMapping}; overridable mainly for tests. */
  maxGapMs?: number;
}

export interface UseReplayResult {
  loadState: ReplayLoadState;
  /** Set when `loadState === 'error'`. */
  error: string | undefined;
  /** From `RunEventsResponse.partial` — true when at least one log file couldn't be read. */
  partial: boolean;
  /** Total playback duration after gap compression, in ms. */
  durationMs: number;
  /** Current playback position, in ms, within `[0, durationMs]`. */
  positionMs: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** `RunState` reconstructed as of `positionMs`. `undefined` until loaded. */
  run: RunState | undefined;
  /** Events that have occurred by `positionMs`, in chronological order — feeds an inspect panel. */
  visibleEvents: LoggedAgentEvent[];
  play: () => void;
  pause: () => void;
  /** Clamps to `[0, durationMs]`. */
  seek: (ms: number) => void;
  setSpeed: (speed: ReplaySpeed) => void;
}

/**
 * Loads a run's saved state plus its full event log (NFR-7) and exposes a
 * scrubbable, playable reconstruction of `RunState` over the course of the
 * run — see the file header for the fold, gap-compression and clock design.
 *
 * `runId === undefined` leaves the hook at `loadState: 'idle'` with nothing
 * loaded, so a panel can mount this hook before a run is selected.
 */
export function useReplay(runId: string | undefined, options: UseReplayOptions = {}): UseReplayResult {
  const maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  // The clock is captured once, at first use, not re-read from `options` on
  // every render — it is a construction-time test seam, not a value meant to
  // change while playback is live.
  const clockRef = useRef<ReplayClock | undefined>(undefined);
  clockRef.current ??= options.clock ?? createDefaultClock();

  const [loadState, setLoadState] = useState<ReplayLoadState>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [partial, setPartial] = useState(false);
  const [baseRun, setBaseRun] = useState<RunState | undefined>(undefined);
  const [events, setEvents] = useState<LoggedAgentEvent[]>([]);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<ReplaySpeed>(1);

  useEffect(() => {
    if (runId === undefined) {
      setLoadState('idle');
      return;
    }

    let cancelled = false;
    setLoadState('loading');
    setError(undefined);
    setPlaying(false);
    setPositionMs(0);

    Promise.all([fetchRun(runId), fetchRunEvents(runId)])
      .then(([run, eventsResponse]) => {
        if (cancelled) return;
        setBaseRun(run);
        setEvents(eventsResponse.events);
        setPartial(eventsResponse.partial);
        setLoadState('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoadState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  const timeline = useMemo(() => buildTimelineMapping(events, maxGapMs), [events, maxGapMs]);
  const durationMs = timeline.durationMs;

  // Refs mirroring the latest render's values, read from inside the rAF/timer
  // callback below so the loop doesn't need to be torn down and rebuilt every
  // time `speed` or `durationMs` changes mid-playback.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;

  useEffect(() => {
    if (!playing) return undefined;
    const clock = clockRef.current;
    if (clock === undefined) return undefined;

    let handle: number | undefined;
    let lastNow = clock.now();

    const frame = (nowMs: number): void => {
      const deltaMs = nowMs - lastNow;
      lastNow = nowMs;
      setPositionMs((prev) => {
        const next = advancePositionMs(prev, deltaMs, speedRef.current, durationRef.current);
        if (next >= durationRef.current) setPlaying(false); // reached the end: stop rather than idle at the edge
        return next;
      });
      if (playingRef.current) handle = clock.schedule(frame);
    };
    handle = clock.schedule(frame);

    return () => {
      if (handle !== undefined) clock.cancel(handle);
    };
  }, [playing]);

  const run = useMemo(() => {
    if (baseRun === undefined) return undefined;
    return foldEvents(baseRun, events, timeline.realTsAt(positionMs));
  }, [baseRun, events, timeline, positionMs]);

  const visibleEvents = useMemo(() => {
    const atTs = timeline.realTsAt(positionMs);
    return sortEventsForReplay(events).filter((e) => e.ts <= atTs);
  }, [events, timeline, positionMs]);

  const play = useCallback(() => {
    setPositionMs((p) => (p >= durationRef.current ? 0 : p)); // "play" at the end restarts, rather than doing nothing
    setPlaying(true);
  }, []);
  const pause = useCallback(() => setPlaying(false), []);
  const seek = useCallback((ms: number) => {
    setPositionMs(Math.min(Math.max(ms, 0), durationRef.current));
  }, []);
  const setSpeed = useCallback((s: ReplaySpeed) => setSpeedState(s), []);

  return {
    loadState,
    error,
    partial,
    durationMs,
    positionMs,
    playing,
    speed,
    run,
    visibleEvents,
    play,
    pause,
    seek,
    setSpeed,
  };
}
