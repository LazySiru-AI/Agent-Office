import path from 'node:path';
import {
  RunStateSchema,
  type AgentEvent,
  type LoggedAgentEvent,
  type RunState,
} from '@agent-office/shared';
import type { RunStore, RunSummary } from './types.js';
import { assertSafeRelativePath, assertValidRunId, newRunId } from './util.js';

/**
 * An in-memory {@link RunStore}.
 *
 * Lets the dispatcher be tested without touching disk, which matters because
 * those tests exercise concurrency, cancellation and timeouts — all of which are
 * slow and flaky when every state transition is an fsync.
 *
 * `saveRun` deep-clones through the schema, exactly as the file store does via
 * JSON. Without that, a test could mutate stored state by holding a reference
 * and the persistence bugs it exists to catch would pass silently.
 */
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunState>();
  private readonly reports = new Map<string, Map<string, string>>();
  private readonly logs = new Map<string, Map<string, LoggedAgentEvent[]>>();

  constructor(
    private readonly rootDir = path.resolve('/virtual/runs'),
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = () => newRunId(),
  ) {}

  async createRun(task: string): Promise<RunState> {
    const timestamp = this.now();
    const run: RunState = {
      id: this.makeId(),
      task,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      assignments: [],
    };

    await this.saveRun(run);
    return this.clone(run);
  }

  async loadRun(runId: string): Promise<RunState> {
    const stored = this.runs.get(assertValidRunId(runId));
    if (stored === undefined) {
      throw new Error(`run "${runId}" not found`);
    }
    return this.clone(stored);
  }

  async saveRun(run: RunState): Promise<void> {
    assertValidRunId(run.id);
    this.runs.set(run.id, this.clone({ ...run, updatedAt: this.now() }));
  }

  async listRuns(): Promise<RunSummary[]> {
    return [...this.runs.values()]
      .map((run) => ({
        id: run.id,
        task: run.task,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id, 'en'));
  }

  runDir(runId: string): string {
    return path.join(this.rootDir, assertValidRunId(runId));
  }

  async workspaceDir(runId: string): Promise<string> {
    return path.join(this.runDir(runId), 'workspace');
  }

  async writeReport(runId: string, relativePath: string, content: string): Promise<void> {
    const safe = assertSafeRelativePath(relativePath);
    const bucket = this.reports.get(assertValidRunId(runId)) ?? new Map<string, string>();
    bucket.set(safe, content);
    this.reports.set(runId, bucket);
  }

  async readReport(runId: string, relativePath: string): Promise<string> {
    const safe = assertSafeRelativePath(relativePath);
    const content = this.reports.get(assertValidRunId(runId))?.get(safe);
    if (content === undefined) {
      throw new Error(`report "${relativePath}" not found in run "${runId}"`);
    }
    return content;
  }

  async appendEvent(runId: string, assignmentId: string, event: AgentEvent): Promise<void> {
    const byAssignment = this.logs.get(assertValidRunId(runId)) ?? new Map<string, LoggedAgentEvent[]>();
    const entries = byAssignment.get(assignmentId) ?? [];
    entries.push({ ts: this.now(), event });
    byAssignment.set(assignmentId, entries);
    this.logs.set(runId, byAssignment);
  }

  async readEvents(runId: string, assignmentId: string): Promise<LoggedAgentEvent[]> {
    return [...(this.logs.get(assertValidRunId(runId))?.get(assignmentId) ?? [])];
  }

  /** Test helper: every report written for a run, keyed by relative path. */
  reportsFor(runId: string): ReadonlyMap<string, string> {
    return this.reports.get(runId) ?? new Map<string, string>();
  }

  private clone(run: RunState): RunState {
    return RunStateSchema.parse(JSON.parse(JSON.stringify(run)));
  }
}
