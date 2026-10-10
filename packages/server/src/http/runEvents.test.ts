import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { API, type LoggedAgentEvent } from '@agent-office/shared';
import { FileRunStore } from '../store/fileStore.js';
import { AUTH_TOKEN_HEADER } from './authToken.js';
import { collectRunEvents } from './runEvents.js';
import { buildServer } from './server.js';
import { RunSupervisor } from './supervisor.js';
import { testProviderFactory, testRegistry } from './fixtures.js';

/**
 * `collectRunEvents`'s "unreadable file" mode is the one failure this suite
 * cannot trigger by simply arranging files on disk: by the time `readFile`
 * runs, `readdir` has already proven the entry exists and is a regular file,
 * and — verified by hand against this repo's actual Windows target — neither
 * removing a file between `readdir` and `readFile` nor holding an open
 * handle to it denies this same process a subsequent read; the OS just
 * allows it. Mocking `readFile` is the portable way to simulate "the file
 * existed a moment ago but the read itself failed" (deleted mid-request, a
 * transient disk error, a permission change by another process).
 *
 * The failure is scoped by filename suffix (`readFileFailure.suffix`, reset
 * to `undefined` after firing once) rather than "fail the very next call":
 * `collectRunEvents` is exercised here through `FileRunStore`/the real HTTP
 * route in most tests, and `loadRun` (`server.ts`) reads the run's own
 * `run.json` — also via this same `readFile` — before the route handler ever
 * reaches `collectRunEvents`. An unscoped one-shot mock fails that unrelated
 * read instead of the intended log file and turns the request into a 404,
 * which is what happened on the first pass at this test. `readdir` and every
 * other export stay real; only `readFile` is wrapped, and it still delegates
 * to the real implementation for every path that does not match, so every
 * other test in this file reads real files from disk exactly as before.
 *
 * `vi.hoisted` is required here (not just a `let` above the `vi.mock` call):
 * Vitest hoists `vi.mock` factories above the rest of the module, so a plain
 * module-level `let` would still be in its temporal dead zone when the
 * factory runs.
 */
const readFileFailure = vi.hoisted(() => ({
  suffix: undefined as string | undefined,
  code: 'EACCES',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
      const [target] = args;
      if (
        readFileFailure.suffix !== undefined &&
        typeof target === 'string' &&
        target.endsWith(readFileFailure.suffix)
      ) {
        const suffix = readFileFailure.suffix;
        readFileFailure.suffix = undefined; // one-shot once it actually matches
        return Promise.reject(
          Object.assign(new Error(`simulated read failure for ${suffix}`), {
            code: readFileFailure.code,
          }),
        );
      }
      return actual.readFile(...args);
    }),
  };
});

/** Not a real secret — a fixed value so these tests need not care what it is. */
const TEST_TOKEN = 'test-suite-token-not-a-real-secret';

/**
 * `GET /api/runs/:id/events` (NFR-7 replay).
 *
 * Uses a real `FileRunStore` on a temp directory rather than `MemoryRunStore`
 * (which `server.test.ts` uses everywhere else): this endpoint's whole job is
 * reading `.jsonl` files off disk, so the thing under test does not exist
 * unless the files really are on disk.
 */

let tmpRoot: string;
let runsRoot: string;
let store: FileRunStore;
const started: Array<{ app: FastifyInstance; supervisor: RunSupervisor }> = [];

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-run-events-'));
  runsRoot = path.join(tmpRoot, 'runs');
  store = new FileRunStore(runsRoot);
});

afterEach(async () => {
  for (const { app, supervisor } of started.splice(0)) {
    await supervisor.shutdown();
    await app.close();
  }
  await rm(tmpRoot, { recursive: true, force: true });
  // Guard against a test that set this up but failed before the mocked
  // `readFile` call actually fired (which is what normally clears it) —
  // otherwise the *next* test's unrelated reads could be poisoned by a
  // leftover suffix.
  readFileFailure.suffix = undefined;
});

async function setup(): Promise<{ app: FastifyInstance; supervisor: RunSupervisor }> {
  const registry = testRegistry();
  const supervisor = new RunSupervisor({
    registry,
    store,
    makeProvider: testProviderFactory(),
    onWarning: () => undefined,
  });
  const app = await buildServer({ registry, store, supervisor, token: TEST_TOKEN });
  await app.ready();
  // AO-6 put a token in front of every `/api` route. These tests are about the
  // event-log route's own behaviour, so rather than adding the header to each
  // of the ~8 `.inject()` calls below — a mechanical change that would make
  // every one of them slightly less about what it is testing — the token is
  // attached once here, at the seam.
  const rawInject = app.inject.bind(app);
  app.inject = ((optsOrUrl: InjectOptions | string) => {
    const options: InjectOptions = typeof optsOrUrl === 'string' ? { url: optsOrUrl } : optsOrUrl;
    return rawInject({
      ...options,
      headers: { [AUTH_TOKEN_HEADER]: TEST_TOKEN, ...options.headers },
    });
  }) as unknown as FastifyInstance['inject'];

  started.push({ app, supervisor });
  return { app, supervisor };
}

/** Every error body must be `{ error: string }`, matching the rest of the API. */
function expectApiError(body: string): string {
  const parsed: unknown = JSON.parse(body);
  expect(parsed).toHaveProperty('error');
  const { error } = parsed as { error: unknown };
  expect(typeof error).toBe('string');
  return String(error);
}

function loggedLine(ts: number, assignmentId: string, chunk: string): string {
  const entry: LoggedAgentEvent = {
    ts,
    event: { t: 'text', assignmentId, chunk },
  };
  return `${JSON.stringify(entry)}\n`;
}

/** Create a bare run directory (no assignments in `run.json`) with a `logs/` dir. */
async function createBareRun(): Promise<string> {
  const run = await store.createRun('replay fixture');
  return run.id;
}

function logsDir(runId: string): string {
  return path.join(store.runDir(runId), 'logs');
}

describe('GET /api/runs/:id/events', () => {
  it('merges multiple assignment log files into one ts-ordered stream', async () => {
    const { app } = await setup();
    const runId = await createBareRun();

    await writeFile(
      path.join(logsDir(runId), 'lead.jsonl'),
      loggedLine(3_000, 'lead', 'third') + loggedLine(1_000, 'lead', 'first'),
      'utf8',
    );
    await writeFile(
      path.join(logsDir(runId), 'review.jsonl'),
      loggedLine(2_000, 'review', 'second'),
      'utf8',
    );

    const response = await app.inject({ method: 'GET', url: API.runEvents(runId) });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { runId: string; events: LoggedAgentEvent[]; partial: boolean };
    expect(body.runId).toBe(runId);
    expect(body.partial).toBe(false);
    expect(body.events.map((e) => (e.event.t === 'text' ? e.event.chunk : undefined))).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('skips a malformed line and a truncated final line, marks partial, keeps the rest', async () => {
    const { app } = await setup();
    const runId = await createBareRun();

    const content =
      loggedLine(1_000, 'lead', 'ok-1') +
      'not json at all\n' +
      loggedLine(2_000, 'lead', 'ok-2') +
      '{"ts": 3000, "event": {"t": "text", "assignmentId": "lead", "chunk": "cut off';
    await writeFile(path.join(logsDir(runId), 'lead.jsonl'), content, 'utf8');

    const response = await app.inject({ method: 'GET', url: API.runEvents(runId) });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { events: LoggedAgentEvent[]; partial: boolean };
    expect(body.partial).toBe(true);
    expect(body.events.map((e) => (e.event.t === 'text' ? e.event.chunk : undefined))).toEqual([
      'ok-1',
      'ok-2',
    ]);
  });

  it('returns an empty array without erroring for a run with no logs directory', async () => {
    // A run that failed during planning never gets past `createRun`'s
    // subdirectory creation... so simulate the case that actually differs:
    // the `logs/` subdirectory removed after the fact (e.g. a run whose
    // directory tree predates `RUN_SUBDIRS` including it).
    const { app } = await setup();
    const runId = await createBareRun();
    await rm(logsDir(runId), { recursive: true, force: true });

    const response = await app.inject({ method: 'GET', url: API.runEvents(runId) });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { events: LoggedAgentEvent[]; partial: boolean };
    expect(body.events).toEqual([]);
    expect(body.partial).toBe(false);
  });

  it('returns 404 with the standard error shape for an unknown run id', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: API.runEvents('20260101-000000-zzzz') });

    expect(response.statusCode).toBe(404);
    expectApiError(response.body);
  });

  it('rejects a run id attempting path traversal', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/api/runs/..%2F..%2Fetc/events' });

    expect(response.statusCode).toBe(400);
    expectApiError(response.body);
  });

  it('returns a stable order across repeated calls when timestamps tie', async () => {
    const { app } = await setup();
    const runId = await createBareRun();

    // Same millisecond on purpose, across two different assignment logs, so the
    // only thing deciding order is the documented tiebreak (filename, then
    // in-file line position) rather than filesystem read order.
    await writeFile(
      path.join(logsDir(runId), 'alpha.jsonl'),
      loggedLine(5_000, 'alpha', 'a-1') + loggedLine(5_000, 'alpha', 'a-2'),
      'utf8',
    );
    await writeFile(path.join(logsDir(runId), 'beta.jsonl'), loggedLine(5_000, 'beta', 'b-1'), 'utf8');

    const first = await app.inject({ method: 'GET', url: API.runEvents(runId) });
    const second = await app.inject({ method: 'GET', url: API.runEvents(runId) });

    const chunksOf = (body: string): unknown[] =>
      (JSON.parse(body) as { events: LoggedAgentEvent[] }).events.map((e) =>
        e.event.t === 'text' ? e.event.chunk : undefined,
      );

    const expected = ['a-1', 'a-2', 'b-1'];
    expect(chunksOf(first.body)).toEqual(expected);
    expect(chunksOf(second.body)).toEqual(expected);
  });

  // -------------------------------------------------------------------------
  // `reason` — the three failure modes `collectRunEvents` must tell apart.
  // -------------------------------------------------------------------------

  // These three call `collectRunEvents` directly rather than through
  // `app.inject`/the HTTP route: `server.ts` (out of scope for this change —
  // owned by another worker) still destructures only `{ events, partial }`
  // out of the result and does not forward `reason` into the response body.
  // That is expected and does not indicate a problem with `collectRunEvents`
  // itself — it is exactly the "wiring is mechanical, and someone else does
  // it" split described for this task. Testing at the HTTP layer here would
  // only prove `server.ts` hasn't been wired yet, which is already known;
  // testing `collectRunEvents` directly proves the actual new surface works.

  it('reports a non-ENOENT directory-listing failure with a distinguishing reason and no absolute path', async () => {
    const runId = await createBareRun();
    await rm(logsDir(runId), { recursive: true, force: true });
    // A `logs` path that exists but is a FILE (not merely absent) makes
    // `readdir` fail with ENOTDIR rather than ENOENT. The "run just has not
    // logged anything yet" case (ENOENT, not degraded) is already covered by
    // 'returns an empty array without erroring for a run with no logs
    // directory' above; this exercises the other branch of that same catch —
    // the one that must produce `partial: true` plus a reason.
    await writeFile(logsDir(runId), 'not a directory', 'utf8');

    const result = await collectRunEvents(store, runId);

    expect(result.events).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.reason).toBeDefined();
    // Names the mode ("could not be listed") distinctly from the other two
    // modes' wording (checked in the sibling tests below), and carries the
    // errno code for an operator without echoing Node's own message, which
    // would have embedded the absolute `logs` path.
    expect(result.reason).toContain('could not be listed');
    expect(result.reason).toContain('ENOTDIR');
    expect(result.reason).not.toContain(tmpRoot);
    expect(result.reason).not.toContain(runsRoot);
  });

  it('reports an unreadable log file with a distinguishing reason and no absolute path', async () => {
    const runId = await createBareRun();
    await writeFile(
      path.join(logsDir(runId), 'review.jsonl'),
      loggedLine(1_000, 'review', 'unreachable'),
      'utf8',
    );
    // Scoped to this one filename (see the mock's doc comment at the top of
    // this file) so it fails only the read this test cares about.
    readFileFailure.suffix = 'review.jsonl';
    readFileFailure.code = 'EACCES';

    const result = await collectRunEvents(store, runId);

    expect(result.events).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('unreadable');
    expect(result.reason).toContain('review.jsonl');
    expect(result.reason).toContain('EACCES');
    // Not the directory-listing mode's wording.
    expect(result.reason).not.toContain('could not be listed');
    expect(result.reason).not.toContain(tmpRoot);
    expect(result.reason).not.toContain(runsRoot);
    // The mock fired and cleared itself; nothing left over for later tests.
    expect(readFileFailure.suffix).toBeUndefined();
  });

  it('reports an invalid line (bad JSON or failed schema) with a distinguishing reason and no absolute path', async () => {
    const runId = await createBareRun();

    const content =
      loggedLine(1_000, 'lead', 'ok-1') +
      'not json at all\n' +
      // Valid JSON, but `t: 'text'` requires `chunk` — a schema failure
      // rather than a `JSON.parse` failure, so this line also exercises the
      // `safeParse` branch of the same "invalid line" mode.
      `${JSON.stringify({ ts: 2_000, event: { t: 'text', assignmentId: 'lead' } })}\n`;
    await writeFile(path.join(logsDir(runId), 'lead.jsonl'), content, 'utf8');

    const result = await collectRunEvents(store, runId);

    expect(result.partial).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('skipped');
    expect(result.reason).toContain('lead.jsonl');
    // Two bad lines in one file: the count says so without listing each one.
    expect(result.reason).toContain('2 log lines');
    // Not the other two modes' wording.
    expect(result.reason).not.toContain('could not be listed');
    expect(result.reason).not.toContain('unreadable');
    expect(result.reason).not.toContain(tmpRoot);
    expect(result.reason).not.toContain(runsRoot);
  });
});
