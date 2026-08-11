import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@agent-office/shared';
import {
  EMPTY_QUERY,
  countRuns,
  formatAge,
  isReplayable,
  queryRuns,
  type RunFilter,
} from './runHistory.js';

/**
 * The run history browser's logic (Phase 7).
 *
 * Constructed in full rather than cast from a partial: `RunSummary` has
 * required fields, and a cast that hid one would let a test pass against a
 * shape the server never sends.
 */
function makeRun(overrides: Partial<RunSummary> & Pick<RunSummary, 'id'>): RunSummary {
  return {
    task: 'Review something',
    status: 'done',
    createdAt: 1_000,
    updatedAt: 1_000,
    live: false,
    ...overrides,
  };
}

const RUNS: RunSummary[] = [
  makeRun({ id: '20260810-100000-aaaa', task: 'Review our vendor NDA for liability terms', updatedAt: 100 }),
  makeRun({ id: '20260810-110000-bbbb', task: 'Corporation tax in Ireland', updatedAt: 300, status: 'failed' }),
  makeRun({ id: '20260809-120000-cccc', task: 'Refactor the payments service', updatedAt: 200, status: 'cancelled' }),
  makeRun({ id: '20260811-090000-dddd', task: 'Survey the RAG literature', updatedAt: 50, live: true, status: 'running' }),
];

describe('queryRuns — ordering', () => {
  it('floats a live run above newer finished ones', () => {
    // The live run has the *oldest* updatedAt here, deliberately: burying the
    // thing currently executing under yesterday's history is the failure this
    // rule exists to prevent.
    const result = queryRuns(RUNS, EMPTY_QUERY);
    expect(result[0]?.id).toBe('20260811-090000-dddd');
  });

  it('orders the rest newest-updated first', () => {
    const result = queryRuns(RUNS, EMPTY_QUERY).filter((run) => !run.live);
    expect(result.map((r) => r.updatedAt)).toEqual([300, 200, 100]);
  });

  it('does not mutate the array it was given', () => {
    // `Array.prototype.sort` sorts in place, and this list comes straight from
    // React state — sorting it in place would mutate state and skip a render.
    const original = [...RUNS];
    queryRuns(RUNS, EMPTY_QUERY);
    expect(RUNS).toEqual(original);
  });
});

describe('queryRuns — search', () => {
  it('matches the task case-insensitively', () => {
    const result = queryRuns(RUNS, { search: 'IRELAND', filter: 'all' });
    expect(result.map((r) => r.id)).toEqual(['20260810-110000-bbbb']);
  });

  it('ANDs multiple words in any order', () => {
    // "tax ireland" must find a task that says "…tax in Ireland", which a
    // single substring match would miss.
    const result = queryRuns(RUNS, { search: 'ireland tax', filter: 'all' });
    expect(result.map((r) => r.id)).toEqual(['20260810-110000-bbbb']);
  });

  it('searches the run id, so a date prefix works as a date filter', () => {
    const result = queryRuns(RUNS, { search: '20260810', filter: 'all' });
    expect(result).toHaveLength(2);
  });

  it('treats an empty or whitespace-only search as no search', () => {
    expect(queryRuns(RUNS, { search: '', filter: 'all' })).toHaveLength(4);
    expect(queryRuns(RUNS, { search: '   ', filter: 'all' })).toHaveLength(4);
  });

  it('returns nothing when nothing matches, rather than everything', () => {
    expect(queryRuns(RUNS, { search: 'zzzz', filter: 'all' })).toEqual([]);
  });
});

describe('queryRuns — filters', () => {
  const cases: { filter: RunFilter; expected: string[] }[] = [
    { filter: 'all', expected: ['dddd', 'bbbb', 'cccc', 'aaaa'] },
    { filter: 'live', expected: ['dddd'] },
    { filter: 'finished', expected: ['aaaa'] },
    // `failed` covers `cancelled` too: to someone scanning for "runs that
    // produced nothing" they are one category.
    { filter: 'failed', expected: ['bbbb', 'cccc'] },
  ];

  for (const scenario of cases) {
    it(`the ${scenario.filter} filter selects the right runs`, () => {
      const result = queryRuns(RUNS, { search: '', filter: scenario.filter });
      expect(result.map((r) => r.id.slice(-4))).toEqual(scenario.expected);
    });
  }

  it('combines a filter with a search', () => {
    const result = queryRuns(RUNS, { search: 'payments', filter: 'failed' });
    expect(result.map((r) => r.id.slice(-4))).toEqual(['cccc']);
  });
});

describe('countRuns', () => {
  it('counts each category, with cancelled folded into failed', () => {
    expect(countRuns(RUNS)).toEqual({ all: 4, live: 1, finished: 1, failed: 2 });
  });

  it('counts an empty history as all zeroes rather than throwing', () => {
    expect(countRuns([])).toEqual({ all: 0, live: 0, finished: 0, failed: 0 });
  });
});

describe('formatAge', () => {
  const NOW = 1_000_000_000_000;
  const MINUTE = 60_000;

  it('reads as "just now" under a minute', () => {
    expect(formatAge(NOW - 5_000, NOW)).toBe('just now');
  });

  it('steps up through minutes, hours and days', () => {
    expect(formatAge(NOW - 4 * MINUTE, NOW)).toBe('4m ago');
    expect(formatAge(NOW - 3 * 60 * MINUTE, NOW)).toBe('3h ago');
    expect(formatAge(NOW - 3 * 24 * 60 * MINUTE, NOW)).toBe('3d ago');
  });

  it('falls back to a date beyond a month, where "47d ago" stops meaning anything', () => {
    expect(formatAge(NOW - 60 * 24 * 60 * MINUTE, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not produce a negative age from a clock skew', () => {
    // The server stamps `updatedAt`; a client clock running slow would
    // otherwise render "-3m ago", which reads as a bug in the app rather than
    // in the clock.
    expect(formatAge(NOW + 10_000, NOW)).toBe('just now');
  });
});

describe('isReplayable', () => {
  it('is true for a finished run that is not executing here', () => {
    expect(isReplayable(makeRun({ id: 'x', status: 'done' }))).toBe(true);
    expect(isReplayable(makeRun({ id: 'x', status: 'failed' }))).toBe(true);
    expect(isReplayable(makeRun({ id: 'x', status: 'cancelled' }))).toBe(true);
  });

  it('is false while a run is still going', () => {
    expect(isReplayable(makeRun({ id: 'x', status: 'running' }))).toBe(false);
    expect(isReplayable(makeRun({ id: 'x', status: 'done', live: true }))).toBe(false);
  });
});
