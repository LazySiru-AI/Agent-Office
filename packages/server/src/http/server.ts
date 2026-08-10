import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import {
  API,
  ClientMessageSchema,
  CreateRunRequestSchema,
  isRunTerminal,
  type AgentDef,
  type AgentSummary,
  type RunState,
  type ServerMessage,
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import { UnknownProviderError } from '../providers/factory.js';
import { ProviderUnavailableError } from '../providers/types.js';
import { UnsafePathError, type RunStore } from '../store/types.js';
import { assertValidRunId } from '../store/util.js';
import { collectRunEvents } from './runEvents.js';
import type { RunSupervisor } from './supervisor.js';

/**
 * The HTTP + WebSocket surface (PLAN.md Phase 3).
 *
 * Every route here is one of the entries in the wire contract's `API` constant,
 * and every payload is one of its zod schemas. Nothing is invented locally: the
 * browser half of Phase 3 is written against that file, and a route or a field
 * that exists only on this side is a bug that surfaces as a blank screen.
 *
 * Two rules run through the whole file:
 *
 * - **Nothing from the client is trusted.** Bodies, params and query strings are
 *   parsed with the contract's schemas before they reach any handler logic. A
 *   run id becomes a directory name, so it also goes through `assertValidRunId`.
 * - **Report paths are treated as hostile.** They originate in the Manager's
 *   LLM-generated `deliverable` field, so every read goes through the store's
 *   `readReport`, which resolves and verifies containment (NFR-1). This module
 *   never touches `fs` itself.
 *
 * `buildServer` returns an instance rather than listening, so tests can drive it
 * with `.inject()` and `serve.ts` owns the one decision that must not be got
 * wrong — the loopback bind (NFR-6).
 */

export interface ServerDeps {
  registry: Registry;
  store: RunStore;
  supervisor: RunSupervisor;
  /** Passed straight to Fastify. Tests pass `false` to keep output readable. */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Fastify route patterns, derived from the contract's URL builders.
 *
 * `API.run(':runId')` cannot be used directly: the builders percent-encode their
 * argument, so the colon would arrive as `%3A` and the route would never match.
 * Substituting a placeholder that survives encoding keeps these strings anchored
 * to the contract instead of being retyped by hand, where `/report-file` and
 * `/report_file` would disagree silently.
 */
const RUN_ID_PLACEHOLDER = 'runIdPlaceholder';

function toPattern(url: string): string {
  return url.replace(RUN_ID_PLACEHOLDER, ':runId').replace(/\?.*$/, '');
}

const ROUTES = {
  health: API.health(),
  agents: API.agents(),
  runs: API.runs(),
  run: toPattern(API.run(RUN_ID_PLACEHOLDER)),
  cancelRun: toPattern(API.cancelRun(RUN_ID_PLACEHOLDER)),
  runReport: toPattern(API.runReport(RUN_ID_PLACEHOLDER)),
  assignmentReport: toPattern(API.assignmentReport(RUN_ID_PLACEHOLDER, 'x')),
  runEvents: toPattern(API.runEvents(RUN_ID_PLACEHOLDER)),
  socket: API.socket(),
} as const;

/** Route params. The id is re-checked with `assertValidRunId` before any I/O. */
const RunParamsSchema = z.object({ runId: z.string().min(1) });

/** `?path=` on the assignment-report route. */
const ReportQuerySchema = z.object({ path: z.string().min(1) });

/**
 * Origins allowed to call this server from a browser.
 *
 * The Vite dev server runs on its own port, which makes every fetch from it
 * cross-origin even though both ends are loopback. Rather than require a proxy
 * config in the web package, loopback origins are allowed explicitly — and only
 * loopback ones, so this stays consistent with NFR-6's "no auth, therefore not
 * reachable from the network". A page served from a real host cannot be one of
 * these origins, so it still cannot reach the API.
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });

  await app.register(fastifyWebsocket);

  // Every failure leaves through here so the body always matches `ApiErrorSchema`.
  // Fastify's own errors (a malformed JSON body, a payload over the limit) would
  // otherwise send `{ statusCode, error, message }`, which the client has no
  // case for.
  app.setErrorHandler((error: unknown, request, reply) => {
    const status = statusFor(error);
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    void reply.status(status).send({ error: describe(error) });
  });

  /**
   * Accept a POST whose content type Fastify has no parser for, treating the
   * body as absent.
   *
   * `/cancel` carries no body, and what a client puts in the header for a
   * bodyless POST is entirely up to it: `fetch` sends nothing, curl sends
   * `application/x-www-form-urlencoded`, PowerShell sends the same. Fastify
   * answers all but the first with a 415 whose body is not `ApiErrorSchema`
   * either. Ignoring the body is safe because every route that needs one
   * validates it with a schema, so a text/plain `POST /api/runs` still fails —
   * as a 400 that says which field was wrong, rather than a 415.
   */
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, _body, done) => {
    done(null, undefined);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: `no route for ${request.method} ${request.url}` });
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && LOOPBACK_ORIGIN.test(origin)) {
      void reply.header('access-control-allow-origin', origin);
      void reply.header('vary', 'origin');
    }
  });

  // Preflight for the same loopback origins. Registered as a wildcard route
  // because the not-found handler would otherwise answer OPTIONS with a 404 and
  // the browser would never send the real request.
  app.options('/*', async (_request, reply) => {
    void reply
      .header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .status(204)
      .send();
  });

  // --- Health -------------------------------------------------------------
  // Not in the contract's schema set because there is nothing for the client to
  // parse beyond "the server answered". It doubles as the readiness probe the
  // web dev server polls before opening a socket.
  app.get(ROUTES.health, async () => ({
    ok: true,
    serverTime: Date.now(),
    liveRunIds: deps.supervisor.liveRunIds(),
  }));

  // --- Agent roster (FR-R1) ------------------------------------------------
  app.get(ROUTES.agents, async () => ({
    agents: deps.registry.agents.map(toAgentSummary),
  }));

  // --- Runs ----------------------------------------------------------------
  app.get(ROUTES.runs, async () => ({ runs: await deps.supervisor.listRuns() }));

  app.post(ROUTES.runs, async (request, reply) => {
    const parsed = CreateRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, `invalid request body: ${formatIssues(parsed.error)}`);
    }

    // `startRun` returns as soon as the run has an id; the pipeline keeps going
    // in the background. A run that takes ten minutes must not hold a request
    // open for ten minutes (NFR-3 pushes the rest over the socket).
    const runId = await deps.supervisor.startRun(parsed.data);
    return reply.status(201).send({ runId });
  });

  app.get(ROUTES.run, async (request) => loadRun(deps, parseRunId(request.params)));

  /**
   * Cancel (FR-M9).
   *
   * The contract defines no response body for this route, so it answers with the
   * `RunState` — a shape the client already has a schema for, and the thing it
   * would otherwise have to re-fetch to find out what cancelling did. Note that
   * the status is very unlikely to be `cancelled` yet: aborting is a request to
   * unwind, and the transition happens when dispatch notices.
   */
  app.post(ROUTES.cancelRun, async (request) => {
    const runId = parseRunId(request.params);
    const run = await loadRun(deps, runId);

    if (deps.supervisor.cancelRun(runId)) return run;

    // Not live here. Either it finished, or it belongs to a previous server
    // process — in both cases there is nothing this process can abort, and
    // saying so is more useful than a silent success.
    throw new HttpError(
      409,
      isRunTerminal(run.status)
        ? `run "${runId}" has already finished (${run.status})`
        : `run "${runId}" is not executing in this server process`,
    );
  });

  // --- Reports -------------------------------------------------------------
  app.get(ROUTES.runReport, async (request) => {
    const runId = parseRunId(request.params);
    const run = await loadRun(deps, runId);

    if (run.reportPath === undefined) {
      throw new HttpError(404, `run "${runId}" has no synthesis report yet (status: ${run.status})`);
    }

    return readReport(deps, runId, run.reportPath);
  });

  app.get(ROUTES.assignmentReport, async (request) => {
    const runId = parseRunId(request.params);
    const query = ReportQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new HttpError(400, `invalid query: ${formatIssues(query.error)}`);
    }

    // Deliberately no existence check on the run first: `readReport` resolves
    // the path against the run directory and rejects anything that escapes it,
    // which is the check that actually matters here (NFR-1).
    return readReport(deps, runId, query.data.path);
  });

  // --- Event history (NFR-7 replay) ----------------------------------------
  app.get(ROUTES.runEvents, async (request) => {
    const runId = parseRunId(request.params);
    // Established purely to get the 404 right: a run id that is well-formed
    // but was never created must not be reported as "zero events", which is
    // indistinguishable from a run that simply has not produced any yet.
    await loadRun(deps, runId);

    const { events, partial } = await collectRunEvents(deps.store, runId);
    return { runId, events, partial };
  });

  // --- WebSocket (NFR-2, NFR-3) -------------------------------------------
  app.get(ROUTES.socket, { websocket: true }, (socket: unknown) => {
    attachSocket(deps, asWebSocket(socket));
  });

  return app;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/**
 * The slice of the `ws` socket this file uses.
 *
 * `ws` ships no types of its own and `@types/ws` is not a dependency, so the
 * plugin's handler hands back `any`. Narrowing it here means a typo in
 * `readyState` is a compile error rather than a socket that silently never
 * sends anything.
 */
interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/** `ws`'s `OPEN`. Hard-coded because the constant lives on the untyped module. */
const WS_OPEN = 1;

function asWebSocket(socket: unknown): WebSocketLike {
  return socket as WebSocketLike;
}

/**
 * Wire one client socket to the supervisor.
 *
 * The contract's `snapshot` is what makes reattach work (NFR-2): a subscribing
 * client is sent the whole `RunState` plus buffered history *before* any live
 * message, so a refresh mid-run rebuilds the same view instead of resuming from
 * whatever happens to arrive next.
 *
 * Nothing a client sends may kill the socket. Malformed JSON, an unknown
 * message type, or a subscribe for a run that does not exist all answer with an
 * `error` message and leave the connection usable — a browser that gets
 * disconnected for one bad frame reconnects in a loop.
 */
function attachSocket(deps: ServerDeps, socket: WebSocketLike): void {
  const subscriptions = new Map<string, () => void>();
  let closed = false;

  const send = (message: ServerMessage): void => {
    if (closed || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A socket that has gone away mid-write is not an error worth logging on
      // every buffered event; the close handler tidies up either way.
      closed = true;
    }
  };

  const sendRunList = (): void => {
    void deps.supervisor
      .listRuns()
      .then((runs) => send({ t: 'runs', runs }))
      .catch((error: unknown) => send({ t: 'error', message: describe(error) }));
  };

  send({ t: 'hello', serverTime: Date.now(), liveRunIds: deps.supervisor.liveRunIds() });
  sendRunList();

  const offRunList = deps.supervisor.onRunListChanged(sendRunList);

  const unsubscribe = (runId: string): void => {
    const off = subscriptions.get(runId);
    if (off === undefined) return;
    off();
    subscriptions.delete(runId);
  };

  const subscribe = async (runId: string): Promise<void> => {
    if (subscriptions.has(runId)) unsubscribe(runId);

    // The listener is registered before the snapshot is read, with anything it
    // receives held back until the snapshot has gone out. Subscribing afterwards
    // would drop every event emitted in between, which on a busy run is exactly
    // the window that matters. The supervisor reads a live run's buffers
    // synchronously, so nothing is sent twice: the queue can only hold events
    // newer than the snapshot.
    const queued: ServerMessage[] = [];
    let snapshotSent = false;
    const off = deps.supervisor.subscribe(runId, (message) => {
      if (snapshotSent) send(message);
      else queued.push(message);
    });
    subscriptions.set(runId, off);

    let snapshot: Awaited<ReturnType<RunSupervisor['snapshot']>>;
    try {
      snapshot = await deps.supervisor.snapshot(runId);
    } catch (error) {
      unsubscribe(runId);
      send({ t: 'error', runId, message: describe(error) });
      return;
    }

    send({
      t: 'snapshot',
      run: snapshot.run,
      events: snapshot.events,
      live: snapshot.live,
      truncated: snapshot.truncated,
    });
    // Replayed as ordinary `log` messages because the contract's snapshot has no
    // field for them; the client's log pane sees the same stream either way.
    for (const entry of snapshot.logs) {
      send({ t: 'log', runId, line: entry.line, ts: entry.ts });
    }

    snapshotSent = true;
    for (const message of queued) send(message);
    queued.length = 0;
  };

  socket.on('message', (data: unknown) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      send({ t: 'error', message: 'message is not valid JSON' });
      return;
    }

    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      send({ t: 'error', message: `unsupported message: ${formatIssues(result.error)}` });
      return;
    }

    const message = result.data;
    if (message.t === 'ping') {
      send({ t: 'pong' });
      return;
    }
    if (message.t === 'unsubscribe') {
      unsubscribe(message.runId);
      return;
    }

    let runId: string;
    try {
      runId = assertValidRunId(message.runId);
    } catch (error) {
      send({ t: 'error', runId: message.runId, message: describe(error) });
      return;
    }

    void subscribe(runId).catch((error: unknown) => {
      send({ t: 'error', runId, message: describe(error) });
    });
  });

  socket.on('close', () => {
    closed = true;
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
    offRunList();
  });

  socket.on('error', () => {
    // Transport errors are always followed by `close`; treating them as fatal
    // here would just double the teardown.
    closed = true;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A failure with a status code attached.
 *
 * Thrown rather than answered inline so every handler's success path returns a
 * plain object and every failure converges on the one error handler that shapes
 * `ApiErrorSchema`. Fastify reads `statusCode` off thrown errors, and
 * {@link statusFor} honours it.
 */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    Object.setPrototypeOf(this, HttpError.prototype);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

/**
 * Validate a route param into a usable run id.
 *
 * Two checks, not one: the schema proves the shape Fastify handed over, and
 * `assertValidRunId` proves it is safe to turn into a directory name. The second
 * throws `UnsafePathError`, which the error handler maps to a 400.
 */
function parseRunId(params: unknown): string {
  const parsed = RunParamsSchema.safeParse(params);
  if (!parsed.success) throw new UnsafePathError(String(params));
  return assertValidRunId(parsed.data.runId);
}

/**
 * Load a run, answering 404 when it cannot be read.
 *
 * Any load failure becomes a 404 carrying the store's own message. That message
 * distinguishes "no such directory" from "run.json does not match the schema",
 * so collapsing both into one status costs nothing diagnostically — and the
 * alternative, sniffing errno out of a wrapped error, is the kind of guess that
 * breaks the first time a store implementation changes.
 */
async function loadRun(deps: ServerDeps, runId: string): Promise<RunState> {
  try {
    return await deps.supervisor.getRunState(runId);
  } catch (error) {
    throw new HttpError(404, `run "${runId}" not found: ${describe(error)}`);
  }
}

/** Read one report through the store, so path containment is always enforced. */
async function readReport(
  deps: ServerDeps,
  runId: string,
  reportPath: string,
): Promise<{ path: string; markdown: string }> {
  try {
    const markdown = await deps.store.readReport(runId, reportPath);
    return { path: reportPath, markdown };
  } catch (error) {
    // An escaping path is the client's fault and gets a 400; a missing file is
    // simply not there yet. Note the 404 message deliberately does not echo the
    // filesystem path the store tried, which would leak the runs root.
    if (error instanceof UnsafePathError) throw new HttpError(400, error.message);
    throw new HttpError(404, `report "${reportPath}" not found in run "${runId}"`);
  }
}

function toAgentSummary(agent: AgentDef): AgentSummary {
  // Deliberately not the system prompt: the roster browser lists agents, and
  // shipping every prompt would make the response an order of magnitude larger
  // for something no view renders.
  return {
    name: agent.name,
    category: agent.category,
    description: agent.description,
    tools: [...agent.tools],
    ...(agent.model === undefined ? {} : { model: agent.model }),
  };
}

/**
 * Map an error to a status code, defaulting to 500 for anything unrecognised.
 *
 * The `statusCode` fallback catches Fastify's own errors — a body that is not
 * JSON, or one over the size limit — which arrive as 400s and would otherwise be
 * reported to the client as server faults.
 */
function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof UnsafePathError) return 400;
  if (error instanceof UnknownProviderError) return 400;
  if (error instanceof ProviderUnavailableError) return 503;

  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) return statusCode;
  return 500;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('; ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
