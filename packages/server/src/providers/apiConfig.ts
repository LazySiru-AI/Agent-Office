import type { ProviderId } from './types.js';

/**
 * Where an HTTP provider's key, endpoint and model come from (Phase 7).
 *
 * One module rather than three, because the interesting part is not any single
 * provider's environment variable — it is the rule that a key is *never* read
 * anywhere except here. Everything downstream takes a resolved config object,
 * so there is exactly one place to audit when the question is "can a key reach
 * a log, an event, or the browser?".
 */

export interface ApiProviderConfig {
  /** Never logged, never serialised into an event. See `describeConfig`. */
  apiKey: string;
  /** Full origin, no trailing slash. Overridable for proxies and fakes. */
  baseUrl: string;
  model: string;
  /** Cap on a single response. Providers that require it get this value. */
  maxOutputTokens: number;
  /**
   * Where `model` came from.
   *
   * Recorded because "nobody chose this" and "somebody chose this" are different
   * facts with different consequences, and a bare string cannot tell them apart.
   * A catalog agent's own `model:` frontmatter should be honoured over a
   * fallback nobody asked for, and must *not* silently override an operator who
   * set `ANTHROPIC_MODEL` or passed `--model`. See {@link resolveAgentModel}.
   */
  modelSource: 'default' | 'environment' | 'override';
}

/**
 * Defaults per provider.
 *
 * The Anthropic model is pinned to Sonnet: it is the sensible default for a
 * roster of specialist agents doing focused work, and picking the largest model
 * by default would make an accidental run expensive.
 *
 * The OpenAI and DeepSeek model names are **guesses that have never been sent
 * to a live endpoint** — no key of any kind was available when this was
 * written. They are here so the adapter has something to send, not because they
 * are known good, and both are overridable by environment variable precisely
 * because they will probably need to be. Anything reading this should assume
 * the model name is the first thing to check when a real call fails.
 */
const DEFAULTS: Record<string, { baseUrl: string; model: string; keyVar: string }> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5',
    keyVar: 'ANTHROPIC_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o',
    keyVar: 'OPENAI_API_KEY',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyVar: 'DEEPSEEK_API_KEY',
  },
};

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Provider ids this module knows how to configure. */
export type ApiProviderId = Extract<ProviderId, 'anthropic' | 'openai' | 'deepseek'>;

export function isApiProviderId(id: string): id is ApiProviderId {
  return id === 'anthropic' || id === 'openai' || id === 'deepseek';
}

export interface ResolveConfigOptions {
  /** Injected so tests never depend on the machine's real environment. */
  env?: Record<string, string | undefined>;
  /** Explicit overrides, e.g. from the settings UI. Win over the environment. */
  overrides?: Partial<ApiProviderConfig>;
}

/**
 * Environment variables read, in order of precedence:
 *
 *   <PROVIDER>_API_KEY     the key. No default; absent means unavailable.
 *   <PROVIDER>_BASE_URL    endpoint override, for proxies and for the fake
 *                          server the tests run against.
 *   <PROVIDER>_MODEL       model override.
 *   AGENT_OFFICE_MAX_OUTPUT_TOKENS   applies to every provider.
 *
 * Returns `undefined` for the key when it is absent rather than throwing:
 * `isAvailable()` is the place that turns a missing key into a message a user
 * can act on, and throwing here would make a preflight check into a crash.
 */
export function resolveApiConfig(
  id: ApiProviderId,
  options: ResolveConfigOptions = {},
): ApiProviderConfig {
  const env = options.env ?? process.env;
  const defaults = DEFAULTS[id];
  if (defaults === undefined) {
    throw new Error(`resolveApiConfig: no defaults for provider "${id}"`);
  }

  const prefix = id.toUpperCase();
  const maxRaw = env['AGENT_OFFICE_MAX_OUTPUT_TOKENS'];
  const maxParsed = maxRaw === undefined ? Number.NaN : Number(maxRaw);

  const overriddenModel = options.overrides?.model;
  const envModel = env[`${prefix}_MODEL`];

  return {
    apiKey: options.overrides?.apiKey ?? env[defaults.keyVar] ?? '',
    baseUrl: stripTrailingSlash(
      options.overrides?.baseUrl ?? env[`${prefix}_BASE_URL`] ?? defaults.baseUrl,
    ),
    model: overriddenModel ?? envModel ?? defaults.model,
    modelSource:
      overriddenModel !== undefined ? 'override' : envModel !== undefined ? 'environment' : 'default',
    maxOutputTokens:
      options.overrides?.maxOutputTokens ??
      (Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : DEFAULT_MAX_OUTPUT_TOKENS),
  };
}

/**
 * Catalog `model:` aliases → concrete API model ids, per provider.
 *
 * The vendored catalog speaks in `sonnet`, `haiku` and `inherit`. Those are
 * Anthropic's words, and only Anthropic's API can be told what they mean —
 * hence the two empty maps. That emptiness is the honest answer rather than an
 * omission: there is no defensible `sonnet → gpt-…` mapping, because the
 * catalog's author was choosing a capability tier within one vendor's range,
 * not a tier in the abstract, and inventing a cross-vendor equivalence would
 * silently change which model a user's money goes to.
 *
 * These ids are exactly as unverified as {@link DEFAULTS}' — nothing here has
 * been sent to a live endpoint. `opus` appears despite no catalog agent using
 * it, because the frontmatter is free text and an agent tuned later may.
 */
const MODEL_ALIASES: Record<ApiProviderId, Record<string, string>> = {
  anthropic: {
    sonnet: 'claude-sonnet-5',
    haiku: 'claude-haiku-4-5-20251001',
    opus: 'claude-opus-5',
  },
  openai: {},
  deepseek: {},
};

/**
 * The catalog's own tier vocabulary — a small, closed set of words its
 * authors use to mean "some capability tier", never a real model id.
 * `MODEL_ALIASES` above already translates every one of these for Anthropic;
 * this set exists so {@link resolveAgentModel} can recognise the same words
 * when a *different* provider has no translation for them, and report that
 * rather than silently sending the word itself as a model id.
 *
 * Membership, not shape, is what makes something a tier word. The previous
 * version of this check used "contains a hyphen" as a stand-in for that, and
 * it was the wrong stand-in: `o1` and `o3` are real, hyphen-free model ids,
 * and that heuristic would have classed either as an unknown tier word,
 * silently substituted the provider default, and reported it as unhonoured —
 * exactly the outcome this function exists to avoid. Dormant today — the
 * catalog holds only `sonnet` (105 agents), `inherit` (25) and `haiku` (18),
 * none of which trip the bug — but live the moment a catalog agent names an
 * `o`-series model or any other hyphen-free id.
 */
const KNOWN_TIER_WORDS = new Set(['sonnet', 'haiku', 'opus']);

export interface AgentModelChoice {
  /** What to actually send. */
  model: string;
  /**
   * Set when the agent asked for a model this provider could not give it, with
   * a sentence explaining what was used instead.
   *
   * Deliberately returned rather than logged: running an agent on a model other
   * than the one its definition names changes what the run costs and how good
   * it is, so it belongs in front of the user, not in a server log. Adapters
   * surface it as a non-fatal `error` event — the same treatment
   * `claude-code/provider.ts` gives a tool it could not grant.
   */
  unhonoured?: string;
}

/**
 * Decide which model one assignment runs on.
 *
 * Precedence, strongest first:
 *
 *   1. an explicit provider-level model (`--model`, the settings panel, or
 *      `<PROVIDER>_MODEL`) — somebody stated what this run should use;
 *   2. the agent's catalog `model:`, translated through {@link MODEL_ALIASES};
 *   3. the provider default.
 *
 * `inherit` resolves to (3) with nothing reported, because that is precisely
 * what the catalog means by it. An untranslatable alias also resolves to (3),
 * but *is* reported: the difference between "the agent asked for nothing" and
 * "the agent asked for something it did not get" is the whole reason
 * {@link AgentModelChoice.unhonoured} exists.
 */
export function resolveAgentModel(
  id: ApiProviderId,
  config: ApiProviderConfig,
  agentModel: string | undefined,
): AgentModelChoice {
  if (agentModel === undefined || agentModel === 'inherit') return { model: config.model };

  if (config.modelSource !== 'default') {
    return {
      model: config.model,
      unhonoured:
        `this agent's catalog model "${agentModel}" was not used: ` +
        `the run explicitly specifies "${config.model}", which takes precedence.`,
    };
  }

  const mapped = MODEL_ALIASES[id][agentModel];
  if (mapped !== undefined) return { model: mapped };

  // A frontmatter value that is already a full model id is passed through: the
  // catalog is editable, and an agent tuned for a specific model should get it
  // rather than being second-guessed by a lookup table that has never heard of
  // it. "Not a known tier word" is the test, not "has a hyphen" — see
  // {@link KNOWN_TIER_WORDS}.
  if (!KNOWN_TIER_WORDS.has(agentModel)) return { model: agentModel };

  return {
    model: config.model,
    unhonoured:
      `this agent's catalog model "${agentModel}" means nothing to the ${id} API, ` +
      `so "${config.model}" was used instead. Catalog model tiers are Anthropic's ` +
      'vocabulary; there is no faithful equivalent here.',
  };
}

/** Which environment variable holds a given provider's key, for error messages. */
export function apiKeyVariable(id: ApiProviderId): string {
  return DEFAULTS[id]?.keyVar ?? `${id.toUpperCase()}_API_KEY`;
}

/**
 * A loggable view of a config, with the key reduced to its shape.
 *
 * Not `[redacted]`: when a run fails with a 401 the question is almost always
 * "which key did it use", and a length plus a four-character suffix answers it
 * without putting a working credential in a log file that gets pasted into an
 * issue.
 */
export function describeConfig(config: ApiProviderConfig): string {
  const key =
    config.apiKey === ''
      ? 'absent'
      : `${config.apiKey.length} chars ending ${config.apiKey.slice(-4)}`;
  return `baseUrl=${config.baseUrl} model=${config.model} maxOutputTokens=${config.maxOutputTokens} key=${key}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
