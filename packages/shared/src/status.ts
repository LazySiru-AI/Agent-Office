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
] as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const AssignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);

/** Statuses from which no further transition is legal. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['done', 'failed', 'cancelled'];
export const TERMINAL_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'done',
  'failed',
  'skipped',
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
  // FR-M10: a reviewer may send an assignment back, so `reporting` can loop to
  // `working` once. The retry budget is enforced by the dispatcher, not here.
  reporting: ['done', 'working'],
  done: [],
  failed: [],
  skipped: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (isRunTerminal(from)) return false;
  if (to === 'failed' || to === 'cancelled') return true;
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionAssignment(from: AssignmentStatus, to: AssignmentStatus): boolean {
  if (isAssignmentTerminal(from)) return false;
  if (to === 'failed') return true;
  return ASSIGNMENT_TRANSITIONS[from].includes(to);
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
};
