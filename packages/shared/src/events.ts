import { z } from 'zod';
import { AssignmentStatusSchema } from './status.js';

/**
 * The normalised event stream (PLAN.md §1.4).
 *
 * Every provider — Claude Code today, raw APIs later — is flattened into this
 * union before anything else sees it. That flattening is the seam that keeps the
 * orchestrator and the sim provider-agnostic, so resist adding provider-specific
 * fields here; put them in the raw `.jsonl` log instead.
 */

const base = { assignmentId: z.string().min(1) };

export const AgentEventSchema = z.discriminatedUnion('t', [
  z.object({
    ...base,
    t: z.literal('status'),
    status: AssignmentStatusSchema,
    /**
     * Fields `dispatcher.ts`'s `setStatus` sets on `AssignmentState` in the
     * same breath as this status change — `reportPath`/`endedAt` on `done`,
     * `error`/`endedAt` on `skipped` or `failed`. Carrying them here is what
     * lets replay's fold (`useReplay.ts`, NFR-7) apply the real values instead
     * of guessing: before this, the event carried only `{ status }`, so a
     * replayed `reportPath` was inferred from `deliverable` (wrong for a
     * revised assignment whose report moved) and a replayed `error` was
     * whatever fatal `error` event happened to precede it (wrong for
     * `skipped`, which never emits one).
     *
     * ALL THREE ARE OPTIONAL, and must stay that way: every `.jsonl` line
     * already on disk was written before this field existed, so it parses as
     * `{ status }` with these absent. Absent has to keep meaning "this status
     * change carried no such field" — not "clear it" — or an old log would
     * replay differently than it did the day it was recorded, which is
     * exactly what NFR-7 promises will not happen.
     */
    reportPath: z.string().min(1).optional(),
    error: z.string().optional(),
    endedAt: z.number().int().nonnegative().optional(),
    /**
     * FR-M10's `done -> briefing` revision re-dispatch clears the target's
     * `endedAt` (the work is not finished any more), and that clearing has to
     * reach the log too, or a replayed revision shows `briefing` next to the
     * STALE `endedAt` from the assignment's earlier completion — appearing to
     * finish before it restarted.
     *
     * This cannot reuse the `endedAt` field above by simply omitting it:
     * omission already means "unchanged" for every other field on every other
     * event (see the constraint above), so an absent `endedAt` on a
     * `briefing` event is indistinguishable from "nothing to say about
     * `endedAt`" and the fold would leave the old value sitting there. A
     * distinct, explicit signal is the only honest way to say "this field had
     * a value, and now it does not" rather than "this field was never
     * mentioned".
     */
    endedAtCleared: z.literal(true).optional(),
    /**
     * Dispatch attempt count, as of this transition.
     *
     * `dispatcher.ts`'s `executeAssignment` already hands `setStatus` an
     * `attempts` in the same patch as the opening `briefing` — it was simply
     * never put on the event, and that omission was the one field replay
     * could not reconstruct at all: no other variant records a change in
     * attempt count, so `useReplay.ts`'s fold had to leave `attempts` at
     * whatever the fetched base `RunState` held (normally the run's FINAL
     * value) for the whole of playback. A run whose reviewer sent work back
     * once therefore replayed as though it had always been on its second
     * attempt, from the first frame.
     *
     * Optional for the same reason the three fields above are: every
     * `.jsonl` line written before this existed parses without it, and absent
     * must keep meaning "this transition said nothing about `attempts`", not
     * "reset it to zero". Only `briefing` carries it in practice, because
     * that is the only transition that changes it.
     */
    attempts: z.number().int().nonnegative().optional(),
  }),
  z.object({ ...base, t: z.literal('text'), chunk: z.string() }),
  z.object({
    ...base,
    t: z.literal('tool'),
    name: z.string().min(1),
    /** Short human-readable line for the inspect panel, e.g. `Read src/app.ts`. */
    summary: z.string(),
  }),
  z.object({ ...base, t: z.literal('artifact'), path: z.string().min(1) }),
  z.object({
    ...base,
    t: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  z.object({
    ...base,
    t: z.literal('error'),
    message: z.string(),
    /** Fatal ends the assignment; non-fatal is a recoverable hiccup (NFR-8). */
    fatal: z.boolean(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['t'];

/** An event as persisted to `runs/<id>/logs/<assignmentId>.jsonl` (NFR-7 replay). */
export const LoggedAgentEventSchema = z.object({
  /** Epoch milliseconds. Replay uses the deltas to pace playback. */
  ts: z.number().int().nonnegative(),
  event: AgentEventSchema,
});

export type LoggedAgentEvent = z.infer<typeof LoggedAgentEventSchema>;

export function isAgentEventType<T extends AgentEventType>(
  event: AgentEvent,
  t: T,
): event is Extract<AgentEvent, { t: T }> {
  return event.t === t;
}
