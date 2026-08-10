import type { AgentEvent } from '@agent-office/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LineSplitter,
  MAX_LINE_LENGTH,
  normaliseFrame,
  parseFrame,
  splitLines,
  type SplitEvent,
} from './parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

const AUTH_FAILURE = readFixture('auth-failure.jsonl');
const SYNTHETIC_SUCCESS = readFixture('synthetic-success.jsonl');
const MALFORMED = readFixture('malformed.jsonl');

/**
 * Runs the full pipeline (split → parse → normalise) over `content`, fed to
 * the splitter in chunks of `chunkSize` characters. This is how a real
 * adapter composes the two exported concerns, and how the chunk-boundary
 * tests below prove the composition is chunk-size-independent.
 */
function runPipeline(
  content: string,
  chunkSize: number,
  assignmentId = 'a1',
): { events: AgentEvent[]; malformedLines: number; unrecognisedFrames: number } {
  const splitter = new LineSplitter();
  const events: AgentEvent[] = [];
  let malformedLines = 0;
  let unrecognisedFrames = 0;

  function handle(splitEvent: SplitEvent): void {
    if (splitEvent.kind === 'overflow') return; // covered separately below
    const parsed = parseFrame(splitEvent.text);
    if (parsed.kind === 'parse-error') {
      malformedLines += 1;
      return;
    }
    if (parsed.kind === 'ignorable') return;

    const { events: frameEvents, recognised } = normaliseFrame(parsed.frame, assignmentId);
    if (!recognised) unrecognisedFrames += 1;
    events.push(...frameEvents);
  }

  const size = chunkSize <= 0 ? content.length || 1 : chunkSize;
  for (let i = 0; i < content.length; i += size) {
    for (const splitEvent of splitter.push(content.slice(i, i + size))) handle(splitEvent);
  }
  for (const splitEvent of splitter.finish()) handle(splitEvent);

  return { events, malformedLines, unrecognisedFrames };
}

describe('LineSplitter: chunk-boundary correctness', () => {
  it('reassembles a JSON object split across two chunks mid-object', () => {
    const splitter = new LineSplitter();
    const first = splitter.push('{"type":"assist');
    expect(first).toEqual([]);
    const second = splitter.push('ant"}\n');
    expect(second).toEqual([{ kind: 'line', text: '{"type":"assistant"}', trailing: false }]);
  });

  it('emits multiple complete lines found within a single chunk', () => {
    const splitter = new LineSplitter();
    const events = splitter.push('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(events).toEqual([
      { kind: 'line', text: '{"a":1}', trailing: false },
      { kind: 'line', text: '{"a":2}', trailing: false },
      { kind: 'line', text: '{"a":3}', trailing: false },
    ]);
  });

  it('strips a trailing CR (Windows CRLF) from each line', () => {
    const splitter = new LineSplitter();
    const events = splitter.push('{"a":1}\r\n{"a":2}\r\n');
    expect(events).toEqual([
      { kind: 'line', text: '{"a":1}', trailing: false },
      { kind: 'line', text: '{"a":2}', trailing: false },
    ]);
  });

  it('handles a CRLF split exactly between the \\r and the \\n across chunks', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\r')).toEqual([]);
    expect(splitter.push('\n{"a":2}\r\n')).toEqual([
      { kind: 'line', text: '{"a":1}', trailing: false },
      { kind: 'line', text: '{"a":2}', trailing: false },
    ]);
  });

  it('emits a trailing fragment, tagged, when the stream ends without a final newline', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"incomplete":')).toEqual([
      { kind: 'line', text: '{"a":1}', trailing: false },
    ]);
    expect(splitter.finish()).toEqual([{ kind: 'line', text: '{"incomplete":', trailing: true }]);
  });

  it('emits nothing at finish() when the stream ended cleanly on a newline', () => {
    const splitter = new LineSplitter();
    splitter.push('{"a":1}\n');
    expect(splitter.finish()).toEqual([]);
  });

  it('emits nothing at finish() for an empty trailing tail', () => {
    const splitter = new LineSplitter();
    splitter.push('{"a":1}\n   ');
    // Whitespace-only isn't literally empty, so it is still surfaced as a
    // trailing fragment; parseFrame is what treats blank content as ignorable.
    expect(splitter.finish()).toEqual([{ kind: 'line', text: '   ', trailing: true }]);

    const emptySplitter = new LineSplitter();
    emptySplitter.push('{"a":1}\n');
    expect(emptySplitter.finish()).toEqual([]);
  });
});

describe('LineSplitter: the memory cap', () => {
  it('surfaces an overflow instead of growing the buffer without bound, then recovers on the next line', () => {
    const splitter = new LineSplitter({ maxLineLength: 10 });
    const events: SplitEvent[] = [];

    events.push(...splitter.push('12345')); // 5 chars, under cap, buffered
    events.push(...splitter.push('67890AB')); // now 12 chars total, over the 10-char cap
    events.push(...splitter.push('CDEF\n')); // rest of the runaway line, discarded
    events.push(...splitter.push('{"a":1}\n')); // a normal line right after must still parse

    expect(events).toEqual([
      { kind: 'overflow', discardedChars: 12 },
      { kind: 'line', text: '{"a":1}', trailing: false },
    ]);
  });

  it('overflows a single line that arrives already over the cap in one chunk', () => {
    const splitter = new LineSplitter({ maxLineLength: 10 });
    const events = splitter.push('x'.repeat(50) + '\n' + '{"a":1}\n');
    expect(events).toEqual([
      { kind: 'overflow', discardedChars: 50 },
      { kind: 'line', text: '{"a":1}', trailing: false },
    ]);
  });

  it('does not leave overflow state stuck across finish()', () => {
    const splitter = new LineSplitter({ maxLineLength: 10 });
    splitter.push('x'.repeat(50)); // no newline yet — still "in" the runaway line
    // Stream ends mid-overflow: nothing sane to flush, and no crash either.
    expect(splitter.finish()).toEqual([]);
  });

  it('the default MAX_LINE_LENGTH is generous enough not to clip realistic frames', () => {
    // A large-but-realistic tool_result embedding a few hundred KB of file
    // content must never be mistaken for a runaway line.
    const splitter = new LineSplitter();
    const big = `{"type":"user","content":"${'x'.repeat(500_000)}"}\n`;
    const events = splitter.push(big);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('line');
    expect(MAX_LINE_LENGTH).toBeGreaterThan(500_000);
  });
});

describe('splitLines: async generator wrapper', () => {
  it('yields the same lines as manual push/finish, for an async source', async () => {
    async function* source(): AsyncGenerator<string> {
      yield '{"a":1}\n{"inc';
      yield 'omplete":true}';
    }

    const lines: SplitEvent[] = [];
    for await (const event of splitLines(source())) lines.push(event);

    expect(lines).toEqual([
      { kind: 'line', text: '{"a":1}', trailing: false },
      { kind: 'line', text: '{"incomplete":true}', trailing: true },
    ]);
  });

  it('accepts a plain synchronous iterable too', async () => {
    const lines: SplitEvent[] = [];
    for await (const event of splitLines(['{"a":1}\n', '{"a":2}\n'])) lines.push(event);
    expect(lines).toEqual([
      { kind: 'line', text: '{"a":1}', trailing: false },
      { kind: 'line', text: '{"a":2}', trailing: false },
    ]);
  });
});

describe('parseFrame', () => {
  it('treats a blank line as ignorable, not an error', () => {
    expect(parseFrame('')).toEqual({ kind: 'ignorable', reason: 'blank line' });
    expect(parseFrame('   ')).toEqual({ kind: 'ignorable', reason: 'blank line' });
  });

  it('reports invalid JSON as a parse error without throwing', () => {
    const result = parseFrame('not json at all');
    expect(result.kind).toBe('parse-error');
  });

  it('reports truncated JSON as a parse error without throwing', () => {
    const result = parseFrame('{"type":"assistant","message":{"content":[{"type":"text","text":"cut off');
    expect(result.kind).toBe('parse-error');
  });

  it('reports valid JSON with no recognisable frame shape as a parse error', () => {
    expect(parseFrame('[1,2,3]').kind).toBe('parse-error');
    expect(parseFrame('"just a string"').kind).toBe('parse-error');
  });

  it('parses a well-formed frame', () => {
    const result = parseFrame('{"type":"system","subtype":"init"}');
    expect(result).toEqual({ kind: 'frame', frame: { type: 'system', subtype: 'init' } });
  });

  it('still parses (as a frame) a JSON object whose type this build has never heard of', () => {
    const result = parseFrame('{"type":"unknown_future_frame","payload":{"anything":true}}');
    expect(result.kind).toBe('frame');
  });
});

describe('normaliseFrame: assistant frames', () => {
  it('maps a text block to a text event', () => {
    const frame = JSON.parse(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result.recognised).toBe(true);
    expect(result.events).toEqual([{ t: 'text', assignmentId: 'a1', chunk: 'hello' }]);
  });

  it('skips thinking blocks entirely — reasoning is never agent output', () => {
    const frame = JSON.parse(
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"internal reasoning"},{"type":"text","text":"final answer"}]}}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result.events).toEqual([{ t: 'text', assignmentId: 'a1', chunk: 'final answer' }]);
    expect(JSON.stringify(result.events)).not.toContain('internal reasoning');
  });

  it('derives a short summary for a tool_use block from its file_path input', () => {
    const frame = JSON.parse(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/auth/session.ts"}}]}}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result.events).toEqual([
      { t: 'tool', assignmentId: 'a1', name: 'Read', summary: 'Read src/auth/session.ts' },
    ]);
  });

  it('derives a summary from command/pattern/url when file_path/path are absent', () => {
    const bash = normaliseFrame(
      JSON.parse(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}',
      ),
      'a1',
    );
    expect(bash.events).toEqual([{ t: 'tool', assignmentId: 'a1', name: 'Bash', summary: 'Bash npm test' }]);

    const grep = normaliseFrame(
      JSON.parse(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"TODO"}}]}}',
      ),
      'a1',
    );
    expect(grep.events).toEqual([{ t: 'tool', assignmentId: 'a1', name: 'Grep', summary: 'Grep TODO' }]);
  });

  it('falls back to the bare tool name when no known summary field is present', () => {
    const result = normaliseFrame(
      JSON.parse('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"MysteryTool","input":{"weird":1}}]}}'),
      'a1',
    );
    expect(result.events).toEqual([{ t: 'tool', assignmentId: 'a1', name: 'MysteryTool', summary: 'MysteryTool' }]);
  });

  it('truncates a long summary value rather than dumping the whole thing', () => {
    const longCommand = 'echo ' + 'x'.repeat(200);
    const result = normaliseFrame(
      JSON.parse(
        `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":${JSON.stringify(longCommand)}}}]}}`,
      ),
      'a1',
    );
    const summary = result.events[0];
    expect(summary?.t).toBe('tool');
    if (summary?.t === 'tool') {
      expect(summary.summary.length).toBeLessThan(longCommand.length);
      expect(summary.summary.startsWith('Bash echo ')).toBe(true);
      expect(summary.summary.endsWith('…')).toBe(true);
    }
  });

  it('emits an artifact event alongside the tool event for a Write call naming a file', () => {
    const result = normaliseFrame(
      JSON.parse(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"reports/01.md","content":"# Report"}}]}}',
      ),
      'a1',
    );
    expect(result.events).toEqual([
      { t: 'tool', assignmentId: 'a1', name: 'Write', summary: 'Write reports/01.md' },
      { t: 'artifact', assignmentId: 'a1', path: 'reports/01.md' },
    ]);
  });

  it('does not emit an artifact event for a Read call, even though it also carries file_path', () => {
    const result = normaliseFrame(
      JSON.parse(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"reports/01.md"}}]}}',
      ),
      'a1',
    );
    expect(result.events.some((e) => e.t === 'artifact')).toBe(false);
  });

  it('emits usage once per assistant frame, folding cache counters into totals', () => {
    const frame = JSON.parse(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":40,"output_tokens":92,"cache_creation_input_tokens":0,"cache_read_input_tokens":13400}}}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result.events).toEqual([
      { t: 'text', assignmentId: 'a1', chunk: 'hi' },
      { t: 'usage', assignmentId: 'a1', inputTokens: 40 + 13400, outputTokens: 92 },
    ]);
  });

  it('emits no usage event when the frame carries none', () => {
    const result = normaliseFrame(
      JSON.parse('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'),
      'a1',
    );
    expect(result.events.some((e) => e.t === 'usage')).toBe(false);
  });

  it('CRITICAL: a synthetic error turn produces a fatal error, never a text event carrying the message', () => {
    const frame = JSON.parse(
      '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed","is_api_error_message":true}',
    );
    const result = normaliseFrame(frame, 'a1');

    expect(result.events).toContainEqual({
      t: 'error',
      assignmentId: 'a1',
      message: 'Not logged in · Please run /login',
      fatal: true,
    });
    expect(result.events.some((e) => e.t === 'text')).toBe(false);
  });

  it('falls back to the error code when a synthetic error turn carries no text block', () => {
    const frame = JSON.parse(
      '{"type":"assistant","message":{"content":[]},"error":"authentication_failed","is_api_error_message":true}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result.events).toContainEqual({
      t: 'error',
      assignmentId: 'a1',
      message: 'authentication_failed',
      fatal: true,
    });
  });

  it('survives a text block missing its text field, producing no event and no crash', () => {
    const result = normaliseFrame(
      JSON.parse('{"type":"assistant","message":{"content":[{"type":"text"}]}}'),
      'a1',
    );
    expect(result.recognised).toBe(true);
    expect(result.events).toEqual([]);
  });
});

describe('normaliseFrame: user, system, stream_event and unrecognised frames', () => {
  it('emits nothing for a user frame carrying a tool_result', () => {
    const frame = JSON.parse(
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file contents here"}]}}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result).toEqual({ events: [], recognised: true });
  });

  it('emits nothing for a system frame, but still counts as recognised', () => {
    const result = normaliseFrame(JSON.parse('{"type":"system","subtype":"init"}'), 'a1');
    expect(result).toEqual({ events: [], recognised: true });
  });

  it('emits nothing for a stream_event frame, but still counts as recognised', () => {
    const result = normaliseFrame(JSON.parse('{"type":"stream_event"}'), 'a1');
    expect(result).toEqual({ events: [], recognised: true });
  });

  it('flags a genuinely unknown frame type as unrecognised, so the caller can count it', () => {
    const result = normaliseFrame(
      JSON.parse('{"type":"unknown_future_frame","payload":{"anything":true}}'),
      'a1',
    );
    expect(result).toEqual({ events: [], recognised: false });
  });
});

describe('normaliseFrame: result frames', () => {
  it('is_error is the authority, not subtype: a failed run with subtype "success" still reports fatal', () => {
    const frame = JSON.parse(
      '{"type":"result","is_error":true,"subtype":"success","result":"Not logged in","terminal_reason":"api_error"}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result.events).toEqual([{ t: 'error', assignmentId: 'a1', message: 'Not logged in', fatal: true }]);
  });

  it('falls back to terminal_reason when result carries no message', () => {
    const frame = JSON.parse('{"type":"result","is_error":true,"terminal_reason":"error"}');
    const result = normaliseFrame(frame, 'a1');
    expect(result.events).toEqual([{ t: 'error', assignmentId: 'a1', message: 'error', fatal: true }]);
  });

  it('emits nothing for a successful result frame — no double-counted total usage', () => {
    const frame = JSON.parse(
      '{"type":"result","is_error":false,"subtype":"success","total_cost_usd":0.04,"usage":{"input_tokens":1575,"output_tokens":480}}',
    );
    const result = normaliseFrame(frame, 'a1');
    expect(result).toEqual({ events: [], recognised: true });
  });
});

describe('fixture: auth-failure.jsonl (real capture)', () => {
  const lines = AUTH_FAILURE.split('\n').filter((l) => l.trim().length > 0);

  it('produces a fatal error and never leaks the error text as a text event', () => {
    const events: AgentEvent[] = [];
    for (const line of lines) {
      const parsed = parseFrame(line);
      if (parsed.kind !== 'frame') continue;
      events.push(...normaliseFrame(parsed.frame, 'a1').events);
    }

    const errors = events.filter((e): e is Extract<AgentEvent, { t: 'error' }> => e.t === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.fatal)).toBe(true);
    expect(errors.some((e) => e.message.includes('Not logged in'))).toBe(true);

    const texts = events.filter((e) => e.t === 'text');
    expect(texts).toEqual([]);
    for (const event of events) {
      if (event.t === 'error') continue;
      expect(JSON.stringify(event)).not.toContain('Not logged in');
    }
  });
});

describe('fixture: synthetic-success.jsonl (derived)', () => {
  function collect(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const line of SYNTHETIC_SUCCESS.split('\n')) {
      const parsed = parseFrame(line);
      if (parsed.kind !== 'frame') continue;
      events.push(...normaliseFrame(parsed.frame, 'a1').events);
    }
    return events;
  }

  it('produces the expected text, tool, artifact and usage events, and a clean finish', () => {
    const events = collect();

    const textChunks = events.filter((e) => e.t === 'text').map((e) => (e.t === 'text' ? e.chunk : ''));
    expect(textChunks).toEqual([
      "I'll review the authentication module.",
      'Review complete. The session module does not rotate tokens on privilege change.',
    ]);

    const tools = events.filter((e) => e.t === 'tool');
    expect(tools).toEqual([
      { t: 'tool', assignmentId: 'a1', name: 'Read', summary: 'Read src/auth/session.ts' },
      { t: 'tool', assignmentId: 'a1', name: 'Write', summary: 'Write reports/01-code-reviewer.md' },
    ]);

    expect(events).toContainEqual({
      t: 'artifact',
      assignmentId: 'a1',
      path: 'reports/01-code-reviewer.md',
    });

    // No fatal error anywhere in a successful run's frames.
    expect(events.some((e) => e.t === 'error')).toBe(false);

    // Four assistant frames in the fixture each carry usage → four usage
    // events, including cache-read counters folded into inputTokens.
    const usageEvents = events.filter((e): e is Extract<AgentEvent, { t: 'usage' }> => e.t === 'usage');
    expect(usageEvents).toHaveLength(4);
    expect(usageEvents[0]).toEqual({ t: 'usage', assignmentId: 'a1', inputTokens: 1420 + 12000, outputTokens: 38 });
    expect(usageEvents[usageEvents.length - 1]).toEqual({
      t: 'usage',
      assignmentId: 'a1',
      inputTokens: 60 + 14900,
      outputTokens: 210,
    });

    // The terminal `result` frame (is_error: false) contributes no extra
    // event of its own — the run's completion is a process-exit concern for
    // the adapter, not something this normaliser invents.
  });
});

describe('fixture: malformed.jsonl (hand-written edge cases)', () => {
  it('survives every malformed line and still produces the events from the valid lines around them', () => {
    const lines = MALFORMED.split('\n');
    const events: AgentEvent[] = [];
    let malformedLines = 0;
    let unrecognisedFrames = 0;

    for (const line of lines) {
      const parsed = parseFrame(line);
      if (parsed.kind === 'parse-error') {
        malformedLines += 1;
        continue;
      }
      if (parsed.kind === 'ignorable') continue;

      const { events: frameEvents, recognised } = normaliseFrame(parsed.frame, 'a1');
      if (!recognised) unrecognisedFrames += 1;
      events.push(...frameEvents);
    }

    // "not json at all" and the truncated line are each one parse error.
    expect(malformedLines).toBe(2);
    // "unknown_future_frame" parses as JSON but is not a frame type this
    // build understands.
    expect(unrecognisedFrames).toBe(1);

    // The valid text frame survives and produces its event.
    expect(events).toContainEqual({ t: 'text', assignmentId: 'a1', chunk: 'partial work survives' });
    expect(events).toContainEqual({
      t: 'usage',
      assignmentId: 'a1',
      inputTokens: 10,
      outputTokens: 5,
    });

    // The text block missing its `text` field produces no event, no crash.
    // The final result frame (is_error: true) still reports fatal.
    expect(events).toContainEqual({
      t: 'error',
      assignmentId: 'a1',
      message: 'stream ended badly',
      fatal: true,
    });

    // Nothing beyond what is asserted above: the init frame is a no-op, and
    // the text-missing-its-text-field frame contributes nothing.
    expect(events).toHaveLength(3);
  });
});

describe('chunk-boundary equivalence: the highest-value test in this file', () => {
  const cases: Array<[string, string]> = [
    ['auth-failure.jsonl', AUTH_FAILURE],
    ['synthetic-success.jsonl', SYNTHETIC_SUCCESS],
    ['malformed.jsonl', MALFORMED],
  ];

  for (const [name, content] of cases) {
    it(`produces an identical event sequence for ${name} at 1-byte, 7-byte and whole-file chunk sizes`, () => {
      const wholeFile = runPipeline(content, content.length);
      const sevenByte = runPipeline(content, 7);
      const oneByte = runPipeline(content, 1);

      expect(sevenByte.events).toEqual(wholeFile.events);
      expect(oneByte.events).toEqual(wholeFile.events);

      expect(sevenByte.malformedLines).toBe(wholeFile.malformedLines);
      expect(oneByte.malformedLines).toBe(wholeFile.malformedLines);

      expect(sevenByte.unrecognisedFrames).toBe(wholeFile.unrecognisedFrames);
      expect(oneByte.unrecognisedFrames).toBe(wholeFile.unrecognisedFrames);

      // Sanity: this fixture actually produced something, so the assertions
      // above are not vacuously true over three empty arrays.
      expect(wholeFile.events.length).toBeGreaterThan(0);
    });
  }
});
