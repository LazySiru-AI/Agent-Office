import { z } from 'zod';
import { RunPlanSchema } from './plan.js';
import { AssignmentStatusSchema, RunStatusSchema, isRunTerminal } from './status.js';

/**
 * Persisted run state (PLAN.md NFR-2).
 *
 * This is the shape written to `runs/<id>/run.json` after every transition, and
 * the shape the web client renders. It lives in `shared` for that second reason:
 * Phase 3's UI and Phase 4's office sim both read it, so it must not be a
 * server-private type.
 *
 * Everything here is plain JSON — no class instances, no Dates — so that a
 * reload is a `JSON.parse` plus a schema check and nothing more.
 */

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export type Usage = z.infer<typeof UsageSchema>;

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export const AssignmentStateSchema = z.object({
  id: z.string().min(1),
  /** Phase this assignment belongs to; phases execute in order. */
  phaseId: z.string().min(1),
  agentName: z.string().min(1),
  objective: z.string().min(1),
  deliverable: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),

  status: AssignmentStatusSchema,
  /** Dispatch attempts so far. Bounded by the reviewer send-back budget (FR-M10). */
  attempts: z.number().int().nonnegative(),
  usage: UsageSchema,

  /** Epoch ms. Absent until the assignment first leaves `pending`. */
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  /** Run-relative path, e.g. `reports/03-security-auditor.md`. Set on success. */
  reportPath: z.string().min(1).optional(),
  /** Failure reason, when status is `failed`. */
  error: z.string().optional(),
});

export type AssignmentState = z.infer<typeof AssignmentStateSchema>;

export const RunStateSchema = z.object({
  id: z.string().min(1),
  /** The user's original task text, verbatim. */
  task: z.string().min(1),
  status: RunStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),

  /** Absent until planning succeeds. */
  plan: RunPlanSchema.optional(),
  /** Flattened across phases, in execution order. Empty before planning. */
  assignments: z.array(AssignmentStateSchema),

  /** Run-relative path to the Manager's synthesis, once written. */
  reportPath: z.string().min(1).optional(),
  /** Run-relative path to the exported PDF (Phase 5). */
  pdfPath: z.string().min(1).optional(),
  /** Failure reason, when status is `failed`. */
  error: z.string().optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

/** Sum of every assignment's usage. Drives the cost display (NFR-5). */
export function totalUsage(run: RunState): Usage {
  return run.assignments.reduce<Usage>(
    (acc, assignment) => ({
      inputTokens: acc.inputTokens + assignment.usage.inputTokens,
      outputTokens: acc.outputTokens + assignment.usage.outputTokens,
    }),
    { ...EMPTY_USAGE },
  );
}

export function findAssignment(run: RunState, assignmentId: string): AssignmentState | undefined {
  return run.assignments.find((a) => a.id === assignmentId);
}

/** Assignments belonging to one phase, in plan order. */
export function assignmentsInPhase(run: RunState, phaseId: string): AssignmentState[] {
  return run.assignments.filter((a) => a.phaseId === phaseId);
}

/**
 * Whether every dependency of `assignment` has completed successfully.
 *
 * A dependency that failed or was skipped is NOT satisfied — dependents must be
 * skipped rather than run against a missing report (FR-M5 gives each assignment
 * the reports of its `dependsOn`, so a missing one would silently degrade the
 * brief).
 */
export function dependenciesSatisfied(run: RunState, assignment: AssignmentState): boolean {
  return assignment.dependsOn.every((depId) => findAssignment(run, depId)?.status === 'done');
}

/** True when a dependency has failed or been skipped, so this one cannot run. */
export function dependenciesUnreachable(run: RunState, assignment: AssignmentState): boolean {
  return assignment.dependsOn.some((depId) => {
    const status = findAssignment(run, depId)?.status;
    return status === 'failed' || status === 'skipped' || status === undefined;
  });
}

export function isRunFinished(run: RunState): boolean {
  return isRunTerminal(run.status);
}
