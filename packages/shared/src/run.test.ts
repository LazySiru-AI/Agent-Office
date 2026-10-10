import { describe, expect, it } from 'vitest';
import type { AssignmentState, RunState } from './run.js';
import { dependenciesUnreachable, runTotalUsage, totalUsage } from './run.js';

/**
 * Full `AssignmentState` factory, built by hand rather than via a partial
 * cast (house style forbids `as`) so every required field is visible at the
 * call site of each test.
 */
function makeAssignment(overrides: Partial<AssignmentState> & { id: string }): AssignmentState {
  return {
    phaseId: 'phase-1',
    agentName: 'some-agent',
    objective: 'Do the thing.',
    deliverable: `reports/${overrides.id}.md`,
    dependsOn: [],
    status: 'pending',
    attempts: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: '20260810-120000-test',
    task: 'Do the thing.',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    assignments: [],
    ...overrides,
  };
}

describe('totalUsage and runTotalUsage', () => {
  it('totalUsage sums only assignment usage, ignoring managerUsage entirely', () => {
    const run = makeRun({
      assignments: [
        makeAssignment({ id: 'a', usage: { inputTokens: 100, outputTokens: 40 } }),
        makeAssignment({ id: 'b', usage: { inputTokens: 25, outputTokens: 10 } }),
      ],
      managerUsage: { inputTokens: 900, outputTokens: 300 },
    });

    expect(totalUsage(run)).toEqual({ inputTokens: 125, outputTokens: 50 });
  });

  it('runTotalUsage adds managerUsage on top of the assignment total', () => {
    const run = makeRun({
      assignments: [makeAssignment({ id: 'a', usage: { inputTokens: 100, outputTokens: 40 } })],
      managerUsage: { inputTokens: 900, outputTokens: 300 },
    });

    expect(runTotalUsage(run)).toEqual({ inputTokens: 1000, outputTokens: 340 });
  });

  it('runTotalUsage matches totalUsage when there is no manager spend recorded', () => {
    // `managerUsage` is optional (older `run.json` files predate the field);
    // absence must fall back to zero, not throw or silently drop the
    // assignment total.
    const run = makeRun({
      assignments: [makeAssignment({ id: 'a', usage: { inputTokens: 10, outputTokens: 5 } })],
    });

    expect(runTotalUsage(run)).toEqual(totalUsage(run));
  });

  it('reports the same discrepancy the token-budget defect was measured against: Manager spend can outweigh assignment spend entirely', () => {
    // MAJOR defect (dispatcher.ts, FR-M8): the run token budget used to be
    // checked with `totalUsage` alone, which let a Manager-heavy run sail
    // straight through a budget it had already blown. This is the exact
    // shape measured while confirming that defect — 225 tokens of assignment
    // spend against 420 of Manager spend, 645 true total.
    const run = makeRun({
      assignments: [makeAssignment({ id: 'a', usage: { inputTokens: 150, outputTokens: 75 } })],
      managerUsage: { inputTokens: 280, outputTokens: 140 },
    });

    const assignmentsOnly = totalUsage(run);
    const whole = runTotalUsage(run);

    expect(assignmentsOnly.inputTokens + assignmentsOnly.outputTokens).toBe(225);
    expect(whole.inputTokens + whole.outputTokens).toBe(645);
    // The number a budget check must use to catch this: the assignment-only
    // figure alone would never have crossed a 400-token budget; the true
    // total blows straight through it.
    expect(assignmentsOnly.inputTokens + assignmentsOnly.outputTokens).toBeLessThan(400);
    expect(whole.inputTokens + whole.outputTokens).toBeGreaterThan(400);
  });
});

describe('dependenciesUnreachable', () => {
  it('is false when every dependency is still pending, not yet failed or skipped', () => {
    const run = makeRun({
      assignments: [
        makeAssignment({ id: 'a', status: 'pending' }),
        makeAssignment({ id: 'b', dependsOn: ['a'] }),
      ],
    });

    expect(dependenciesUnreachable(run, run.assignments[1]!)).toBe(false);
  });

  it('is true when a dependency failed', () => {
    const run = makeRun({
      assignments: [
        makeAssignment({ id: 'a', status: 'failed' }),
        makeAssignment({ id: 'b', dependsOn: ['a'] }),
      ],
    });

    expect(dependenciesUnreachable(run, run.assignments[1]!)).toBe(true);
  });
});
