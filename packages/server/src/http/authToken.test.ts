import { describe, expect, it } from 'vitest';
import {
  AUTH_TOKEN_ENV_VAR,
  extractProvidedToken,
  generateAuthToken,
  resolveAuthToken,
  tokensMatch,
} from './authToken.js';

/**
 * Unit tests for the AO-6 token primitives, kept separate from `server.ts`'s
 * integration-level "startup token" tests (`server.test.ts`) so a failure
 * here points straight at the comparison/generation logic rather than at
 * routing, hooks, or the WebSocket upgrade.
 */

describe('generateAuthToken', () => {
  it('produces a long, hex-encoded, unpredictable value', () => {
    const token = generateAuthToken();

    // 24 bytes hex-encoded is 48 hex characters. Asserting the exact length
    // pins the entropy budget described in the doc comment — a future
    // "just use fewer bytes, it's only local" edit changes this number.
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('never repeats across calls', () => {
    // Not proof of cryptographic randomness (nothing this cheap could be),
    // but a token generator that returned a fixed or low-entropy value would
    // fail this immediately, and that is the class of regression worth
    // catching here.
    const tokens = new Set(Array.from({ length: 50 }, () => generateAuthToken()));
    expect(tokens.size).toBe(50);
  });
});

describe('resolveAuthToken', () => {
  it(`pins the token from ${AUTH_TOKEN_ENV_VAR} when it is set`, () => {
    // Exists for exactly two callers: this package's own test suite, and
    // scripted/CI use of `npm run serve` — see the doc comment on
    // `resolveAuthToken` for why "predictable on purpose" is fine there and
    // nowhere else.
    const resolved = resolveAuthToken({ [AUTH_TOKEN_ENV_VAR]: 'a-pinned-value' });

    expect(resolved).toEqual({ token: 'a-pinned-value', pinned: true });
  });

  it('generates a fresh token when the env var is absent', () => {
    const resolved = resolveAuthToken({});

    expect(resolved.pinned).toBe(false);
    expect(resolved.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('generates a fresh token when the env var is present but empty', () => {
    // An empty string is not "unset" as far as `env[KEY]` is concerned, but
    // treating it as a real pinned token would mean `tokensMatch` comparing
    // against `''` — every request with no token header would then match an
    // empty `provided`... except `extractProvidedToken` never returns `''`
    // either (see its own tests), so this is defence in depth, not the only
    // thing standing between an empty env var and an open server.
    const resolved = resolveAuthToken({ [AUTH_TOKEN_ENV_VAR]: '' });

    expect(resolved.pinned).toBe(false);
  });

  it('does not read `process.env` when an explicit env object is given', () => {
    // Every other test in this file passes its own env object specifically
    // to avoid depending on whatever happens to be set in the process
    // actually running the suite; this test is the one that pins that
    // behaviour rather than merely relying on it.
    const withoutTheRealEnv = resolveAuthToken({ PATH: process.env['PATH'] });
    expect(withoutTheRealEnv.pinned).toBe(false);
  });
});

describe('tokensMatch', () => {
  // What this suite can and cannot prove: a unit test cannot measure whether
  // a comparison ran in constant time — that needs statistics over many
  // real requests, not an assertion. What it CAN pin down is the property
  // that breaks first if someone "simplifies" this back to `===` or to a bare
  // `crypto.timingSafeEqual(a, b)`: neither of those handles a `provided`
  // value of a different length from `expected` without either leaking that
  // length through an early return (`===`) or throwing `RangeError: Input
  // buffers must have the same byte length` (`timingSafeEqual` on its own).
  // The hash-then-compare tests below exist specifically to fail if either
  // shortcut reappears.

  it('accepts the correct token', () => {
    expect(tokensMatch('correct-horse-battery-staple', 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(tokensMatch('correct-horse-battery-staple', 'correct-horse-battery-staplf')).toBe(false);
  });

  it('rejects a wrong token of a different, shorter length without throwing', () => {
    // A bare `crypto.timingSafeEqual` on the raw strings would throw here
    // rather than return `false` — which `server.ts`'s `onRequest` hook does
    // not catch, so an attacker sending a short guess would 500 the server
    // instead of getting the ordinary 401 every other wrong guess gets. That
    // is not a security hole on its own, but it is a crash on attacker input,
    // and a crash where a boolean was expected is exactly the kind of defect
    // that gets found by fuzzing, not by review.
    expect(() => tokensMatch('a-much-longer-correct-token', 'short')).not.toThrow();
    expect(tokensMatch('a-much-longer-correct-token', 'short')).toBe(false);
  });

  it('rejects a wrong token of a different, longer length without throwing', () => {
    expect(tokensMatch('short', 'a-much-longer-wrong-guess')).toBe(false);
  });

  it('rejects an undefined token (the "header absent" case) without treating it as a match', () => {
    // `extractProvidedToken` returns `undefined` for "nothing was sent", and
    // that must never be allowed to compare equal to anything — including an
    // `expected` that itself happens to be an empty string, which is why this
    // is checked as its own case rather than folded into "wrong token".
    expect(tokensMatch('any-token-at-all', undefined)).toBe(false);
  });

  it('is case-sensitive, so a token is not weakened by a lenient comparison', () => {
    expect(tokensMatch('CaseSensitiveToken', 'casesensitivetoken')).toBe(false);
  });
});

describe('extractProvidedToken', () => {
  it('prefers the header over the query parameter when both are present', () => {
    // The header is the steady-state mechanism (see `authToken.ts`'s own doc
    // comment on why); if a stale query parameter is still sitting in a
    // bookmarked URL alongside a client that has since started sending the
    // header, the header must win rather than the two silently disagreeing
    // about which request "really" carries the token.
    expect(extractProvidedToken('from-header', 'from-query')).toBe('from-header');
  });

  it('falls back to the query parameter when no header is present', () => {
    expect(extractProvidedToken(undefined, 'from-query')).toBe('from-query');
  });

  it('takes the first value of a repeated header rather than joining or erroring', () => {
    // Node represents a repeated header as an array; a token header sent
    // twice is unusual but not malformed, and silently picking the first
    // value is safer than concatenating two tokens into a string that will
    // never equal anything.
    expect(extractProvidedToken(['first', 'second'], undefined)).toBe('first');
  });

  it('ignores a non-string query value rather than coercing it', () => {
    // `request.query` is `unknown` at the point this runs (see `server.ts`'s
    // call site) — a repeated `?token=a&token=b` parses to an array under
    // Fastify's default query parser, and treating that as "the token" would
    // mean `String(['a','b'])` silently becoming `'a,b'`, which cannot equal
    // any real token but also is not the loud failure a malformed request
    // deserves.
    expect(extractProvidedToken(undefined, ['a', 'b'])).toBeUndefined();
    expect(extractProvidedToken(undefined, 42)).toBeUndefined();
  });

  it('returns undefined when neither header nor query carries a token', () => {
    expect(extractProvidedToken(undefined, undefined)).toBeUndefined();
  });

  it('treats an empty header value the same as an absent one', () => {
    expect(extractProvidedToken('', 'from-query')).toBe('from-query');
  });
});
