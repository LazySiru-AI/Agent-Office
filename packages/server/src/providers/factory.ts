import {
  MANAGER_PLAN_ASSIGNMENT_ID,
  MANAGER_SYNTHESIS_ASSIGNMENT_ID,
} from '../orchestrator/manager.js';
import { ScriptedProvider } from './scripted.js';
import type { AgentProvider } from './types.js';

/**
 * One place that turns a provider id into a live {@link AgentProvider}.
 *
 * This started life inside the run CLI. Phase 3 added a second caller (the HTTP
 * supervisor), and a second copy of the scripted Manager's canned plan would
 * have meant the browser and the CLI silently diverging the first time either
 * was tweaked — the exact class of bug the shared wire contract exists to
 * prevent. It lives under `providers/` rather than `scripts/` because a server
 * module importing from a CLI entrypoint would drag `process.argv` parsing into
 * the request path.
 */

/**
 * Domain presets for the scripted provider's canned plan.
 *
 * The scripted provider cannot reason, so the "Manager" has to be told which
 * team to field. Keyword matching is crude on purpose — its only job is to make
 * the no-cost dry run exercise more than one domain, which is the Phase 2 exit
 * criterion. A real provider ignores all of this.
 *
 * Every `lead`/`reviewers` name is checked against the registry before use.
 */
interface ScriptedDomain {
  domain: string;
  reportStyle: string;
  keywords: string[];
  lead: string;
  reviewers: string[];
}

const SCRIPTED_DOMAINS: ScriptedDomain[] = [
  {
    domain: 'legal',
    reportStyle: 'legal-memo',
    keywords: ['nda', 'contract', 'legal', 'clause', 'agreement', 'vendor', 'liability', 'terms'],
    lead: 'legal-advisor',
    reviewers: ['compliance-auditor', 'risk-manager'],
  },
  {
    domain: 'tax',
    reportStyle: 'advisory',
    keywords: ['tax', 'vat', 'deduction', 'filing', 'audit', 'accounting'],
    lead: 'business-analyst',
    reviewers: ['risk-manager', 'research-analyst'],
  },
  {
    domain: 'software',
    reportStyle: 'engineering',
    keywords: ['code', 'api', 'bug', 'refactor', 'auth', 'service', 'module', 'performance'],
    lead: 'backend-developer',
    reviewers: ['security-auditor', 'code-reviewer'],
  },
];

/** Used when the task matches no preset, and as the shape of every preset. */
const SCRIPTED_FALLBACK_DOMAIN: ScriptedDomain = {
  domain: 'general',
  reportStyle: 'briefing',
  keywords: [],
  lead: 'research-analyst',
  reviewers: ['business-analyst', 'technical-writer'],
};

function chooseScriptedDomain(task: string, known: ReadonlySet<string>): ScriptedDomain {
  const haystack = task.toLowerCase();
  const matched = SCRIPTED_DOMAINS.find((candidate) =>
    candidate.keywords.some((keyword) => haystack.includes(keyword)),
  );

  for (const candidate of [matched, SCRIPTED_FALLBACK_DOMAIN]) {
    if (candidate === undefined) continue;
    const team = [candidate.lead, ...candidate.reviewers];
    if (team.every((name) => known.has(name))) return candidate;
  }

  throw new Error(
    'the scripted provider\'s canned teams reference agents that are not in the registry. ' +
      'Update SCRIPTED_DOMAINS in src/providers/factory.ts.',
  );
}

/**
 * The plan the scripted "Manager" returns. Two phases with a real dependency
 * edge, so the dry run covers phase sequencing, `dependsOn` briefing and
 * intra-phase parallelism rather than just a flat fan-out.
 */
export function scriptedPlanJson(task: string, known: ReadonlySet<string>): string {
  const choice = chooseScriptedDomain(task, known);

  const plan = {
    summary: `Scripted dry run for: ${task}`,
    domain: choice.domain,
    reportStyle: choice.reportStyle,
    phases: [
      {
        id: 'analysis',
        name: 'Analysis',
        parallel: false,
        assignments: [
          {
            id: 'lead-analysis',
            agentName: choice.lead,
            objective: `Produce the primary analysis for: ${task}`,
            deliverable: `reports/01-${choice.lead}.md`,
            dependsOn: [],
          },
        ],
      },
      {
        id: 'review',
        name: 'Review',
        parallel: true,
        assignments: choice.reviewers.map((agentName, index) => ({
          id: `review-${index + 1}`,
          agentName,
          objective: `Review the primary analysis from a ${agentName} perspective.`,
          deliverable: `reports/0${index + 2}-${agentName}.md`,
          dependsOn: ['lead-analysis'],
        })),
      },
    ],
  };

  return JSON.stringify(plan, null, 2);
}

/**
 * Provider ids this build can actually construct.
 *
 * Deliberately narrower than `PROVIDER_IDS`, which enumerates every id the
 * event/telemetry types know about including ones no adapter exists for yet.
 * The HTTP layer quotes this list when it rejects a request, so a user who asks
 * for `anthropic` is told what is available instead of what is conceivable.
 */
export const AVAILABLE_PROVIDER_IDS = ['scripted'] as const;

/**
 * Build the provider for one run.
 *
 * `task` is needed because the scripted provider's plan is canned per task; a
 * real provider ignores it. `knownAgentNames` is the registry's roster, used to
 * keep the canned plan from naming an agent that does not exist — which would
 * fail plan validation rather than the run, and read as a Manager bug.
 */
export interface MakeProviderOptions {
  /**
   * Artificial per-event latency for the scripted provider, in milliseconds.
   *
   * A scripted run otherwise completes in well under a second, which makes the
   * live-status and reattach behaviour the UI exists to show (NFR-2, NFR-3)
   * impossible to observe or test by hand — the run is over before a refresh
   * can land. Slowing the fake provider down is the only way to exercise those
   * paths without spending real tokens, the same argument that justifies the
   * scripted provider itself. Ignored by real providers.
   */
  stepDelayMs?: number;
}

export function makeProvider(
  id: string,
  task: string,
  knownAgentNames: ReadonlySet<string>,
  options: MakeProviderOptions = {},
): AgentProvider {
  if (id === 'scripted') {
    const pace = options.stepDelayMs === undefined ? {} : { delayMs: options.stepDelayMs };
    // The Manager's planning and synthesis turns go through the provider too, so
    // a single placeholder for everything can never complete a run: planning
    // would get prose where it requires JSON and burn the whole repair budget.
    // Both manager turns are scripted by assignment id; agents get the fallback.
    return new ScriptedProvider({
      byAssignment: {
        [MANAGER_PLAN_ASSIGNMENT_ID]: {
          text: scriptedPlanJson(task, knownAgentNames),
          usage: { inputTokens: 1200, outputTokens: 400 },
          ...pace,
        },
        [MANAGER_SYNTHESIS_ASSIGNMENT_ID]: {
          text: [
            '# Scripted synthesis',
            '',
            'This document was assembled by the scripted provider. No model was',
            'called, so the section below is structural proof only — it shows the',
            'orchestrator collected every report and reached the synthesis step.',
            '',
            'Replace `--provider scripted` with a real provider once Phase 1 lands.',
          ].join('\n'),
          usage: { inputTokens: 2000, outputTokens: 600 },
          ...pace,
        },
      },
      fallback: {
        text: [
          '## Findings',
          '',
          'Placeholder report from the scripted provider. No model was called.',
          '',
          'Replace `--provider scripted` with a real provider once Phase 1 lands.',
        ].join('\n'),
        usage: { inputTokens: 500, outputTokens: 250 },
        ...pace,
      },
    });
  }

  if (id === 'claude-code') {
    throw new UnknownProviderError(
      'the claude-code provider is not implemented yet (Phase 1).\n' +
        'It is blocked on the Claude Code CLI not being installed — see SETUP.md.',
    );
  }

  throw new UnknownProviderError(
    `unknown provider "${id}". Known: ${AVAILABLE_PROVIDER_IDS.join(', ')}.`,
  );
}

/**
 * Raised when the requested provider id cannot be constructed.
 *
 * A distinct class because over HTTP this is a 400 (the caller asked for
 * something that does not exist) rather than a 500 (the server broke). A plain
 * `Error` would have to be told apart by its message, which is exactly the
 * fragility this avoids.
 */
export class UnknownProviderError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, UnknownProviderError.prototype);
    this.name = 'UnknownProviderError';
  }
}
