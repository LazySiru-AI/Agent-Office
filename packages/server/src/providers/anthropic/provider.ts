import { formatCostUsd, type AgentEvent, type Usage } from '@agent-office/shared';
import { createSandboxedTools, type SandboxedTools } from '../apiTools.js';
import {
  apiKeyVariable,
  resolveAgentModel,
  resolveApiConfig,
  type ApiProviderConfig,
  type ResolveConfigOptions,
} from '../apiConfig.js';
import { estimateRunCostUsd, priceFor } from '../pricing.js';
import { readSse } from '../sse.js';
import {
  ProviderUnavailableError,
  type AgentProvider,
  type AgentRunRequest,
  type ProviderAvailability,
} from '../types.js';
import {
  AnthropicErrorBodySchema,
  AnthropicStreamEventSchema,
  ASSUMED_ANTHROPIC_VERSION,
  ContentBlockDeltaEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockStopEventSchema,
  InputJsonDeltaSchema,
  MessageDeltaEventSchema,
  MessageStartEventSchema,
  ResponseTextBlockSchema,
  ResponseToolUseBlockSchema,
  StreamErrorEventSchema,
  TextDeltaSchema,
  totalInputTokens,
  totalOutputTokens,
  type AnthropicMessageParam,
  type AnthropicMessagesRequestBody,
  type AnthropicStreamEvent,
  type AnthropicToolDefinition,
  type RequestContentBlock,
  type RequestToolResultBlock,
  type ResponseContentBlock,
} from './protocol.js';

/**
 * The Anthropic Messages API adapter (PLAN.md Phase 7).
 *
 * Mirrors `claude-code/provider.ts`'s shape deliberately: same `deps`
 * injection seam for testing, same "abort must never read as a failure"
 * discipline (FR-M9), same "one fatal error per genuine failure" instinct.
 * What differs is the transport — `fetch` + SSE instead of a spawned child
 * process — and that this adapter, not a CLI, owns the tool-use loop.
 *
 * **No API key exists on this machine.** Every claim this file makes about
 * request/response shape traces back to `protocol.ts`'s module doc, which is
 * explicit about what in there is documented-and-trusted versus guessed.
 * Nothing here has been run against `api.anthropic.com`. The whole test
 * suite (`provider.test.ts`) runs against `fakeServer.ts`, a local stand-in —
 * see that file's module doc for exactly what that does and does not prove.
 */

/**
 * Bound on tool-use round trips (API calls) within one assignment.
 *
 * Chosen without a live endpoint to calibrate against, so this is a judgement
 * call rather than an empirical one — recorded here so it is easy to revisit
 * once real usage exists. The reasoning: a catalog agent doing focused,
 * single-purpose work (PLAN.md's whole premise for the roster) reads a
 * handful of files, runs a search or two, maybe writes one report — comfortably
 * under ten tool-use turns in the overwhelming majority of runs. 30 leaves
 * roughly 3x headroom above that for a legitimately involved multi-file task,
 * while still guaranteeing that a model stuck calling a no-op tool (or a tool
 * whose result it keeps misreading) hits a hard, cheap stop rather than
 * burning the FR-M8 budget one HTTP round trip at a time. This is a loop
 * bound, not a cost bound — see {@link AnthropicProviderOptions.maxCostUsd}
 * for this provider's (now-existing) equivalent of the CLI adapter's
 * `--max-budget-usd`.
 */
export const MAX_TOOL_ITERATIONS = 30;

export interface AnthropicProviderOptions {
  /**
   * Passed to `resolveApiConfig` as `overrides.model`. Unset falls through to
   * the `ANTHROPIC_MODEL` environment variable, then the default in
   * `apiConfig.ts`.
   *
   * Run-wide, and stronger than the per-agent `model:` that now arrives on
   * `AgentRunRequest`: setting this states what the whole run should use, so it
   * outranks the catalog's standing default for any one agent. See
   * `resolveAgentModel`.
   */
  model?: string;
  /** Sent as the `anthropic-version` header. Defaults to `protocol.ts`'s `ASSUMED_ANTHROPIC_VERSION`. */
  apiVersion?: string;
  /** Overrides {@link MAX_TOOL_ITERATIONS} for one provider instance (tests only, in practice). */
  maxToolIterations?: number;
  /**
   * Per-assignment spend ceiling in USD (FR-M8). The name and shape match
   * `factory.ts`'s `MakeProviderOptions.maxCostUsd`, which is how a run
   * actually sets this — construction always goes through `makeProvider`.
   *
   * Unlike the Claude Code adapter, which hands this straight to the CLI's own
   * `--max-budget-usd` and lets it enforce the cap mid-response, this adapter
   * has no such primitive: a `/v1/messages` call is billed in full once it
   * returns, with no way to stop part-way through one. The cap is therefore
   * checked *between* tool-use rounds, using `pricing.ts`'s estimate of what
   * has been spent so far — not during a round. That makes the guarantee
   * weaker than the CLI's: the worst-case overshoot is bounded by one round's
   * `max_tokens` (`config.maxOutputTokens`), not by zero. Say so plainly in
   * the fatal error this produces rather than implying a precision this
   * adapter cannot deliver.
   *
   * If this is set and the resolved model has no known price (`pricing.ts`'s
   * `priceFor` returns `undefined` — every OpenAI/DeepSeek id, and any
   * Anthropic id whose tier this repo does not recognise), the adapter
   * refuses to run at all rather than run uncapped: see `isAvailable()`. A
   * cap that silently does not apply is the exact defect this option exists
   * to close, and a run that never starts costs nothing, unlike one that
   * ignores its cap.
   */
  maxCostUsd?: number;
  /** Surface for adapter-level diagnostics that are not agent events — same contract as `claude-code`'s. */
  onDiagnostic?: (message: string) => void;
  /**
   * Seams, injected only by tests. Follows the same deps-object convention as
   * `ClaudeCodeProviderOptions` rather than inventing a second style.
   */
  deps?: {
    /** Defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Defaults to the real `createSandboxedTools`. */
    createTools?: typeof createSandboxedTools;
    /** Fed to `resolveApiConfig`, so tests never depend on this machine's real environment. */
    env?: Record<string, string | undefined>;
    /** Fed to `resolveApiConfig`; typically `{ baseUrl }` pointed at `fakeServer.ts`. */
    configOverrides?: Partial<ApiProviderConfig>;
  };
}

/** One resolved `tool_use` block: what to execute and what to echo back. */
interface PendingToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What one API turn (one `/v1/messages` call) produced, once its stream ends. */
interface TurnOutcome {
  /** True when the turn ended via a mid-stream `error` event; the caller must stop, no further event needed. */
  fatal: boolean;
  /** The assistant's content blocks, in order, ready to echo back on the next turn. */
  assistantContent: RequestContentBlock[];
  /** Every `tool_use` block the model asked for, in order. */
  pendingToolUses: PendingToolUse[];
  /** False if the stream ended without a `message_stop` — a truncated/dropped connection. */
  sawMessageStop: boolean;
  /**
   * Whether this turn yielded at least one `text` event (i.e. saw a
   * `text_delta`, even one carrying an empty string). Tracked per turn, not
   * inferred from `assistantContent`, because `run`'s text-only-turn branch
   * needs to know across the *whole* tool-use loop whether any turn ever
   * produced text — see the guard where it is used.
   */
  sawText: boolean;
  /**
   * This turn's own token usage, mirroring the `usage` event already yielded
   * (not accumulated across turns — `run`'s `maxCostUsd` check does that).
   * `undefined` when the turn never reported usage at all, the same
   * condition `sawUsage` guards for the event.
   */
  usage: Usage | undefined;
}

/** Accumulates one content block across `content_block_delta` events keyed by `index`. */
type BlockAcc =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; partialJson: string }
  /** Extended-thinking or genuinely unknown block types: tracked only so
   *  indices line up; never surfaced and never echoed back — see protocol.ts. */
  | { type: 'other' };

export class AnthropicProvider implements AgentProvider {
  readonly id = 'anthropic' as const;

  private readonly options: AnthropicProviderOptions;

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
  }

  private resolveConfig(): ApiProviderConfig {
    // `deps.configOverrides` (test-only) and `options.model` (the production
    // per-provider-instance knob) both land in `overrides`, with `model`
    // folded in last so a test can still override the whole config wholesale
    // without `model` silently winning — in practice the two are never set
    // together.
    const overrides: Partial<ApiProviderConfig> = {
      ...this.options.deps?.configOverrides,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    };
    const resolveOptions: ResolveConfigOptions = {
      ...(this.options.deps?.env === undefined ? {} : { env: this.options.deps.env }),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    };
    return resolveApiConfig('anthropic', resolveOptions);
  }

  /**
   * No network call, by design (the brief is explicit: "a preflight that
   * costs money or hangs is worse than no preflight"). A missing key is one
   * thing checkable for free; whether a requested cost cap can even be
   * enforced is another, and both are cheap enough to check here.
   *
   * The model checked against `priceFor` is `config.model` — the run-wide
   * resolved model, before any per-agent catalog override — because that is
   * all this preflight knows: `AgentRunRequest.model` only exists once a run
   * starts. `run()` cannot fully substitute for that gap either (a catalog
   * agent could in principle name an unpriced model literal directly), but a
   * provider-wide cap paired with a provider-wide unpriced model is the case
   * that matters in practice, and is exactly what `makeProvider` constructs.
   */
  async isAvailable(): Promise<ProviderAvailability> {
    const config = this.resolveConfig();
    if (config.apiKey === '') {
      return { ok: false, reason: `${apiKeyVariable('anthropic')} is not set` };
    }
    if (this.options.maxCostUsd !== undefined && priceFor(config.model) === undefined) {
      return {
        ok: false,
        reason:
          `a cost cap of ${formatCostUsd(this.options.maxCostUsd)} was requested, but model "${config.model}" ` +
          'has no known price, so that cap cannot be enforced. Running uncapped would defeat the point of ' +
          'asking for one, so this run does not start — either drop the cost cap or use a model this repo ' +
          'has a price for (a "sonnet", "haiku" or "opus" tier id).',
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
    const makeTools = this.options.deps?.createTools ?? createSandboxedTools;
    // The allowlist goes to the executor, not only to the schema list.
    // Advertising a tool and executing one are separate decisions, and a model
    // can emit a call for a tool it was never offered (FR-M5).
    const tools: SandboxedTools = makeTools(request.workspaceDir, request.allowedTools);
    const toolSchemas = tools.schemas(request.allowedTools);
    const toolDefinitions = toolSchemas.map(toAnthropicToolDef);

    // The agent's catalog `model:` — `sonnet`, `haiku` or nothing — resolved to
    // something this API will accept. Done once per assignment rather than per
    // turn: the model must not change underneath a tool-use loop, or the second
    // half of a conversation would be answered by a different model than the
    // half it is replying to.
    const modelChoice = resolveAgentModel('anthropic', config, request.model);
    if (modelChoice.unhonoured !== undefined) {
      // Non-fatal, and deliberately an event rather than a diagnostic: which
      // model an agent ran on decides what it cost and how good it was, so a
      // substitution belongs in front of whoever is paying.
      yield {
        assignmentId: request.assignmentId,
        t: 'error',
        fatal: false,
        message: modelChoice.unhonoured,
      };
    }

    // `isAvailable()` (above) already refused a cap paired with an unpriced
    // *provider-wide* model. `modelChoice.model` can still diverge from that
    // — an agent's catalog frontmatter can name a literal, unrecognised model
    // id that `resolveAgentModel` passes through unchanged (see
    // `apiConfig.ts`). Re-checking here closes that gap for the model this
    // specific assignment actually runs on, before a single request is sent.
    if (this.options.maxCostUsd !== undefined && priceFor(modelChoice.model) === undefined) {
      yield {
        assignmentId: request.assignmentId,
        t: 'error',
        fatal: true,
        message:
          `a cost cap of ${formatCostUsd(this.options.maxCostUsd)} was requested, but this assignment's model ` +
          `"${modelChoice.model}" has no known price, so that cap cannot be enforced. Refusing to run it ` +
          'uncapped rather than silently ignoring the cap.',
      };
      return;
    }

    const messages: AnthropicMessageParam[] = [{ role: 'user', content: request.task }];
    const maxIterations = this.options.maxToolIterations ?? MAX_TOOL_ITERATIONS;
    // FR-M8's spend cap, estimated turn by turn as the tool-use loop runs.
    // See `AnthropicProviderOptions.maxCostUsd` for what precision this can
    // and cannot promise.
    let spentUsd = 0;

    // The interface contract (`types.ts`) is "must emit at least one `text`
    // event carrying the agent's final answer". Tracked across the whole
    // tool-use loop, not just the last turn: a turn that only calls tools
    // produces no text, and the turn that finally stops calling tools is the
    // one this guard cares about.
    let sawText = false;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (request.signal.aborted) return;

      const body: AnthropicMessagesRequestBody = {
        model: modelChoice.model,
        max_tokens: config.maxOutputTokens,
        system: request.systemPrompt,
        messages,
        stream: true,
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
      };

      let outcome: TurnOutcome;
      try {
        const response = await fetchImpl(`${config.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': this.options.apiVersion ?? ASSUMED_ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });

        if (!response.ok) {
          const message = await this.describeHttpError(response);
          yield { assignmentId: request.assignmentId, t: 'error', fatal: true, message };
          return;
        }

        outcome = yield* this.consumeTurn(response, request);
      } catch (err) {
        // Aborting an in-flight fetch (or the body stream it opened) can
        // surface as a rejection here rather than as a graceful end of the
        // SSE iterable, depending on exactly when the abort lands relative to
        // the request lifecycle. Either shape must resolve to "stop quietly",
        // per FR-M9 and to match `claude-code/provider.ts`'s own rule that a
        // deliberate cancel must never read as a provider failure.
        if (request.signal.aborted) return;
        yield {
          assignmentId: request.assignmentId,
          t: 'error',
          fatal: true,
          message: `could not complete the request to the Anthropic API: ${describeError(err)}`,
        };
        return;
      }

      // Same FR-M9 rule, for the case where the abort landed cleanly (no
      // throw) partway through `consumeTurn` — readSse's own cancellation
      // resolves its iterable rather than rejecting it.
      if (request.signal.aborted) return;

      if (outcome.fatal) return; // consumeTurn already emitted the error event.

      if (outcome.sawText) sawText = true;

      if (!outcome.sawMessageStop) {
        yield {
          assignmentId: request.assignmentId,
          t: 'error',
          fatal: true,
          message: 'the Anthropic API stream ended before a terminal "message_stop" event arrived',
        };
        return;
      }

      if (this.options.maxCostUsd !== undefined) {
        // `priceFor(modelChoice.model)` was already confirmed defined above,
        // so `estimateRunCostUsd` only returns `undefined` here if a turn
        // never reported usage at all (`outcome.usage === undefined`) — rare,
        // but not a reason to under-count: `?? 0` treats an unpriceable turn
        // as free rather than silently skipping the cap check altogether.
        if (outcome.usage !== undefined) {
          spentUsd += estimateRunCostUsd(outcome.usage, modelChoice.model) ?? 0;
        }
        if (spentUsd > this.options.maxCostUsd) {
          // A round that has already returned has already been billed for —
          // there is no way to claw back tokens the API already generated.
          // What this check bounds is the *next* round: stopping here means
          // the overshoot is capped at one round's `max_tokens`
          // (`config.maxOutputTokens`), not zero. FR-M8's "fails cleanly with
          // partial results preserved" is satisfied because every `text`
          // event this run has yielded so far has already reached the
          // caller — stopping the generator here loses nothing already sent.
          yield {
            assignmentId: request.assignmentId,
            t: 'error',
            fatal: true,
            message:
              `stopping: estimated spend so far (${formatCostUsd(spentUsd)}) exceeds this assignment's cost ` +
              `cap of ${formatCostUsd(this.options.maxCostUsd)}. This estimate is checked between tool-use ` +
              `rounds, not mid-round, so the overshoot can be as large as one round's max_tokens ` +
              `(${String(config.maxOutputTokens)} tokens) rather than exactly zero.`,
          };
          return;
        }
      }

      if (outcome.pendingToolUses.length === 0) {
        // A text-only turn: the model is done. But "done" is not the same as
        // "produced text" — `message_start` → `message_delta` →
        // `message_stop` with no content blocks at all is a degenerate but
        // real reply, and nothing above guarantees it cannot happen. Left
        // unguarded, this turns into a confusing downstream failure rather
        // than the real one: for an ordinary assignment the dispatcher's own
        // empty-report check (FR-M6) would eventually catch it, but the
        // Manager's own planning and synthesis turns call this adapter
        // directly with no such check, so a silently empty run here would
        // surface there as a bare JSON-parse failure with no clue that the
        // model simply said nothing. Same guard as `openai/provider.ts`'s
        // `run`, for the same reason.
        if (!sawText) {
          yield { assignmentId: request.assignmentId, t: 'text', chunk: '' };
        }
        return;
      }

      // Echo the assistant's own turn back verbatim, then the tool results,
      // and loop. This round trip is Anthropic's documented multi-turn
      // tool-use protocol — see protocol.ts's module doc for the verified/
      // assumed split on that claim.
      messages.push({ role: 'assistant', content: outcome.assistantContent });

      const resultBlocks: RequestToolResultBlock[] = [];
      for (const use of outcome.pendingToolUses) {
        if (request.signal.aborted) return;
        // `execute` is documented to never throw — a failing tool comes back
        // as `{ isError: true, content: "..." }`, which is what the model
        // sees on the next turn, not a crashed run.
        const result = await tools.execute(use.name, use.input);
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: result.content,
          ...(result.isError ? { is_error: true as const } : {}),
        });
      }
      messages.push({ role: 'user', content: resultBlocks });
    }

    yield {
      assignmentId: request.assignmentId,
      t: 'error',
      fatal: true,
      message:
        `stopped after ${String(maxIterations)} tool-use round trips without the agent finishing; ` +
        'this bounds a model that never stops calling tools rather than letting it spend without limit ' +
        '(see MAX_TOOL_ITERATIONS).',
    };
  }

  /**
   * Consume one SSE stream from `/v1/messages`, yielding normalised events as
   * they arrive and returning what the turn produced once it ends.
   *
   * A generator rather than a function returning a promise of an array: text
   * must reach the caller as it streams in (NFR-3), not batched until the
   * turn completes — the whole point of `stream: true`.
   */
  private async *consumeTurn(
    response: Response,
    request: AgentRunRequest,
  ): AsyncGenerator<AgentEvent, TurnOutcome> {
    const blocks = new Map<number, BlockAcc>();
    const order: number[] = [];
    const pendingToolUses: PendingToolUse[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    // Components of `inputTokens`, kept so `pricing.ts` can charge a cache
    // read at its own rate instead of the fresh-input rate.
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let sawUsage = false;
    let sawMessageStop = false;
    let sawText = false;

    for await (const raw of readSse(response.body, request.signal)) {
      const event = this.parseStreamEvent(raw.data);
      if (event === undefined) continue; // diagnostic already recorded; degrade, don't fail (NFR-8).

      // `event` is typed as the full `AnthropicStreamEvent` union, and that
      // union's `type` field is not a pure literal discriminant — the
      // catch-all `UnknownStreamEventSchema` member types it as plain
      // `string` — so `event.type === '…'` below does not narrow `event`
      // itself. Re-validating against the specific schema per branch is the
      // cast-free way to recover a properly typed event; it is cheap and
      // cannot fail, since `event` already matched this same schema as a
      // member of `AnthropicStreamEventSchema`. Identical technique, and
      // identical reason, to `claude-code/parse.ts`'s `normaliseFrame`.

      if (event.type === 'message_start') {
        const parsed = MessageStartEventSchema.safeParse(event);
        const usage = parsed.success ? parsed.data.message?.usage : undefined;
        if (usage !== undefined) {
          inputTokens = totalInputTokens(usage);
          outputTokens = totalOutputTokens(usage);
          cacheReadTokens = usage.cache_read_input_tokens ?? 0;
          cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
          sawUsage = true;
        }
        continue;
      }

      if (event.type === 'content_block_start') {
        const parsed = ContentBlockStartEventSchema.safeParse(event);
        if (parsed.success) {
          order.push(parsed.data.index);
          blocks.set(parsed.data.index, this.startBlock(parsed.data.content_block));
        }
        continue;
      }

      if (event.type === 'content_block_delta') {
        const parsed = ContentBlockDeltaEventSchema.safeParse(event);
        if (!parsed.success) continue;
        const { index, delta } = parsed.data;

        const acc = blocks.get(index);
        if (acc === undefined) continue; // a delta for a block we never saw start; ignore rather than throw.

        // `delta` is `ContentBlockDeltaSchema`, itself a union with the same
        // permissive-catch-all shape as the outer event union — so it needs
        // the same specific-schema re-parse before `.text` / `.partial_json`
        // can be read as anything narrower than `unknown`.
        if (delta.type === 'text_delta' && acc.type === 'text') {
          const textDelta = TextDeltaSchema.safeParse(delta);
          if (textDelta.success) {
            acc.text += textDelta.data.text;
            sawText = true;
            yield { assignmentId: request.assignmentId, t: 'text', chunk: textDelta.data.text };
          }
        } else if (delta.type === 'input_json_delta' && acc.type === 'tool_use') {
          const jsonDelta = InputJsonDeltaSchema.safeParse(delta);
          if (jsonDelta.success) acc.partialJson += jsonDelta.data.partial_json;
        }
        // thinking_delta / signature_delta / an unrecognised delta type:
        // accumulated nowhere. Never surfaced — see protocol.ts's module doc.
        continue;
      }

      if (event.type === 'content_block_stop') {
        const parsed = ContentBlockStopEventSchema.safeParse(event);
        const acc = parsed.success ? blocks.get(parsed.data.index) : undefined;
        if (acc?.type === 'tool_use') {
          const input = this.parseToolInput(acc.partialJson);
          pendingToolUses.push({ id: acc.id, name: acc.name, input });
          yield {
            assignmentId: request.assignmentId,
            t: 'tool',
            name: acc.name,
            summary: summariseToolUse(acc.name, input),
          };
        }
        continue;
      }

      if (event.type === 'message_delta') {
        const parsed = MessageDeltaEventSchema.safeParse(event);
        const usage = parsed.success ? parsed.data.usage : undefined;
        if (usage !== undefined) {
          // `message_delta`'s usage carries the running output-token count;
          // it does not restate input tokens, so `inputTokens` from
          // `message_start` is left untouched.
          outputTokens = totalOutputTokens(usage);
          sawUsage = true;
        }
        continue;
      }

      if (event.type === 'message_stop') {
        sawMessageStop = true;
        break;
      }

      if (event.type === 'ping') continue;

      if (event.type === 'error') {
        const parsed = StreamErrorEventSchema.safeParse(event);
        const errorField = parsed.success ? parsed.data.error : undefined;
        const detail = errorField?.message ?? errorField?.type ?? 'no details in the error event';
        yield {
          assignmentId: request.assignmentId,
          t: 'error',
          fatal: true,
          message: `the Anthropic API reported an error mid-stream: ${detail}`,
        };
        return {
          fatal: true,
          assistantContent: [],
          pendingToolUses: [],
          sawMessageStop: false,
          sawText,
          usage: sawUsage ? { inputTokens, outputTokens } : undefined,
        };
      }

      // Reachable only for a future SSE event type this file has never heard
      // of — every literal member of AnthropicStreamEventSchema above is
      // handled, so falling through here means `event.type` matched only the
      // catch-all `UnknownStreamEventSchema` member.
      this.options.onDiagnostic?.(`unrecognised Anthropic SSE event type "${event.type}"`);
    }

    // FR-M9: an abort that resolved the SSE iterable cleanly (rather than
    // throwing — see the try/catch around this call in `run`) must produce
    // nothing further. No usage, no reconstructed content: the turn simply
    // did not finish, and it is not this method's place to report a partial
    // one as though it completed.
    if (request.signal.aborted) {
      return {
        fatal: false,
        assistantContent: [],
        pendingToolUses: [],
        sawMessageStop: false,
        sawText,
        usage: undefined,
      };
    }

    if (sawUsage) {
      yield {
        assignmentId: request.assignmentId,
        t: 'usage',
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      };
    }

    const assistantContent: RequestContentBlock[] = [];
    for (const index of order) {
      const acc = blocks.get(index);
      if (acc === undefined) continue;
      if (acc.type === 'text' && acc.text.length > 0) {
        assistantContent.push({ type: 'text', text: acc.text });
      } else if (acc.type === 'tool_use') {
        const use = pendingToolUses.find((candidate) => candidate.id === acc.id);
        assistantContent.push({ type: 'tool_use', id: acc.id, name: acc.name, input: use?.input ?? {} });
      }
      // 'other' (thinking, unknown): dropped from the echo — see protocol.ts.
    }

    return {
      fatal: false,
      assistantContent,
      pendingToolUses,
      sawMessageStop,
      sawText,
      usage: sawUsage ? { inputTokens, outputTokens } : undefined,
    };
  }

  /** Parse and validate one SSE frame's `data:` payload. `undefined` means "skip it", with a diagnostic already filed. */
  private parseStreamEvent(data: string): AnthropicStreamEvent | undefined {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch (err) {
      this.options.onDiagnostic?.(`unparseable Anthropic SSE frame (not JSON): ${describeError(err)}`);
      return undefined;
    }

    const parsed = AnthropicStreamEventSchema.safeParse(json);
    if (!parsed.success) {
      // Every schema member is `.passthrough()` with only `type` required, so
      // reaching here means the payload was not even an object carrying a
      // string `type` — genuinely malformed, not merely a newer shape.
      this.options.onDiagnostic?.(
        `Anthropic SSE frame did not match any known shape: ${parsed.error.issues[0]?.message ?? 'no details'}`,
      );
      return undefined;
    }
    return parsed.data;
  }

  /**
   * `block` is `ResponseContentBlock`, another union sharing the same
   * permissive-catch-all shape (`UnknownContentBlockSchema`'s `type: string`)
   * as the event union above — same reason, same fix: re-parse against the
   * specific schema before reading a field that only some members declare.
   */
  private startBlock(block: ResponseContentBlock | undefined): BlockAcc {
    if (block === undefined) return { type: 'other' };

    if (block.type === 'text') {
      const parsed = ResponseTextBlockSchema.safeParse(block);
      return { type: 'text', text: parsed.success ? (parsed.data.text ?? '') : '' };
    }

    if (block.type === 'tool_use') {
      const parsed = ResponseToolUseBlockSchema.safeParse(block);
      const id = parsed.success ? parsed.data.id : undefined;
      const name = parsed.success ? parsed.data.name : undefined;
      if (typeof id !== 'string' || typeof name !== 'string') {
        this.options.onDiagnostic?.('a tool_use content block started without an id or name; dropping it');
        return { type: 'other' };
      }
      return { type: 'tool_use', id, name, partialJson: '' };
    }

    return { type: 'other' };
  }

  private parseToolInput(partialJson: string): Record<string, unknown> {
    if (partialJson.trim().length === 0) return {};
    let value: unknown;
    try {
      value = JSON.parse(partialJson);
    } catch (err) {
      this.options.onDiagnostic?.(
        `could not parse a tool_use block's accumulated input JSON, treating input as empty: ${describeError(err)}`,
      );
      return {};
    }
    return isRecord(value) ? value : {};
  }

  private async describeHttpError(response: Response): Promise<string> {
    const status = response.status;
    const bodyText = await response.text().catch(() => '');
    const parsed = AnthropicErrorBodySchema.safeParse(safeJsonParse(bodyText));
    const apiMessage = parsed.success ? parsed.data.error?.message : undefined;
    // NEVER include the API key here: `bodyText` is the server's response,
    // which cannot echo a header we sent unless the server itself is
    // adversarial — but nothing in this function ever reads `config.apiKey`,
    // so there is no path by which it could leak into this string regardless.
    const detail = apiMessage ?? (bodyText.length > 0 ? truncate(bodyText, 500) : 'no response body');

    if (status === 401 || status === 403) {
      return (
        `Anthropic API authentication failed (HTTP ${String(status)}). ` +
        `Check that ${apiKeyVariable('anthropic')} holds a valid key. API said: ${detail}`
      );
    }
    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retrySuffix = retryAfter === null ? '' : ` Retry after ${retryAfter}s.`;
      return `Anthropic API rate limit exceeded (HTTP 429).${retrySuffix} API said: ${detail}`;
    }
    return `Anthropic API returned HTTP ${String(status)}: ${detail}`;
  }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

type ToolSchema = ReturnType<SandboxedTools['schemas']>[number];

function toAnthropicToolDef(schema: ToolSchema): AnthropicToolDefinition {
  // apiTools.ts's `ToolSchema.description` is a required string (unlike the
  // Anthropic wire format's optional one), so there is no "omit when absent"
  // case to handle here — every tool this adapter can offer has one.
  return { name: schema.name, description: schema.description, input_schema: schema.inputSchema };
}

/** Priority order for picking the one input field that makes a tool summary readable. */
const SUMMARY_FIELDS = ['file_path', 'path', 'pattern', 'command', 'url', 'query'] as const;
const MAX_SUMMARY_VALUE_LENGTH = 80;

/**
 * Build a short, human-readable line for the inspect panel, e.g.
 * `Read src/auth/session.ts`. Mirrors `claude-code/parse.ts`'s
 * `summariseToolUse` — same idea, same reason: never dump the whole `input`
 * object, which can carry a Write's full file contents.
 */
function summariseToolUse(name: string, input: Record<string, unknown>): string {
  for (const field of SUMMARY_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) {
      return `${name} ${truncate(value, MAX_SUMMARY_VALUE_LENGTH)}`;
    }
  }
  return name;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJsonParse(text: string): unknown {
  try {
    return text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
