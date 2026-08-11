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

  /**
   * The provider that executed this run, e.g. `scripted` or `claude-code`.
   *
   * Recorded because cost (NFR-5) cannot be derived from the agents alone: an
   * agent's catalog `model:` says what it *would* cost through a real provider,
   * not what this run actually spent. Without this field a `scripted` run —
   * which calls no model at all — prices itself off `sonnet` and reports money
   * that was never spent.
   *
   * Optional so that `run.json` files written before this field existed still
   * load; a run without it prices off the catalog model as before.
   */
  provider: z.string().min(1).optional(),

  /** Absent until planning succeeds. */
  plan: RunPlanSchema.optional(),
  /** Flattened across phases, in execution order. Empty before planning. */
  assignments: z.array(AssignmentStateSchema),

  /**
   * Tokens spent by the Manager's own turns — planning, repair retries and
   * synthesis — which are not assignments and so appear nowhere in
   * `assignments[].usage`.
   *
   * They are real spend, and on a small run they exceed the agents' combined
   * usage, so a cost display built on `totalUsage` alone understates the run
   * badly (NFR-5). Kept separate rather than folded into the assignment totals
   * because the dispatcher's token budget (FR-M8) is scoped to dispatch.
   */
  managerUsage: UsageSchema.optional(),

  /** Run-relative path to the Manager's synthesis, once written. */
  reportPath: z.string().min(1).optional(),
  /** Run-relative path to the exported PDF (Phase 5). */
  pdfPath: z.string().min(1).optional(),
  /**
   * The theme the designer step chose, and why (FR-P2).
   *
   * Persisted rather than recomputed because the choice is a model's, and a
   * regenerated PDF that silently changed appearance would be indistinguishable
   * from a styling bug. Kept as a plain string here so `run.ts` does not depend
   * on `report.ts`; it is validated against the closed theme set at the point
   * the designer produces it.
   */
  theme: z.string().min(1).optional(),
  designRationale: z.string().optional(),
  /** Failure reason, when status is `failed`. */
  error: z.string().optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

/**
 * Everything the run actually spent: assignments plus the Manager's own turns.
 *
 * This is the number to show a user (NFR-5), and it is also what
 * `dispatcher.ts`'s `enforceTokenBudget` checks FR-M8's per-run token budget
 * against. It was not always the latter: the budget used to be checked with
 * {@link totalUsage} alone, on the reasoning that "the dispatcher's budget is
 * about dispatch". That reasoning was itself the bug, not a justification for
 * one — FR-M8 says "per-run token budget", and a user who sets a limit means
 * the whole run, not the slice of it the dispatcher happens to own. Measured
 * before the fix: `runTokenBudget: 400`, 225 tokens of assignment spend, 420
 * tokens of Manager spend — 645 true total, 61% over — and the run never
 * halted, because 225 alone never crossed 400.
 *
 * The two components are not equally reachable by a dispatch-time check,
 * which matters for what this guarantees. Manager *planning* spend is banked
 * into `run.managerUsage` before dispatch begins, so it counts from the very
 * first budget check `enforceTokenBudget` makes — an oversized planning turn
 * alone can now halt a run before a single assignment is dispatched. Manager
 * *synthesis* spend, by contrast, happens after dispatch has already finished
 * and returned, so no check made during dispatch — this one included — can
 * ever pre-empt it. A run can therefore still finish having spent more than
 * its budget once synthesis is counted; that is an inherent limit of checking
 * the budget during dispatch, not a gap this function could close.
 */
export function runTotalUsage(run: RunState): Usage {
  const assignments = totalUsage(run);
  const manager = run.managerUsage ?? EMPTY_USAGE;
  return {
    inputTokens: assignments.inputTokens + manager.inputTokens,
    outputTokens: assignments.outputTokens + manager.outputTokens,
  };
}

/**
 * Sum of every assignment's usage, excluding the Manager's own planning and
 * synthesis turns.
 *
 * No longer what FR-M8's dispatch budget is checked against — see
 * {@link runTotalUsage}'s doc comment for why that changed. Kept as its own
 * function because some callers legitimately want the assignments-only
 * figure (e.g. a per-assignment cost breakdown, or a test asserting the two
 * totals actually differ), not because dispatch still scopes to it.
 */
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
