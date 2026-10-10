import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for @agent-office/web (PLAN.md Phase 3).
 *
 * The server binds to loopback only (NFR-6), so the dev client talks to it
 * through this proxy rather than a hardcoded host — the client code itself
 * uses same-origin relative paths (`API.*` in `wire.ts`) and needs no CORS
 * handling. `/ws` must proxy with `ws: true` or the WebSocket upgrade never
 * reaches the server and reconnect logic would spin forever against a 404.
 */

const AUTH_TOKEN_HEADER = 'x-agent-office-token';

/**
 * The port `npm run serve` is listening on — read from the environment
 * rather than hardcoded, because it used not to be: the two `target` strings
 * below were plain string literals pinned to `5179`, so `npm run serve --
 * --port 5299` moved the server and left this proxy still pointed at 5179,
 * where nothing was listening. Every `/api` request and the `/ws` upgrade
 * then failed with a bare connection error that named neither `--port` nor
 * any reason to suspect it — this is not hypothetical, a UAT agent hit
 * exactly this because the default port was already taken by another
 * session. `AGENT_OFFICE_SERVER_PORT` is the fix: set it to the same value
 * passed to `--port` before starting `npm run web`, and both `target`s below
 * follow it.
 *
 * It has to be an environment variable rather than, say, a flag added to the
 * `vite` invocation, because this config module is evaluated by a process
 * entirely separate from `npm run serve` — there is no argv here to read the
 * server's own flags from, and (unlike the dev token below) there is no file
 * either side already writes for a config-eval-time read to consult. An env
 * var the developer sets identically for both commands is the plainest
 * channel available for a value that is fixed for the lifetime of both
 * processes, which is also why this is read once at config-eval time rather
 * than per-request the way `readDevToken` below reads the token: the target
 * of a `ProxyOptions` entry is a plain string, fixed when the proxy is
 * configured — Vite does not re-resolve it per proxied request the way
 * `configure`'s hooks run per request, so there would be nothing to gain from
 * re-reading this on every call and no hook that would let this file do so
 * even if there were.
 */
const DEFAULT_SERVER_PORT = 5179;

function readServerPort(): number {
  const raw = process.env['AGENT_OFFICE_SERVER_PORT'];
  if (raw === undefined) return DEFAULT_SERVER_PORT;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Fail soft, the same posture `readDevToken` below takes: a typo'd env
    // var must not crash Vite's config eval before a single page has loaded.
    // Falling back to the default and warning to the terminal Vite already
    // owns is diagnosable; throwing here would turn a bad shell export into
    // "the dev server won't start at all", a worse failure than proxying to
    // the wrong port with an explanation printed right above it.
    console.warn(
      `vite.config.ts: ignoring invalid AGENT_OFFICE_SERVER_PORT=${JSON.stringify(raw)} ` +
        `(must be a positive number); proxying to the default port ${DEFAULT_SERVER_PORT} instead.`,
    );
    return DEFAULT_SERVER_PORT;
  }
  return parsed;
}

const SERVER_PORT = readServerPort();

/**
 * Mirrors `devTokenFilePath` in `packages/server/src/scripts/serve.ts`
 * exactly — see that file's comment for the full story (why a file, what
 * protects it, why it's namespaced by port) and for why this is a small
 * duplicated FUNCTION rather than a shared import (the web package does not
 * depend on `@agent-office/server`, and should not start to for one function).
 * If the two ever drift, the symptom is every proxied request coming back 401
 * with a token file `serve.ts` is writing somewhere this file isn't reading —
 * exactly why both halves of this pair name their counterpart. Keyed off the
 * `SERVER_PORT` this file already resolved above, rather than a second,
 * independent read of `AGENT_OFFICE_SERVER_PORT`, so the token path and the
 * proxy target can never disagree about which port they mean.
 */
function devTokenFilePath(port: number): string {
  const suffix = port === DEFAULT_SERVER_PORT ? '' : `-${port}`;
  return path.join(os.tmpdir(), 'agent-office', `dev-token${suffix}`);
}

const DEV_TOKEN_FILE = devTokenFilePath(SERVER_PORT);

/**
 * Read the token fresh on every proxied request rather than once at Vite
 * startup.
 *
 * `npm run serve` and `npm run web` are two independent processes, started in
 * either order, and the server generates a new random token on every run (see
 * `authToken.ts`'s `resolveAuthToken`) unless `AGENT_OFFICE_TOKEN` pins one.
 * Caching the value at config-eval time would mean restarting only the API
 * server — the far more common half of the pair to restart, since it is the
 * one running the actual orchestration — leaves the proxy attaching a stale
 * token until Vite itself is also restarted, turning "AO-6 works" into "AO-6
 * works until you don't remember exactly which process needs a bounce". A
 * synchronous read of a few dozen bytes on each request is not worth avoiding
 * for that.
 *
 * Read failures (server not started yet, file not written yet, permissions
 * denied) return `undefined` rather than throwing: the request proceeds
 * without the header, gets a 401 from the real server exactly like any other
 * unauthenticated caller, and the developer sees a normal, diagnosable HTTP
 * error instead of Vite's dev server crashing on every page load before the
 * API process has even started.
 *
 * This function, and the header it attaches, are a DEVELOPMENT convenience
 * only. Vite's dev server enforces none of `server.ts`'s protections —  no
 * `Host` allowlist, no `Origin` check, no token requirement of its own — so
 * any local process that can reach the Vite port (default 5173) gets the same
 * access to the API this proxy has, exactly as if it had the token itself.
 * That is an explicit, accepted trade for not having to paste a token into
 * the browser on every `npm run web` — say so plainly rather than let a
 * reader assume the dev setup is as protected as the API server it fronts.
 */
function readDevToken(): string | undefined {
  try {
    return readFileSync(DEV_TOKEN_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach the dev token to every request this proxy forwards — plain HTTP and
 * the WebSocket upgrade alike, since `server.ts`'s `onRequest` hook checks
 * both the same way (NFR-3 for the socket half). `proxyReq`/`proxyReqWs` are
 * `http-proxy`'s hooks for "the outbound request/upgrade about to leave this
 * process for the target", which is the one place a header can be injected
 * without the browser or `packages/web/src/api.ts` ever needing to know a
 * token exists.
 */
function attachDevToken(): Pick<ProxyOptions, 'configure'> {
  return {
    configure: (proxy) => {
      const inject = (proxyReq: { setHeader(name: string, value: string): void }): void => {
        const token = readDevToken();
        if (token !== undefined) proxyReq.setHeader(AUTH_TOKEN_HEADER, token);
      };
      proxy.on('proxyReq', inject);
      proxy.on('proxyReqWs', inject);
    },
  };
}

/**
 * S4 (P2): make the trade-off `readDevToken`'s comment already documents
 * impossible to miss.
 *
 * That comment is honest — it says plainly that this proxy is a development
 * convenience, that the token only protects requests which go THROUGH it, and
 * that the Vite dev server itself enforces none of `server.ts`'s protections
 * (no `Host` allowlist, no `Origin` check, no token requirement of its own).
 * The gap this closes is not the trade itself, which was already a deliberate,
 * documented decision — it is that "documented" meant "in a comment in this
 * file," reachable only by a developer who goes looking for it. Nobody running
 * `npm run serve` in one terminal and `npm run web` in another sees a comment;
 * the two-process dev workflow the README recommends is exactly the one that
 * turns AO-6 (the server's own auth) off for anything that can reach the Vite
 * port, and the person running that workflow deserves to be told so at the
 * moment it happens, not only if they happen to read `vite.config.ts`.
 *
 * A dedicated plugin's `configureServer` hook, rather than a bare top-level
 * `console.warn` in this module: a Vite CONFIG FILE is evaluated for `vite
 * build` and `vite preview` too, neither of which starts this dev server or
 * this proxy at all, so a warning at module-eval time would print in contexts
 * where nothing it describes is even true. `configureServer` runs when a Vite
 * DEV SERVER actually starts, which is the moment this warning is true.
 *
 * That is a narrower claim than "only `npm run web`", though, and the
 * `process.env['VITEST']` guard below exists because of the gap: this
 * package's tests run through the repo-root `vitest.config.ts`, which lists
 * `packages/*` as `projects` — so `npx vitest run` (from ANY package, not
 * just this one) loads THIS file as `packages/web`'s project config, and
 * Vitest builds its own internal Vite dev server from it to transform test
 * modules, which fires `configureServer` on every plugin found here. Caught
 * this exact way while verifying this fix: `npx vitest run
 * packages/server/...` — nothing to do with the web dev proxy — printed the
 * warning before a single test ran. Vitest sets `process.env.VITEST = 'true'`
 * for the whole process for exactly this kind of "am I really inside a dev
 * server" check, so skipping when it is set keeps this warning tied to what
 * it actually describes (`npm run web`'s real dev server) instead of firing
 * on every test run anywhere in the monorepo.
 *
 * Printed with plain `console.warn` rather than through Vite's own
 * `server.config.logger`: the logger's output is filtered by `--logLevel`
 * (someone quieting normal dev-server chatter with `--logLevel error` would
 * silently lose a `logger.warn` call), and a notice about what is and is not
 * protected on this port should not be something a routine noise-reduction
 * flag can suppress.
 */
function devProxyWarningPlugin(): Plugin {
  return {
    name: 'agent-office-dev-proxy-warning',
    configureServer() {
      // See the guard's own paragraph above: without this, `npx vitest run`
      // anywhere in the monorepo prints a warning about a dev proxy that
      // was never started.
      if (process.env['VITEST'] !== undefined) return;

      console.warn(
        [
          '',
          '[agent-office] dev proxy warning: this Vite dev server has no auth of its own.',
          '',
          `  Protected:     requests forwarded through THIS proxy (/api, /ws) carry the`,
          `                 same startup token the real server (npm run serve) requires,`,
          `                 read fresh from ${DEV_TOKEN_FILE} on every request.`,
          '  NOT protected: the Vite dev server itself. It enforces no Host allowlist, no',
          '                 Origin check, and no token of its own — any local process that',
          '                 can reach this port gets the same access as a request carrying',
          '                 the token, exactly as if it had the token itself.',
          '',
          '  This is a deliberate development convenience (see readDevToken\'s comment in',
          '  vite.config.ts), not a bug — but it means the two-process workflow this file',
          '  supports (npm run serve + npm run web) turns the server\'s own Host/Origin/',
          '  token checks (AO-6) off for anything that can reach this port. Do not expose',
          '  this dev server beyond localhost.',
          '',
        ].join('\n'),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), devProxyWarningPlugin()],
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
        ...attachDevToken(),
      },
      '/ws': {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        ws: true,
        ...attachDevToken(),
      },
    },
  },
});
