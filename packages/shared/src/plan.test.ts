import { describe, expect, it } from 'vitest';
import {
  RunPlanSchema,
  allAssignments,
  assignedAgentNames,
  validatePlanAgainstRegistry,
} from './plan.js';

/** A minimal two-phase plan with one backward dependency. */
function validPlan() {
  return {
    summary: 'Review the auth module.',
    domain: 'software',
    reportStyle: 'engineering',
    phases: [
      {
        id: 'research',
        name: 'Research',
        parallel: true,
        assignments: [
          {
            id: 'audit',
            agentName: 'security-auditor',
            objective: 'Find auth weaknesses.',
            deliverable: 'reports/01-security-auditor.md',
            dependsOn: [],
          },
        ],
      },
      {
        id: 'review',
        name: 'Review',
        parallel: false,
        assignments: [
          {
            id: 'summarise',
            agentName: 'code-reviewer',
            objective: 'Turn findings into fixes.',
            deliverable: 'reports/02-code-reviewer.md',
            dependsOn: ['audit'],
          },
        ],
      },
    ],
  };
}

describe('RunPlanSchema', () => {
  it('accepts a well-formed plan', () => {
    expect(RunPlanSchema.safeParse(validPlan()).success).toBe(true);
  });

  it('defaults dependsOn to an empty array', () => {
    const plan = validPlan();
    delete (plan.phases[0]!.assignments[0] as { dependsOn?: string[] }).dependsOn;

    const parsed = RunPlanSchema.parse(plan);
    expect(parsed.phases[0]!.assignments[0]!.dependsOn).toEqual([]);
  });

  it('rejects duplicate assignment ids across phases', () => {
    const plan = validPlan();
    plan.phases[1]!.assignments[0]!.id = 'audit';

    const result = RunPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('duplicate assignment id');
  });

  it('rejects a dependency on an unknown assignment', () => {
    const plan = validPlan();
    plan.phases[1]!.assignments[0]!.dependsOn = ['does-not-exist'];

    const result = RunPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('unknown assignment id');
  });

  it('rejects a self-dependency', () => {
    const plan = validPlan();
    plan.phases[1]!.assignments[0]!.dependsOn = ['summarise'];

    const result = RunPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('depends on itself');
  });

  it('rejects a forward dependency, which would deadlock the dispatcher', () => {
    const plan = validPlan();
    // Phase 0 depending on phase 1.
    plan.phases[0]!.assignments[0]!.dependsOn = ['summarise'];

    const result = RunPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('not in an earlier phase');
  });

  it('rejects a same-phase dependency', () => {
    const plan = validPlan();
    plan.phases[0]!.assignments.push({
      id: 'second',
      agentName: 'qa-expert',
      objective: 'Check tests.',
      deliverable: 'reports/03-qa-expert.md',
      dependsOn: ['audit'],
    });

    const result = RunPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('not in an earlier phase');
  });

  it('rejects non-kebab-case ids', () => {
    const plan = validPlan();
    plan.phases[0]!.id = 'Research Phase';

    expect(RunPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('rejects a phase with no assignments', () => {
    const plan = validPlan();
    plan.phases[0]!.assignments = [];

    expect(RunPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe('plan helpers', () => {
  it('flattens assignments in execution order', () => {
    const plan = RunPlanSchema.parse(validPlan());
    expect(allAssignments(plan).map((a) => a.id)).toEqual(['audit', 'summarise']);
  });

  it('deduplicates agent names', () => {
    const plan = validPlan();
    plan.phases[1]!.assignments[0]!.agentName = 'security-auditor';

    const parsed = RunPlanSchema.parse(plan);
    expect(assignedAgentNames(parsed)).toEqual(['security-auditor']);
  });
});

describe('validatePlanAgainstRegistry', () => {
  it('passes when every agent is known', () => {
    const plan = RunPlanSchema.parse(validPlan());
    const issues = validatePlanAgainstRegistry(plan, ['security-auditor', 'code-reviewer']);
    expect(issues).toEqual([]);
  });

  it('reports each hallucinated agent with its assignment id', () => {
    const plan = RunPlanSchema.parse(validPlan());
    const issues = validatePlanAgainstRegistry(plan, ['security-auditor']);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.assignmentId).toBe('summarise');
    expect(issues[0]!.agentName).toBe('code-reviewer');
  });
});
