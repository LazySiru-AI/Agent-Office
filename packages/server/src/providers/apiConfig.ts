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
 *                          server the tests run against. Validated by
 *                          {@link validateBaseUrl} (AO-9) before use: this
 *                          becomes the origin a request carrying `apiKey`
 *                          is sent to, so an unchecked value here is a key
 *                          exfiltration path, not just a routing knob.
 *   <PROVIDER>_MODEL       model override.
 *   AGENT_OFFICE_MAX_OUTPUT_TOKENS   applies to every provider.
 *
 * Returns `undefined` for the key when it is absent rather than throwing:
 * `isAvailable()` is the place that turns a missing key into a message a user
 * can act on, and throwing here would make a preflight check into a crash.
 * The base URL is held to a stricter standard than the key: an absent key is
 * an ordinary, expected state (not every provider is configured), but a base
 * URL that resolves to something dangerous is a misconfiguration that should
 * fail immediately rather than quietly send credentials somewhere unintended.
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

  const rawBaseUrl = options.overrides?.baseUrl ?? env[`${prefix}_BASE_URL`] ?? defaults.baseUrl;
  const envVarName = `${prefix}_BASE_URL`;
  // Overrides come from the settings UI, not the environment, so a bad value
  // there is validated the same way — see `validateBaseUrl`'s doc comment for
  // why "which var name to name in the error" still matters even though an
  // override did not literally come from `env[envVarName]`.
  const baseUrl = stripTrailingSlash(validateBaseUrl(rawBaseUrl, envVarName));

  return {
    apiKey: options.overrides?.apiKey ?? env[defaults.keyVar] ?? '',
    baseUrl,
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

/** Loopback hostnames a local model server (Ollama, LM Studio, …) is reachable on. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Validate a `<PROVIDER>_BASE_URL` value before it is ever used as the origin
 * for a request that carries `x-api-key` / `Bearer` credentials (AO-9).
 *
 * `resolveApiConfig` used to pass this value through `stripTrailingSlash` and
 * nowhere else — an operator (or, per the AO-1 finding, anything that can
 * write `.env`) could point a provider's requests at any host at all, and the
 * key would go with them. `https://` is accepted for any host: TLS means
 * neither the key nor the response can be read in transit even if the host
 * turns out to be the wrong one. `http://` is accepted only for loopback
 * (`127.0.0.1`, `::1`, `localhost`) — local model servers such as Ollama and
 * LM Studio are a real, common setup that only ever speaks plain HTTP on the
 * machine's own loopback interface, and rejecting them would break a
 * legitimate workflow in order to close a threat loopback traffic does not
 * present: it never reaches a network link, so there is nothing on the wire
 * to intercept and nowhere for a key to be exfiltrated to. `http://` to any
 * other host is rejected outright — it would hand the key and the request
 * body to whatever is listening at that address in the clear, and to
 * whatever a DNS answer resolves the hostname to, which the person setting
 * the variable does not control.
 *
 * Three more things a URL can smuggle, each rejected explicitly rather than
 * left to accident:
 *   - a scheme other than `http:`/`https:` (`file:`, `javascript:`, `data:`,
 *     an unrecognised custom scheme, …) — this value is only ever used as a
 *     `fetch` request origin, so anything else is either inert or a sign the
 *     variable does not hold what its name says it does.
 *   - a URL that parses but names no host — there is nothing to send a
 *     request to, and silently falling back to the provider default would
 *     hide a real misconfiguration rather than report it. In practice the
 *     WHATWG `URL` parser already refuses to produce an empty host for
 *     `http:`/`https:` (it throws instead, landing in the catch above), so
 *     this check is defence-in-depth against that guarantee changing or
 *     being relied on incorrectly, not a path exercised by any input found
 *     during this fix.
 *   - userinfo embedded in the URL (`https://user:pass@host`) — the host a
 *     reader *sees* is not reliably the host a request actually reaches
 *     (`https://api.anthropic.com@attacker.example` sends the request to
 *     `attacker.example`), which is the classic URL-phishing trick, and it
 *     has no legitimate use here: a proxy that needs credentials takes them
 *     in a header, not embedded in the origin.
 *
 * Throws rather than returning a sentinel or silently falling back to the
 * default: a misconfigured base URL should fail loudly at config-resolution
 * time with a message naming the exact variable, not surface later as "why
 * did my key end up at attacker.example" with nothing pointing at the cause.
 */
export function validateBaseUrl(rawValue: string, envVarName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(
      `${envVarName} is set to "${rawValue}", which is not a valid URL. Set it to a full origin such as ` +
        '"https://api.example.com" or, for a local model server, "http://127.0.0.1:PORT".',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `${envVarName} is set to "${rawValue}", which uses the "${parsed.protocol}" scheme. Only https:// ` +
        '(any host) and http:// (loopback only) are accepted.',
    );
  }

  if (parsed.hostname === '') {
    throw new Error(`${envVarName} is set to "${rawValue}", which names no host to send requests to.`);
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `${envVarName} is set to "${rawValue}", which embeds credentials in the URL itself. This is rejected ` +
        'because the visible host is not reliably the host a request actually reaches; if a proxy needs ' +
        'credentials, supply them via a header, not the URL.',
    );
  }

  if (parsed.protocol === 'https:') {
    return rawValue;
  }

  // A bracketed IPv6 literal keeps its brackets in `URL#hostname` (e.g.
  // "[::1]"), unlike every other host form — stripped here so the loopback
  // set only has to name the bare address once.
  const bareHostname =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  if (LOOPBACK_HOSTNAMES.has(bareHostname.toLowerCase())) {
    return rawValue;
  }

  throw new Error(
    `${envVarName} is set to "${rawValue}", which uses plain http:// to a non-loopback host. This would send ` +
      'the API key in the clear to that host. Use https://, or http:// only to 127.0.0.1, ::1, or localhost ' +
      'for a local model server (e.g. Ollama, LM Studio).',
  );
}
