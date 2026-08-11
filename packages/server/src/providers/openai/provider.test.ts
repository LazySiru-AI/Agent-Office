import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-office/shared';
import type { SandboxedTools, ToolResult, ToolSchema } from '../apiTools.js';
import { ProviderUnavailableError, type AgentRunRequest } from '../types.js';
import { chunkLine, DONE_LINE, startFakeOpenAi, type FakeOpenAiServer, type FakeStep } from './fakeServer.js';
import { DEFAULT_MAX_TOOL_ROUNDS, OpenAiCompatibleProvider } from './provider.js';

/**
 * The OpenAI/DeepSeek Chat Completions adapter (Phase 7).
 *
 * Every test here runs the adapter against `fakeServer.ts`, a local HTTP
 * double — never a real endpoint (see `provider.ts`'s top comment for why
 * that is, and for the verified/assumed split that follows from it). Tools
 * are a hand-written stub matching `apiTools.ts`'s `SandboxedTools`
 * interface rather than the real filesystem-backed implementation: what this
 * file tests is the adapter's own SSE parsing, tool-call reassembly and
 * loop/error/cancellation behaviour, not the sandbox's filesystem
 * containment, which is `apiTools.ts`'s own test file's job.
 */

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    assignmentId: 'asg-1',
    systemPrompt: 'You are a careful assistant.',
    task: 'Summarise the workspace.',
    allowedTools: [],
    workspaceDir: 'C:\\fake\\workspace',
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

interface StubToolsHandle extends SandboxedTools {
  calls: Array<{ name: string; input: unknown }>;
}

/**
 * A minimal `SandboxedTools` stub. `catalog` names the tools this stub knows
 * about (default: `Read`, `Grep`); `schemas` filters that catalog down to
 * whatever `allowedTools` requests, exactly as `apiTools.ts`'s real
 * implementation does, so the "never offered a tool outside `allowedTools`"
 * test is meaningful.
 */
function stubTools(options: {
  catalog?: string[];
  execute?: (name: string, input: unknown) => Promise<ToolResult>;
} = {}): StubToolsHandle {
  const catalog = options.catalog ?? ['Read', 'Grep'];
  const calls: Array<{ name: string; input: unknown }> = [];

  return {
    calls,
    schemas(allowedTools: readonly string[]): ToolSchema[] {
      const wanted = new Set(allowedTools);
      return catalog
        .filter((name) => wanted.has(name))
        .map((name) => ({
          name,
          description: `${name} tool (stub).`,
          inputSchema: { type: 'object' },
        }));
    },
    async execute(name: string, input: unknown): Promise<ToolResult> {
      calls.push({ name, input });
      if (options.execute !== undefined) return options.execute(name, input);
      return { content: `${name} executed`, isError: false };
    },
  };
}

async function withServer(
  steps: FakeStep[],
  run: (server: FakeOpenAiServer) => Promise<void>,
): Promise<void> {
  const server = await startFakeOpenAi(steps);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function makeProvider(
  server: FakeOpenAiServer,
  overrides: {
    id?: 'openai' | 'deepseek';
    tools?: SandboxedTools;
    onDiagnostic?: (message: string) => void;
    maxToolRounds?: number;
  } = {},
): OpenAiCompatibleProvider {
  const id = overrides.id ?? 'openai';
  const envPrefix = id.toUpperCase();
  return new OpenAiCompatibleProvider(id, {
    ...(overrides.maxToolRounds === undefined ? {} : { maxToolRounds: overrides.maxToolRounds }),
    ...(overrides.onDiagnostic === undefined ? {} : { onDiagnostic: overrides.onDiagnostic }),
    deps: {
      env: {
        [`${envPrefix}_API_KEY`]: `test-${id}-key`,
        [`${envPrefix}_BASE_URL`]: server.url,
      },
      tools: () => overrides.tools ?? stubTools({ catalog: [] }),
    },
  });
}

// ---------------------------------------------------------------------------
// isAvailable
// ---------------------------------------------------------------------------

describe('OpenAiCompatibleProvider.isAvailable', () => {
  it('reports unavailable and names OPENAI_API_KEY when no key is configured, without making a network call', async () => {
    const fetchSpy = vi.fn();
    const provider = new OpenAiCompatibleProvider('openai', {
      deps: { env: {}, fetch: fetchSpy as unknown as typeof fetch },
    });

    const result = await provider.isAvailable();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('OPENAI_API_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports unavailable and names DEEPSEEK_API_KEY for a DeepSeek instance', async () => {
    const provider = new OpenAiCompatibleProvider('deepseek', { deps: { env: {} } });
    const result = await provider.isAvailable();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('DEEPSEEK_API_KEY');
  });

  it('reports available once the key is present', async () => {
    const provider = new OpenAiCompatibleProvider('openai', {
      deps: { env: { OPENAI_API_KEY: 'sk-present' } },
    });
    await expect(provider.isAvailable()).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// A plain turn
// ---------------------------------------------------------------------------

describe('a plain text turn', () => {
  it('yields the streamed text and the usage reported in the trailing chunk', async () => {
    const steps: FakeStep[] = [
      {
        kind: 'stream',
        parts: [
          chunkLine({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
          chunkLine({ choices: [{ index: 0, delta: { content: 'Hello, ' }, finish_reason: null }] }),
          chunkLine({ choices: [{ index: 0, delta: { content: 'world.' }, finish_reason: null }] }),
          chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          chunkLine({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }),
          DONE_LINE,
        ],
      },
    ];

    await withServer(steps, async (server) => {
      const onDiagnostic = vi.fn();
      const provider = makeProvider(server, { onDiagnostic });
      const events = await collect(provider.run(makeRequest()));

      const text = events
        .filter((e) => e.t === 'text')
        .map((e) => (e as Extract<AgentEvent, { t: 'text' }>).chunk)
        .join('');
      expect(text).toBe('Hello, world.');

      const usage = events.filter((e) => e.t === 'usage');
      expect(usage).toEqual([{ t: 'usage', assignmentId: 'asg-1', inputTokens: 12, outputTokens: 5 }]);

      expect(events.some((e) => e.t === 'error')).toBe(false);
      // The literal [DONE] terminator must never reach JSON.parse, and a
      // clean stream must not produce any diagnostic at all.
      expect(onDiagnostic).not.toHaveBeenCalled();

      expect(server.requests).toHaveLength(1);
      const req = server.requests[0]!;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer test-openai-key');
      const body = req.bodyJson as Record<string, unknown>;
      expect(body['stream']).toBe(true);
      expect(body['stream_options']).toEqual({ include_usage: true });
      expect(body['messages']).toEqual([
        { role: 'system', content: 'You are a careful assistant.' },
        { role: 'user', content: 'Summarise the workspace.' },
      ]);
      // No tools were allowed, so no `tools` field at all rather than `[]` —
      // an empty array can still make some models "think" about tool use.
      expect(body['tools']).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Usage — must be reported once, not once per chunk that carries it
// ---------------------------------------------------------------------------

describe('usage reporting', () => {
  it('yields exactly one usage event with the true totals when a stream repeats the same cumulative usage across two chunks', async () => {
    // The defect this reproduces: some deployments attach the same running
    // total to more than one chunk in a stream (here, the finish-reason
    // chunk and the trailing empty-choices chunk that follows it). A naive
    // per-chunk yield handed both copies downstream, and both the dispatcher
    // and the web replay fold usage events with `+=`, turning a true 100/50
    // into a reported 200/100.
    const steps: FakeStep[] = [
      {
        kind: 'stream',
        parts: [
          chunkLine({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }),
          chunkLine({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          chunkLine({
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          DONE_LINE,
        ],
      },
    ];

    await withServer(steps, async (server) => {
      const provider = makeProvider(server);
      const events = await collect(provider.run(makeRequest()));

      const usage = events.filter((e) => e.t === 'usage');
      expect(usage).toEqual([{ t: 'usage', assignmentId: 'asg-1', inputTokens: 100, outputTokens: 50 }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Tool-call fragment reassembly — the test that matters most
// ---------------------------------------------------------------------------

describe('streamed tool-call reassembly', () => {
  it('reassembles id, name and arguments fragments split across many deltas — including a split falling mid-JSON-string — into one correct call', async () => {
    // arguments, assembled in order, must equal exactly:
    //   {"path":"notes/plan.md"}
    // Piece boundaries are chosen to fall inside a string literal's
    // characters ("note|s/pl|an.md"), which is exactly the case a naive
    // per-fragment JSON.parse would corrupt.
    const round1: FakeStep = {
      kind: 'stream',
      parts: [
        chunkLine({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'Re' } }] },
              finish_reason: null,
            },
          ],
        }),
        chunkLine({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'ad', arguments: '{"pa' } }] }, finish_reason: null },
          ],
        }),
        chunkLine({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"note' } }] }, finish_reason: null }],
        }),
        chunkLine({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 's/pl' } }] }, finish_reason: null }],
        }),
        chunkLine({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'an.md"}' } }] }, finish_reason: null }],
        }),
        chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        DONE_LINE,
      ],
    };
    const round2: FakeStep = {
      kind: 'stream',
      parts: [
        chunkLine({ choices: [{ index: 0, delta: { content: 'Done reading.' }, finish_reason: null }] }),
        chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        DONE_LINE,
      ],
    };

    await withServer([round1, round2], async (server) => {
      const tools = stubTools({ catalog: ['Read'] });
      const provider = makeProvider(server, { tools });
      const events = await collect(provider.run(makeRequest({ allowedTools: ['Read'] })));

      expect(tools.calls).toEqual([{ name: 'Read', input: { path: 'notes/plan.md' } }]);

      const toolEvents = events.filter((e) => e.t === 'tool');
      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0] as Extract<AgentEvent, { t: 'tool' }>).name).toBe('Read');

      expect(events.some((e) => e.t === 'error')).toBe(false);

      // Round 2's request must echo the assistant's tool-call turn and the
      // tool's result before the next user-visible turn.
      expect(server.requests).toHaveLength(2);
      const round2Body = server.requests[1]!.bodyJson as { messages: unknown[] };
      expect(round2Body.messages[2]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_abc', type: 'function', function: { name: 'Read', arguments: '{"path":"notes/plan.md"}' } },
        ],
      });
      expect(round2Body.messages[3]).toEqual({
        role: 'tool',
        tool_call_id: 'call_abc',
        content: 'Read executed',
      });
    });
  });

  it('reassembles two tool calls interleaved by index in the same round, and executes both', async () => {
    const round1: FakeStep = {
      kind: 'stream',
      parts: [
        chunkLine({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_0', type: 'function', function: { name: 'Read' } },
                  { index: 1, id: 'call_1', type: 'function', function: { name: 'Gre' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        chunkLine({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 1, function: { name: 'p' } },
                  { index: 0, function: { arguments: '{"pa' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        chunkLine({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'th":"a.txt"}' } },
                  { index: 1, function: { arguments: '{"pattern":"foo"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        DONE_LINE,
      ],
    };
    const round2: FakeStep = {
      kind: 'stream',
      parts: [chunkLine({ choices: [{ index: 0, delta: { content: 'Both done.' }, finish_reason: null }] }), DONE_LINE],
    };

    await withServer([round1, round2], async (server) => {
      const tools = stubTools({ catalog: ['Read', 'Grep'] });
      const provider = makeProvider(server, { tools });
      const events = await collect(provider.run(makeRequest({ allowedTools: ['Read', 'Grep'] })));

      expect(tools.calls).toEqual([
        { name: 'Read', input: { path: 'a.txt' } },
        { name: 'Grep', input: { pattern: 'foo' } },
      ]);
      expect(events.filter((e) => e.t === 'tool')).toHaveLength(2);
      expect(events.some((e) => e.t === 'error')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Reporting a run-wide model override (defect 6 coverage — resolveAgentModel
// itself is covered exhaustively in apiConfig.test.ts; this proves the
// adapter actually surfaces what that function returns).
// ---------------------------------------------------------------------------

describe('reporting a run-wide model override', () => {
  it('yields exactly one non-fatal error event when a run-wide model overrides the agent catalog model, and still completes the run normally', async () => {
    const steps: FakeStep[] = [
      { kind: 'stream', parts: [chunkLine({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }), DONE_LINE] },
    ];

    await withServer(steps, async (server) => {
      const provider = new OpenAiCompatibleProvider('openai', {
        model: 'gpt-4o-mini',
        deps: {
          env: { OPENAI_API_KEY: 'test-openai-key', OPENAI_BASE_URL: server.url },
          tools: () => stubTools({ catalog: [] }),
        },
      });
      const events = await collect(provider.run(makeRequest({ model: 'sonnet' })));

      const warnings = events.filter((e) => e.t === 'error' && !e.fatal);
      expect(warnings).toHaveLength(1);
      const message = warnings[0]?.t === 'error' ? warnings[0].message : '';
      expect(message).toContain('sonnet');
      expect(message).toContain('gpt-4o-mini');

      expect(events.some((e) => e.t === 'text' && e.chunk === 'ok')).toBe(true);
      expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);

      const body = server.requests[0]!.bodyJson as { model: string };
      expect(body.model).toBe('gpt-4o-mini');
    });
  });
});

// ---------------------------------------------------------------------------
// Tool allowlisting
// ---------------------------------------------------------------------------

describe('tool allowlisting', () => {
  it('never offers Write to a model whose allowedTools is only Read', async () => {
    const steps: FakeStep[] = [
      { kind: 'stream', parts: [chunkLine({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }), DONE_LINE] },
    ];

    await withServer(steps, async (server) => {
      const tools = stubTools({ catalog: ['Read', 'Write'] });
      const provider = makeProvider(server, { tools });
      await collect(provider.run(makeRequest({ allowedTools: ['Read'] })));

      const body = server.requests[0]!.bodyJson as { tools: Array<{ function: { name: string } }> };
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]!.function.name).toBe('Read');
      expect(JSON.stringify(body.tools)).not.toContain('Write');
    });
  });
});

// ---------------------------------------------------------------------------
// Malformed frames
// ---------------------------------------------------------------------------

describe('a malformed SSE frame', () => {
  it('is skipped as a non-fatal diagnostic, and surrounding frames still stream correctly', async () => {
    const steps: FakeStep[] = [
      {
        kind: 'stream',
        parts: [
          chunkLine({ choices: [{ index: 0, delta: { content: 'before ' }, finish_reason: null }] }),
          // Deliberately broken JSON — an unterminated object.
          'data: {"choices": [{"index": 0, "delta": {"content": "oops"\n\n',
          chunkLine({ choices: [{ index: 0, delta: { content: 'after' }, finish_reason: null }] }),
          DONE_LINE,
        ],
      },
    ];

    await withServer(steps, async (server) => {
      const onDiagnostic = vi.fn();
      const provider = makeProvider(server, { onDiagnostic });
      const events = await collect(provider.run(makeRequest()));

      const text = events
        .filter((e) => e.t === 'text')
        .map((e) => (e as Extract<AgentEvent, { t: 'text' }>).chunk)
        .join('');
      expect(text).toBe('before after');
      expect(events.some((e) => e.t === 'error')).toBe(false);
      expect(onDiagnostic).toHaveBeenCalledTimes(1);
      expect(onDiagnostic.mock.calls[0]![0]).toContain('unparseable');
    });
  });
});

// ---------------------------------------------------------------------------
// Chunk boundary mid `data:` line
// ---------------------------------------------------------------------------

describe('a transport chunk boundary landing mid data: line', () => {
  it('does not drop or corrupt the frame', async () => {
    const whole = chunkLine({ choices: [{ index: 0, delta: { content: 'split me' }, finish_reason: null }] }) + DONE_LINE;
    // Cut in the middle of the word "data:" itself, well before any line
    // boundary — the most awkward split available.
    const cut = whole.indexOf('content') + 3;
    const parts = [whole.slice(0, cut), whole.slice(cut)];

    await withServer([{ kind: 'stream', parts }], async (server) => {
      const provider = makeProvider(server);
      const events = await collect(provider.run(makeRequest()));

      const text = events
        .filter((e) => e.t === 'text')
        .map((e) => (e as Extract<AgentEvent, { t: 'text' }>).chunk)
        .join('');
      expect(text).toBe('split me');
      expect(events.some((e) => e.t === 'error')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

describe('non-2xx responses', () => {
  it('a 401 produces a fatal error naming OPENAI_API_KEY and never contains the key', async () => {
    const steps: FakeStep[] = [
      { kind: 'json', status: 401, body: { error: { message: 'Incorrect API key provided.' } } },
    ];
    const secretKey = 'sk-THE-SECRET-VALUE-DO-NOT-LEAK';

    await withServer(steps, async (server) => {
      const provider = new OpenAiCompatibleProvider('openai', {
        deps: {
          env: { OPENAI_API_KEY: secretKey, OPENAI_BASE_URL: server.url },
          tools: () => stubTools({ catalog: [] }),
        },
      });
      const events = await collect(provider.run(makeRequest()));

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({ t: 'error', fatal: true });
      const message = (event as Extract<AgentEvent, { t: 'error' }>).message;
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).toContain('Incorrect API key provided.');
      expect(message).not.toContain(secretKey);
    });
  });

  it('a 429 produces a fatal error with rate-limit wording', async () => {
    const steps: FakeStep[] = [{ kind: 'json', status: 429, body: { error: { message: 'Rate limit reached.' } } }];

    await withServer(steps, async (server) => {
      const provider = makeProvider(server);
      const events = await collect(provider.run(makeRequest()));

      expect(events).toHaveLength(1);
      const message = (events[0] as Extract<AgentEvent, { t: 'error' }>).message;
      expect(message).toContain('429');
      expect(message.toLowerCase()).toContain('rate');
    });
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancellation (FR-M9)', () => {
  it('aborting mid-stream terminates the run without emitting a spurious error event', async () => {
    const steps: FakeStep[] = [
      {
        kind: 'stream',
        parts: [chunkLine({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })],
        hangAfter: true,
      },
    ];

    await withServer(steps, async (server) => {
      const provider = makeProvider(server);
      const controller = new AbortController();
      const events: AgentEvent[] = [];

      const iterator = provider.run(makeRequest({ signal: controller.signal }))[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      events.push(first.value as AgentEvent);

      controller.abort();

      const second = await iterator.next();
      expect(second.done).toBe(true);

      expect(events).toEqual([{ t: 'text', assignmentId: 'asg-1', chunk: 'partial' }]);
    });
  });
});

// ---------------------------------------------------------------------------
// The tool-loop bound
// ---------------------------------------------------------------------------

describe('the tool-call loop bound', () => {
  it('stops with a fatal error after the configured number of rounds rather than looping forever', async () => {
    const bound = 3;
    const loopingRound = (): FakeStep => ({
      kind: 'stream',
      parts: [
        chunkLine({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
              finish_reason: null,
            },
          ],
        }),
        chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        DONE_LINE,
      ],
    });
    const steps = Array.from({ length: bound }, loopingRound);

    await withServer(steps, async (server) => {
      const tools = stubTools({ catalog: ['Read'] });
      const provider = makeProvider(server, { tools, maxToolRounds: bound });
      const events = await collect(provider.run(makeRequest({ allowedTools: ['Read'] })));

      expect(server.requests).toHaveLength(bound);
      const last = events[events.length - 1] as Extract<AgentEvent, { t: 'error' }>;
      expect(last.t).toBe('error');
      expect(last.fatal).toBe(true);
      expect(last.message).toContain(String(bound));
      expect(tools.calls).toHaveLength(bound);
    });
  });

  it('the exported default bound is a small, sane constant, not effectively unbounded', () => {
    expect(DEFAULT_MAX_TOOL_ROUNDS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_TOOL_ROUNDS).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek, through the same class
// ---------------------------------------------------------------------------

describe('the DeepSeek adapter is the same class, constructed differently', () => {
  it('reports id "deepseek" and sends the request to the DeepSeek base URL', async () => {
    const steps: FakeStep[] = [
      { kind: 'stream', parts: [chunkLine({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }), DONE_LINE] },
    ];

    await withServer(steps, async (server) => {
      const provider = new OpenAiCompatibleProvider('deepseek', {
        deps: {
          env: { DEEPSEEK_API_KEY: 'sk-deepseek-test', DEEPSEEK_BASE_URL: server.url },
          tools: () => stubTools({ catalog: [] }),
        },
      });

      expect(provider.id).toBe('deepseek');

      const events = await collect(provider.run(makeRequest()));
      expect(events.some((e) => e.t === 'error')).toBe(false);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]!.headers.authorization).toBe('Bearer sk-deepseek-test');
    });
  });
});

// ---------------------------------------------------------------------------
// ProviderUnavailableError
// ---------------------------------------------------------------------------

describe('run() when no key is configured', () => {
  it('throws ProviderUnavailableError rather than making a request', async () => {
    const provider = new OpenAiCompatibleProvider('openai', {
      deps: { env: {}, tools: () => stubTools({ catalog: [] }) },
    });

    await expect(collect(provider.run(makeRequest()))).rejects.toThrow(ProviderUnavailableError);
  });
});
