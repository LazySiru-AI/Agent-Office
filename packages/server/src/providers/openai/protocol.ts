import { z } from 'zod';

/**
 * The OpenAI Chat Completions wire format (Phase 7) — shared verbatim by the
 * OpenAI and DeepSeek adapters, because DeepSeek's API is documented as
 * wire-compatible with this one. One schema file, not two, for the same
 * reason `provider.ts` is one class: two near-identical copies drift the
 * first time either is patched.
 *
 * Nothing in this file has been checked against a live endpoint — see the top
 * comment in `provider.ts` for the full verified/assumed split. These schemas
 * encode the *published* shape of the format, not an observed one.
 */

// ---------------------------------------------------------------------------
// Outgoing (request) shapes.
//
// These are produced by this adapter, never parsed from the wire, so they are
// plain TypeScript types rather than zod schemas. Zod schemas exist to
// validate *untrusted* input; a request body this process built itself is not
// that, and running it through `.parse()` would only be able to catch a bug
// that a type error would already have caught.
// ---------------------------------------------------------------------------

export interface ChatToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema, passed through verbatim from `apiTools.ts`'s `schemas()`. */
    parameters: unknown;
  };
}

export interface ChatRequestToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * `null` is only meaningful on an assistant message that carries
   * `tool_calls` and produced no prose alongside them — the documented shape
   * for that case is `content: null`, not an absent field.
   */
  content: string | null;
  /** Only ever set on an assistant message that is calling tools. */
  tool_calls?: ChatRequestToolCall[];
  /** Only ever set on a tool-result message, echoing the call it answers. */
  tool_call_id?: string;
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: true;
  /**
   * Requests the trailing usage chunk — see `provider.ts` on why this is sent
   * unconditionally and what happens if a provider ignores it (NFR-5).
   */
  stream_options: { include_usage: true };
  tools?: ChatToolSpec[];
  /**
   * ASSUMED, NOT VERIFIED: `max_tokens` is the classic Chat Completions field
   * and is what this adapter sends. Some newer OpenAI models instead expect
   * `max_completion_tokens` and may reject or silently ignore `max_tokens`.
   * Flagged here rather than silently picked because it is exactly the kind
   * of thing that should be the first thing checked when a real call fails.
   */
  max_tokens?: number;
}

// ---------------------------------------------------------------------------
// Incoming (response) shapes — untrusted, parsed with zod. `.passthrough()`
// throughout: an unknown field from a newer API version must degrade to
// "ignored", never "the run breaks on the next model release".
// ---------------------------------------------------------------------------

/**
 * One fragment of one streamed tool call.
 *
 * `index` is the only field this adapter trusts to be stable and complete on
 * every fragment — it is the reassembly key. `id`, `function.name` and
 * `function.arguments` are all treated as *partial*, to be concatenated
 * across every fragment sharing an `index`, never read once and assumed
 * whole. That is the single hardest part of this adapter (see `provider.ts`)
 * and the reason none of these three are typed as "arrives complete".
 */
const ToolCallDeltaSchema = z
  .object({
    index: z.number().int().nonnegative(),
    id: z.string().optional(),
    type: z.string().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ChunkDeltaSchema = z
  .object({
    role: z.string().optional(),
    content: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallDeltaSchema).optional(),
  })
  .passthrough();

const ChunkChoiceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    delta: ChunkDeltaSchema,
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const UsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const ChatCompletionChunkSchema = z
  .object({
    id: z.string().optional(),
    object: z.string().optional(),
    // Documented as always present, but not load-bearing enough to require:
    // an empty array is exactly what the trailing usage-only chunk sends.
    choices: z.array(ChunkChoiceSchema).default([]),
    /**
     * Only present on the trailing chunk of a response, and only when this
     * adapter's `stream_options.include_usage: true` was honoured — see
     * `provider.ts`. `null` as well as absent, because some gateways send an
     * explicit null on every non-trailing chunk rather than omitting the key.
     */
    usage: UsageSchema.nullable().optional(),
  })
  .passthrough();

export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;

/** The documented Chat Completions error envelope, returned on non-2xx. */
export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        message: z.string(),
        type: z.string().optional(),
        param: z.string().nullable().optional(),
        code: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
