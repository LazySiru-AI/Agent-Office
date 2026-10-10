import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API } from '@agent-office/shared';
import { MemoryRunStore } from '../store/memoryStore.js';
import { AUTH_TOKEN_HEADER } from './authToken.js';
import { buildServer } from './server.js';
import { RunSupervisor } from './supervisor.js';
import { stubDeliverable, testProviderFactory, testRegistry } from './fixtures.js';

/**
 * Route-level tests for serving `packages/web/dist` (`staticClient.ts`), so
 * `npm run serve` can be the one process a user runs.
 *
 * Mirrors `server.test.ts`'s own discipline: driven through `.inject()`, a
 * fresh temp directory stands in for a real build so nothing here depends on
 * this checkout's own `packages/web/dist` existing or being current, and the
 * client is treated as hostile input exactly like a report path or a run id
 * is everywhere else in this package.
 */

const TEST_TOKEN = 'static-client-test-token-not-a-real-secret';

const started: Array<{ app: FastifyInstance; supervisor: RunSupervisor }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const { app, supervisor } of started.splice(0)) {
    await supervisor.shutdown();
    await app.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Materialise a temp `dist`-shaped directory from a map of relative path -> content. */
async function buildDist(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-office-static-test-'));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(dir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return dir;
}

/**
 * A path under `os.tmpdir()` that is never created — stands in for "nobody
 * has run the web package's build yet", which is exactly `existsSync` false
 * in `serve.ts`.
 */
function unbuiltDistDir(): string {
  const dir = path.join(os.tmpdir(), `agent-office-static-test-unbuilt-${Date.now()}-${Math.random()}`);
  tempDirs.push(dir);
  return dir;
}

async function setup(webDistDir?: string): Promise<{ app: FastifyInstance }> {
  const registry = testRegistry();
  const store = new MemoryRunStore();
  const supervisor = new RunSupervisor({
    registry,
    store,
    makeProvider: testProviderFactory(),
    onWarning: () => undefined,
    produceDeliverable: stubDeliverable(),
  });
  const app = await buildServer({
    registry,
    store,
    supervisor,
    token: TEST_TOKEN,
    ...(webDistDir === undefined ? {} : { webDistDir }),
  });
  await app.ready();

  started.push({ app, supervisor });
  return { app };
}

describe('static web client (packages/web/dist)', () => {
  it('serves index.html for / with no token at all', async () => {
    const dist = await buildDist({ 'index.html': '<html>agent office</html>' });
    const { app } = await setup(dist);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('agent office');
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('falls back to index.html for an extensionless client-side route (SPA)', async () => {
    const dist = await buildDist({ 'index.html': '<html>shell</html>' });
    const { app } = await setup(dist);

    const response = await app.inject({ method: 'GET', url: '/runs/20260101-000000-abcd' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('shell');
  });

  it('serves a real built asset with its content type', async () => {
    const dist = await buildDist({
      'index.html': '<html></html>',
      'assets/app.js': 'console.log("agent office");',
    });
    const { app } = await setup(dist);

    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('console.log("agent office");');
    expect(response.headers['content-type']).toContain('text/javascript');
  });

  it('answers 404 for a missing asset rather than masking it as the SPA shell', async () => {
    const dist = await buildDist({ 'index.html': '<html>shell</html>' });
    const { app } = await setup(dist);

    const response = await app.inject({ method: 'GET', url: '/assets/does-not-exist.js' });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('shell');
  });

  it('lands harmlessly back inside dist for a literal ".." — Fastify\'s own router already collapses it', async () => {
    // Verified with a standalone probe against a bare Fastify instance: a
    // literal `..` in the URL (`/../../package.json`) reaches this app's
    // `notFoundHandler` already rewritten to `/package.json` — find-my-way
    // normalises dot segments (and their %2e-encoded form) before routing.
    // Asserted here anyway, rather than assumed: `resolveWithin` still runs
    // on whatever pathname actually arrives, so this only documents that in
    // THIS case the escape never reaches it, as opposed to the encoded-slash
    // case below, which does.
    const dist = await buildDist({ 'index.html': '<html>shell</html>' });
    const { app } = await setup(dist);

    const response = await app.inject({ method: 'GET', url: '/../../package.json' });

    // Not found — because "package.json" does not exist INSIDE dist, not
    // because anything escaped it. Confirms the request never reached
    // anywhere near this repo's real package.json.
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('"name"');
    expect(response.body).not.toContain('@agent-office');
  });

  it('refuses a traversal that bypasses that normalisation via an encoded slash', async () => {
    // `/assets/..%2f..%2fsecret.txt`: find-my-way does not decode `%2f`
    // before routing (a literal `/` there would be a path separator, but the
    // encoded form is treated as one opaque segment — verified with the same
    // probe as above), so this arrives at `serveStaticClient` unchanged. Only
    // THIS module's own `decodeURIComponent` turns it into `../../secret.txt`
    // — which is exactly the gap `resolveWithin`'s containment check exists
    // to close, since nothing upstream of it defused this one.
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-office-static-test-outer-'));
    tempDirs.push(parent);
    const dist = path.join(parent, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '<html></html>');
    await writeFile(path.join(parent, 'secret.txt'), 'do-not-leak-this');

    const { app } = await setup(dist);

    const response = await app.inject({ method: 'GET', url: '/assets/..%2f..%2fsecret.txt' });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('do-not-leak-this');
  });

  it('starts normally and answers sanely — not a crash, not a mysterious 404 — when dist has not been built', async () => {
    const { app } = await setup(unbuiltDistDir());

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(404);
    expect(response.body.toLowerCase()).toContain('has not been built');
  });

  it('picks up a build that appears after the server started, with no restart', async () => {
    const dist = unbuiltDistDir();
    const { app } = await setup(dist);

    const before = await app.inject({ method: 'GET', url: '/' });
    expect(before.statusCode).toBe(404);

    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '<html>built while running</html>');

    const after = await app.inject({ method: 'GET', url: '/' });
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain('built while running');
  });

  it('leaves the old behaviour untouched when webDistDir is not configured: token still required, JSON 404 shape on an unmatched route', async () => {
    const { app } = await setup(undefined);

    // No token at all: without `webDistDir`, `isUngatedStaticRequest` can
    // never be true, so this is still just an ordinary unauthenticated
    // request to an unmatched route — exactly what it was before this
    // module existed.
    const unauthenticated = await app.inject({ method: 'GET', url: '/' });
    expect(unauthenticated.statusCode).toBe(401);

    const withToken = await app.inject({
      method: 'GET',
      url: '/',
      headers: { [AUTH_TOKEN_HEADER]: TEST_TOKEN },
    });
    expect(withToken.statusCode).toBe(404);
    const parsed = JSON.parse(withToken.body) as { error: string };
    expect(parsed.error).toContain('no route for');
  });

  it('still requires the token for /api even with the static client configured', async () => {
    const dist = await buildDist({ 'index.html': '<html></html>' });
    const { app } = await setup(dist);

    const response = await app.inject({ method: 'GET', url: API.agents() });

    expect(response.statusCode).toBe(401);
  });

  it('serves /api/agents once the correct token is supplied, unaffected by the static client', async () => {
    const dist = await buildDist({ 'index.html': '<html></html>' });
    const { app } = await setup(dist);

    const response = await app.inject({
      method: 'GET',
      url: API.agents(),
      headers: { [AUTH_TOKEN_HEADER]: TEST_TOKEN },
    });

    expect(response.statusCode).toBe(200);
  });

  it('still requires the token on the /ws upgrade even with the static client configured', async () => {
    const dist = await buildDist({ 'index.html': '<html></html>' });
    const { app } = await setup(dist);

    const response = await app.inject({
      method: 'GET',
      url: API.socket(),
      headers: { host: 'localhost', upgrade: 'websocket', connection: 'upgrade' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('still refuses a foreign Host for a static request (DNS-rebinding defence stays on)', async () => {
    const dist = await buildDist({ 'index.html': '<html></html>' });
    const { app } = await setup(dist);

    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'attacker.example' },
    });

    expect(response.statusCode).toBe(403);
  });
});
