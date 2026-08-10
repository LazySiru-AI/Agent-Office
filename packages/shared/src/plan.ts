import { z } from 'zod';

/**
 * The Manager's structured output (PLAN.md §1.4, FR-M2).
 *
 * This schema is the contract that makes the whole app drivable: the office sim
 * lays out desks from it, the dispatcher executes it, and the report assembles
 * from it. An LLM producing free-form prose here would sink the product, so
 * invalid output is repaired-and-retried rather than tolerated.
 */

const idPattern = /^[a-z0-9][a-z0-9-]*$/;

const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(idPattern, 'ids must be lowercase kebab-case');

export const AssignmentSpecSchema = z.object({
  id: Id,
  /** Must resolve against the registry — enforced by validatePlanAgainstRegistry. */
  agentName: z.string().min(1),
  /** What this specific agent must produce. Not the overall task. */
  objective: z.string().min(1),
  /** Expected report path, e.g. `reports/03-security-auditor.md`. */
  deliverable: z.string().min(1),
  /** Assignment ids this one consumes the reports of. Earlier phases only. */
  dependsOn: z.array(Id).default([]),
});

export type AssignmentSpec = z.infer<typeof AssignmentSpecSchema>;

export const PhaseSpecSchema = z.object({
  id: Id,
  name: z.string().min(1),
  /** Whether assignments in this phase may run concurrently. */
  parallel: z.boolean().default(true),
  assignments: z.array(AssignmentSpecSchema).min(1),
});

export type PhaseSpec = z.infer<typeof PhaseSpecSchema>;

export const RunPlanSchema = z
  .object({
    /** The Manager's restatement of the task, shown back to the user. */
    summary: z.string().min(1),
    /** Free-form, but drives report theming: "software", "legal", "tax", ... */
    domain: z.string().min(1),
    phases: z.array(PhaseSpecSchema).min(1),
    /** Hint carried into the designer step (FR-P2). */
    reportStyle: z.string().min(1),
  })
  .superRefine((plan, ctx) => {
    const seenPhaseIds = new Set<string>();
    const seenAssignmentIds = new Set<string>();
    // Assignment id -> index of the phase it lives in.
    const phaseOfAssignment = new Map<string, number>();

    plan.phases.forEach((phase, phaseIndex) => {
      if (seenPhaseIds.has(phase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phases', phaseIndex, 'id'],
          message: `duplicate phase id "${phase.id}"`,
        });
      }
      seenPhaseIds.add(phase.id);

      phase.assignments.forEach((assignment, assignmentIndex) => {
        if (seenAssignmentIds.has(assignment.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['phases', phaseIndex, 'assignments', assignmentIndex, 'id'],
            message: `duplicate assignment id "${assignment.id}"`,
          });
        }
        seenAssignmentIds.add(assignment.id);
        phaseOfAssignment.set(assignment.id, phaseIndex);
      });
    });

    // Dependencies must point backwards, to a strictly earlier phase. This is
    // what guarantees the dispatcher can execute phase-by-phase without
    // deadlocking, and it makes cycles structurally impossible.
    plan.phases.forEach((phase, phaseIndex) => {
      phase.assignments.forEach((assignment, assignmentIndex) => {
        assignment.dependsOn.forEach((dep, depIndex) => {
          const path = [
            'phases',
            phaseIndex,
            'assignments',
            assignmentIndex,
            'dependsOn',
            depIndex,
          ];

          if (dep === assignment.id) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `assignment "${assignment.id}" depends on itself`,
            });
            return;
          }

          const depPhase = phaseOfAssignment.get(dep);
          if (depPhase === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `unknown assignment id "${dep}"`,
            });
            return;
          }

          if (depPhase >= phaseIndex) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `"${assignment.id}" depends on "${dep}", which is not in an earlier phase`,
            });
          }
        });
      });
    });
  });

export type RunPlan = z.infer<typeof RunPlanSchema>;

/** Every assignment across every phase, in execution order. */
export function allAssignments(plan: RunPlan): AssignmentSpec[] {
  return plan.phases.flatMap((phase) => phase.assignments);
}

/** Distinct agent names the plan calls for, in first-appearance order. */
export function assignedAgentNames(plan: RunPlan): string[] {
  return [...new Set(allAssignments(plan).map((a) => a.agentName))];
}

export interface PlanRegistryIssue {
  assignmentId: string;
  agentName: string;
  message: string;
}

/**
 * FR-M3: schema validity is not enough — every `agentName` must exist in the
 * registry. A hallucinated specialist is the most likely Manager failure mode,
 * so this returns structured issues suitable for feeding back into a repair
 * retry rather than throwing.
 */
export function validatePlanAgainstRegistry(
  plan: RunPlan,
  knownAgentNames: Iterable<string>,
): PlanRegistryIssue[] {
  const known = new Set(knownAgentNames);
  return allAssignments(plan)
    .filter((a) => !known.has(a.agentName))
    .map((a) => ({
      assignmentId: a.id,
      agentName: a.agentName,
      message: `no agent named "${a.agentName}" exists in the registry`,
    }));
}
