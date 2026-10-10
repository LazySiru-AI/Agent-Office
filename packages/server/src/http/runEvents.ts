import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LoggedAgentEventSchema, type LoggedAgentEvent } from '@agent-office/shared';
import type { RunStore } from '../store/types.js';
import { assertValidRunId, resolveWithin } from '../store/util.js';

/**
 * `GET /api/runs/:id/events` support (PLAN.md NFR-7 replay).
 *
 * The live WebSocket `snapshot` only ever shows a bounded ring buffer (see
 * `EVENT_BUFFER_LIMIT` in wire.ts) and nothing at all for a run that finished
 * before this server process started. Replay needs the *entire* run, so this
 * reads straight off `runs/<id>/logs/*.jsonl` rather than going through any
 * in-memory state.
 *
 * Deliberately independent of `RunStore.readEvents`: that method takes one
 * assignment id, and the whole point here is that we do not know the set of
 * assignment ids up front — a run that failed during planning has none, and one
 * that failed outside the pipeline may have written logs for assignments that
 * never made it into `run.json`. Reading the directory itself is the only way
 * to see everything that was actually recorded.
 */

export interface RunEventsResult {
  events: LoggedAgentEvent[];
  /** True when a file could not be read, or a line inside one was skipped. */
  partial: boolean;
  /**
   * Present only when `partial` is true (absent, not `undefined` — see the
   * `exactOptionalPropertyTypes` note below); explains *why*, for an operator
   * reading a log line during an incident rather than for a UI. Before this
   * field existed, every one of the three failure modes below (directory
   * listing, a specific log file, a specific log line) collapsed into the
   * same `partial: true` with no way to tell them apart short of reading this
   * file's source, which is exactly the defect this field fixes.
   *
   * `server.ts` currently destructures only `{ events, partial }` from this
   * result and is untouched by this change — this is an added optional key,
   * not a reshaping of what was already returned. `...(reason === undefined
   * ? {} : { reason })` at the return sites is required, not stylistic:
   * with `exactOptionalPropertyTypes`, `{ reason: undefined }` is a
   * different (and here, wrong) shape from omitting the key outright.
   *
   * ## Never an absolute path
   * `fileStore.ts` used to build a message containing `cannot read run state
   * at <absolute path>: ...` that reached an HTTP client verbatim before
   * `loadRun` in `server.ts` was fixed to swallow it rather than forward
   * `describe(error)` (see the comment there). Node's own fs error messages
   * have the same problem — `"EACCES: permission denied, scandir
   * 'C:\\Users\\...\\logs'"` — so this function never puts `error.message`
   * from a filesystem call into `reason`. Only `error.code` (a short
   * constant like `EACCES`/`EPERM`) and run-relative filenames (the bare
   * names `readdir` returned, never the `path.join(logsDir, filename)` used
   * for the actual read) are eligible. `JSON.parse`/schema-validation
   * failures are the one exception: those messages describe the *content* of
   * a line, not a filesystem path, so they carry no run-directory location
   * information and are safe to include.
   *
   * ## Why counts/lists instead of one clause per occurrence
   * See the accumulator comment inside `collectRunEvents` for the full
   * reasoning; in short, unreadable files are listed in full (bounded by the
   * number of assignments in the run), while invalid lines are summarized as
   * a count plus one example, because a single corrupt file could otherwise
   * contribute thousands of near-duplicate clauses.
   */
  reason?: string;
}

/** `error.code` for Node's errno exceptions, without an `any` cast. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** One event plus enough provenance to break a `ts` tie deterministically. */
interface Positioned {
  event: LoggedAgentEvent;
  /** Log filename, e.g. `lead.jsonl` — stands in for the assignment id. */
  file: string;
  /** Index within that file's line stream, in on-disk (append) order. */
  line: number;
}

/**
 * Read and merge every assignment's event log for one run.
 *
 * @param store used only for `runDir` — the actual reads are plain `fs`,
 * because the store interface has no "list every log file" operation and
 * inventing one just for this endpoint would be a wider seam than the problem
 * needs.
 */
export async function collectRunEvents(store: RunStore, runId: string): Promise<RunEventsResult> {
  const id = assertValidRunId(runId);
  const runDir = store.runDir(id);
  // Belt and braces (NFR-1): `runDir` already resolves from a validated id, but
  // routing the fixed `'logs'` segment through the same containment check as
  // every other run-relative path keeps this file from being the one place that
  // trusts a string instead of proving it.
  const logsDir = resolveWithin(runDir, 'logs');

  let entries: string[];
  try {
    const dirents = await readdir(logsDir, { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
  } catch (error) {
    // No `logs/` directory at all is a legitimate state — a run that never got
    // past planning has no assignments and therefore never appended anything.
    // That is not a degraded response, so `partial` stays false.
    if (errorCode(error) === 'ENOENT') return { events: [], partial: false };
    // Anything else (permissions, a `logs` that turned out to be a file) means
    // we cannot say what the run contains. Reporting an empty-but-partial
    // history beats throwing: NFR-8 asks for degradation, not a broken replay
    // screen, and `partial: true` tells the client not to trust the emptiness.
    //
    // `error` is bound (it previously was not) so this mode can say *why* —
    // "permission denied" and "logs turned out to be a file" (ENOTDIR) call
    // for different operator action, and folding both into a bare `true` was
    // the actual defect. Only `error.code` goes into the message: `readdir`'s
    // own error carries the full `logsDir` path in `.message`, which is
    // exactly the leak class described on `RunEventsResult.reason` above.
    const code = errorCode(error);
    return {
      events: [],
      partial: true,
      reason: `run's log directory could not be listed${code === undefined ? '' : ` (${code})`}`,
    };
  }

  const positioned: Positioned[] = [];
  let partial = false;

  // Detail behind `partial`, assembled into a `reason` string after the loop.
  // Two trackers, one per remaining failure mode (directory listing already
  // returned above; it cannot co-occur with these). `JSON.parse` failures and
  // schema-validation failures share one tracker — both mean "this line is
  // not a usable event" and an operator does not need them split further to
  // act on the message; the outer three modes (directory / file / line) are
  // what the task requires distinguishing, not sub-modes of "line".
  //
  //  - `unreadableFiles`: one entry per file that could not even be opened,
  //    each carrying that file's own `error.code`. Bounded by the number of
  //    `.jsonl` files `readdir` returned above — there are only as many log
  //    files as assignments in the run — so a full list costs nothing and is
  //    strictly more actionable than a count: an operator can go look at
  //    that specific file instead of guessing which one.
  //  - `invalidLineCount` / `invalidLineFiles` / `firstInvalidLine`: lines are
  //    NOT bounded the same way. A single truncated or corrupted file could
  //    contribute thousands of bad lines (e.g. a provider that wrote garbage
  //    in a tight loop before crashing), and a clause per line — or even a
  //    per-line list — would turn `reason` into unreadable noise during the
  //    exact incident it exists to help diagnose. So this carries: the total
  //    count (cheap, always exact, answers "how bad"); the set of files it
  //    happened in (bounded exactly like `unreadableFiles`, same reasoning);
  //    and only the *first* such line's own message, on the theory that
  //    repeated corruption in one file usually shares a single root cause (a
  //    truncated write, a schema that changed under the writer) and the
  //    first example is the one an operator would actually grep for. Carrying
  //    every message would not be strictly wrong, just strictly less useful
  //    per byte than count + first, which is the trade this function makes.
  const unreadableFiles: string[] = [];
  let invalidLineCount = 0;
  const invalidLineFiles: string[] = [];
  let firstInvalidLine: string | undefined;

  for (const filename of entries) {
    const file = path.join(logsDir, filename);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      // One assignment's log being unreadable (e.g. deleted mid-request) must
      // not take down the whole replay; the rest of the run is still real.
      //
      // `error` is bound (it previously was not) so the reason can say which
      // file and why. Only `errorCode` goes in: `readFile`'s own message
      // embeds the full absolute `file` path, which is the leak class
      // documented on `RunEventsResult.reason`; `filename` (the bare name
      // from `readdir`, not the joined `file`) is run-relative and safe.
      partial = true;
      unreadableFiles.push(`${filename} (${errorCode(error) ?? 'unknown error'})`);
      continue;
    }

    const lines = raw.split('\n');
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (line === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // Unlike `FileRunStore.readEvents`, position within the file does not
        // matter here: a killed process can only ever truncate its *last*
        // write, but merging across many files means "last line of file A" is
        // not "last line of the run". Any unparseable line is therefore
        // skipped rather than failing the request, per NFR-8 — a hole in one
        // assignment's log must not blank the whole replay.
        //
        // `error` is bound and its message (a `SyntaxError` describing where
        // in the line parsing broke, e.g. "Unexpected token o in JSON at
        // position 0") is safe to surface: it describes the line's content,
        // not a filesystem location, unlike the fs errors above.
        partial = true;
        invalidLineCount += 1;
        if (!invalidLineFiles.includes(filename)) invalidLineFiles.push(filename);
        firstInvalidLine ??=
          `${filename} line ${index + 1}: invalid JSON` +
          (error instanceof Error ? ` (${error.message})` : '');
        continue;
      }

      const result = LoggedAgentEventSchema.safeParse(parsed);
      if (!result.success) {
        partial = true;
        invalidLineCount += 1;
        if (!invalidLineFiles.includes(filename)) invalidLineFiles.push(filename);
        // Same pattern used elsewhere for a `safeParse` failure (see
        // `anthropic/provider.ts` and `claude-code/parse.ts`): the first
        // issue's own message, falling back to a generic label if zod ever
        // returns an empty issues array.
        firstInvalidLine ??=
          `${filename} line ${index + 1}: failed schema validation ` +
          `(${result.error.issues[0]?.message ?? 'no details'})`;
        continue;
      }

      positioned.push({ event: result.data, file: filename, line: index });
    }
  }

  // Tiebreak on `ts`, which collides often — the scripted provider and a fast
  // real one can both log several events inside the same millisecond.
  //
  // Chosen order: filename (i.e. assignment id) ascending, then line number
  // within that file ascending. Reasoning:
  //   - Within one assignment's log, entries are appended one at a time via
  //     `FileRunStore`'s per-path write queue (see `enqueue` in fileStore.ts),
  //     so line order *is* that assignment's true causal order even when two
  //     lines share a millisecond. Falling back to line number therefore never
  //     misorders events that actually have a knowable order.
  //   - Across assignments there is no such signal — two agents ticking in the
  //     same millisecond genuinely have no recorded ordering — so the filename
  //     is used only to make the result reproducible, not to claim a causal
  //     relationship that was never recorded. Any deterministic key would do;
  //     the filename is simply the one already at hand.
  // `Array#sort` is stable in Node (spec-guaranteed since ES2019), which is
  // what makes this last step safe rather than an additional source of
  // nondeterminism.
  positioned.sort((a, b) => {
    if (a.event.ts !== b.event.ts) return a.event.ts - b.event.ts;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  // No cap. `EVENT_BUFFER_LIMIT` bounds the *live* ring buffer because that one
  // lives in server memory for the life of the process; this endpoint reads
  // once, serialises once, and the response goes to a loopback-only client
  // (NFR-6) on the same machine that already has the `.jsonl` files on disk.
  // Silently dropping events would also directly defeat the reason this route
  // exists — replay is supposed to be the *complete* run (see `wire.ts`'s
  // `RunEventsResponseSchema` doc) — so an incomplete-but-uncapped response is
  // the honest failure mode and a truncated one is not. If a run ever produces
  // enough events for this to matter in practice, the fix is pagination, not a
  // silent cutoff here.

  // One clause per failure mode that actually occurred, joined so both can be
  // present at once (a run can have both an unreadable file *and* a corrupt
  // line in a different file in the same call). `undefined` when neither
  // tracker collected anything, i.e. exactly when `partial` is still false —
  // kept as two independent computations rather than deriving one from the
  // other so a future third mode added to this loop cannot silently desync
  // `partial` from whether `reason` gets built.
  const reasonClauses: string[] = [];
  if (unreadableFiles.length > 0) {
    reasonClauses.push(`log file(s) unreadable: ${unreadableFiles.join(', ')}`);
  }
  if (invalidLineCount > 0) {
    const lineWord = invalidLineCount === 1 ? 'line' : 'lines';
    const fileWord = invalidLineFiles.length === 1 ? 'file' : 'files';
    reasonClauses.push(
      `${invalidLineCount} log ${lineWord} skipped for invalid JSON or failed event-schema ` +
        `validation, across ${invalidLineFiles.length} ${fileWord} (${invalidLineFiles.join(', ')}); ` +
        `first: ${firstInvalidLine ?? 'no details'}`,
    );
  }
  const reason = reasonClauses.length > 0 ? reasonClauses.join('; ') : undefined;

  // `exactOptionalPropertyTypes` makes `{ reason: undefined }` a distinct
  // (and here, wrong) shape from omitting the key — see the doc comment on
  // `RunEventsResult.reason`. This spread is how every other optional field
  // in this codebase (e.g. `toAgentSummary`'s `model` in `server.ts`) gets
  // built under that setting, so it is not a one-off pattern for this file.
  return {
    events: positioned.map((p) => p.event),
    partial,
    ...(reason === undefined ? {} : { reason }),
  };
}
