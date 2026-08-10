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
  z.object({ ...base, t: z.literal('status'), status: AssignmentStatusSchema }),
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
