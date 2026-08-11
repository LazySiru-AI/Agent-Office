import { describe, expect, it } from 'vitest';
import type { AgentDef, AssignmentState, RunState } from '@agent-office/shared';
import { buildRegistry, type Registry } from '../registry/index.js';
import { buildRoster, estimateRunCostUsd } from './deliverable.js';

/**
 * Regression coverage for the confirmed defect: `produceDeliverable`'s one
 * production caller (`runner.ts`) never populates `DeliverableDeps.costUsd`,
 * so `ReportDocument.costUsd` was always `undefined` and every PDF cover
 * page showed "—" no matter what the run spent. `estimateRunCostUsd` is the
 * fallback `produceDeliverable` now falls back to when no caller-supplied
 * figure exists — this file tests that fallback directly, against the
 * registry and run shapes it actually reads, without needing a browser or a
 * live provider (that plumbing is what `produceDeliverable` itself wires up,
 * and is exercised — with `runner.ts` — separately).
 */

function agent(name: string, model?: string): AgentDef {
  return {
    name,
    description: `${name} does things.`,
    tools: ['Read'],
    category: '01-core-development',
    filePath: `categories/01-core-development/${name}.md`,
    systemPrompt: `${name.toUpperCase()}-BODY`,
    ...(model === undefined ? {} : { model }),
  };
}

function testRegistry(agents: AgentDef[]): Registry {
  return buildRegistry(agents);
}

function makeAssignment(
  overrides: Partial<AssignmentState> & Pick<AssignmentState, 'id' | 'agentName'>,
): AssignmentState {
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

describe('estimateRunCostUsd', () => {
  it('prices every assignment off its own catalog model — a real cost', () => {
    const registry = testRegistry([agent('writer', 'sonnet'), agent('reviewer', 'haiku')]);
    const run = makeRun({
      id: 'run-1',
      provider: 'claude-code',
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
    });

    expect(estimateRunCostUsd(run, registry)).toBeCloseTo(1.85, 6);
  });

  it('prices a scripted run at exactly zero, not undefined — a genuine zero', () => {
    const registry = testRegistry([agent('writer', 'sonnet')]);
    const run = makeRun({
      id: 'run-2',
      provider: 'scripted',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 100_000, outputTokens: 50_000 },
        }),
      ],
    });

    expect(estimateRunCostUsd(run, registry)).toBe(0);
  });

  it('returns undefined when nothing in the run can be priced — a genuine unknown', () => {
    const registry = testRegistry([agent('mystery')]); // no catalog model at all
    const run = makeRun({
      id: 'run-3',
      provider: 'openai',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'mystery',
          usage: { inputTokens: 1_000, outputTokens: 1_000 },
        }),
      ],
    });

    expect(estimateRunCostUsd(run, registry)).toBeUndefined();
  });

  it("adds the Manager's own usage exactly once, on top of the assignments' total", () => {
    const registry = testRegistry([agent('writer', 'sonnet')]);
    const run = makeRun({
      id: 'run-4',
      provider: 'claude-code',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 100_000, outputTokens: 0 }, // sonnet -> $0.30
        }),
      ],
      managerUsage: { inputTokens: 100_000, outputTokens: 0 }, // priced via free-provider check only
    });

    // The Manager has no agent and therefore no catalog model, so under a
    // real (non-free) provider its usage cannot be priced — it must not
    // silently vanish from the assignment total, nor be double-counted.
    expect(estimateRunCostUsd(run, registry)).toBeCloseTo(0.3, 6);
  });

  it("prices the Manager's usage at zero under a free provider, exactly once", () => {
    const registry = testRegistry([agent('writer', 'sonnet')]);
    const run = makeRun({
      id: 'run-5',
      provider: 'scripted',
      assignments: [
        makeAssignment({ id: 'a1', agentName: 'writer', usage: { inputTokens: 0, outputTokens: 0 } }),
      ],
      managerUsage: { inputTokens: 100_000, outputTokens: 50_000 },
    });

    expect(estimateRunCostUsd(run, registry)).toBe(0);
  });

  it('falls through to the catalog model when the run has no recorded provider', () => {
    const registry = testRegistry([agent('writer', 'haiku')]);
    const run = makeRun({
      id: 'run-6',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
        }),
      ],
    });

    expect(estimateRunCostUsd(run, registry)).toBeCloseTo(0.8, 6);
  });
});

describe('buildRoster', () => {
  it('includes an entry for a failed assignment, not just successes (FR-P4)', () => {
    const registry = testRegistry([agent('writer', 'sonnet')]);
    const run = makeRun({
      id: 'run-7',
      assignments: [
        makeAssignment({ id: 'a1', agentName: 'writer', status: 'failed', error: 'boom' }),
      ],
    });

    const roster = buildRoster(run, registry);
    expect(roster).toEqual([
      { agentName: 'writer', category: '01-core-development', role: 'Do the work', status: 'failed' },
    ]);
  });

  it('falls back to "unknown" category for an agent no longer in the registry', () => {
    const registry = testRegistry([]);
    const run = makeRun({
      id: 'run-8',
      assignments: [makeAssignment({ id: 'a1', agentName: 'renamed-or-removed' })],
    });

    const roster = buildRoster(run, registry);
    expect(roster[0]?.category).toBe('unknown');
  });
});
