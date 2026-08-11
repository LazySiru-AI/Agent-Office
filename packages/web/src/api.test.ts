import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelRun,
  createRun,
  fetchAgents,
  fetchProviders,
  fetchRun,
  fetchRuns,
  submitTeamDecision,
} from './api.js';

/**
 * `api.ts` is the one place every HTTP response is supposed to pass through
 * its shared zod schema before a component ever sees it (see the file
 * header there). That promise is only as good as what happens at the two
 * edges: a response that doesn't match its schema, and a response whose
 * status isn't 2xx. Neither of those should ever reach a caller as
 * `undefined` fields or a resolved promise — both must surface as a thrown,
 * readable `Error`, which is what every test below checks.
 *
 * `fetch` is stubbed per test rather than pulled in as a library — Node's
 * built-in global `fetch` is what `api.ts` actually calls, so replacing
 * `globalThis.fetch` with a `vi.fn()` exercises the real code path with no
 * network involved.
 */

function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300): Response {
  return {
    ok,
    status,
    statusText: `status ${status}`,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A response whose body cannot be parsed as JSON at all (e.g. an empty 500 from a proxy). */
function unparseableResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: `status ${status}`,
    json: () => Promise.reject(new Error('Unexpected end of JSON input')),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAgents — the happy path parses through AgentListResponseSchema', () => {
  it('resolves to the agents array when the body matches the schema', async () => {
    const agents = [{ name: 'writer', category: 'content', description: 'writes things', tools: ['Read'] }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agents }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAgents()).resolves.toEqual(agents);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents');
  });
});

describe('a schema mismatch throws instead of handing a caller a bad shape', () => {
  it('rejects when a required field is missing from the response body', async () => {
    // "name" is required by AgentSummarySchema; this body omits it entirely.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { agents: [{ category: 'x' }] })));

    await expect(fetchAgents()).rejects.toThrow();
  });

  it('rejects when a field has the wrong type, rather than silently coercing or passing it through as undefined', async () => {
    // "id" must be a string per ProviderInfoSchema; this body sends a number.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { providers: [{ id: 42, available: true }] })),
    );

    await expect(fetchProviders()).rejects.toThrow();
  });

  it('rejects when the top-level shape is wrong (an array where an object was expected)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, [])));

    await expect(fetchRuns()).rejects.toThrow();
  });
});

describe('a non-2xx GET surfaces a readable error, never a resolved promise', () => {
  it('includes the status code and the server-provided error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'no such run' })));

    await expect(fetchRun('missing-run')).rejects.toThrow(/404/);
    await expect(fetchRun('missing-run')).rejects.toThrow(/no such run/);
  });

  it('falls back to the raw JSON body when there is no `error` string field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { unexpected: 'shape' })));

    await expect(fetchRun('r1')).rejects.toThrow(/unexpected/);
  });

  it('falls back to statusText when the error body cannot be parsed as JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unparseableResponse(502)));

    await expect(fetchRun('r1')).rejects.toThrow(/status 502/);
  });
});

describe('createRun — client-side validation and the POST happy path', () => {
  it('sends the request body as JSON and resolves to the new run id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { runId: 'run-123' }));
    vi.stubGlobal('fetch', fetchMock);

    const runId = await createRun({ task: 'do the thing', provider: 'claude-code', concurrency: 2 });

    expect(runId).toBe('run-123');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ task: 'do the thing', provider: 'claude-code', concurrency: 2 });
  });

  it('rejects an invalid request (empty task) before ever calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRun({ task: '' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx POST response as a readable error', async () => {
    // concurrency: 5 passes CreateRunRequestSchema's own client-side check
    // (max 12), so this exercises the server's rejection, not the client's.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'provider unavailable' })));

    await expect(createRun({ task: 'do the thing', concurrency: 5 })).rejects.toThrow(/provider unavailable/);
  });

  it('rejects when the create response is missing runId, rather than resolving to undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})));

    await expect(createRun({ task: 'do the thing' })).rejects.toThrow();
  });
});

describe('cancelRun — a fire-and-forget POST with no body to parse', () => {
  it('resolves with no error on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})));
    await expect(cancelRun('run-1')).resolves.toBeUndefined();
  });

  it('surfaces a non-2xx response as a readable error naming the run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { error: 'run already finished' })));
    await expect(cancelRun('run-1')).rejects.toThrow(/run already finished/);
  });
});

describe('submitTeamDecision (FR-M11) — POSTs the operations, no response body to parse', () => {
  it('sends the decision as JSON to the run-specific team route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await submitTeamDecision('run-1', { operations: [{ op: 'drop', assignmentId: 'a1' }] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/runs/run-1/team');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ operations: [{ op: 'drop', assignmentId: 'a1' }] });
  });

  it('an empty operations array — "the team is right, go" — is a valid request, not rejected client-side', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitTeamDecision('run-1', { operations: [] })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('surfaces a non-2xx response as a readable error, e.g. the server refusing an illegal drop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: 'assignment "a1" is still depended on' })),
    );

    await expect(
      submitTeamDecision('run-1', { operations: [{ op: 'drop', assignmentId: 'a1' }] }),
    ).rejects.toThrow(/still depended on/);
  });
});
