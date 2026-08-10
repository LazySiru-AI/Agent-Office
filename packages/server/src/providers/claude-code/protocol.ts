import { z } from 'zod';

/**
 * The Claude Code CLI's `--output-format stream-json` wire format.
 *
 * PLAN.md §3 (Phase 1) is explicit that this must be captured from the installed
 * binary rather than assumed, because the flag names and event shapes are the
 * plan's largest unknown. This file is that capture, written against
 * **Claude Code 2.1.222** on Windows. `fixtures/` holds the raw bytes it was
 * derived from.
 *
 * ## What is verified, and what is not
 *
 * Directly observed from the installed CLI (see `fixtures/auth-failure.jsonl`,
 * captured verbatim from a real invocation):
 *
 * - the `system`/`init` frame and its field names
 * - the `assistant` frame wrapper, including `message.usage` and the
 *   `error` / `is_api_error_message` fields that only appear on failures
 * - the `result` frame, including `total_cost_usd`, `modelUsage`,
 *   `permission_denials` and `terminal_reason`
 * - `--verbose` is **mandatory** alongside `--print --output-format stream-json`;
 *   without it the CLI exits 1 with a usage error and emits no JSON at all
 * - process exit code is 1 when the run fails
 *
 * Derived structurally, NOT observed on this wire format: the `text`,
 * `thinking`, `tool_use` and `tool_result` content blocks. These are ordinary
 * Anthropic API content blocks and their shapes were confirmed from Claude Code
 * session transcripts on this machine. The transcript envelope is *not* the same
 * as this one — transcripts use camelCase (`sessionId`, `parentUuid`) where
 * stream-json uses snake_case (`session_id`, `parent_tool_use_id`) — so only the
 * inner blocks carry over. Producing a live capture of a successful tool-using
 * session requires an authenticated CLI; see SETUP.md.
 *
 * ## Why these schemas are permissive
 *
 * Every frame schema uses `.passthrough()` and marks all but the discriminant
 * optional. A strict schema here would turn every future CLI release into an
 * outage: Claude Code adds fields to these frames routinely, and an unknown
 * field must never fail a run that is otherwise streaming fine. The parser's job
 * is to recognise what it knows and ignore the rest — forward compatibility is a
 * correctness requirement, not a nicety.
 */

/** Anthropic content blocks, as they appear inside `message.content[]`. */

export const TextBlockSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .passthrough();

export const ThinkingBlockSchema = z
  .object({ type: z.literal('thinking'), thinking: z.string() })
  .passthrough();

export const ToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string(),
    /** Tool arguments. Shape varies per tool, so it stays unknown by design. */
    input: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const ToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().optional(),
    /** String for most tools; an array of blocks for image-returning ones. */
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

/** Anything the CLI adds later lands here rather than failing the parse. */
export const UnknownBlockSchema = z.object({ type: z.string() }).passthrough();

export const ContentBlockSchema = z.union([
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  UnknownBlockSchema,
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * Token usage as the CLI reports it.
 *
 * Note the four separate counters. `input_tokens` excludes cache traffic, so
 * summing only `input_tokens` understates a cached run substantially — the
 * adapter folds the cache counters in deliberately (NFR-5).
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

/** `system` / `subtype: "init"` — always the first frame of a session. */
export const InitFrameSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    /** The tools actually available to the session, after all filtering. */
    tools: z.array(z.string()).optional(),
    permissionMode: z.string().optional(),
    apiKeySource: z.string().optional(),
    claude_code_version: z.string().optional(),
  })
  .passthrough();

/** Any other `system` frame. Recognised so it is skipped, not mis-parsed. */
export const SystemFrameSchema = z
  .object({ type: z.literal('system'), subtype: z.string().optional() })
  .passthrough();

export const AssistantFrameSchema = z
  .object({
    type: z.literal('assistant'),
    message: z
      .object({
        role: z.string().optional(),
        model: z.string().optional(),
        content: z.array(ContentBlockSchema).optional(),
        usage: UsageSchema.optional(),
        stop_reason: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    /** Set when the frame comes from a nested subagent rather than the main turn. */
    parent_tool_use_id: z.string().nullable().optional(),
    session_id: z.string().optional(),
    /**
     * Present only on failures. Observed carrying `"authentication_failed"`
     * while `message.model` was `"<synthetic>"` — the CLI fabricates an
     * assistant turn to deliver the error, so an adapter that trusts
     * `type: "assistant"` alone will report an error string as the agent's work.
     */
    error: z.string().optional(),
    is_api_error_message: z.boolean().optional(),
  })
  .passthrough();

/** `user` frames carry tool results back. Named for symmetry with the API. */
export const UserFrameSchema = z
  .object({
    type: z.literal('user'),
    message: z
      .object({ content: z.array(ContentBlockSchema).optional() })
      .passthrough()
      .optional(),
    parent_tool_use_id: z.string().nullable().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

/**
 * The terminal frame.
 *
 * `is_error` is the authority on whether the run succeeded — **not** `subtype`.
 * A real capture of a failed run carries `{"is_error": true, "subtype":
 * "success"}` simultaneously, because `subtype` describes how the CLI
 * terminated rather than whether the work succeeded. Keying success off
 * `subtype` is the single easiest way to get this adapter wrong.
 */
export const ResultFrameSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    usage: UsageSchema.optional(),
    total_cost_usd: z.number().optional(),
    num_turns: z.number().optional(),
    duration_ms: z.number().optional(),
    session_id: z.string().optional(),
    terminal_reason: z.string().optional(),
    permission_denials: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Emitted only with `--include-partial-messages`. The adapter does not pass that
 * flag, so this exists to be recognised and skipped if a future default turns it
 * on — an unrecognised frame carrying partial text would otherwise be a
 * candidate for double-counting against the complete `assistant` frame.
 */
export const StreamEventFrameSchema = z
  .object({ type: z.literal('stream_event') })
  .passthrough();

export const StreamJsonFrameSchema = z.union([
  InitFrameSchema,
  AssistantFrameSchema,
  UserFrameSchema,
  ResultFrameSchema,
  StreamEventFrameSchema,
  SystemFrameSchema,
  z.object({ type: z.string() }).passthrough(),
]);

export type StreamJsonFrame = z.infer<typeof StreamJsonFrameSchema>;
export type InitFrame = z.infer<typeof InitFrameSchema>;
export type AssistantFrame = z.infer<typeof AssistantFrameSchema>;
export type ResultFrame = z.infer<typeof ResultFrameSchema>;

/**
 * Total billable input, folding in cache traffic.
 *
 * Cache reads are cheaper than fresh input rather than free, and cache *writes*
 * cost more than fresh input. Neither is priced correctly by a flat sum, but
 * dropping them entirely is worse: a run that reads 40k cached tokens and 200
 * fresh ones would display as 200. NFR-5 asks for visibility, and an
 * approximation that is visible beats an exact number that omits most of the
 * traffic. Recorded here rather than hidden in the parser so the trade is
 * findable when per-counter pricing arrives.
 */
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

/** The CLI version this protocol was captured from. */
export const CAPTURED_FROM_VERSION = '2.1.222';
