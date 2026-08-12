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
}

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
    return { token: pinned, pinned: true };
  }
  return { token: generateAuthToken(), pinned: false };
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
