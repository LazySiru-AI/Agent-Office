import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type ProxyOptions } from 'vite';
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

/**
 * Mirrors `DEV_TOKEN_FILE` in `packages/server/src/scripts/serve.ts` exactly —
 * see that file's comment for why this is a small duplicated constant rather
 * than a shared import (the web package does not depend on `@agent-office/server`,
 * and should not start to for one path string). If the two paths drift, the
 * symptom is every proxied request coming back 401 with a token file `serve.ts`
 * is writing somewhere this file isn't reading, which is exactly why both
 * halves of this pair name their counterpart.
 */
const DEV_TOKEN_FILE = path.join(os.tmpdir(), 'agent-office', 'dev-token');
const AUTH_TOKEN_HEADER = 'x-agent-office-token';

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

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5179',
        changeOrigin: true,
        ...attachDevToken(),
      },
      '/ws': {
        target: 'ws://127.0.0.1:5179',
        ws: true,
        ...attachDevToken(),
      },
    },
  },
});
