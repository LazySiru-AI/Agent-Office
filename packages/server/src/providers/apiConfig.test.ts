import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentEventSchema,
  AgentListResponseSchema,
  AgentSummarySchema,
  ApiErrorSchema,
  ClarificationRequestSchema,
  CreateRunResponseSchema,
  ProviderInfoSchema,
  ProviderListResponseSchema,
  ReportResponseSchema,
  RunEventsResponseSchema,
  RunListResponseSchema,
  RunStateSchema,
  RunSummarySchema,
  ServerMessageSchema,
} from '@agent-office/shared';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  apiKeyVariable,
  describeConfig,
  isApiProviderId,
  resolveAgentModel,
  resolveApiConfig,
  validateBaseUrl,
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

// ---------------------------------------------------------------------------
// AO-9: `<PROVIDER>_BASE_URL` becomes the origin a request carrying the API
// key is sent to. Wired through `resolveApiConfig` (below) so this cannot be
// bypassed by any caller that goes through the normal config path, and
// exercised directly against `validateBaseUrl` (further below) for the
// per-case error text, since asserting exact wording through `resolveApiConfig`
// for every case would just be indirection.
// ---------------------------------------------------------------------------

describe('resolveApiConfig — base URL validation (AO-9)', () => {
  it('accepts https:// to any host — prevents a regression that would block ordinary provider/proxy use', () => {
    const config = resolveApiConfig('openai', { env: { OPENAI_BASE_URL: 'https://my-proxy.example.com' } });
    expect(config.baseUrl).toBe('https://my-proxy.example.com');
  });

  it('accepts http:// to loopback — prevents a regression that would break local model servers (Ollama, LM Studio)', () => {
    for (const host of ['http://127.0.0.1:11434', 'http://localhost:1234', 'http://[::1]:8080']) {
      const config = resolveApiConfig('openai', { env: { OPENAI_BASE_URL: host } });
      expect(config.baseUrl).toBe(host);
    }
  });

  it('rejects http:// to a non-loopback host — this is the exfiltration path AO-9 exists to close: a plain-http base URL would send the key in the clear to any host an operator (or a compromised .env write) names', () => {
    expect(() => resolveApiConfig('openai', { env: { OPENAI_BASE_URL: 'http://attacker.example' } })).toThrow(
      /OPENAI_BASE_URL/,
    );
    expect(() => resolveApiConfig('openai', { env: { OPENAI_BASE_URL: 'http://attacker.example' } })).toThrow(
      /non-loopback/,
    );
  });

  it('the error names the specific variable that was misconfigured, not a generic message — prevents a fix from being blocked by "which provider even set this"', () => {
    expect(() => resolveApiConfig('deepseek', { env: { DEEPSEEK_BASE_URL: 'http://evil.test' } })).toThrow(
      /DEEPSEEK_BASE_URL/,
    );
    expect(() => resolveApiConfig('anthropic', { env: { ANTHROPIC_BASE_URL: 'http://evil.test' } })).toThrow(
      /ANTHROPIC_BASE_URL/,
    );
  });

  it('validates an explicit override the same way as an environment value — the settings UI is not a bypass', () => {
    expect(() =>
      resolveApiConfig('anthropic', { env: NO_ENV, overrides: { baseUrl: 'http://attacker.example' } }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });
});

describe('validateBaseUrl', () => {
  const VAR = 'ANTHROPIC_BASE_URL';

  it('accepts https:// regardless of host', () => {
    expect(validateBaseUrl('https://api.anthropic.com', VAR)).toBe('https://api.anthropic.com');
    expect(validateBaseUrl('https://some-proxy.internal:8443', VAR)).toBe('https://some-proxy.internal:8443');
  });

  it('accepts http:// to exactly the three loopback forms named in the fix, case-insensitively for the hostname', () => {
    expect(validateBaseUrl('http://127.0.0.1:9999', VAR)).toBe('http://127.0.0.1:9999');
    expect(validateBaseUrl('http://[::1]:9999', VAR)).toBe('http://[::1]:9999');
    expect(validateBaseUrl('http://localhost:9999', VAR)).toBe('http://localhost:9999');
    expect(validateBaseUrl('http://LOCALHOST:9999', VAR)).toBe('http://LOCALHOST:9999');
  });

  it('rejects http:// to a public host — this is the exact exploit AO-9 describes: a key sent in the clear to whatever the hostname resolves to', () => {
    expect(() => validateBaseUrl('http://example.com', VAR)).toThrow(/non-loopback/);
    expect(() => validateBaseUrl('http://93.184.216.34', VAR)).toThrow(/non-loopback/);
  });

  it('rejects a non-http(s) scheme — prevents this value from ever being used to smuggle something other than an HTTP request origin (e.g. `file:` reading local disk, `javascript:` in a context that might eval it)', () => {
    expect(() => validateBaseUrl('file:///etc/passwd', VAR)).toThrow(/scheme/);
    expect(() => validateBaseUrl('javascript:alert(1)', VAR)).toThrow(/scheme/);
    expect(() => validateBaseUrl('ftp://example.com', VAR)).toThrow(/scheme/);
  });

  it('rejects userinfo embedded in the URL — prevents the classic "https://real-host@attacker.example" trick where the visible host is not the actual destination', () => {
    expect(() => validateBaseUrl('https://api.anthropic.com@attacker.example', VAR)).toThrow(/credentials/);
    expect(() => validateBaseUrl('https://user:pass@127.0.0.1:9999', VAR)).toThrow(/credentials/);
  });

  it('rejects a string that is not a URL at all, with a message pointing at how to fix it — this is also the path an empty-host URL like "http://" takes, since the WHATWG parser itself refuses to produce an empty host for http(s) and throws before validation even runs', () => {
    expect(() => validateBaseUrl('not a url', VAR)).toThrow(/not a valid URL/);
    expect(() => validateBaseUrl('http://', VAR)).toThrow(/not a valid URL/);
  });

  it('every rejection names the offending variable — prevents a misconfiguration report that does not say which setting to change', () => {
    for (const bad of ['http://attacker.example', 'file:///x', 'https://a@b.example', 'http://', 'nope']) {
      expect(() => validateBaseUrl(bad, 'DEEPSEEK_BASE_URL')).toThrow(/DEEPSEEK_BASE_URL/);
    }
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

// NFR-4 (Must), the "never written into run artifacts / never logged" clause:
// "API keys ... are never sent to the frontend, and are never written into
// run artifacts." `describeConfig` is the one function in this codebase whose
// entire job is producing the human-readable line that DOES get logged and
// surfaced in diagnostics, so it is the one place that clause can be broken —
// the tests below prove the raw key never appears in what it returns, in
// full or as a workable prefix, while still saying enough (length, last four
// characters) to be useful when a run fails with a 401.
describe('describeConfig — the key must not be loggable (NFR-4)', () => {
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
// NFR-4 (Must), the third clause: "API keys ... are never sent to the
// frontend." The two describe blocks above already cover the other two
// clauses of NFR-4 — `env.test.ts`'s "returns variable names only, never the
// values" proves a key never leaks into a loaded-env report, and
// `describeConfig` above proves one never leaks into a log line. Neither
// touches the wire contract itself, and "never sent to the frontend" has held
// so far only because nobody has added a field that would break it — nothing
// asserts the omission directly.
//
// This block does. It walks the actual zod schemas `packages/shared/src/
// wire.ts` exports for every SERVER -> CLIENT message — every HTTP response
// schema, `ServerMessageSchema`'s websocket variants, and the two schemas
// they embed (`RunStateSchema`, `AgentEventSchema`) — and asserts none of
// their field names, at any depth, look like a place an API key could ride
// along. Inbound schemas (`CreateRunRequestSchema`, `TeamOperationSchema`,
// `ClarificationAnswerSchema`, `ClientMessageSchema`, ...) are deliberately
// excluded: they travel client -> server, which is outside this clause.
//
// This is a structural assertion on the schema objects themselves — imported
// and introspected via zod's own `ZodObject`/`ZodArray`/`ZodUnion`/
// `ZodDiscriminatedUnion`/`ZodOptional`/`ZodNullable`/`ZodDefault` shapes —
// rather than a grep over `wire.ts`'s source text. The practical difference:
// a future field literally named `apiKey` fails this test the moment it is
// added to a schema, before anything built on that schema ever serialises it,
// where a text grep could be defeated by a rename or a re-export the grep's
// pattern did not anticipate.
// ---------------------------------------------------------------------------

/**
 * Recursively collects every field name reachable from `schema`, unwrapping
 * the zod wrapper types this codebase's wire schemas actually use.
 *
 * `seen` guards against re-walking the same schema instance twice (several of
 * the schemas below embed the same nested schema — e.g. `RunStateSchema`
 * reachable both directly and through `ServerMessageSchema`'s `snapshot`/
 * `state` variants) — not because these particular schemas are cyclic, but
 * because nothing about zod's public API rules that out for a schema this
 * function has not been told about yet.
 */
function collectFieldNames(schema: z.ZodTypeAny, seen: Set<z.ZodTypeAny> = new Set()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return Object.entries(shape).flatMap(([key, value]) => [key, ...collectFieldNames(value, seen)]);
  }
  if (schema instanceof z.ZodArray) {
    return collectFieldNames(schema.element as z.ZodTypeAny, seen);
  }
  if (schema instanceof z.ZodOptional) {
    return collectFieldNames(schema.unwrap() as z.ZodTypeAny, seen);
  }
  if (schema instanceof z.ZodNullable) {
    return collectFieldNames(schema.unwrap() as z.ZodTypeAny, seen);
  }
  if (schema instanceof z.ZodDefault) {
    return collectFieldNames(schema.removeDefault() as z.ZodTypeAny, seen);
  }
  if (schema instanceof z.ZodUnion) {
    return (schema.options as readonly z.ZodTypeAny[]).flatMap((option) => collectFieldNames(option, seen));
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return (schema.options as readonly z.ZodTypeAny[]).flatMap((option) => collectFieldNames(option, seen));
  }
  // Every leaf type (string, number, boolean, literal, enum, ...) contributes
  // no field names of its own — it IS a field's value, not a container of more
  // fields — so falling through to "nothing more to collect" is correct, not
  // merely a default.
  return [];
}

describe('NFR-4: the wire contract exposes no field that could carry an API key', () => {
  const outboundSchemas: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
    ['CreateRunResponseSchema', CreateRunResponseSchema],
    ['RunSummarySchema', RunSummarySchema],
    ['RunListResponseSchema', RunListResponseSchema],
    ['AgentSummarySchema', AgentSummarySchema],
    ['AgentListResponseSchema', AgentListResponseSchema],
    ['ProviderInfoSchema', ProviderInfoSchema],
    ['ProviderListResponseSchema', ProviderListResponseSchema],
    ['ReportResponseSchema', ReportResponseSchema],
    ['RunEventsResponseSchema', RunEventsResponseSchema],
    ['ApiErrorSchema', ApiErrorSchema],
    ['ClarificationRequestSchema', ClarificationRequestSchema],
    ['ServerMessageSchema', ServerMessageSchema],
    // Embedded inside RunEventsResponseSchema and inside ServerMessageSchema's
    // `snapshot`/`state` variants — walked directly too, so a field added
    // here is caught regardless of which wrapper is under test.
    ['RunStateSchema', RunStateSchema],
    ['AgentEventSchema', AgentEventSchema],
  ];

  // `apiKey`/`api_key`, `secret`, `credential`, `password`, in any casing.
  // Deliberately does NOT match bare "token": `RunStateSchema`'s usage
  // counters (`inputTokens`, `outputTokens`, `cacheReadTokens`,
  // `cacheWriteTokens`) and `CreateRunRequestSchema`'s `tokenBudget` all
  // contain that substring legitimately, and are token COUNTS, not
  // credentials — flagging them would make this test noisy enough that a
  // real future violation could hide in the expected-failures list.
  const SUSPECT_FIELD = /api[_-]?key|secret|credential|password/i;

  for (const [name, schema] of outboundSchemas) {
    it(`${name} has no field name that looks like a credential`, () => {
      const suspects = collectFieldNames(schema).filter((field) => SUSPECT_FIELD.test(field));
      expect(suspects).toEqual([]);
    });
  }
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
