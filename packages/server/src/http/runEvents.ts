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
    return { events: [], partial: true };
  }

  const positioned: Positioned[] = [];
  let partial = false;

  for (const filename of entries) {
    const file = path.join(logsDir, filename);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      // One assignment's log being unreadable (e.g. deleted mid-request) must
      // not take down the whole replay; the rest of the run is still real.
      partial = true;
      continue;
    }

    const lines = raw.split('\n');
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (line === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Unlike `FileRunStore.readEvents`, position within the file does not
        // matter here: a killed process can only ever truncate its *last*
        // write, but merging across many files means "last line of file A" is
        // not "last line of the run". Any unparseable line is therefore
        // skipped rather than failing the request, per NFR-8 — a hole in one
        // assignment's log must not blank the whole replay.
        partial = true;
        continue;
      }

      const result = LoggedAgentEventSchema.safeParse(parsed);
      if (!result.success) {
        partial = true;
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
  return { events: positioned.map((p) => p.event), partial };
}
