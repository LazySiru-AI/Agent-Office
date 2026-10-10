import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '@agent-office/shared';
import type { AgentRunRequest, ProviderId } from '../types.js';
import { ProviderUnavailableError } from '../types.js';
import { AnthropicProvider, MAX_TOOL_ITERATIONS, type AnthropicProviderOptions } from './provider.js';
import { sseFrame, shred, startFakeAnthropic, type FakeAnthropicResponse } from './fakeServer.js';

/**
 * Adapter-level tests (Phase 7).
 *
 * No API key exists on this machine, so every test here runs against
 * `fakeServer.ts` — a local `node:http` server speaking the wire format
 * `protocol.ts` documents. That proves the adapter's *behaviour* given that
 * wire format: SSE parsing, the tool-use loop, cancellation, error mapping.
 * It does NOT prove the wire format itself matches the live Anthropic API —
 * see `protocol.ts`'s module doc for the verified/assumed split on that.
 */

// ---------------------------------------------------------------------------
// Test doubles and small builders
// ---------------------------------------------------------------------------

interface StubToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A hand-made `SandboxedTools` stand-in, per the brief's instruction to code
 * against `apiTools.ts`'s documented interface rather than its real
 * filesystem behaviour. Filtering by `allowedTools` is re-implemented here
 * (case-insensitively, matching the real module) so the "never offered Write"
 * test proves *this adapter* forwards the allowlist correctly — the real
 * module's own filtering is that module's own test's job, not this one's.
 */
function stubTools(
  defs: readonly StubToolDef[],
  resultFor: (name: string, input: Record<string, unknown>) => { content: string; isError: boolean },
): {
  factory: (workspaceDir: string) => { schemas: (allowed: readonly string[]) => StubToolDef[]; execute: (name: string, input: unknown) => Promise<{ content: string; isError: boolean }> };
  calls: Array<{ name: string; input: unknown }>;
} {
  const calls: Array<{ name: string; input: unknown }> = [];
  const factory = (_workspaceDir: string) => ({
    schemas(allowed: readonly string[]): StubToolDef[] {
      const wanted = new Set(allowed.map((name) => name.toLowerCase()));
      return defs.filter((def) => wanted.has(def.name.toLowerCase()));
    },
    async execute(name: string, input: unknown) {
      calls.push({ name, input });
      return resultFor(name, isRecord(input) ? input : {});
    },
  });
  return { factory, calls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NO_TOOLS = stubTools([], () => ({ content: '', isError: false })).factory;

function makeRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    assignmentId: 'a1',
    systemPrompt: '# code-reviewer\n\nYou review code for correctness.',
    task: 'Review the auth module and summarise the risks.',
    allowedTools: ['Read', 'Write'],
    workspaceDir: process.cwd(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function providerAgainst(
  url: string,
  toolsFactory: ReturnType<typeof stubTools>['factory'] | typeof NO_TOOLS,
  options: Partial<AnthropicProviderOptions> & { diagnostics?: string[] } = {},
): AnthropicProvider {
  const { diagnostics, ...rest } = options;
  return new AnthropicProvider({
    ...(diagnostics === undefined ? {} : { onDiagnostic: (m: string) => diagnostics.push(m) }),
    ...rest,
    deps: {
      createTools: toolsFactory,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: url },
    },
  });
}

async function collect(provider: AnthropicProvider, request: AgentRunRequest): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of provider.run(request)) events.push(event);
  return events;
}

/** One ordinary text-only SSE turn: message_start → text deltas → message_delta → message_stop. */
function plainTurnSse(textChunks: readonly string[], usage: { input: number; output: number }): string {
  let out = sseFrame('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: usage.input, output_tokens: 0 } },
  });
  out += sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const chunk of textChunks) {
    out += sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
  }
  out += sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 });
  out += sseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output },
  });
  out += sseFrame('message_stop', { type: 'message_stop' });
  return out;
}

/** One tool-use SSE turn: a single `tool_use` block, no text, `stop_reason: "tool_use"`. */
function toolUseTurnSse(
  toolUseId: string,
  toolName: string,
  inputJsonParts: readonly string[],
  usage: { input: number; output: number },
): string {
  let out = sseFrame('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: usage.input, output_tokens: 0 } },
  });
  out += sseFrame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
  });
  for (const part of inputJsonParts) {
    out += sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: part },
    });
  }
  out += sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 });
  out += sseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: usage.output },
  });
  out += sseFrame('message_stop', { type: 'message_stop' });
  return out;
}

function sseResponse(body: string, extra: Partial<Extract<FakeAnthropicResponse, { kind: 'sse' }>> = {}): FakeAnthropicResponse {
  return { kind: 'sse', parts: [body], ...extra };
}

/** Loose shape of what the adapter actually posts, checked without `as` casts. */
const SentBodySchema = z
  .object({
    model: z.string(),
    max_tokens: z.number(),
    system: z.string(),
    stream: z.boolean(),
    messages: z.array(z.unknown()),
    tools: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe('AnthropicProvider — preflight', () => {
  it('reports unavailable, naming the env var, without making a network call', async () => {
    const provider = new AnthropicProvider({ deps: { createTools: NO_TOOLS, env: {} } });
    const availability = await provider.isAvailable();
    expect(availability).toEqual({ ok: false, reason: 'ANTHROPIC_API_KEY is not set' });
  });

  it('throws ProviderUnavailableError from run() rather than starting when the key is absent', async () => {
    const provider = new AnthropicProvider({ deps: { createTools: NO_TOOLS, env: {} } });
    await expect(collect(provider, makeRequest())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('is registered under the "anthropic" provider id', () => {
    const id: ProviderId = new AnthropicProvider({ deps: { env: {} } }).id;
    expect(id).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// A plain turn
// ---------------------------------------------------------------------------

describe('AnthropicProvider — a plain text turn', () => {
  it('yields text and usage, and sends the system prompt and task correctly', async () => {
    const fake = await startFakeAnthropic([
      sseResponse(plainTurnSse(['Hello', ' world'], { input: 50, output: 12 })),
    ]);
    try {
      const request = makeRequest();
      const events = await collect(providerAgainst(fake.url, NO_TOOLS), request);

      const text = events.filter((e) => e.t === 'text');
      const usage = events.filter((e) => e.t === 'usage');
      expect(text.map((e) => (e.t === 'text' ? e.chunk : ''))).toEqual(['Hello', ' world']);
      expect(usage).toEqual([
        {
          t: 'usage',
          assignmentId: 'a1',
          inputTokens: 50,
          outputTokens: 12,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
      expect(events.every((e) => e.assignmentId === 'a1')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);

      expect(fake.requests).toHaveLength(1);
      const sent = SentBodySchema.parse(fake.requests[0]?.body);
      expect(sent.system).toBe(request.systemPrompt);
      expect(sent.stream).toBe(true);
      expect(sent.messages[0]).toEqual({ role: 'user', content: request.task });

      const headers = fake.requests[0]?.headers ?? {};
      expect(headers['x-api-key']).toBe('sk-ant-test-key-not-a-real-secret');
      expect(headers['anthropic-version']).toBeTruthy();
    } finally {
      await fake.close();
    }
  });

  it('survives a malformed SSE frame, recording a diagnostic without failing the run (NFR-8)', async () => {
    const garbage = 'event: content_block_delta\ndata: {this is not valid json\n\n';
    const body = garbage + plainTurnSse(['still works'], { input: 5, output: 2 });
    const fake = await startFakeAnthropic([sseResponse(body)]);
    try {
      const diagnostics: string[] = [];
      const events = await collect(providerAgainst(fake.url, NO_TOOLS, { diagnostics }), makeRequest());

      expect(events.some((e) => e.t === 'text' && e.chunk === 'still works')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
      expect(diagnostics.length).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The "at least one text event" contract (types.ts)
// ---------------------------------------------------------------------------

describe('AnthropicProvider — the empty-turn contract guard', () => {
  it('still emits a text event carrying an empty chunk when a turn ends with no content blocks at all', async () => {
    // The exact shape the reviewer fed in: message_start -> message_delta ->
    // message_stop, no content_block_* events whatsoever. Nothing upstream
    // of `run` guarantees a turn produces text, so without this guard the
    // run completes having yielded only a usage event, breaking the
    // documented contract ("must emit at least one text event carrying the
    // agent's final answer").
    const body =
      sseFrame('message_start', {
        type: 'message_start',
        message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } },
      }) +
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      }) +
      sseFrame('message_stop', { type: 'message_stop' });

    const fake = await startFakeAnthropic([sseResponse(body)]);
    try {
      const events = await collect(providerAgainst(fake.url, NO_TOOLS), makeRequest());

      const text = events.filter((e): e is Extract<AgentEvent, { t: 'text' }> => e.t === 'text');
      expect(text).toEqual([{ t: 'text', assignmentId: 'a1', chunk: '' }]);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reporting a run-wide model override (defect 6 coverage — resolveAgentModel
// itself is covered exhaustively in apiConfig.test.ts; this proves the
// adapter actually surfaces what that function returns).
// ---------------------------------------------------------------------------

describe('AnthropicProvider — reporting a run-wide model override', () => {
  it('yields exactly one non-fatal error event when a run-wide model overrides the agent catalog model, and still completes the run normally', async () => {
    const fake = await startFakeAnthropic([sseResponse(plainTurnSse(['ok'], { input: 5, output: 1 }))]);
    try {
      const provider = new AnthropicProvider({
        model: 'claude-opus-5',
        deps: {
          createTools: NO_TOOLS,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
        },
      });
      const events = await collect(provider, makeRequest({ model: 'sonnet' }));

      const warnings = events.filter((e) => e.t === 'error' && !e.fatal);
      expect(warnings).toHaveLength(1);
      const message = warnings[0]?.t === 'error' ? warnings[0].message : '';
      expect(message).toContain('sonnet');
      expect(message).toContain('claude-opus-5');

      expect(events.some((e) => e.t === 'text' && e.chunk === 'ok')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);

      const sent = SentBodySchema.parse(fake.requests[0]?.body);
      expect(sent.model).toBe('claude-opus-5');
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Chunk boundaries
// ---------------------------------------------------------------------------

describe('AnthropicProvider — chunk boundaries', () => {
  it('loses nothing when a chunk boundary falls mid `data:` line', async () => {
    // The exact failure sse.ts exists to survive: tear the payload into
    // 3-byte pieces, guaranteeing a cut lands inside a `data:` line at least
    // once, and prove the real fetch → readSse → provider pipeline (not just
    // the synthetic-ReadableStream unit tests in sse.test.ts) survives it.
    const payload = plainTurnSse(['this sentence must arrive whole'], { input: 9, output: 6 });
    const fake = await startFakeAnthropic([{ kind: 'sse', parts: shred(payload, 3) }]);
    try {
      const events = await collect(providerAgainst(fake.url, NO_TOOLS), makeRequest());
      const text = events.filter((e): e is Extract<AgentEvent, { t: 'text' }> => e.t === 'text');
      expect(text.map((e) => e.chunk).join('')).toBe('this sentence must arrive whole');
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The tool-use loop
// ---------------------------------------------------------------------------

describe('AnthropicProvider — the tool-use loop', () => {
  it('executes a requested tool and sends its result back on the follow-up request', async () => {
    const { factory, calls } = stubTools(
      [{ name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object' } }],
      (_name, input) => ({ content: `contents of ${String(input['path'])}`, isError: false }),
    );

    const fake = await startFakeAnthropic([
      sseResponse(toolUseTurnSse('toolu_1', 'Read', ['{"path":', '"notes.txt"}'], { input: 80, output: 5 })),
      sseResponse(plainTurnSse(['Done.'], { input: 100, output: 3 })),
    ]);
    try {
      const events = await collect(providerAgainst(fake.url, factory, {}), makeRequest({ allowedTools: ['Read'] }));

      const tool = events.find((e) => e.t === 'tool');
      expect(tool).toMatchObject({ t: 'tool', name: 'Read', summary: expect.stringContaining('notes.txt') });
      expect(events.some((e) => e.t === 'text' && e.chunk === 'Done.')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);

      expect(calls).toEqual([{ name: 'Read', input: { path: 'notes.txt' } }]);

      expect(fake.requests).toHaveLength(2);
      const secondBody = SentBodySchema.parse(fake.requests[1]?.body);
      expect(secondBody.messages).toHaveLength(3);
      expect(secondBody.messages[0]).toEqual({ role: 'user', content: 'Review the auth module and summarise the risks.' });
      expect(secondBody.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'notes.txt' } }],
      });
      expect(secondBody.messages[2]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents of notes.txt' }],
      });
    } finally {
      await fake.close();
    }
  });

  it('never offers a tool outside allowedTools', async () => {
    const { factory } = stubTools(
      [
        { name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object' } },
        { name: 'Write', description: 'Writes a file.', inputSchema: { type: 'object' } },
      ],
      () => ({ content: 'ok', isError: false }),
    );
    const fake = await startFakeAnthropic([sseResponse(plainTurnSse(['fine'], { input: 4, output: 1 }))]);
    try {
      await collect(providerAgainst(fake.url, factory), makeRequest({ allowedTools: ['Read'] }));

      const sent = SentBodySchema.parse(fake.requests[0]?.body);
      const toolNames = (sent.tools ?? []).map((t) => t.name);
      expect(toolNames).toEqual(['Read']);
      expect(toolNames).not.toContain('Write');
    } finally {
      await fake.close();
    }
  });

  it('hits its iteration bound rather than spinning forever on a model that never stops calling tools', async () => {
    const bound = 3;
    const { factory } = stubTools(
      [{ name: 'Loop', description: 'Never satisfies the model.', inputSchema: { type: 'object' } }],
      () => ({ content: 'again', isError: false }),
    );

    // Exactly `bound` scripted turns: if the adapter ever asked for a 4th,
    // the fake server's own "more requests than scripted" guard would fail
    // the request loudly rather than let the test hang or pass by accident.
    const responses: FakeAnthropicResponse[] = Array.from({ length: bound }, (_unused, i) =>
      sseResponse(toolUseTurnSse(`toolu_${String(i)}`, 'Loop', ['{}'], { input: 10, output: 2 })),
    );
    const fake = await startFakeAnthropic(responses);
    try {
      const events = await collect(
        providerAgainst(fake.url, factory, { maxToolIterations: bound }),
        makeRequest({ allowedTools: ['Loop'] }),
      );

      expect(fake.requests).toHaveLength(bound);
      const fatal = events.filter((e) => e.t === 'error' && e.fatal);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]?.t === 'error' && fatal[0].message).toContain(String(bound));
    } finally {
      await fake.close();
    }
  });

  it('exports the production default so the bound above is not accidentally testing a different number', () => {
    expect(MAX_TOOL_ITERATIONS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('AnthropicProvider — HTTP errors', () => {
  it('reports a 401 as fatal, naming the env var, and never includes the key', async () => {
    const secretKey = 'sk-ant-super-secret-do-not-leak-0000';
    const fake = await startFakeAnthropic([
      { kind: 'json', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
    ]);
    try {
      const provider = new AnthropicProvider({
        deps: { createTools: NO_TOOLS, env: { ANTHROPIC_API_KEY: secretKey, ANTHROPIC_BASE_URL: fake.url } },
      });
      const events = await collect(provider, makeRequest());

      const fatal = events.filter((e) => e.t === 'error' && e.fatal);
      expect(fatal).toHaveLength(1);
      const message = fatal[0]?.t === 'error' ? fatal[0].message : '';
      expect(message).toContain('ANTHROPIC_API_KEY');
      expect(message).not.toContain(secretKey);
    } finally {
      await fake.close();
    }
  });

  it('reports a 429 as fatal and actionable, distinct from a plain HTTP error', async () => {
    const fake = await startFakeAnthropic([
      { kind: 'json', status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } } },
    ]);
    try {
      const events = await collect(providerAgainst(fake.url, NO_TOOLS), makeRequest());
      const fatal = events.filter((e) => e.t === 'error' && e.fatal);
      expect(fatal).toHaveLength(1);
      const message = fatal[0]?.t === 'error' ? fatal[0].message : '';
      expect(message.toLowerCase()).toContain('rate limit');
    } finally {
      await fake.close();
    }
  });

  it('reports a mid-stream error event as fatal without crashing the process', async () => {
    const body = sseFrame('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const fake = await startFakeAnthropic([sseResponse(body)]);
    try {
      const events = await collect(providerAgainst(fake.url, NO_TOOLS), makeRequest());
      const fatal = events.filter((e) => e.t === 'error' && e.fatal);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]?.t === 'error' && fatal[0].message).toContain('Overloaded');
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('AnthropicProvider — cancellation (FR-M9)', () => {
  it('stops on abort without reporting a spurious failure', async () => {
    const fake = await startFakeAnthropic([{ kind: 'stall' }]);
    try {
      const controller = new AbortController();
      const provider = providerAgainst(fake.url, NO_TOOLS);

      setTimeout(() => controller.abort(), 150);

      const events: AgentEvent[] = [];
      for await (const event of provider.run(makeRequest({ signal: controller.signal }))) {
        events.push(event);
      }

      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it('does not send a follow-up request after abort even mid tool-use loop', async () => {
    const { factory, calls } = stubTools(
      [{ name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object' } }],
      () => ({ content: 'ok', isError: false }),
    );
    const fake = await startFakeAnthropic([
      sseResponse(toolUseTurnSse('toolu_1', 'Read', ['{"path":"a.txt"}'], { input: 10, output: 2 })),
      { kind: 'stall' }, // would hang forever if the adapter ever asked for it
    ]);
    try {
      const controller = new AbortController();
      const provider = providerAgainst(fake.url, factory);

      // Abort as soon as the first turn's tool call has been recorded, before
      // the adapter can start a second request.
      const events: AgentEvent[] = [];
      for await (const event of provider.run(makeRequest({ allowedTools: ['Read'], signal: controller.signal }))) {
        events.push(event);
        if (event.t === 'tool') controller.abort();
      }

      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
      // Either zero or one call recorded depending on exactly where the abort
      // landed relative to `tools.execute` — what matters is the loop never
      // reached a second HTTP request, which the stalled second response
      // would otherwise have hung on.
      expect(calls.length).toBeLessThanOrEqual(1);
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The cost cap (FR-M8, `maxCostUsd`) — see `pricing.ts` for the tier join and
// `AnthropicProviderOptions.maxCostUsd` for what precision this can promise.
// ---------------------------------------------------------------------------

describe('AnthropicProvider — the cost cap (maxCostUsd)', () => {
  it('lets a run finish normally when the estimated spend stays under the cap', async () => {
    const fake = await startFakeAnthropic([
      sseResponse(plainTurnSse(['well within budget'], { input: 1000, output: 500 })),
    ]);
    try {
      const provider = providerAgainst(fake.url, NO_TOOLS, { maxCostUsd: 10 });
      const events = await collect(provider, makeRequest());

      expect(events.some((e) => e.t === 'text' && e.chunk === 'well within budget')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it('produces exactly one fatal error naming the cap and the estimate, after the text already streamed', async () => {
    // claude-sonnet-5 (the default model) prices at $3/$15 per million input/
    // output tokens, so this turn's 1M+1M tokens cost an estimated $18 —
    // comfortably over the $1 cap.
    const fake = await startFakeAnthropic([
      sseResponse(plainTurnSse(['spent'], { input: 1_000_000, output: 1_000_000 })),
    ]);
    try {
      const provider = providerAgainst(fake.url, NO_TOOLS, { maxCostUsd: 1 });
      const events = await collect(provider, makeRequest());

      const textIndex = events.findIndex((e) => e.t === 'text' && e.chunk === 'spent');
      expect(textIndex).toBeGreaterThanOrEqual(0);

      const fatal = events.filter((e) => e.t === 'error' && e.fatal);
      expect(fatal).toHaveLength(1);
      // The text this round produced reached the caller before the cap check
      // ran — FR-M8's "fails cleanly with partial results preserved".
      expect(events.indexOf(fatal[0]!)).toBeGreaterThan(textIndex);

      const message = fatal[0]?.t === 'error' ? fatal[0].message : '';
      expect(message).toContain('$1.00');
      expect(message).toContain('$18.00');
    } finally {
      await fake.close();
    }
  });

  it('stops before starting a further tool-use round it would otherwise have made, once the cap would be exceeded', async () => {
    const { factory } = stubTools(
      [{ name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object' } }],
      () => ({ content: 'contents', isError: false }),
    );
    // Exactly one scripted response: if the adapter ever asked for a second
    // round after the cap tripped, the fake server's own "more requests than
    // scripted" guard would fail the request loudly rather than let it pass.
    const fake = await startFakeAnthropic([
      sseResponse(toolUseTurnSse('toolu_1', 'Read', ['{"path":"a.txt"}'], { input: 1_000_000, output: 1_000_000 })),
    ]);
    try {
      const provider = providerAgainst(fake.url, factory, { maxCostUsd: 1 });
      const events = await collect(provider, makeRequest({ allowedTools: ['Read'] }));

      expect(events.some((e) => e.t === 'tool')).toBe(true);
      const fatal = events.filter((e) => e.t === 'error' && e.fatal);
      expect(fatal).toHaveLength(1);
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it('reports unavailable, naming the model, when a cost cap is requested for a model with no known price', async () => {
    const provider = new AnthropicProvider({
      model: 'claude-3-legacy-id', // no recognised tier word — see pricing.ts
      maxCostUsd: 5,
      deps: {
        createTools: NO_TOOLS,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret' },
      },
    });

    const availability = await provider.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('claude-3-legacy-id');
    expect(availability.reason?.toLowerCase()).toContain('price');

    await expect(collect(provider, makeRequest())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('runs normally against an unpriced model when no cost cap is set at all', async () => {
    const fake = await startFakeAnthropic([sseResponse(plainTurnSse(['fine'], { input: 5, output: 1 }))]);
    try {
      const provider = new AnthropicProvider({
        model: 'claude-3-legacy-id',
        deps: {
          createTools: NO_TOOLS,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
        },
      });
      const events = await collect(provider, makeRequest());

      expect(events.some((e) => e.t === 'text' && e.chunk === 'fine')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// MCP tools (Stage 4)
// ---------------------------------------------------------------------------

/**
 * A hand-made `McpTools` stand-in — `mcpTools.ts`'s contract is
 * `SandboxedTools` plus `close()` and `serverDiagnostics` — used exactly the
 * way `stubTools` above stands in for `apiTools.ts`. These tests prove THIS
 * ADAPTER wires the contract correctly (composition, routing, and above all
 * the `close()` guarantee); whether a real MCP server connection behaves
 * correctly is `mcpTools.ts`'s own test suite's job, not this file's.
 */
function stubMcpTools(
  defs: readonly StubToolDef[],
  resultFor: (name: string, input: Record<string, unknown>) => { content: string; isError: boolean } = () => ({
    content: 'ok',
    isError: false,
  }),
): {
  factory: (configPath: string | undefined) => Promise<{
    schemas: (allowed: readonly string[]) => StubToolDef[];
    execute: (name: string, input: unknown) => Promise<{ content: string; isError: boolean }>;
    close: () => Promise<void>;
    serverDiagnostics: ReadonlyMap<string, string>;
  }>;
  calls: Array<{ name: string; input: unknown }>;
  closeCount: () => number;
  configPathSeen: () => string | undefined;
  allowedToolsSeen: () => readonly string[] | undefined;
} {
  const calls: Array<{ name: string; input: unknown }> = [];
  let closes = 0;
  let seenConfigPath: string | undefined;
  let seenAllowedTools: readonly string[] | undefined;
  const factory = async (configPath: string | undefined, options?: { allowedTools?: readonly string[] }) => {
    seenConfigPath = configPath;
    seenAllowedTools = options?.allowedTools;
    return {
      schemas(allowed: readonly string[]): StubToolDef[] {
        const wanted = new Set(allowed.map((name) => name.toLowerCase()));
        return defs.filter((def) => wanted.has(def.name.toLowerCase()));
      },
      async execute(name: string, input: unknown) {
        calls.push({ name, input });
        return resultFor(name, isRecord(input) ? input : {});
      },
      async close() {
        closes += 1;
      },
      serverDiagnostics: new Map<string, string>(),
    };
  };
  return {
    factory,
    calls,
    closeCount: () => closes,
    configPathSeen: () => seenConfigPath,
    allowedToolsSeen: () => seenAllowedTools,
  };
}

/** A minimal `McpRegistry` value — structurally what `loadMcpRegistry` returns, built without importing the type. */
function fakeMcpRegistry(configPath = 'C:/fake/mcp-config.json'): { configPath: string; serverNames: ReadonlySet<string> } {
  return { configPath, serverNames: new Set(['docs']) };
}

describe('AnthropicProvider — MCP tools (Stage 4)', () => {
  it('advertises MCP schemas alongside sandboxed ones and routes each call to the layer that declares it', async () => {
    const { factory: sandboxFactory, calls: sandboxCalls } = stubTools(
      [{ name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object' } }],
      () => ({ content: 'file contents', isError: false }),
    );
    const { factory: mcpFactory, calls: mcpCalls, closeCount } = stubMcpTools(
      [{ name: 'mcp__docs__search', description: 'Search the docs server.', inputSchema: { type: 'object' } }],
      () => ({ content: 'search results', isError: false }),
    );

    const fake = await startFakeAnthropic([
      sseResponse(toolUseTurnSse('toolu_1', 'Read', ['{"path":"a.txt"}'], { input: 10, output: 2 })),
      sseResponse(toolUseTurnSse('toolu_2', 'mcp__docs__search', ['{"q":"tax"}'], { input: 12, output: 2 })),
      sseResponse(plainTurnSse(['Done.'], { input: 15, output: 3 })),
    ]);
    try {
      const provider = new AnthropicProvider({
        deps: {
          createTools: sandboxFactory,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
          loadMcpRegistry: () => fakeMcpRegistry(),
          createMcpTools: mcpFactory,
        },
      });
      const events = await collect(
        provider,
        makeRequest({ allowedTools: ['Read', 'mcp__docs__search'] }),
      );

      // Both names were offered to the model on the very first request — the
      // schema list is the union of both layers, not just the sandboxed one.
      const firstBody = SentBodySchema.parse(fake.requests[0]?.body);
      const toolNames = (firstBody.tools ?? []).map((t) => t.name);
      expect(toolNames).toEqual(['Read', 'mcp__docs__search']);

      // Each call reached exactly the layer that declared it.
      expect(sandboxCalls).toEqual([{ name: 'Read', input: { path: 'a.txt' } }]);
      expect(mcpCalls).toEqual([{ name: 'mcp__docs__search', input: { q: 'tax' } }]);

      expect(events.some((e) => e.t === 'text' && e.chunk === 'Done.')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);

      // FR-M9: the run completed successfully, and the MCP handle was still
      // closed exactly once — success is an exit path too, not only the
      // failure/abort ones covered below.
      expect(closeCount()).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it('passes the registry\'s configPath straight through to createMcpTools', async () => {
    const { factory: mcpFactory, configPathSeen } = stubMcpTools([]);
    const fake = await startFakeAnthropic([sseResponse(plainTurnSse(['ok'], { input: 1, output: 1 }))]);
    try {
      const provider = new AnthropicProvider({
        deps: {
          createTools: NO_TOOLS,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
          loadMcpRegistry: () => fakeMcpRegistry('Z:/operator/mcp.json'),
          createMcpTools: mcpFactory,
        },
      });
      await collect(provider, makeRequest());
      expect(configPathSeen()).toBe('Z:/operator/mcp.json');
    } finally {
      await fake.close();
    }
  });

  it('hands the assignment\'s allowedTools to the MCP handle, not only to schemas() (FR-M5)', async () => {
    // The adapter's half of the boundary `mcpTools.ts` now enforces. Passing the allowlist ONLY into
    // `tools.schemas(request.allowedTools)` shapes what the model is told about and nothing else; the
    // handle has to hold it to refuse a call for a name that was never offered. `claude-code/
    // provider.ts` gets the same guarantee from `--allowedTools`, so without this the choice of model
    // vendor silently changed what a delegated agent could reach through the same MCP config.
    const { factory: mcpFactory, allowedToolsSeen } = stubMcpTools([]);
    const fake = await startFakeAnthropic([sseResponse(plainTurnSse(['ok'], { input: 1, output: 1 }))]);
    try {
      const provider = new AnthropicProvider({
        deps: {
          createTools: NO_TOOLS,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
          loadMcpRegistry: () => fakeMcpRegistry(),
          createMcpTools: mcpFactory,
        },
      });
      await collect(provider, makeRequest({ allowedTools: ['Read', 'mcp__docs__search'] }));

      expect(allowedToolsSeen()).toEqual(['Read', 'mcp__docs__search']);
    } finally {
      await fake.close();
    }
  });

  it('closes the MCP handle even when the run ends in a fatal HTTP error', async () => {
    const { factory: mcpFactory, closeCount } = stubMcpTools([]);
    const fake = await startFakeAnthropic([
      { kind: 'json', status: 500, body: { type: 'error', error: { type: 'api_error', message: 'internal error' } } },
    ]);
    try {
      const provider = new AnthropicProvider({
        deps: {
          createTools: NO_TOOLS,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
          loadMcpRegistry: () => fakeMcpRegistry(),
          createMcpTools: mcpFactory,
        },
      });
      const events = await collect(provider, makeRequest());

      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(true);
      // The defect this proves does not happen: an early `return` from deep
      // inside the tool-use loop (here, the HTTP-error branch) skipping a
      // cleanup that only lived at the bottom of a successful run.
      expect(closeCount()).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it('closes the MCP handle on abort (FR-M9)', async () => {
    const { factory: mcpFactory, closeCount } = stubMcpTools([]);
    const fake = await startFakeAnthropic([{ kind: 'stall' }]);
    try {
      const controller = new AbortController();
      const provider = new AnthropicProvider({
        deps: {
          createTools: NO_TOOLS,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
          loadMcpRegistry: () => fakeMcpRegistry(),
          createMcpTools: mcpFactory,
        },
      });

      setTimeout(() => controller.abort(), 150);
      const events: AgentEvent[] = [];
      for await (const event of provider.run(makeRequest({ signal: controller.signal }))) {
        events.push(event);
      }

      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
      expect(closeCount()).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it('with no registry configured, never touches MCP at all and behaves exactly as before Stage 4', async () => {
    // The regression this guards: composing in an (empty) MCP layer whenever
    // this code path runs, "for uniformity", even with MCP disabled — which
    // would change `execute()`'s unknown-tool wording (composeTools.ts's own,
    // not apiTools.ts's) on the single most common configuration this
    // adapter runs under today.
    let mcpFactoryCalls = 0;
    const fake = await startFakeAnthropic([sseResponse(plainTurnSse(['fine'], { input: 5, output: 1 }))]);
    try {
      const provider = new AnthropicProvider({
        deps: {
          createTools: NO_TOOLS,
          // `env` deliberately carries no `AGENT_OFFICE_MCP_CONFIG` — the
          // real `loadMcpRegistry` (not stubbed here) must see that and
          // return `undefined`, exactly as it does for every other test in
          // this file.
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
          createMcpTools: async (configPath: string | undefined) => {
            mcpFactoryCalls += 1;
            return (await stubMcpTools([]).factory(configPath));
          },
        },
      });
      const events = await collect(provider, makeRequest());

      expect(events.some((e) => e.t === 'text' && e.chunk === 'fine')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
      // The strongest form of "unchanged": the MCP factory was never even
      // invoked, so there is no MCP layer of any kind (empty or otherwise)
      // in the composed tools for this run.
      expect(mcpFactoryCalls).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it('degrades to sandbox-only tools with a non-fatal event when MCP tools fail to start (NFR-8)', async () => {
    const fake = await startFakeAnthropic([sseResponse(plainTurnSse(['still works'], { input: 5, output: 1 }))]);
    try {
      const provider = new AnthropicProvider({
        deps: {
          createTools: NO_TOOLS,
          env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-a-real-secret', ANTHROPIC_BASE_URL: fake.url },
          loadMcpRegistry: () => fakeMcpRegistry(),
          createMcpTools: async () => {
            throw new Error('mcp server executable not found');
          },
        },
      });
      const events = await collect(provider, makeRequest());

      const warnings = events.filter((e) => e.t === 'error' && !e.fatal);
      expect(warnings.some((w) => w.t === 'error' && w.message.includes('mcp server executable not found'))).toBe(
        true,
      );
      // NFR-8: a roster problem degrades this run, it does not fail it — the
      // assignment never actually depended on MCP being reachable.
      expect(events.some((e) => e.t === 'text' && e.chunk === 'still works')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
