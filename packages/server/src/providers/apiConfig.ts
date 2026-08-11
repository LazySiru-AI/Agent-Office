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

  return {
    apiKey: options.overrides?.apiKey ?? env[defaults.keyVar] ?? '',
    baseUrl: stripTrailingSlash(
      options.overrides?.baseUrl ?? env[`${prefix}_BASE_URL`] ?? defaults.baseUrl,
    ),
    model: options.overrides?.model ?? env[`${prefix}_MODEL`] ?? defaults.model,
    maxOutputTokens:
      options.overrides?.maxOutputTokens ??
      (Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : DEFAULT_MAX_OUTPUT_TOKENS),
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
