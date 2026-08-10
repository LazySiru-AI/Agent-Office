import type { AgentEvent, LoggedAgentEvent, RunState } from '@agent-office/shared';

/**
 * Run persistence (PLAN.md NFR-2, NFR-7).
 *
 * An interface rather than a concrete class so the dispatcher can be tested
 * against an in-memory store without touching disk, and so JSON-on-disk can be
 * swapped for SQLite in Phase 7 without the orchestrator noticing.
 */

export interface RunSummary {
  id: string;
  task: string;
  status: RunState['status'];
  createdAt: number;
  updatedAt: number;
  /** Absent on runs persisted before `RunState.provider` existed. */
  provider?: string;
}

export interface RunStore {
  /** Allocate a run id, create its directory tree, and persist the initial state. */
  createRun(task: string): Promise<RunState>;

  /** Load and schema-validate `runs/<id>/run.json`. Throws if absent or invalid. */
  loadRun(runId: string): Promise<RunState>;

  /**
   * Persist state. Called after EVERY transition (NFR-2), so it must be cheap
   * and atomic — write to a temp file and rename, never a partial overwrite.
   */
  saveRun(run: RunState): Promise<void>;

  /** Newest first. Backs the Phase 7 run-history browser. */
  listRuns(): Promise<RunSummary[]>;

  /** Absolute path to `runs/<id>`. */
  runDir(runId: string): string;

  /**
   * Absolute path to `runs/<id>/workspace`, created on demand.
   *
   * NFR-1: this is the only directory a code-writing agent may touch. The user's
   * own repositories are never a working directory.
   */
  workspaceDir(runId: string): Promise<string>;

  /**
   * Write a report at a run-relative path, e.g. `reports/03-security-auditor.md`.
   *
   * Implementations MUST reject paths that escape the run directory — an
   * absolute path, or one that climbs out via `..`. The path originates in the
   * Manager's `deliverable` field, which is LLM-generated and therefore
   * untrusted input.
   */
  writeReport(runId: string, relativePath: string, content: string): Promise<void>;

  /** Read a previously written report. Same path constraints as `writeReport`. */
  readReport(runId: string, relativePath: string): Promise<string>;

  /** Append one event to `runs/<id>/logs/<assignmentId>.jsonl`. */
  appendEvent(runId: string, assignmentId: string, event: AgentEvent): Promise<void>;

  /** Read an assignment's full event log, for replay (NFR-7). */
  readEvents(runId: string, assignmentId: string): Promise<LoggedAgentEvent[]>;
}

/** Raised when a caller-supplied relative path would escape the run directory. */
export class UnsafePathError extends Error {
  constructor(relativePath: string) {
    super(`refusing to use path "${relativePath}": it escapes the run directory`);
    Object.setPrototypeOf(this, UnsafePathError.prototype);
    this.name = 'UnsafePathError';
  }
}
