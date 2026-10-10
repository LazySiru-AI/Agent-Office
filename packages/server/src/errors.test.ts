import { describe, expect, it } from 'vitest';
import { errorDetail } from './errors.js';

describe('errorDetail', () => {
  it('carries the stack', () => {
    const detail = errorDetail(new Error('the disk went away'));

    expect(detail).toContain('the disk went away');
    // A stack, not just the message — the thing every one-line `describe` copy
    // at a layer boundary throws away.
    expect(detail).toContain('errors.test.ts');
  });

  it('walks the cause chain, which is the whole reason it exists', () => {
    // The shape a sanitising route produces: a safe summary for the client,
    // wrapped around the real error that named an absolute path.
    const root = new Error('EACCES: permission denied, open /runs/abc/report.pdf');
    const wrapped = new Error('artifact "reports/01.pdf" not found in run "abc"', {
      cause: root,
    });

    const detail = errorDetail(wrapped);

    expect(detail).toContain('not found in run');
    expect(detail).toContain('Caused by:');
    expect(detail).toContain('EACCES: permission denied');
  });

  it('follows more than one link', () => {
    const a = new Error('innermost');
    const b = new Error('middle', { cause: a });
    const c = new Error('outermost', { cause: b });

    const detail = errorDetail(c);

    expect(detail).toContain('outermost');
    expect(detail).toContain('middle');
    expect(detail).toContain('innermost');
  });

  it('stops at a bounded depth, so a cycle cannot hang the failure path', () => {
    // `a.cause === b` and `b.cause === a`. Nothing in this repository builds
    // one, but a cause chain is user-supplied structure by the time it reaches
    // here — it can arrive from a provider adapter — and this runs inside a
    // request's error handling, where an unbounded walk is the last thing
    // anyone wants.
    const a = new Error('ping');
    const b = new Error('pong', { cause: a });
    (a as { cause?: unknown }).cause = b;

    const detail = errorDetail(a);

    expect(detail).toBeDefined();
    // The head plus at most four links: bounded, whatever the input does.
    expect((detail ?? '').split('Caused by:').length - 1).toBeLessThanOrEqual(4);
  });

  it('handles a non-Error cause without pretending it has a stack', () => {
    const detail = errorDetail(new Error('outer', { cause: 'a bare string' }));

    expect(detail).toContain('Caused by: a bare string');
  });

  it('is undefined for a non-Error, because there is nothing a summary lost', () => {
    expect(errorDetail('just a string')).toBeUndefined();
    expect(errorDetail(undefined)).toBeUndefined();
    expect(errorDetail({ message: 'shaped like an error, is not one' })).toBeUndefined();
  });

  it('falls back to name and message when there is no stack', () => {
    // Not paranoia: `stack` is optional in the spec, and this system's failures
    // routinely arrive from a provider CLI as objects rehydrated from JSON.
    const stackless = new Error('came from another process');
    delete (stackless as { stack?: string }).stack;

    expect(errorDetail(stackless)).toBe('Error: came from another process');
  });
});
