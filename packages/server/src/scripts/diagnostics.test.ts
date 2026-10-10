import { describe, expect, it } from 'vitest';
import type { DiagnosticKind, DiagnosticRecord, DiagnosticSeverity } from '@agent-office/shared';
import { formatAbsolute, formatAge, group, parseArgs, type Options } from './diagnostics.js';

/**
 * Exercises the pure argument-parsing and formatting logic directly against
 * fixtures, not the CLI — `main()` does file IO (reading `diagnostics.jsonl`)
 * that these tests deliberately don't need to touch, the same split
 * `purge.test.ts` makes between `purgeRuns` and `main()`, and `traceability
 * .test.ts` makes between its own pure functions and `buildTraceabilityReport`.
 *
 * `main()` itself is guarded behind `isEntryPoint` (see the bottom of
 * `diagnostics.ts`) specifically so importing this module for `parseArgs`,
 * `group`, `formatAge` and `formatAbsolute` never runs the real CLI against
 * vitest's own `process.argv`.
 */

describe('parseArgs', () => {
  it('rejects an unrecognised flag by name, rather than silently ignoring it', () => {
    // The generic regression this guards against: any flag not in the
    // known set used to be captured into an unread Map entry and every
    // filter behaved as if the flag had never been typed at all.
    expect(() => parseArgs(['--jsno'])).toThrow(/unexpected argument "--jsno"/);
  });

  it('accepts every documented flag without throwing', () => {
    const parsed = parseArgs(['--kind', 'blocker', '--since', '24h', '--run', 'abc', '--recent', '5', '--json']);
    expect(parsed).not.toBe('help');
    const options = parsed as Options;
    expect(options.kinds).toEqual(new Set(['blocker']));
    expect(options.sinceMs).toBe(24 * 60 * 60 * 1000);
    expect(options.runId).toBe('abc');
    expect(options.recent).toBe(5);
    expect(options.json).toBe(true);
  });

  it('--recent alone defaults to 20', () => {
    const parsed = parseArgs(['--recent']) as Options;
    expect(parsed.recent).toBe(20);
  });

  it('--recent with an unparseable value throws instead of silently falling back to 20', () => {
    // This was the exact silent-typo behaviour every other numeric/duration
    // flag (`--since`) already refused to have: `Number('abc')` is `NaN`,
    // and the old code let that `NaN` flow all the way to `main`'s fallback,
    // which treated "unparseable" the same as "not supplied".
    expect(() => parseArgs(['--recent', 'abc'])).toThrow(/--recent "abc"/);
  });

  it('--recent with zero or a negative number throws', () => {
    expect(() => parseArgs(['--recent', '0'])).toThrow(/--recent "0"/);
    expect(() => parseArgs(['--recent', '-3'])).toThrow(/--recent "-3"/);
  });

  it('--recent absent stays undefined (grouped view, not chronological)', () => {
    const parsed = parseArgs([]) as Options;
    expect(parsed.recent).toBeUndefined();
  });

  it('-h and --help both request help without throwing on other flags', () => {
    expect(parseArgs(['-h'])).toBe('help');
    expect(parseArgs(['--help'])).toBe('help');
  });

  it('an unknown --kind value still throws with the known list', () => {
    expect(() => parseArgs(['--kind', 'not-a-real-kind'])).toThrow(/unknown --kind/);
  });
});

describe('formatAge', () => {
  const now = 1_700_000_000_000;

  it('renders seconds, minutes, hours and days at their respective thresholds', () => {
    expect(formatAge(now - 30_000, now)).toBe('30s ago');
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAge(now - 5 * 3_600_000, now)).toBe('5h ago');
    expect(formatAge(now - 5 * 86_400_000, now)).toBe('5d ago');
  });

  it('never goes negative for a timestamp at or after "now"', () => {
    expect(formatAge(now, now)).toBe('0s ago');
    expect(formatAge(now + 10_000, now)).toBe('0s ago');
  });
});

describe('formatAbsolute', () => {
  it('renders a sortable "YYYY-MM-DD HH:mm:ss" local timestamp', () => {
    const ts = Date.UTC(2026, 7, 14, 20, 14, 8); // 2026-08-14T20:14:08Z
    expect(formatAbsolute(ts)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('group', () => {
  // Built field-by-field, rather than `{ ...defaults, ...overrides }` on a
  // `Partial<DiagnosticRecord>`, so an omitted optional field (`agentName`,
  // `runId`) stays an absent key rather than becoming a present key holding
  // `undefined` — required under `exactOptionalPropertyTypes`, and the same
  // distinction `group()`'s own "no runId means no run" logic depends on.
  function record(overrides: {
    ts: number;
    kind?: DiagnosticKind;
    severity?: DiagnosticSeverity;
    message?: string;
    agentName?: string;
    runId?: string;
  }): DiagnosticRecord {
    const { ts, kind = 'tool-denied', severity = 'warning', message = 'wanted Bash', agentName, runId } = overrides;
    return {
      ts,
      kind,
      severity,
      message,
      ...(agentName === undefined ? {} : { agentName }),
      ...(runId === undefined ? {} : { runId }),
    };
  }

  it('groups by kind + message and counts occurrences', () => {
    const groups = group([
      record({ ts: 1, agentName: 'a1' }),
      record({ ts: 2, agentName: 'a2' }),
      record({ ts: 3, kind: 'assignment-failed', severity: 'error', message: 'budget exhausted' }),
    ]);

    expect(groups).toHaveLength(2);
    const denied = groups.find((g) => g.kind === 'tool-denied');
    expect(denied?.count).toBe(2);
    expect(denied?.agents).toEqual(new Set(['a1', 'a2']));
  });

  it('sorts errors before warnings regardless of count', () => {
    const groups = group([
      record({ ts: 1 }),
      record({ ts: 2 }),
      record({ ts: 3 }),
      record({ ts: 4, kind: 'assignment-failed', severity: 'error', message: 'budget exhausted' }),
    ]);

    expect(groups[0]?.sample.severity).toBe('error');
    expect(groups[1]?.sample.severity).toBe('warning');
  });

  it('a record with no runId contributes no run rather than a placeholder one', () => {
    const groups = group([record({ ts: 1 })]);
    expect(groups[0]?.runs.size).toBe(0);
  });
});
