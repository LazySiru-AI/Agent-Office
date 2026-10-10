import { formatCostUsd, type AgentEvent, type Usage } from '@agent-office/shared';
import {
  apiKeyVariable,
  resolveAgentModel,
  resolveApiConfig,
  type ApiProviderConfig,
  type ApiProviderId,
} from '../apiConfig.js';
import { createSandboxedTools, type SandboxedTools } from '../apiTools.js';
import { loadMcpRegistry } from '../claude-code/mcpConfig.js';
import { composeTools } from '../composeTools.js';
import { createMcpTools, type McpTools } from '../mcpTools.js';
import { estimateRunCostUsd, priceFor } from '../pricing.js';
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
 *
 * ## MCP tools (Stage 4)
 *
 * Same shape as the Anthropic adapter, and for the same reason: this class owns
 * its own tool-use loop rather than handing tools off to a CLI that speaks MCP
 * natively, so it also owns reaching MCP servers itself. `run` loads the
 * operator's registry (`claude-code/mcpConfig.ts`'s `loadMcpRegistry`) and, when
 * one is configured, composes an `mcpTools.ts` handle with the sandboxed
 * filesystem tools via `composeTools.ts` — see that module's doc for the
 * collision policy and why `execute()` still never throws. Two invariants this
 * file's tests hold it to, identical to the Anthropic adapter's: no registry
 * configured means byte-for-byte the pre-Stage-4 behaviour (no empty MCP layer
 * composed in "for uniformity"), and the MCP handle's `close()` always runs —
 * success, a fatal error, an exception, or an abort — via the `try`/`finally`
 * around `runLoop` in `run`.
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
   * `apiConfig.ts`.
   *
   * Run-wide, and stronger than the per-agent `model:` on `AgentRunRequest`:
   * setting this states what the whole run should use. In practice it is the
   * only one that decides anything for this provider — the catalog's tiers are
   * Anthropic's vocabulary, so `resolveAgentModel` cannot translate them here
   * and says so instead of guessing.
   */
  model?: string;

  /** Bound on the tool-call loop. Default {@link DEFAULT_MAX_TOOL_ROUNDS}. */
  maxToolRounds?: number;

  /**
   * Per-assignment spend ceiling in USD (FR-M8). The name and shape match
   * `factory.ts`'s `MakeProviderOptions.maxCostUsd` and the Anthropic
   * adapter's option of the same name — construction always goes through
   * `makeProvider`, so all three must agree.
   *
   * Chat Completions has no server-side spend cap to hand this to (unlike the
   * Claude Code CLI's `--max-budget-usd`), so it is enforced here: estimated
   * spend is accumulated between rounds of the tool-call loop and the run
   * stops once it would exceed the cap — see `run`. The cap is therefore
   * checked between HTTP round trips, not mid-response, so the worst-case
   * overshoot is bounded by one round's `max_tokens`
   * (`config.maxOutputTokens`), not zero.
   *
   * `pricing.ts`'s `priceFor` returns `undefined` for *every* OpenAI and
   * DeepSeek model id — no price for either vendor has ever been verified
   * here (see this file's module doc). Setting a cap for this provider
   * therefore always means `isAvailable()` refuses to run rather than run
   * uncapped: a silently unenforced cap is precisely the defect this option
   * exists to close, and a run that never starts costs nothing.
   */
  maxCostUsd?: number;

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
    /**
     * Fed to `resolveApiConfig` AND to `loadMcpRegistry` (see `run`), so a
     * test that wants "MCP is configured" can set
     * `AGENT_OFFICE_MCP_CONFIG` in this same object rather than needing a
     * second seam that touches the real `process.env`.
     */
    env?: Record<string, string | undefined>;
    tools?: (workspaceDir: string, allowedTools?: readonly string[]) => SandboxedTools;
    /**
     * Defaults to the real `loadMcpRegistry`. Injectable for the same reason
     * `tools` is: a test proving "an MCP registry is configured" should not
     * have to write a real JSON file to disk — it can hand back an
     * `McpRegistry` value directly.
     */
    loadMcpRegistry?: typeof loadMcpRegistry;
    /**
     * Defaults to the real `mcpTools.ts` `createMcpTools`. Injectable so a
     * test can prove this adapter's MCP wiring (composition, `close()` on
     * every exit path) without spawning a real MCP server subprocess —
     * `mcpTools.ts`'s own tests own proving a real server connection behaves
     * correctly.
     */
    createMcpTools?: typeof createMcpTools;
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
  /** This round's own token usage — mirrors the `usage` event already yielded; see `consumeStream`. */
  usage: Usage | undefined;
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
      ...(this.options.deps?.env === undefined ? {} : { env: this.options.deps.env }),
      ...(this.options.model === undefined ? {} : { overrides: { model: this.options.model } }),
    });
  }

  /**
   * No network call — a missing key is read straight out of the environment.
   * Whether a requested cost cap can even be enforced is the second thing
   * checked here, for the same reason: it is knowable for free, and a run
   * that starts anyway would be exactly the "reads as working until the bill
   * arrives" defect `maxCostUsd` exists to close (see its own doc comment).
   */
  async isAvailable(): Promise<ProviderAvailability> {
    const config = this.resolveConfig();
    if (config.apiKey === '') {
      return {
        ok: false,
        reason: `no API key configured for ${this.id} — set ${apiKeyVariable(this.id)}`,
      };
    }
    if (this.options.maxCostUsd !== undefined && priceFor(config.model) === undefined) {
      return {
        ok: false,
        reason:
          `a cost cap of ${formatCostUsd(this.options.maxCostUsd)} was requested, but model "${config.model}" ` +
          `has no known price for ${this.id} — no OpenAI or DeepSeek price has ever been verified in this ` +
          'repo, so that cap cannot be enforced. Refusing to run uncapped rather than silently ignoring it; ' +
          'drop the cost cap to run this model without one.',
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
      // The third parameter is the run's SUBJECT — a read-only second root the
      // file tools may look in but no write tool can name (`apiTools.ts`).
      // Threaded through the injection seam as well as the real factory so a
      // test double sees exactly what production does.
      ((dir: string, allowed?: readonly string[], subject?: string) =>
        createSandboxedTools(dir, allowed, subject));

    // The allowlist is passed to the executor, not only used to pick which
    // schemas to advertise. Advertising and executing are separate decisions,
    // and a model can emit a call for a tool it was never offered.
    const sandboxedTools: SandboxedTools = makeTools(
      request.workspaceDir,
      request.allowedTools,
      request.subjectPath,
    );

    // --- Stage 4: MCP tools, composed alongside the sandboxed ones ---------
    //
    // Same shape as `anthropic/provider.ts`'s `run` — see that file's
    // equivalent block for the full reasoning behind each choice below
    // (env-gated registry, why creation failure degrades rather than fails
    // the run, why composition is skipped entirely rather than composing in
    // an empty layer). Duplicated rather than shared, deliberately: a reader
    // of one adapter should not have to open the other to understand this
    // one, and the two engines have no natural common module to hold a
    // shared helper without one adapter depending on the other's file.
    const loadRegistry = this.options.deps?.loadMcpRegistry ?? loadMcpRegistry;
    const mcpRegistry = loadRegistry(this.options.deps?.env);

    let mcpTools: McpTools | undefined;
    if (mcpRegistry !== undefined) {
      try {
        const makeMcpTools = this.options.deps?.createMcpTools ?? createMcpTools;
        // The assignment's allowlist is handed to the MCP handle, not just used to pick schemas —
        // see `anthropic/provider.ts`'s identical call for the reasoning (FR-M5; the `claude-code`
        // adapter's equivalent is `--allowedTools`).
        mcpTools = await makeMcpTools(mcpRegistry.configPath, {
          allowedTools: request.allowedTools,
          // FR-T4: what an agent may touch must not depend on which vendor is
          // behind it, so this adapter grants the subject root exactly as the
          // Anthropic one does — same namespace, same read-only shape.
          ...(request.subjectPath === undefined ? {} : { subjectDir: request.subjectPath }),
        });
      } catch (error) {
        // NFR-8: a registry that fails to start degrades this run to "no MCP
        // tools this time" rather than failing an assignment that never
        // needed MCP — see `anthropic/provider.ts`'s identical block for the
        // full reasoning.
        yield {
          assignmentId: request.assignmentId,
          t: 'error',
          fatal: false,
          message: `MCP tools could not be started (${describeError(error)}); continuing without them.`,
        };
      }
    }

    // Composing in an empty MCP layer "for uniformity" would change
    // `execute()`'s "no layer declares this name" wording on the common,
    // MCP-disabled path — see `composeTools.ts`'s module doc and
    // `anthropic/provider.ts`'s identical note. Skipped entirely instead.
    const tools: SandboxedTools =
      mcpTools === undefined ? sandboxedTools : composeTools(sandboxedTools, mcpTools);

    try {
      yield* this.runLoop(request, tools, config, fetchImpl);
    } finally {
      // FR-M9: an `McpTools` handle owns a spawned OS process per configured
      // server. `finally` — not a `return`-time call — makes this
      // unconditional across `runLoop`'s many early exits (the round bound,
      // the cost cap, an HTTP or stream error, an abort) and any exception
      // that escapes it. See `anthropic/provider.ts`'s identical guard for
      // the fuller reasoning.
      if (mcpTools !== undefined) {
        await mcpTools.close();
      }
    }
  }

  /**
   * The tool-call loop itself, extracted out of `run` purely so the
   * `try`/`finally` around it (the MCP `close()` guarantee — see `run`) does
   * not have to re-indent this method's entire body. Everything below is
   * unchanged from the pre-Stage-4 `run`, just moved: it still reads
   * `this.options` and calls `this.consumeStream` exactly as it did as part
   * of `run` itself, because this is still the same class instance.
   */
  private async *runLoop(
    request: AgentRunRequest,
    tools: SandboxedTools,
    config: ApiProviderConfig,
    fetchImpl: typeof fetch,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const maxRounds = this.options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const { assignmentId } = request;

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

    // Resolved once per assignment, not per round: swapping models midway
    // through a tool-use conversation would have one model answering for
    // another's calls.
    const modelChoice = resolveAgentModel(this.id, config, request.model);
    if (modelChoice.unhonoured !== undefined) {
      // Expected rather than exceptional for this provider: a catalog agent
      // saying `sonnet` is asking for something no OpenAI-compatible endpoint
      // has. Reported as a non-fatal event anyway, because "ran on a different
      // model than its definition asked for" changes both the bill and the
      // output, and silence there is how a surprise becomes a mystery.
      yield { assignmentId, t: 'error', fatal: false, message: modelChoice.unhonoured };
    }

    // `isAvailable()` (above) already refused a cap paired with an unpriced
    // provider-wide model, but `resolveAgentModel` can still pass a literal,
    // unrecognised catalog id straight through unchanged for this specific
    // assignment (see `apiConfig.ts`). Since no OpenAI or DeepSeek id is ever
    // priced anyway (`pricing.ts`'s `priceFor`), this is in practice always
    // true already whenever `maxCostUsd` is set — kept anyway so this
    // adapter never silently disagrees with `isAvailable()` about which
    // model it is actually about to run.
    if (this.options.maxCostUsd !== undefined && priceFor(modelChoice.model) === undefined) {
      yield {
        assignmentId,
        t: 'error',
        fatal: true,
        message:
          `a cost cap of ${formatCostUsd(this.options.maxCostUsd)} was requested, but this assignment's model ` +
          `"${modelChoice.model}" has no known price, so that cap cannot be enforced. Refusing to run it ` +
          'uncapped rather than silently ignoring the cap.',
      };
      return;
    }

    let sawText = false;
    let completedWithTextOnlyTurn = false;
    // FR-M8's spend cap, estimated round by round as the tool-call loop
    // runs. See `OpenAiProviderOptions.maxCostUsd` for what precision this
    // can and cannot promise.
    let spentUsd = 0;

    for (let round = 0; round < maxRounds; round += 1) {
      if (request.signal.aborted) return;

      const body: ChatCompletionRequestBody = {
        model: modelChoice.model,
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

      if (this.options.maxCostUsd !== undefined) {
        // `priceFor(modelChoice.model)` was already confirmed defined above,
        // so `estimateRunCostUsd` only returns `undefined` here if a round
        // never reported usage at all (`roundResult.usage === undefined`) —
        // `?? 0` treats that round as free rather than silently skipping the
        // cap check altogether.
        if (roundResult.usage !== undefined) {
          spentUsd += estimateRunCostUsd(roundResult.usage, modelChoice.model) ?? 0;
        }
        if (spentUsd > this.options.maxCostUsd) {
          // A round that has already returned has already been billed for —
          // there is no clawing back tokens the model already generated.
          // Stopping here bounds the *next* round rather than this one, so
          // the overshoot can be as large as one round's `max_tokens`
          // (`config.maxOutputTokens`), not exactly zero. FR-M8's "fails
          // cleanly with partial results preserved" holds because every
          // `text` event yielded so far has already reached the caller.
          yield {
            assignmentId,
            t: 'error',
            fatal: true,
            message:
              `stopping: estimated spend so far (${formatCostUsd(spentUsd)}) exceeds this assignment's cost ` +
              `cap of ${formatCostUsd(this.options.maxCostUsd)}. This estimate is checked between tool-call ` +
              `rounds, not mid-round, so the overshoot can be as large as one round's max_tokens ` +
              `(${String(config.maxOutputTokens)} tokens) rather than exactly zero.`,
          };
          return;
        }
      }

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

    // Chat Completions sends `usage` as a running total, not a per-chunk
    // delta — and some deployments attach that same cumulative figure to more
    // than one chunk in the same stream (the trailing content chunk and the
    // empty-choices chunk that follows it, in practice). Yielding a `usage`
    // event per chunk therefore handed the same 100/50 totals downstream
    // twice, and both the dispatcher and the web replay fold usage events
    // with `+=`, so the run's cost was reported as double what it actually
    // spent — exactly the kind of quiet inflation NFR-5 exists to prevent,
    // and one that trips FR-M8's budget on phantom spend. `latestUsage` is
    // overwritten, never accumulated, and yielded at most once per round —
    // last-one-wins, the same rule `message_delta`'s output-token count
    // follows in the Anthropic adapter.
    let latestUsage: { inputTokens: number; outputTokens: number } | undefined;

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
          latestUsage = {
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

    // Same FR-M9 rule as the Anthropic adapter's `consumeTurn`: an abort that
    // resolved this loop cleanly (rather than throwing, above) must not
    // produce a trailing usage event for a round that did not finish.
    if (!signal.aborted && latestUsage !== undefined) {
      yield { assignmentId, t: 'usage', inputTokens: latestUsage.inputTokens, outputTokens: latestUsage.outputTokens };
    }

    const toolAccumulators = toolCallsByChoice.get(0);
    const toolCalls =
      toolAccumulators === undefined
        ? []
        : [...toolAccumulators.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);

    return {
      text: textByChoice.get(0) ?? '',
      toolCalls,
      usage: !signal.aborted ? latestUsage : undefined,
    };
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
