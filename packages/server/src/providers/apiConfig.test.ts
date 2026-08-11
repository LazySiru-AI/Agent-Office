import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  apiKeyVariable,
  describeConfig,
  isApiProviderId,
  resolveAgentModel,
  resolveApiConfig,
  type ApiProviderConfig,
  type ApiProviderId,
} from './apiConfig.js';

/**
 * Config resolution, and the one rule that matters most in it: a key must never
 * reach a log, an event, or the browser.
 *
 * Every assertion about `describeConfig` below is a security assertion wearing
 * ordinary clothes. The reason this module exists at all is so there is exactly
 * one place to check that question, and these are the checks.
 */

const NO_ENV: Record<string, string | undefined> = {};

describe('resolveApiConfig — defaults', () => {
  it('gives each provider its own endpoint and key variable', () => {
    expect(resolveApiConfig('anthropic', { env: NO_ENV }).baseUrl).toBe('https://api.anthropic.com');
    expect(resolveApiConfig('openai', { env: NO_ENV }).baseUrl).toBe('https://api.openai.com');
    expect(resolveApiConfig('deepseek', { env: NO_ENV }).baseUrl).toBe('https://api.deepseek.com');

    expect(apiKeyVariable('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(apiKeyVariable('openai')).toBe('OPENAI_API_KEY');
    expect(apiKeyVariable('deepseek')).toBe('DEEPSEEK_API_KEY');
  });

  it('returns an empty key rather than throwing when none is set', () => {
    // `isAvailable()` is where a missing key becomes a message a user can act
    // on. Throwing here would turn a preflight check into a crash.
    expect(resolveApiConfig('anthropic', { env: NO_ENV }).apiKey).toBe('');
  });

  it('defaults Anthropic to Sonnet rather than the largest model', () => {
    // An accidental run should not be expensive by default.
    expect(resolveApiConfig('anthropic', { env: NO_ENV }).model).toBe('claude-sonnet-5');
  });

  it('applies the shared output-token cap', () => {
    expect(resolveApiConfig('openai', { env: NO_ENV }).maxOutputTokens).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS,
    );
  });
});

describe('resolveApiConfig — environment', () => {
  it('reads the key, endpoint and model from per-provider variables', () => {
    const config = resolveApiConfig('anthropic', {
      env: {
        ANTHROPIC_API_KEY: 'sk-test-abcd',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
        ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
      },
    });

    expect(config.apiKey).toBe('sk-test-abcd');
    expect(config.baseUrl).toBe('http://127.0.0.1:9999');
    expect(config.model).toBe('claude-haiku-4-5-20251001');
  });

  it('does not let one provider’s variables leak into another', () => {
    const config = resolveApiConfig('openai', {
      env: { ANTHROPIC_API_KEY: 'sk-anthropic', ANTHROPIC_BASE_URL: 'http://wrong' },
    });

    expect(config.apiKey).toBe('');
    expect(config.baseUrl).toBe('https://api.openai.com');
  });

  it('strips a trailing slash so joined paths never double up', () => {
    // `${baseUrl}/v1/messages` against a stored `https://x/` yields `//v1`,
    // which some gateways route differently and some reject outright.
    const config = resolveApiConfig('openai', { env: { OPENAI_BASE_URL: 'https://proxy.test/' } });
    expect(config.baseUrl).toBe('https://proxy.test');
  });

  it('ignores an unusable output-token cap instead of sending NaN', () => {
    for (const raw of ['nonsense', '0', '-5', '']) {
      const config = resolveApiConfig('openai', {
        env: { AGENT_OFFICE_MAX_OUTPUT_TOKENS: raw },
      });
      expect(config.maxOutputTokens, `for ${JSON.stringify(raw)}`).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    }
  });

  it('honours a valid output-token cap', () => {
    const config = resolveApiConfig('openai', { env: { AGENT_OFFICE_MAX_OUTPUT_TOKENS: '2048' } });
    expect(config.maxOutputTokens).toBe(2048);
  });
});

describe('resolveApiConfig — overrides', () => {
  it('lets an explicit override beat the environment', () => {
    const config = resolveApiConfig('anthropic', {
      env: { ANTHROPIC_MODEL: 'from-env' },
      overrides: { model: 'from-caller' },
    });
    expect(config.model).toBe('from-caller');
  });

  it('leaves unrelated fields alone when one is overridden', () => {
    const config = resolveApiConfig('anthropic', {
      env: { ANTHROPIC_API_KEY: 'sk-keep-me' },
      overrides: { model: 'other' },
    });
    expect(config.apiKey).toBe('sk-keep-me');
  });
});

describe('describeConfig — the key must not be loggable', () => {
  const KEY = 'sk-ant-super-secret-value-1234';

  it('never contains the key in full', () => {
    const described = describeConfig({
      apiKey: KEY,
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
      maxOutputTokens: 8192,
      modelSource: 'default',
    });

    expect(described).not.toContain(KEY);
    // Nor any workable prefix of it. A four-character suffix is not enough to
    // reconstruct a key; a long prefix would be.
    expect(described).not.toContain('sk-ant-super');
  });

  it('shows enough to identify which key was used', () => {
    // When a run fails with a 401 the question is always "which key was that",
    // and `[redacted]` answers nothing. A length and the last four characters
    // answer it without putting a working credential in a pasted log.
    const described = describeConfig({
      apiKey: KEY,
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
      maxOutputTokens: 8192,
      modelSource: 'default',
    });

    expect(described).toContain(`${KEY.length} chars`);
    expect(described).toContain('1234');
  });

  it('says "absent" rather than describing an empty key', () => {
    const described = describeConfig({
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-4o',
      maxOutputTokens: 8192,
      modelSource: 'default',
    });

    expect(described).toContain('key=absent');
    expect(described).not.toContain('0 chars');
  });
});

// ---------------------------------------------------------------------------
// resolveAgentModel — precedence across three engines, and the closed
// tier-word set that replaced the old "contains a hyphen" heuristic.
//
// No test for this function or for the per-agent model feature existed
// before this file was touched — this is the coverage the QA review flagged
// as entirely missing (defect 6). It is written as a matrix over the three
// axes the function's own doc names as its precedence rule: where the
// resolved config's model came from (`modelSource`), what the agent's own
// catalog `model:` says, and which provider is being asked.
// ---------------------------------------------------------------------------

describe('resolveAgentModel', () => {
  const PROVIDERS: readonly ApiProviderId[] = ['anthropic', 'openai', 'deepseek'];

  function config(model: string, modelSource: ApiProviderConfig['modelSource']): ApiProviderConfig {
    return { apiKey: 'test-key', baseUrl: 'https://example.test', model, maxOutputTokens: 8192, modelSource };
  }

  describe('agentModel undefined or "inherit" — always the resolved config model, for every provider and every modelSource', () => {
    for (const id of PROVIDERS) {
      for (const modelSource of ['default', 'environment', 'override'] as const) {
        for (const agentModel of [undefined, 'inherit'] as const) {
          it(`${id} / modelSource=${modelSource} / agentModel=${String(agentModel)}`, () => {
            const result = resolveAgentModel(id, config('the-configured-model', modelSource), agentModel);
            expect(result).toEqual({ model: 'the-configured-model' });
          });
        }
      }
    }
  });

  describe('an explicit run-wide model ("environment" or "override") always wins and is always reported as unhonoured, whatever the agent catalog names', () => {
    for (const id of PROVIDERS) {
      for (const modelSource of ['environment', 'override'] as const) {
        for (const agentModel of ['sonnet', 'haiku', 'turbo', 'o1', 'gpt-4o-mini'] as const) {
          it(`${id} / modelSource=${modelSource} / agentModel="${agentModel}"`, () => {
            const result = resolveAgentModel(id, config('run-wide-model', modelSource), agentModel);
            expect(result.model).toBe('run-wide-model');
            expect(result.unhonoured).toContain(agentModel);
            expect(result.unhonoured).toContain('run-wide-model');
          });
        }
      }
    }
  });

  describe('modelSource "default" — the catalog model decides, translated per provider', () => {
    it('translates "sonnet" and "haiku" to concrete Anthropic ids, with nothing reported as unhonoured', () => {
      expect(resolveAgentModel('anthropic', config('claude-sonnet-5', 'default'), 'sonnet')).toEqual({
        model: 'claude-sonnet-5',
      });
      expect(resolveAgentModel('anthropic', config('claude-sonnet-5', 'default'), 'haiku')).toEqual({
        model: 'claude-haiku-4-5-20251001',
      });
    });

    it('translates the dormant "opus" alias too, for when a catalog agent eventually uses it', () => {
      expect(resolveAgentModel('anthropic', config('claude-sonnet-5', 'default'), 'opus')).toEqual({
        model: 'claude-opus-5',
      });
    });

    for (const id of ['openai', 'deepseek'] as const) {
      it(`reports "sonnet", "haiku" and "opus" as unhonoured for ${id}, which has no translation for Anthropic's vocabulary`, () => {
        for (const tier of ['sonnet', 'haiku', 'opus']) {
          const result = resolveAgentModel(id, config('gpt-4o', 'default'), tier);
          expect(result.model).toBe('gpt-4o');
          expect(result.unhonoured).toContain(tier);
        }
      });
    }

    for (const id of PROVIDERS) {
      it(`passes a full, hyphen-free model id such as "o1" straight through for ${id} — the exact case the old hyphen heuristic got wrong`, () => {
        expect(resolveAgentModel(id, config('some-default', 'default'), 'o1')).toEqual({ model: 'o1' });
        expect(resolveAgentModel(id, config('some-default', 'default'), 'o3')).toEqual({ model: 'o3' });
      });

      it(`passes an unrecognised tier word such as "turbo" straight through for ${id}, exactly like a hyphenated model id would be`, () => {
        expect(resolveAgentModel(id, config('some-default', 'default'), 'turbo')).toEqual({ model: 'turbo' });
      });

      it(`passes a hyphenated full model id straight through for ${id}`, () => {
        expect(resolveAgentModel(id, config('some-default', 'default'), 'gpt-4o-mini')).toEqual({
          model: 'gpt-4o-mini',
        });
      });
    }
  });
});

describe('isApiProviderId', () => {
  it('accepts exactly the three HTTP providers', () => {
    expect(isApiProviderId('anthropic')).toBe(true);
    expect(isApiProviderId('openai')).toBe(true);
    expect(isApiProviderId('deepseek')).toBe(true);
  });

  it('rejects the providers that are not configured this way', () => {
    // `claude-code` reads credentials from the CLI's own login, and `scripted`
    // has no endpoint at all. Both would resolve to a config full of defaults
    // that mean nothing if this guard let them through.
    expect(isApiProviderId('claude-code')).toBe(false);
    expect(isApiProviderId('scripted')).toBe(false);
    expect(isApiProviderId('')).toBe(false);
  });
});
