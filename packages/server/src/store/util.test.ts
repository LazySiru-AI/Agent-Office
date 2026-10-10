import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnsafePathError } from './types.js';
import { assertSafeRelativePath, assertValidRunId, newRunId, resolveWithin } from './util.js';

/**
 * `assertSafeRelativePath` is the only thing standing between an LLM-authored
 * `deliverable` string and the user's filesystem (NFR-1), so the escape cases
 * matter more than the happy ones.
 *
 * Control characters are built with `String.fromCharCode` rather than written
 * literally: a source file containing raw control bytes is treated as binary by
 * git and grep, which has already bitten this project once.
 */

const WINDOWS = path.sep === '\\';
const NUL = String.fromCharCode(0);

describe('assertSafeRelativePath', () => {
  it('accepts an ordinary report path unchanged', () => {
    expect(assertSafeRelativePath('reports/01-x.md')).toBe('reports/01-x.md');
    expect(assertSafeRelativePath('reports/appendix/02-y.md')).toBe('reports/appendix/02-y.md');
    expect(assertSafeRelativePath('report.md')).toBe('report.md');
  });

  it('normalises redundant segments', () => {
    expect(assertSafeRelativePath('./reports/01-x.md')).toBe('reports/01-x.md');
    expect(assertSafeRelativePath('reports/./01-x.md')).toBe('reports/01-x.md');
    // Climbing back down into the run directory is fine; only escaping it is not.
    expect(assertSafeRelativePath('reports/sub/../01-x.md')).toBe('reports/01-x.md');
  });

  it('normalises Windows separators to forward slashes on Windows', () => {
    const result = assertSafeRelativePath('reports\\01-x.md');
    if (WINDOWS) {
      expect(result).toBe('reports/01-x.md');
    } else {
      // On POSIX a backslash is a legal filename character, not a separator, so
      // this is one file named `reports\01-x.md` — still safely inside the run.
      expect(result).toBe('reports\\01-x.md');
    }
  });

  it('rejects paths that climb out of the run directory', () => {
    for (const bad of ['..', '../x', '../../x', 'a/../../b', 'reports/../../escape.md']) {
      expect(() => assertSafeRelativePath(bad)).toThrow(UnsafePathError);
    }
  });

  it('rejects backslash traversal on Windows', () => {
    if (WINDOWS) {
      expect(() => assertSafeRelativePath('..\\escape.md')).toThrow(UnsafePathError);
      expect(() => assertSafeRelativePath('reports\\..\\..\\escape.md')).toThrow(UnsafePathError);
    } else {
      // POSIX reads these as filenames, so they stay inside the run directory.
      expect(assertSafeRelativePath('..\\escape.md')).toBe('..\\escape.md');
    }
  });

  it('rejects absolute and drive-letter paths', () => {
    for (const bad of [
      '/etc/passwd',
      '/reports/01-x.md',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      'c:/Windows/System32',
      'D:relative.md',
    ]) {
      expect(() => assertSafeRelativePath(bad)).toThrow(UnsafePathError);
    }
  });

  it('rejects empty and whitespace-only paths', () => {
    for (const bad of ['', ' ', '\t', '   \n  ']) {
      expect(() => assertSafeRelativePath(bad)).toThrow(UnsafePathError);
    }
  });

  it('rejects control characters, including the NUL truncation trick', () => {
    expect(() => assertSafeRelativePath(`reports/01.md${NUL}.txt`)).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath(`reports/${String.fromCharCode(10)}x.md`)).toThrow(
      UnsafePathError,
    );
    expect(() => assertSafeRelativePath(`reports/${String.fromCharCode(127)}x.md`)).toThrow(
      UnsafePathError,
    );
  });

  it('throws UnsafePathError naming the offending path', () => {
    expect(() => assertSafeRelativePath('../escape.md')).toThrow('../escape.md');
    try {
      assertSafeRelativePath('../escape.md');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafePathError);
      expect((error as Error).name).toBe('UnsafePathError');
    }
  });
});

describe('resolveWithin', () => {
  const base = path.resolve('runs', '20240102-030405-abcd');

  it('resolves a relative path to an absolute one inside the base', () => {
    expect(resolveWithin(base, 'reports/01-x.md')).toBe(path.join(base, 'reports', '01-x.md'));
    expect(resolveWithin(base, './logs/a1.jsonl')).toBe(path.join(base, 'logs', 'a1.jsonl'));
  });

  it('rejects anything that escapes the base', () => {
    for (const bad of ['../escape.md', '../../escape.md', 'a/../../b', '/etc/passwd']) {
      expect(() => resolveWithin(base, bad)).toThrow(UnsafePathError);
    }
  });

  it('rejects a path that resolves to the base itself', () => {
    // `.` survives the string checks but must not be usable as a file target.
    expect(() => resolveWithin(base, '.')).toThrow(UnsafePathError);
  });

  it('resolves the base itself, so a relative base is not a hole', () => {
    const relativeBase = path.join('runs', '20240102-030405-abcd');
    expect(resolveWithin(relativeBase, 'report.md')).toBe(path.join(base, 'report.md'));
  });
});

describe('newRunId', () => {
  const clock = new Date(2024, 0, 2, 3, 4, 5);

  it('formats as YYYYMMDD-HHMMSS-xxxx', () => {
    expect(newRunId(clock, () => 0)).toBe('20240102-030405-aaaa');
    expect(newRunId()).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  it('zero-pads every component', () => {
    expect(newRunId(new Date(2024, 8, 5, 6, 7, 8), () => 0)).toBe('20240905-060708-aaaa');
    expect(newRunId(new Date(2024, 11, 31, 23, 59, 59), () => 0)).toBe('20241231-235959-aaaa');
  });

  it('is deterministic given a clock and a random source', () => {
    expect(newRunId(clock, () => 0)).toBe(newRunId(clock, () => 0));
    // The last slot of the alphabet, to prove the index never runs off the end.
    expect(newRunId(clock, () => 0.999999)).toBe('20240102-030405-9999');
  });

  it('sorts lexically in chronological order', () => {
    const ids = [
      newRunId(new Date(2023, 11, 31, 23, 59, 59), () => 0),
      newRunId(new Date(2024, 0, 2, 3, 4, 5), () => 0),
      newRunId(new Date(2024, 0, 2, 3, 4, 6), () => 0),
      newRunId(new Date(2024, 9, 1, 0, 0, 0), () => 0),
    ];

    expect([...ids].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(ids);
    // Descending order is what `listRuns` relies on for "newest first".
    expect([...ids].sort((a, b) => b.localeCompare(a, 'en'))).toEqual([...ids].reverse());
  });

  it('produces ids that are valid run ids', () => {
    expect(assertValidRunId(newRunId())).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
  });
});

describe('assertValidRunId', () => {
  it('returns the id it was given', () => {
    expect(assertValidRunId('20240102-030405-abcd')).toBe('20240102-030405-abcd');
    expect(assertValidRunId('a')).toBe('a');
    expect(assertValidRunId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects ids that could become a directory traversal', () => {
    for (const bad of ['..', '../', '../escape', 'a/b', 'a\\b', '/abs', 'C:\\runs']) {
      expect(() => assertValidRunId(bad)).toThrow(UnsafePathError);
    }
  });

  it('rejects empty, over-long, uppercase and otherwise odd ids', () => {
    for (const bad of ['', ' ', 'a'.repeat(65), 'ABC', '20240102-030405-ABCD', '-leading', '.', 'a b', 'a_b']) {
      expect(() => assertValidRunId(bad)).toThrow(UnsafePathError);
    }
  });
});
