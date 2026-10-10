import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-office/shared';
import { createToolEventThrottle, parseArgs } from './run.js';

/**
 * Exercises `parseArgs` directly against fixture argv arrays — no subprocess,
 * no registry, no provider. `main()`'s file/network IO is deliberately not
 * under test here, matching `purge.test.ts`'s split between the pure
 * selection logic and the CLI's own IO shell.
 *
 * The two defects these tests exist to pin down:
 *
 *   - P1: a boolean flag (`--quiet`) used to swallow the next bare word into
 *     the task instead of rejecting it, silently corrupting the one input a
 *     paid run is built from. See `run.ts`'s long comment above `parseArgs`.
 *   - P3: `-h`/`--help` used to be checked in the same left-to-right pass as
 *     everything else, so a malformed invocation could throw before the loop
 *     ever reached a `--help` later in argv.
 */

describe('parseArgs — help precedence (P3)', () => {
  it('returns "help" for a bare --help', () => {
    expect(parseArgs(['--help'])).toBe('help');
  });

  it('returns "help" for -h', () => {
    expect(parseArgs(['-h'])).toBe('help');
  });

  it('honours --help even when it trails a completely malformed invocation', () => {
    // Before the fix, `--bogus` (an unrecognised flag) would throw before the
    // loop ever reached `--help` sitting after it — the exact ordering defect
    // this dedicated first pass exists to remove.
    expect(parseArgs(['--bogus', '--help'])).toBe('help');
  });

  it('honours --help even alongside the P1 defect shape (--quiet followed by a stray word)', () => {
    expect(parseArgs(['do the thing', '--quiet', 'false', '--help'])).toBe('help');
  });

  it('honours --help even when the task is entirely missing', () => {
    expect(parseArgs(['--help'])).toBe('help');
  });
});

describe('parseArgs — positionals-before-flags (P1)', () => {
  it('joins multiple positional words into the task when no flag precedes them', () => {
    const result = parseArgs(['audit', 'this', 'repo']);
    expect(result).not.toBe('help');
    if (result === 'help') throw new Error('unreachable');
    expect(result.task).toBe('audit this repo');
  });

  it('accepts --quiet as a bare boolean flag with no following value consumed', () => {
    const result = parseArgs(['a task', '--quiet']);
    if (result === 'help') throw new Error('unreachable');
    expect(result.task).toBe('a task');
    expect(result.quiet).toBe(true);
  });

  it('REGRESSION: rejects a bare word left over after --quiet, naming it, instead of joining it onto the task', () => {
    // This is the exact defect from the UAT report: `npm run run --
    // "audit this" --quiet false` used to silently become task
    // "audit this false".
    expect(() => parseArgs(['audit this', '--quiet', 'false'])).toThrow(/unexpected argument "false"/);
  });

  it('rejects a stray positional after a value-taking flag has already been consumed', () => {
    expect(() => parseArgs(['a task', '--provider', 'scripted', 'extra'])).toThrow(
      /unexpected argument "extra"/,
    );
  });

  it('does not fail must-not-start-a-run cases open: the error is thrown, not swallowed', () => {
    expect(() => parseArgs(['a task', '--quiet', 'false'])).toThrow(Error);
  });
});

describe('parseArgs — unrecognised flags', () => {
  it('rejects an unknown --flag by name, matching the traceability.ts "unexpected argument" shape', () => {
    expect(() => parseArgs(['a task', '--bogus', 'x'])).toThrow(/unexpected argument "--bogus"/);
  });

  it('rejects a flag from the OTHER script (agent.ts) as unrecognised here', () => {
    expect(() => parseArgs(['a task', '--replace-prompt'])).toThrow(/unexpected argument "--replace-prompt"/);
  });
});

describe('parseArgs — ordinary, well-formed invocations still work', () => {
  it('parses a task with no flags at all', () => {
    const result = parseArgs(['just a task']);
    if (result === 'help') throw new Error('unreachable');
    expect(result.task).toBe('just a task');
    expect(result.quiet).toBe(false);
    expect(result.maxCostUsd).toBeUndefined();
  });

  it('parses --max-cost, --concurrency, --timeout, --budget together', () => {
    const result = parseArgs([
      'a task',
      '--max-cost',
      '0.5',
      '--concurrency',
      '2',
      '--timeout',
      '1000',
      '--budget',
      '4000',
    ]);
    if (result === 'help') throw new Error('unreachable');
    expect(result.maxCostUsd).toBe(0.5);
    expect(result.concurrency).toBe(2);
    expect(result.timeoutMs).toBe(1000);
    expect(result.tokenBudget).toBe(4000);
  });

  it('rejects a non-positive numeric flag', () => {
    expect(() => parseArgs(['a task', '--concurrency', '-1'])).toThrow(/--concurrency must be a positive number/);
  });

  it('rejects a value-taking flag given no value at all', () => {
    expect(() => parseArgs(['a task', '--provider'])).toThrow(/option --provider needs a value/);
  });

  it('rejects an empty task', () => {
    expect(() => parseArgs([])).toThrow(/no task given/);
  });

  it('resolves --provider, defaulting when omitted', () => {
    const withProvider = parseArgs(['a task', '--provider', 'scripted']);
    if (withProvider === 'help') throw new Error('unreachable');
    expect(withProvider.provider).toBe('scripted');

    const withoutProvider = parseArgs(['a task']);
    if (withoutProvider === 'help') throw new Error('unreachable');
    expect(withoutProvider.provider).toBe('claude-code');
  });
});

/**
 * F6 (P2): `createToolEventThrottle` is the console-visibility fix — `tool`
 * events used to reach only the per-assignment `.jsonl` log, so a real
 * (paid) assignment printed one line at start and one at the end, with
 * nothing in between to tell "working" from "hung" for the whole run. See
 * `TOOL_LOG_INTERVAL_MS`'s comment in `run.ts` for the full reasoning,
 * including the throttling scheme's rejected alternatives.
 *
 * A fake clock is used throughout — a real-timer test here would be either
 * slow (waiting out `TOOL_LOG_INTERVAL_MS` for real) or flaky (a shorter
 * interval racing the test process's own scheduling jitter).
 */
describe('createToolEventThrottle (F6)', () => {
  function toolEvent(assignmentId: string, summary: string): Extract<AgentEvent, { t: 'tool' }> {
    return { t: 'tool', assignmentId, name: 'Read', summary };
  }

  it('prints the first tool call for an assignment immediately', () => {
    let now = 0;
    const throttle = createToolEventThrottle(() => now, 5_000);

    const line = throttle(toolEvent('a1', 'Read src/app.ts'));
    expect(line).toBe('  a1                       tool: Read src/app.ts');
  });

  it('suppresses a second call within the interval', () => {
    let now = 0;
    const throttle = createToolEventThrottle(() => now, 5_000);

    throttle(toolEvent('a1', 'Read src/app.ts'));
    now = 1_000; // well inside the 5s window
    const line = throttle(toolEvent('a1', 'Bash npm test'));
    expect(line).toBeUndefined();
  });

  it('prints again once the interval elapses, folding suppressed calls into a "(+N more)" suffix', () => {
    let now = 0;
    const throttle = createToolEventThrottle(() => now, 5_000);

    throttle(toolEvent('a1', 'Read src/app.ts')); // printed
    now = 1_000;
    throttle(toolEvent('a1', 'Bash npm test')); // suppressed (1)
    now = 2_000;
    throttle(toolEvent('a1', 'Grep TODO')); // suppressed (2)
    now = 5_500; // past the 5s window measured from t=0
    const line = throttle(toolEvent('a1', 'Write out.md'));

    expect(line).toBe('  a1                       tool: Write out.md (+2 more)');
  });

  it('does not silently drop suppressed activity: the "(+N more)" count is never lost', () => {
    let now = 0;
    const throttle = createToolEventThrottle(() => now, 1_000);

    // All 10 calls happen at the same instant (now stays 0 throughout the
    // loop): the first prints immediately, the remaining 9 are suppressed.
    for (let i = 0; i < 10; i += 1) {
      throttle(toolEvent('a1', `call ${i}`));
    }
    now = 1_000;
    const line = throttle(toolEvent('a1', 'call 10'));

    // 1 printed (call 0) + 9 suppressed (call 1..9) in the loop, then this
    // one prints with all 9 folded in — none of the suppressed activity is
    // silently dropped, only batched into the count.
    expect(line).toBe('  a1                       tool: call 10 (+9 more)');
  });

  it('tracks each assignment independently — a busy assignment cannot starve a quiet one', () => {
    let now = 0;
    const throttle = createToolEventThrottle(() => now, 5_000);

    throttle(toolEvent('busy', 'call 1'));
    now = 500;
    expect(throttle(toolEvent('busy', 'call 2'))).toBeUndefined(); // busy is throttled

    // A DIFFERENT assignment's first call still prints immediately, even
    // though "busy" is mid-suppression — the throttle is keyed per
    // assignment, not global.
    const quietLine = throttle(toolEvent('quiet', 'call 1'));
    expect(quietLine).toBe('  quiet                    tool: call 1');
  });

  it('resets the suppressed count after each print, rather than accumulating across intervals', () => {
    let now = 0;
    const throttle = createToolEventThrottle(() => now, 1_000);

    throttle(toolEvent('a1', 'first')); // printed, lastPrintedAt = 0
    now = 500; // still inside the 1s window measured from 0
    throttle(toolEvent('a1', 'suppressed')); // suppressed (1)
    now = 1_200; // 1200ms since the last PRINT (not since the suppressed call)
    const secondPrint = throttle(toolEvent('a1', 'second')); // printed, +1, lastPrintedAt = 1200
    expect(secondPrint).toBe('  a1                       tool: second (+1 more)');

    now = 2_500; // 1300ms since the SECOND print — well past the window again
    // Nothing was suppressed between the second print and this call, so no
    // suffix should reappear carrying over the earlier count.
    const thirdPrint = throttle(toolEvent('a1', 'third'));
    expect(thirdPrint).toBe('  a1                       tool: third');
  });
});
