import type { AgentEvent } from '@agent-office/shared';
import {
  AssistantFrameSchema,
  ResultFrameSchema,
  StreamJsonFrameSchema,
  totalInputTokens,
  totalOutputTokens,
  type AssistantFrame,
  type ContentBlock,
  type ResultFrame,
  type StreamJsonFrame,
} from './protocol.js';

/**
 * The Claude Code CLI adapter's stream parser (PLAN.md §3, Phase 1).
 *
 * Two concerns live here, deliberately kept separable rather than fused into
 * one "read the process" function, because the adapter owns process
 * lifecycle (spawn, signal, exit code) and only needs to hand this module
 * bytes on one side and receive {@link AgentEvent}s on the other:
 *
 * 1. {@link LineSplitter} / {@link splitLines} — turn a chunked text stream
 *    (stdout does not respect JSON object boundaries) into whole NDJSON
 *    lines (NFR-3 streaming: events must be usable as they arrive, not only
 *    once the process exits).
 * 2. {@link parseFrame} / {@link normaliseFrame} — turn one NDJSON line into
 *    zero or more {@link AgentEvent}s, per protocol.ts's documented frame
 *    shapes.
 *
 * Every function here is pure and synchronous. Nothing throws for malformed
 * input — a bad line degrades to zero events plus a reason the caller can
 * log, never a crashed run (NFR-8). The one exception is genuinely
 * programmer-facing misuse (e.g. constructing a splitter with a negative
 * cap), which is not expected to occur with real CLI output.
 */

// ---------------------------------------------------------------------------
// 1. Line splitting
// ---------------------------------------------------------------------------

/**
 * Upper bound on a single buffered (newline-less) line, in UTF-16 code units.
 *
 * Measuring code units rather than bytes is an approximation — a line that is
 * mostly multi-byte UTF-8 would hit this cap at a smaller true byte count —
 * but stream-json content is overwhelmingly ASCII JSON syntax and English
 * tool output, so the approximation errs conservative rather than permissive.
 *
 * 10 MiB is chosen against the largest legitimate frame this protocol
 * produces: a `tool_result` or `tool_use` block embedding a whole file's
 * contents, which in practice tops out in the hundreds of KB. 10 MiB leaves
 * two orders of magnitude of headroom above that so no real frame is ever
 * clipped, while still bounding the damage a stuck or adversarial process
 * (a CLI bug that never emits a newline) can do to this process's memory to
 * a fixed, small multiple of one line rather than an unbounded accumulation.
 */
export const MAX_LINE_LENGTH = 10 * 1024 * 1024;

export type SplitEvent =
  | { readonly kind: 'line'; readonly text: string; readonly trailing: boolean }
  | { readonly kind: 'overflow'; readonly discardedChars: number };

export interface LineSplitterOptions {
  /** Overridable for tests; production code should use the {@link MAX_LINE_LENGTH} default. */
  maxLineLength?: number;
}

/**
 * Incremental NDJSON line splitter.
 *
 * Stateful by design: `push` is called once per chunk as it arrives off the
 * process's stdout, and must remember a chunk's unterminated tail across
 * calls, because chunk boundaries have no relationship to line boundaries —
 * a chunk can end mid-object, or contain several lines, or both. `finish()`
 * flushes whatever is left when the stream ends.
 */
export class LineSplitter {
  private readonly maxLineLength: number;
  private buffer = '';
  /** True while discarding the remainder of a line that has already overflowed. */
  private overflowing = false;

  constructor(options: LineSplitterOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH;
  }

  /** Feed one chunk of decoded text. Returns every line (and overflow) it completed. */
  push(chunk: string): SplitEvent[] {
    const events: SplitEvent[] = [];
    let rest = chunk;

    while (rest.length > 0) {
      if (this.overflowing) {
        const newlineIndex = rest.indexOf('\n');
        if (newlineIndex === -1) {
          // Still inside the runaway line; nothing more to do with this chunk.
          rest = '';
          break;
        }
        // Found the end of the runaway line. Resume normal splitting after it.
        this.overflowing = false;
        rest = rest.slice(newlineIndex + 1);
        continue;
      }

      const newlineIndex = rest.indexOf('\n');
      if (newlineIndex === -1) {
        this.buffer += rest;
        rest = '';
        if (this.buffer.length > this.maxLineLength) {
          events.push({ kind: 'overflow', discardedChars: this.buffer.length });
          this.overflowing = true;
          this.buffer = '';
        }
        break;
      }

      const line = stripTrailingCR(this.buffer + rest.slice(0, newlineIndex));
      this.buffer = '';
      rest = rest.slice(newlineIndex + 1);

      if (line.length > this.maxLineLength) {
        events.push({ kind: 'overflow', discardedChars: line.length });
      } else {
        events.push({ kind: 'line', text: line, trailing: false });
      }
    }

    return events;
  }

  /**
   * Call once, after the underlying stream has ended. Flushes a trailing
   * fragment — a line the process wrote without a final newline (e.g. it was
   * killed mid-write for a timeout or crash) — tagged `trailing: true` so the
   * caller can tell it apart from an ordinary complete line. Per the brief,
   * nothing is emitted for an empty tail, and nothing is emitted for a tail
   * that was already discarded as part of an overflow.
   */
  finish(): SplitEvent[] {
    this.overflowing = false;
    const remainder = stripTrailingCR(this.buffer);
    this.buffer = '';
    if (remainder.length === 0) return [];
    return [{ kind: 'line', text: remainder, trailing: true }];
  }
}

function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Convenience wrapper around {@link LineSplitter} for driving it off a real
 * (or fixture) stream. Accepts sync or async iterables of already-decoded
 * text so callers choose how to decode: a `child_process` adapter should
 * call `stdout.setEncoding('utf8')` before iterating it, so that multi-byte
 * UTF-8 sequences straddling a chunk boundary are reassembled by Node's
 * stream decoder before reaching this module — redoing that decoding here
 * from raw bytes would just relocate the same boundary bug one layer down.
 */
export async function* splitLines(
  chunks: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<SplitEvent> {
  const splitter = new LineSplitter();
  for await (const chunk of chunks) {
    yield* splitter.push(chunk);
  }
  yield* splitter.finish();
}

// ---------------------------------------------------------------------------
// 2. Frame parsing
// ---------------------------------------------------------------------------

export type FrameParseResult =
  | { readonly kind: 'frame'; readonly frame: StreamJsonFrame }
  | { readonly kind: 'ignorable'; readonly reason: string }
  | { readonly kind: 'parse-error'; readonly message: string };

/**
 * Parse one NDJSON line into a {@link StreamJsonFrame}, or explain why it
 * could not be one. Never throws: `malformed.jsonl` exists precisely to
 * exercise garbage lines, truncated JSON and blank lines, and a parser that
 * threw on any of those would take the whole event stream down with it
 * (NFR-8).
 */
export function parseFrame(line: string): FrameParseResult {
  if (line.trim().length === 0) {
    return { kind: 'ignorable', reason: 'blank line' };
  }

  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (err) {
    return { kind: 'parse-error', message: `invalid JSON: ${describeError(err)}` };
  }

  const result = StreamJsonFrameSchema.safeParse(json);
  if (!result.success) {
    // protocol.ts's schemas are all `.passthrough()` with only the
    // discriminant required, so reaching here means the line was valid JSON
    // that was not even an object with a `type` string — e.g. a bare array
    // or number. Genuinely unrecognised *frame types* (a `type` this parser
    // has never heard of) still succeed here via the catch-all member; see
    // `normaliseFrame`'s `recognised` flag for that case instead.
    return {
      kind: 'parse-error',
      message: `line is not a recognisable stream-json frame: ${result.error.issues[0]?.message ?? 'no details'}`,
    };
  }

  return { kind: 'frame', frame: result.data };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 3. Frame → AgentEvent normalisation
// ---------------------------------------------------------------------------

export interface NormaliseResult {
  readonly events: AgentEvent[];
  /**
   * False when `frame.type` was none of `system`, `assistant`, `user`,
   * `result` or `stream_event` — i.e. it only parsed at all because of
   * protocol.ts's catch-all union member. `events` is always `[]` in that
   * case, but an empty-events *recognised* frame (a plain `system` frame,
   * say) is a normal no-op, whereas an empty-events *unrecognised* frame is
   * something the caller should count or log, per the brief, so future CLI
   * releases that add frame types are visible rather than silently dropped.
   */
  readonly recognised: boolean;
}

const KNOWN_FRAME_TYPES = new Set([
  'system',
  'assistant',
  'user',
  'result',
  'stream_event',
  // Emitted immediately after `system/init` on a real authenticated run,
  // reporting the account's rate-limit window. Observed on 2.1.222 once the
  // CLI was signed in — the unauthenticated capture never produced one, which
  // is why it was absent from the fixtures and reported as unrecognised the
  // first time the exit criterion ran for real. Carries no agent activity, so
  // it is ignored like `system`; it is listed here so it stops being counted
  // as a protocol surprise.
  'rate_limit_event',
]);

/** Turn one parsed frame into zero or more normalised events. */
export function normaliseFrame(frame: StreamJsonFrame, assignmentId: string): NormaliseResult {
  if (!KNOWN_FRAME_TYPES.has(frame.type)) {
    return { events: [], recognised: false };
  }

  if (frame.type === 'assistant') {
    // `frame` is typed as the full StreamJsonFrame union, and that union's
    // `type` field is not purely a literal discriminant (the catch-all
    // member types it as plain `string`), so the `frame.type === 'assistant'`
    // check above does not narrow `frame` itself. Re-validating against the
    // specific schema is the cast-free way to recover a properly typed
    // AssistantFrame; it is cheap and cannot fail, since `frame` already
    // matched this same schema as a member of StreamJsonFrameSchema.
    const parsed = AssistantFrameSchema.safeParse(frame);
    return { events: parsed.success ? eventsForAssistant(parsed.data, assignmentId) : [], recognised: true };
  }

  if (frame.type === 'result') {
    const parsed = ResultFrameSchema.safeParse(frame);
    return { events: parsed.success ? eventsForResult(parsed.data, assignmentId) : [], recognised: true };
  }

  // `system`, `user`, `stream_event` and `rate_limit_event` are all
  // recognised, zero-event frames:
  //
  // - `system`: session metadata (init, or otherwise) — nothing an operator
  //   needs surfaced as agent activity. A real run also emits
  //   `system/thinking_tokens` throughout and one `system/post_turn_summary`
  //   at the end; both fall here.
  // - `rate_limit_event`: account rate-limit window, not agent activity.
  // - `stream_event`: only ever emitted with `--include-partial-messages`,
  //   which this adapter does not pass; recognised so a future default
  //   flipping that on degrades to "ignored" rather than "miscounted as
  //   unrecognised" (see protocol.ts's comment on StreamEventFrameSchema).
  // - `user`: carries `tool_result` blocks back from the CLI's own tool
  //   execution. Deliberately not surfaced as `text` — tool output is often
  //   large (full file contents, command stdout) and would flood the
  //   transcript with content the *tool* produced, not the agent, which is
  //   exactly the "whose words are these" ambiguity the synthetic-error-frame
  //   guard below exists to avoid for assistant frames. The preceding
  //   `tool_use` event's summary is the intended signal for the inspect
  //   panel; the raw result is available in the replay log if ever needed.
  return { events: [], recognised: true };
}

function eventsForAssistant(frame: AssistantFrame, assignmentId: string): AgentEvent[] {
  const events: AgentEvent[] = [];

  const errorMessage = assistantErrorMessage(frame);
  if (errorMessage !== undefined) {
    // CRITICAL (see protocol.ts's comment on AssistantFrameSchema.error):
    // the CLI delivers failures as a fabricated assistant turn, model
    // `"<synthetic>"`, carrying the human-readable message as an ordinary
    // `text` block. Content blocks are deliberately NOT processed in this
    // branch — surfacing that block as a normal `text` event would write
    // "Not logged in · Please run /login" into the report as if the agent
    // itself had said it.
    events.push({ t: 'error', assignmentId, message: errorMessage, fatal: true });
  } else {
    events.push(...eventsForContent(frame.message?.content, assignmentId));
  }

  // NO usage event here. `message.usage` on an assistant frame is not a
  // per-turn increment, which is what this used to assume, and both consumers
  // (`dispatcher.ts` and `runner.ts`) *sum* usage events.
  //
  // Measured against the first real authenticated capture (2.1.222, three
  // turns, `result` reporting in=26 out=579 cr=44878 cw=22731):
  //
  //   - The CLI emits one assistant frame per *content block*, so a turn with
  //     a `thinking` block and a `tool_use` block produces two frames carrying
  //     the identical `message.usage`. Summing them double-counted input to
  //     exactly 2x the truth — 135,270 against 67,635.
  //   - `output_tokens` on those frames reads 3, 3, 1, 1, 1, 1. It is not the
  //     turn's output at all. Summed, it gave 10 against a true 579 — 1.7%.
  //
  // Wrong in both directions at once, and the token budget in
  // `dispatcher.ts` halts on that sum, so it would trip early on input and
  // never on output. The `result` frame is the CLI's own final accounting and
  // is the only trustworthy source; `eventsForResult` emits it.
  //
  // The cost is that usage now arrives once, at the end of an assignment,
  // rather than ticking up during it. The in-run spend guard does not rest on
  // this: `provider.ts` passes `--max-budget-usd`, so the CLI enforces the cap
  // on its own side while a turn is in flight, and the dispatcher's budget
  // still halts *subsequent* assignments on accurate totals.

  return events;
}

/**
 * Present only on the CLI's synthetic error turn. Prefers the human-readable
 * text block (what a user would actually see) over the `error` code field
 * (e.g. `"authentication_failed"`), falling back to the code, then to a
 * generic message, so this never returns `undefined` once it has decided the
 * frame is an error.
 */
/**
 * An expired sign-in, recognised from the CLI's own wording.
 *
 * The preflight cannot catch this. `claude auth status` on a session whose token
 * has expired still reports `loggedIn: true` — captured from the real CLI
 * (2.1.229), whose output carries `loggedIn`, `authMethod`, `apiProvider`,
 * `email`, `orgId`, `orgName` and `subscriptionType`, and **no expiry field of
 * any kind**. There is nothing for `checkClaudeCodeAvailability` to test, so a
 * run starts, spawns a child, and dies at the first model call with a 401.
 *
 * That happened. What reached the user was `Manager turn "manager-plan" failed
 * in the provider: Failed to authenticate. API Error: 401 OAuth access token has
 * expired. Re-authenticate to continue.` — accurate, and it never names the
 * command. Recognising the shape here lets the one thing the user has to do
 * travel with the failure into `run.json`, the diagnostics log and the UI alike,
 * rather than being something they must already know.
 *
 * Two independent phrases must match, not one, because this is a heuristic over
 * a vendor's human-readable string. The cost of a miss is only the sentence not
 * being appended; the cost of a false positive is telling someone to
 * re-authenticate when that is not their problem.
 */
function isExpiredSignIn(message: string): boolean {
  return /token has expired|re-?authenticate/i.test(message) && /401|authenticat/i.test(message);
}

/** Appended to an expiry failure. The remedy, not a diagnosis. */
export const SIGN_IN_EXPIRED_HINT =
  'The Claude Code CLI sign-in has expired — run `claude auth login`, then start the run again. ' +
  'Note that `claude auth status` reports `loggedIn: true` for an expired session, ' +
  'so this cannot be detected before the run starts.';

function assistantErrorMessage(frame: AssistantFrame): string | undefined {
  const isError = frame.error !== undefined || frame.is_api_error_message === true;
  if (!isError) return undefined;

  const texts = (frame.message?.content ?? [])
    .map((block) => (typeof block.text === 'string' ? block.text : undefined))
    .filter((text): text is string => text !== undefined);

  const message =
    texts.length > 0
      ? texts.join('\n')
      : (frame.error ?? 'the Claude Code CLI reported an error with no message');

  return isExpiredSignIn(message) ? `${message}\n\n${SIGN_IN_EXPIRED_HINT}` : message;
}

function eventsForContent(content: ContentBlock[] | undefined, assignmentId: string): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const block of content ?? []) {
    if (block.type === 'text') {
      // protocol.ts's ContentBlockSchema is a plain `z.union`, not a
      // discriminated one, and its catch-all `UnknownBlockSchema` only
      // requires `type: string`. A block that *claims* `type: "text"` but
      // omits the `text` field (malformed.jsonl's case) therefore parses
      // successfully as an unknown block, not a text block — `block.text` is
      // simply absent here. There is nothing to surface; skip it rather than
      // emit an empty chunk or throw.
      if (typeof block.text === 'string') {
        events.push({ t: 'text', assignmentId, chunk: block.text });
      }
      continue;
    }

    if (block.type === 'thinking') {
      // Reasoning is never agent output — the brief is explicit that
      // surfacing it would misrepresent the agent's actual report.
      continue;
    }

    if (block.type === 'tool_use') {
      if (typeof block.name !== 'string') continue; // same missing-required-field case as above
      const input = asRecord(block.input);
      events.push({ t: 'tool', assignmentId, name: block.name, summary: summariseToolUse(block.name, input) });

      const path = artifactPathFor(block.name, input);
      if (path !== undefined) {
        events.push({ t: 'artifact', assignmentId, path });
      }
      continue;
    }

    // `tool_result` blocks are not expected inside an *assistant* frame (they
    // belong to `user` frames) but the shared ContentBlockSchema permits
    // them structurally, and any genuinely unknown future block type lands
    // here too. Both are dropped for the same reason as the `user` frame
    // case above: nothing here is confirmed agent-authored text.
  }

  return events;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Priority order for picking the one input field that makes a summary readable. */
const SUMMARY_FIELDS = ['file_path', 'path', 'pattern', 'command', 'url'] as const;
const MAX_SUMMARY_VALUE_LENGTH = 80;

/**
 * Build a short, human-readable line for the inspect panel, e.g.
 * `Read src/auth/session.ts`. Never the whole `input` object — tool inputs
 * can carry large payloads (a Write's full file contents, a Bash command's
 * embedded heredoc), and dumping them would turn the panel into a wall of
 * JSON instead of a scannable activity log.
 */
function summariseToolUse(name: string, input: Record<string, unknown> | undefined): string {
  if (input === undefined) return name;

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

/** Tools whose whole purpose is producing a file, as opposed to merely reading or searching one. */
const ARTIFACT_TOOLS = new Set(['Write', 'Edit']);
const ARTIFACT_PATH_FIELDS = ['file_path', 'path'] as const;

/**
 * Decision: emit a separate `artifact` event alongside the `tool` event for
 * `Write`/`Edit` calls that name a file, rather than making the caller infer
 * "this tool call produced a file" from the `tool` event's free-text
 * summary. `Read`/`Grep`/`Glob` also carry `file_path`/`path` inputs but do
 * not produce anything, so the tool name is checked first; restricting to
 * these two known writer tools is conservative by design — a future tool
 * that also writes files will simply not get an `artifact` event until this
 * set is extended, which is a missed nicety rather than a false claim that a
 * file changed.
 */
function artifactPathFor(name: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!ARTIFACT_TOOLS.has(name) || input === undefined) return undefined;

  for (const field of ARTIFACT_PATH_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }

  return undefined;
}

function eventsForResult(frame: ResultFrame, assignmentId: string): AgentEvent[] {
  // Denials are reported on success and on failure alike, and are gathered
  // before the `is_error` branch for exactly that reason.
  const events: AgentEvent[] = eventsForPermissionDenials(frame, assignmentId);

  // The authoritative token accounting for the whole assignment, and the only
  // accurate one on this wire format — see the long note in
  // `eventsForAssistant` for the measurements that establish that. Emitted on
  // the failure branch too: a run that died partway still burned tokens, and
  // omitting them understates a failed run's cost to zero.
  const usage = frame.usage;
  if (usage !== undefined) {
    events.push({
      t: 'usage',
      assignmentId,
      inputTokens: totalInputTokens(usage),
      outputTokens: totalOutputTokens(usage),
      // The cached split, forwarded rather than folded away. `totalInputTokens`
      // sums all three counters into one number, which is the right figure to
      // DISPLAY and the wrong one to price: on the capture this adapter was
      // built against, 44,878 of 67,635 input tokens were cache reads, and
      // charging those at the fresh-input rate overstates the bill roughly
      // tenfold. Carrying the components alongside the total lets `pricing.ts`
      // charge each at its own rate without anyone re-deriving the total.
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    });
  }

  if (frame.is_error !== true) {
    return events;
  }

  // `is_error` is the authority, not `subtype` — protocol.ts documents a real
  // capture with `is_error: true` alongside `subtype: "success"`
  // simultaneously, because `subtype` describes how the CLI terminated, not
  // whether the run succeeded.
  const message = frame.result ?? frame.terminal_reason ?? 'the Claude Code CLI reported a failure with no message';
  events.push({ t: 'error', assignmentId, message, fatal: true });
  return events;
}

/**
 * Surface the result frame's `permission_denials` as non-fatal error events.
 *
 * These were parsed and then dropped, which made a denial invisible: an agent
 * that asked for `Bash`, was refused by the permission mode, and worked around
 * it produced a report indistinguishable from one written by an agent that
 * simply never wanted `Bash`. That difference matters — a denied tool is the
 * most likely explanation for a thin or hedged report, and it is the operator's
 * own configuration causing it (`permissionMode` defaults to `acceptEdits`,
 * see `provider.ts`), so it is fixable once seen.
 *
 * Non-fatal, matching how `provider.ts` already reports a tool it could not
 * grant: the agent kept working, so this is a degraded run rather than a failed
 * one (NFR-8).
 *
 * The ENTRY SHAPE IS NOT VERIFIED. `protocol.ts` types this as
 * `z.array(z.unknown())` because both captured fixtures carry an empty array —
 * a real denial has never been observed on this wire format. So each entry is
 * read defensively for any of the field names the CLI plausibly uses, and an
 * entry that yields none of them still produces an event saying a denial
 * happened without inventing a tool name for it. Reporting "something was
 * denied" is worth more than silence, and far more than a confident wrong name.
 */
function eventsForPermissionDenials(frame: ResultFrame, assignmentId: string): AgentEvent[] {
  const denials = frame.permission_denials ?? [];

  return denials.map((denial) => {
    const named = toolNameOf(denial);
    return {
      t: 'error' as const,
      assignmentId,
      message:
        named === undefined
          ? 'a tool call was denied by the permission mode (the CLI did not name the tool)'
          : `tool "${named}" was denied by the permission mode; the agent continued without it`,
      fatal: false,
    };
  });
}

const DENIAL_NAME_FIELDS = ['tool_name', 'toolName', 'tool', 'name'] as const;

function toolNameOf(denial: unknown): string | undefined {
  const record = asRecord(denial);
  if (record === undefined) return typeof denial === 'string' ? denial : undefined;

  for (const field of DENIAL_NAME_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
