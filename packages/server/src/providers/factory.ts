import {
  MANAGER_PLAN_ASSIGNMENT_ID,
  MANAGER_SYNTHESIS_ASSIGNMENT_ID,
} from '../orchestrator/manager.js';
import { AnthropicProvider } from './anthropic/provider.js';
import { ClaudeCodeProvider } from './claude-code/provider.js';
import { OpenAiCompatibleProvider } from './openai/provider.js';
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
 * This once was narrower than `PROVIDER_IDS` — that list enumerates every id
 * the event/telemetry types know about, and for a while it included ids no
 * adapter existed for yet. The two now hold the same five members (they differ
 * only in order), because every declared id has an adapter. Kept as a separate
 * constant rather than aliased to `PROVIDER_IDS`: the next id will again be
 * declared for telemetry before it can be constructed, and the HTTP layer
 * quotes *this* list when it rejects a request, so a user is told what is
 * available rather than what is conceivable.
 */
export const AVAILABLE_PROVIDER_IDS = [
  'scripted',
  'claude-code',
  'anthropic',
  'openai',
  'deepseek',
] as const;

/**
 * What a run uses when nobody says otherwise.
 *
 * The local Claude Code CLI, because it is the one engine on this machine that
 * needs no key in a file — it uses the sign-in the user already has. The HTTP
 * adapters take over the moment `ANTHROPIC_API_KEY` and friends appear in
 * `.env`; until then they report themselves unavailable and the settings panel
 * shows why.
 *
 * This used to be `scripted`, which was right while there was nothing else that
 * worked and is wrong now: a default that quietly calls no model produces a
 * report full of placeholder text that looks like a finished run. The trade is
 * deliberate — the default now spends money — so every test that must not
 * spend passes `scripted` explicitly rather than relying on the default.
 */
export const DEFAULT_PROVIDER = 'claude-code';

/**
 * Ask every provider whether it could run, for `GET /api/providers` (Phase 7).
 *
 * Constructing each one is cheap and synchronous by contract, and
 * `isAvailable()` is documented to make no network call — so this is a fast
 * route that cannot hang. It asks the adapters rather than re-deriving
 * readiness from environment variables here, because a second copy of "what
 * does this provider need" would drift from the first the moment one changed.
 *
 * A provider that throws while being *constructed* is reported as unavailable
 * rather than failing the whole route: one broken adapter should not stop a
 * user seeing that the other four are fine.
 */
export async function probeProviders(
  knownAgentNames: ReadonlySet<string>,
): Promise<{ id: string; available: boolean; reason?: string }[]> {
  const probes = AVAILABLE_PROVIDER_IDS.map(async (id) => {
    try {
      const provider = makeProvider(id, 'readiness probe', knownAgentNames);
      const availability = await provider.isAvailable();
      return {
        id,
        available: availability.ok,
        ...(availability.reason === undefined ? {} : { reason: availability.reason }),
      };
    } catch (error) {
      return {
        id,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return Promise.all(probes);
}

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
   * Per-assignment spend ceiling (FR-M8). Ignored by the scripted provider,
   * which spends nothing. Unset means no cap.
   *
   * Every real adapter now acts on it, by two different mechanisms. The Claude
   * Code adapter forwards it to the CLI's own `--max-budget-usd`. The
   * `anthropic` and OpenAI-compatible adapters meter spend themselves against
   * `pricing.ts`, and refuse to run at all when the resolved model has no known
   * price — stricter than the CLI, and deliberately so: a cap that silently
   * does not apply is the defect this option exists to close.
   *
   * Per *assignment*, not per run. Nothing here accumulates across the
   * assignments of one run, so an N-assignment plan can spend up to N times
   * this value. See `supervisor.ts`, which passes one provider instance — and
   * therefore this one ceiling — to every invocation.
   */
  maxCostUsd?: number;

  /**
   * The run-wide model. Unset means each adapter's configured default.
   *
   * Provider-wide, and *not* the only way a model is chosen: `AgentRunRequest`
   * also carries the catalog's per-agent `model:` frontmatter, and every
   * adapter consumes it (`claude-code/provider.ts`'s `buildArgs`, and
   * `resolveAgentModel` for the `anthropic` and OpenAI-compatible adapters).
   * This option wins where both are set — a run-wide instruction outranks an
   * agent's standing preference — and each adapter reports the substitution
   * rather than applying it silently.
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

  if (id === 'openai' || id === 'deepseek') {
    // One adapter for both: DeepSeek serves the OpenAI Chat Completions shape,
    // and everything that differs between them — key variable, base URL, model
    // — is already absorbed by `resolveApiConfig`. A second near-identical file
    // would be two places to fix the next streaming bug.
    const providerOptions = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      // `OpenAiCompatibleProviderOptions.maxCostUsd` is declared now, so this is
      // a plain forward rather than the speculative one it used to be. The
      // adapter meters spend against `pricing.ts` itself and refuses to run an
      // unpriced model rather than run uncapped.
      ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    };
    return new OpenAiCompatibleProvider(id, providerOptions);
  }

  if (id === 'anthropic') {
    // Same reasoning as the OpenAI-compatible branch above: `maxCostUsd` is
    // declared by `AnthropicProviderOptions` and metered by the adapter itself.
    const providerOptions = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    };
    return new AnthropicProvider(providerOptions);
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
