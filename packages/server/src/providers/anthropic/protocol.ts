import { z } from 'zod';

/**
 * The Anthropic Messages API wire format (Phase 7), `POST /v1/messages` with
 * `stream: true`.
 *
 * ## What is verified, and what is not — read this before trusting any shape below
 *
 * **No API key was available on this machine when this file was written, and
 * no request has ever reached `api.anthropic.com` from this codebase.** Every
 * shape here is therefore DERIVED — from the publicly published Anthropic API
 * reference and from this model's own training knowledge of the Messages API
 * — not CAPTURED, the way `claude-code/protocol.ts` captured real bytes from
 * an installed binary. That distinction matters enough to restate per section:
 *
 * - The SSE event sequence (`message_start` → `content_block_start` →
 *   `content_block_delta`* → `content_block_stop` → … → `message_delta` →
 *   `message_stop`) and each event's field names: well-documented publicly,
 *   stable for a long time, high confidence — but still unverified against a
 *   live response by this project.
 * - `anthropic-version: 2023-06-01` and the `x-api-key` header name: the
 *   documented values, unverified here.
 * - The non-streaming error body shape (`{"type":"error","error":{"type",
 *   "message"}}`) and which HTTP status maps to which `error.type`: documented,
 *   unverified here.
 * - Extended-thinking block shapes (`thinking`, `redacted_thinking`,
 *   `signature_delta`): included for forward-compatibility only. This adapter
 *   never requests a thinking budget, so it does not expect to see them, and
 *   does not attempt to echo them back on the next turn — see provider.ts.
 *
 * Every schema below is `.passthrough()` with only the discriminant field
 * required, exactly as `claude-code/protocol.ts` does, and for the same
 * reason: an unknown field from a newer API version — or from a guess in this
 * file that turns out to be subtly wrong once a real key is available — must
 * degrade to "ignored", never to a failed run. Whoever adds the first real
 * key to this project should point it at `fakeServer.ts`'s script format
 * first, diff a real capture against these schemas, and correct anything
 * this comment got wrong.
 */

// ---------------------------------------------------------------------------
// Content blocks — the response side (what the model sends us)
// ---------------------------------------------------------------------------

export const ResponseTextBlockSchema = z
  .object({ type: z.literal('text'), text: z.string().optional() })
  .passthrough();

export const ResponseToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string().optional(),
    /** Present at `content_block_start`, typically `{}`; the real argument
     *  arrives incrementally via `input_json_delta` and is reassembled by the
     *  caller — see provider.ts's block accumulator. */
    input: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** Extended-thinking blocks. Never requested by this adapter — see module doc. */
export const ResponseThinkingBlockSchema = z
  .object({ type: z.literal('thinking'), thinking: z.string().optional(), signature: z.string().optional() })
  .passthrough();

export const ResponseRedactedThinkingBlockSchema = z
  .object({ type: z.literal('redacted_thinking'), data: z.string().optional() })
  .passthrough();

/** Anything this file has never heard of lands here rather than failing the parse. */
export const UnknownContentBlockSchema = z.object({ type: z.string() }).passthrough();

export const ResponseContentBlockSchema = z.union([
  ResponseTextBlockSchema,
  ResponseToolUseBlockSchema,
  ResponseThinkingBlockSchema,
  ResponseRedactedThinkingBlockSchema,
  UnknownContentBlockSchema,
]);

export type ResponseContentBlock = z.infer<typeof ResponseContentBlockSchema>;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Token usage as the API reports it. Same four-counter shape as
 * `claude-code/protocol.ts`'s `UsageSchema` — Claude Code's stream-json usage
 * object is itself just this API's usage object, passed through — so the
 * same folding logic applies: `input_tokens` alone understates a cached run,
 * and `totalInputTokens` below folds the cache counters in (NFR-5).
 */
export const UsageSchema = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    cache_creation_input_tokens: z.number().nonnegative().optional(),
    cache_read_input_tokens: z.number().nonnegative().optional(),
  })
  .passthrough();

export type RawUsage = z.infer<typeof UsageSchema>;

export function totalInputTokens(usage: RawUsage | undefined): number {
  if (usage === undefined) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export function totalOutputTokens(usage: RawUsage | undefined): number {
  return usage?.output_tokens ?? 0;
}

// ---------------------------------------------------------------------------
// SSE event envelope — the streaming side
// ---------------------------------------------------------------------------

export const MessageStartEventSchema = z
  .object({
    type: z.literal('message_start'),
    message: z
      .object({
        id: z.string().optional(),
        role: z.string().optional(),
        model: z.string().optional(),
        content: z.array(ResponseContentBlockSchema).optional(),
        stop_reason: z.string().nullable().optional(),
        usage: UsageSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ContentBlockStartEventSchema = z
  .object({
    type: z.literal('content_block_start'),
    index: z.number().int().nonnegative(),
    content_block: ResponseContentBlockSchema.optional(),
  })
  .passthrough();

export const TextDeltaSchema = z.object({ type: z.literal('text_delta'), text: z.string() }).passthrough();
export const InputJsonDeltaSchema = z
  .object({ type: z.literal('input_json_delta'), partial_json: z.string() })
  .passthrough();
export const ThinkingDeltaSchema = z
  .object({ type: z.literal('thinking_delta'), thinking: z.string() })
  .passthrough();
export const SignatureDeltaSchema = z
  .object({ type: z.literal('signature_delta'), signature: z.string() })
  .passthrough();
export const UnknownDeltaSchema = z.object({ type: z.string() }).passthrough();

export const ContentBlockDeltaSchema = z.union([
  TextDeltaSchema,
  InputJsonDeltaSchema,
  ThinkingDeltaSchema,
  SignatureDeltaSchema,
  UnknownDeltaSchema,
]);

export const ContentBlockDeltaEventSchema = z
  .object({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: ContentBlockDeltaSchema,
  })
  .passthrough();

export const ContentBlockStopEventSchema = z
  .object({ type: z.literal('content_block_stop'), index: z.number().int().nonnegative() })
  .passthrough();

export const MessageDeltaEventSchema = z
  .object({
    type: z.literal('message_delta'),
    delta: z
      .object({ stop_reason: z.string().nullable().optional(), stop_sequence: z.string().nullable().optional() })
      .passthrough()
      .optional(),
    usage: UsageSchema.optional(),
  })
  .passthrough();

export const MessageStopEventSchema = z.object({ type: z.literal('message_stop') }).passthrough();

export const PingEventSchema = z.object({ type: z.literal('ping') }).passthrough();

/**
 * A mid-stream error. Documented as occurring even after a 200 response has
 * started streaming — an `overloaded_error` arriving partway through is the
 * canonical example — which is exactly why this is a distinct SSE event
 * rather than only an HTTP-status concern.
 */
export const StreamErrorEventSchema = z
  .object({
    type: z.literal('error'),
    error: z.object({ type: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const UnknownStreamEventSchema = z.object({ type: z.string() }).passthrough();

export const AnthropicStreamEventSchema = z.union([
  MessageStartEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockDeltaEventSchema,
  ContentBlockStopEventSchema,
  MessageDeltaEventSchema,
  MessageStopEventSchema,
  PingEventSchema,
  StreamErrorEventSchema,
  UnknownStreamEventSchema,
]);

export type AnthropicStreamEvent = z.infer<typeof AnthropicStreamEventSchema>;

// ---------------------------------------------------------------------------
// Non-streaming error body (401 / 403 / 429 / 4xx / 5xx responses)
// ---------------------------------------------------------------------------

export const AnthropicErrorBodySchema = z
  .object({
    type: z.literal('error').optional(),
    error: z
      .object({ type: z.string().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AnthropicErrorBody = z.infer<typeof AnthropicErrorBodySchema>;

// ---------------------------------------------------------------------------
// Request-side shapes — these are ours to construct, not to parse, so they
// are plain TS types rather than zod schemas (nothing untrusted flows through
// them; zod's value is validating what arrives, not what we send).
// ---------------------------------------------------------------------------

export interface RequestToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  /** Omitted rather than `false` when the tool succeeded — see provider.ts's
   *  `exactOptionalPropertyTypes`-friendly spread convention. */
  is_error?: boolean;
}

export interface RequestToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RequestTextBlock {
  type: 'text';
  text: string;
}

export type RequestContentBlock = RequestTextBlock | RequestToolUseBlock | RequestToolResultBlock;

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | RequestContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface AnthropicMessagesRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: AnthropicMessageParam[];
  stream: true;
  tools?: AnthropicToolDefinition[];
}

/** The `anthropic-version` value this file was written against. See module doc. */
export const ASSUMED_ANTHROPIC_VERSION = '2023-06-01';
