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
 *   workspace/               the only directory a code-writing agent may touch
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
   * Tail of the in-flight append chain for each log file, keyed by absolute
   * path. See {@link enqueue}.
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
    // Cheap, and it means a run directory removed underneath us fails at the
    // write rather than silently losing every later transition.
    await mkdir(dir, { recursive: true });
    await this.writeFileAtomic(
      path.join(dir, RUN_STATE_FILE),
      `${JSON.stringify(validated, null, 2)}\n`,
    );
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

  /** NFR-1: the sandbox, created on demand so it always exists before dispatch. */
  async workspaceDir(runId: string): Promise<string> {
    const dir = path.join(this.runDir(runId), 'workspace');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeReport(runId: string, relativePath: string, content: string): Promise<void> {
    const target = resolveWithin(this.runDir(runId), relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await this.writeFileAtomic(target, content);
  }

  async readReport(runId: string, relativePath: string): Promise<string> {
    const target = resolveWithin(this.runDir(runId), relativePath);
    try {
      return await readFile(target, 'utf8');
    } catch (error) {
      throw new Error(`cannot read report at ${target}: ${describeError(error)}`, { cause: error });
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
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new Error(`cannot write ${target}: ${describeError(error)}`, { cause: error });
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
