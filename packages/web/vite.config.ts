import { defineConfig } from 'vite';
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
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5179',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:5179',
        ws: true,
      },
    },
  },
});
