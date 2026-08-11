/**
 * Server-sent events, read off a `fetch` response body (Phase 7).
 *
 * Every HTTP provider in this directory streams SSE, and every one of them
 * would otherwise grow its own copy of this loop. That is worth avoiding for a
 * specific reason rather than on principle: the failure this code exists to
 * prevent — a chunk boundary landing in the middle of a `data:` line, so one
 * token of the agent's answer is silently dropped — is invisible in testing
 * unless you provoke it deliberately. One implementation can be provoked once;
 * three copies fail independently and quietly.
 *
 * The transport is deliberately kept separate from any provider's *meaning*.
 * This module knows about `event:`/`data:` framing and nothing about tool calls,
 * usage or message deltas.
 */

/** One decoded SSE event. `event` is absent when the stream omits the field. */
export interface SseEvent {
  event?: string;
  data: string;
}

/** How large a single event may grow before the stream is treated as hostile. */
const MAX_EVENT_BYTES = 32 * 1024 * 1024;

/**
 * Split a byte stream into SSE events.
 *
 * Follows the WHATWG event-stream rules that matter here: events are separated
 * by a blank line, `data:` lines accumulate and are joined with newlines, a
 * single optional space after the colon is stripped, and comment lines (starting
 * `:`) are ignored — several providers send those as keep-alives, and treating
 * one as data would inject a stray blank line into an agent's report.
 *
 * `\r\n` is handled as well as `\n`: the spec permits both, and a provider
 * behind a proxy that rewrites line endings should not corrupt a run.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  if (body === null) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  // Real bytes currently sitting in `buffer`, unresolved into an event.
  //
  // This must be a byte count, not `buffer.length`: `.length` on a decoded
  // JS string counts UTF-16 code units, and a stream of multi-byte
  // characters (CJK text is 3 bytes/char in UTF-8 but 1 code unit each;
  // most emoji are 4 bytes but 2 code units, a surrogate pair) makes
  // `.length` undercount the true byte size by up to 3x. A 32MB *byte* cap
  // measured that way let an unterminated CJK stream buffer roughly 100MB
  // before tripping — three times the advertised limit. Tracking the actual
  // `byteLength` of what has been read in, minus what has been consumed out,
  // keeps the cap honest in the unit it is documented in.
  let bufferedBytes = 0;

  const onAbort = (): void => {
    // Cancelling the reader is what actually closes the socket. Without it an
    // aborted run leaves the connection open and the provider keeps billing.
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      bufferedBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      if (bufferedBytes > MAX_EVENT_BYTES) {
        throw new Error(
          `SSE stream exceeded ${MAX_EVENT_BYTES} bytes without an event boundary; refusing to buffer further`,
        );
      }

      for (;;) {
        const boundary = findBoundary(buffer);
        if (boundary === undefined) break;
        const consumedLength = boundary.index + boundary.length;
        const raw = buffer.slice(0, boundary.index);
        const consumed = buffer.slice(0, consumedLength);
        buffer = buffer.slice(consumedLength);
        // Re-encoding only the piece just consumed (bounded by one event's
        // size, not the whole stream) to keep `bufferedBytes` an accurate
        // count of what remains unresolved.
        bufferedBytes -= encoder.encode(consumed).length;

        const parsed = parseEvent(raw);
        if (parsed !== undefined) yield parsed;
      }
    }

    // A final event with no trailing blank line. Providers do this when they
    // close the connection immediately after the terminal event, and dropping
    // it would lose the last thing the model said.
    const parsed = parseEvent(buffer);
    if (parsed !== undefined) yield parsed;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** The first blank line, and how many characters it occupies. */
function findBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');

  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseEvent(raw: string): SseEvent | undefined {
  const dataLines: string[] = [];
  let eventName: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Exactly one leading space is part of the framing, not the value. More
    // than one is data — a JSON payload never starts with a space, but an
    // agent's prose might.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
  }

  if (dataLines.length === 0) return undefined;
  return {
    ...(eventName === undefined ? {} : { event: eventName }),
    data: dataLines.join('\n'),
  };
}
