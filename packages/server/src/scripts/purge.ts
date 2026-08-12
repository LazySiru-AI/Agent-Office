import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStateSchema, isRunTerminal, type RunState } from '@agent-office/shared';
import { defaultRunsRoot } from '../store/fileStore.js';
import { assertValidRunId } from '../store/util.js';

/**
 * AO-R07 remediation: `runs/<id>/` holds full model transcripts, the task
 * text, every specialist's report, and the rendered HTML/PDF, at default file
 * permissions, with nothing that ever expires them. The directory is
 * gitignored, so the exposure is local rather than a network one — but
 * "local" and "permanent" together still mean every prompt anyone has ever
 * typed into this tool sits on disk indefinitely, and most people running it
 * do not know that. This command is the fix: delete `runs/<id>/` wholesale
 * for runs whose `createdAt` is older than a caller-supplied cutoff.
 *
 *   npm run runs:purge -- --older-than 30d
 *   npm run runs:purge -- --older-than 30d --execute
 *
 * (`npm run runs:purge` is not wired up in `package.json` as part of this
 * change — that file belongs to other work in flight. Until it is,
 * `npx tsx src/scripts/purge.ts -- --older-than 30d` from `packages/server`
 * runs the same script.)
 *
 * ## Why the default is a dry run, not real deletion
 *
 * Deleting a run directory cannot be undone — there is no trash, no
 * versioning, nothing this codebase can offer instead of "the transcripts are
 * gone". Every other destructive operation in this codebase requires the
 * caller to reach for the dangerous behaviour on purpose (`git push --force`,
 * `rm -rf`, a confirmation dialog before a real delete). A retention command
 * that deletes by default and needs a flag to opt OUT would invert that at
 * exactly the moment it is most likely to be misused: someone notices how
 * much disk `runs/` has eaten, reaches for this command in a hurry, and does
 * not read the flag reference carefully before running it. Requiring
 * `--execute` to opt IN means the worst outcome of an under-read invocation
 * is a report of what *would* have been deleted, with nothing actually
 * touched — rerunnable as many times as it takes to get `--older-than` right
 * before anything irreversible happens.
 *
 * ## Why a non-terminal run is never purged, regardless of age
 *
 * This command has no way to ask "is a server process currently dispatching
 * this run" — it only ever reads `run.json` off disk, the same file the
 * dispatcher itself writes to after every transition (NFR-2). A run whose
 * `status` is not one of `TERMINAL_RUN_STATUSES` (`done`, `failed`,
 * `cancelled`) might be genuinely executing right now in a live server
 * process, or it might be a run a crashed server abandoned mid-flight and
 * never got the chance to reconcile (`RunSupervisor.reconcileCrashedRuns` in
 * `http/supervisor.ts` is what marks those `failed` on the next server
 * start — this script does not, and must not, do that job itself). Both
 * cases read identically from a `run.json` on disk, and this command treats
 * them identically: skipped, no matter how old the run id's timestamp says
 * it is. A user who wants to purge a run truly stuck non-terminal from a
 * crashed server can restart the server (which reconciles it to `failed`)
 * and purge afterwards; this command staying conservative is the price of
 * never being the thing that deleted a run mid-execution.
 */

interface CliOptions {
  runsRoot: string;
  olderThanMs: number;
  olderThanLabel: string;
  execute: boolean;
}

const USAGE = `
Usage: npm run runs:purge -- --older-than <age> [options]

Options:
  --older-than <age>   Required. Delete runs created before now minus this
                       age. A number followed by d (days), h (hours) or m
                       (minutes) — e.g. 30d, 12h, 90m.
  --runs-root <path>   Where run artifacts live (default: ${defaultRunsRoot()}).
  --execute            Actually delete. Without it (the default) this command
                       only prints what it would delete and touches nothing.
  -h, --help           Show this message.

Deletes runs/<id>/ wholesale — transcripts, reports, the workspace, the HTML
and PDF. This cannot be undone.

A run that is not in a terminal state (done, failed, cancelled) is never
deleted, no matter its age: this command has no way to tell a genuinely live
run from one merely abandoned by a crashed server, and refuses to guess.
`.trim();

const DURATION_PATTERN = /^(\d+)(d|h|m)$/i;

function parseDuration(raw: string): number {
  const match = DURATION_PATTERN.exec(raw.trim());
  if (match === null) {
    throw new Error(`--older-than must look like "30d", "12h" or "90m", got "${raw}"`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const unitMs = unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 60 * 1000;
  return amount * unitMs;
}

function parseArgs(argv: string[]): CliOptions {
  const flags = new Map<string, string>();
  let execute = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument "${arg}".\n\n${USAGE}`);
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`option ${arg} needs a value`);
    }
    flags.set(arg.slice(2), value);
    i += 1;
  }

  const olderThanRaw = flags.get('older-than');
  if (olderThanRaw === undefined) {
    // No default cutoff: a retention command that silently assumes an age
    // when the caller did not say one risks deleting more than they meant to
    // the first time they forget the flag. Forcing the choice every time is
    // cheap; guessing wrong is not.
    throw new Error(`--older-than is required.\n\n${USAGE}`);
  }

  return {
    runsRoot: path.resolve(flags.get('runs-root') ?? defaultRunsRoot()),
    olderThanMs: parseDuration(olderThanRaw),
    olderThanLabel: olderThanRaw,
    execute,
  };
}

/** Why a candidate run directory was, or was not, selected for deletion. */
export type PurgeReason = 'purge' | 'skip-live' | 'skip-too-recent' | 'skip-unreadable';

export interface PurgeCandidate {
  id: string;
  dir: string;
  /** `0` when the run's state could not be read (`reason: 'skip-unreadable'`). */
  createdAt: number;
  /** `'unknown'` when the run's state could not be read. */
  status: string;
  reason: PurgeReason;
}

export interface PurgeReport {
  runsRoot: string;
  /** Epoch ms: runs with `createdAt` before this are eligible. */
  cutoff: number;
  candidates: PurgeCandidate[];
  /** Ids actually removed. Empty unless `execute` was true. */
  deleted: string[];
  executed: boolean;
}

export interface PurgeOptions {
  runsRoot: string;
  olderThanMs: number;
  /** Defaults to `false` — see the module doc comment for why. */
  execute?: boolean;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/**
 * Select, and optionally delete, run directories older than a cutoff.
 *
 * Separated from `main()` so tests can exercise the selection and deletion
 * logic directly against a real temp directory, without going through
 * `process.argv` or `process.exit`.
 */
export async function purgeRuns(options: PurgeOptions): Promise<PurgeReport> {
  const execute = options.execute ?? false;
  const now = options.now?.() ?? Date.now();
  const cutoff = now - options.olderThanMs;
  const warn = options.onWarning ?? ((message: string) => process.stderr.write(`[runs:purge] ${message}\n`));

  const root = path.resolve(options.runsRoot);

  // Refuse a runs root that IS a filesystem root. `path.dirname` of a root is
  // the same root back (`path.dirname('/') === '/'`, `path.dirname('C:\\')
  // === 'C:\\'`), which is the standard idiom for detecting one. A typo'd or
  // misresolved `--runs-root` landing on a drive root would otherwise have
  // every top-level directory that happens to be named like a run id
  // (`assertValidRunId` below still gates that) become a deletion candidate —
  // implausible today, but this check costs nothing and an irreversible
  // delete is exactly the operation worth a belt-and-braces refusal for.
  if (path.dirname(root) === root) {
    throw new Error(`refusing to use "${root}" as the runs root: it is a filesystem root`);
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { runsRoot: root, cutoff, candidates: [], deleted: [], executed: execute };
    }
    throw new Error(`cannot list runs in ${root}: ${describeError(error)}`, { cause: error });
  }

  const candidates: PurgeCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    let id: string;
    try {
      // Same skip policy as `FileRunStore.listRuns`: a directory whose name
      // is not a valid run id is not a run and is never a deletion candidate,
      // no matter what a `--older-than` cutoff would otherwise select.
      id = assertValidRunId(entry.name);
    } catch {
      continue;
    }

    const dir = path.join(root, id);

    // Belt and braces (the same property `resolveWithin` in `store/util.ts`
    // checks, and `FileRunStore.assignmentWorkspaceDir` checks again on top
    // of it): confirm the directory this loop is about to consider deleting
    // really is a child of `root`, rather than trusting that a valid run id
    // joined onto `root` could not somehow land elsewhere. Belongs here too,
    // not only in the store — this script's safety should not depend
    // entirely on a guarantee made in a file it does not own.
    const relative = path.relative(root, dir);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }

    const run = await readRunState(dir);
    if (run === undefined) {
      warn(`skipping ${dir}: run.json is missing or unreadable — cannot confirm it is safe to delete`);
      candidates.push({ id, dir, createdAt: 0, status: 'unknown', reason: 'skip-unreadable' });
      continue;
    }

    if (!isRunTerminal(run.status)) {
      candidates.push({ id, dir, createdAt: run.createdAt, status: run.status, reason: 'skip-live' });
      continue;
    }

    if (run.createdAt >= cutoff) {
      candidates.push({ id, dir, createdAt: run.createdAt, status: run.status, reason: 'skip-too-recent' });
      continue;
    }

    candidates.push({ id, dir, createdAt: run.createdAt, status: run.status, reason: 'purge' });
  }

  const deleted: string[] = [];
  if (execute) {
    for (const candidate of candidates) {
      if (candidate.reason !== 'purge') continue;
      await rm(candidate.dir, { recursive: true, force: true });
      deleted.push(candidate.id);
    }
  }

  return { runsRoot: root, cutoff, candidates, deleted, executed: execute };
}

async function readRunState(dir: string): Promise<RunState | undefined> {
  try {
    const raw = await readFile(path.join(dir, 'run.json'), 'utf8');
    const parsed = RunStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await purgeRuns({
    runsRoot: options.runsRoot,
    olderThanMs: options.olderThanMs,
    execute: options.execute,
  });

  const toPurge = report.candidates.filter((c) => c.reason === 'purge');
  const skippedLive = report.candidates.filter((c) => c.reason === 'skip-live');
  const skippedRecent = report.candidates.filter((c) => c.reason === 'skip-too-recent');
  const skippedUnreadable = report.candidates.filter((c) => c.reason === 'skip-unreadable');

  process.stdout.write(`runs root: ${report.runsRoot}\n`);
  process.stdout.write(
    `cutoff:    runs created before ${new Date(report.cutoff).toISOString()} (older than ${options.olderThanLabel})\n`,
  );
  process.stdout.write(
    `mode:      ${options.execute ? 'EXECUTE (deleting)' : 'dry run — nothing will be deleted; pass --execute to delete'}\n\n`,
  );

  process.stdout.write(`${options.execute ? 'deleted' : 'would delete'} (${toPurge.length}):\n`);
  for (const c of toPurge) {
    process.stdout.write(`  ${c.id}  (created ${new Date(c.createdAt).toISOString()}, status ${c.status})\n`);
  }
  if (toPurge.length === 0) process.stdout.write('  (none)\n');

  if (skippedLive.length > 0) {
    process.stdout.write(`\nskipped, not in a terminal state (${skippedLive.length}):\n`);
    for (const c of skippedLive) process.stdout.write(`  ${c.id}  (status ${c.status})\n`);
  }
  if (skippedRecent.length > 0) {
    process.stdout.write(`\nskipped, newer than the cutoff (${skippedRecent.length}):\n`);
  }
  if (skippedUnreadable.length > 0) {
    process.stdout.write(`\nskipped, run.json missing or unreadable (${skippedUnreadable.length}):\n`);
    for (const c of skippedUnreadable) process.stdout.write(`  ${c.id}\n`);
  }

  process.stdout.write(`\n${report.deleted.length} run(s) deleted.\n`);
  if (!options.execute && toPurge.length > 0) {
    process.stdout.write('Re-run with --execute to actually delete these.\n');
  }
}

/**
 * Only run `main()` when this file is the process entry point.
 *
 * Every sibling script in this directory (`run.ts`, `serve.ts`, `dump.ts`)
 * calls `main().catch(...)` unconditionally at the bottom of the file, which
 * is fine for them — nothing else ever imports a CLI entrypoint. This one is
 * different: `purgeRuns` above is exported specifically so its selection and
 * deletion logic can be tested directly (`purge.test.ts`), against a real
 * temp directory, without shelling out to a subprocess. Without this guard,
 * importing this module for its exports would also execute `main()` — parsing
 * `process.argv` as if it were this script's own CLI arguments (it is
 * vitest's), and very likely throwing on a missing `--older-than`, which
 * would set `process.exitCode` for the whole test run rather than for a
 * command that was never actually invoked.
 */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nruns:purge failed.\n\n${message}\n`);
    process.exitCode = 1;
  });
}
