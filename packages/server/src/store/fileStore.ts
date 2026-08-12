import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LoggedAgentEventSchema,
  RunStateSchema,
  type AgentEvent,
  type LoggedAgentEvent,
  type RunState,
} from '@agent-office/shared';
import { UnsafePathError, type RunStore, type RunSummary } from './types.js';
import { assertValidRunId, newRunId, resolveWithin } from './util.js';

/**
 * The on-disk {@link RunStore} (PLAN.md §1.1, NFR-1, NFR-2, NFR-7).
 *
 * ```
 * runs/<runId>/
 *   run.json                 full state, resumable
 *   workspace/                     no longer touched directly by dispatch (AO-8)
 *     <assignmentId>/
 *       attempt-1/                 the only directory that assignment's first
 *                                  dispatch may touch
 *       attempt-2/                 present only if FR-M10 sent it back once
 *   logs/<assignmentId>.jsonl
 *   reports/NN-<agent>.md
 * ```
 *
 * Two properties drive most of the design here:
 *
 * - **NFR-2 calls `saveRun` after every transition.** A crash mid-write must
 *   never leave a truncated `run.json`, so every write is temp-file + rename
 *   rather than an in-place overwrite.
 * - **Report paths are LLM-generated.** They arrive from the Manager's
 *   `deliverable` field and are resolved through {@link resolveWithin} against
 *   the run directory before anything touches the filesystem.
 *
 * **AO-8: `workspace/` is no longer one shared directory per run.** It used to
 * be — `workspaceDir(runId)` returned a single path, and every assignment in a
 * parallel phase was handed that same directory as its `cwd`/sandbox root. FR-M5
 * spends real effort making sure an assignment sees only its own objective and
 * its declared dependencies' reports; a shared workspace quietly gave every
 * assignment in the phase a second, unlogged channel into every other one's
 * files — one agent could plant a `CLAUDE.md`, or a file that merely looked like
 * "notes for whoever runs next", and a concurrent sibling with no declared
 * dependency on it would read and could act on it. `assignmentWorkspaceDir`
 * below is the fix: each assignment gets its own subtree, keyed by assignment id
 * and then by attempt number. `workspaceDir(runId)` itself is unchanged and
 * still exists — other callers (the run's file browser, notably) still want "the
 * workspace for this run" as a single answer, and this store keeps giving them
 * one — dispatch is simply no longer among those callers.
 */

/** Filename of the persisted run state inside each run directory. */
export const RUN_STATE_FILE = 'run.json';

/** Subdirectories created for every run. */
export const RUN_SUBDIRS = ['workspace', 'logs', 'reports'] as const;

/**
 * Notified when the store skips something it could not make sense of.
 *
 * Exists so that "tolerate the damage" never means "hide the damage" — see the
 * skip policy on {@link FileRunStore.listRuns}.
 */
export type StoreWarning = (message: string, cause?: unknown) => void;

/**
 * Backoff between `rename` retries, in milliseconds. One entry per retry, so
 * this also sets the retry count. Totals ~330ms — long enough to outlast a
 * virus scanner opening a small JSON file, short enough that a genuinely stuck
 * handle still surfaces as an error rather than a hang.
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 50, 100, 150] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `<agent-office>/runs`.
 *
 * Four levels up from this file whether it is running from `src/store` (tsx,
 * vitest) or `dist/store` (built output) — the depth happens to be the same.
 */
export function defaultRunsRoot(): string {
  return path.resolve(HERE, '..', '..', '..', '..', 'runs');
}

function defaultWarning(message: string): void {
  console.warn(`[run-store] ${message}`);
}

export class FileRunStore implements RunStore {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly warn: StoreWarning;

  /**
   * Tail of the in-flight write chain for each file, keyed by absolute path.
   * Covers log appends, `run.json` saves and reports. See {@link enqueue}.
   */
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(
    rootDir: string = defaultRunsRoot(),
    now: () => number = Date.now,
    makeId: () => string = () => newRunId(),
    onWarning: StoreWarning = defaultWarning,
  ) {
    this.rootDir = path.resolve(rootDir);
    this.now = now;
    this.makeId = makeId;
    this.warn = onWarning;
  }

  /** Absolute path to the runs root. */
  get root(): string {
    return this.rootDir;
  }

  async createRun(task: string): Promise<RunState> {
    const timestamp = this.now();
    const run: RunState = {
      id: assertValidRunId(this.makeId()),
      task,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      assignments: [],
    };

    const dir = this.runDir(run.id);
    for (const sub of RUN_SUBDIRS) {
      await mkdir(path.join(dir, sub), { recursive: true });
    }

    await this.saveRun(run);
    // Matches MemoryRunStore: the caller gets the state it asked for, while the
    // persisted copy carries `saveRun`'s own `updatedAt`.
    return this.clone(run);
  }

  async loadRun(runId: string): Promise<RunState> {
    return this.readRunFile(path.join(this.runDir(runId), RUN_STATE_FILE));
  }

  async saveRun(run: RunState): Promise<void> {
    const id = assertValidRunId(run.id);
    // Validate before writing: a state that cannot be re-loaded is worse than a
    // failed save, because the failure surfaces at the next restart instead of
    // at the transition that caused it.
    const validated = RunStateSchema.parse({ ...run, updatedAt: this.now() });

    const dir = this.runDir(id);
    const target = path.join(dir, RUN_STATE_FILE);
    const body = `${JSON.stringify(validated, null, 2)}\n`;

    // Serialised per path. Assignments in a parallel phase transition
    // concurrently and each transition saves, so without this two renames race
    // onto the same `run.json` — which on Windows is an outright EPERM, not
    // merely a last-writer-wins.
    return this.enqueue(target, async () => {
      // Cheap, and it means a run directory removed underneath us fails at the
      // write rather than silently losing every later transition.
      await mkdir(dir, { recursive: true });
      await this.writeFileAtomic(target, body);
    });
  }

  /**
   * Newest first.
   *
   * Run ids are `YYYYMMDD-HHMMSS-xxxx`, so a descending directory-name sort is
   * already chronological; that ordering decides the order in which `run.json`
   * files are read. Each one still has to be read for `task` and `status`, and
   * the results are re-sorted by `createdAt` afterwards so that a clock change
   * (or an injected `makeId` that is not time-based) cannot produce a listing
   * that disagrees with the in-memory store's ordering.
   *
   * **Skip policy.** A directory that is not a valid run id, or whose
   * `run.json` is missing, unreadable, malformed or schema-invalid, is skipped
   * rather than failing the whole listing — one corrupt run must not make the
   * history browser unusable. Skipping is never silent: each one is reported
   * through the `onWarning` callback (stderr by default) naming the path and
   * the reason. Entries that are not directories are ignored outright; they are
   * not runs and never were.
   */
  async listRuns(): Promise<RunSummary[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw new Error(`cannot list runs in ${this.rootDir}: ${describeError(error)}`, {
        cause: error,
      });
    }

    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, 'en'));

    const summaries: RunSummary[] = [];
    for (const name of names) {
      let id: string;
      try {
        id = assertValidRunId(name);
      } catch {
        this.warn(`skipping ${path.join(this.rootDir, name)}: not a valid run id`);
        continue;
      }

      try {
        const run = await this.readRunFile(path.join(this.rootDir, id, RUN_STATE_FILE));
        summaries.push({
          id: run.id,
          task: run.task,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          ...(run.provider === undefined ? {} : { provider: run.provider }),
        });
      } catch (error) {
        this.warn(`skipping run "${id}": ${describeError(error)}`, error);
      }
    }

    return summaries.sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id, 'en'),
    );
  }

  runDir(runId: string): string {
    return path.join(this.rootDir, assertValidRunId(runId));
  }

  /**
   * NFR-1: the run-level sandbox, created on demand.
   *
   * Kept for callers that legitimately want one answer for "the workspace
   * directory of this run" — the run's file browser is the one that exists
   * today. `dispatchRun` (`orchestrator/dispatcher.ts`) does NOT call this any
   * more; see {@link assignmentWorkspaceDir} and the AO-8 note on this class's
   * own doc comment for why a shared directory across concurrent assignments
   * was a defect, not a convenience.
   */
  async workspaceDir(runId: string): Promise<string> {
    const dir = path.join(this.runDir(runId), 'workspace');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * AO-8: a sandbox scoped to one assignment's one attempt, not the whole run.
   *
   * Not declared on the {@link RunStore} interface — `dispatcher.ts` reaches
   * this through the small duck-typed extension point defined there
   * (`hasPerAssignmentWorkspaces`), so that adding per-assignment isolation
   * did not require widening `RunStore` itself and, with it, every other
   * implementation of it. A store that does not implement this method (today,
   * only the in-memory test double) simply falls back to the old run-level
   * `workspaceDir`, which is the correct behaviour for a store that never
   * touches real disk in the first place and has nothing for two assignments
   * to actually collide over.
   *
   * **Layout: `workspace/<assignmentId>/attempt-<n>`, one level per attempt,
   * not one directory reused across attempts.** This is the answer to the
   * re-dispatch question FR-M10 raises: an assignment can run twice (the
   * original dispatch, and the one revision a reviewer may request), and the
   * second run must not be confused by whatever the first run left behind —
   * a half-written file, an edit that made sense under the since-superseded
   * objective, anything the agent believed was scratch space and left dirty.
   * Wiping and reusing `attempt-1` in place was the other option considered
   * and rejected: it would satisfy "not confused" just as well, but at the
   * cost of destroying the one thing a human investigating a bad *first*
   * report would want to open — the workspace that actually produced it. A
   * fresh `attempt-<n>` directory per dispatch gets both: attempt 2 starts
   * from nothing (so it cannot be confused by attempt 1's leftovers, and
   * cannot mix its own files into the report evaluated as the revision's
   * fault when they were the original attempt's), and attempt 1's directory
   * survives untouched alongside it, on disk, for exactly as long as the run
   * itself does.
   *
   * **Cleanup: none, here.** More attempt directories is more litter, and this
   * method does not sweep old ones — the whole point of keeping attempt 1
   * around is that it stays available for inspection, and a store that
   * deleted it the moment attempt 2 started would reintroduce the
   * debuggability loss the per-attempt layout exists to avoid. Litter is
   * instead bounded by `MAX_REVIEW_REVISIONS` (at most one revision per
   * assignment today, so at most two attempt directories) and, at the run
   * level, by the retention policy AO-R07 adds: `scripts/purge.ts` deletes
   * `runs/<id>/` — workspace, attempts and all — wholesale, once the run
   * is old enough. Workspace litter is not a problem this method solves; it
   * is a problem the run's own eventual purge solves, on purpose.
   *
   * Containment (NFR-1) mirrors {@link logFile}'s two-step check rather than
   * trusting `resolveWithin` alone: assignment ids arrive from the Manager's
   * plan and are schema-restricted to lowercase kebab-case with no
   * separators, but that restriction lives in `shared/src/plan.ts`, a file
   * this store does not control and cannot assume will never loosen. An
   * assignment id containing its own separator (`a/../../escape`) would
   * still resolve *inside* the run directory under `resolveWithin` alone —
   * `workspace/../../escape` climbs back out of `workspace/` but not out of
   * `runDir` if crafted carefully — so the explicit `path.dirname` check
   * below additionally pins the assignment's own directory to be a direct
   * child of `workspace/`, not merely somewhere inside the run.
   */
  async assignmentWorkspaceDir(runId: string, assignmentId: string, attempt: number): Promise<string> {
    const runDir = this.runDir(runId);
    const workspaceRoot = path.join(runDir, 'workspace');
    const assignmentDir = resolveWithin(runDir, `workspace/${assignmentId}`);
    if (path.dirname(assignmentDir) !== workspaceRoot) {
      throw new UnsafePathError(assignmentId);
    }

    // `attempt` is dispatcher-computed (`AssignmentState.attempts`, itself
    // bounded by FR-M10's revision budget), never model- or plan-supplied, so
    // it gets a defensive floor rather than the full untrusted-path treatment
    // above — there is no attacker-controlled string here to smuggle a
    // traversal through.
    const safeAttempt = Math.max(1, Math.trunc(attempt));
    const attemptDir = path.join(assignmentDir, `attempt-${safeAttempt}`);

    await mkdir(attemptDir, { recursive: true });
    return attemptDir;
  }

  async writeReport(runId: string, relativePath: string, content: string): Promise<void> {
    const target = resolveWithin(this.runDir(runId), relativePath);
    // Same serialisation as saveRun: two assignments given the same deliverable
    // path by the Manager would otherwise race onto one file.
    return this.enqueue(target, async () => {
      await mkdir(path.dirname(target), { recursive: true });
      await this.writeFileAtomic(target, content);
    });
  }

  async readReport(runId: string, relativePath: string): Promise<string> {
    const target = resolveWithin(this.runDir(runId), relativePath);
    try {
      return await readFile(target, 'utf8');
    } catch (error) {
      throw new Error(`cannot read report at ${target}: ${describeError(error)}`, { cause: error });
    }
  }

  async readBinary(runId: string, relativePath: string): Promise<Buffer> {
    const target = resolveWithin(this.runDir(runId), relativePath);
    try {
      // No encoding argument: `readFile` returns a Buffer, and asking for utf8
      // here is exactly how a PDF arrives at the browser corrupted.
      return await readFile(target);
    } catch (error) {
      throw new Error(`cannot read artifact at ${target}: ${describeError(error)}`, { cause: error });
    }
  }

  async appendEvent(runId: string, assignmentId: string, event: AgentEvent): Promise<void> {
    const file = this.logFile(runId, assignmentId);
    const entry: LoggedAgentEvent = LoggedAgentEventSchema.parse({ ts: this.now(), event });
    const line = `${JSON.stringify(entry)}\n`;

    return this.enqueue(file, async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, line, 'utf8');
    });
  }

  /**
   * NFR-7 replay input.
   *
   * A crash between `appendFile`'s write and the process dying can leave a
   * final line that is cut off mid-JSON. That one case is tolerated (with a
   * warning) because it is a normal consequence of being killed. Anything else
   * — a truncated line that is *not* last, or a line that parses as JSON but
   * does not match {@link LoggedAgentEventSchema} — throws, because that is
   * corruption rather than an interrupted write, and replaying a log with holes
   * in it silently would defeat the point of having one.
   */
  async readEvents(runId: string, assignmentId: string): Promise<LoggedAgentEvent[]> {
    const file = this.logFile(runId, assignmentId);

    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw new Error(`cannot read event log at ${file}: ${describeError(error)}`, {
        cause: error,
      });
    }

    const lines = raw.split('\n');
    const events: LoggedAgentEvent[] = [];

    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (line === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const isTrailing = lines.slice(index + 1).every((rest) => rest.trim() === '');
        if (isTrailing) {
          this.warn(
            `${file}: ignoring truncated final line ${index + 1} (interrupted append)`,
            error,
          );
          continue;
        }
        throw new Error(
          `${file}: line ${index + 1} is not valid JSON and is not the final line: ${describeError(error)}`,
          { cause: error },
        );
      }

      const result = LoggedAgentEventSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `${file}: line ${index + 1} does not match LoggedAgentEventSchema: ${formatIssues(result.error.issues)}`,
        );
      }
      events.push(result.data);
    }

    return events;
  }

  /**
   * `runs/<id>/logs/<assignmentId>.jsonl`, with the assignment id pinned to a
   * single filename inside `logs/`.
   *
   * `resolveWithin` alone would accept an assignment id containing a separator
   * (`sub/a1` → `logs/sub/a1.jsonl`), which is still inside the run directory
   * but is not where anything looks for it. Assignment ids come from the
   * Manager's plan, so they get the same suspicion as report paths.
   */
  private logFile(runId: string, assignmentId: string): string {
    const runDir = this.runDir(runId);
    const file = resolveWithin(runDir, `logs/${assignmentId}.jsonl`);
    if (path.dirname(file) !== path.join(runDir, 'logs')) {
      throw new UnsafePathError(assignmentId);
    }
    return file;
  }

  /**
   * Serialise work per file path.
   *
   * Two concurrent `appendEvent` calls for the same assignment would otherwise
   * race on `mkdir` + `appendFile`; chaining them keeps both the ordering and
   * the line boundaries intact. The stored tail never rejects, so one failed
   * append does not poison every later one — the rejection still reaches the
   * caller that caused it.
   *
   * This is a within-process guarantee only. Two server processes appending to
   * the same log would still interleave; the design assumes one local
   * single-user server (NFR-6).
   */
  private enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.appendChains.get(key) ?? Promise.resolve();
    const next = previous.then(work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );

    this.appendChains.set(key, tail);
    void tail.then(() => {
      // Only the current tail may clear the entry; a later enqueue will have
      // replaced it already.
      if (this.appendChains.get(key) === tail) this.appendChains.delete(key);
    });

    return next;
  }

  /**
   * Write via a temp file in the same directory, then rename over the target.
   *
   * Same directory matters: `rename` is only atomic within a filesystem, and a
   * temp file in the OS temp dir may well be on a different one. A reader
   * therefore sees either the old file or the complete new one, never a
   * half-written one (NFR-2).
   *
   * Callers reach this through {@link enqueue}, so writes to one path never
   * overlap. The retry below is for handles this process does not own.
   */
  private async writeFileAtomic(target: string, contents: string): Promise<void> {
    const dir = path.dirname(target);
    const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);

    try {
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(contents, 'utf8');
        try {
          await handle.sync();
        } catch (error) {
          // fsync is unsupported on some filesystems. It buys durability across
          // a power loss, not the atomicity the rename already provides, so a
          // failure here is reported rather than fatal.
          this.warn(`fsync failed for ${tmp}; write is atomic but not durable`, error);
        }
      } finally {
        await handle.close();
      }
      await this.renameWithRetry(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new Error(`cannot write ${target}: ${describeError(error)}`, { cause: error });
    }
  }

  /**
   * `rename` over an existing file fails on Windows with `EPERM`/`EBUSY`/
   * `EACCES` whenever anything else holds a handle to the target — antivirus
   * mid-scan, a file watcher, an editor with `run.json` open. The handle is
   * released within milliseconds, so a short backoff converts a hard run failure
   * into a pause nobody notices.
   *
   * This is the app's highest-frequency filesystem operation (NFR-2 saves after
   * every state transition), so leaving it un-retried means a long run is
   * near-certain to hit it. POSIX does not need this, but the retry is harmless
   * there — those codes do not arise for this operation.
   */
  private async renameWithRetry(tmp: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, target);
        if (attempt > 0) {
          this.warn(`rename onto ${target} succeeded after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
        }
        return;
      } catch (error) {
        const code = errorCode(error);
        const contended = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!contended || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
        await delay(RENAME_RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
  }

  private async readRunFile(file: string): Promise<RunState> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read run state at ${file}: ${describeError(error)}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`run state at ${file} is not valid JSON: ${describeError(error)}`, {
        cause: error,
      });
    }

    const result = RunStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `run state at ${file} does not match RunStateSchema: ${formatIssues(result.error.issues)}`,
      );
    }
    return result.data;
  }

  private clone(run: RunState): RunState {
    return RunStateSchema.parse(JSON.parse(JSON.stringify(run)));
  }
}

interface SchemaIssue {
  readonly path: ReadonlyArray<string | number | symbol>;
  readonly message: string;
}

function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('; ');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `error.code` for Node's errno exceptions, without an `any` cast. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
