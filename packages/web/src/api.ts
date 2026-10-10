import { z } from 'zod';
import {
  API,
  AgentListResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  ProviderListResponseSchema,
  ReportResponseSchema,
  RunEventsResponseSchema,
  RunListResponseSchema,
  RunStateSchema,
  TeamDecisionSchema,
  ClarificationDecisionSchema,
  type AgentSummary,
  type CreateRunRequest,
  type ProviderInfo,
  type ReportResponse,
  type RunEventsResponse,
  type RunState,
  type RunSummary,
  type TeamDecision,
  type ClarificationDecision,
} from '@agent-office/shared';

/**
 * Thin fetch wrappers around the HTTP surface in `wire.ts`.
 *
 * Every URL comes from the `API` helper — never a hand-typed path string, so a
 * route rename on the server side is a compile error here rather than a
 * silent 404. Every response body is parsed with its zod schema before a
 * caller sees it: the server is a separate process, built in parallel, and a
 * shape mismatch should fail loudly at the fetch boundary rather than surface
 * as `undefined` deep inside a component.
 *
 * AO-6 (`packages/server/src/http/authToken.ts`) adds one more thing every
 * function below has to get right: the server now refuses every `/api` route
 * without a token, so every request this file issues attaches one whenever
 * `authToken` (below) is non-empty.
 *
 * ## A1: the two requests that cannot carry a header
 *
 * `state/socket.ts`'s WebSocket upgrade and `panels/PdfDownload.tsx`'s
 * download anchor both authenticate through `appendToken` (below) instead of
 * `AUTH_TOKEN_HEADER`, and for the same reason each: a native browser
 * `WebSocket` cannot set custom headers on its upgrade request at all, and a
 * plain `<a href download>` is a browser-native navigation, not a `fetch`
 * this file's code is in the loop for — there is no request object to attach
 * a header to either way. `AUTH_TOKEN_QUERY_PARAM` is `authToken.ts`'s own
 * fallback for exactly this shape of caller, and `extractProvidedToken`
 * there accepts it on any request that carries it, not only a first
 * navigation — see that function's doc comment for why that is safe. Both
 * call sites export the *decision* (`appendToken`) as a pure function taking
 * the token as a parameter, rather than reading the module-level `authToken`
 * themselves, so the URL-building logic is unit-testable without the
 * `vi.resetModules()` + dynamic-`import()` dance the AO-6 bootstrap tests
 * below need (this module resolves its own token exactly once, at import
 * time, against whatever `window` existed then).
 *
 * This was fine to leave unfixed behind the Vite dev proxy (`vite.config.ts`
 * injects the header onto the proxied `/ws` upgrade itself, transparently to
 * both the browser's native `WebSocket` and to `socket.ts`'s own code) but
 * not behind `npm run serve` on its own, which is the documented way to run
 * this app: with no proxy to inject anything, an upgrade or a download with
 * no token attached 401s exactly like any other unauthenticated request.
 */

/**
 * Mirrors `AUTH_TOKEN_HEADER` / `AUTH_TOKEN_QUERY_PARAM` in
 * `packages/server/src/http/authToken.ts` exactly. Duplicated rather than
 * imported for the same reason `vite.config.ts` duplicates them: this
 * package does not depend on `@agent-office/server`, and should not grow that
 * dependency for two string constants. If the two drift, the symptom is every
 * request in this file coming back 401 despite a token being present —
 * which is exactly why each copy names where its counterpart lives.
 */
const AUTH_TOKEN_HEADER = 'x-agent-office-token';
const AUTH_TOKEN_QUERY_PARAM = 'token';

/** Where the token lives between page loads, once bootstrapped off the URL. */
const TOKEN_STORAGE_KEY = 'agent-office-token';

/**
 * Read the token off the URL exactly once, on first load, and never again
 * (AO-6).
 *
 * `serve.ts` prints a URL of the form `http://127.0.0.1:<port>/?token=...`,
 * the Jupyter pattern — a browser's very first, top-level navigation to that
 * URL is a request no script is in the loop for yet, so a query parameter is
 * the only place a token can travel on that one request. Everything after
 * that is issued by THIS file's own code, which can and does use a header
 * instead (see `getJson`/`postJson` below) — and a header is the materially
 * better place for a bearer credential to live for the rest of the session:
 * a URL is copied into browser history, sync services, crash reports, and
 * `Referer` headers sent to any third-party resource the page loads, none of
 * which a request header is ever exposed to. So the token is read off the
 * URL, written to `sessionStorage`, and immediately scrubbed from the address
 * bar with `history.replaceState` — the query parameter is a one-time
 * bootstrap, not a channel this app keeps using.
 *
 * `sessionStorage` rather than `localStorage`: the token is only as good as
 * the server process that minted it, which does not outlive the terminal
 * `npm run serve` was run in, so persisting it past the tab's own lifetime
 * would just accumulate stale, unusable values.
 *
 * NOTE: this bootstrap is dead code for the ordinary `npm run web` dev flow
 * (see `vite.config.ts`), which never needs a token pasted in at all — the
 * proxy attaches the header itself. It exists for the case that flow's proxy
 * does not cover: opening this app's built output directly against the API
 * server with no Vite dev proxy in front of it.
 */
/**
 * Write a token to the one storage slot every request in this file reads
 * from (`TOKEN_STORAGE_KEY`, `sessionStorage`). Pulled out of
 * `bootstrapAuthToken` below so `setAuthToken` (S9 — the 401-recovery path)
 * writes to the exact same slot the same way, rather than growing a second,
 * slightly different copy of this try/catch. Best-effort, matching every
 * other storage write in this codebase (`state/useRun.ts`'s
 * `writeStoredRunId`, `theme/useTheme.ts`'s `writeStorage`): a denied write
 * (private browsing in some engines, disabled by policy) must not make the
 * token this call already has in hand unusable for the rest of THIS tab's
 * life, it only means the next page load will need it supplied again.
 */
function persistToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // See doc comment above — a denied write is not a reason to fail here.
  }
}

function bootstrapAuthToken(): string | undefined {
  // `typeof window === 'undefined'` rather than a bare reference: this
  // module is imported by `api.test.ts` under vitest's default Node
  // environment, which has no DOM globals at all. A bare `window.location`
  // there would throw at import time instead of simply finding no token —
  // production use is always a real browser tab, where this branch is never
  // taken.
  if (typeof window === 'undefined') return undefined;

  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get(AUTH_TOKEN_QUERY_PARAM);
  if (fromUrl !== null && fromUrl.length > 0) {
    persistToken(fromUrl);
    url.searchParams.delete(AUTH_TOKEN_QUERY_PARAM);
    window.history.replaceState(window.history.state as unknown, '', url.toString());
    return fromUrl;
  }

  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolved once, at module load, not per request: the bootstrap above already
 * mutates the URL and storage as a side effect that must happen exactly once
 * per page load, and re-running it on every `fetch` would either repeat that
 * mutation harmlessly (the URL no longer has the parameter, so nothing
 * happens) or, worse, silently stop sending the token the moment the URL
 * lookup starts missing it, even though it is still sitting in
 * `sessionStorage`. Resolving once and holding the result sidesteps both.
 *
 * Exported (previously module-private) for the two callers described in the
 * A1 section of this file's header — `state/socket.ts` and
 * `panels/PdfDownload.tsx` — which need the same resolved value this file's
 * own `getJson`/`postJson` already attach as a header, but as a query
 * parameter instead.
 *
 * `let`, not `const` (S9): every reader of this binding — `getJson`,
 * `postJson`, the three hand-rolled `fetch` calls below, `socket.ts`'s
 * `wsUrl()`, `PdfDownload.tsx`'s render — reads the identifier fresh each
 * time it runs rather than capturing its value at import time, because none
 * of them destructure it into a local at module load. That is what makes
 * `setAuthToken` below sufficient on its own to fix every one of those call
 * sites after a 401: there is exactly one live binding, and updating it here
 * updates what every future call anywhere in the app sees, with no second
 * "now go tell socket.ts and PdfDownload.tsx" step required. Still meant as
 * read-only from outside this module — nothing external should assign to it
 * directly, only call `setAuthToken`, which also keeps `sessionStorage` in
 * sync (a bare assignment would not).
 */
export let authToken: string | undefined = bootstrapAuthToken();

/**
 * S9: give the app a way back in after a 401, without a reload and without
 * the token ever touching the URL.
 *
 * This is the ONLY other place besides `bootstrapAuthToken` that is allowed
 * to change what `authToken` resolves to — see that binding's own comment
 * for why a plain reassignment elsewhere in the app would be the wrong
 * move (it would desync `sessionStorage` from the in-memory value, so a
 * same-tab reload immediately after re-auth would silently revert to the
 * stale token). Reuses `persistToken`, the exact helper
 * `bootstrapAuthToken` itself uses for the URL-bootstrap case, so both
 * paths that ever populate `TOKEN_STORAGE_KEY` do it identically — this is
 * not a second, hand-kept copy of that logic.
 *
 * Takes the token as already-validated input rather than re-validating it
 * here: `panels/AuthRecovery.tsx`'s `isSubmittableToken` is the actual gate
 * (a blank/whitespace-only input never reaches this function at all), the
 * same split `useSettings.ts`'s file header describes between one-time
 * parsing and live, user-facing validation — this function's job is only
 * "make X the token from now on", not "decide whether X looks like one".
 */
export function setAuthToken(token: string): void {
  persistToken(token);
  authToken = token;
}

// ---------------------------------------------------------------------------
// S9: a 401 becomes app state.
//
// `api.ts` throws on every non-2xx response (see `getJson`/`postJson` and the
// three hand-rolled `fetch` calls below) — that promise rejection is already
// enough for the ONE call site that triggered it to show an error, but a
// token going bad (a new tab, a cleared session, a stale bookmark) is not a
// one-call-site problem: every fetch anywhere in the app starts failing the
// same way at once, and no individual panel's error text ("cancel run
// failed (401): unauthorized") tells a user what actually happened or what
// to do about it.
//
// The mechanism chosen is a plain callback registry — `onUnauthorized`
// subscribes, the module notifies every subscriber when a response comes
// back 401 — rather than either of the two alternatives this file could
// have reached for instead:
//
//   - A React context / global store (Zustand, Redux, etc.). Rejected
//     because nothing else in this codebase's `state/` directory works that
//     way: `useRun.ts`, `useSettings.ts` and `useTheme.ts` are each a plain
//     hook wrapping plain, exported, independently-testable functions, and
//     `api.ts` itself has never imported React at all — introducing either
//     would make this file the one exception to a pattern the rest of
//     `state/` already commits to, for a feature that does not need it.
//
//   - `window.dispatchEvent(new CustomEvent(...))`. Rejected because this
//     file's own tests (`api.test.ts`) run under plain Node with no DOM most
//     of the time — only the "AO-6 token bootstrap" block stubs a `window`
//     at all, and only for that one describe block. Tying the 401 signal to
//     a DOM event target would make it untestable from a plain
//     `vi.stubGlobal('fetch', ...)` test the way every other test in that
//     file already is, for no benefit: nothing here needs event bubbling,
//     capture, or any other DOM-specific behaviour a `CustomEvent` buys.
//
// A callback registry needs neither: it is exactly the shape `state/socket.ts`
// already uses for its own cross-cutting notifications (`RunSocket`'s
// `onMessage`/`onStatusChange`/`onParseError` options), so a consuming hook
// subscribes to this the same way `useRun.ts` already subscribes to that.
// ---------------------------------------------------------------------------

type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Subscribe to "some request just got a 401". Returns an unsubscribe
 * function, so a hook can call this from a `useEffect` and clean up on
 * unmount the same way it already detaches a `RunSocket` — see
 * `state/useRun.ts`'s `reauthenticate`/`unauthorized` wiring.
 *
 * Fires for every 401 while unauthenticated, not just the first — a caller
 * that only wants to know "am I currently locked out", not "how many times
 * have I been locked out", is expected to collapse repeats itself (a boolean
 * flip is idempotent), which is simpler than this function guessing at
 * de-duplication semantics a caller didn't ask for.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

/**
 * The one place "is this failure the kind a fresh token fixes" is decided.
 * Exported and pure — no `Response`, just the status code already read off
 * one — so it is testable with a bare number and no `fetch` mock at all,
 * and so `readErrorMessage`/`failedResponseError` below have exactly one
 * place to ask this question rather than a `res.status === 401` literal
 * copied at every call site.
 *
 * 401 only, not 403: a 401 (`Unauthorized`) is this app's *only* status code
 * for "the credential you sent is missing or wrong" — see
 * `packages/server/src/http/authToken.ts`, which never issues a 403 at all.
 * A 403 in a different app can mean "you're authenticated, but not allowed
 * to do this", which a new token would not fix; conflating the two here
 * would be borrowing a distinction this server doesn't make.
 */
export function isRecoverableAuthFailure(status: number): boolean {
  return status === 401;
}

/**
 * Append `token=` to a URL — as `?token=` if it has no query string yet, or
 * `&token=` if it does — mirroring `AUTH_TOKEN_QUERY_PARAM` in
 * `packages/server/src/http/authToken.ts` exactly (see the constant above
 * for why that pairing is duplicated rather than imported).
 *
 * A no-op, returning `url` unchanged, when `token` is `undefined` — the
 * ordinary case behind the Vite dev proxy, which injects `AUTH_TOKEN_HEADER`
 * itself and never needs a query parameter at all. Both call sites pass this
 * file's own `authToken` at the point they build a URL, so they see exactly
 * the value the rest of this file is already using for every other request.
 *
 * Takes `token` as a parameter rather than closing over `authToken` directly
 * so it can be unit-tested as a pure function with no module-load-order
 * dependency — see the A1 section above for why that matters here
 * specifically.
 */
export function appendToken(url: string, token: string | undefined): string {
  if (token === undefined) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${AUTH_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

interface Parseable<T> {
  parse: (data: unknown) => T;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
    ) {
      return (body as { error: string }).error;
    }
    return JSON.stringify(body);
  } catch {
    return res.statusText;
  }
}

/**
 * The single choke point every non-2xx response in this file passes through
 * (S9). Every one of the five call sites below used to build its own
 * `new Error(...)` inline, each with a slightly different prefix
 * ("GET ... failed", "cancel run failed", ...) but the identical shape
 * otherwise — this keeps that per-call-site wording (callers still pass
 * their own `prefix`) while making the 401 check a single line instead of
 * five copies that could individually be forgotten as new call sites are
 * added.
 *
 * Returns the `Error` rather than throwing it directly, so callers keep
 * `throw await failedResponseError(...)` at their own call site: TypeScript
 * can already tell control does not continue past a `throw`, which it
 * cannot for an awaited call to a function that merely PROMISES to reject
 * (`Promise<never>`) — the return-and-throw split avoids relying on that
 * inference at every one of the five sites.
 */
async function failedResponseError(prefix: string, res: Response): Promise<Error> {
  if (isRecoverableAuthFailure(res.status)) notifyUnauthorized();
  return new Error(`${prefix} (${res.status}): ${await readErrorMessage(res)}`);
}

/**
 * `fetch(url)` — no second argument at all — when there is no token to send,
 * rather than `fetch(url, { headers: {} })` or `fetch(url, undefined)`. Not
 * cosmetic: `api.test.ts` asserts several of these calls with
 * `toHaveBeenCalledWith(url)`, and a mock call recorded with an extra
 * (even empty) second argument would fail that exact-arguments check. This
 * is also simply the more honest call to make — nothing about a request with
 * no token to attach is different from how this file behaved before AO-6.
 */
async function getJson<T>(url: string, schema: Parseable<T>): Promise<T> {
  const res =
    authToken === undefined ? await fetch(url) : await fetch(url, { headers: { [AUTH_TOKEN_HEADER]: authToken } });
  if (!res.ok) {
    throw await failedResponseError(`GET ${url} failed`, res);
  }
  return schema.parse(await res.json());
}

async function postJson<T>(url: string, body: unknown, schema: Parseable<T>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken === undefined ? {} : { [AUTH_TOKEN_HEADER]: authToken }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await failedResponseError(`POST ${url} failed`, res);
  }
  return schema.parse(await res.json());
}

export function fetchAgents(): Promise<AgentSummary[]> {
  return getJson(API.agents(), AgentListResponseSchema).then((r) => r.agents);
}

export function fetchRuns(): Promise<RunSummary[]> {
  return getJson(API.runs(), RunListResponseSchema).then((r) => r.runs);
}

/**
 * Which providers this server can actually run (Phase 7).
 *
 * Availability depends on the server's environment — an API key, a CLI on its
 * PATH — none of which the browser can see. Offering a provider the server
 * cannot construct would mean a run that fails a minute after it starts.
 */
export function fetchProviders(): Promise<ProviderInfo[]> {
  return getJson(API.providers(), ProviderListResponseSchema).then((r) => r.providers);
}

export function fetchRun(runId: string): Promise<RunState> {
  return getJson(API.run(runId), RunStateSchema);
}

export function fetchRunReport(runId: string): Promise<ReportResponse> {
  return getJson(API.runReport(runId), ReportResponseSchema);
}

export function fetchAssignmentReport(runId: string, reportPath: string): Promise<ReportResponse> {
  return getJson(API.assignmentReport(runId, reportPath), ReportResponseSchema);
}

export async function createRun(req: CreateRunRequest): Promise<string> {
  const body = CreateRunRequestSchema.parse(req);
  const res = await postJson(API.runs(), body, CreateRunResponseSchema);
  return res.runId;
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(API.cancelRun(runId), {
    method: 'POST',
    ...(authToken === undefined ? {} : { headers: { [AUTH_TOKEN_HEADER]: authToken } }),
  });
  if (!res.ok) {
    throw await failedResponseError('cancel run failed', res);
  }
}

/**
 * `POST /api/runs/:id/team` (FR-M11) — the user's verdict on the Manager's
 * proposed team, built by `panels/TeamReview.tsx`'s `buildTeamReviewModel`.
 *
 * Follows `cancelRun` above rather than `postJson`: the response carries
 * nothing the client needs back (the new `RunState` arrives over the socket
 * as a `state` push, same as every other transition — see `useRun.ts`'s
 * `applyServerMessage`), so there is no response schema to parse, only a
 * status code to check. The *request* body is still validated against
 * `TeamDecisionSchema` before it leaves the browser, for the same reason
 * `createRun` validates against `CreateRunRequestSchema`: a locally-built
 * object should fail loudly here if it drifted from the wire contract,
 * rather than arrive at the server already wrong.
 */
export async function submitTeamDecision(runId: string, decision: TeamDecision): Promise<void> {
  const body = TeamDecisionSchema.parse(decision);
  const res = await fetch(API.runTeam(runId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken === undefined ? {} : { [AUTH_TOKEN_HEADER]: authToken }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await failedResponseError('submit team decision failed', res);
  }
}

/**
 * `POST /api/runs/:id/clarify` (FR-M12) — the user's answers to the Manager's
 * questions, or their decision to plan without answering.
 *
 * Same shape and same reasoning as `submitTeamDecision` above: no response body
 * to parse (the released run arrives as a `state` push), request validated
 * against the wire schema before it leaves the browser.
 *
 * A decline posts `{ declined: true }` rather than an empty `answers` array,
 * because those are different claims to the planner — see
 * `ClarificationDecisionSchema`'s own comment. Getting that wrong here would
 * turn "I would rather you just planned it" into "every question's answer is
 * nothing", which is the one mistake this route can make that the user cannot
 * see.
 */
export async function submitClarification(
  runId: string,
  decision: ClarificationDecision,
): Promise<void> {
  const body = ClarificationDecisionSchema.parse(decision);
  const res = await fetch(API.runClarify(runId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken === undefined ? {} : { [AUTH_TOKEN_HEADER]: authToken }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await failedResponseError('submit clarification failed', res);
  }
}

/**
 * `GET /api/runs/:id/events` — the full event log, for replay (NFR-7).
 *
 * Uses the canonical schema from `wire.ts`. This briefly carried a hand-kept
 * local copy, because the shared barrel did not re-export it — a second
 * definition of a wire shape is precisely the drift `wire.ts` exists to
 * prevent, so the barrel was fixed rather than the mirror maintained.
 */
export function fetchRunEvents(runId: string): Promise<RunEventsResponse> {
  return getJson(API.runEvents(runId), RunEventsResponseSchema);
}
