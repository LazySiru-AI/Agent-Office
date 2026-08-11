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
 */

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

async function getJson<T>(url: string, schema: Parseable<T>): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status}): ${await readErrorMessage(res)}`);
  }
  return schema.parse(await res.json());
}

async function postJson<T>(url: string, body: unknown, schema: Parseable<T>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(API.cancelRun(runId), { method: 'POST' });
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
    headers: { 'Content-Type': 'application/json' },
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
