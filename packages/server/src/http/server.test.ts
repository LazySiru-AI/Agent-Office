import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { API, ServerMessageSchema, type ServerMessage } from '@agent-office/shared';
import { FileRunStore } from '../store/fileStore.js';
import { MemoryRunStore } from '../store/memoryStore.js';
import type { RunStore } from '../store/types.js';
import { AUTH_TOKEN_HEADER, AUTH_TOKEN_QUERY_PARAM } from './authToken.js';
import { buildServer, isLoopbackHost } from './server.js';
import { RunSupervisor } from './supervisor.js';
import {
  SLOW_RUN_TIMEOUT_MS,
  TEST_SYNTHESIS,
  stubDeliverable,
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

/**
 * Not a real secret — a fixed value so every test in this file that is not
 * itself about the token can assert on ordinary 200/400/403/404 outcomes
 * without also having to know or care what the token is. Real deployments
 * never see this value; `serve.ts` always calls `resolveAuthToken`.
 */
const TEST_TOKEN = 'test-suite-token-not-a-real-secret';

const started: Array<{ app: FastifyInstance; supervisor: RunSupervisor }> = [];

afterEach(async () => {
  // Runs that hang on purpose would otherwise keep vitest's process alive.
  for (const { app, supervisor } of started.splice(0)) {
    await supervisor.shutdown();
    await app.close();
  }
  // The timeout is an ARGUMENT here, not left to `vi.setConfig` further down
  // the file, and that is the whole fix. A hook takes its budget when it is
  // REGISTERED; this registration runs at line 34 and the `setConfig` call runs
  // at line ~90, so the config arrived too late and this hook silently kept
  // vitest's 10s default. It failed roughly one full-suite run in three, at
  // 10,060ms, reported against whichever test happened to precede it — which
  // sent me looking at that test twice before looking here.
  //
  // `shutdown()` waits for every in-flight run to unwind rather than killing it
  // mid-`saveRun`, so under load this hook genuinely needs the same budget the
  // tests do. Passing it explicitly is the only form that cannot be outrun by
  // module evaluation order.
}, SLOW_RUN_TIMEOUT_MS);

/**
 * Attach `TEST_TOKEN` to every `.inject()`/`.injectWS()` call this `app`
 * instance makes from here on, so the ~60 call sites in this file written
 * before AO-6 existed keep exercising exactly what they were written to test
 * — routing, `Host`/`Origin`, handler logic — rather than every one of them
 * needing a mechanical, unrelated header added. A test whose whole point IS
 * the token (see the "startup token (AO-6)" describe block below) does not
 * call this: it builds its own app and calls `.inject()`/`.injectWS()`
 * directly, so it controls the header (or the query parameter, or neither)
 * itself.
 *
 * The override still respects an explicit header a caller supplies (spread
 * order: the default goes in first, the caller's own `headers` are spread
 * after), which is what lets the `Host`/`Origin` tests below keep overriding
 * `host`/`origin` without losing the token this wrapper adds.
 *
 * The casts are the price of monkey-patching a method Fastify's own types
 * declare as a set of call-signature overloads (a bare options object, a
 * callback form, a chainable zero-argument form) rather than one function
 * type — this file only ever uses the options-object, awaited-promise form,
 * so the replacement only needs to implement that one, and `unknown` is the
 * honest way to say "this satisfies less than the full overloaded type".
 */
function authenticateInjections(app: FastifyInstance, token: string): void {
  const rawInject = app.inject.bind(app);
  app.inject = ((optsOrUrl: InjectOptions | string) => {
    const opts: InjectOptions = typeof optsOrUrl === 'string' ? { url: optsOrUrl } : optsOrUrl;
    return rawInject({ ...opts, headers: { [AUTH_TOKEN_HEADER]: token, ...opts.headers } });
  }) as unknown as FastifyInstance['inject'];

  const rawInjectWS = app.injectWS.bind(app);
  type InjectWSArgs = Parameters<FastifyInstance['injectWS']>;
  app.injectWS = ((path?: InjectWSArgs[0], upgradeContext?: unknown, options?: InjectWSArgs[2]) => {
    const context = (upgradeContext ?? {}) as { headers?: Record<string, string> };
    return rawInjectWS(
      path,
      { ...context, headers: { [AUTH_TOKEN_HEADER]: token, ...context.headers } },
      options,
    );
  }) as unknown as FastifyInstance['injectWS'];
}

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
    produceDeliverable: stubDeliverable(),
  });
  const app = await buildServer({ registry, store, supervisor, token: TEST_TOKEN });
  await app.ready();
  authenticateInjections(app, TEST_TOKEN);

  started.push({ app, supervisor });
  return { app, supervisor, store };
}

/**
 * Like `setup()`, but deliberately WITHOUT `authenticateInjections` — used
 * only by the "startup token (AO-6)" tests below, which are specifically
 * about what happens when a caller does not go through that convenience.
 * Every other test in this file wants the token attached automatically so it
 * can get on with testing something else; these tests want full control over
 * whether it is present, correct, wrong, or supplied a different way.
 */
async function setupUnauthenticated(): Promise<{ app: FastifyInstance; supervisor: RunSupervisor }> {
  const registry = testRegistry();
  const store = new MemoryRunStore();
  const supervisor = new RunSupervisor({
    registry,
    store,
    makeProvider: testProviderFactory(),
    onWarning: () => undefined,
    produceDeliverable: stubDeliverable(),
  });
  const app = await buildServer({ registry, store, supervisor, token: TEST_TOKEN });
  await app.ready();

  started.push({ app, supervisor });
  return { app, supervisor };
}

/** Every error body must be `{ error: string }`, whatever produced it. */
function expectApiError(body: string): string {
  const parsed: unknown = JSON.parse(body);
  expect(parsed).toHaveProperty('error');
  const { error } = parsed as { error: unknown };
  expect(typeof error).toBe('string');
  return String(error);
}

/**
 * File-level, for the reasons written out in `supervisor.test.ts`: picking
 * "the slow ones" by hand was a judgement that had to be made correctly on
 * every test and every new test, and the tighter deadline inside
 * `waitForTerminal` made the marker ineffective even where it was applied.
 * Half the tests here drive a real run through the store; the ones that do not
 * cannot hang, and `RUN_POLL_TIMEOUT_MS` still fires first with a message
 * naming the status a stuck run was in.
 */
// `hookTimeout` is set here too, and it does NOT on its own fix the hook above
// — that is worth stating plainly, because an earlier version of this comment
// claimed it did and was wrong for two more full-suite runs before the error
// text was actually read.
//
// A hook takes its budget when it is registered. `afterEach` is registered at
// the top of this file and this call runs further down, so the config lands
// after the hook already has its default. The `SLOW_RUN_TIMEOUT_MS` argument
// passed directly to `afterEach` is what actually governs it. This line still
// earns its place for `testTimeout` — every `it` in the file is registered
// below it — and `hookTimeout` is kept so any hook added AFTER this point
// inherits the right budget rather than quietly getting 10s.
//
// Fourth instance of one pattern in this file's history: a budget set in one
// place while a tighter, unstated one governed elsewhere. `waitForTerminal`'s
// own ceiling, then `waitFor`'s, then the hook default, then this. The lesson
// each time is the same — the explicit argument beats the ambient setting.
vi.setConfig({ testTimeout: SLOW_RUN_TIMEOUT_MS, hookTimeout: SLOW_RUN_TIMEOUT_MS });

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
  }, SLOW_RUN_TIMEOUT_MS);

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
    const app = await buildServer({ registry, store, supervisor, token: TEST_TOKEN });
    await app.ready();
    authenticateInjections(app, TEST_TOKEN);
    started.push({ app, supervisor });

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.', provider: 'gpt-9' },
    });

    expect(response.statusCode).toBe(400);
    expect(expectApiError(response.body)).toMatch(/unknown provider/);
  });

  it('rejects a non-positive maxCostUsd, so a caller cannot mistake "0" for "no cap" (FR-M8)', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.', maxCostUsd: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(expectApiError(response.body)).toMatch(/invalid request body/);
  });

  it('threads maxCostUsd from the request body into the provider factory (FR-M8)', async () => {
    // DEFECT FIXED: `startRun` used to call `makeProvider` with no options at
    // all, so a settings-panel cost budget could never reach the Claude Code
    // adapter's `--max-budget-usd` no matter what the client sent. The
    // supervisor's injectable `makeProvider` is the seam that proves the
    // fix without spawning a real CLI: it stands in for
    // `providers/factory.ts` and records what it was called with.
    const registry = testRegistry();
    const store = new MemoryRunStore();
    const received: unknown[] = [];
    const supervisor = new RunSupervisor({
      registry,
      store,
      makeProvider: (_id, _task, _known, options) => {
        received.push(options);
        // `testProviderFactory()` returns a zero-argument stub — it ignores
        // id/task/known — so nothing is lost by not forwarding them.
        return testProviderFactory()();
      },
      onWarning: () => undefined,
      produceDeliverable: stubDeliverable(),
    });
    const app = await buildServer({ registry, store, supervisor, token: TEST_TOKEN });
    await app.ready();
    authenticateInjections(app, TEST_TOKEN);
    started.push({ app, supervisor });

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.', maxCostUsd: 3.5 },
    });

    expect(response.statusCode).toBe(201);
    expect(received).toContainEqual(expect.objectContaining({ maxCostUsd: 3.5 }));
  });
});

describe('POST /api/runs concurrency cap (AO-6)', () => {
  it('refuses the (N+1)th run with 429 while N are executing, and allows a new one once a slot frees', async () => {
    // WHAT THIS PREVENTS: before this cap, `startRun` accepted every request
    // that passed the trust-boundary checks unconditionally — no limit on how
    // many were executing at once. Each run spawns real, billed provider
    // child processes, so on a loopback server with no user boundary (the
    // rest of AO-6) that was an unbounded-cost primitive: anything that could
    // reach this port could keep POSTing runs forever. `--max-budget-usd`
    // caps what ONE run can spend; nothing capped how many could be spending
    // it at the same time.
    const registry = testRegistry();
    const store = new MemoryRunStore();
    const supervisor = new RunSupervisor({
      registry,
      store,
      // Every run hangs, so both cap slots stay occupied for as long as the
      // test needs them to before the assertions below release one.
      makeProvider: testProviderFactory({ lead: { hang: true } }),
      onWarning: () => undefined,
      produceDeliverable: stubDeliverable(),
      maxConcurrentRuns: 2,
    });
    const app = await buildServer({ registry, store, supervisor, token: TEST_TOKEN });
    await app.ready();
    authenticateInjections(app, TEST_TOKEN);
    started.push({ app, supervisor });

    // Return type inferred rather than written as `ReturnType<typeof
    // app.inject>`: `inject` is declared as a set of overloads (options object,
    // callback, chainable), so that expression resolves to the chainable
    // `Chain` form, not the promise this call actually returns.
    const post = async (task: string) =>
      app.inject({ method: 'POST', url: API.runs(), payload: { task } });

    const first = await post('first run');
    const second = await post('second run');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = (JSON.parse(first.body) as { runId: string }).runId;
    await waitFor(() => supervisor.liveRunIds().length === 2, 'both runs to be live');

    const third = await post('one too many');

    expect(third.statusCode).toBe(429);
    expect(expectApiError(third.body)).toMatch(/already executing/);
    // The refusal happened before a run was ever created for it — a 429 that
    // still allocated a run id would be a supervisor lying about its own cap.
    expect((await store.listRuns()).map((run) => run.task)).not.toContain('one too many');

    // Free a slot, exactly the way a real run ends: cancel it and wait for
    // the supervisor to actually stop counting it as live.
    await app.inject({ method: 'POST', url: API.cancelRun(firstId) });
    await waitFor(() => supervisor.liveRunIds().length === 1, 'the cancelled run to free its slot');

    const fourth = await post('now there is room');
    expect(fourth.statusCode).toBe(201);

    // Clean up the two runs still hanging so the suite's teardown is not left
    // draining a supervisor that will never finish on its own.
    for (const response of [second, fourth]) {
      const { runId } = JSON.parse(response.body) as { runId: string };
      await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    }
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

  it('does not leak the runs root or a filesystem username into a 404 body', async () => {
    // `MemoryRunStore`'s "not found" error is already just a run id (see the
    // test above) — it cannot exercise this defect. `FileRunStore` is the
    // store that actually failed: its error names the absolute path it tried
    // (`cannot read run state at C:\Users\<name>\...\run.json: ENOENT ...`),
    // and `loadRun` used to forward that string verbatim into the response
    // body, handing any loopback caller the server's own filesystem layout.
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-server-'));
    const runsRoot = path.join(tmpRoot, 'runs');
    try {
      const registry = testRegistry();
      const store = new FileRunStore(runsRoot);
      const supervisor = new RunSupervisor({
        registry,
        store,
        makeProvider: testProviderFactory(),
        onWarning: () => undefined,
        produceDeliverable: stubDeliverable(),
      });
      const app = await buildServer({ registry, store, supervisor, token: TEST_TOKEN });
      await app.ready();
      authenticateInjections(app, TEST_TOKEN);
      started.push({ app, supervisor });

      const response = await app.inject({ method: 'GET', url: API.run('20260101-000000-zzzz') });

      expect(response.statusCode).toBe(404);
      const message = expectApiError(response.body);
      expect(message).not.toContain(runsRoot);
      expect(message).not.toContain(os.userInfo().username);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
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
  }, SLOW_RUN_TIMEOUT_MS);

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

describe('POST /api/runs/:runId/team (FR-M11)', () => {
  /** Start a `reviewTeam` run and wait for it to reach the pause. */
  async function startParkedRun(app: FastifyInstance, supervisor: RunSupervisor): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.', reviewTeam: true },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    await waitFor(
      async () => (await supervisor.getRunState(runId)).status === 'awaiting_approval',
      'the run to park for team approval',
    );
    return runId;
  }

  it('exposes the parked run and its proposed plan through the run-state route the client already polls', async () => {
    // FR-M11 adds no new read path. The "review the team" screen has to be
    // able to render off the exact same `GET /api/runs/:id` (and the `state`
    // messages the socket already pushes) that every other view of a run
    // uses — a plan visible only through some route built specifically for
    // this feature would be a second source of truth for something the
    // client already has one of.
    const { app, supervisor } = await setup();
    const runId = await startParkedRun(app, supervisor);

    const response = await app.inject({ method: 'GET', url: API.run(runId) });

    expect(response.statusCode).toBe(200);
    const run = JSON.parse(response.body) as { status: string; plan?: { phases: unknown[] } };
    expect(run.status).toBe('awaiting_approval');
    expect(run.plan?.phases.length).toBeGreaterThan(0);
  });

  it('refuses an unapplicable decision with a 400 and leaves the run parked for a corrected one', async () => {
    // Found by driving the assembled feature against a live server, not by a
    // test — which is the point of writing this one.
    //
    // Dropping an assignment that others depend on returned **200**, and the
    // run then went to `failed`. Both halves were behaving reasonably alone:
    // `applyTeamOperations` refused an edit that would strand a dependency,
    // and the runner refused to dispatch a plan the user had not approved
    // rather than silently reverting to the Manager's original. The defect
    // lived in the seam — the only layer that could still recover had already
    // answered "OK" and let go.
    //
    // A run destroyed by a typo is a bad outcome for a feature whose whole
    // purpose is giving the user control before anything is spent, and worse
    // than having no control at all, because the 200 claims it worked. So the
    // refusal has to happen here, while the run can still be corrected.
    const { app, supervisor } = await setup();
    const runId = await startParkedRun(app, supervisor);

    const before = JSON.parse(
      (await app.inject({ method: 'GET', url: API.run(runId) })).body,
    ) as { assignments: { id: string; dependsOn: string[] }[] };
    // Whatever the scripted planner produced, pick a target something depends on.
    const depended = before.assignments.find((a) =>
      before.assignments.some((other) => other.dependsOn.includes(a.id)),
    );
    if (depended === undefined) throw new Error('expected the scripted plan to have a dependency');

    const response = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      payload: { operations: [{ op: 'drop', assignmentId: depended.id }] },
    });

    expect(response.statusCode).toBe(400);
    expect(expectApiError(response.body)).toMatch(/rejected/i);

    // The run is still parked — not failed, not dispatched — so the user can
    // simply post a decision that works.
    const after = JSON.parse((await app.inject({ method: 'GET', url: API.run(runId) })).body) as {
      status: string;
    };
    expect(after.status).toBe('awaiting_approval');

    const retry = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      payload: { operations: [] },
    });
    expect(retry.statusCode).toBe(200);
    await waitForTerminal(supervisor, runId);
  }, SLOW_RUN_TIMEOUT_MS);

  it('releases a parked run on an empty decision and lets it run to done', async () => {
    // The empty array is the "the Manager's team is right, go" case
    // `TeamDecisionSchema`'s doc comment calls out — approval is the act of
    // posting at all, not a separate flag that could disagree with the ops.
    const { app, supervisor } = await setup();
    const runId = await startParkedRun(app, supervisor);

    const response = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      payload: { operations: [] },
    });

    expect(response.statusCode).toBe(200);
    const run = await waitForTerminal(supervisor, runId);
    expect(run.status).toBe('done');
  }, SLOW_RUN_TIMEOUT_MS);

  it('returns 409 for a live run that is not awaiting team approval, rather than silently doing nothing', async () => {
    // A run that never asked to pause (no `reviewTeam`) has nothing parked to
    // resolve. The hang keeps it non-terminal and past the pause point (in
    // `running`) so this exercises the "wrong status, but not finished"
    // branch specifically — a terminal run gets the differently-worded
    // "already finished" refusal, covered by the cancel-then-approve test
    // below, and conflating the two messages would leave a caller unable to
    // tell "too early to retry" from "this is over" from the response alone.
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
      url: API.runTeam(runId),
      payload: { operations: [] },
    });

    expect(response.statusCode).toBe(409);
    expect(expectApiError(response.body)).toMatch(/not awaiting team approval/);

    // Clean up the deliberately-hung run.
    await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    await waitForTerminal(supervisor, runId);
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: API.runTeam('20260101-000000-zzzz'),
      payload: { operations: [] },
    });

    expect(response.statusCode).toBe(404);
    expectApiError(response.body);
  });

  it('returns 400 for a body the contract does not accept', async () => {
    // `operations` is required, and each entry is a three-way discriminated
    // union (`drop`/`swap`/`add`) — anything else must fail here rather than
    // reach `applyTeamOperations` with a shape it was never validated against.
    const { app, supervisor } = await setup();
    const runId = await startParkedRun(app, supervisor);

    const response = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      payload: { operations: [{ op: 'rename', assignmentId: 'lead' }] },
    });

    expect(response.statusCode).toBe(400);
    expect(expectApiError(response.body)).toMatch(/invalid request body/);

    // The run is still parked — clean it up so teardown is not left draining
    // a supervisor waiting on a decision that will never arrive.
    await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    await waitForTerminal(supervisor, runId);
  });

  it('refuses a foreign origin, the same protection every other state-changing POST gets', async () => {
    // The same shape as "refuses a forged cancel outright" below, with a body
    // attached: `Host: 127.0.0.1:5179` is a genuine loopback host, so only
    // `Origin` gives the request away, and the `onRequest` hook is what has
    // to catch it — nothing route-specific was added for this route, so this
    // is the test that proves it actually inherited the hook rather than the
    // hook only having ever run ahead of `/cancel`.
    const { app, supervisor } = await setup();
    const runId = await startParkedRun(app, supervisor);

    const response = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      headers: { host: '127.0.0.1:5179', origin: 'http://evil.example' },
      payload: { operations: [] },
    });

    expect(response.statusCode).toBe(403);
    // The assertion that matters: the side effect did not happen either. A
    // 403 that still released the run would be worse than useless — it would
    // look safe while quietly not being.
    expect((await supervisor.getRunState(runId)).status).toBe('awaiting_approval');

    await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    await waitForTerminal(supervisor, runId);
  });

  it('lets a cancel release a parked run, and a later approval cannot revive it', async () => {
    // Cancel and approve are the two ways a pause ends. Once cancel has won,
    // an approval that was already in flight (or simply arrives late) must
    // not resurrect the run into dispatch — it has to see the same "already
    // finished" refusal any other post-terminal action gets.
    const { app, supervisor } = await setup();
    const runId = await startParkedRun(app, supervisor);

    const cancelled = await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    expect(cancelled.statusCode).toBe(200);
    const run = await waitForTerminal(supervisor, runId);
    expect(run.status).toBe('cancelled');

    const response = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      payload: { operations: [] },
    });

    expect(response.statusCode).toBe(409);
    expect(expectApiError(response.body)).toMatch(/already finished/);
  });

  it('refuses a second approval once the first has already released the run', async () => {
    // Exactly-once from the outside: a double-click or a retried request must
    // not be able to resolve the same parked decision twice.
    const { app, supervisor } = await setup();
    const runId = await startParkedRun(app, supervisor);

    const first = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      payload: { operations: [] },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: API.runTeam(runId),
      payload: { operations: [] },
    });
    expect(second.statusCode).toBe(409);

    await waitForTerminal(supervisor, runId);
  }, SLOW_RUN_TIMEOUT_MS);
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

  it('serves only the reports the run declares, not everything in its directory', async () => {
    // Containment was never enough on its own, and this is the test that used
    // to say it was. It asked only whether a `../../../../etc/passwd` climb was
    // refused — it was, and still is — and concluded the route was safe. But
    // the boundary containment establishes is the RUN DIRECTORY, and that
    // directory holds `run.json`, the `logs/*.jsonl` replay records, and
    // `workspace/`, which is where NFR-1 deliberately puts the output of an
    // agent nobody trusts. Every one of those was served in full, over an
    // unauthenticated loopback route (NFR-6), to anything on this machine that
    // could make an HTTP request.
    //
    // So the traversal case below is now the least interesting of the four.
    const { app, supervisor } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });
    const { runId } = JSON.parse(created.body) as { runId: string };
    const run = await waitForTerminal(supervisor, runId);

    // A real report is still served — the route must not have become useless.
    const declared = run.assignments.find((assignment) => assignment.reportPath !== undefined);
    expect(declared?.reportPath).toBeDefined();
    const allowed = await app.inject({
      method: 'GET',
      url: API.assignmentReport(runId, declared?.reportPath ?? ''),
    });
    expect(allowed.statusCode).toBe(200);

    for (const path of ['run.json', 'logs/lead-analysis.jsonl', 'workspace/anything.txt']) {
      const response = await app.inject({ method: 'GET', url: API.assignmentReport(runId, path) });
      expect(response.statusCode).toBe(404);
      // The refusal names no path and no reason beyond "not a report here":
      // whether some other file exists in this run directory is not something
      // an unauthenticated caller should be able to probe for.
      expect(expectApiError(response.body)).toMatch(/has no report at that path/);
      expect(response.body).not.toContain('run.json');
    }

    const climb = await app.inject({
      method: 'GET',
      url: API.assignmentReport(runId, '../../../../etc/passwd'),
    });
    expect(climb.statusCode).toBe(404);
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

describe('Host header allowlist (DNS rebinding)', () => {
  // `.inject()` sets `Host: localhost:80` by default when no header is given
  // (see `light-my-request`'s `parseURL`, which resolves a path-only URL
  // against `http://localhost`), so every other test in this file already
  // exercises "loopback Host succeeds" without asking for it explicitly. These
  // tests are the explicit versions plus the rejection cases, which nothing
  // else here would otherwise cover.

  it('accepts Host: localhost:<port>, the normal browser/dev-server case', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { host: 'localhost:5179' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('accepts Host: 127.0.0.1:<port>', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { host: '127.0.0.1:5179' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a foreign Host with 403 — the DNS-rebinding regression case', async () => {
    // A page rebound to resolve `attacker.example` at 127.0.0.1 still sends
    // `Host: attacker.example`; that name is not one this process answers on
    // (`serve.ts` binds only `127.0.0.1`), so it must be refused regardless of
    // which socket the bytes actually arrived on.
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { host: 'attacker.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(expectApiError(response.body)).toMatch(/not a loopback address/);
  });

  it('rejects a foreign Host on the WebSocket upgrade route too', async () => {
    // `onUpgrade` in `@fastify/websocket` dispatches the raw upgrade request
    // through `fastify.routing`, which runs the normal hook chain — including
    // this one — before the socket is ever handed to the ws handler. A
    // DNS-rebound page must not be able to open a live event stream just
    // because it targets `/ws` instead of a plain HTTP route.
    const { app } = await setup();

    await expect(
      app.injectWS(API.socket(), { headers: { host: 'attacker.example' } }),
    ).rejects.toThrow(/403/);
  });

  // ---------------------------------------------------------------------
  // The other half. These four are the tests whose absence let a wrong claim
  // sit in `server.ts`'s own doc comment: every case above varies `Host` and
  // leaves `Origin` alone, so the suite was green while a foreign PAGE — which
  // sends a perfectly valid loopback `Host` — could read and mutate freely.
  // ---------------------------------------------------------------------

  it('rejects a foreign Origin even when the Host is a real loopback address', async () => {
    // The realistic cross-origin shape, and the one the Host check cannot
    // see: `Host` is the URL fetched (loopback, valid), `Origin` is the page
    // that fetched it (foreign). Reproduced against a running server before
    // the fix — this returned 200 with the full run list.
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.runs(),
      headers: { host: '127.0.0.1:5179', origin: 'http://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(expectApiError(response.body)).toMatch(/not a loopback origin/);
  });

  it('refuses a forged cancel outright, rather than withholding a CORS header', async () => {
    // The distinction that matters for a side effect. Denying
    // `access-control-allow-origin` only stops the attacking page from READING
    // the reply; the bodyless POST is a CORS "simple request", so the handler
    // has already run by then and the run is already cancelled. The request
    // has to be refused before the route, which is why this check lives in
    // `onRequest`.
    // `hang: true` so the run is still live to be cancelled — the same shape
    // the other cancel tests in this file use.
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
      headers: { host: '127.0.0.1:5179', origin: 'http://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    // The assertion that matters: the side effect did not happen. A CORS
    // header withheld after the fact would leave this false.
    expect(supervisor.isLive(runId)).toBe(true);

    // Clean up the deliberately-hung run so the suite's teardown is not
    // draining a supervisor that will never finish on its own.
    await app.inject({ method: 'POST', url: API.cancelRun(runId) });
    await waitForTerminal(supervisor, runId);
  });

  it('rejects a foreign Origin on the WebSocket upgrade — the stream has no same-origin policy', async () => {
    // The worst of the three, because no browser protection applies at all:
    // `WebSocket` is exempt from the same-origin policy, so any open tab could
    // connect and receive run state, log lines and deliverable content. The
    // server refusing the upgrade is the only thing standing in the way.
    const { app } = await setup();

    await expect(
      app.injectWS(API.socket(), { headers: { host: 'localhost', origin: 'http://evil.example' } }),
    ).rejects.toThrow(/403/);
  });

  it('still accepts a request with no Origin at all — curl, the CLI, tests', async () => {
    // Absence must stay allowed. A non-browser client sends no Origin, and
    // that is the ordinary local case NFR-6 is built around; the DNS-rebinding
    // shape that also omits Origin is what the Host check covers.
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { host: '127.0.0.1:5179' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('still accepts the dev server, whose loopback origin is cross-origin by port', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { host: '127.0.0.1:5179', origin: 'http://localhost:5173' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rejects a foreign Host on the CORS preflight route too', async () => {
    // The preflight route is registered as a wildcard specifically to answer
    // OPTIONS before the not-found handler would; it has to be behind the same
    // Host check as everything else, not exempted because it runs earlier.
    const { app } = await setup();

    const response = await app.inject({
      method: 'OPTIONS',
      url: API.runs(),
      headers: { host: 'attacker.example', origin: 'http://127.0.0.1:5173' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a cross-site cancel with a foreign Host, and the run is NOT cancelled (CSRF)', async () => {
    // The CSRF shape: a bodyless `text/plain` POST is a CORS "simple request",
    // so a foreign page can fire it with no preflight and no Origin header at
    // all. The Host check is what has to stop this — it must both answer 403
    // AND leave the run's state untouched, not just report the right status
    // code while the cancel goes through anyway.
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
      headers: { host: 'attacker.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(supervisor.isLive(runId)).toBe(true);
    const run = await supervisor.getRunState(runId);
    expect(run.status).not.toBe('cancelled');
  });

  it('treats a missing Host header the same as a foreign one', () => {
    // `.inject()` cannot construct a request with no `Host` header at all —
    // `light-my-request` always synthesizes one (see the comment at the top of
    // this describe block) — so the "absent" branch of `isLoopbackHost` is
    // exercised directly rather than through a route. A raw HTTP/1.0 socket
    // can omit the header for real, and this is the code path that has to
    // catch it: `undefined` must reject exactly like `attacker.example` does,
    // never fail open.
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('the startup token (AO-6)', () => {
  // Same register as the "Host header allowlist" block above, deliberately:
  // this is the other half of the same trust boundary. `Host`/`Origin` prove
  // a request arrived the way a browser aimed at this origin would send one;
  // the token proves the caller is someone who was actually handed access to
  // this process. Neither on its own is NFR-6's full story, which is exactly
  // why closing only one of them (the state before this change) left a real
  // gap: loopback is shared by every account and process on the machine, and
  // nothing about a request's `Host` or `Origin` says who sent it.

  it('refuses a GET route with no token at all', async () => {
    // WHAT THIS PREVENTS: before AO-6, a well-formed loopback request with a
    // valid `Host` and no `Origin` (the ordinary curl/script shape) was
    // simply served — that is precisely the "any other local account" gap
    // the finding describes. `GET /api/runs` was chosen for this test rather
    // than `/api/health` because it is the read this gap most directly
    // exposed: the full run list, to anything on the machine.
    const { app } = await setupUnauthenticated();

    const response = await app.inject({ method: 'GET', url: API.runs() });

    expect(response.statusCode).toBe(401);
    expectApiError(response.body);
  });

  it('refuses a state-changing POST with no token', async () => {
    // The side-effect case, not just the read case: without this, the same
    // other-account caller could start real, billed provider processes.
    const { app } = await setupUnauthenticated();

    const response = await app.inject({
      method: 'POST',
      url: API.runs(),
      payload: { task: 'Analyse the thing.' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses the WebSocket upgrade with no token', async () => {
    // The worst case of all three checks this file covers: WebSocket has no
    // same-origin policy, so `Host`/`Origin` aside, the token is the ONLY
    // thing that can still stand between an open `/ws` — run state, log
    // lines, deliverable content, all of it — and any local process that can
    // reach this port. This mirrors the "rejects a foreign Origin on the
    // WebSocket upgrade" test above exactly, with the token as the axis
    // instead of Origin.
    const { app } = await setupUnauthenticated();

    await expect(
      app.injectWS(API.socket(), { headers: { host: 'localhost' } }),
    ).rejects.toThrow(/401/);
  });

  it('refuses a wrong token sent as the header', async () => {
    const { app } = await setupUnauthenticated();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { [AUTH_TOKEN_HEADER]: 'not-the-right-token' },
    });

    expect(response.statusCode).toBe(401);
    // Deliberately not asserting on the error message's exact wording beyond
    // what `expectApiError` already checks (a string) — the route's own
    // comment explains why "wrong" and "absent" get the identical message.
  });

  it('refuses a wrong token sent as the query parameter', async () => {
    const { app } = await setupUnauthenticated();

    const response = await app.inject({
      method: 'GET',
      url: `${API.health()}?${AUTH_TOKEN_QUERY_PARAM}=not-the-right-token`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('still requires the token on /api/health — the one route worth considering an exemption for', async () => {
    // DECISION (see `server.ts`'s comment on this route for the full
    // reasoning): not exempted. `liveRunIds` in the health response is
    // exactly the kind of fact AO-6 is about — which runs this account is
    // currently spending money to execute — so an unauthenticated health
    // route would reopen a sliver of the same gap the token exists to close,
    // for a benefit (an unauthenticated readiness probe) nothing in this
    // codebase actually needs; the Vite proxy attaches the header to every
    // `/api/*` path uniformly, `/api/health` included.
    const { app } = await setupUnauthenticated();

    const response = await app.inject({ method: 'GET', url: API.health() });

    expect(response.statusCode).toBe(401);
  });

  it('accepts the correct token via the header, the steady-state mechanism', async () => {
    const { app } = await setupUnauthenticated();

    const response = await app.inject({
      method: 'GET',
      url: API.runs(),
      headers: { [AUTH_TOKEN_HEADER]: TEST_TOKEN },
    });

    expect(response.statusCode).toBe(200);
  });

  it('accepts the correct token via the query parameter — the first-browser-load bootstrap', async () => {
    // This is the ONE case the query parameter exists for (see
    // `authToken.ts`'s `extractProvidedToken`): the very first top-level
    // navigation to the URL `serve.ts` prints, before any client script has
    // had a chance to attach a header. It is accepted here on any route, not
    // just a designated "bootstrap" one, because the server has no session
    // concept to make that distinction with — see the doc comment for why
    // that is still safe.
    const { app } = await setupUnauthenticated();

    const response = await app.inject({
      method: 'GET',
      url: `${API.runs()}?${AUTH_TOKEN_QUERY_PARAM}=${TEST_TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
  });

  it('accepts the correct token on the WebSocket upgrade, via the header', async () => {
    const { app } = await setupUnauthenticated();

    const socket = await app.injectWS(API.socket(), {
      headers: { host: 'localhost', [AUTH_TOKEN_HEADER]: TEST_TOKEN },
    });

    // The upgrade actually completing (not merely the promise resolving to
    // something) is the assertion that matters — `injectWS` only resolves
    // once the 101 response has been seen (see `@fastify/websocket`'s
    // implementation), so getting a socket back at all is already proof, but
    // closing it cleanly rules out a half-open connection the test would
    // otherwise leak into the next one.
    socket.close();
  });

  it('checks Host and Origin before the token, so a DNS-rebound or cross-origin request gets that refusal, not a token one', async () => {
    // Ordering matters for what a rebinding or cross-origin attempt learns
    // from the response: if the token check ran first, a foreign Host would
    // get a 401 and could conclude "this process wants a token" — one more
    // bit of reconnaissance than a rejection already known to be hopeless
    // needs to hand out. Checked here with NO token supplied at all, so a 403
    // (not a 401) is proof the Host check is what actually fired.
    const { app } = await setupUnauthenticated();

    const response = await app.inject({
      method: 'GET',
      url: API.health(),
      headers: { host: 'attacker.example' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('exempts the CORS preflight from the token, so the real authenticated request can even be sent', async () => {
    // A browser cannot attach a custom header to an OPTIONS preflight — that
    // request exists purely to ask "would this header be allowed?" before any
    // credential is involved. Requiring the token here would fail every
    // preflight, and a failed preflight means no browser ever sends the real,
    // correctly-authenticated request behind it. `access-control-allow-headers`
    // naming the token header is the other half of this: without it, the
    // preflight would succeed but the browser would still refuse to attach
    // the header on the real request that follows.
    const { app } = await setupUnauthenticated();

    const response = await app.inject({
      method: 'OPTIONS',
      url: API.runs(),
      headers: { origin: 'http://127.0.0.1:5173' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain(AUTH_TOKEN_HEADER);
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
 *
 * The explicit `Host` header is load-bearing, not decorative. `@fastify/websocket`'s
 * `injectWS` does not go through `light-my-request` the way `app.inject()` does —
 * it builds its own bare upgrade request by hand (see `injectWS` in
 * `@fastify/websocket/index.js`) and that request carries no `Host` header
 * unless one is supplied here. `app.inject()` does not have this gap; it
 * defaults to `localhost:80` on its own. A real browser's WebSocket handshake
 * always sends `Host` (it is a mandatory HTTP header), so this line is making
 * the test send what a real client already sends implicitly — it is not
 * loosening the server's check, which still rejects an upgrade carrying a
 * foreign `Host` exactly like any other route (see the "Host header allowlist"
 * tests above).
 */
async function openSocket(
  app: FastifyInstance,
): Promise<{ socket: TestSocket; messages: ServerMessage[] }> {
  const messages: ServerMessage[] = [];
  const socket = (await app.injectWS(API.socket(), { headers: { host: 'localhost' } }, {
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
