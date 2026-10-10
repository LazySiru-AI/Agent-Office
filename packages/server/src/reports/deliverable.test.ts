import { describe, expect, it } from 'vitest';
import type { AgentDef, AssignmentState, RunState } from '@agent-office/shared';
import { buildRegistry, type Registry } from '../registry/index.js';
import { buildRoster, estimateRunCostUsd, formatCategoryLabel, trimRoleForCover } from './deliverable.js';

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

  it('D1: prices a model-floor-raised assignment as sonnet, not the cheaper catalog word', () => {
    // The registry still says `haiku` — the catalog file is never rewritten
    // (`modelPolicy.ts` clamps, it does not overwrite) — but the assignment
    // itself recorded `sonnet` as what actually ran, and that must win.
    const registry = testRegistry([agent('cheap', 'haiku')]);
    const run = makeRun({
      id: 'run-10',
      provider: 'claude-code',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'cheap',
          model: 'sonnet',
          usage: { inputTokens: 1_000_000, outputTokens: 0 }, // sonnet -> $3.00, haiku -> $0.80
        }),
      ],
    });

    expect(estimateRunCostUsd(run, registry)).toBeCloseTo(3.0, 6);
  });

  it('D1: falls back to the catalog model when assignment.model is absent — an old run.json', () => {
    const registry = testRegistry([agent('cheap', 'haiku')]);
    const run = makeRun({
      id: 'run-11',
      provider: 'claude-code',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'cheap',
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
        }),
      ],
    });

    expect(estimateRunCostUsd(run, registry)).toBeCloseTo(0.8, 6);
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
      { agentName: 'writer', category: 'Core Development', role: 'Do the work', status: 'failed' },
    ]);
  });

  it('falls back to a humanised "Unknown" category for an agent no longer in the registry', () => {
    const registry = testRegistry([]);
    const run = makeRun({
      id: 'run-8',
      assignments: [makeAssignment({ id: 'a1', agentName: 'renamed-or-removed' })],
    });

    const roster = buildRoster(run, registry);
    expect(roster[0]?.category).toBe('Unknown');
  });

  it('trims a multi-sentence objective to its first sentence, not the raw text (Doc2)', () => {
    const registry = testRegistry([agent('writer', 'sonnet')]);
    const run = makeRun({
      id: 'run-9',
      assignments: [
        makeAssignment({
          id: 'a1',
          agentName: 'writer',
          objective:
            'Investigate the authentication flow end to end. Then write up every finding in detail, ' +
            'covering session handling, token refresh, and the logout path as well.',
        }),
      ],
    });

    const roster = buildRoster(run, registry);
    expect(roster[0]?.role).toBe('Investigate the authentication flow end to end.');
  });

  it('maps every numbered category slug to a readable label, not the raw directory name (Doc5)', () => {
    // The full closed set from `categories/` at the repo root, so a renamed
    // or newly added category directory that this map has not caught up with
    // is caught here rather than by a cover page nobody is looking at.
    expect(formatCategoryLabel('01-core-development')).toBe('Core Development');
    expect(formatCategoryLabel('02-language-specialists')).toBe('Language Specialists');
    expect(formatCategoryLabel('03-infrastructure')).toBe('Infrastructure');
    expect(formatCategoryLabel('04-quality-security')).toBe('Quality & Security');
    expect(formatCategoryLabel('05-data-ai')).toBe('Data & AI');
    expect(formatCategoryLabel('06-developer-experience')).toBe('Developer Experience');
    expect(formatCategoryLabel('07-specialized-domains')).toBe('Specialized Domains');
    expect(formatCategoryLabel('08-business-product')).toBe('Business & Product');
    expect(formatCategoryLabel('09-meta-orchestration')).toBe('Meta & Orchestration');
    expect(formatCategoryLabel('10-research-analysis')).toBe('Research & Analysis');
  });
});

describe('trimRoleForCover', () => {
  it('leaves a short, already-single-sentence objective untouched', () => {
    expect(trimRoleForCover('Investigate the auth flow.')).toBe('Investigate the auth flow.');
  });

  it('leaves an objective with no terminal punctuation untouched when it fits the budget', () => {
    expect(trimRoleForCover('Investigate the auth flow')).toBe('Investigate the auth flow');
  });

  it('cuts a long single sentence on a word boundary and marks the cut', () => {
    const objective =
      'Investigate every layer of the authentication and authorization subsystem across ' +
      'the whole monorepo, including third-party integrations, and write up every finding';
    const result = trimRoleForCover(objective);
    expect(result.length).toBeLessThanOrEqual(101); // 100-char budget + the ellipsis mark
    expect(result.endsWith('…')).toBe(true);
    expect(result.endsWith(' …')).toBe(false); // cut on a word boundary, no trailing space
  });
});
