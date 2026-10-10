import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DiagnosticRecordSchema,
  SEVERITY_FOR_KIND,
  type DiagnosticKind,
  type DiagnosticRecord,
} from '@agent-office/shared';

/**
 * The append-only diagnostics log (see `shared/src/diagnostics.ts` for what it is
 * for).
 *
 * ## Where it lives, and why there
 *
 * `runs/diagnostics.jsonl` — beside the run directories, not inside one.
 *
 * - Inside `runs/`, so it inherits the gitignore that keeps every other run
 *   artifact off the repository. A diagnostics file at the repo root would be
 *   untracked and one `git add -A` from being committed, which is precisely the
 *   hazard the stray `reports/` directory demonstrated.
 * - At the ROOT of `runs/` rather than in a run directory, because
 *   `scripts/purge.ts` deletes whole run directories by age. A log whose entire
 *   purpose is to be read months later must not be deleted by the retention
 *   policy for transcripts. Purge skips non-directories (`entry.isDirectory()`),
 *   so a file here survives it — that is load-bearing, and
 *   `purge.test.ts` should keep it true.
 *
 * ## Append-only, one JSON object per line
 *
 * The same format as the per-run event logs, for the same reasons: a crash
 * mid-write costs the last line rather than the file, appending needs no read of
 * what is already there, and a reader can stream it. Nothing here ever rewrites
 * or compacts — an aggregated view is the *reader's* job (`scripts/diagnostics.ts`
 * groups by kind and message), because the frequency of a repeated warning is the
 * most useful thing the log knows and compaction is how you lose it.
 *
 * ## Failure posture: never break the run
 *
 * Every write is best-effort and swallows its error. This log observes a run; it
 * is not part of one, and a full disk or a locked file must not fail an
 * assignment that otherwise succeeded. That is the opposite of the store's
 * posture for reports (`writeReport` failing DOES fail the assignment), and the
 * difference is the point: a missing report means the run produced nothing, a
 * missing diagnostic means we know slightly less about a run that worked.
 */

export const DIAGNOSTICS_FILENAME = 'diagnostics.jsonl';

/**
 * What the orchestrator needs from this module, and nothing more.
 *
 * Declared as an interface so `dispatcher.ts` and `runner.ts` depend on the
 * *capability* rather than on {@link DiagnosticsLog} itself — which keeps a
 * filesystem class out of the orchestrator's imports and lets a test pass an
 * array-backed sink without touching disk.
 */
export interface DiagnosticsSink {
  record(input: DiagnosticInput): Promise<DiagnosticRecord | undefined>;
}

/**
 * Classify a non-fatal provider complaint.
 *
 * The honest note first: this reads the message text, which is a heuristic, and
 * heuristics on human-readable strings rot when the string is reworded. The
 * alternative was a `kind` field on `AgentEvent` — and that type is persisted to
 * every run's event log and re-read by replay (NFR-7), so widening it for an
 * observability nicety would mean a contract change, a schema migration for
 * existing logs, and a replay path that has to tolerate both shapes. That is a
 * real cost against a small gain.
 *
 * The mitigation is that both matched phrases are produced by exactly one call
 * site each, both in this repository, and both are asserted by this module's
 * tests — so a reword breaks a test rather than silently degrading every future
 * record to `provider-warning`. A miss is also cheap: the record is still
 * written, still grouped, still readable, just filed under the general kind.
 */
export function classifyProviderWarning(message: string): DiagnosticKind {
  if (/mcp-server-not-registered|not registered/i.test(message)) return 'mcp-unregistered';
  if (/was not granted/i.test(message)) return 'tool-denied';
  return 'provider-warning';
}

export interface DiagnosticInput {
  kind: DiagnosticKind;
  /** Absent for process-level records — see the schema's own comment on this field. */
  runId?: string;
  message: string;
  assignmentId?: string;
  agentName?: string;
  detail?: string;
  task?: string;
}

export interface DiagnosticsLogOptions {
  /** The `runs/` root. The log is written to `<runsRoot>/diagnostics.jsonl`. */
  runsRoot: string;
  /** Injected for tests, and so a caller can pin timestamps. */
  now?: () => number;
  /**
   * Where a write failure is reported. Defaults to silence, deliberately: the
   * server passes its own warning channel, and a CLI run should not print a
   * scary line about the observability layer when the run itself is fine.
   */
  onWarning?: (message: string, cause?: unknown) => void;
}

/** One line's worth of budget for a message, matching the schema's own cap. */
const MAX_MESSAGE_CHARS = 500;
const MAX_DETAIL_CHARS = 8_000;
const MAX_TASK_CHARS = 500;

export class DiagnosticsLog {
  private readonly file: string;
  private readonly now: () => number;
  private readonly onWarning: (message: string, cause?: unknown) => void;

  /**
   * Serialises writes within this process.
   *
   * `appendFile` with a single `write` is atomic enough for short lines on both
   * platforms in practice, but "in practice" is doing a lot of work there and two
   * assignments in a parallel phase log at the same instant by design. Chaining
   * on one promise costs nothing measurable — these are rare, small writes — and
   * removes the question entirely.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: DiagnosticsLogOptions) {
    this.file = path.join(options.runsRoot, DIAGNOSTICS_FILENAME);
    this.now = options.now ?? (() => Date.now());
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  get path(): string {
    return this.file;
  }

  /**
   * Append one record. Never throws.
   *
   * Returns the record it wrote (or `undefined` when it could not build a valid
   * one), so a caller that wants to assert on the result in a test can, without
   * reading the file back.
   */
  async record(input: DiagnosticInput): Promise<DiagnosticRecord | undefined> {
    const candidate = {
      ts: this.now(),
      kind: input.kind,
      severity: SEVERITY_FOR_KIND[input.kind],
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      message: truncate(collapse(input.message), MAX_MESSAGE_CHARS),
      ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }),
      ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
      ...(input.detail === undefined ? {} : { detail: truncate(input.detail, MAX_DETAIL_CHARS) }),
      ...(input.task === undefined ? {} : { task: truncate(collapse(input.task), MAX_TASK_CHARS) }),
    };

    // Validated on the way IN, not only on the way out. A malformed record is a
    // bug at the call site, and catching it here means the file never contains a
    // line the reader will choke on — a log that cannot be parsed is worse than
    // one missing an entry.
    const parsed = DiagnosticRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      this.onWarning(
        `diagnostics: refusing to log a malformed ${input.kind} record`,
        parsed.error,
      );
      return undefined;
    }

    const line = `${JSON.stringify(parsed.data)}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.appendFile(this.file, line, 'utf8');
      } catch (error) {
        this.onWarning('diagnostics: could not append to the log', error);
      }
    });
    await this.queue;

    return parsed.data;
  }

  /**
   * Read every record, oldest first.
   *
   * A missing file is an empty list, not an error: it is the normal state of a
   * deployment that has never had anything worth logging, and making the reader
   * distinguish that from a real failure would put a try/catch at every call
   * site to say the same thing.
   *
   * An unparseable line is SKIPPED rather than fatal, and counted so the caller
   * can say so. A single truncated last line — the exact thing an append-only
   * log gets from a crash — must not cost a reader the other nine hundred.
   */
  async read(): Promise<{ records: DiagnosticRecord[]; skipped: number }> {
    let text: string;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], skipped: 0 };
      throw error;
    }

    const records: DiagnosticRecord[] = [];
    let skipped = 0;

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = DiagnosticRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }

    return { records, skipped };
  }
}

/**
 * Messages are a grouping key, so a newline in one would split a group that is
 * really one problem — and an embedded newline in a JSONL value is legal but
 * makes the file painful to grep, which is the other way people will read it.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
