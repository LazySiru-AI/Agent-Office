import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RunPlanSchema, validatePlanAgainstRegistry } from '@agent-office/shared';
import { loadRegistry } from '../registry/index.js';
import { scriptedPlanJson } from './factory.js';

/**
 * The scripted "Manager" and its domain routing (Phase 6).
 *
 * The scripted provider cannot reason, so its canned plan is the only routing
 * this project can exercise without spending money on a model. That makes it
 * worth testing carefully rather than dismissing as a stopgap: it is what the
 * no-cost dry run, the browser demo and every orchestrator test actually run
 * through, and a plan it emits that fails validation would break all three at
 * once.
 *
 * The five tasks below are the Phase 6 domain matrix. They are deliberately
 * phrased the way a person would phrase them, not seeded with the preset's own
 * keywords — a routing test written against its own vocabulary proves nothing.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Loaded once: the real catalog is 156 files and re-reading it per test is slow. */
const registryPromise = loadRegistry(REPO_ROOT);

interface DomainCase {
  label: string;
  task: string;
  expectedDomain: string;
  /** The lead, plus every reviewer — the whole team, in plan order. */
  expectedTeam: string[];
}

const DOMAIN_MATRIX: DomainCase[] = [
  {
    label: 'software',
    task: 'Review the payments service for authentication bugs and refactor the retry logic',
    expectedDomain: 'software',
    expectedTeam: ['backend-developer', 'security-auditor', 'code-reviewer'],
  },
  {
    label: 'legal',
    task: 'Review our vendor NDA for unusual liability and termination terms',
    expectedDomain: 'legal',
    expectedTeam: ['legal-advisor', 'compliance-auditor', 'risk-manager'],
  },
  {
    label: 'tax',
    task: 'We are opening a subsidiary in Ireland — what are the corporation tax and VAT registration consequences?',
    expectedDomain: 'tax',
    expectedTeam: ['tax-advisor', 'tax-compliance-specialist', 'risk-manager'],
  },
  {
    label: 'research',
    task: 'Survey the published literature on retrieval-augmented generation and summarise the state of the art',
    expectedDomain: 'research',
    expectedTeam: ['research-analyst', 'data-researcher', 'competitive-analyst'],
  },
  {
    label: 'product',
    task: 'Prioritise the Q3 roadmap and define success metrics for the new onboarding flow',
    expectedDomain: 'product',
    expectedTeam: ['product-manager', 'ux-researcher', 'business-analyst'],
  },
];

describe('the scripted domain matrix (Phase 6)', () => {
  for (const scenario of DOMAIN_MATRIX) {
    it(`routes a ${scenario.label} task to the ${scenario.label} team`, async () => {
      const registry = await registryPromise;
      const known = new Set(registry.byName.keys());

      const plan = RunPlanSchema.parse(JSON.parse(scriptedPlanJson(scenario.task, known)));

      expect(plan.domain).toBe(scenario.expectedDomain);
      const team = plan.phases.flatMap((phase) => phase.assignments.map((a) => a.agentName));
      expect(team).toEqual(scenario.expectedTeam);
    });
  }

  it('emits a plan that passes the same validation the Manager’s output must pass', async () => {
    // The scripted plan takes a different code path to a model's, but it is fed
    // into the identical validator. If these ever diverge, every scripted test
    // in the project is exercising something the real pipeline would reject.
    const registry = await registryPromise;
    const known = new Set(registry.byName.keys());

    for (const scenario of DOMAIN_MATRIX) {
      const plan = RunPlanSchema.parse(JSON.parse(scriptedPlanJson(scenario.task, known)));
      const unknown = validatePlanAgainstRegistry(plan, [...known]);
      expect(unknown, `${scenario.label} plan names an agent outside the registry`).toEqual([]);
    }
  });
});

describe('keyword matching is on whole words, not substrings', () => {
  // The matcher this replaced used `String.includes`, which is true of "tax" in
  // "syntax" and "vat" in "elevator". A task about a syntax error would have
  // been handed to the tax team. These are the regressions worth pinning.
  const substringTraps: { task: string; mustNotBe: string }[] = [
    { task: 'Fix the syntax errors in the template parser', mustNotBe: 'tax' },
    { task: 'The elevator telemetry dashboard drops events', mustNotBe: 'tax' },
  ];

  for (const trap of substringTraps) {
    it(`does not route "${trap.task}" to ${trap.mustNotBe}`, async () => {
      const registry = await registryPromise;
      const known = new Set(registry.byName.keys());
      const plan = RunPlanSchema.parse(JSON.parse(scriptedPlanJson(trap.task, known)));
      expect(plan.domain).not.toBe(trap.mustNotBe);
    });
  }
});

describe('a preset naming an agent that does not exist', () => {
  it('throws and names the missing agent rather than quietly fielding another team', async () => {
    const registry = await registryPromise;
    // Every agent except the tax lead, so the tax preset is broken but the
    // fallback team is still intact — the case where silently degrading would
    // have looked like success.
    const known = new Set(registry.byName.keys());
    known.delete('tax-advisor');

    expect(() =>
      scriptedPlanJson('What are the corporation tax consequences of the merger?', known),
    ).toThrow(/tax-advisor/);
  });

  it('throws when even the fallback team is unavailable', () => {
    expect(() => scriptedPlanJson('something entirely unclassifiable', new Set())).toThrow(
      /fallback team/,
    );
  });
});
