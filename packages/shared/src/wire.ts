import { z } from 'zod';
import { LoggedAgentEventSchema } from './events.js';
import { RunStateSchema, type Usage } from './run.js';
import { RunStatusSchema } from './status.js';

/**
 * The client/server wire contract (PLAN.md Phase 3).
 *
 * Phase 3 splits the app across a process boundary for the first time, so the
 * two sides need an agreed vocabulary before either can be written. Everything
 * crossing that boundary is defined here and nowhere else — a route string or
 * message shape that exists only in the server or only in the client is a bug
 * waiting for the next refactor.
 *
 * Both directions are zod schemas rather than bare types. The server must not
 * trust a browser tab, and the client must not trust that the server it
 * reconnected to is the version it was built against.
 */

// ---------------------------------------------------------------------------
// 1. HTTP surface
// ---------------------------------------------------------------------------

/**
 * Every HTTP route, as functions rather than string literals so a typo cannot
 * silently disagree across the two packages.
 *
 * NFR-6: the server binds to loopback only. These are same-origin paths; the
 * client never needs a host.
 */
export const API = {
  health: () => '/api/health',
  agents: () => '/api/agents',
  /**
   * Which providers this server can actually construct, and why not (Phase 7).
   *
   * Answered by the server rather than assumed by the client because
   * availability depends on the *server's* environment — an API key, a CLI on
   * its PATH. The browser has no way to know any of that, and a settings panel
   * that offered `anthropic` on a machine with no key would be offering a run
   * that fails a minute later.
   */
  providers: () => '/api/providers',
  runs: () => '/api/runs',
  run: (runId: string) => `/api/runs/${encodeURIComponent(runId)}`,
  cancelRun: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/cancel`,
  /** The Manager's synthesis (`report.md`). */
  runReport: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/report`,
  /**
   * One assignment's report. The path is a run-relative `reports/NN-agent.md`,
   * passed as a query parameter so slashes need no double encoding.
   */
  assignmentReport: (runId: string, reportPath: string) =>
    `/api/runs/${encodeURIComponent(runId)}/report-file?path=${encodeURIComponent(reportPath)}`,
  /**
   * The run's full event history, read from `runs/<id>/logs/*.jsonl` (NFR-7).
   *
   * Distinct from the WebSocket `snapshot`, which serves a *live* reattach from
   * a bounded ring buffer and therefore truncates. Replay needs the whole run,
   * including runs that finished before this server process started, so it has
   * to come off disk rather than out of memory.
   */
  runEvents: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  /**
   * The finished PDF (FR-P5). Served as a binary download rather than JSON, so
   * the client can point an anchor at it and let the browser do the saving —
   * no blob juggling, and the filename comes from `Content-Disposition`.
   */
  runPdf: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/pdf`,
  /** WebSocket endpoint (NFR-3: push, never polling). */
  socket: () => '/ws',
} as const;

/** `POST /api/runs` body. */
export const CreateRunRequestSchema = z.object({
  task: z.string().min(1, 'a task is required').max(20_000),
  /** Defaults to `scripted` server-side until Phase 1 lands a real provider. */
  provider: z.string().min(1).optional(),
  concurrency: z.number().int().positive().max(12).optional(),
  timeoutMs: z.number().int().positive().optional(),
  tokenBudget: z.number().int().positive().optional(),
  /**
   * Per-assignment spend cap in USD (FR-M8), forwarded to the Claude Code
   * adapter's `--max-budget-usd`. `timeoutMs` and `tokenBudget` above were
   * already wired from this schema through the supervisor to the dispatcher;
   * this field was the omission — the web settings panel has always sent it,
   * but the schema dropped it before it reached anything that could act on
   * it, so it was documented and tested in isolation while every real run
   * ignored it. `.positive()` and `.finite()` both matter: zero or a negative
   * cap must not reach the CLI reading as "protected" when it isn't, and
   * `.finite()` rules out `NaN`/`Infinity` from a hand-built or non-JSON
   * request body.
   */
  maxCostUsd: z.number().positive().finite().optional(),
});

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/** `POST /api/runs` response. The run is already executing when this returns. */
export const CreateRunResponseSchema = z.object({
  runId: z.string().min(1),
});

export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

/**
 * A row in the run list. Mirrors the store's `RunSummary`, but lives here
 * because the client renders it and `shared` may not import from `server`.
 */
export const RunSummarySchema = z.object({
  id: z.string().min(1),
  task: z.string(),
  status: RunStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Mirrors `RunState.provider`; see the note there on why cost needs it. */
  provider: z.string().min(1).optional(),
  /** True when this run is executing in the current server process. */
  live: z.boolean().default(false),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunListResponseSchema = z.object({
  runs: z.array(RunSummarySchema),
});

export type RunListResponse = z.infer<typeof RunListResponseSchema>;

/** One roster entry, for the agent browser. Deliberately not the full prompt. */
export const AgentSummarySchema = z.object({
  name: z.string(),
  category: z.string(),
  description: z.string(),
  tools: z.array(z.string()),
  model: z.string().optional(),
});

export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentListResponseSchema = z.object({
  agents: z.array(AgentSummarySchema),
});

export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

/**
 * One provider's readiness (Phase 7).
 *
 * `reason` is deliberately human text rather than a code: the only consumer is
 * a line in a settings panel, and "ANTHROPIC_API_KEY is not set" is the whole
 * answer. A code would need a lookup table on the client that could only ever
 * say the same sentence less directly.
 *
 * Note what is absent: no key, no endpoint, no model. Availability is the only
 * thing the browser needs, and anything more would put credentials one
 * screenshot away from being shared.
 */
export const ProviderInfoSchema = z.object({
  id: z.string().min(1),
  available: z.boolean(),
  reason: z.string().optional(),
});

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderInfoSchema),
});

export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;

export const ReportResponseSchema = z.object({
  path: z.string(),
  markdown: z.string(),
});

export type ReportResponse = z.infer<typeof ReportResponseSchema>;

/**
 * `GET /api/runs/:id/events` — the whole run, for replay (NFR-7).
 *
 * Ordered by `ts` across every assignment, because the per-assignment `.jsonl`
 * files are written concurrently and interleaving them is the only way to
 * reconstruct what the office actually looked like moment to moment.
 *
 * The replay's value is that it costs nothing: iterating the office sim against
 * a real run must not mean re-running the agents. That is the requirement, not
 * a convenience — PLAN.md §4 lists "sim iteration burns tokens" as a risk whose
 * mitigation is this endpoint existing.
 */
export const RunEventsResponseSchema = z.object({
  runId: z.string().min(1),
  events: z.array(LoggedAgentEventSchema),
  /**
   * True when at least one log file could not be read. The replay is still
   * usable — it is simply missing an agent — and saying so beats presenting a
   * hole as the truth.
   */
  partial: z.boolean().default(false),
});

export type RunEventsResponse = z.infer<typeof RunEventsResponseSchema>;

/** Every error response body, so the client has exactly one shape to handle. */
export const ApiErrorSchema = z.object({
  error: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// 2. WebSocket messages
// ---------------------------------------------------------------------------

/**
 * Client -> server.
 *
 * Subscription is explicit and per-run: a tab watching one run must not receive
 * the event firehose of every other run in the process.
 */
export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('subscribe'), runId: z.string().min(1) }),
  z.object({ t: z.literal('unsubscribe'), runId: z.string().min(1) }),
  /** Keeps intermediaries from idling the socket shut. */
  z.object({ t: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * Server -> client.
 *
 * `snapshot` is what makes NFR-2 work. A subscribing client is sent the full
 * current `RunState` plus the buffered event history *before* any live event,
 * so a refresh mid-run reconstructs the same view rather than resuming from
 * whatever happens to arrive next. Clients therefore never need to merge a
 * partial state — they replace wholesale on `snapshot` and `state`.
 */
export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    serverTime: z.number().int().nonnegative(),
    /** Runs executing in this process right now. */
    liveRunIds: z.array(z.string()),
  }),
  z.object({
    t: z.literal('snapshot'),
    run: RunStateSchema,
    events: z.array(LoggedAgentEventSchema),
    /** Whether more events are still coming, i.e. the run is executing. */
    live: z.boolean(),
    /**
     * True when the buffer dropped its oldest events, so the client can say the
     * history is partial instead of implying it has everything.
     */
    truncated: z.boolean().default(false),
  }),
  z.object({
    t: z.literal('event'),
    runId: z.string().min(1),
    event: LoggedAgentEventSchema,
  }),
  /** Full replacement of run state after any transition (NFR-2). */
  z.object({ t: z.literal('state'), run: RunStateSchema }),
  /** The run list changed — a run started, or reached a terminal status. */
  z.object({ t: z.literal('runs'), runs: z.array(RunSummarySchema) }),
  /** Orchestrator log lines (the CLI's `logger`), surfaced in the UI. */
  z.object({
    t: z.literal('log'),
    runId: z.string().min(1),
    line: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('error'),
    message: z.string(),
    runId: z.string().optional(),
  }),
  z.object({ t: z.literal('pong') }),
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/**
 * Per-run ring-buffer size for replayable events.
 *
 * Bounded because a long run with chatty agents would otherwise grow without
 * limit in server memory. The full history is always on disk in
 * `logs/<assignmentId>.jsonl`; this buffer only serves the reattach path, and
 * `snapshot.truncated` tells the client when it is not the whole story.
 */
export const EVENT_BUFFER_LIMIT = 2_000;

/** Same reasoning, for orchestrator log lines. */
export const LOG_BUFFER_LIMIT = 500;

// ---------------------------------------------------------------------------
// 3. Cost (NFR-5)
// ---------------------------------------------------------------------------

/**
 * USD per million tokens, keyed by the `model` field in agent frontmatter.
 *
 * **These are approximate and will drift.** They exist so the UI can show an
 * order-of-magnitude figure next to the token count, which is the actual
 * NFR-5 requirement; they are not billing data. `estimateCostUsd` returns
 * `undefined` for an unpriced model rather than guessing, so an unknown model
 * shows tokens only instead of a confidently wrong dollar figure.
 */
export const DEFAULT_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  haiku: { inputPerMTok: 0.8, outputPerMTok: 4 },
};

/** The scripted provider calls nothing, so its runs must read as free. */
export const FREE_MODELS = new Set(['scripted', 'none']);

export function estimateCostUsd(usage: Usage, model?: string): number | undefined {
  if (model !== undefined && FREE_MODELS.has(model)) return 0;
  const price = model === undefined ? undefined : DEFAULT_PRICING[model];
  if (price === undefined) return undefined;
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}

/** `$0.0123` / `$1.23`, or `—` when the model carries no price. */
export function formatCostUsd(cost: number | undefined): string {
  if (cost === undefined) return '—';
  if (cost === 0) return '$0.00';
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}
