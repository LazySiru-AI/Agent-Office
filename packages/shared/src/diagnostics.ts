import { z } from 'zod';

/**
 * The run-spanning diagnostics log.
 *
 * ## Why this exists when everything is already logged
 *
 * Every warning this system produces already reaches
 * `runs/<id>/logs/<assignmentId>.jsonl` as a non-fatal `error` event, and every
 * failure reaches `run.json`. Both are per-run and per-assignment, interleaved
 * with the text and usage events of the turn that produced them. That is the
 * right shape for "what happened in this run" and useless for the questions an
 * operator actually asks after a week of use:
 *
 * - *Which tool grants keep getting refused, and to which agents?*
 * - *Which MCP servers do agents keep asking for that nobody registered?*
 * - *What have agents said would make this work better?*
 *
 * Answering those from the per-run logs means knowing which of forty run
 * directories to open. This file is the append-only place they all land, so the
 * answer is one read.
 *
 * ## Why agents get a channel of their own
 *
 * `enhancement` and `blocker` are not produced by this codebase — they are
 * written by the agents doing the work, who are the only participants who see
 * the brief, the tools they were given, and the gap between them. Before this,
 * an agent that noticed "I could have answered this properly with the shell" or
 * "the brief never told me which jurisdiction" had exactly one place to put it:
 * the body of a report about something else, where it reads as a caveat and is
 * never seen again.
 *
 * The marker convention is deliberately the one `review.ts` already
 * established — `[[MARKER: text]]`, double square brackets — and for the reason
 * documented there: it is not markdown syntax, so a model that bolds its report,
 * puts it under a heading or fences it as code cannot destroy it. A second
 * convention for the same job would be one more thing for an agent author to
 * get subtly wrong.
 */

export const DIAGNOSTIC_KINDS = [
  /** A tool the agent's catalog entry asked for and the adapter refused. */
  'tool-denied',
  /** An `mcp__<server>__*` request naming a server this deployment has not registered. */
  'mcp-unregistered',
  /** A non-fatal provider complaint — a model override, a degraded capability. */
  'provider-warning',
  /** An assignment that ended without a usable report. */
  'assignment-failed',
  /**
   * A run that failed as a whole — a planning turn that exhausted its repair
   * budget, a provider that died before dispatch, a synthesis that threw.
   *
   * Distinct from `assignment-failed` because these happen when there is no
   * assignment to attach them to, and grouping the two together made "which of
   * my runs are failing, and where" unanswerable: a planning failure and an
   * agent failure are different problems with different fixes.
   */
  'run-failed',
  /**
   * A read that succeeded *incompletely* — the caller got a 200 and a partial
   * answer.
   *
   * Its own kind rather than a `request-failed`, because the request did not
   * fail: `GET /api/runs/:id/events` answers 200 with `partial: true` when a log
   * file is unreadable or a line fails validation, which is the right response
   * (the events that ARE readable are worth having). But that means the 5xx gate
   * on `request-failed` can never fire for it even in principle, so without this
   * kind the reason exists only in the response body of a request nobody kept.
   *
   * The operator opening a replay view mid-incident and seeing `partial: true`
   * is precisely the person who needs to know WHY, and `partial: true` with no
   * explanation is worse than an error — it looks like success.
   */
  'replay-degraded',
  /**
   * An HTTP request the server answered with a 5xx.
   *
   * The only kind that belongs to the *process* rather than to a run — see
   * `runId` on the record schema below. It exists because a route throwing is
   * invisible in every other channel: run artifacts record what the
   * orchestrator did, and a request that failed before reaching it (or while
   * reading a report off disk) leaves no trace in `run.json` at all.
   */
  'request-failed',
  /** Agent-authored: this would have gone better with X. */
  'enhancement',
  /** Agent-authored: something stopped me producing what was asked for. */
  'blocker',
  /** Agent-authored: worth knowing, neither of the above. */
  'note',
] as const;

export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

/**
 * Severity is *derived* from kind at the write site rather than chosen per
 * record, so the same kind cannot be logged as a warning by one call site and an
 * error by another — which is how a severity filter stops meaning anything.
 */
export const DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'error'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export const SEVERITY_FOR_KIND: Record<DiagnosticKind, DiagnosticSeverity> = {
  'tool-denied': 'warning',
  'mcp-unregistered': 'warning',
  'provider-warning': 'warning',
  'assignment-failed': 'error',
  'run-failed': 'error',
  'replay-degraded': 'warning',
  'request-failed': 'error',
  enhancement: 'info',
  blocker: 'error',
  note: 'info',
};

export const DiagnosticRecordSchema = z.object({
  ts: z.number().int().nonnegative(),
  kind: z.enum(DIAGNOSTIC_KINDS),
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  /**
   * The run this happened in.
   *
   * Optional, for the same reason `assignmentId` below is: some records are
   * scoped wider than the thing under them. A `request-failed` for
   * `GET /api/agents` belongs to the process, not to any run, and the honest
   * shape for that is an absent key — a sentinel like `'server'` would be a
   * fake id that `--run` could match and that the reader would count as a run.
   *
   * Every other kind still supplies it, and the widening is safe for the
   * existing file: every record already written has the field, so old lines
   * still parse. Readers must handle its absence (`scripts/diagnostics.ts`
   * prints those as process-level).
   */
  runId: z.string().min(1).optional(),
  /** Absent for run-level records (a planning failure belongs to no assignment). */
  assignmentId: z.string().min(1).optional(),
  /** The agent that hit it, when there is one. The most useful grouping key after `kind`. */
  agentName: z.string().min(1).optional(),
  /**
   * One line, and the field every reader groups by. Kept short deliberately: the
   * long explanation belongs in `detail`, and a message carrying a run id or a
   * path would make two occurrences of one problem look like two problems.
   */
  message: z.string().min(1).max(500),
  /** The full text — an adapter's reasoning, an agent's paragraph. Untruncated. */
  detail: z.string().max(8_000).optional(),
  /** The task the run was given, for context when reading months later. */
  task: z.string().max(500).optional(),
});

export type DiagnosticRecord = z.infer<typeof DiagnosticRecordSchema>;
