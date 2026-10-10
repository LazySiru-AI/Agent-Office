import { describe, expect, it } from 'vitest';
import { isSubmittableToken, sanitizeTokenInput } from './AuthRecovery.js';

/**
 * The two decisions `AuthRecovery.tsx` makes that are decisions rather than
 * markup — see that file's own comment for why they are pulled out as pure
 * functions: this package's suite runs under plain Node with no DOM, so the
 * component's rendered `disabled` attribute and the value it eventually
 * hands to `onSubmit` are both unassertable here, but the functions behind
 * them are not.
 */
describe('sanitizeTokenInput (S9)', () => {
  it('returns the token unchanged when it has no surrounding whitespace', () => {
    expect(sanitizeTokenInput('abc123')).toBe('abc123');
  });

  it('trims a trailing newline — the shape of a token copied with the line it sat on', () => {
    expect(sanitizeTokenInput('abc123\n')).toBe('abc123');
  });

  it('trims leading and trailing spaces — the shape of a token copied out of a wrapped terminal line', () => {
    expect(sanitizeTokenInput('  abc123  ')).toBe('abc123');
  });

  it('does not trim or otherwise alter internal characters', () => {
    // A real token from `authToken.ts` is an opaque random string; nothing
    // about this function should assume it looks like anything in
    // particular beyond "has no leading/trailing whitespace".
    expect(sanitizeTokenInput('  a-b_c.d~e  ')).toBe('a-b_c.d~e');
  });

  it('reduces a whitespace-only input to the empty string', () => {
    expect(sanitizeTokenInput('   \n\t  ')).toBe('');
  });
});

describe('isSubmittableToken (S9) — the decision behind the Reconnect button\'s disabled state', () => {
  it('is true for a non-empty, non-whitespace token', () => {
    expect(isSubmittableToken('abc123')).toBe(true);
  });

  it('is false for an empty string — nothing has been typed yet', () => {
    expect(isSubmittableToken('')).toBe(false);
  });

  it('is false for a whitespace-only string — pasting only spaces is not a token', () => {
    expect(isSubmittableToken('   ')).toBe(false);
  });

  it('is true even when the only non-whitespace content is a single character', () => {
    expect(isSubmittableToken(' x ')).toBe(true);
  });
});
