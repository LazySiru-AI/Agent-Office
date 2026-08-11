import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@agent-office/shared';
import { RunSocket, type SocketStatus } from './socket.js';

/**
 * `RunSocket` underpins NFR-2 (a refresh or server restart reattaches to a
 * live run) and NFR-3 (events visible in ~500ms, pushed not polled). Both
 * promises depend on behaviour that is easy to get subtly wrong and hard to
 * notice by eye: reconnecting without being told to, backing off rather than
 * hammering a dead server, never taking the tab down on a bad frame, and
 * keeping the wire's re-subscribe/unsubscribe contract straight across a
 * drop. None of that is exercised by importing the file — it all requires
 * driving a `WebSocket` through open/message/close/error, so this file
 * implements a minimal fake rather than pulling in a dependency (per the
 * task brief) or reaching for a real socket in a test.
 *
 * The fake is deliberately dumb: it records what was sent, and exposes
 * `serverOpens()`/`serverSends()`/`serverDrops()` methods that a test calls
 * to play the role of "the network", mirroring the four events
 * `socket.ts`'s `open()` actually listens for.
 */

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(readonly url: string) {
    createdSockets.push(this);
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    // A real browser WebSocket throws on send() while not OPEN; RunSocket
    // never calls send() in that state (it checks readyState itself), so a
    // throw here would catch a regression in that guard.
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('FakeWebSocket: send() while not open');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  /** Simulates the handshake completing. */
  serverOpens(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  /** Simulates an inbound frame, exactly as `ev.data` arrives in the browser. */
  serverSends(data: string): void {
    this.emit('message', { data });
  }

  /** Simulates the connection dropping (server restart, proxy timeout, network blip). */
  serverDrops(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  private emit(type: string, ev: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
}

let createdSockets: FakeWebSocket[] = [];

function latestSocket(): FakeWebSocket {
  const socket = createdSockets.at(-1);
  if (socket === undefined) throw new Error('no FakeWebSocket has been constructed yet');
  return socket;
}

// Mirrors socket.ts's own private INITIAL_BACKOFF_MS / MAX_BACKOFF_MS. Not
// exported (they are an implementation detail of the reconnect loop), so
// these are pinned here as the contract under test — if socket.ts's values
// ever change, these tests should be updated alongside it, not silently pass
// against stale numbers.
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

beforeEach(() => {
  createdSockets = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'app.example:1234' } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connect and receive', () => {
  it('reports connecting, then open, as the handshake completes', () => {
    const statuses: SocketStatus[] = [];
    const socket = new RunSocket({ onMessage: () => undefined, onStatusChange: (s) => statuses.push(s) });

    socket.connect();
    expect(statuses).toEqual(['connecting']);

    latestSocket().serverOpens();
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('delivers a schema-valid frame to onMessage', () => {
    const onMessage = vi.fn();
    const socket = new RunSocket({ onMessage });
    socket.connect();
    latestSocket().serverOpens();

    const frame: ServerMessage = { t: 'pong' };
    latestSocket().serverSends(JSON.stringify(frame));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(frame);
  });

  it('connects to the same-origin /ws path over ws:, mirroring http:', () => {
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    expect(latestSocket().url).toBe('ws://app.example:1234/ws');
  });
});

describe('reconnect after a drop (NFR-2)', () => {
  it('opens a new socket after the connection closes unexpectedly, without being told to', () => {
    vi.useFakeTimers();
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    latestSocket().serverOpens();
    expect(createdSockets).toHaveLength(1);

    latestSocket().serverDrops();
    expect(createdSockets).toHaveLength(1); // not yet — waiting out the backoff

    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(createdSockets).toHaveLength(2);
  });

  it('re-subscribes to the previously-subscribed run once the new connection opens (the point of NFR-2)', () => {
    vi.useFakeTimers();
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    latestSocket().serverOpens();
    socket.subscribe('run-42');
    expect(latestSocket().sent).toContainEqual(JSON.stringify({ t: 'subscribe', runId: 'run-42' }));

    latestSocket().serverDrops();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    const second = latestSocket();
    expect(second.sent).toEqual([]); // nothing sent until the new socket opens

    second.serverOpens();
    expect(second.sent).toContainEqual(JSON.stringify({ t: 'subscribe', runId: 'run-42' }));
  });

  it('resets the backoff to its initial value after a successful reconnect', () => {
    vi.useFakeTimers();
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    latestSocket().serverOpens();

    // First drop: consumes the doubling once (500ms -> next would be 1000ms).
    latestSocket().serverDrops();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    latestSocket().serverOpens(); // successful reconnect — should reset backoff to 500ms, not leave it at 1000ms

    latestSocket().serverDrops();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS - 1);
    expect(createdSockets).toHaveLength(2); // not yet due either way at 499ms
    vi.advanceTimersByTime(1);
    // At exactly 500ms elapsed: reconnects now if backoff was reset to 500ms
    // as it should be. If the reset were missing (backoff still doubled to
    // 1000ms from the earlier attempt), the pending timer would not fire
    // until 1000ms and this would still read 2, catching the regression.
    expect(createdSockets).toHaveLength(3);
  });

  it('does not reconnect after close() is called deliberately', () => {
    vi.useFakeTimers();
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    latestSocket().serverOpens();

    socket.close();
    vi.advanceTimersByTime(MAX_BACKOFF_MS * 2);
    expect(createdSockets).toHaveLength(1);
  });
});

describe('reconnect backs off rather than spinning (NFR-2, against hammering a dead server)', () => {
  it('doubles the delay between attempts up to a cap, instead of retrying immediately every time', () => {
    vi.useFakeTimers();
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();

    // Never reaches 'open' — every attempt fails immediately, forcing the
    // backoff to grow on every single retry.
    let expectedDelay = INITIAL_BACKOFF_MS;
    for (let attempt = 0; attempt < 6; attempt++) {
      const before = createdSockets.length;
      latestSocket().serverDrops();

      vi.advanceTimersByTime(expectedDelay - 1);
      expect(createdSockets).toHaveLength(before); // not yet — still inside this attempt's backoff window

      vi.advanceTimersByTime(1);
      expect(createdSockets).toHaveLength(before + 1); // reconnects right on schedule, not early

      expectedDelay = Math.min(expectedDelay * 2, MAX_BACKOFF_MS);
    }
    // Sanity: after enough failures the delay is pinned at the cap, not still growing unbounded.
    expect(expectedDelay).toBe(MAX_BACKOFF_MS);
  });
});

describe('a malformed or unparseable message does not kill the connection', () => {
  it('reports invalid JSON via onParseError and keeps the socket usable for the next frame', () => {
    const onMessage = vi.fn();
    const onParseError = vi.fn();
    const socket = new RunSocket({ onMessage, onParseError });
    socket.connect();
    const ws = latestSocket();
    ws.serverOpens();

    ws.serverSends('{not valid json');
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(FakeWebSocket.OPEN); // never closed by the parse failure

    const frame: ServerMessage = { t: 'pong' };
    ws.serverSends(JSON.stringify(frame));
    expect(onMessage).toHaveBeenCalledWith(frame);
  });

  it('reports well-formed JSON that fails ServerMessageSchema via onParseError, not onMessage', () => {
    const onMessage = vi.fn();
    const onParseError = vi.fn();
    const socket = new RunSocket({ onMessage, onParseError });
    socket.connect();
    latestSocket().serverOpens();

    // Valid JSON, but "t" isn't a member of the discriminated union — e.g. a
    // stale client talking to a newer/older server build.
    latestSocket().serverSends(JSON.stringify({ t: 'not-a-real-message-type' }));

    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores a binary frame rather than treating it as a parse error or a message', () => {
    const onMessage = vi.fn();
    const onParseError = vi.fn();
    const socket = new RunSocket({ onMessage, onParseError });
    socket.connect();
    latestSocket().serverOpens();

    // handleRaw's `typeof data !== 'string'` guard — binary frames are not
    // part of this contract and must be silently ignored, not surfaced as
    // corruption.
    latestSocket().serverSends(new ArrayBuffer(4) as unknown as string);

    expect(onMessage).not.toHaveBeenCalled();
    expect(onParseError).not.toHaveBeenCalled();
  });
});

describe('unsubscribing stops delivery', () => {
  it('sends an unsubscribe frame immediately when the socket is open', () => {
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    const ws = latestSocket();
    ws.serverOpens();
    socket.subscribe('run-1');

    socket.unsubscribe();
    expect(ws.sent).toContainEqual(JSON.stringify({ t: 'unsubscribe', runId: 'run-1' }));
  });

  it('does not re-subscribe on the next reconnect once unsubscribed — the mechanism that makes delivery actually stop', () => {
    // RunSocket itself does not filter inbound frames by run id (useRun.ts's
    // fold does that); what it owns is the re-subscribe-on-reconnect
    // behaviour, so "unsubscribe stops delivery" cashes out as: a socket that
    // reconnects after an unsubscribe must not ask the server to resume
    // sending that run's frames.
    vi.useFakeTimers();
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    const first = latestSocket();
    first.serverOpens();
    socket.subscribe('run-1');
    expect(first.sent).toContainEqual(JSON.stringify({ t: 'subscribe', runId: 'run-1' }));

    socket.unsubscribe();
    first.serverDrops();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    const second = latestSocket();
    second.serverOpens();

    expect(second.sent).not.toContainEqual(expect.stringContaining('"t":"subscribe"'));
  });

  it('unsubscribing with no prior subscription sends nothing', () => {
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    const ws = latestSocket();
    ws.serverOpens();

    socket.unsubscribe();
    expect(ws.sent).toEqual([]);
  });
});

describe('messages are surfaced in order', () => {
  it('delivers a burst of frames to onMessage in the same order they arrived on the wire', () => {
    const received: string[] = [];
    const socket = new RunSocket({
      onMessage: (msg) => {
        if (msg.t === 'log') received.push(msg.line);
      },
    });
    socket.connect();
    const ws = latestSocket();
    ws.serverOpens();

    const lines = ['first', 'second', 'third', 'fourth'];
    for (const line of lines) {
      const frame: ServerMessage = { t: 'log', runId: 'run-1', line, ts: 1 };
      ws.serverSends(JSON.stringify(frame));
    }

    expect(received).toEqual(lines);
  });

  it('preserves order even when a malformed frame is interleaved between valid ones', () => {
    const received: string[] = [];
    const socket = new RunSocket({
      onMessage: (msg) => {
        if (msg.t === 'log') received.push(msg.line);
      },
      onParseError: () => undefined,
    });
    socket.connect();
    const ws = latestSocket();
    ws.serverOpens();

    ws.serverSends(JSON.stringify({ t: 'log', runId: 'run-1', line: 'one', ts: 1 } satisfies ServerMessage));
    ws.serverSends('garbage');
    ws.serverSends(JSON.stringify({ t: 'log', runId: 'run-1', line: 'two', ts: 2 } satisfies ServerMessage));

    expect(received).toEqual(['one', 'two']);
  });
});

describe('keepalive ping (NFR-3: intermediaries must not idle the socket shut)', () => {
  it('sends a ping on the keepalive interval while open, and stops once closed', () => {
    vi.useFakeTimers();
    const socket = new RunSocket({ onMessage: () => undefined });
    socket.connect();
    const ws = latestSocket();
    ws.serverOpens();

    vi.advanceTimersByTime(25_000);
    expect(ws.sent).toContainEqual(JSON.stringify({ t: 'ping' }));

    const pingsSoFar = ws.sent.filter((s) => s === JSON.stringify({ t: 'ping' })).length;
    socket.close();
    vi.advanceTimersByTime(100_000);
    const pingsAfterClose = ws.sent.filter((s) => s === JSON.stringify({ t: 'ping' })).length;
    expect(pingsAfterClose).toBe(pingsSoFar); // no further pings once closed
  });
});
