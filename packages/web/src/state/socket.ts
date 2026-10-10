import {
  API,
  ClientMessageSchema,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '@agent-office/shared';
import { appendToken, authToken } from '../api.js';

/**
 * WebSocket client for `/ws` (`wire.ts` §2).
 *
 * NFR-2 (resumability) is only as good as this file: the server process can
 * restart, a laptop can sleep, a proxy can drop an idle connection. Every one
 * of those must end the same way — reconnect with backoff, then re-send
 * `subscribe` for whatever run the UI is currently looking at — or a refresh
 * mid-run would silently stop updating instead of erroring loudly.
 *
 * Every inbound frame is parsed with `ServerMessageSchema` before a listener
 * ever sees it. The socket is not a trusted boundary: the process we
 * reconnected to might be a different build than the one that sent the last
 * frame, and a browser tab must never crash on a malformed message.
 *
 * ## A1: authenticating the upgrade itself
 *
 * `wsUrl` used to build `/ws` with no credential at all, which the Vite dev
 * proxy papered over (it injects `AUTH_TOKEN_HEADER` on the proxied upgrade
 * before this code ever runs) but which 401s outright under `npm run serve`
 * on its own — the documented way to run this app, and one with no proxy in
 * front of it. A native browser `WebSocket` cannot set a custom header on its
 * upgrade request under any circumstance, so the header this file's sibling
 * `api.ts` attaches to every ordinary fetch is not an option here; the fix is
 * the query-parameter fallback `packages/server/src/http/authToken.ts`'s
 * `extractProvidedToken` already accepts for exactly this shape of caller —
 * confirmed by reading that function's doc comment and `server.ts`'s
 * `onRequest` hook, which applies the same token check to `/ws` as to every
 * `/api` route (`isGatedApiPath` explicitly includes `API.socket()`) and
 * reads the query parameter through that same `extractProvidedToken`. `api.ts`
 * exports `authToken` (the value it already resolves for its own header) and
 * `appendToken` (a pure query-string builder) so this file attaches the exact
 * same credential the same way, without duplicating the bootstrap logic.
 *
 * Behind the dev proxy this is a no-op: `authToken` resolves to `undefined`
 * there (nothing ever put a token in the URL or `sessionStorage` on that
 * flow — the proxy's own injected header is what authenticates), so
 * `appendToken` returns the `/ws` URL unchanged and the proxy keeps doing
 * exactly what it already did.
 */

export type SocketStatus = 'connecting' | 'open' | 'closed';

export interface RunSocketOptions {
  /** Called for every frame that parses cleanly against ServerMessageSchema. */
  onMessage: (msg: ServerMessage) => void;
  /** Called whenever connection status changes, so the UI can show it. */
  onStatusChange?: (status: SocketStatus) => void;
  /**
   * Called when a frame fails to parse. Never throws — a malformed frame from
   * a mismatched server build must not take the tab down.
   */
  onParseError?: (error: unknown, raw: unknown) => void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
/** Keeps intermediaries (proxies, NAT) from idling the socket shut. */
const PING_INTERVAL_MS = 25_000;

export class RunSocket {
  private ws: WebSocket | undefined;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** The run we're meant to be watching. Survives reconnects; drives re-subscribe. */
  private subscribedRunId: string | undefined;
  private closedByCaller = false;

  constructor(private readonly options: RunSocketOptions) {}

  connect(): void {
    this.closedByCaller = false;
    this.open();
  }

  /** Subscribe to a run, replacing any prior subscription. Persists across reconnects. */
  subscribe(runId: string): void {
    this.subscribedRunId = runId;
    this.send({ t: 'subscribe', runId });
  }

  unsubscribe(): void {
    const runId = this.subscribedRunId;
    this.subscribedRunId = undefined;
    if (runId !== undefined) this.send({ t: 'unsubscribe', runId });
  }

  close(): void {
    this.closedByCaller = true;
    this.clearTimers();
    this.ws?.close();
  }

  private open(): void {
    this.options.onStatusChange?.('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.options.onStatusChange?.('open');
      this.startPing();
      // Re-subscribe after every reconnect. This single call is what makes
      // NFR-2 survive a server restart instead of the client going quiet.
      if (this.subscribedRunId !== undefined) {
        this.send({ t: 'subscribe', runId: this.subscribedRunId });
      }
    });

    ws.addEventListener('message', (ev) => {
      this.handleRaw(ev.data as unknown);
    });

    ws.addEventListener('close', () => {
      this.stopPing();
      this.options.onStatusChange?.('closed');
      if (!this.closedByCaller) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // A browser WebSocket always fires 'close' right after 'error'; the
      // reconnect is scheduled from the 'close' handler so it isn't doubled up.
      ws.close();
    });
  }

  private handleRaw(data: unknown): void {
    if (typeof data !== 'string') return; // binary frames are not part of this contract
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(data);
    } catch (error) {
      this.options.onParseError?.(error, data);
      return;
    }
    const result = ServerMessageSchema.safeParse(parsedJson);
    if (!result.success) {
      this.options.onParseError?.(result.error, parsedJson);
      return;
    }
    this.options.onMessage(result.data);
  }

  private send(msg: ClientMessage): void {
    const validated = ClientMessageSchema.parse(msg);
    if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(validated));
    }
    // Dropped silently if not open — `subscribedRunId` re-sends `subscribe`
    // on the next 'open', so a message issued mid-reconnect is never lost.
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.open(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.stopPing();
  }
}

/**
 * Build the `/ws` URL for one `location` — a pure function taking `location`
 * and `token` as parameters, rather than reading `window`/`authToken`
 * directly, so it is unit-testable with a plain object (`socket.test.ts`)
 * without needing a real `window` global or the module-reset dance
 * `api.test.ts`'s AO-6 suite needs to observe `authToken` with a different
 * value. `wsUrl` below is the thin, untested wrapper that supplies the real
 * globals.
 */
export function buildWsUrl(location: Pick<Location, 'protocol' | 'host'>, token: string | undefined): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return appendToken(`${proto}//${location.host}${API.socket()}`, token);
}

function wsUrl(): string {
  return buildWsUrl(window.location, authToken);
}
