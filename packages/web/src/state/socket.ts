import {
  API,
  ClientMessageSchema,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '@agent-office/shared';

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

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${API.socket()}`;
}
