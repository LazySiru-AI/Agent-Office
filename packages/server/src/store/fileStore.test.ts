import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AssignmentState, RunState } from '@agent-office/shared';
import { FileRunStore } from './fileStore.js';
import { UnsafePathError } from './types.js';

/**
 * These tests use a real temp directory rather than a mocked `fs`.
 *
 * The whole point of this store is what happens on a real filesystem —
 * rename-over-existing, mkdir races, partially written files — and a mocked
 * `fs` would only assert that we called the functions we already know we call.
 */

const FIXED_CLOCK = 1_700_000_000_000;

let tmpRoot: string;
let runsRoot: string;
let store: FileRunStore;
let warnings: string[];
let clock: number;
let idCounter: number;

function nextId(): string {
  idCounter += 1;
  return `20240102-0000${String(idCounter).padStart(2, '0')}-aaaa`;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function assignment(id: string): AssignmentState {
  return {
    id,
    phaseId: 'phase-1',
    agentName: 'security-auditor',
    objective: 'audit the auth flow',
    deliverable: `reports/01-${id}.md`,
    dependsOn: [],
    status: 'pending',
    attempts: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-store-'));
  runsRoot = path.join(tmpRoot, 'runs');
  warnings = [];
  clock = FIXED_CLOCK;
  idCounter = 0;
  store = new FileRunStore(
    runsRoot,
    () => clock,
    () => nextId(),
    (message) => {
      warnings.push(message);
    },
  );
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('FileRunStore.createRun', () => {
  it('creates the run directory tree and persists a queued run', async () => {
    const run = await store.createRun('audit the auth flow');

    expect(run.status).toBe('queued');
    expect(run.assignments).toEqual([]);
    expect(run.createdAt).toBe(FIXED_CLOCK);

    const dir = store.runDir(run.id);
    expect(await isDirectory(dir)).toBe(true);
    for (const sub of ['workspace', 'logs', 'reports']) {
      expect(await isDirectory(path.join(dir, sub))).toBe(true);
    }
    expect(await exists(path.join(dir, 'run.json'))).toBe(true);
  });

  it('round-trips through loadRun', async () => {
    const created = await store.createRun('draft the NDA review');
    const loaded = await store.loadRun(created.id);
    expect(loaded).toEqual(created);
  });

  it('rejects a run id that is not directory-safe', async () => {
    const bad = new FileRunStore(runsRoot, () => clock, () => '../escape');
    await expect(bad.createRun('x')).rejects.toBeInstanceOf(UnsafePathError);
  });
});

describe('FileRunStore.saveRun', () => {
  it('persists transitions and leaves no temp files behind', async () => {
    const run = await store.createRun('ship the parser');

    await store.saveRun({ ...run, status: 'planning' });
    await store.saveRun({ ...run, status: 'dispatching' });
    await store.saveRun({ ...run, status: 'running', assignments: [assignment('a1')] });

    const dir = store.runDir(run.id);
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries.sort()).toEqual(['logs', 'reports', 'run.json', 'workspace']);

    const reloaded = await store.loadRun(run.id);
    expect(reloaded.status).toBe('running');
    expect(reloaded.assignments).toHaveLength(1);
  });

  it('replaces the file wholesale rather than overwriting in place', async () => {
    const run = await store.createRun('shrink the state');
    const fat: RunState = {
      ...run,
      status: 'running',
      assignments: [assignment('a1'), assignment('a2'), assignment('a3')],
    };
    await store.saveRun(fat);

    // A shorter write over a longer file is where an in-place overwrite leaves a
    // trailing fragment of the previous contents and produces invalid JSON.
    await store.saveRun({ ...run, status: 'cancelled', assignments: [] });

    const raw = await readFile(path.join(store.runDir(run.id), 'run.json'), 'utf8');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    const reloaded = await store.loadRun(run.id);
    expect(reloaded.assignments).toEqual([]);
    expect(reloaded.status).toBe('cancelled');
  });

  it('stamps updatedAt from the injected clock', async () => {
    const run = await store.createRun('tick');
    clock = FIXED_CLOCK + 5_000;
    await store.saveRun({ ...run, status: 'planning' });

    const reloaded = await store.loadRun(run.id);
    expect(reloaded.createdAt).toBe(FIXED_CLOCK);
    expect(reloaded.updatedAt).toBe(FIXED_CLOCK + 5_000);
  });

  /**
   * Regression: assignments in a parallel phase each save on every transition,
   * so concurrent saves are the normal case, not an edge case. Unserialised,
   * these race onto one `run.json` — on Windows the losing `rename` fails with
   * EPERM and takes the whole run down.
   */
  it('survives concurrent saves of the same run', async () => {
    const run = await store.createRun('parallel phase');

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.saveRun({ ...run, status: 'running', assignments: [assignment(`a${i}`)] }),
      ),
    );

    const dir = store.runDir(run.id);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // Whichever save landed last, the file must be complete and re-loadable —
    // never a half-written or interleaved document.
    const reloaded = await store.loadRun(run.id);
    expect(reloaded.status).toBe('running');
    expect(reloaded.assignments).toHaveLength(1);
  });

  it('serialises concurrent saves in call order', async () => {
    const run = await store.createRun('ordered');
    const statuses = ['planning', 'dispatching', 'running'] as const;

    await Promise.all(statuses.map((status) => store.saveRun({ ...run, status })));

    // The chain preserves submission order, so the last caller wins rather than
    // whichever write happened to finish last.
    expect((await store.loadRun(run.id)).status).toBe('running');
  });
});

describe('FileRunStore.loadRun', () => {
  it('throws naming the path when run.json is absent', async () => {
    await expect(store.loadRun('20240102-000099-aaaa')).rejects.toThrow('run.json');
  });

  it('throws naming the path when run.json is not JSON', async () => {
    const run = await store.createRun('corrupt me');
    const file = path.join(store.runDir(run.id), 'run.json');
    await writeFile(file, '{ this is not json', 'utf8');

    await expect(store.loadRun(run.id)).rejects.toThrow(file);
    await expect(store.loadRun(run.id)).rejects.toThrow('not valid JSON');
  });

  it('throws when run.json is valid JSON but fails the schema', async () => {
    const run = await store.createRun('half a run');
    const file = path.join(store.runDir(run.id), 'run.json');
    await writeFile(file, JSON.stringify({ id: run.id, task: 'half a run' }), 'utf8');

    await expect(store.loadRun(run.id)).rejects.toThrow(file);
    await expect(store.loadRun(run.id)).rejects.toThrow('RunStateSchema');
  });

  it('rejects a traversing run id', async () => {
    await expect(store.loadRun('../escape')).rejects.toBeInstanceOf(UnsafePathError);
    expect(() => store.runDir('../escape')).toThrow(UnsafePathError);
  });
});

describe('FileRunStore.listRuns', () => {
  it('returns an empty list when the runs root does not exist yet', async () => {
    expect(await store.listRuns()).toEqual([]);
  });

  it('returns runs newest first', async () => {
    const first = await store.createRun('first');
    clock = FIXED_CLOCK + 1_000;
    const second = await store.createRun('second');
    clock = FIXED_CLOCK + 2_000;
    const third = await store.createRun('third');

    const listed = await store.listRuns();
    expect(listed.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
    expect(listed.map((r) => r.task)).toEqual(['third', 'second', 'first']);
    expect(listed[0]?.status).toBe('queued');
  });

  it('skips unreadable run directories with a warning rather than failing', async () => {
    const good = await store.createRun('good');

    // A directory whose name is a plausible run id but has no run.json.
    await mkdir(path.join(runsRoot, '20240101-000000-bbbb'), { recursive: true });
    // A directory whose name is not a run id at all.
    await mkdir(path.join(runsRoot, 'Not_A_Run'), { recursive: true });
    // A run whose state is corrupt.
    await mkdir(path.join(runsRoot, '20240101-000001-cccc'), { recursive: true });
    await writeFile(
      path.join(runsRoot, '20240101-000001-cccc', 'run.json'),
      '{ truncated',
      'utf8',
    );
    // A stray file, which is not a run and is ignored outright.
    await writeFile(path.join(runsRoot, 'notes.txt'), 'hello', 'utf8');

    const listed = await store.listRuns();

    expect(listed.map((r) => r.id)).toEqual([good.id]);

    // Skipping is tolerated but never silent: one warning per skipped entry.
    const skips = warnings.filter((w) => w.startsWith('skipping'));
    expect(skips).toHaveLength(3);
    expect(skips.some((w) => w.includes('Not_A_Run'))).toBe(true);
    expect(skips.some((w) => w.includes('20240101-000000-bbbb'))).toBe(true);
    expect(skips.some((w) => w.includes('20240101-000001-cccc'))).toBe(true);
  });
});

describe('FileRunStore.workspaceDir', () => {
  it('returns an absolute path inside the run directory', async () => {
    const run = await store.createRun('sandbox me');
    const workspace = await store.workspaceDir(run.id);

    expect(path.isAbsolute(workspace)).toBe(true);
    expect(workspace).toBe(path.join(store.runDir(run.id), 'workspace'));
    expect(await isDirectory(workspace)).toBe(true);
  });

  it('recreates the workspace on demand if it has been removed', async () => {
    const run = await store.createRun('sandbox me');
    const workspace = await store.workspaceDir(run.id);
    await rm(workspace, { recursive: true, force: true });
    expect(await isDirectory(workspace)).toBe(false);

    expect(await store.workspaceDir(run.id)).toBe(workspace);
    expect(await isDirectory(workspace)).toBe(true);
  });
});

describe('FileRunStore.assignmentWorkspaceDir (AO-8)', () => {
  it('creates a per-assignment, per-attempt directory nested under workspace/', async () => {
    const run = await store.createRun('isolate me');
    const dir = await store.assignmentWorkspaceDir(run.id, 'security-auditor', 1);

    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(
      path.join(store.runDir(run.id), 'workspace', 'security-auditor', 'attempt-1'),
    );
    expect(await isDirectory(dir)).toBe(true);
  });

  it('gives two assignments in the same run two different directories', async () => {
    // The AO-8 defect in one sentence: this used to be the same directory for
    // every assignment in a run. Two distinct, non-overlapping paths is the
    // whole fix, at the unit level — `dispatcher.test.ts` proves the same
    // thing end to end, by actually writing files and checking neither
    // assignment can see the other's.
    const run = await store.createRun('two agents');
    const a = await store.assignmentWorkspaceDir(run.id, 'alpha', 1);
    const b = await store.assignmentWorkspaceDir(run.id, 'beta', 1);

    expect(a).not.toBe(b);
    expect(path.relative(a, b).startsWith('..')).toBe(true);
  });

  it('gives the same assignment a different directory on each attempt, and keeps the earlier one', async () => {
    // FR-M10 re-dispatch: an assignment can run twice (original + one
    // revision). The fix decided here is "new directory per attempt, nothing
    // deleted" rather than "wipe and reuse attempt 1" — attempt 2 must not be
    // confused by whatever attempt 1 left behind, but a human debugging a bad
    // first report still wants attempt 1's workspace to exist. This test
    // pins both halves: the paths differ, and the first one is not removed
    // by asking for the second.
    const run = await store.createRun('revise me');
    const first = await store.assignmentWorkspaceDir(run.id, 'reviewer-target', 1);
    await writeFile(path.join(first, 'draft.txt'), 'attempt one output', 'utf8');

    const second = await store.assignmentWorkspaceDir(run.id, 'reviewer-target', 2);

    expect(second).not.toBe(first);
    expect(await isDirectory(first)).toBe(true);
    expect(await exists(path.join(first, 'draft.txt'))).toBe(true);
    // The second attempt's directory starts empty — not confused by what the
    // first attempt left behind.
    expect(await readdir(second)).toEqual([]);
  });

  it('rejects an assignment id that would escape workspace/ via a separator (NFR-1)', async () => {
    // Assignment ids are schema-restricted to lowercase kebab-case in
    // `shared/src/plan.ts`, which this store does not control. Defence in
    // depth, mirroring `logFile`'s own two-step check: even if that
    // restriction ever loosened, a crafted id must not be able to resolve a
    // "workspace" directory outside the run.
    const run = await store.createRun('untrusted assignment id');

    for (const bad of ['../../escape', 'sub/nested', 'a/../../../escape']) {
      await expect(store.assignmentWorkspaceDir(run.id, bad, 1)).rejects.toBeInstanceOf(
        UnsafePathError,
      );
    }
  });

  it('floors a non-positive or fractional attempt number rather than trusting it verbatim', async () => {
    // `attempt` is dispatcher-computed, not model output, so this is a floor
    // against a programming mistake rather than an adversarial input — but a
    // directory name built from a raw `attempt-${attempt}` with no floor
    // would happily produce `attempt-0` or `attempt-1.5` for one, and this
    // pins the defensive clamp instead of leaving it unexercised.
    const run = await store.createRun('clamp me');
    const zero = await store.assignmentWorkspaceDir(run.id, 'agent', 0);
    const fractional = await store.assignmentWorkspaceDir(run.id, 'agent', 1.9);

    expect(path.basename(zero)).toBe('attempt-1');
    expect(path.basename(fractional)).toBe('attempt-1');
  });
});

// FR-P1 (Must): "Individual agent reports stored as markdown, viewable
// in-app." This describe block proves the "stored as markdown" half:
// `round-trips a report` below writes real markdown (`# Findings\n\nAll
// clear.\n`) through `writeReport` and confirms both `readReport` and a
// direct read of the file on disk return it byte-for-byte, at the real path
// (`reports/<name>.md`) a run's report actually lives at. The "viewable
// in-app" half — the HTTP route that serves this same content to the UI — is
// proved in `http/server.test.ts`'s `report routes (NFR-1, FR-P1)` describe
// block, which is the more precise home for it: this file never starts an
// HTTP server, so it has no way to prove anything about what is viewable.
describe('FileRunStore reports', () => {
  it('round-trips a report', async () => {
    const run = await store.createRun('report me');
    await store.writeReport(run.id, 'reports/03-security-auditor.md', '# Findings\n\nAll clear.\n');

    expect(await store.readReport(run.id, 'reports/03-security-auditor.md')).toBe(
      '# Findings\n\nAll clear.\n',
    );
    expect(
      await readFile(
        path.join(store.runDir(run.id), 'reports', '03-security-auditor.md'),
        'utf8',
      ),
    ).toBe('# Findings\n\nAll clear.\n');
  });

  it('creates intermediate directories for a nested path', async () => {
    const run = await store.createRun('nest me');
    await store.writeReport(run.id, 'reports/appendix/a/04-notes.md', 'deep');

    expect(await store.readReport(run.id, 'reports/appendix/a/04-notes.md')).toBe('deep');
    expect(
      await isDirectory(path.join(store.runDir(run.id), 'reports', 'appendix', 'a')),
    ).toBe(true);
  });

  it('overwrites an existing report', async () => {
    const run = await store.createRun('revise me');
    await store.writeReport(run.id, 'reports/01-x.md', 'first draft, rather long');
    await store.writeReport(run.id, 'reports/01-x.md', 'short');

    expect(await store.readReport(run.id, 'reports/01-x.md')).toBe('short');
  });

  it('throws naming the path when a report is missing', async () => {
    const run = await store.createRun('missing');
    await expect(store.readReport(run.id, 'reports/nope.md')).rejects.toThrow('nope.md');
  });

  it('rejects paths that escape the run directory', async () => {
    const run = await store.createRun('untrusted deliverable');
    const escapes = [
      '../escape.md',
      '../../escape.md',
      'reports/../../escape.md',
      path.join(tmpRoot, 'escape.md'),
      'C:\\Windows\\Temp\\escape.md',
      '',
    ];

    for (const bad of escapes) {
      await expect(store.writeReport(run.id, bad, 'pwned')).rejects.toBeInstanceOf(
        UnsafePathError,
      );
      await expect(store.readReport(run.id, bad)).rejects.toBeInstanceOf(UnsafePathError);
    }

    expect(await exists(path.join(tmpRoot, 'escape.md'))).toBe(false);
    expect(await exists(path.join(runsRoot, 'escape.md'))).toBe(false);
  });

  it('rejects a path containing a NUL byte', async () => {
    const run = await store.createRun('nul byte');
    const evil = `reports/ok.md${String.fromCharCode(0)}/../../escape.md`;
    await expect(store.writeReport(run.id, evil, 'pwned')).rejects.toBeInstanceOf(
      UnsafePathError,
    );
  });
});

describe('FileRunStore event logs', () => {
  const events: AgentEvent[] = [
    { t: 'status', assignmentId: 'a1', status: 'working' },
    { t: 'text', assignmentId: 'a1', chunk: 'reading the file' },
    { t: 'tool', assignmentId: 'a1', name: 'Read', summary: 'Read src/app.ts' },
    { t: 'usage', assignmentId: 'a1', inputTokens: 120, outputTokens: 45 },
    { t: 'status', assignmentId: 'a1', status: 'done' },
  ];

  it('appends and reads back a jsonl log in order', async () => {
    const run = await store.createRun('log me');
    for (const event of events) {
      await store.appendEvent(run.id, 'a1', event);
    }

    const logged = await store.readEvents(run.id, 'a1');
    expect(logged.map((entry) => entry.event)).toEqual(events);
    expect(logged.every((entry) => entry.ts === FIXED_CLOCK)).toBe(true);

    const raw = await readFile(path.join(store.runDir(run.id), 'logs', 'a1.jsonl'), 'utf8');
    expect(raw.split('\n').filter((line) => line !== '')).toHaveLength(events.length);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('keeps concurrent appends to the same file ordered and intact', async () => {
    const run = await store.createRun('race me');
    await Promise.all(events.map((event) => store.appendEvent(run.id, 'a1', event)));

    const logged = await store.readEvents(run.id, 'a1');
    expect(logged.map((entry) => entry.event)).toEqual(events);
  });

  it('keeps each assignment in its own file', async () => {
    const run = await store.createRun('two agents');
    await store.appendEvent(run.id, 'a1', { t: 'text', assignmentId: 'a1', chunk: 'one' });
    await store.appendEvent(run.id, 'a2', { t: 'text', assignmentId: 'a2', chunk: 'two' });

    expect((await store.readEvents(run.id, 'a1')).map((e) => e.event)).toEqual([
      { t: 'text', assignmentId: 'a1', chunk: 'one' },
    ]);
    expect((await store.readEvents(run.id, 'a2')).map((e) => e.event)).toEqual([
      { t: 'text', assignmentId: 'a2', chunk: 'two' },
    ]);
  });

  it('returns an empty log for an assignment that has never emitted', async () => {
    const run = await store.createRun('quiet');
    expect(await store.readEvents(run.id, 'never-ran')).toEqual([]);
  });

  it('tolerates a truncated final line, with a warning', async () => {
    const run = await store.createRun('crash me');
    await store.appendEvent(run.id, 'a1', { t: 'text', assignmentId: 'a1', chunk: 'one' });
    await store.appendEvent(run.id, 'a1', { t: 'text', assignmentId: 'a1', chunk: 'two' });

    const file = path.join(store.runDir(run.id), 'logs', 'a1.jsonl');
    await appendFile(file, '{"ts":1700000000000,"event":{"t":"tex', 'utf8');

    const logged = await store.readEvents(run.id, 'a1');
    expect(logged.map((entry) => entry.event)).toEqual([
      { t: 'text', assignmentId: 'a1', chunk: 'one' },
      { t: 'text', assignmentId: 'a1', chunk: 'two' },
    ]);
    expect(warnings.some((w) => w.includes('truncated final line'))).toBe(true);
  });

  it('throws on a truncated line that is not the last one', async () => {
    const run = await store.createRun('mangled');
    const file = path.join(store.runDir(run.id), 'logs', 'a1.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      ['{"ts":1,"event":{"t":"tex', '{"ts":2,"event":{"t":"text","assignmentId":"a1","chunk":"ok"}}', ''].join(
        '\n',
      ),
      'utf8',
    );

    await expect(store.readEvents(run.id, 'a1')).rejects.toThrow('not valid JSON');
  });

  it('throws on a line that is valid JSON but fails the schema', async () => {
    const run = await store.createRun('bad shape');
    const file = path.join(store.runDir(run.id), 'logs', 'a1.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ ts: 1, event: { t: 'nonsense' } })}\n`, 'utf8');

    await expect(store.readEvents(run.id, 'a1')).rejects.toThrow('LoggedAgentEventSchema');
  });

  it('rejects an assignment id that would escape the logs directory', async () => {
    const run = await store.createRun('untrusted assignment id');
    const event: AgentEvent = { t: 'text', assignmentId: 'x', chunk: 'x' };

    // `..` is deliberately absent: `logs/` + `..` + `.jsonl` is the harmless
    // filename `...jsonl`, which stays inside the logs directory.
    for (const bad of ['../../escape', 'sub/a1', 'C:\\Windows\\Temp\\escape']) {
      await expect(store.appendEvent(run.id, bad, event)).rejects.toBeInstanceOf(
        UnsafePathError,
      );
      await expect(store.readEvents(run.id, bad)).rejects.toBeInstanceOf(UnsafePathError);
    }
  });
});
