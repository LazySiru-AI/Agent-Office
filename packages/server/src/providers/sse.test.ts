import { describe, expect, it } from 'vitest';
import { readSse, type SseEvent } from './sse.js';

/**
 * The SSE reader (Phase 7).
 *
 * Every HTTP provider streams through this one loop, so its bugs are not
 * localised — a dropped `data:` line is a missing sentence in an agent's report,
 * arriving with no error and no trace. Most of these tests therefore feed the
 * stream in deliberately awkward byte splits rather than clean whole events,
 * because clean input is exactly the case that never fails in production.
 */

/** A stream that delivers exactly the chunks given, in order. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      controller.enqueue(encoder.encode(chunk ?? ''));
    },
  });
}

/** Split a whole payload into fixed-size pieces, ignoring line structure. */
function shred(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

async function collect(chunks: string[], signal?: AbortSignal): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSse(streamOf(chunks), signal)) events.push(event);
  return events;
}

describe('readSse — framing', () => {
  it('yields one event per blank-line-separated block', async () => {
    const events = await collect(['data: one\n\ndata: two\n\n']);
    expect(events).toEqual([{ data: 'one' }, { data: 'two' }]);
  });

  it('carries the event name when the stream sends one', async () => {
    const events = await collect(['event: message_start\ndata: {"a":1}\n\n']);
    expect(events).toEqual([{ event: 'message_start', data: '{"a":1}' }]);
  });

  it('joins multiple data lines in one event with newlines, per the spec', async () => {
    const events = await collect(['data: first\ndata: second\n\n']);
    expect(events).toEqual([{ data: 'first\nsecond' }]);
  });

  it('accepts CRLF line endings, which a proxy may introduce', async () => {
    const events = await collect(['event: ping\r\ndata: hello\r\n\r\ndata: bye\r\n\r\n']);
    expect(events).toEqual([{ event: 'ping', data: 'hello' }, { data: 'bye' }]);
  });

  it('ignores comment lines, which providers send as keep-alives', async () => {
    // Treating a keep-alive as data would inject a blank line into an agent's
    // report — visible in the PDF, and traceable to nothing.
    const events = await collect([': keep-alive\n\ndata: real\n\n']);
    expect(events).toEqual([{ data: 'real' }]);
  });

  it('strips exactly one space after the colon, leaving further spaces as data', async () => {
    const events = await collect(['data:  indented\n\n']);
    expect(events).toEqual([{ data: ' indented' }]);
  });

  it('yields a trailing event that has no blank line after it', async () => {
    // Providers do this when they close the connection straight after the
    // terminal event. Dropping it loses the last thing the model said.
    const events = await collect(['data: one\n\ndata: last']);
    expect(events).toEqual([{ data: 'one' }, { data: 'last' }]);
  });

  it('emits nothing for an empty stream, rather than one empty event', async () => {
    expect(await collect([])).toEqual([]);
    expect(await collect([''])).toEqual([]);
    expect(await collect(['\n\n'])).toEqual([]);
  });
});

describe('readSse — chunk boundaries', () => {
  // The failure this module exists to prevent. A network chunk has no reason to
  // align with a line, and a reader that assumes it does drops tokens silently.
  const payload =
    'event: content_block_delta\ndata: {"type":"text_delta","text":"hello"}\n\n' +
    'event: content_block_delta\ndata: {"type":"text_delta","text":" world"}\n\n' +
    'event: message_stop\ndata: {}\n\n';

  const expected: SseEvent[] = [
    { event: 'content_block_delta', data: '{"type":"text_delta","text":"hello"}' },
    { event: 'content_block_delta', data: '{"type":"text_delta","text":" world"}' },
    { event: 'message_stop', data: '{}' },
  ];

  it('reassembles correctly however the bytes are split', async () => {
    // Every split size from one character upward: at size 1 the boundary falls
    // inside `data:` itself, inside the JSON, and between the two newlines of
    // every separator, which is every boundary case at once.
    for (const size of [1, 2, 3, 7, 13, 32, 64, 1000]) {
      const events = await collect(shred(payload, size));
      expect(events, `split into ${size}-character chunks`).toEqual(expected);
    }
  });

  it('handles a split falling exactly between the two newlines of a separator', async () => {
    const events = await collect(['data: one\n', '\ndata: two\n\n']);
    expect(events).toEqual([{ data: 'one' }, { data: 'two' }]);
  });

  it('handles a multi-byte character split across two chunks', async () => {
    // A £ or an em dash landing on a chunk boundary must not become U+FFFD.
    // `TextDecoder` with `stream: true` is what makes this work; a fresh
    // decoder per chunk would corrupt the character and the corruption would
    // reach the report.
    const encoded = new TextEncoder().encode('data: cost £10 — fine\n\n');
    const cut = encoded.indexOf(0xc2); // first byte of the two-byte £
    expect(cut).toBeGreaterThan(0);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, cut + 1));
        controller.enqueue(encoded.slice(cut + 1));
        controller.close();
      },
    });

    const events: SseEvent[] = [];
    for await (const event of readSse(stream)) events.push(event);
    expect(events).toEqual([{ data: 'cost £10 — fine' }]);
  });
});

describe('readSse — cancellation and limits', () => {
  it('stops when the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    // An endless stream: without the abort this loop never terminates, so the
    // test failing looks like a hang, which is the honest signal here.
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(encoder.encode('data: tick\n\n'));
      },
    });

    const seen: SseEvent[] = [];
    for await (const event of readSse(stream, controller.signal)) {
      seen.push(event);
      if (seen.length === 3) controller.abort();
    }

    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it('returns immediately for a null body rather than throwing', async () => {
    // `fetch` gives a null body for a 204, and a provider hitting that path
    // should see an empty stream, not a crash.
    const events: SseEvent[] = [];
    for await (const event of readSse(null)) events.push(event);
    expect(events).toEqual([]);
  });

  it('refuses to buffer an unbounded stream that never sends a boundary', async () => {
    // A provider that streams megabytes with no blank line would otherwise grow
    // the buffer until the process dies. Failing loudly is the lesser harm.
    const encoder = new TextEncoder();
    const megabyte = 'x'.repeat(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(megabyte));
      },
    });

    await expect(async () => {
      for await (const _event of readSse(stream)) {
        // The stream never produces an event; the guard must fire first.
      }
    }).rejects.toThrow(/exceeded/);
  });
});
