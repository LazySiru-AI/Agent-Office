import { z } from 'zod';

/**
 * Run and assignment lifecycles (PLAN.md §1.5).
 *
 * These are deliberately in `shared` rather than in the server: the office sim
 * derives every character behaviour from assignment status, so the frontend
 * must not be able to invent a status the orchestrator does not own.
 */

export const RUN_STATUSES = [
  'queued',
  'planning',
  'dispatching',
  'running',
  'synthesizing',
  'designing',
  'report_ready',
  'done',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export const RunStatusSchema = z.enum(RUN_STATUSES);

export const ASSIGNMENT_STATUSES = [
  'pending',
  'briefing',
  'working',
  'blocked',
  'reporting',
  'done',
  'failed',
  'skipped',
  /**
   * FR-M9: the run was stopped while this assignment was in flight.
   *
   * Added late, and the reason it was missing is worth keeping. `working`'s
   * only legal onward edges are `reporting` and `blocked`, neither terminal,
   * so for four phases the dispatcher had exactly one terminal status to reach
   * for when a cancel landed mid-flight — `failed` — and it took it, with the
   * cause written into `error` text. Everything downstream then read the
   * consequence rather than the cause: `ASSIGNMENT_BEHAVIOUR` gave the
   * character `idle_slumped` with an error bubble, the office showed a team
   * that had failed at work the user had simply called off, and the run list's
   * "Failed" filter counted it. A status vocabulary that cannot say "stopped"
   * forces every reader of it to say "broken" instead.
   *
   * Distinct from `skipped`, which is also a no-result terminal state: a skip
   * is a decision the dispatcher made about THIS assignment (its dependencies
   * were unreachable), whereas a cancellation is something that happened to
   * the whole run. They share `statusStopped` in the palette, because both are
   * "withdrawn, not a result", and stay separate here because the office and
   * the log have to be able to say which one occurred.
   */
  'cancelled',
] as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const AssignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);

/** Statuses from which no further transition is legal. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['done', 'failed', 'cancelled'];
export const TERMINAL_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'done',
  'failed',
  'skipped',
  'cancelled',
];

export function isRunTerminal(s: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}

export function isAssignmentTerminal(s: AssignmentStatus): boolean {
  return TERMINAL_ASSIGNMENT_STATUSES.includes(s);
}

/**
 * Legal transitions. `failed` and `cancelled` are reachable from any
 * non-terminal run status, so they are folded in by {@link canTransitionRun}
 * rather than repeated in every row.
 */
const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['planning'],
  planning: ['dispatching'],
  dispatching: ['running'],
  running: ['synthesizing'],
  synthesizing: ['designing'],
  designing: ['report_ready'],
  report_ready: ['done'],
  done: [],
  failed: [],
  cancelled: [],
};

const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  pending: ['briefing', 'blocked', 'skipped'],
  briefing: ['working', 'blocked'],
  working: ['reporting', 'blocked'],
  blocked: ['working', 'briefing'],
  reporting: ['done'],
  // FR-M10: a reviewer may send its target back for one revision.
  //
  // This edge leaves a terminal status, which is why it is spelled out here
  // rather than left to `canTransitionAssignment`'s general rules. It has to
  // leave `done`: a reviewer necessarily runs in a *later phase* than the work
  // it reviews, phases run strictly in sequence, and a phase only starts once
  // the previous one has drained — so by the time any critique exists, its
  // target reached `done` long ago.
  //
  // An earlier version of this table put the FR-M10 edge on `reporting`
  // (`reporting -> working`), which reads plausibly and is unreachable in
  // practice: `reporting` lasts only the few milliseconds between a provider
  // finishing and its report being written, and no reviewer can observe it. The
  // comment claiming to support FR-M10 was therefore false for three phases.
  //
  // The edge lands on `briefing`, not `working`, because a re-dispatch is an
  // ordinary dispatch: it goes back through the same `executeAssignment` path
  // that assembles a brief, and that path opens with `briefing`. Pointing this
  // at `working` would have required the dispatcher to special-case the entry
  // point for revisions — a second code path for the case most likely to be
  // under-tested.
  //
  // The revision budget is enforced by the dispatcher (see `review.ts`), not
  // here: a state machine that counted attempts would need to know what an
  // attempt costs, which is exactly the sort of thing `shared` must not know.
  done: ['briefing'],
  failed: [],
  skipped: [],
  cancelled: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (isRunTerminal(from)) return false;
  if (to === 'failed' || to === 'cancelled') return true;
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * The table is consulted **before** the terminal check, so an edge written
 * explicitly above wins.
 *
 * That ordering is what lets FR-M10's `done -> working` exist without making
 * `done` non-terminal everywhere else. `isAssignmentTerminal` keeps its meaning
 * — "no further work is scheduled by default", which is what the replay reader
 * and the run accounting rely on — while the one revision edge the requirement
 * calls for is legal because it was written down. `failed` and `skipped` have
 * empty rows and so remain sealed completely.
 */
export function canTransitionAssignment(from: AssignmentStatus, to: AssignmentStatus): boolean {
  if (ASSIGNMENT_TRANSITIONS[from].includes(to)) return true;
  if (isAssignmentTerminal(from)) return false;
  // Both are "this stopped, from outside the assignment's own lifecycle", and
  // both can arrive at any point before it finishes, so neither is worth
  // repeating in all five non-terminal rows above. `cancelled` joins `failed`
  // here rather than being written into the table for exactly the reason the
  // run-level comment gives: an edge that exists from everywhere is clearer
  // stated once than enumerated five times and then forgotten on the sixth.
  return to === 'failed' || to === 'cancelled';
}

/**
 * The animation binding (PLAN.md §1.5).
 *
 * This map is the whole reason the sim stays honest: it is a pure function from
 * orchestrator state to what a character does. The renderer reads it and owns no
 * status of its own, so "what the office shows" cannot drift from "what is
 * actually running".
 */
export interface CharacterBehaviour {
  /** Sprite animation loop to play. */
  animation: 'idle' | 'idle_relaxed' | 'idle_slumped' | 'walk' | 'type';
  /** Where the character should be standing or sitting. */
  location: 'desk' | 'manager_desk' | 'to_manager' | 'to_desk';
  /** Overhead bubble, if any. */
  bubble: 'none' | 'speech' | 'alert' | 'error';
  /** Whether the character is carrying the report-paper prop. */
  carrying: boolean;
}

export const ASSIGNMENT_BEHAVIOUR: Record<AssignmentStatus, CharacterBehaviour> = {
  pending: { animation: 'idle', location: 'desk', bubble: 'none', carrying: false },
  briefing: { animation: 'walk', location: 'to_manager', bubble: 'speech', carrying: false },
  working: { animation: 'type', location: 'desk', bubble: 'none', carrying: false },
  blocked: { animation: 'idle', location: 'desk', bubble: 'alert', carrying: false },
  reporting: { animation: 'walk', location: 'to_manager', bubble: 'none', carrying: true },
  done: { animation: 'idle_relaxed', location: 'desk', bubble: 'none', carrying: false },
  failed: { animation: 'idle_slumped', location: 'desk', bubble: 'error', carrying: false },
  skipped: { animation: 'idle', location: 'desk', bubble: 'none', carrying: false },
  // Same body language as `skipped`, and deliberately NOT `failed`'s: the
  // office must not show a slumped, error-bubbled agent because the user
  // pressed Cancel. Nothing went wrong at this desk — the work simply stopped
  // being wanted, which reads as an agent sitting idle, not a defeated one.
  cancelled: { animation: 'idle', location: 'desk', bubble: 'none', carrying: false },
};
