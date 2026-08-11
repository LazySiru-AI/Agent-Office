import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A local stand-in for `api.anthropic.com` (Phase 7).
 *
 * This is the entire verification story for `provider.ts`: no API key exists
 * on this machine, so nothing here is ever checked against a live endpoint.
 * What IS checked, thoroughly, is "given a server that speaks the wire format
 * documented in `protocol.ts`, does the adapter behave correctly" — the SSE
 * parsing, the tool-use loop, the abort path, the error handling. That is a
 * real and valuable thing to verify; it is just not the same claim as "this
 * works against Anthropic's actual servers". See `protocol.ts`'s module doc
 * for the line between the two.
 *
 * Built on `node:http` rather than `msw` or similar because the awkward-chunk
 * tests need control over exactly when bytes hit the socket — a mocking layer
 * that intercepts at the `fetch` level would never let a `data:` line be torn
 * in half across two writes, which is precisely the case `sse.ts` exists to
 * survive and the case this file is asked to provoke.
 */

export interface FakeAnthropicRequestRecord {
  readonly method: string;
  readonly path: string;
  /** Node lower-cases header names; a caller checking `x-api-key` etc. gets this as-is. */
  readonly headers: Record<string, string | string[] | undefined>;
  /** Parsed as JSON when the body is valid JSON, `undefined` otherwise (or empty body). */
  readonly body: unknown;
  readonly rawBody: string;
}

/**
 * One scripted reply to one request. Consumed in order — the Nth call to
 * `/v1/messages` gets `responses[N]`. A test driving the tool-use loop passes
 * two entries: the tool-use turn, then the follow-up turn.
 */
export type FakeAnthropicResponse =
  /** A normal SSE reply. `parts` are written to the socket one at a time. */
  | {
      readonly kind: 'sse';
      readonly status?: number;
      readonly parts: readonly string[];
      /**
       * Delay between writes, in milliseconds. `0` (the default) still yields
       * to the event loop between writes via `setImmediate`, which is enough
       * in practice to keep Node from coalescing consecutive `res.write`
       * calls into one TCP segment — the condition needed to actually provoke
       * a chunk boundary landing mid `data:` line on the client end, rather
       * than merely asserting it in a synthetic `ReadableStream` (already
       * covered exhaustively by `sse.test.ts`). This file's job is proving
       * the real fetch → readSse → provider pipeline survives it too.
       */
      readonly delayMs?: number;
    }
  /** A non-streaming JSON error body, e.g. a 401 or 429. */
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  /** Sends headers, then never writes or ends — for cancellation tests. */
  | { readonly kind: 'stall' }
  /** Escape hatch for a shape the other three cannot express. */
  | { readonly kind: 'custom'; readonly handle: (req: IncomingMessage, res: ServerResponse) => void };

export interface StartFakeAnthropicResult {
  readonly url: string;
  /** Every request received, in arrival order. Assertion surface for tests. */
  readonly requests: FakeAnthropicRequestRecord[];
  close(): Promise<void>;
}

export async function startFakeAnthropic(
  responses: readonly FakeAnthropicResponse[],
): Promise<StartFakeAnthropicResult> {
  const requests: FakeAnthropicRequestRecord[] = [];
  let callIndex = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const record: FakeAnthropicRequestRecord = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: { ...req.headers },
        body: parseJsonQuietly(rawBody),
        rawBody,
      };
      requests.push(record);

      const response = responses[callIndex];
      callIndex += 1;

      if (response === undefined) {
        // A test that scripted fewer turns than the adapter actually sent is
        // a bug in the test (or a bug in the tool-use loop's bound), not
        // something to fail silently on — a 500 with an explicit count makes
        // either failure mode loud rather than hanging the request.
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'test_setup_error',
              message: `fake Anthropic server received request ${String(callIndex)} but only ${String(responses.length)} response(s) were scripted`,
            },
          }),
        );
        return;
      }

      void serveOne(response, req, res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake Anthropic server failed to bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function serveOne(response: FakeAnthropicResponse, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (response.kind === 'json') {
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
    return;
  }

  if (response.kind === 'stall') {
    // Headers only: enough for `fetch()` to resolve with a 200 and an open
    // body stream, so the adapter is genuinely blocked inside `readSse`
    // rather than never having started — the shape that only an abort (not a
    // timeout that never fires) can recover from.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return;
  }

  if (response.kind === 'custom') {
    response.handle(req, res);
    return;
  }

  // 'sse'
  res.writeHead(response.status ?? 200, { 'content-type': 'text/event-stream' });
  for (const part of response.parts) {
    res.write(part);
    await pause(response.delayMs);
  }
  res.end();
}

function pause(ms: number | undefined): Promise<void> {
  if (ms === undefined || ms <= 0) {
    // Still a real async gap — `setImmediate` defers past the current I/O
    // callback so Node's socket layer gets a chance to flush what was just
    // written before the next `write` is queued, rather than both landing in
    // the same synchronous burst.
    return new Promise((resolve) => setImmediate(resolve));
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonQuietly(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Small helpers for building `sse` response scripts in tests.
// ---------------------------------------------------------------------------

/** Format one SSE frame the way the real API does: `event:` line + `data:` line + blank line. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Split a whole payload into fixed-size pieces, deliberately ignoring line
 * structure — the same shredding technique `sse.test.ts` uses, applied here
 * so a test can force a cut in the middle of a `data:` line specifically.
 */
export function shred(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}
