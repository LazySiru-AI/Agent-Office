import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The startup token (AO-6, NFR-6's other half).
 *
 * `server.ts`'s `Host`/`Origin` checks close the browser-facing gap: a page the
 * user did not knowingly point at this process cannot reach it, whether by DNS
 * rebinding or ordinary cross-origin fetch. Neither check is a user boundary,
 * because neither one asks "who is asking" — only "does this request's headers
 * look like they came from a browser tab aimed at this origin". Loopback is
 * shared by every process and every account on the machine. A second local
 * user, or a lower-privilege process that could not otherwise read this user's
 * files, can open a raw socket to `127.0.0.1:<port>` directly — no browser, no
 * `Host` header to get wrong, no `Origin` to omit-and-therefore-pass — and it
 * sails through both checks because both are about the shape of the request,
 * not who sent it. From there it can `POST /api/runs` and spawn real, billed
 * child processes as this user's account, read every run's reports and
 * workspace files, and cancel work in flight.
 *
 * The fix is the same one Jupyter has shipped for years for the identical
 * problem (a loopback dev server with real side effects and no other identity
 * check): a random token, generated fresh at process start, required on every
 * request. Knowing the token is what "having legitimate access to this
 * process" means here — nothing else on the machine can guess it, and nothing
 * about the transport (loopback, a valid `Host`, a valid `Origin`) substitutes
 * for it.
 */

/** Set this to pin the token — scripted use, CI, and this package's own tests. */
export const AUTH_TOKEN_ENV_VAR = 'AGENT_OFFICE_TOKEN';

/**
 * Case-insensitive on the wire (Node/Fastify lower-case incoming header names
 * regardless of how a client capitalises them), spelled lower-case here so a
 * reader is not left wondering whether the casing matters.
 */
export const AUTH_TOKEN_HEADER = 'x-agent-office-token';

/**
 * The fallback carrier for a request that cannot set a header — see the long
 * comment on {@link extractProvidedToken} for exactly which requests that is
 * and why it is deliberately not "all of them".
 */
export const AUTH_TOKEN_QUERY_PARAM = 'token';

/**
 * 24 random bytes (192 bits), hex-encoded to a 48-character string.
 *
 * Sized the way Jupyter sizes its own (`secrets.token_hex(24)`): comfortably
 * beyond what an on-machine guesser could brute force before the process
 * restarts and invalidates it, while still short enough to read out over a
 * terminal and paste. This is not a password meant to be memorised — it is a
 * bearer credential meant to be copied once per session, so entropy is the
 * only property that matters and length-for-memorability is not a
 * consideration at all.
 */
export function generateAuthToken(): string {
  return randomBytes(24).toString('hex');
}

export interface ResolvedAuthToken {
  token: string;
  /** True when the token came from {@link AUTH_TOKEN_ENV_VAR} rather than being freshly generated. */
  pinned: boolean;
  /**
   * True when `token` is too short/low-entropy to be a meaningful bearer
   * credential — see {@link estimateEntropyBits} for exactly what "too" means
   * and why that threshold, not a shorter or longer one, was chosen.
   *
   * S6: the pin exists so CI and this package's own tests can hand the
   * process a fixed value instead of scraping a freshly generated one off
   * stdout (see the doc comment on {@link resolveAuthToken}), and that use is
   * legitimate at any strength — a test asserting "the wrong token is
   * rejected" does not need 192 bits of entropy to do its job, and refusing a
   * weak pin outright would break exactly the callers this mechanism exists
   * for. So `resolveAuthToken` never rejects on strength; it *always* reports
   * it, and it is on the caller (`scripts/serve.ts`'s startup banner) to
   * decide what a human should be told before an actual network-reachable
   * process starts trusting `AGENT_OFFICE_TOKEN=1` as if it carried the same
   * weight as `generateAuthToken()`'s 192 bits. Silence was the actual
   * defect: the banner reported a weak pin identically to a strong generated
   * token, so an operator who pinned `1` for a quick local test and then
   * left the process reachable had nothing telling them the door was
   * effectively unlocked.
   */
  weak: boolean;
}

/**
 * A minimum-entropy estimate, not a strength meter — good enough to flag
 * `AGENT_OFFICE_TOKEN=1` without pretending to model an attacker's actual
 * knowledge of the token's structure. Detects which character classes
 * (lower, upper, digit, other/punctuation) the value actually uses, sums a
 * conservative size for each present class, and estimates entropy as
 * `length * log2(charsetSize)` — the standard "each character drawn
 * independently and uniformly from this alphabet" approximation. It is an
 * upper bound, not a measurement: `aaaaaaaaaaaaaaaa` scores as if every
 * character were unpredictable, when repetition means it plainly is not. A
 * true measurement (e.g. compressibility or an actual entropy estimator)
 * would catch that, but is more machinery than a "does this look like a
 * placeholder" gate needs, and the estimate this function does make is
 * strictly generous to the token — so it can under-flag a contrived
 * low-entropy-but-technically-diverse string, but it never over-flags a
 * genuinely random one, which is the direction of error that matters for a
 * warning rather than a hard rejection.
 */
function estimateEntropyBits(value: string): number {
  let charsetSize = 0;
  if (/[a-z]/.test(value)) charsetSize += 26;
  if (/[A-Z]/.test(value)) charsetSize += 26;
  if (/[0-9]/.test(value)) charsetSize += 10;
  // A conservative count of the printable ASCII punctuation/symbol range,
  // not an exhaustive one — good enough to credit "has punctuation" without
  // claiming to know exactly which symbols a caller might use.
  if (/[^a-zA-Z0-9]/.test(value)) charsetSize += 32;
  if (charsetSize === 0) return 0;
  return value.length * Math.log2(charsetSize);
}

/**
 * The minimum-entropy bar a token must clear to be reported as not weak.
 *
 * 64 bits, not the 192 bits {@link generateAuthToken} actually produces:
 * this is a floor for "not trivially guessable", not a target for "as strong
 * as the generator". 64 bits is OWASP's own minimum for a session
 * identifier (Session Management Cheat Sheet: "at least 64 bits of
 * randomness") — a comparable bearer-credential problem, and a number with
 * an external citation behind it rather than one picked to make a specific
 * test pass. At 64 bits, brute-forcing this token by sending guesses to the
 * loopback HTTP server (the only channel `tokensMatch` is ever reached
 * through — see that function's doc comment) is not a practical attack
 * before a human would notice something hammering the port; at the same
 * time it is comfortably clearable by anything that looks like a real
 * secret (a 16+ character mixed-case-and-digit string, a UUID, any value
 * copied from a real secrets manager), so it does not nag a caller who
 * pinned something reasonable. It does flag the actual failure case this
 * finding is about: `AGENT_OFFICE_TOKEN=1` is 1 character of digits, roughly
 * 3.3 bits — nowhere close.
 */
const WEAK_TOKEN_ENTROPY_BITS = 64;

/**
 * The token this process will require, decided once at startup.
 *
 * A pinned value from `AGENT_OFFICE_TOKEN` exists for exactly two callers that
 * cannot perform an interactive "read the token off stdout, paste it
 * somewhere" handshake: this package's own test suite (see `server.test.ts`,
 * `supervisor.test.ts`'s HTTP-adjacent fixtures) and scripted/CI use of `npm
 * run serve`. Everyone else gets a token nobody chose and nobody could have
 * predicted, which is the property that actually matters — a fixed default
 * baked into the source would be exactly as reachable by another local account
 * as no token at all, since anyone can read the source.
 */
export function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): ResolvedAuthToken {
  const pinned = env[AUTH_TOKEN_ENV_VAR];
  if (typeof pinned === 'string' && pinned.length > 0) {
    return { token: pinned, pinned: true, weak: estimateEntropyBits(pinned) < WEAK_TOKEN_ENTROPY_BITS };
  }
  const token = generateAuthToken();
  return { token, pinned: false, weak: estimateEntropyBits(token) < WEAK_TOKEN_ENTROPY_BITS };
}

/**
 * Constant-time comparison, deliberately not `===`.
 *
 * `===` on two strings short-circuits at the first differing character (or the
 * first byte past the shorter string's length), so the time it takes to
 * return `false` leaks two things to anyone who can measure it precisely
 * enough from a shared machine: how many characters of a guess were correct,
 * and — from the fact that a same-length wrong guess takes measurably longer
 * than a wrong-length one — the token's exact length. Neither is a lot of
 * information from one request, but the whole point of a token is that it
 * cannot be recovered faster than brute force, and a timing oracle turns
 * "brute force the whole keyspace" into "brute force one character position at
 * a time", which is a different and much cheaper problem.
 *
 * `node:crypto`'s `timingSafeEqual` closes the content-comparison side of that
 * but requires equal-length buffers and throws on a mismatch — so comparing
 * `expected` against a `provided` value of a different length would either
 * throw (revealing nothing useful, but an exception is not the shape this
 * function should have for a routine "wrong token" case) or, if guarded with a
 * length check first, leak the length back out through the branch that skips
 * the constant-time comparison entirely. Hashing both sides to a fixed-length
 * digest before comparing removes the second problem too: `timingSafeEqual`
 * always receives two 32-byte buffers, so neither branch nor timing depends on
 * how long the caller's guess happened to be.
 */
export function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

/**
 * Pull the caller's token out of a request, header first.
 *
 * The query-parameter fallback exists for exactly one situation: a browser's
 * *very first* navigation to a URL this process printed at startup
 * (`http://127.0.0.1:<port>/?token=...`, the Jupyter pattern). That request is
 * a top-level navigation, not a script-issued `fetch`, so there is no
 * JavaScript in the loop yet to attach a header — the token can only travel in
 * the URL itself. Every request after that first load is issued by this
 * application's own client code (`packages/web/src/api.ts`), which reads the
 * query parameter exactly once, stores it, and switches to the header for
 * everything else — see that file's own comment for why staying on the query
 * parameter would be worse than a one-time exposure.
 *
 * The server side cannot enforce "query parameter only on the first request"
 * — it has no session concept and NFR-6 is not about to grow one for this —
 * so it accepts the query parameter on any request that carries it, header or
 * not. That is deliberately more permissive than the client's own discipline,
 * and is safe only because a request that used the query form is exactly as
 * authenticated as one that used the header: the token is the token either
 * way, and neither path skips {@link tokensMatch}.
 */
export function extractProvidedToken(
  headerValue: string | string[] | undefined,
  queryValue: unknown,
): string | undefined {
  if (typeof headerValue === 'string' && headerValue.length > 0) return headerValue;
  if (Array.isArray(headerValue) && typeof headerValue[0] === 'string' && headerValue[0].length > 0) {
    return headerValue[0];
  }
  if (typeof queryValue === 'string' && queryValue.length > 0) return queryValue;
  return undefined;
}
