import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API, ServerMessageSchema, type ServerMessage } from '@agent-office/shared';
import { MemoryRunStore } from '../store/memoryStore.js';
import type { RunStore } from '../store/types.js';
import { buildServer } from './server.js';
import { RunSupervisor } from './supervisor.js';
import {
  TEST_SYNTHESIS,
  testProviderFactory,
  testRegistry,
  waitFor,
  waitForTerminal,
} from './fixtures.js';

/**
 * Route-level tests, driven through Fastify's `.inject()` so no port is bound
 * and no run of these tests can accidentally satisfy NFR-6 by luck.
 *
 * The recurring theme is that the client is never trusted: a bad body, a run id
 * that is really a path traversal, a report path pointing outside the run
 * directory. Each of those has to fail as a 400 with the contract's error shape,
 * not as a stack trace or a 500.
 */

const started: Array<{ app: FastifyInstance; supervisor: RunSupervisor }> = [];

afterEach(async () => {
  // Runs that hang on purpose would otherwise keep vitest's process alive.
  for (const { app, supervisor } of started.splice(0)) {
    await supervisor.shutdown();
    await app.close();
  }
});

async function setup(
  overrides: Parameters<typeof testProviderFactory>[0] = {},
): Promise<{ app: FastifyInstance; supervisor: RunSupervisor; store: RunStore }> {
  const registry = testRegistry();
  const store = new MemoryRunStore();
  const supervisor = new RunSupervisor({
    registry,
    store,
    makeProvider: testProviderFactory(overrides),
    onWarning: () => undefined,
  });
  const app = await buildServer({ registry, store, supervisor });
  await app.ready();

  started.push({ app, supervisor });
  return { app, supervisor, store };
}

/** Every error body must be `{ error: string }`, whatever produced it. */
function expectApiError(body: string): string {
  const parsed: unknown = JSON.parse(body);
  expect(parsed).toHaveProperty('error');
  const { error } = parsed as { error: unknown };
  expect(typeof error).toBe('string');
  return String(error);
}

describe('GET /api/health', () => {
  it('answers without touching the store, so it works as a readiness probe', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: API.health() });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, liveRunIds: [] });
  });
});

describe('GET /api/agents', () => {
  it('returns the roster without the system prompts', async () => {
    // The prompts are the bulk of every agent file and nothing in the UI renders
    // them; shipping them would multiply this response's size for nothing.
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: API.agents() });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { agents: Array<Record<string, unknown>> };
    expect(body.agents.length).toBeGreaterThan(0);
    expect(body.agents[0]).toHaveProperty('description');
    expect(body.agents[0]).not.toHaveProperty('systemPrompt');
  });
});

describe('POST /api/runs', () => {
  it('creates a run that reaches done with every assignment in the plan', async () => {
    const { app, supervisor } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });

    expect(response.statusCode).toBe(201);
    const { runId } = JSON.parse(response.body) as { runId: string };
    expect(runId).toBeTruthy();

    const run = await waitForTerminal(supervisor, runId);
    expect(run.status).toBe('done');
    expect(run.assignments).toHaveLength(3);
  });

  it('answers while the run is still executing', async () => {
    // The scripted provider finishes a whole run in milliseconds, so proving
    // this needs an assignment that never returns: the response must come back
    // regardless. A route that awaited the pipeline would hang here forever.
    const { app, supervisor } = await setup({ lead: { hang: true } });

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });

    expect(response.statusCode).toBe(201);
    const { runId } = JSON.parse(response.body) as { runId: string };
    expect(supervisor.liveRunIds()).toContain(runId);
  });

  it('rejects a body the contract does not accept', async () => {
    // `task` is required and non-empty. Without this check an empty task would
    // reach the Manager and produce a plan for nothing.
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: '', concurrency: 999 },
    });

    expect(response.statusCode).toBe(400);
    expect(expectApiError(response.body)).toMatch(/invalid request body/);
  });

  it('rejects a body that is not JSON at all, in the contract error shape', async () => {
    // Fastify's own parse error would otherwise be sent as
    // `{ statusCode, error, message }`, which the client has no case for.
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });

    expect(response.statusCode).toBe(400);
    expectApiError(response.body);
  });

  it('rejects an unknown provider as a client error, not a server fault', async () => {
    const registry = testRegistry();
    const store = new MemoryRunStore();
    const supervisor = new RunSupervisor({ registry, store, onWarning: () => undefined });
    const app = await buildServer({ registry, store, supervisor });
    await app.ready();
    started.push({ app, supervisor });

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.', provider: 'gpt-9' },
    });

    expect(response.statusCode).toBe(400);
    expect(expectApiError(response.body)).toMatch(/unknown provider/);
  });
});

describe('GET /api/runs and /api/runs/:runId', () => {
  it('lists runs with the live flag the contract asks for', async () => {
    const { app, supervisor } = await setup({ lead: { hang: true } });

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };

    const response = await app.inject({ method: 'GET', url: API.runs() });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { runs: Array<{ id: string; live: boolean }> };
    expect(body.runs.find((run) => run.id === runId)?.live).toBe(true);
  });

  it('returns 404 for a run id that is well formed but unknown', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: API.run('20260101-000000-zzzz') });

    expect(response.statusCode).toBe(404);
    expectApiError(response.body);
  });

  it('returns 400 for a run id that would escape the runs directory', async () => {
    // Run ids become directory names. Anything outside the id alphabet is
    // refused before it reaches the store (NFR-1).
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/api/runs/..%2F..%2Fetc' });

    expect(response.statusCode).toBe(400);
    expectApiError(response.body);
  });
});

describe('POST /api/runs/:runId/cancel (FR-M9)', () => {
  it('cancels a run that is executing here', async () => {
    const { app, supervisor } = await setup({ lead: { hang: true } });

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitFor(() => supervisor.isLive(runId), 'the run to be live');

    const response = await app.inject({ method: 'POST', url: API.cancelRun(runId) });

    expect(response.statusCode).toBe(200);
    const run = await waitForTerminal(supervisor, runId);
    expect(run.status).toBe('cancelled');
  });

  it('returns 409 for a run that has already finished', async () => {
    // Not a 404: the run exists, it just cannot be stopped. Reporting success
    // would leave the UI showing a cancel that never happened.
    const { app, supervisor } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitForTerminal(supervisor, runId);

    const response = await app.inject({ method: 'POST', url: API.cancelRun(runId) });

    expect(response.statusCode).toBe(409);
    expect(expectApiError(response.body)).toMatch(/already finished/);
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'POST', url: API.cancelRun('20260101-000000-zzzz') });

    expect(response.statusCode).toBe(404);
  });

  it('accepts a bodyless POST whatever content type the client attached', async () => {
    // Cancel carries no body, and clients disagree about what to send for that:
    // `fetch` sends no content type, curl and PowerShell send
    // `application/x-www-form-urlencoded`. Fastify's default is a 415 whose body
    // is not the contract's error shape either.
    const { app, supervisor } = await setup({ lead: { hang: true } });

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitFor(() => supervisor.isLive(runId), 'the run to be live');

    const response = await app.inject({
      method: 'POST',
      url: API.cancelRun(runId),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('report routes (NFR-1)', () => {
  it('serves the synthesis once the run has written one', async () => {
    const { app, supervisor } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitForTerminal(supervisor, runId);

    const response = await app.inject({ method: 'GET', url: API.runReport(runId) });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { path: string; markdown: string };
    expect(body.path).toBe('report.md');
    expect(body.markdown).toContain(TEST_SYNTHESIS.split('\n')[0]);
  });

  it('returns 404 while the run has no synthesis yet', async () => {
    const { app } = await setup({ lead: { hang: true } });

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };

    const response = await app.inject({ method: 'GET', url: API.runReport(runId) });

    expect(response.statusCode).toBe(404);
    expect(expectApiError(response.body)).toMatch(/no synthesis report/);
  });

  it('serves one assignment report by its run-relative path', async () => {
    const { app, supervisor } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitForTerminal(supervisor, runId);

    const response = await app.inject({
      method: 'GET',
      url: API.assignmentReport(runId, 'reports/01-alpha.md'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { path: string; markdown: string };
    expect(body.path).toBe('reports/01-alpha.md');
    expect(body.markdown).toContain('Findings');
  });

  it('refuses a report path that climbs out of the run directory', async () => {
    // The path in a real request comes from the Manager's LLM-generated
    // `deliverable` field, so it is treated as hostile. The store performs the
    // containment check; this proves the route actually routes through it.
    const { app, supervisor } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitForTerminal(supervisor, runId);

    const response = await app.inject({
      method: 'GET',
      url: API.assignmentReport(runId, '../../../../etc/passwd'),
    });

    expect(response.statusCode).toBe(400);
    expect(expectApiError(response.body)).toMatch(/escapes the run directory/);
  });

  it('returns 404 for a report path that is safe but absent', async () => {
    const { app, supervisor } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitForTerminal(supervisor, runId);

    const response = await app.inject({
      method: 'GET',
      url: API.assignmentReport(runId, 'reports/99-nobody.md'),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('cross-origin access', () => {
  it('allows a loopback dev origin, because the Vite server has its own port', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { origin: 'http://localhost:5173' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('refuses to name a non-loopback origin', async () => {
    // There is no authentication anywhere in this application (NFR-6). Echoing
    // an arbitrary origin would let any page the user visits drive the API.
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the preflight, which the not-found handler would otherwise reject', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'OPTIONS',
      url: API.runs(),
      headers: { origin: 'http://127.0.0.1:5173' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('unknown routes', () => {
  it('answers with the contract error shape rather than Fastify default', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expectApiError(response.body);
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** The slice of the injected `ws` client these tests use; `ws` ships no types. */
interface TestSocket {
  send(data: string): void;
  close(): void;
  on(event: 'message', listener: (data: unknown) => void): void;
}

/**
 * Open a socket with its message collector already attached.
 *
 * The listener goes on in `onInit`, before the handshake completes: the server
 * sends `hello` the instant the route handler runs, so attaching after
 * `injectWS` resolves is a race that loses the greeting.
 *
 * Messages are parsed through the contract's own schema, so a server message the
 * client could not have handled fails here rather than in the browser.
 */
async function openSocket(
  app: FastifyInstance,
): Promise<{ socket: TestSocket; messages: ServerMessage[] }> {
  const messages: ServerMessage[] = [];
  const socket = (await app.injectWS(API.socket(), undefined, {
    onInit: (ws: TestSocket) => {
      ws.on('message', (raw: unknown) => {
        messages.push(ServerMessageSchema.parse(JSON.parse(String(raw))));
      });
    },
  })) as unknown as TestSocket;

  return { socket, messages };
}

describe('WebSocket /ws', () => {
  it('greets a new connection with hello and the current run list', async () => {
    const { app } = await setup();
    const { socket, messages } = await openSocket(app);

    await waitFor(() => messages.some((message) => message.t === 'hello'), 'the hello message');
    await waitFor(() => messages.some((message) => message.t === 'runs'), 'the run list');

    socket.close();
  });

  it('answers ping with pong', async () => {
    const { app } = await setup();
    const { socket, messages } = await openSocket(app);

    socket.send(JSON.stringify({ t: 'ping' }));

    await waitFor(() => messages.some((message) => message.t === 'pong'), 'a pong');
    socket.close();
  });

  it('survives malformed JSON and unknown message types', async () => {
    // A browser that gets disconnected for one bad frame reconnects in a loop,
    // so neither of these may close the socket.
    const { app } = await setup();
    const { socket, messages } = await openSocket(app);

    socket.send('{ not json at all');
    socket.send(JSON.stringify({ t: 'launch-missiles' }));
    socket.send(JSON.stringify({ t: 'ping' }));

    await waitFor(
      () => messages.filter((message) => message.t === 'error').length >= 2,
      'an error for each bad frame',
    );
    await waitFor(() => messages.some((message) => message.t === 'pong'), 'the socket to still work');

    socket.close();
  });

  it('sends a snapshot before any live message when a client subscribes (NFR-2)', async () => {
    // This is reattach-on-refresh. The run is deliberately still executing, so
    // the snapshot has to carry the state and the buffered history that the
    // vanished tab already saw, before anything new arrives.
    const { app, supervisor } = await setup({ lead: { hang: true } });

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitFor(() => supervisor.isLive(runId), 'the run to be live');
    await waitFor(async () => (await supervisor.snapshot(runId)).events.length > 0, 'buffered events');

    const { socket, messages } = await openSocket(app);
    socket.send(JSON.stringify({ t: 'subscribe', runId }));

    await waitFor(() => messages.some((message) => message.t === 'snapshot'), 'the snapshot');

    const snapshotIndex = messages.findIndex((message) => message.t === 'snapshot');
    const snapshot = messages[snapshotIndex];
    if (snapshot?.t !== 'snapshot') throw new Error('expected a snapshot message');

    expect(snapshot.run.id).toBe(runId);
    expect(snapshot.live).toBe(true);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.events.length).toBeGreaterThan(0);

    // No per-run message may precede it, or the client would be merging into a
    // state it does not have yet.
    const before = messages.slice(0, snapshotIndex);
    expect(before.some((message) => message.t === 'event' || message.t === 'state')).toBe(false);

    // ...and live traffic must follow it. Cancelling guarantees more transitions.
    await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    await waitFor(
      () => messages.slice(snapshotIndex).some((message) => message.t === 'state'),
      'live state messages after the snapshot',
    );

    socket.close();
  });

  it('reports a subscribe for an unknown run without closing the socket', async () => {
    const { app } = await setup();
    const { socket, messages } = await openSocket(app);

    socket.send(JSON.stringify({ t: 'subscribe', runId: '20260101-000000-zzzz' }));
    socket.send(JSON.stringify({ t: 'ping' }));

    await waitFor(() => messages.some((message) => message.t === 'error'), 'an error message');
    await waitFor(() => messages.some((message) => message.t === 'pong'), 'the socket to still work');

    socket.close();
  });

  it('stops delivering a run after unsubscribe', async () => {
    const { app, supervisor } = await setup({ lead: { hang: true } });

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };

    const { socket, messages } = await openSocket(app);
    socket.send(JSON.stringify({ t: 'subscribe', runId }));
    await waitFor(() => messages.some((message) => message.t === 'snapshot'), 'the snapshot');

    socket.send(JSON.stringify({ t: 'unsubscribe', runId }));
    // The unsubscribe has to be processed before the cancel it is meant to mute.
    socket.send(JSON.stringify({ t: 'ping' }));
    await waitFor(() => messages.some((message) => message.t === 'pong'), 'the unsubscribe to land');

    const perRunBefore = messages.filter(
      (message) => message.t === 'event' || message.t === 'state' || message.t === 'log',
    ).length;

    await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    await waitForTerminal(supervisor, runId);

    const perRunAfter = messages.filter(
      (message) => message.t === 'event' || message.t === 'state' || message.t === 'log',
    ).length;
    expect(perRunAfter).toBe(perRunBefore);

    socket.close();
  });
});
