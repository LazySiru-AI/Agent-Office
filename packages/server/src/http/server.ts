import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import {
  API,
  ClientMessageSchema,
  CreateRunRequestSchema,
  TeamDecisionSchema,
  isRunTerminal,
  type AgentDef,
  type AgentSummary,
  type RunState,
  type ServerMessage,
} from '@agent-office/shared';
import { applyTeamOperations } from '../orchestrator/team.js';
import type { Registry } from '../registry/index.js';
import { UnknownProviderError, probeProviders } from '../providers/factory.js';
import { ProviderUnavailableError } from '../providers/types.js';
import { UnsafePathError, type RunStore } from '../store/types.js';
import { assertValidRunId } from '../store/util.js';
import { AUTH_TOKEN_HEADER, AUTH_TOKEN_QUERY_PARAM, extractProvidedToken, tokensMatch } from './authToken.js';
import { collectRunEvents } from './runEvents.js';
import { RunConcurrencyLimitError, type RunSupervisor } from './supervisor.js';

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
  /**
   * The startup token every `/api` route and the WebSocket upgrade require
   * (AO-6, `authToken.ts`). Mandatory rather than defaulted-when-absent on
   * purpose: an optional field invites a construction site that forgets it,
   * and "forgot to pass a credential" failing closed (a type error) is a very
   * different outcome from it failing open (no auth at all). `serve.ts`
   * resolves one with `resolveAuthToken` before calling this; tests pass a
   * fixed value from the same helper.
   */
  token: string;
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
  providers: API.providers(),
  runs: API.runs(),
  run: toPattern(API.run(RUN_ID_PLACEHOLDER)),
  cancelRun: toPattern(API.cancelRun(RUN_ID_PLACEHOLDER)),
  runTeam: toPattern(API.runTeam(RUN_ID_PLACEHOLDER)),
  runReport: toPattern(API.runReport(RUN_ID_PLACEHOLDER)),
  assignmentReport: toPattern(API.assignmentReport(RUN_ID_PLACEHOLDER, 'x')),
  runEvents: toPattern(API.runEvents(RUN_ID_PLACEHOLDER)),
  runPdf: toPattern(API.runPdf(RUN_ID_PLACEHOLDER)),
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

/**
 * Hosts this server accepts on the `Host` header.
 *
 * `LOOPBACK_ORIGIN` above is not a substitute for this, and the gap is not
 * academic: it is DNS rebinding. A browser's same-origin check is keyed off
 * the *name* the page was loaded from, not the IP that name resolves to on any
 * given request. An attacker serves a page from `attacker.example` with a
 * DNS record on a very short TTL, waits for the browser to cache "same origin
 * as `attacker.example`" for that page, then re-points the name at
 * `127.0.0.1`. The page's next `fetch` to `attacker.example` is still
 * same-origin as far as the browser is concerned — no `Origin` header is even
 * sent, so `LOOPBACK_ORIGIN` never runs — yet the TCP connection it opens
 * lands on this loopback server. Every route becomes readable and callable by
 * a page the user never pointed at this server on purpose, because nothing
 * here checks that the request actually arrived by the name it claims.
 *
 * The `Host` header is the one thing a rebound request cannot launder: it is
 * set by the browser from the URL the page navigated to, which is still
 * `attacker.example`, independent of which IP the connection actually went
 * to. Refusing anything but the loopback names this process answers on
 * (`serve.ts` hard-codes the bind address to `127.0.0.1` — NFR-6 forbids a
 * `--host` flag that could point it anywhere else) closes exactly the gap
 * `LOOPBACK_ORIGIN` cannot.
 *
 * **This does NOT on its own close the CSRF hole on
 * `POST /api/runs/:id/cancel`, and an earlier version of this comment claimed
 * it did.** The claim is wrong in a way worth recording, because it is the
 * natural mistake to make about these two headers. `Host` is the URL the
 * request was sent *to*; a page on `evil.example` fetching
 * `http://127.0.0.1:5179/...` sends `Host: 127.0.0.1:5179`, which is a
 * genuinely loopback host and passes this check — the foreign name appears
 * only in `Origin`. So this regex stops the *rebinding* shape (attacker's name
 * in `Host`) and nothing else. Reproduced against a running server while the
 * claim was still in the file: a foreign origin read the full run list and
 * cancelled a live run, both with a 200.
 *
 * The Origin check in `onRequest` is the other half, and neither half is
 * redundant: `Host` covers the browser case that sends no Origin at all
 * (rebinding), `Origin` covers the ordinary cross-origin case that sends a
 * perfectly valid Host.
 *
 * `[::1]` is the RFC 3986 form a real browser sends; the bare, bracket-less
 * `::1` is accepted too because some non-browser loopback callers (curl,
 * scripts) send it that way, and it is exactly as trustworthy — nothing
 * outside this machine can claim it.
 */
const LOOPBACK_HOST = /^(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|\[::1\](:\d+)?|::1)$/i;

/**
 * `undefined` covers both "header absent" and the shape TypeScript gives a
 * header that was never sent — `.inject()` cannot actually construct a
 * request with no `Host` header (see `server.test.ts`), but a raw socket
 * talking HTTP/1.0 can, and this must refuse that exactly like it refuses
 * `attacker.example`.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  return typeof host === 'string' && LOOPBACK_HOST.test(host);
}

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
    // Checked first and unconditionally — before the Origin/CORS logic below,
    // before content-type parsing, before any route runs. See `LOOPBACK_HOST`
    // above for why an Origin allowlist alone does not stop a DNS-rebound
    // request, and why this has to be the thing that runs first.
    const host = request.headers.host;
    if (!isLoopbackHost(host)) {
      void reply.status(403).send({
        error:
          typeof host === 'string' && host.length > 0
            ? `Host header "${host}" is not a loopback address`
            : 'missing Host header',
      });
      return;
    }

    /**
     * A present-but-foreign `Origin` is REFUSED, not merely denied a CORS
     * header. This is the half the Host check above cannot cover, and the two
     * are not interchangeable.
     *
     * `Host` reflects the URL the request was sent TO; `Origin` reflects the
     * page it came FROM. A page on `https://evil.example` fetching
     * `http://127.0.0.1:5179/api/runs` therefore sends `Host: 127.0.0.1:5179`
     * — which is a perfectly good loopback host and passes the check above —
     * alongside `Origin: https://evil.example`. Only the DNS-rebinding shape
     * (where the *name* is the attacker's) is stopped by `Host`.
     *
     * Before this, `Origin` was computed and used only to decide whether to
     * echo `access-control-allow-origin`, which is a decision about what the
     * BROWSER will let script read — a rule the browser enforces on behalf of
     * a well-behaved page, and one that does not apply at all to the two
     * things that actually matter here:
     *
     * - **Side effects.** The wildcard content-type parser above makes a
     *   bodyless `POST /api/runs/:id/cancel` a CORS "simple request": no
     *   preflight, and the handler runs before any response header is read.
     *   Withholding the CORS header afterwards does not un-cancel the run.
     *   Verified against a running server: a foreign origin cancelled a live
     *   run and got a 200.
     * - **WebSockets.** `/ws` is not subject to the same-origin policy at all.
     *   Any page could open `ws://127.0.0.1:<port>/ws` and receive the whole
     *   event stream — run state, log lines, deliverable content — with no
     *   interaction beyond being open in a tab.
     *
     * An ABSENT `Origin` still passes, deliberately. Non-browser clients
     * (curl, the run CLI, a test harness) send none, and a request with no
     * Origin is not a cross-origin request from a page — it is the ordinary
     * local case NFR-6 is built around. The `Host` check is what covers the
     * one browser situation that also omits Origin, which is precisely DNS
     * rebinding.
     */
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      if (!LOOPBACK_ORIGIN.test(origin)) {
        void reply
          .status(403)
          .send({ error: `Origin "${origin}" is not a loopback origin` });
        return;
      }
      void reply.header('access-control-allow-origin', origin);
      void reply.header('vary', 'origin');
    }

    /**
     * The startup token (AO-6, NFR-6's other half — see `authToken.ts`'s
     * header comment for the attack this closes: loopback is not a user
     * boundary, and everything checked above this line is about the SHAPE of
     * the request, never about who sent it).
     *
     * Deliberately the last check in this hook, not the first. `Host` and
     * `Origin` are cheap, allocate nothing, and their failure messages are
     * safe to be specific ("not a loopback address") because they describe
     * something the caller already sent in plaintext. Token failure is the
     * one case here worth reaching last: if a foreign `Host` or `Origin`
     * request also carries a missing/wrong token, the response it gets is the
     * `Host`/`Origin` 403, not a 401 — one fewer bit of information ("this
     * process also wants a token") handed to a rebinding attempt that was
     * always going to fail anyway.
     *
     * CORS preflight (`OPTIONS`) is exempt. A browser preflight is generated
     * by the browser itself, never by page script, and it cannot be made to
     * carry `AUTH_TOKEN_HEADER` — the whole point of `Access-Control-Request-
     * Headers` is to ASK whether that header will be allowed on the real
     * request, before any application code (or credential) is involved.
     * Requiring the token here would make the preflight itself fail, which
     * means the real, authenticated request behind it would never be sent by
     * any browser — a self-inflicted outage, not a security improvement,
     * since the preflight response carries nothing but CORS headers and an
     * empty body. The real request that follows is still checked exactly like
     * every other route.
     */
    if (request.method !== 'OPTIONS') {
      const provided = extractProvidedToken(
        request.headers[AUTH_TOKEN_HEADER],
        (request.query as Record<string, unknown> | undefined)?.[AUTH_TOKEN_QUERY_PARAM],
      );
      if (!tokensMatch(deps.token, provided)) {
        // 401, not 403: `Host`/`Origin` failures above are refusals that hold
        // regardless of who is asking ("this request could not possibly be
        // legitimate"); a missing/wrong token is the standard "supply a valid
        // credential" case, and 401 is the code with that specific meaning.
        // The message says neither which check failed nor what was received —
        // "invalid" covers "absent" and "wrong" identically, so a caller
        // fishing for confirmation that a guessed prefix was on the right
        // track learns nothing from the response shape.
        void reply.status(401).send({ error: 'missing or invalid token' });
        return;
      }
    }
  });

  // Preflight for the same loopback origins. Registered as a wildcard route
  // because the not-found handler would otherwise answer OPTIONS with a 404 and
  // the browser would never send the real request.
  //
  // `access-control-allow-headers` has to list `AUTH_TOKEN_HEADER` alongside
  // `content-type`, and this is not optional decoration: a custom header is
  // exactly what makes a cross-port request "non-simple" and triggers a
  // preflight in the first place, so a browser that preflights, sees its
  // intended header absent from this list, and refuses to send it on the real
  // request would make every authenticated call from the web client fail —
  // silently, from this route's point of view, since the preflight itself
  // still answers 204.
  app.options('/*', async (_request, reply) => {
    void reply
      .header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', `content-type, ${AUTH_TOKEN_HEADER}`)
      .status(204)
      .send();
  });

  // --- Health -------------------------------------------------------------
  // Not in the contract's schema set because there is nothing for the client to
  // parse beyond "the server answered". It doubles as the readiness probe the
  // web dev server polls before opening a socket.
  //
  // DECISION (AO-6): not exempted from the token check above, even though it
  // was the one route worth considering for it. The response includes
  // `liveRunIds` — which runs this account's process is currently spending
  // money executing — and that is precisely the kind of fact NFR-6's "no
  // auth" gap let any local process read for free. Exempting the one route
  // that still leaks something would reopen a sliver of AO-6 for a benefit
  // that does not exist: nothing in this codebase calls `/api/health` before
  // it has a token to send (the web client's poller, if and when one exists,
  // goes through `api.ts`'s wrapper exactly like every other route; the Vite
  // proxy injects the header for every `/api/*` path uniformly, `/api/health`
  // included). "Every `/api` route" in the finding is read literally.
  app.get(ROUTES.health, async () => ({
    ok: true,
    serverTime: Date.now(),
    liveRunIds: deps.supervisor.liveRunIds(),
  }));

  // --- Agent roster (FR-R1) ------------------------------------------------
  app.get(ROUTES.agents, async () => ({
    agents: deps.registry.agents.map(toAgentSummary),
  }));

  // --- Provider readiness (Phase 7) ----------------------------------------
  //
  // Each provider's own `isAvailable()` answers this, rather than the route
  // re-deriving it from environment variables: the adapter is the thing that
  // knows what it needs, and a second copy of that rule here would drift the
  // first time one of them changed. The contract for `isAvailable` is that it
  // makes no network call, so this route is cheap and cannot hang.
  app.get(ROUTES.providers, async () => ({
    providers: await probeProviders(new Set(deps.registry.byName.keys())),
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

  /**
   * Approve (and optionally edit) the proposed team (FR-M11).
   *
   * This is a state-changing POST with a body, exactly the shape the long
   * comment on `onRequest` above is about: the `Host`/`Origin` checks it
   * describes run unconditionally for every route registered on `app`, this
   * one included, so a foreign page cannot release a parked run any more than
   * it can cancel one. Nothing route-specific has to be added for that here —
   * only getting the route registered the normal way is required, and the
   * cross-origin test alongside `cancel`'s covers that it actually inherited
   * the hook rather than the hook having been bypassed by accident.
   *
   * The 409 branch is deliberately one message covering several causes — run
   * never asked to pause, already dispatching, already decided, or cancelled
   * out from under the pause — because `supervisor.submitTeamDecision`
   * reports only whether it had something to resolve, not why it did not
   * (see its own doc comment for that trade-off). A caller does not need the
   * distinction: every one of those means "this is not the moment to approve
   * a team", which is exactly what FR-M11 asks the route to refuse. Modelled
   * on `cancelRun` immediately above, right down to fetching `run` before the
   * verb that might change it, so the body returned on success reflects what
   * the client asked about, not a state the resolve may not have reached yet.
   */
  app.post(ROUTES.runTeam, async (request) => {
    const runId = parseRunId(request.params);
    const parsed = TeamDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, `invalid request body: ${formatIssues(parsed.error)}`);
    }

    const run = await loadRun(deps, runId);

    /**
     * Validate the edits HERE, while the run is still parked, rather than
     * letting `executeRun` discover the problem after the decision is released.
     *
     * Found by driving the assembled feature against a live server rather than
     * by a test: posting a `drop` of an assignment two others depended on
     * returned **200**, and the run then went to `failed`. Both halves were
     * behaving reasonably on their own — `applyTeamOperations` correctly
     * refused an edit that would strand a dependency, and the runner correctly
     * refused to dispatch a plan the user had not approved rather than silently
     * falling back to the Manager's original. The defect was in the seam: the
     * only place that could still *recover* was this route, and it had already
     * answered "OK" and let go.
     *
     * A run destroyed by a typo is a bad outcome for a feature whose entire
     * purpose is to give the user control before anything is spent, and it is
     * worse than the control being absent, because the 200 says it worked.
     * So the trust boundary does the validating, exactly as it already does for
     * a malformed body two statements above: an unacceptable decision is a 400
     * naming what is wrong, and the run stays parked for a corrected one.
     *
     * This is a dry run, deliberately — the authoritative application still
     * happens in `executeRun` against the plan it holds. Two evaluations of the
     * same pure function over the same inputs cannot disagree, and keeping the
     * runner's check means the guarantee "nothing unapproved is ever
     * dispatched" does not depend on every future caller of
     * `submitTeamDecision` remembering to pre-validate.
     */
    if (parsed.data.operations.length > 0) {
      if (run.plan === undefined) {
        throw new HttpError(409, `run "${runId}" has no plan to edit yet (status: ${run.status})`);
      }
      const dryRun = applyTeamOperations(
        run.plan,
        parsed.data.operations,
        new Set(deps.registry.byName.keys()),
      );
      if ('error' in dryRun) {
        throw new HttpError(400, `team decision rejected: ${dryRun.error}`);
      }
    }

    if (deps.supervisor.submitTeamDecision(runId, parsed.data.operations)) return run;

    throw new HttpError(
      409,
      isRunTerminal(run.status)
        ? `run "${runId}" has already finished (${run.status})`
        : `run "${runId}" is not awaiting team approval (status: ${run.status})`,
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

    // The run IS loaded first, and that reverses an earlier decision worth
    // recording. The old comment here said an existence check was unnecessary
    // because `readReport` rejects any path escaping the run directory, "which
    // is the check that actually matters". Containment was never the only thing
    // that mattered: it makes the run directory the boundary, and the run
    // directory holds `run.json`, the `logs/*.jsonl` replay records, and
    // `workspace/` — which is where NFR-1 deliberately puts the output of an
    // agent nobody trusts. All three were served in full through this route on
    // request. On a loopback server with no authentication (NFR-6) that is a
    // read-any-file-in-any-run primitive, reachable by anything that can make
    // an HTTP request from this machine.
    //
    // So the rule is now "a file this run declares as a report", not "a file
    // inside this run's directory". Matching against `reportPath` rather than
    // against the plan's `deliverable` is the stricter of the two readings and
    // the right one: `reportPath` is set only once an assignment has actually
    // succeeded and written its file, so a path that was merely *planned* is
    // not servable either.
    const run = await loadRun(deps, runId);
    const declared = new Set<string>(
      run.assignments
        .map((assignment) => assignment.reportPath)
        .filter((reportPath): reportPath is string => reportPath !== undefined),
    );
    if (run.reportPath !== undefined) declared.add(run.reportPath);

    if (!declared.has(query.data.path)) {
      // 404, not 403: whether some other file exists inside this run directory
      // is not something an unauthenticated caller should be able to probe, and
      // a distinguishable "forbidden" would answer exactly that question. The
      // message names no path for the same reason.
      throw new HttpError(404, `run "${runId}" has no report at that path`);
    }

    return readReport(deps, runId, query.data.path);
  });

  // --- PDF download (FR-P5) ------------------------------------------------
  app.get(ROUTES.runPdf, async (request, reply) => {
    const runId = parseRunId(request.params);
    const run = await loadRun(deps, runId);

    if (run.pdfPath === undefined) {
      // Distinguished from a missing run so the client can say "not ready yet"
      // rather than "no such run" — the difference matters while a run is still
      // working its way to `designing`.
      throw new HttpError(
        404,
        `run "${runId}" has no PDF yet (status: ${run.status})`,
      );
    }

    const bytes = await deps.store.readBinary(runId, run.pdfPath);

    // `attachment` rather than `inline`: FR-P5 asks for a download, and a
    // filename carrying the run id is what makes several exported runs
    // distinguishable in a downloads folder.
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="agent-office-${runId}.pdf"`)
      .header('Content-Length', String(bytes.byteLength))
      .send(bytes);
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
 * Any load failure becomes a 404. It used to carry the store's own message —
 * useful, because that message distinguishes "no such directory" from
 * "run.json does not match the schema" — but `fileStore.ts`'s message is
 * `cannot read run state at ${absolute path}: ...`, and `describe(error)` was
 * forwarding that verbatim into the HTTP body. `GET /api/runs/<unknown-id>`
 * was handing back the runs root's full filesystem path, Windows username
 * included, to whoever asked. Same discipline as {@link readReport} below:
 * report that the run was not found, never the path the store tried.
 */
async function loadRun(deps: ServerDeps, runId: string): Promise<RunState> {
  try {
    return await deps.supervisor.getRunState(runId);
  } catch {
    throw new HttpError(404, `run "${runId}" not found`);
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
  // 429, not 503: the server is not degraded and nothing about it is
  // unavailable — a slot is simply spoken for by another run right now, which
  // is exactly what "Too Many Requests" describes and "Service Unavailable"
  // does not. It is also not a 403: a request that arrives ninety seconds
  // later, once a run has finished, is expected to succeed with the same
  // token and the same body, which is what makes this a rate/capacity signal
  // rather than a refusal of the caller. See `supervisor.ts`'s
  // `RunConcurrencyLimitError` for what the cap is protecting — every run
  // spawns real, billed child processes, so unlike most 429s this one is a
  // cost control, not a throughput nicety.
  if (error instanceof RunConcurrencyLimitError) return 429;

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
