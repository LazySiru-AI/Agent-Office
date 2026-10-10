import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGNOSTIC_KINDS, type DiagnosticKind, type DiagnosticRecord } from '@agent-office/shared';
import { loadDotEnv } from '../env.js';
import { DiagnosticsLog } from '../diagnostics/log.js';
import { defaultRunsRoot } from '../store/fileStore.js';

/**
 * Read the cross-run diagnostics log (`runs/diagnostics.jsonl`).
 *
 * ## Grouped by default, not chronological
 *
 * The log is append-only and lossless, so the raw file is a chronological list in
 * which the same refused tool grant appears once per assignment that asked for
 * it — 114 of the 156 catalog agents request `Bash`, so on a normal week that one
 * warning is most of the file. A chronological dump would therefore bury the
 * single occurrence of something new under a hundred repeats of something known,
 * which is exactly backwards.
 *
 * So the default view groups by `kind` + `message` and sorts by count. The
 * frequency IS the finding: "17 agents wanted a shell" is a decision to make,
 * while "an agent wanted a shell" is a shrug. `--recent` gives the chronological
 * view for the times you want the other question.
 *
 * ## Why a CLI and not just the UI
 *
 * The operator reading this is asking about the deployment, not about a run, and
 * they are as likely to be at a terminal after a week away as in the browser
 * mid-run. It is also the honest place for it while the web app has no
 * cross-run view of anything — a panel would need a route, a poller and a place
 * in a layout built entirely around a single selected run.
 */

/**
 * `defaultRunsRoot()`, not `path.resolve(process.cwd(), 'runs')`.
 *
 * The cwd version was written first and was wrong in the one way that matters:
 * npm workspaces run this script with the cwd set to `packages/server`, so
 * `npm run diagnostics` looked for `packages/server/runs/diagnostics.jsonl` and
 * cheerfully reported "Nothing has been logged yet" while the real log sat at
 * the repository root with records in it. A reader that says "nothing is wrong"
 * when it is looking in the wrong place is worse than one that errors.
 *
 * `defaultRunsRoot` resolves from this module's own location instead, which is
 * why `purge.ts` already uses it — the same bug, already solved once here.
 */
const DEFAULT_RUNS_ROOT = defaultRunsRoot();

export interface Options {
  runsRoot: string;
  kinds: Set<DiagnosticKind> | undefined;
  sinceMs: number | undefined;
  runId: string | undefined;
  recent: number | undefined;
  json: boolean;
}

const USAGE = `Usage: npm run diagnostics -- [options]

Reads runs/diagnostics.jsonl — warnings, failures and agent-authored notes,
collected across every run.

Options:
  --kind <k[,k]>    Only these kinds. One or more of:
                    ${DIAGNOSTIC_KINDS.join(', ')}
  --agents          Shorthand for --kind enhancement,blocker,note (what the
                    agents themselves asked for).
  --since <dur>     Only entries newer than e.g. 24h, 7d, 30m.
  --run <id>        Only entries from one run.
  --recent [n]      Chronological instead of grouped; newest n (default 20).
  --json            Emit the matching records as JSON, for piping. Note: the
                    plain "npm run diagnostics -- --json" form still has npm's
                    own "> pkg script" banner ahead of the array on stdout —
                    that line comes from npm itself, not this script, and
                    package.json cannot suppress it. For output you can pipe
                    straight into JSON.parse, add --silent to the npm
                    invocation ("npm run diagnostics --silent -- --json") or
                    call this file directly ("npx tsx
                    src/scripts/diagnostics.ts --json").
  --runs-root <p>   Where runs/ lives (default: ${DEFAULT_RUNS_ROOT}).
  -h, --help        Show this message.`;

/**
 * Every flag this parser understands. Any `--xxx` token not in this set is a
 * typo or a stale flag name, and used to be swallowed silently: the value
 * simply landed under an unread key in `flags` and every filter behaved as
 * if the flag had never been passed. That is fine for a harmless typo like
 * `--jsno`, but the same silent-ignore behaviour on a flag that changes what
 * gets deleted (`purge.ts`'s `--drry-run`) is how a typo becomes data loss —
 * see `purge.ts`'s `parseArgs` for the sibling fix. `traceability.ts:591`
 * already throws on an unrecognised argument; this brings `diagnostics.ts`
 * in line with that rather than leaving it the odd one out.
 */
const KNOWN_FLAGS = new Set(['kind', 'agents', 'since', 'run', 'recent', 'json', 'runs-root', 'help']);

export function parseArgs(argv: readonly string[]): Options | 'help' {
  const flags = new Map<string, string | undefined>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (!KNOWN_FLAGS.has(name)) {
      throw new Error(`unexpected argument "${arg}".\n\n${USAGE}`);
    }
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? next : undefined;
    flags.set(name, value);
    if (value !== undefined) i += 1;
  }

  if (argv.includes('-h') || argv.includes('--help')) return 'help';

  const kinds = new Set<DiagnosticKind>();
  const kindFlag = flags.get('kind');
  if (kindFlag !== undefined) {
    for (const raw of kindFlag.split(',')) {
      const value = raw.trim();
      if (!isKind(value)) {
        throw new Error(`unknown --kind "${value}". Known: ${DIAGNOSTIC_KINDS.join(', ')}`);
      }
      kinds.add(value);
    }
  }
  if (flags.has('agents')) {
    kinds.add('enhancement');
    kinds.add('blocker');
    kinds.add('note');
  }

  return {
    runsRoot: path.resolve(flags.get('runs-root') ?? DEFAULT_RUNS_ROOT),
    kinds: kinds.size === 0 ? undefined : kinds,
    sinceMs: parseDuration(flags.get('since')),
    runId: flags.get('run'),
    recent: flags.has('recent') ? parseRecentCount(flags.get('recent')) : undefined,
    json: flags.has('json'),
  };
}

function isKind(value: string): value is DiagnosticKind {
  return (DIAGNOSTIC_KINDS as readonly string[]).includes(value);
}

/**
 * `--recent` on its own means "use the default of 20" (`raw === undefined`,
 * the flag was present with nothing after it); `--recent <n>` must be a
 * genuine positive whole number. Before this, `--recent abc` silently became
 * the default too — `Number('abc')` is `NaN`, and the one call site that
 * consumed it (`main`'s `Number.isFinite(parsed.recent) ... : 20` fallback)
 * quietly treated "unparseable" the same as "not supplied", the exact
 * silent-typo behaviour `--since` and `--kind` already refuse to have.
 * Validating here, at parse time, means `main` no longer needs that fallback
 * at all — see the `--recent` branch below.
 */
function parseRecentCount(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`could not read --recent "${raw}"; expected a positive whole number`);
  }
  return n;
}

/** `30m`, `24h`, `7d`. Same vocabulary as `purge.ts --older-than`, deliberately. */
function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)\s*([mhd])$/i.exec(value.trim());
  if (match === null) throw new Error(`could not read --since "${value}"; try 24h, 7d or 30m`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * ms;
}

export interface Group {
  kind: DiagnosticKind;
  message: string;
  count: number;
  agents: Set<string>;
  runs: Set<string>;
  last: number;
  sample: DiagnosticRecord;
}

export function group(records: readonly DiagnosticRecord[]): Group[] {
  const groups = new Map<string, Group>();

  for (const record of records) {
    const key = `${record.kind} ${record.message}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        kind: record.kind,
        message: record.message,
        count: 1,
        agents: new Set(record.agentName === undefined ? [] : [record.agentName]),
        // A record without a run id is process-level (an HTTP 5xx), so it
        // contributes no run rather than a placeholder one — see the printer
        // below for what an empty set is rendered as.
        runs: new Set(record.runId === undefined ? [] : [record.runId]),
        last: record.ts,
        sample: record,
      });
      continue;
    }
    existing.count += 1;
    if (record.agentName !== undefined) existing.agents.add(record.agentName);
    if (record.runId !== undefined) existing.runs.add(record.runId);
    if (record.ts > existing.last) {
      existing.last = record.ts;
      existing.sample = record;
    }
  }

  // Severity first, then frequency. An error seen twice outranks a warning seen
  // ninety times: the sort is meant to put what you should ACT on at the top,
  // and "most common" and "most important" are different questions.
  const rank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  return [...groups.values()].sort((a, b) => {
    const bySeverity = (rank[a.sample.severity] ?? 3) - (rank[b.sample.severity] ?? 3);
    return bySeverity !== 0 ? bySeverity : b.count - a.count;
  });
}

export function formatAge(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * `2026-08-14 13:14:08` in the machine's own local timezone.
 *
 * `formatAge` alone ("3d ago") is honest about relative recency but useless
 * for the question an operator asks a week later: "which server log entry
 * does this line up with, and which commit was deployed when it happened?"
 * That needs a timestamp that can be typed into a search box or compared
 * against a wall clock, which "3d ago" cannot be.
 *
 * Deliberately not `toISOString()` here: ISO is UTC, and an operator reading
 * this next to a local server log or their own clock would have to do the
 * timezone arithmetic themselves every single time. Deliberately not
 * `toLocaleString()` either — its output format depends on the reader's
 * locale and Node's ICU build, so the same record could print two different
 * ways on two machines. `sv-SE` is the well-known trick for getting
 * `Intl.DateTimeFormat` to emit `YYYY-MM-DD HH:mm:ss` — sortable,
 * unambiguous, and still in the reader's own local time — without
 * hand-rolling zero-padding.
 */
export function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString('sv-SE', { hour12: false });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  loadDotEnv(path.resolve(parsed.runsRoot, '..'));

  const log = new DiagnosticsLog({ runsRoot: parsed.runsRoot });
  const { records, skipped } = await log.read();
  const now = Date.now();

  const matching = records.filter((record) => {
    if (parsed.kinds !== undefined && !parsed.kinds.has(record.kind)) return false;
    if (parsed.runId !== undefined && record.runId !== parsed.runId) return false;
    if (parsed.sinceMs !== undefined && now - record.ts > parsed.sinceMs) return false;
    return true;
  });

  if (parsed.json) {
    // Raw epoch `ts` is kept, not replaced: it is what `--since`/sorting/every
    // downstream consumer of this record shape already keys on, and dropping
    // it would break anyone piping this into a script that expects the
    // `DiagnosticRecord` shape from `@agent-office/shared` unchanged. `tsIso`
    // is added alongside it — this is a plain object built for the JSON
    // response, not the shared `DiagnosticRecord` type itself, so widening it
    // here costs nothing and breaks no one.
    const withIso = matching.map((record) => ({ ...record, tsIso: new Date(record.ts).toISOString() }));
    process.stdout.write(`${JSON.stringify(withIso, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${log.path}\n`);
  process.stdout.write(
    `${records.length} record(s), ${matching.length} matching${
      skipped > 0 ? `, ${skipped} unparseable line(s) skipped` : ''
    }\n\n`,
  );

  if (matching.length === 0) {
    // Said plainly rather than printing an empty table: "nothing has gone wrong"
    // and "your filter matched nothing" look identical otherwise.
    process.stdout.write(
      records.length === 0
        ? 'Nothing has been logged yet.\n'
        : 'No records match those filters.\n',
    );
    return;
  }

  if (parsed.recent !== undefined) {
    // No fallback needed here the way there used to be: `parseRecentCount`
    // (in `parseArgs`) now validates `--recent`'s value eagerly, so
    // `parsed.recent` is guaranteed a positive whole number by construction —
    // an invalid one throws before `main` ever runs.
    for (const record of matching.slice(-parsed.recent).reverse()) {
      process.stdout.write(
        `${formatAge(record.ts, now).padStart(8)}  ${formatAbsolute(record.ts)}  ${record.severity.padEnd(7)} ${record.kind.padEnd(17)} ${
          record.agentName ?? '—'
        }\n            ${record.message}\n            ${
          record.runId === undefined ? 'no run (server process)' : `run ${record.runId}`
        }\n\n`,
      );
    }
    return;
  }

  for (const entry of group(matching)) {
    const agents = [...entry.agents];
    const who =
      agents.length === 0
        ? ''
        : agents.length <= 3
          ? `  [${agents.join(', ')}]`
          : `  [${agents.slice(0, 3).join(', ')} +${agents.length - 3} more]`;

    process.stdout.write(
      `${String(entry.count).padStart(4)}×  ${entry.sample.severity.padEnd(7)} ${entry.kind.padEnd(17)} ${formatAge(entry.last, now)} (${formatAbsolute(entry.last)})\n`,
    );
    process.stdout.write(`      ${entry.message}\n`);
    process.stdout.write(
      `      ${entry.runs.size === 0 ? 'no run (server process)' : `${entry.runs.size} run(s)`}${who}\n\n`,
    );
  }
}

/**
 * Make a closed downstream pipe silent instead of fatal.
 *
 * `npx tsx src/scripts/diagnostics.ts --recent 3 | Select-Object -First 1` —
 * or any `| head`-style consumer — closes its end of the pipe as soon as it
 * has what it wants. Node's default reaction to a subsequent write on
 * `process.stdout` is an unhandled `EPIPE` error, which crashes the process
 * (exit 255 in PowerShell). A closed reader is not a bug in this program: it
 * is the normal, intended way a pager says "I have enough, stop." The right
 * response is to stop writing quietly and exit 0, not to throw and look like
 * a report that broke.
 *
 * Only `EPIPE` is swallowed this way — any other write error on stdout (a
 * full disk if it were ever redirected to a file, say) still propagates and
 * fails the process, same as before this guard existed.
 */
function tolerateEpipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

/**
 * Only run `main()` (and only install the EPIPE guard) when this file is the
 * process entry point — the same guard `purge.ts` and `traceability.ts` use,
 * for the same reason: `diagnostics.test.ts` imports `parseArgs`, `group`,
 * `formatAge` and `formatAbsolute` directly to exercise them against
 * fixtures, and without this guard that import would also run `main()`
 * against vitest's own `process.argv` — parsing arguments that were never
 * meant for this script and very likely throwing on them, which would set
 * `process.exitCode` for the whole test run rather than for a CLI invocation
 * that never actually happened.
 */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  tolerateEpipe(process.stdout);
  main().catch((error: unknown) => {
    // Same `\n<command> failed.\n\n<message>\n` shape `run.ts`, `serve.ts`,
    // `purge.ts` and `traceability.ts` all use for their own top-level catch —
    // this one used to print a bare message, which read like log noise next
    // to every sibling script's clearly-labelled failure.
    process.stderr.write(`\ndiagnostics failed.\n\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
