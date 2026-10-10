import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import { UnsafePathError } from '../store/types.js';
import { resolveWithin } from '../store/util.js';

/**
 * Serve the built web client (`packages/web/dist`) so `npm run serve` is the
 * one process a user needs, rather than that process plus a second `npm run
 * web` Vite dev server on a different port.
 *
 * This module owns exactly one route-shaped decision: what happens for a
 * request that did not match `/api/*` or `/ws` in `server.ts`. Everything
 * else about those two — the token, `Host`, `Origin` — is unchanged and lives
 * there; see `isGatedApiPath` and the `onRequest` hook's comment for the half
 * of this decision that lives on that side.
 *
 * ## Is the static bundle behind the token too?
 *
 * No — deliberately. `server.ts`'s `onRequest` hook exempts GET/HEAD
 * requests for anything outside `/api/*` and `/ws` from the token check, so
 * `index.html`, the JS bundle, and CSS are served to anyone who can reach
 * this loopback port, with no token required. Two things point the same way:
 *
 * 1. **What the caller in the security posture actually gains.** AO-6 exists
 *    because a *loopback* server is reachable by every local account and
 *    process, not just the browser tab the user opened — see `authToken.ts`'s
 *    module comment. The static bundle carries no run data, no report
 *    content, no task text: `packages/web/src/api.ts` fetches all of that
 *    from `/api/*`, which stays gated exactly as before. An unauthenticated
 *    reader of `index.html` and the JS bundle learns the shape of this
 *    application's UI — information equivalent to reading this open-source
 *    repository's own `packages/web/src` — and nothing about any run, agent
 *    output, or credential. That is not the asset AO-6 was written to
 *    protect.
 * 2. **What gating it would break.** A browser's top-level navigation cannot
 *    attach a custom header (this is exactly why the token also travels as
 *    `?token=` for the *first* request — see `authToken.ts`'s
 *    `extractProvidedToken`). If `index.html` itself required the header, a
 *    bookmarked `http://127.0.0.1:5179/` with no query string would 401
 *    before a single byte of the app's own JavaScript ever ran — no page, no
 *    script, no way for the user to *do* anything about it from the browser.
 *    Answering with the query-parameter form only defers the same problem to
 *    a refresh or a second tab, neither of which carries the parameter
 *    either. `packages/web/src/api.ts`'s own comment already anticipated
 *    exactly this deployment shape ("opening this app's built output
 *    directly against the API server with no Vite dev proxy in front of
 *    it") and reads the token from the URL once, so the design on the client
 *    side already assumes the HTML that bootstraps it is reachable without
 *    one.
 *
 * `/api/*` and `/ws` are unaffected by any of this: `isGatedApiPath` in
 * `server.ts` is checked first, and a request matching either keeps requiring
 * the token exactly as it did before this file existed. A page served from
 * here still cannot read a report, list runs, or open the event socket
 * without it.
 */

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Shown whenever nothing in `distDir` can answer a request — either nobody
 * has run the web package's build yet, or `index.html` itself is missing for
 * some other reason. Plain text on purpose: this is read by a human staring
 * at a browser tab or a curl output, not parsed by `packages/web/src/api.ts`
 * (which never hits this path — see the module comment).
 */
function notBuiltMessage(): string {
  return (
    'Agent Office: the web client has not been built yet, so there is nothing\n' +
    'to serve at this URL.\n\n' +
    'Build packages/web (its own package.json has the build script) so that\n' +
    'packages/web/dist exists, then restart this server. Until then, `npm run\n' +
    'web` still works as a separate Vite dev server on its own port.\n'
  );
}

/**
 * Answer one GET/HEAD request out of `distDir`, the way a static file server
 * would, with an SPA fallback to `index.html` for anything that is not a
 * present file and does not look like it was asking for one (no extension).
 *
 * Callable per request rather than resolved once at startup: it re-checks
 * disk on every call, so a build produced *after* this process started (a
 * common sequence — start the server, then run the build in another
 * terminal) is picked up without a restart, and the "not built yet" message
 * stops appearing the moment `dist/index.html` exists.
 *
 * Containment is enforced with the same `resolveWithin` the run store uses
 * for report paths (`store/util.ts`) — lexical rejection of `..`, absolute
 * paths, drive letters and control characters, then a `path.relative`
 * recheck against the resolved absolute path. That is the right amount of
 * rigour for this directory: unlike a workspace an agent's tool calls write
 * into (`providers/apiTools.ts`'s `verifyRealContainment`, which also walks
 * symlinks because a hostile write could have planted one), `dist` is build
 * output nobody but `npm run build` writes to, so there is no adversarial
 * writer inside it a symlink-following recheck would be defending against —
 * only a hostile *request path*, which `resolveWithin` already refuses.
 */
export async function serveStaticClient(
  distDir: string,
  rawUrl: string,
  method: string,
  reply: FastifyReply,
): Promise<void> {
  const indexPath = path.join(distDir, 'index.html');
  const rawPathname = rawUrl.split('?')[0] ?? rawUrl;

  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    void reply.status(400).type('text/plain; charset=utf-8').send('malformed URL');
    return;
  }

  // Leading slashes only — a relative path never has any once this runs, and
  // `resolveWithin` below treats a leftover leading slash as absolute (and
  // rejects it), which would misfire on the ordinary case of "/assets/x.js".
  const relative = pathname.replace(/^\/+/, '');

  let targetPath: string | undefined;
  if (relative !== '') {
    try {
      const resolved = resolveWithin(distDir, relative);
      const resolvedStat = await stat(resolved).catch(() => undefined);
      if (resolvedStat?.isFile() === true) targetPath = resolved;
    } catch (error) {
      if (error instanceof UnsafePathError) {
        // Same discipline as the report routes in `server.ts`: refuse, never
        // echo the filesystem path a traversal attempt was reaching for.
        void reply
          .status(400)
          .type('text/plain; charset=utf-8')
          .send('refusing a path outside the built web client');
        return;
      }
      throw error;
    }
  }

  if (targetPath === undefined) {
    // No file on disk at that path. A path with no extension is assumed to be
    // a client-side route (`/runs/abc123`) that the SPA's own router resolves
    // once `index.html`'s bundle is running, so it gets the same shell a
    // fresh `/` would. A path that DOES look like an asset request
    // (`/assets/x-abc123.js`) and isn't there is a real 404 — falling back to
    // `index.html` for that would turn a broken or partial build into a blank
    // white page with nothing in the Network tab to explain why.
    const looksLikeAsset = path.extname(relative) !== '';
    if (looksLikeAsset) {
      const built = await stat(indexPath)
        .then(() => true)
        .catch(() => false);
      void reply
        .status(404)
        .type('text/plain; charset=utf-8')
        .send(built ? `no such file: /${relative}` : notBuiltMessage());
      return;
    }
    targetPath = indexPath;
  }

  const finalStat = await stat(targetPath).catch(() => undefined);
  if (finalStat === undefined || !finalStat.isFile()) {
    // Reached only when even `index.html` is absent — nobody has built the
    // client at all. Answering 404 (not 500): there is genuinely nothing to
    // serve, which is exactly what that status means, and the requirement is
    // "start normally and say so clearly", not "invent a page that isn't
    // there".
    void reply.status(404).type('text/plain; charset=utf-8').send(notBuiltMessage());
    return;
  }

  void reply
    .status(200)
    .header('content-type', contentTypeFor(targetPath))
    .header('content-length', String(finalStat.size))
    // `no-cache` everywhere, not the long-lived `immutable` caching a
    // production static host would use for Vite's content-hashed assets:
    // this is a local single-user tool that gets rebuilt in place under the
    // same file names during development, and a stale cached bundle after a
    // rebuild is a worse failure mode here than the (negligible, loopback)
    // cost of re-reading a small file from disk on every load.
    .header('cache-control', 'no-cache')
    .send(method === 'HEAD' ? undefined : await readFile(targetPath));
}
