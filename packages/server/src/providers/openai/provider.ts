import type { AgentEvent } from '@agent-office/shared';
import {
  apiKeyVariable,
  resolveApiConfig,
  type ApiProviderConfig,
  type ApiProviderId,
} from '../apiConfig.js';
import { createSandboxedTools, type SandboxedTools } from '../apiTools.js';
import { readSse } from '../sse.js';
import {
  ProviderUnavailableError,
  type AgentProvider,
  type AgentRunRequest,
  type ProviderAvailability,
} from '../types.js';
import {
  ChatCompletionChunkSchema,
  ErrorResponseSchema,
  type ChatCompletionRequestBody,
  type ChatMessage,
  type ChatRequestToolCall,
  type ChatToolSpec,
} from './protocol.js';

/**
 * The OpenAI Chat Completions adapter (Phase 7) — and, by construction, the
 * DeepSeek adapter. DeepSeek's API is documented as wire-compatible with
 * OpenAI's Chat Completions endpoint, so this is one class parameterised by
 * `id` (which selects, via `resolveApiConfig`, the base URL, key variable and
 * model), not two near-identical files that would silently drift the first
 * time one of them was patched. See the bottom of this file for the one place
 * that distinction actually shows up, and the constructor for how a DeepSeek
 * instance is made.
 *
 * ## VERIFIED vs ASSUMED — read this before trusting anything below
 *
 * No API key of any kind — OpenAI, DeepSeek, or otherwise — was available on
 * this machine while this file was written, and neither live endpoint was
 * ever called. That makes "verified" narrower here than it was for the Claude
 * Code adapter, which was built against a captured CLI transcript:
 *
 * - VERIFIED: this adapter's own parsing, tool-call reassembly, error
 *   handling and cancellation, exercised in `provider.test.ts` against
 *   `fakeServer.ts` — a local HTTP double that speaks the *published*
 *   Chat Completions wire format (SSE framing, delta/tool-call shapes,
 *   `[DONE]`, the error envelope). Every assertion in that suite is about
 *   this file's behaviour given that wire format, full stop.
 *
 * - ASSUMED, NOT VERIFIED: that the fake server's wire format actually
 *   matches either live API. It was built from public documentation and
 *   general knowledge of the format, not from a captured response. Two
 *   specific soft spots, in order of how likely they are to bite first:
 *     1. `max_tokens` vs `max_completion_tokens` (see `protocol.ts`) — this
 *        adapter sends `max_tokens`.
 *     2. Whether `stream_options.include_usage` is honoured identically by
 *        DeepSeek — if not, usage simply never arrives for that leg of the
 *        run (see the comment above the request body below); it does not
 *        break anything, but NFR-5's cost accounting under-reports.
 *   The model names `apiConfig.ts` defaults to are flagged there, for the
 *   same reason, as guesses.
 *
 * ## The tool-call loop
 *
 * Reassembling a streamed tool call is the hardest part of this file and
 * where a bug would hide. A tool call arrives as *fragments*: `index` is the
 * only field guaranteed complete on every fragment, and `id`,
 * `function.name` and `function.arguments` are all partial, concatenated
 * across many deltas — `arguments` in particular arrives as a JSON string
 * chopped at arbitrary byte boundaries, sometimes mid-string-literal. The
 * fix is structural, not defensive: accumulate every fragment by `index` for
 * the whole HTTP response, and do not attempt `JSON.parse` on the arguments
 * until the stream for that round has ended (`consumeStream`, below). There
 * is no earlier point at which "the arguments so far" is meaningfully valid
 * JSON, so there is no earlier point at which parsing it could be correct.
 */

export type OpenAiCompatibleId = Extract<ApiProviderId, 'openai' | 'deepseek'>;

/**
 * Bound on the tool-call loop (see `run`, below).
 *
 * A model that never returns a text-only turn must not hang a run forever —
 * the same failure shape FR-M8's per-assignment spend cap targets, one layer
 * up: runaway *iteration* rather than runaway tokens. Each round already
 * costs at most `maxOutputTokens`, so the worst case for a run that hits this
 * bound is `DEFAULT_MAX_TOOL_ROUNDS * maxOutputTokens`, not unbounded spend.
 * 25 is chosen as generous enough for any realistic multi-step tool sequence
 * this catalog's agents need (reading a handful of files, editing, checking,
 * writing a report) while still turning a genuinely looping model into a
 * clearly labelled failure within a few seconds rather than a silent hang.
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 25;

export interface OpenAiProviderOptions {
  /**
   * Passed to `resolveApiConfig` as `overrides.model`. Unset falls through to
   * the `<PROVIDER>_MODEL` environment variable, then the guessed default in
   * `apiConfig.ts`. Provider-wide rather than per-assignment for the same
   * reason noted in `claude-code/provider.ts`: `AgentRunRequest` carries no
   * model.
   */
  model?: string;

  /** Bound on the tool-call loop. Default {@link DEFAULT_MAX_TOOL_ROUNDS}. */
  maxToolRounds?: number;

  /**
   * Surface for adapter-level diagnostics that are not agent events —
   * a malformed SSE frame, a chunk that does not match the expected shape, a
   * tool call whose arguments were not valid JSON. Mirrors the Claude Code
   * adapter's `onDiagnostic`: these must not become fatal `error` events
   * (NFR-8 asks for degradation, not failure) but dropping them silently is
   * how a real-world format quirk becomes a mystery later.
   */
  onDiagnostic?: (message: string) => void;

  /**
   * Seams, injected only by tests — same convention as
   * `claude-code/provider.ts`'s `deps`.
   *
   * `tools` stands in for `apiTools.ts`'s `createSandboxedTools`. That module
   * is owned by a different Phase 7 workstream; tests here inject a
   * hand-written stub of the same `SandboxedTools` interface so they do not
   * depend on its completion or its filesystem behaviour, which is out of
   * scope for this file.
   */
  deps?: {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    tools?: (workspaceDir: string, allowedTools?: readonly string[]) => SandboxedTools;
  };
}

/** One streamed tool call, reassembled by concatenating every fragment sharing an `index`. */
interface ToolCallAccumulator {
  id: string;
  name: string;
  /** The raw JSON string as sent by the model — parsed only once complete. */
  argumentsJson: string;
}

/** What one HTTP round of the loop produced. */
interface RoundResult {
  text: string;
  toolCalls: ToolCallAccumulator[];
}

export class OpenAiCompatibleProvider implements AgentProvider {
  readonly id: OpenAiCompatibleId;

  private readonly options: OpenAiProviderOptions;

  constructor(id: OpenAiCompatibleId, options: OpenAiProviderOptions = {}) {
    this.id = id;
    this.options = options;
  }

  private resolveConfig(): ApiProviderConfig {
    return resolveApiConfig(this.id, {
      env: this.options.deps?.env,
      ...(this.options.model === undefined ? {} : { overrides: { model: this.options.model } }),
    });
  }

  /** No network call — a missing key is read straight out of the environment. */
  async isAvailable(): Promise<ProviderAvailability> {
    const config = this.resolveConfig();
    if (config.apiKey === '') {
      return {
        ok: false,
        reason: `no API key configured for ${this.id} — set ${apiKeyVariable(this.id)}`,
      };
    }
    return { ok: true };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const availability = await this.isAvailable();
    if (!availability.ok) {
      throw new ProviderUnavailableError(this.id, availability.reason ?? 'unknown reason');
    }

    const config = this.resolveConfig();
    const fetchImpl = this.options.deps?.fetch ?? fetch;
    const makeTools =
      this.options.deps?.tools ??
      ((dir: string, allowed?: readonly string[]) => createSandboxedTools(dir, allowed));
    const maxRounds = this.options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const { assignmentId } = request;

    // The allowlist is passed to the executor, not only used to pick which
    // schemas to advertise. Advertising and executing are separate decisions,
    // and a model can emit a call for a tool it was never offered.
    const tools = makeTools(request.workspaceDir, request.allowedTools);
    const toolSpecs: ChatToolSpec[] = tools.schemas(request.allowedTools).map((schema) => ({
      type: 'function',
      function: {
        name: schema.name,
        description: schema.description,
        parameters: schema.inputSchema,
      },
    }));

    // No system/developer-role split attempted here: Chat Completions accepts
    // a plain `system` message on every model this adapter targets, and the
    // agent's markdown body is used verbatim as its content (FR-M5's "nothing
    // else"), matching how the Claude Code adapter treats it.
    const messages: ChatMessage[] = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.task },
    ];

    let sawText = false;
    let completedWithTextOnlyTurn = false;

    for (let round = 0; round < maxRounds; round += 1) {
      if (request.signal.aborted) return;

      const body: ChatCompletionRequestBody = {
        model: config.model,
        messages,
        stream: true,
        // Chat Completions only reports token usage when asked. Without this,
        // the stream ends at `[DONE]` with no usage figure at all — not an
        // error, just silence — which would make NFR-5's cost accounting
        // quietly wrong rather than loudly broken. A provider that does not
        // recognise the option is expected, per the documented contract, to
        // ignore it; if that assumption is wrong for DeepSeek specifically,
        // this run degrades to "no usage event this round", not a failure.
        stream_options: { include_usage: true },
        max_tokens: config.maxOutputTokens,
        ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Never logged, never placed in an `AgentEvent` — see
            // `apiConfig.ts`'s `describeConfig` for the one sanctioned way to
            // talk about a key at all.
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        // FR-M9: an abort here is the orchestrator's own doing (cancel, or
        // FR-M8's timeout) — it already knows. Reporting it as an `error`
        // event would turn a deliberate cancellation into a spurious failure
        // in the run log, the same distinction `claude-code/provider.ts`
        // draws around its own abort handling.
        if (request.signal.aborted) return;
        yield {
          assignmentId,
          t: 'error',
          message: `could not reach ${this.id}: ${describeError(error)}`,
          fatal: true,
        };
        return;
      }

      if (!response.ok) {
        yield {
          assignmentId,
          t: 'error',
          message: await describeHttpError(response, this.id),
          fatal: true,
        };
        return;
      }

      const roundResult = yield* this.consumeStream(response, assignmentId, request.signal);
      if (request.signal.aborted) return;

      if (roundResult.text.length > 0) sawText = true;

      if (roundResult.toolCalls.length === 0) {
        completedWithTextOnlyTurn = true;
        break;
      }

      const toolCallsForMessage: ChatRequestToolCall[] = roundResult.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson },
      }));

      // The assistant's tool-call turn must be echoed back verbatim before
      // any tool results — the API rejects a `tool` message that does not
      // answer a `tool_calls` entry in the immediately preceding assistant
      // message.
      messages.push({
        role: 'assistant',
        content: roundResult.text.length > 0 ? roundResult.text : null,
        tool_calls: toolCallsForMessage,
      });

      for (const call of roundResult.toolCalls) {
        yield {
          assignmentId,
          t: 'tool',
          name: call.name.length > 0 ? call.name : '(unnamed tool)',
          summary: summariseToolCall(call.name, call.argumentsJson),
        };

        if (request.signal.aborted) return;

        if (call.name.length === 0) {
          this.options.onDiagnostic?.(
            'a streamed tool call finished with no name; reporting it back to the model as an error rather than guessing which tool it meant',
          );
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'error: this tool call arrived with no tool name.',
          });
          continue;
        }

        let input: unknown = {};
        let argumentError: string | undefined;
        if (call.argumentsJson.length > 0) {
          try {
            input = JSON.parse(call.argumentsJson);
          } catch (error) {
            argumentError = describeError(error);
          }
        }

        if (argumentError !== undefined) {
          // The model's mistake, not this adapter's to crash on (NFR-8): tell
          // it what went wrong so the next round can retry, the same way a
          // sandboxed tool's own failures come back as `isError` rather than
          // a thrown exception.
          this.options.onDiagnostic?.(
            `tool "${call.name}" arrived with arguments that did not parse as JSON: ${argumentError}`,
          );
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `error: arguments for "${call.name}" were not valid JSON: ${argumentError}`,
          });
          continue;
        }

        const result = await tools.execute(call.name, input);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
        if (result.isError) {
          this.options.onDiagnostic?.(`tool "${call.name}" reported an error: ${truncate(result.content, 200)}`);
        }
      }
    }

    if (!completedWithTextOnlyTurn) {
      yield {
        assignmentId,
        t: 'error',
        message:
          `the tool-call loop exceeded ${String(maxRounds)} rounds without the model returning a text-only turn; ` +
          'stopping rather than continuing to spend on what looks like a runaway loop',
        fatal: true,
      };
      return;
    }

    // The interface contract (`types.ts`) is "must emit at least one `text`
    // event carrying the agent's final answer". A model whose last turn is
    // genuinely empty (no content deltas at all, just `finish_reason: stop`)
    // is a degenerate but real case; emitting an explicit empty chunk here
    // keeps that contract true rather than silently emitting nothing.
    if (!sawText) {
      yield { assignmentId, t: 'text', chunk: '' };
    }
  }

  /**
   * Consume one HTTP response's SSE stream to completion, yielding `text` and
   * `usage` events as they arrive and reassembling any streamed tool calls.
   *
   * Delegated out of `run` as its own generator (rather than inlined) so the
   * reassembly state — per-choice text and per-choice, per-index tool-call
   * accumulators — is scoped to exactly one round and cannot leak into the
   * next one.
   */
  private async *consumeStream(
    response: Response,
    assignmentId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, RoundResult> {
    // Keyed by the API's own choice `index`. Always 0 in practice — this
    // adapter never sends `n > 1` — but keyed rather than assumed singular so
    // a provider that ignores that degrades to "extra choices ignored", not
    // "silently interleaved with choice 0's text".
    const textByChoice = new Map<number, string>();
    const toolCallsByChoice = new Map<number, Map<number, ToolCallAccumulator>>();

    try {
      for await (const sseEvent of readSse(response.body, signal)) {
        // The literal terminal payload, not an SSE `event:` name — see the
        // class comment on `sse.ts` for why that distinction matters here.
        if (sseEvent.data === '[DONE]') break;

        let raw: unknown;
        try {
          raw = JSON.parse(sseEvent.data);
        } catch (error) {
          // NFR-8: one bad frame degrades the run, it does not end it. A
          // truncated final frame from a killed connection looks exactly like
          // this too, which is exactly the case abort handling below already
          // covers by checking `signal.aborted` once this loop exits.
          this.options.onDiagnostic?.(`unparseable SSE data frame, skipped: ${describeError(error)}`);
          continue;
        }

        const parsed = ChatCompletionChunkSchema.safeParse(raw);
        if (!parsed.success) {
          this.options.onDiagnostic?.(
            `SSE frame did not match the expected chat-completion-chunk shape, skipped: ${parsed.error.message}`,
          );
          continue;
        }
        const chunk = parsed.data;

        if (chunk.usage != null) {
          yield {
            assignmentId,
            t: 'usage',
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }

        for (const choice of chunk.choices) {
          const { delta } = choice;

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            const prior = textByChoice.get(choice.index) ?? '';
            textByChoice.set(choice.index, prior + delta.content);
            yield { assignmentId, t: 'text', chunk: delta.content };
          }

          if (delta.tool_calls !== undefined) {
            let byIndex = toolCallsByChoice.get(choice.index);
            if (byIndex === undefined) {
              byIndex = new Map();
              toolCallsByChoice.set(choice.index, byIndex);
            }

            for (const fragment of delta.tool_calls) {
              // The reassembly this file exists to get right. `fragment.index`
              // is the only thing trusted to identify which call this piece
              // belongs to; `id`, `function.name` and `function.arguments` are
              // all appended, never overwritten, and never inspected as JSON
              // until the whole stream (not just this one fragment, not even
              // just this one chunk) has ended.
              const existing = byIndex.get(fragment.index) ?? { id: '', name: '', argumentsJson: '' };
              existing.id += fragment.id ?? '';
              existing.name += fragment.function?.name ?? '';
              existing.argumentsJson += fragment.function?.arguments ?? '';
              byIndex.set(fragment.index, existing);
            }
          }
        }
      }
    } catch (error) {
      // `signal` was passed directly into `fetch`'s own `signal` option
      // (see `run`, above), so aborting it does not only trigger `readSse`'s
      // own `reader.cancel()` — the Fetch spec has `fetch` itself react to
      // the same signal by erroring the response body stream with an
      // `AbortError`, and that reaction typically wins the race. Either path
      // is cancellation working correctly, not a stream failure, so an abort
      // in flight is swallowed here rather than left to propagate as a
      // rejected `next()` call — `run`'s own `if (request.signal.aborted)
      // return;` immediately after this generator is delegated to is what
      // actually ends the run cleanly (FR-M9: no spurious failure event).
      // Anything else is a genuine, unexpected transport failure and is
      // rethrown — the interface contract explicitly allows a thrown error
      // here ("a thrown error is still handled, but loses the partial event
      // stream").
      if (!signal.aborted) throw error;
    }

    const toolAccumulators = toolCallsByChoice.get(0);
    const toolCalls =
      toolAccumulators === undefined
        ? []
        : [...toolAccumulators.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);

    return { text: textByChoice.get(0) ?? '', toolCalls };
  }
}

function summariseToolCall(name: string, argumentsJson: string): string {
  const label = name.length > 0 ? name : '(unnamed tool)';
  if (argumentsJson.length === 0) return label;
  return `${label} ${truncate(argumentsJson, 80)}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render a non-2xx response as a message safe to put in an `error` event:
 * the API's own explanation where one parses, never the request's own
 * `Authorization` header, and an actionable pointer to the key variable for
 * the two status codes that are almost always a key problem.
 */
async function describeHttpError(response: Response, providerId: OpenAiCompatibleId): Promise<string> {
  const bodyText = await response.text().catch(() => '');

  let apiMessage: string | undefined;
  if (bodyText.length > 0) {
    try {
      const parsed = ErrorResponseSchema.safeParse(JSON.parse(bodyText));
      if (parsed.success) apiMessage = parsed.data.error.message;
    } catch {
      // Not JSON — a gateway or load balancer in front of either API may
      // return a plain-text or HTML error page instead of the documented
      // envelope. Fall through to the raw body below.
    }
  }

  const detail = apiMessage ?? (bodyText.length > 0 ? truncate(bodyText, 300) : response.statusText);

  if (response.status === 401 || response.status === 403) {
    return (
      `${providerId} rejected the request as unauthenticated (HTTP ${String(response.status)}): ${detail}. ` +
      `Check ${apiKeyVariable(providerId)}.`
    );
  }
  if (response.status === 429) {
    return `${providerId} rate-limited this request (HTTP 429): ${detail}. Retry later or reduce concurrency.`;
  }
  return `${providerId} returned HTTP ${String(response.status)}: ${detail}`;
}
