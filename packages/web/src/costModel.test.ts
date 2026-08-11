import { describe, expect, it } from 'vitest';
import type { AssignmentState, RunState } from '@agent-office/shared';
import {
  assignmentCostUsd,
  buildAgentModelIndex,
  effectiveModelFor,
  summariseRunCost,
} from './costModel.js';

/**
 * Regression coverage for the defect verified against the real modules: a
 * `claude-code` (or `anthropic` / `openai` / `deepseek`) run priced every
 * assignment as unpriced because `effectiveModelFor` substituted the
 * provider id for the pricing key. `DEFAULT_PRICING` in `wire.ts` is keyed
 * by CATALOG MODEL names (`sonnet` / `haiku` / `opus`), not provider ids, so
 * that substitution made `DEFAULT_PRICING['claude-code']` — always
 * `undefined` — the price for every real-provider run. This file constructs
 * `AssignmentState`/`RunState` in full rather than casting from a partial,
 * for the same reason `runHistory.test.ts` does: a cast would hide a
 * required field and let a test pass against a shape the server never sends.
 */

function makeAssignment(overrides: Partial<AssignmentState> & Pick<AssignmentState, 'id' | 'agentName'>): AssignmentState {
  return {
    phaseId: 'phase-1',
    objective: 'Do the work',
    deliverable: 'A report',
    dependsOn: [],
    status: 'done',
    attempts: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunState> & Pick<RunState, 'id' | 'assignments'>): RunState {
  return {
    task: 'Do something',
    status: 'done',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('effectiveModelFor', () => {
  it('prices a scripted run as free regardless of the catalog model', () => {
    const assignment = makeAssignment({ id: 'a1', agentName: 'writer' });
    const agentModelByName = new Map([['writer', 'sonnet']]);
    expect(effectiveModelFor(assignment, agentModelByName, 'scripted')).toBe('scripted');
  });

  it('prices a run with no recorded provider as free when it names "none"', () => {
    const assignment = makeAssignment({ id: 'a1', agentName: 'writer' });
    const agentModelByName = new Map([['writer', 'sonnet']]);
    expect(effectiveModelFor(assignment, agentModelByName, 'none')).toBe('none');
  });

  it.each(['claude-code', 'anthropic', 'openai', 'deepseek'])(
    'falls through to the agent catalog model for the real provider %s, rather than using the provider id as the pricing key',
    (provider) => {
      const assignment = makeAssignment({ id: 'a1', agentName: 'writer' });
      const agentModelByName = new Map([['writer', 'sonnet']]);
      expect(effectiveModelFor(assignment, agentModelByName, provider)).toBe('sonnet');
    },
  );

  it('falls through to the catalog model when no provider was recorded on the run', () => {
    const assignment = makeAssignment({ id: 'a1', agentName: 'writer' });
    const agentModelByName = new Map([['writer', 'haiku']]);
    expect(effectiveModelFor(assignment, agentModelByName, undefined)).toBe('haiku');
  });
});

describe('assignmentCostUsd', () => {
  it('prices a real-provider run off the catalog model — the confirmed defect', () => {
    // Reviewer evidence: a claude-code run, 100,000 input / 50,000 output
    // tokens, agent's catalog model sonnet ($3/$15 per Mtok), yields $1.05.
    // Before the fix this returned undefined because `DEFAULT_PRICING`
    // has no `claude-code` entry.
    const assignment = makeAssignment({
      id: 'a1',
      agentName: 'writer',
      usage: { inputTokens: 100_000, outputTokens: 50_000 },
    });
    const agentModelByName = new Map([['writer', 'sonnet']]);
    expect(assignmentCostUsd(assignment, agentModelByName, 'claude-code')).toBeCloseTo(1.05, 6);
  });

  it('matches the price of an unset provider for the same assignment', () => {
    const assignment = makeAssignment({
      id: 'a1',
      agentName: 'writer',
      usage: { inputTokens: 100_000, outputTokens: 50_000 },
    });
    const agentModelByName = new Map([['writer', 'sonnet']]);
    const withProvider = assignmentCostUsd(assignment, agentModelByName, 'claude-code');
    const withoutProvider = assignmentCostUsd(assignment, agentModelByName, undefined);
    expect(withProvider).toBe(withoutProvider);
  });

  it('reports undefined for an agent whose catalog model carries no price', () => {
    const assignment = makeAssignment({
      id: 'a1',
      agentName: 'mystery',
      usage: { inputTokens: 1_000, outputTokens: 1_000 },
    });
    const agentModelByName = new Map([['mystery', 'gpt-5-nonexistent']]);
    expect(assignmentCostUsd(assignment, agentModelByName, 'openai')).toBeUndefined();
  });

  it('reports undefined for an agent absent from the roster index', () => {
    const assignment = makeAssignment({
      id: 'a1',
      agentName: 'ghost',
      usage: { inputTokens: 1_000, outputTokens: 1_000 },
    });
    expect(assignmentCostUsd(assignment, new Map(), 'anthropic')).toBeUndefined();
  });
});

describe('summariseRunCost', () => {
  it('prices every assignment off its own catalog model under a real provider', () => {
    const run = makeRun({
      id: 'run-1',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 100_000, outputTokens: 50_000 }, // sonnet -> $1.05
        }),
        makeAssignment({
          id: 'a2',
          agentName: 'reviewer',
          usage: { inputTokens: 1_000_000, outputTokens: 0 }, // haiku -> $0.80
        }),
      ],
      provider: 'claude-code',
    });
    const agentModelByName = new Map([
      ['writer', 'sonnet'],
      ['reviewer', 'haiku'],
    ]);

    const summary = summariseRunCost(run, agentModelByName, run.provider);
    expect(summary.partial).toBe(false);
    expect(summary.costUsd).toBeCloseTo(1.85, 6);
  });

  it('prices a scripted run at exactly zero, even though the agents have priced catalog models', () => {
    const run = makeRun({
      id: 'run-2',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 100_000, outputTokens: 50_000 },
        }),
      ],
      provider: 'scripted',
    });
    const agentModelByName = new Map([['writer', 'sonnet']]);

    const summary = summariseRunCost(run, agentModelByName, run.provider);
    expect(summary.costUsd).toBe(0);
    expect(summary.partial).toBe(false);
  });

  it('marks the run partial when an assignment spent tokens on an unpriced model', () => {
    const run = makeRun({
      id: 'run-3',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 100_000, outputTokens: 50_000 },
        }),
        makeAssignment({
          id: 'a2',
          agentName: 'experimental',
          usage: { inputTokens: 500, outputTokens: 500 },
        }),
      ],
      provider: 'openai',
    });
    const agentModelByName = new Map([
      ['writer', 'sonnet'],
      ['experimental', 'some-unpriced-model'],
    ]);

    const summary = summariseRunCost(run, agentModelByName, run.provider);
    expect(summary.partial).toBe(true);
    // The priced assignment's contribution must not be lost just because a
    // sibling assignment could not be priced.
    expect(summary.costUsd).toBeCloseTo(1.05, 6);
  });

  it("adds the Manager's own usage exactly once, on top of the assignments' total", () => {
    const run = makeRun({
      id: 'run-4',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 100_000, outputTokens: 0 }, // sonnet -> $0.30
        }),
      ],
      managerUsage: { inputTokens: 100_000, outputTokens: 0 }, // sonnet -> $0.30
      provider: 'scripted',
    });
    const agentModelByName = new Map([['writer', 'sonnet']]);

    // The run provider is `scripted`, so both the assignment and the
    // Manager's own turns price at zero — but the Manager's usage still
    // counts once towards the reported token total, not zero and not twice.
    const summary = summariseRunCost(run, agentModelByName, run.provider);
    expect(summary.usage).toEqual({ inputTokens: 200_000, outputTokens: 0 });
    expect(summary.costUsd).toBe(0);
  });

  it("prices the Manager's usage off the run provider being free, separately from the assignment total, without double-counting", () => {
    const run = makeRun({
      id: 'run-5',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      ],
      managerUsage: { inputTokens: 100_000, outputTokens: 50_000 },
      provider: 'scripted',
    });
    const agentModelByName = new Map([['writer', 'sonnet']]);

    const summary = summariseRunCost(run, agentModelByName, run.provider);
    // Priced exactly once: if the Manager's cost were added twice this would
    // be nonzero even under a free provider.
    expect(summary.costUsd).toBe(0);
  });
});
