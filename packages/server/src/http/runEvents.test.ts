import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API, type LoggedAgentEvent } from '@agent-office/shared';
import { FileRunStore } from '../store/fileStore.js';
import { buildServer } from './server.js';
import { RunSupervisor } from './supervisor.js';
import { testProviderFactory, testRegistry } from './fixtures.js';

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
});

async function setup(): Promise<{ app: FastifyInstance; supervisor: RunSupervisor }> {
  const registry = testRegistry();
  const supervisor = new RunSupervisor({
    registry,
    store,
    makeProvider: testProviderFactory(),
    onWarning: () => undefined,
  });
  const app = await buildServer({ registry, store, supervisor });
  await app.ready();

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
});
