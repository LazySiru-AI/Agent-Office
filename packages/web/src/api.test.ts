import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendToken,
  cancelRun,
  createRun,
  fetchAgents,
  fetchProviders,
  fetchRun,
  fetchRuns,
  isRecoverableAuthFailure,
  onUnauthorized,
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

/**
 * AO-6: the token bootstrap in `api.ts` runs once, at module load, so these
 * tests each need a fresh module instance with a purpose-built `window` stub
 * in place BEFORE that load happens — `vi.resetModules()` plus a dynamic
 * `import()` per test, rather than the static import at the top of this file
 * (which was already evaluated, in Node's windowless environment, before any
 * test body runs). The static-import tests above are unaffected by any of
 * this: `vi.resetModules()` only changes what a LATER `import()` resolves to,
 * never a binding a `import … from` already captured.
 */
/**
 * Shared by the "AO-6 token bootstrap" suite below and the "S9 token
 * recovery" suite further down — both need a fake `window` with a working
 * `sessionStorage` and a `history.replaceState` spy, and both need it built
 * fresh per test rather than sharing one instance (a stray write from one
 * test must never leak into the next). Hoisted to module scope rather than
 * left nested inside one `describe`, which is where they lived before S9
 * needed the same fakes for `setAuthToken`.
 */
function makeSessionStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
}

function stubBrowser(href: string, storage: Storage): { replaceState: ReturnType<typeof vi.fn> } {
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location: { href },
    sessionStorage: storage,
    history: { state: null, replaceState },
  });
  return { replaceState };
}

describe('AO-6 token bootstrap', () => {
  // Reset BEFORE each of these as well as after, and the "before" is the half
  // that matters. `api.ts` resolves its token once at module load, and this
  // file imports it statically at the top for every other test — so by the
  // time the first test in this block runs, the module is already cached with
  // a token resolved against a world that had no `window` at all. The dynamic
  // `import()` below would hand back that same instance, `authToken` would be
  // `undefined`, and `fetch` would be called with no init object: the failure
  // reads as "the bootstrap does not attach the header" when in fact the
  // bootstrap never re-ran.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('reads the token off the URL, attaches it to the next request, and scrubs it from the address bar', async () => {
    // WHAT THIS PREVENTS: without the bootstrap, `serve.ts`'s printed
    // `?token=...` URL would open the app with no way for `api.ts` to ever
    // learn the token — every request would 401, and the only escape would
    // be pasting the token into a header by hand, which is not a workflow
    // any browser UI here exposes.
    const { replaceState } = stubBrowser('http://127.0.0.1:5179/?token=abc123&other=kept', makeSessionStorage());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./api.js');
    await mod.fetchAgents();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-agent-office-token']).toBe('abc123');

    // Scrubbed, not left sitting in browser history — see `bootstrapAuthToken`'s
    // doc comment for why a URL is a weaker place for this than a header.
    expect(replaceState).toHaveBeenCalledTimes(1);
    const [, , newUrl] = replaceState.mock.calls[0] as [unknown, string, string];
    expect(newUrl).not.toContain('token=abc123');
    // Unrelated query parameters survive the rewrite — this is a targeted
    // deletion, not "replace the whole query string".
    expect(newUrl).toContain('other=kept');
  });

  it('persists the token to sessionStorage, so a same-tab reload after the URL is scrubbed still works', async () => {
    const storage = makeSessionStorage();
    stubBrowser('http://127.0.0.1:5179/?token=abc123', storage);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] })));

    await import('./api.js');

    expect(storage.getItem('agent-office-token')).toBe('abc123');
  });

  it('falls back to a token already in sessionStorage when the URL carries none', async () => {
    // The second and every later page view: the query parameter is long gone
    // (this file scrubbed it on the first), so this is the path that has to
    // carry the token from here on.
    stubBrowser('http://127.0.0.1:5179/runs/abc', makeSessionStorage({ 'agent-office-token': 'stored-token' }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./api.js');
    await mod.fetchAgents();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-agent-office-token']).toBe('stored-token');
  });

  it('sends no second fetch argument at all when there is no token anywhere', async () => {
    // Not just "no header" — an absent SECOND ARGUMENT. See `getJson`'s own
    // comment for why: a call recorded as `fetch(url, {})` is a different
    // call from `fetch(url)` as far as `toHaveBeenCalledWith(url)` is
    // concerned, and every test above the "AO-6 token bootstrap" block in
    // this file relies on exactly that exact-arguments shape.
    stubBrowser('http://127.0.0.1:5179/', makeSessionStorage());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./api.js');
    await mod.fetchAgents();

    expect(fetchMock).toHaveBeenCalledWith('/api/agents');
  });
});

/**
 * A1: `appendToken` is the one decision behind both fixes in this defect —
 * `state/socket.ts`'s WebSocket URL and `panels/PdfDownload.tsx`'s download
 * href, neither of which can carry `AUTH_TOKEN_HEADER` the way this file's
 * own `getJson`/`postJson` do. It is deliberately parameterised over `token`
 * rather than reading this module's own `authToken`, precisely so it can be
 * tested here with no `vi.resetModules()`/dynamic-`import()` dance — see the
 * "AO-6 token bootstrap" describe block below for why that dance is needed
 * for anything that DOES read `authToken` directly.
 */
describe('appendToken (A1 — the query-parameter fallback for requests that cannot carry a header)', () => {
  it('appends ?token= when the url has no query string yet', () => {
    expect(appendToken('/ws', 'secret-token')).toBe('/ws?token=secret-token');
  });

  it('appends &token= when the url already has a query string', () => {
    expect(appendToken('/api/runs/run-1/report?path=x', 'secret-token')).toBe(
      '/api/runs/run-1/report?path=x&token=secret-token',
    );
  });

  it('returns the url unchanged when there is no token — the dev-proxy case', () => {
    expect(appendToken('/ws', undefined)).toBe('/ws');
  });

  it('percent-encodes the token, in case it ever contains a URL-unsafe character', () => {
    expect(appendToken('/ws', 'a b&c')).toBe('/ws?token=a%20b%26c');
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

/**
 * S9 — a 401 leaves the user with no way back, unless something classifies
 * it as recoverable and tells the rest of the app. `isRecoverableAuthFailure`
 * is the pure decision (see its doc comment in `api.ts` for why it is 401
 * only, not 401-or-403); these tests are the "at minimum" case the task
 * calls out explicitly — a 401 is recoverable, nothing else is.
 */
describe('isRecoverableAuthFailure (S9) — the one status code a fresh token actually fixes', () => {
  it('classifies 401 as recoverable', () => {
    expect(isRecoverableAuthFailure(401)).toBe(true);
  });

  it('classifies every other status this app can see as not recoverable', () => {
    // 403 in particular is worth pinning explicitly: see the doc comment on
    // `isRecoverableAuthFailure` for why "authenticated but forbidden" is
    // deliberately NOT folded into the same bucket as "no valid token at all".
    for (const status of [400, 403, 404, 409, 429, 500, 502, 503]) {
      expect(isRecoverableAuthFailure(status)).toBe(false);
    }
  });
});

/**
 * S9 — the mechanism itself: does a 401 anywhere in this file actually reach
 * a subscriber, and does a subscriber that unsubscribes actually stop
 * hearing about it. `fetchRun` is used as the vehicle only because it is the
 * shortest `getJson` caller already imported above; the assertion is about
 * `onUnauthorized`/`failedResponseError`, not about runs specifically — every
 * one of `getJson`, `postJson`, `cancelRun`, `submitTeamDecision` and
 * `submitClarification` routes through the same `failedResponseError`
 * (`api.ts`), so this is exercising the shared choke point once rather than
 * once per call site.
 */
describe('onUnauthorized (S9) — a 401 anywhere notifies every current subscriber', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('notifies a subscribed listener when a request comes back 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'token expired' })));
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);

    // The request still rejects as before (S9 does not change that a caller
    // sees a failure) — this mechanism is an ADDITIONAL signal, not a
    // replacement for the per-call-site error.
    await expect(fetchRun('r1')).rejects.toThrow(/401/);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does not notify for a non-401 failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);

    await expect(fetchRun('r1')).rejects.toThrow(/500/);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops notifying once unsubscribed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'nope' })));
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    unsubscribe();

    await expect(fetchRun('r1')).rejects.toThrow(/401/);

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies every subscriber, not just the first', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'nope' })));
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = onUnauthorized(first);
    const unsubSecond = onUnauthorized(second);

    await expect(fetchRun('r1')).rejects.toThrow(/401/);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubFirst();
    unsubSecond();
  });
});

/**
 * S9 — `setAuthToken` is the write half of the recovery path: given a token
 * the user just typed into `panels/AuthRecovery.tsx`, it has to (a) reach
 * `sessionStorage` under the exact key `bootstrapAuthToken` already uses, so
 * a same-tab reload after recovery still works exactly like the ordinary
 * bootstrap does, and (b) update what every future request in this file
 * sends, with no second step. Needs the same fake `window` +
 * `vi.resetModules()` + dynamic-`import()` dance the "AO-6 token bootstrap"
 * suite above needs, and for the identical reason: `authToken` is resolved
 * once at module load against whatever `window` existed then, so a test that
 * wants to observe a DIFFERENT resolved value needs a fresh module instance
 * loaded against a `window` this test controls.
 */
describe('setAuthToken (S9) — accepting a token after a 401', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('stores the token under the exact key bootstrapAuthToken uses, so a same-tab reload still works', async () => {
    const storage = makeSessionStorage();
    stubBrowser('http://127.0.0.1:5179/', storage);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] })));

    const mod = await import('./api.js');
    mod.setAuthToken('recovered-token');

    // 'agent-office-token' is TOKEN_STORAGE_KEY in api.ts — asserted as a
    // literal here (rather than importing the private constant) because that
    // string is also the exact key `bootstrapAuthToken`'s own tests above
    // assert against (`storage.getItem('agent-office-token')`); the two
    // pinning the same literal independently is the actual guarantee that
    // they read the same slot.
    expect(storage.getItem('agent-office-token')).toBe('recovered-token');
  });

  it('makes every subsequent request use the new token, not the one resolved at module load', async () => {
    // Starts with NO token anywhere — the exact "lost the token" scenario
    // S9 exists for: a fresh tab, nothing in the URL, nothing in storage.
    stubBrowser('http://127.0.0.1:5179/', makeSessionStorage());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./api.js');
    await mod.fetchAgents();
    // Before recovery: no token, so no second `fetch` argument at all (see
    // `getJson`'s own comment on why that is the correct pre-token shape).
    expect(fetchMock).toHaveBeenCalledWith('/api/agents');

    mod.setAuthToken('recovered-token');
    fetchMock.mockClear();
    await mod.fetchAgents();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-agent-office-token']).toBe('recovered-token');
  });

  it('does not touch the URL — the token never lands in the address bar via this path', async () => {
    const { replaceState } = stubBrowser('http://127.0.0.1:5179/', makeSessionStorage());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] })));

    const mod = await import('./api.js');
    mod.setAuthToken('recovered-token');

    // `bootstrapAuthToken`'s own URL-scrubbing call happens at module load,
    // before `setAuthToken` is ever reached in this test, so any call here
    // would be a NEW one this function made on its own — which is exactly
    // what must not happen for a token entered through the recovery form.
    expect(replaceState).not.toHaveBeenCalled();
  });
});
