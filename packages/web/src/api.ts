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
  type AgentSummary,
  type CreateRunRequest,
  type ProviderInfo,
  type ReportResponse,
  type RunEventsResponse,
  type RunState,
  type RunSummary,
  type TeamDecision,
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
 * `authToken` (below) is non-empty. This file does NOT attach a token to the
 * WebSocket connection `state/socket.ts` opens — that file is unowned by this
 * change and the dev flow does not need it to: `vite.config.ts`'s proxy
 * attaches the header to the proxied `/ws` upgrade itself, transparently to
 * both the browser's native `WebSocket` (which cannot set custom headers on
 * an upgrade at all) and to `socket.ts`'s own code.
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
    try {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    } catch {
      // Storage denied (private browsing in some engines, disabled by
      // policy) does not make the token unusable for this page load — it is
      // still returned below and used for every request this tab makes from
      // here on. It only means a refresh will need the URL pasted again,
      // which is a worse but still safe fallback, not a broken one.
    }
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
 */
const authToken = bootstrapAuthToken();

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
    throw new Error(`GET ${url} failed (${res.status}): ${await readErrorMessage(res)}`);
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
    throw new Error(`POST ${url} failed (${res.status}): ${await readErrorMessage(res)}`);
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
    throw new Error(`cancel run failed (${res.status}): ${await readErrorMessage(res)}`);
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
    throw new Error(`submit team decision failed (${res.status}): ${await readErrorMessage(res)}`);
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
