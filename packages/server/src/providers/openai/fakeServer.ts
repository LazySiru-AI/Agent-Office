import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

/**
 * A local double for the OpenAI/DeepSeek Chat Completions endpoint (Phase 7).
 *
 * This is the entire verification surface for `provider.ts`: no API key of
 * any kind was available when this adapter was written, so nothing here can
 * be checked against a live endpoint. What this server *can* prove is
 * narrower and still worth proving — given bytes on the wire shaped like the
 * documented Chat Completions format, does the adapter parse, reassemble and
 * error-handle them correctly. It speaks real HTTP over a real loopback
 * socket rather than a synthetic `ReadableStream`, so `fetch`, `AbortSignal`
 * cancellation and TCP-level chunk boundaries are all exercised for real —
 * only the bytes on the other end are fabricated.
 */

export interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** Raw body exactly as received, before any parsing. */
  bodyRaw: string;
  /** `JSON.parse(bodyRaw)`, or `undefined` if that failed. */
  bodyJson: unknown;
}

export type FakeStep =
  /**
   * A streamed `text/event-stream` response, written as separate parts.
   * `hangAfter: true` writes every part and then, instead of ending the
   * response, leaves the connection open indefinitely — a partial stream
   * that stalls, for exercising cancellation (FR-M9) against real in-flight
   * data rather than an empty connection.
   */
  | { kind: 'stream'; parts: string[]; status?: number; hangAfter?: boolean }
  /** A non-streamed JSON response — used for 401, 429, and other error paths. */
  | { kind: 'json'; status: number; body: unknown }
  /**
   * Accepts the connection, sends headers, then never writes or ends. Used to
   * exercise cancellation (FR-M9) against a socket that is genuinely still
   * open, not one that merely has not been read from yet.
   */
  | { kind: 'stall' };

export interface FakeOpenAiServer {
  url: string;
  /** Every request received, in arrival order. Assertion surface for tests. */
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/**
 * Start the fake server. `steps` is consumed in order, one per HTTP request —
 * the tool-call loop makes several requests per run, so a test scripting a
 * two-round exchange passes two steps. A request beyond the end of `steps` is
 * a scripting bug in the test, not a case to paper over, so it gets a loud
 * 500 naming the request number rather than silently repeating the last step.
 */
export async function startFakeOpenAi(steps: FakeStep[]): Promise<FakeOpenAiServer> {
  const requests: CapturedRequest[] = [];
  let callIndex = 0;
  const openSockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      let bodyJson: unknown;
      try {
        bodyJson = JSON.parse(bodyRaw);
      } catch {
        bodyJson = undefined;
      }

      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        bodyRaw,
        bodyJson,
      });

      const step = steps[callIndex];
      callIndex += 1;

      if (step === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: `fakeServer: no scripted step for request #${String(callIndex)}` },
          }),
        );
        return;
      }

      // Nagle's algorithm would happily coalesce several small `res.write`
      // calls into one TCP segment, which would quietly undo the "awkward
      // chunk boundary" a test is deliberately trying to provoke.
      res.socket?.setNoDelay(true);

      if (step.kind === 'stall') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return;
      }

      if (step.kind === 'json') {
        const payload = JSON.stringify(step.body);
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }

      res.writeHead(step.status ?? 200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      writeParts(res, step.parts, step.hangAfter ?? false);
    });
  });

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fakeServer: could not determine the listen address');
  }
  const { port } = address as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A stalled or aborted-but-not-yet-closed socket would otherwise hold
        // `server.close` open forever, hanging the test rather than failing
        // it — worse than any assertion failure it might have caught.
        for (const socket of openSockets) socket.destroy();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/**
 * Write each part on its own turn of the event loop rather than back-to-back
 * in the same tick, so a part boundary chosen mid-`data:`-line or mid-JSON
 * actually lands as a separate read on the client side instead of being
 * invisibly reassembled before `fetch` ever sees it.
 */
function writeParts(res: http.ServerResponse, parts: string[], hangAfter: boolean): void {
  let i = 0;
  const step = (): void => {
    if (i >= parts.length) {
      if (!hangAfter) res.end();
      return;
    }
    const part = parts[i];
    i += 1;
    res.write(part ?? '');
    setImmediate(step);
  };
  step();
}

/** One SSE `data:` line for a JSON payload, ready to drop into `parts`. */
export function chunkLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The literal terminal frame Chat Completions streams end with. */
export const DONE_LINE = 'data: [DONE]\n\n';
