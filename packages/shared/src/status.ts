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
  /**
   * FR-M11: the plan exists and the user is being asked to sign off the team
   * before a single agent is dispatched.
   *
   * Only reached when the run asked for it (`CreateRunRequest.reviewTeam`).
   * Without that flag `planning` still goes straight to `dispatching`, which is
   * why both edges are legal below — this is an opt-in pause, not a new
   * mandatory step, and a run that never opts in must behave exactly as it did
   * before this status existed.
   *
   * It is deliberately its own status rather than a boolean hung off
   * `planning`. Everything downstream — the office, the run list, the status
   * badge, the cancel path — reads run status to decide what to show, and
   * "planning" while actually waiting on a human would make every one of those
   * describe the run as busy when it is idle and waiting for you.
   */
  'awaiting_approval',
  /**
   * FR-M12: the Manager has questions about the task and is waiting for the
   * user to answer them before it plans.
   *
   * Only reached when the run asked for it (`CreateRunRequest.clarify`), on the
   * same opt-in argument as `awaiting_approval` above.
   *
   * Its edge goes back to `planning`, which makes it the **only self-loop** in
   * `RUN_TRANSITIONS` — and the loop is the honest description. The question
   * turn is itself a model call against the roster, so the run really is
   * planning while it asks; calling it `queued` would understate that exactly
   * as calling the park `planning` would overstate it. Parking is a state the
   * user can see and act on, and returning to `planning` is what actually
   * happens next.
   *
   * The bound on the loop is not in this table: `clarify` is consumed once, so
   * the Manager cannot ask, be answered, and ask again. See FR-M12's "one
   * bounded round" in PLAN.md §14.1 for why an open thread was refused.
   */
  'awaiting_clarification',
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
  /**
   * The agent ran, and said it could not produce the work.
   *
   * Added for the same reason `cancelled` above was, and the entry there makes
   * the argument in one line: *a status vocabulary that cannot say "stopped"
   * forces every reader of it to say "broken" instead.* This is the third thing
   * the vocabulary could not say — "the agent answered, honestly, that it had
   * nothing" — and the consequence was the same shape. A live run finished
   * `3 done, 0 failed` while one of the three had produced 3,993 bytes
   * explaining why it could not do the work, against 18,687 and 16,719 from the
   * others. FR-M6's guard is `text.trim() === ''`, so "I could not do this" is a
   * report; the requirement means an assignment that did not produce the work is
   * a failure, and the code tested the letter rather than the intent.
   *
   * Distinct from `failed`, which means something went wrong — a timeout, a
   * provider error, a missing report. Nothing went wrong here: the agent worked,
   * reached a conclusion about its own ability to proceed, and said so. Filing
   * that as a failure would put a red cross on the one behaviour this system
   * most wants to encourage.
   *
   * Distinct from `skipped`, which is the *dispatcher's* decision that an
   * assignment could not run at all. This is the *agent's* report that it did.
   *
   * The trigger is the agent's own `[[BLOCKER: ...]]` marker, whose documented
   * meaning is already "something stopped me producing what was asked for" —
   * i.e. there is no work product. An agent that DID the work and wants to flag
   * something uses `NOTE`; the brief says so explicitly, because acting on this
   * marker makes that distinction load-bearing.
   */
  'declined',
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
  'declined',
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
  // Both edges are legal, and that is the whole shape of FR-M11: a run that
  // asked to review its team pauses at `awaiting_approval`, and a run that did
  // not goes straight on exactly as it always has. Making the pause mandatory
  // here would have turned an opt-in feature into a breaking change for every
  // existing caller, including the CLI and every test fixture.
  //
  // FR-M12 adds the third edge. A run may ask for the clarification round, the
  // team review, both, or neither, and the three edges out of `planning` are
  // what lets all four combinations be legal without any of them being
  // mandatory.
  planning: ['awaiting_clarification', 'awaiting_approval', 'dispatching'],
  awaiting_approval: ['dispatching'],
  // The self-loop (FR-M12). See the status's own doc comment above for why this
  // returns to `planning` rather than forward to `dispatching`: the answers are
  // an input to planning, so the planning turn genuinely has to happen after
  // them. A run that has been answered re-enters `planning` and from there takes
  // whichever of the remaining edges it qualifies for — including
  // `awaiting_approval`, so asking for both stops works and they occur in the
  // order a user would expect: clarify the task, then review the team it
  // produced.
  awaiting_clarification: ['planning'],
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
  reporting: ['done', 'declined'],
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
  // Sealed, like `failed` and `skipped`.
  //
  // The tempting edge is `declined -> briefing`: an assignment that declined is
  // arguably a BETTER candidate for a second attempt with a corrected brief than
  // one that succeeded, which is what `done -> briefing` exists for. It is left
  // out because nothing re-dispatches a declined assignment — `decideRevision`
  // acts on a reviewer's verdict about a `done` target — and a legal edge no
  // code takes is worse than no edge at all: it reads as a retry path that
  // exists. Add it with the code that uses it.
  declined: [],
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
  // An `alert` bubble, not an `error` one — and this is the whole distinction
  // drawn in words. The agent walked its report over and the report says "I
  // could not do this": something needs a human's attention, and nothing broke.
  // `idle_relaxed` would be wrong for the opposite reason: this desk did not
  // finish its work.
  declined: { animation: 'idle', location: 'desk', bubble: 'alert', carrying: false },
};
