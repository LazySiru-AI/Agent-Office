/**
 * What an error looks like when it is written down rather than thrown.
 *
 * ## The problem this exists for
 *
 * An audit of this package counted 173 `throw new …Error(` sites, of which 15
 * attach `{ cause }` — and all 15 are in `store/`, `registry/` or `scripts/`.
 * The `http/`, `orchestrator/`, `providers/` and `reports/` layers attached it
 * at zero sites. Meanwhile seven private copies of
 * `error instanceof Error ? error.message : String(error)` sit at the layer
 * boundaries, each reducing an error to one line.
 *
 * Individually those are fine — a one-line message is exactly right for an HTTP
 * body, a CLI line, or `run.error`. Together they meant that by the time a
 * failure reached anywhere durable, the stack was gone, and so was whatever the
 * original error had been wrapped around.
 *
 * ## Why the one-liners are NOT changed
 *
 * The obvious move is to make `describe` return the whole chain and be done.
 * That is wrong in the direction that matters: those strings are user-facing.
 * `run.error` is rendered in the UI, HTTP bodies are read by clients, and a CLI
 * line ending in three nested `Caused by:` clauses is worse than one that names
 * the problem. The message is a summary and should stay one.
 *
 * So the split is by DESTINATION rather than by call site: the summary keeps
 * going where a person reads one line, and this module produces the long form
 * for the places built to hold it — `runs/diagnostics.jsonl`'s `detail` field,
 * which is untruncated to 8,000 characters precisely so it can carry a stack.
 *
 * ## Sanitising made this load-bearing
 *
 * Several routes deliberately tell the client LESS than they know, because the
 * underlying message carries an absolute filesystem path. Those routes throw a
 * sanitised `HttpError` with the real error as its `cause`. Recording only
 * `error.stack` would then drop the cause entirely — a stack does not include a
 * cause's message — so sanitising would move the information out of the response
 * body and then lose it. That is how a codebase learns not to sanitise. This
 * function is the other half of that trade.
 */

/** How far down a cause chain to walk. */
const MAX_CAUSE_DEPTH = 4;

/**
 * The stack, plus every `cause` beneath it, as one block of text.
 *
 * `undefined` for a non-`Error`, because there is no stack and no chain to
 * record — the caller's own one-line summary already carries everything such a
 * value has.
 *
 * Depth-limited rather than exhaustive. A cause chain is user-supplied structure
 * by the time it reaches here: an adapter can hand back a cycle (`a.cause = b`,
 * `b.cause = a`), or a hundred links from a retry loop that wrapped its own
 * error each time. This runs on a failure path, often inside a request, and a
 * walk that can be made unbounded by remote input is not something to put there.
 * Four links is deeper than any chain this codebase builds and shallow enough to
 * be free.
 */
export function errorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;

  const parts: string[] = [stackOf(error)];

  let cause: unknown = causeOf(error);
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined; depth += 1) {
    parts.push(
      cause instanceof Error ? `Caused by: ${stackOf(cause)}` : `Caused by: ${String(cause)}`,
    );
    cause = cause instanceof Error ? causeOf(cause) : undefined;
  }

  return parts.join('\n');
}

/**
 * `error.stack`, falling back to `name: message`.
 *
 * The fallback is not paranoia: `stack` is optional in the spec, and an error
 * that crossed a process boundary — which is how most of this system's failures
 * arrive, from a provider CLI — can easily be a plain object rehydrated from
 * JSON with no stack at all.
 */
function stackOf(error: Error): string {
  return error.stack ?? `${error.name}: ${error.message}`;
}

/** `cause` is typed `unknown` and absent on older shapes; read it without an `any`. */
function causeOf(error: Error): unknown {
  return (error as { cause?: unknown }).cause;
}
