import {
  MANAGER_PLAN_ASSIGNMENT_ID,
  MANAGER_SYNTHESIS_ASSIGNMENT_ID,
} from '../orchestrator/manager.js';
import { ClaudeCodeProvider } from './claude-code/provider.js';
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
    // Until Phase 6 this preset fielded `business-analyst` as its lead, because
    // the catalog had no tax specialist at all — a general analyst standing in
    // for one was the most visible symptom of that gap. `tax-advisor` and
    // `tax-compliance-specialist` now exist, and the pairing mirrors legal's:
    // one agent takes the position, the other owns what must be filed.
    domain: 'tax',
    reportStyle: 'advisory',
    keywords: ['tax', 'vat', 'gst', 'deduction', 'filing', 'withholding', 'accounting'],
    lead: 'tax-advisor',
    reviewers: ['tax-compliance-specialist', 'risk-manager'],
  },
  {
    domain: 'software',
    reportStyle: 'engineering',
    keywords: ['code', 'api', 'bug', 'refactor', 'auth', 'service', 'module', 'performance'],
    lead: 'backend-developer',
    reviewers: ['security-auditor', 'code-reviewer'],
  },
  {
    domain: 'research',
    reportStyle: 'research-brief',
    keywords: ['research', 'literature', 'survey', 'state of the art', 'study', 'evidence'],
    lead: 'research-analyst',
    reviewers: ['data-researcher', 'competitive-analyst'],
  },
  {
    domain: 'product',
    reportStyle: 'briefing',
    keywords: ['roadmap', 'backlog', 'onboarding', 'feature', 'user', 'metrics', 'launch'],
    lead: 'product-manager',
    reviewers: ['ux-researcher', 'business-analyst'],
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

/**
 * Whole-word keyword match, not substring.
 *
 * `includes('tax')` is true of "syntax", and `includes('vat')` of "elevator" —
 * so the crude matcher this replaced would field a tax team for a task about
 * syntax errors. The matching is still deliberately simple (a real provider
 * ignores all of this), but "simple" should not mean "wrong in a way that is
 * funny only until someone trusts it".
 *
 * Multi-word keywords are matched as phrases, with the same boundary rule at
 * each end.
 */
function mentions(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(haystack);
}

function chooseScriptedDomain(task: string, known: ReadonlySet<string>): ScriptedDomain {
  const haystack = task.toLowerCase();
  const matched = SCRIPTED_DOMAINS.find((candidate) =>
    candidate.keywords.some((keyword) => mentions(haystack, keyword)),
  );

  // A preset whose team is missing from the registry is a bug in the preset, not
  // a reason to quietly field a different team. The catalog is vendored and
  // fixed, so an unknown name here means someone renamed an agent or mistyped
  // one — and silently falling back would hide exactly the routing defect this
  // phase exists to find. Only "no preset matched" legitimately falls back.
  if (matched !== undefined) {
    const missing = [matched.lead, ...matched.reviewers].filter((name) => !known.has(name));
    if (missing.length > 0) {
      throw new Error(
        `the scripted "${matched.domain}" team names agents that are not in the registry: ` +
          `${missing.join(', ')}. Update SCRIPTED_DOMAINS in src/providers/factory.ts.`,
      );
    }
    return matched;
  }

  const fallbackTeam = [SCRIPTED_FALLBACK_DOMAIN.lead, ...SCRIPTED_FALLBACK_DOMAIN.reviewers];
  const missingFallback = fallbackTeam.filter((name) => !known.has(name));
  if (missingFallback.length > 0) {
    throw new Error(
      "the scripted provider's fallback team references agents that are not in the registry: " +
        `${missingFallback.join(', ')}. Update SCRIPTED_FALLBACK_DOMAIN in src/providers/factory.ts.`,
    );
  }
  return SCRIPTED_FALLBACK_DOMAIN;
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
export const AVAILABLE_PROVIDER_IDS = ['scripted', 'claude-code'] as const;

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

  /**
   * Per-assignment spend ceiling handed to the Claude Code CLI's own
   * `--max-budget-usd` (FR-M8). Ignored by the scripted provider, which spends
   * nothing. Unset means no cap, which is the CLI's own default.
   */
  maxCostUsd?: number;

  /**
   * Passed to `--model`. Unset means the CLI's configured default.
   *
   * Provider-wide rather than per-agent: `AgentRunRequest` carries no model, so
   * the catalog's per-agent `model:` frontmatter cannot reach the adapter yet.
   * See the note in `claude-code/provider.ts`.
   */
  model?: string;

  /** Surface for adapter-level diagnostics that are not agent events. */
  onDiagnostic?: (message: string) => void;
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
    // Availability is deliberately not checked here. Construction must stay
    // synchronous and cheap — the HTTP layer builds a provider inside a request
    // handler — and the preflight is an async probe that spawns the CLI. The
    // orchestrator calls `isAvailable()` before dispatching, which is where an
    // unauthenticated CLI surfaces as a clear reason rather than a mid-run
    // failure (NFR-8).
    return new ClaudeCodeProvider({
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
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
