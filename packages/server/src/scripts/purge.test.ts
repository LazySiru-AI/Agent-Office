import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunState } from '@agent-office/shared';
import { FileRunStore } from '../store/fileStore.js';
import { purgeRuns } from './purge.js';

/**
 * These tests exercise `purgeRuns` directly, against a real temp directory —
 * `main()` (argv parsing, stdout reporting) is deliberately not under test
 * here, matching `fileStore.test.ts`'s own preference for the real filesystem
 * over a mock: the property this command has to get right is "which real
 * directories get deleted", and a mocked `fs` would only confirm we called
 * the functions we already know we call.
 */

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let runsRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-purge-'));
  runsRoot = path.join(tmpRoot, 'runs');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Create a fixture run with a specific age and status, via the real store. */
async function makeRun(status: RunState['status'], ageMs: number): Promise<string> {
  const store = new FileRunStore(runsRoot);
  const run = await store.createRun(`probe run, ${status}, ${ageMs}ms old`);
  await store.saveRun({ ...run, status, createdAt: NOW - ageMs });
  return run.id;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('purgeRuns — selection by age', () => {
  it('selects only runs created before the cutoff, and leaves newer ones alone', async () => {
    // The core promise of `--older-than`: an off-by-one here either purges
    // data a user explicitly wanted kept (cutoff too permissive) or leaves
    // the disk growth this command exists to bound (cutoff too strict).
    const old = await makeRun('done', 40 * DAY_MS);
    const recent = await makeRun('done', 20 * DAY_MS);
    const veryRecent = await makeRun('done', 1 * DAY_MS);

    const report = await purgeRuns({
      runsRoot,
      olderThanMs: 30 * DAY_MS,
      now: () => NOW,
    });

    const reasonFor = (id: string) => report.candidates.find((c) => c.id === id)?.reason;
    expect(reasonFor(old)).toBe('purge');
    expect(reasonFor(recent)).toBe('skip-too-recent');
    expect(reasonFor(veryRecent)).toBe('skip-too-recent');
  });

  it('treats a run exactly at the cutoff as too recent, not eligible', async () => {
    // Pins the boundary as `createdAt >= cutoff` (skip), not `>` (purge) —
    // otherwise "older than 30 days" would quietly include a run exactly 30
    // days old, which is not what the flag name says.
    const atCutoff = await makeRun('done', 30 * DAY_MS);

    const report = await purgeRuns({ runsRoot, olderThanMs: 30 * DAY_MS, now: () => NOW });

    expect(report.candidates.find((c) => c.id === atCutoff)?.reason).toBe('skip-too-recent');
  });
});

describe('purgeRuns — dry run is the default', () => {
  it('deletes nothing when `execute` is omitted, even for eligible runs', async () => {
    // MAJOR: if this ever deletes without an explicit `execute: true`, the
    // very first `npm run runs:purge -- --older-than 30d` anyone runs to see
    // what a cutoff would catch destroys data instead of reporting on it.
    const old = await makeRun('done', 90 * DAY_MS);
    const dir = path.join(runsRoot, old);

    const report = await purgeRuns({ runsRoot, olderThanMs: 30 * DAY_MS, now: () => NOW });

    expect(report.executed).toBe(false);
    expect(report.deleted).toEqual([]);
    expect(report.candidates.find((c) => c.id === old)?.reason).toBe('purge');
    expect(await exists(dir)).toBe(true);
    expect(await exists(path.join(dir, 'run.json'))).toBe(true);
  });

  it('deletes exactly the eligible runs, and only them, when `execute: true`', async () => {
    const old = await makeRun('done', 90 * DAY_MS);
    const recent = await makeRun('done', 1 * DAY_MS);

    const report = await purgeRuns({
      runsRoot,
      olderThanMs: 30 * DAY_MS,
      execute: true,
      now: () => NOW,
    });

    expect(report.executed).toBe(true);
    expect(report.deleted).toEqual([old]);
    expect(await exists(path.join(runsRoot, old))).toBe(false);
    expect(await exists(path.join(runsRoot, recent))).toBe(true);
  });
});

describe('purgeRuns — never touches a non-terminal run', () => {
  it('skips a run whose status is not done/failed/cancelled, regardless of age, even with execute: true', async () => {
    // The one guarantee that matters most: this command cannot tell a run a
    // live server process is still dispatching apart from one a crashed
    // server abandoned mid-flight — both just read `status: 'running'` off
    // disk. Treating every non-terminal status as "do not touch" is what
    // keeps an in-progress run's transcript from disappearing out from under
    // it. `90 * DAY_MS` is deliberately far past the cutoff — age must not be
    // able to override this.
    const live = await makeRun('running', 90 * DAY_MS);

    const report = await purgeRuns({
      runsRoot,
      olderThanMs: 30 * DAY_MS,
      execute: true,
      now: () => NOW,
    });

    expect(report.candidates.find((c) => c.id === live)?.reason).toBe('skip-live');
    expect(report.deleted).not.toContain(live);
    expect(await exists(path.join(runsRoot, live))).toBe(true);
  });

  it('skips every non-terminal status, not only "running"', async () => {
    const statuses: RunState['status'][] = [
      'queued',
      'planning',
      'awaiting_approval',
      'dispatching',
      'synthesizing',
      'designing',
      'report_ready',
    ];
    const ids = await Promise.all(statuses.map((status) => makeRun(status, 90 * DAY_MS)));

    const report = await purgeRuns({
      runsRoot,
      olderThanMs: 30 * DAY_MS,
      execute: true,
      now: () => NOW,
    });

    for (const id of ids) {
      expect(report.candidates.find((c) => c.id === id)?.reason).toBe('skip-live');
    }
    expect(report.deleted).toEqual([]);
  });
});

describe('purgeRuns — containment (refuses to touch outside the runs root)', () => {
  it('refuses a runs root that is itself a filesystem root', async () => {
    // A misresolved `--runs-root` landing on a drive root is the one
    // misconfiguration this command should refuse outright rather than
    // attempt — "iterate everything at the top of a disk looking for
    // deletion candidates" is not a posture an irreversible-delete command
    // should ever be in, even though the run-id check would likely save it
    // in practice.
    const root = path.parse(tmpRoot).root;

    await expect(purgeRuns({ runsRoot: root, olderThanMs: DAY_MS, now: () => NOW })).rejects.toThrow(
      'filesystem root',
    );
  });

  it('ignores directories that are not valid run ids, and never deletes them', async () => {
    // Mirrors `FileRunStore.listRuns`'s own skip policy: something living
    // next to real runs in the runs root — a stray file, a misnamed folder —
    // must never become a deletion candidate just because it is old.
    const old = await makeRun('done', 90 * DAY_MS);
    await mkdir(path.join(runsRoot, 'Not_A_Run_Id'), { recursive: true });
    await writeFile(path.join(runsRoot, 'notes.txt'), 'hello', 'utf8');

    const report = await purgeRuns({
      runsRoot,
      olderThanMs: 30 * DAY_MS,
      execute: true,
      now: () => NOW,
    });

    expect(report.candidates.map((c) => c.id)).toEqual([old]);
    expect(await exists(path.join(runsRoot, 'Not_A_Run_Id'))).toBe(true);
    expect(await exists(path.join(runsRoot, 'notes.txt'))).toBe(true);
  });
});

describe('purgeRuns — unreadable state', () => {
  it('skips a run whose run.json is missing or corrupt, rather than guessing it is safe to delete', async () => {
    // The same "cannot confirm, so refuse" posture as the live-run check,
    // applied to the case where there is no state to even read: a run
    // directory whose `run.json` was itself lost to a crash is exactly the
    // kind of thing an operator would want preserved for inspection, not
    // silently swept away because it happened to be old.
    const runId = '20240102-000000-aaaa';
    await mkdir(path.join(runsRoot, runId), { recursive: true });
    await writeFile(path.join(runsRoot, runId, 'run.json'), '{ not json', 'utf8');

    const report = await purgeRuns({
      runsRoot,
      olderThanMs: 0,
      execute: true,
      now: () => NOW,
    });

    expect(report.candidates.find((c) => c.id === runId)?.reason).toBe('skip-unreadable');
    expect(await exists(path.join(runsRoot, runId))).toBe(true);
  });
});

describe('purgeRuns — no runs root yet', () => {
  it('reports an empty, successful run rather than throwing when runs/ does not exist', async () => {
    const report = await purgeRuns({ runsRoot, olderThanMs: DAY_MS, now: () => NOW });
    expect(report.candidates).toEqual([]);
    expect(report.deleted).toEqual([]);
  });
});
