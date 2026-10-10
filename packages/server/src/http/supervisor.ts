import {
  EVENT_BUFFER_LIMIT,
  LOG_BUFFER_LIMIT,
  RunStateSchema,
  isRunTerminal,
  type AgentEvent,
  type CreateRunRequest,
  type LoggedAgentEvent,
  type RunState,
  type RunSummary as WireRunSummary,
  type ServerMessage,
  type ClarificationDecision,
  type TeamOperation,
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import type { DispatchOptions } from '../orchestrator/dispatcher.js';
import { resolveModelPolicy } from '../providers/modelPolicy.js';
import { executeRun, type ExecuteRunDeps } from '../orchestrator/runner.js';
import { makeProvider as defaultMakeProvider, type MakeProviderOptions } from '../providers/factory.js';
import type { AgentProvider } from '../providers/types.js';
import { ProviderUnavailableError } from '../providers/types.js';
import type { RunStore } from '../store/types.js';

/**
 * The live-run registry behind the HTTP layer (PLAN.md Phase 3, NFR-2, NFR-3).
 *
 * Everything here exists because a browser is not a CLI. `npm run run` can hold
 * one promise and print to stdout; a web client starts a run in one request,
 * disappears for thirty seconds, and comes back expecting to find both the run
 * and everything it missed. So this class owns three things the orchestrator
 * deliberately does not:
 *
 * - **Detachment.** `startRun` returns as soon as the run has an id, leaving
 *   `executeRun` running in the background. `POST /api/runs` blocking until a
 *   ten-minute run finished would be a broken API, not a slow one.
 * - **Replay buffers.** Events and log lines are kept per run so a reconnecting
 *   socket gets history before live traffic (NFR-2). They are bounded, because
 *   a chatty run would otherwise grow in memory without limit; the full record
 *   is always on disk in `logs/<assignmentId>.jsonl`.
 * - **Cancellation.** One `AbortController` per run, which is the only handle
 *   `POST /api/runs/:id/cancel` has (FR-M9).
 *
 * A run failing must never take the process down. `executeRun` already converts
 * pipeline failures into a `failed` run, but the background task is unawaited by
 * anyone, so an unexpected throw would surface as an unhandled rejection and
 * kill Node. Every background path here ends in a `catch`.
 */

/** Messages a per-run subscriber receives. */
export type RunListener = (message: ServerMessage) => void;

/** Called when the run list may have changed: a run started, or finished. */
export type RunListListener = () => void;

/** Undo handle returned by every subscription method. */
export type Unsubscribe = () => void;

export type SupervisorWarning = (message: string, cause?: unknown) => void;

/**
 * The default concurrency cap (AO-6) — how many runs this process will
 * execute at once before `startRun` refuses a new one.
 *
 * There was no cap at all before this: `POST /api/runs` handed back a `runId`
 * and started `executeRun` in the background unconditionally, for every
 * request that passed the trust-boundary checks in `server.ts`. On a server
 * with no user boundary (see `authToken.ts` for the finding this and the
 * token both close), that is an unbounded-cost primitive — each run spawns
 * real provider child processes, several per phase, and `--max-budget-usd`
 * caps what ONE of them can spend, never how many can be in flight paying
 * that cap simultaneously. A modest default here is chosen over an unlimited
 * one for the same reason `--max-budget-usd` exists at all: the safe default
 * is the one that fails a request loudly rather than the one that lets a
 * runaway loop (a bug, a misbehaving script, a second local account doing
 * exactly what AO-6 describes) keep spawning processes until something else
 * gives out. Four is not a load-tested ceiling, just a number comfortably
 * above "one interactive user running a couple of things at once" and well
 * below "this machine's fans spin up" — `serve.ts --max-concurrent-runs`
 * overrides it for anyone who has measured their own machine and wants a
 * different number.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/**
 * Thrown by `startRun` when accepting a new run would exceed
 * `maxConcurrentRuns` (AO-6). `server.ts`'s `statusFor` maps this to 429 —
 * see its own comment for why 429 and not 503 or 403.
 */
export class RunConcurrencyLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(
      `refusing to start a new run: ${limit} run(s) are already executing, which is this server's configured limit`,
    );
    Object.setPrototypeOf(this, RunConcurrencyLimitError.prototype);
    this.name = 'RunConcurrencyLimitError';
    this.limit = limit;
  }
}

/**
 * How many finished runs keep their in-memory buffers.
 *
 * Zero would be simpler, but it loses the one case reattach exists for: a run
 * that ends in the half-second between a page unload and the new socket's
 * `subscribe`. The reconnecting client would then get an empty event history
 * for a run it was watching a moment ago. A handful of entries covers that
 * window; older runs fall back to `store.loadRun`, which is exactly the
 * finished-run path anyway.
 */
export const RETAINED_FINISHED_RUNS = 8;

/** What a subscribing client is sent before any live message (NFR-2). */
export interface RunSnapshot {
  run: RunState;
  events: LoggedAgentEvent[];
  /** Whether more events are still coming, i.e. the run is executing here. */
  live: boolean;
  /** True when the buffer no longer holds the whole history. */
  truncated: boolean;
  /** Buffered orchestrator log lines, replayed after the snapshot. */
  logs: BufferedLogLine[];
}

export interface BufferedLogLine {
  line: string;
  ts: number;
}

export interface SupervisorDeps {
  registry: Registry;
  /**
   * FR-R5: read the CURRENT catalog when starting a run, instead of the one
   * captured when this supervisor was constructed.
   *
   * Resolved per `startRun`, not once here, which is the whole point: a run
   * started after an agent file was edited must see the edit. A run already in
   * flight keeps the registry it began with, deliberately — swapping the catalog
   * under a running dispatch would mean an assignment's agent could change
   * definition between its brief and its report.
   */
  getRegistry?: () => Registry;
  store: RunStore;
  /**
   * Injected so tests can drive a run without the real scripted plan, and so
   * Phase 7's provider-per-run selection has an obvious seam.
   *
   * `options` reuses {@link MakeProviderOptions} rather than a shape invented
   * here, so `startRun` and `scripts/run.ts` build the same kind of object for
   * the same factory function. It is the fourth parameter, not folded into
   * `id`/`task`/`knownAgentNames`, so the many existing test doubles that only
   * care about those three keep compiling unchanged (JS silently drops extra
   * call arguments a function does not declare).
   */
  makeProvider?: (
    id: string,
    task: string,
    knownAgentNames: ReadonlySet<string>,
    options?: MakeProviderOptions,
  ) => AgentProvider;
  /** Used when a request omits `provider`. */
  defaultProviderId?: string;
  /**
   * The concurrency cap (AO-6). Defaults to {@link DEFAULT_MAX_CONCURRENT_RUNS}.
   * A run parked at `awaiting_approval` still counts against this — it is
   * still `live` from the supervisor's point of view (see the doc comment on
   * `shutdown` for the same point made about cancellation), and it already
   * spent one planning call's worth of provider cost to get there.
   */
  maxConcurrentRuns?: number;
  /**
   * Artificial per-event latency for the scripted provider (see
   * `MakeProviderOptions.stepDelayMs`). Set from `serve.ts --step-delay` so the
   * live UI and reattach behaviour can be exercised by hand.
   */
  stepDelayMs?: number;

  /**
   * Override for the `designing` step (Phase 5). Defaults to the real one.
   *
   * Present so tests can drive a supervisor without launching a browser per
   * run; see `ExecuteRunDeps.produceDeliverable` for the reasoning.
   */
  produceDeliverable?: ExecuteRunDeps['produceDeliverable'];
  /**
   * Cross-run diagnostics (`diagnostics/log.ts`). Optional: a supervisor without
   * one logs nothing, which is what keeps every existing test construction site
   * unchanged.
   */
  diagnostics?: ExecuteRunDeps['diagnostics'];
  /** Applied to every run; a request's own values win where it sets them. */
  dispatchDefaults?: Partial<DispatchOptions>;
  /** Where background failures go. Defaults to stderr. */
  onWarning?: SupervisorWarning;
  now?: () => number;
}

/**
 * A bounded FIFO that remembers whether it ever dropped anything.
 *
 * The dropped flag is the whole point: a client shown 2,000 events with no
 * indication that 3,000 preceded them would reasonably conclude the run started
 * where the buffer does. `snapshot.truncated` exists so it can say otherwise.
 */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private dropped = false;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`ring buffer limit must be positive, got ${limit}`);
  }

  push(item: T): void {
    this.items.push(item);
    // `shift` is O(n), but n is bounded by a few thousand and this runs once per
    // event — measurably cheaper than the bookkeeping a circular buffer needs.
    while (this.items.length > this.limit) {
      this.items.shift();
      this.dropped = true;
    }
  }

  /** True once the oldest entries have been discarded. */
  get truncated(): boolean {
    return this.dropped;
  }

  get size(): number {
    return this.items.length;
  }

  /** A copy, so a caller holding the result cannot see later pushes. */
  toArray(): T[] {
    return [...this.items];
  }
}

/** Everything the supervisor keeps about one run it started. */
interface RunEntry {
  runId: string;
  controller: AbortController;
  /** The latest persisted state. Authoritative while `live` is true. */
  state: RunState;
  events: RingBuffer<LoggedAgentEvent>;
  logs: RingBuffer<BufferedLogLine>;
  live: boolean;
}

/**
 * The shape of `ExecuteRunDeps.awaitTeamApproval` (FR-M11), spelled out here
 * rather than imported from `runner.ts`.
 *
 * This is deliberate, not an oversight: the field is being added to
 * `runner.ts` by a separate change landing in parallel with this one, and the
 * contract for it — this exact signature — was fixed before either side
 * started, precisely so the two do not have to be sequenced. Declaring the
 * type locally means this file compiles against the agreed shape regardless
 * of which change lands first; spreading a value of this type into the object
 * literal passed to `executeRun` (`startRun` below) is what actually lets it
 * through even before `ExecuteRunDeps` declares the property, because
 * TypeScript's excess-property check does not run on properties contributed
 * by `...spread` the way it does on properties written directly into a
 * literal. Once `runner.ts` adds the field with this same signature, nothing
 * here needs to change.
 */
type AwaitTeamApproval = (context: {
  run: RunState;
  signal: AbortSignal;
}) => Promise<readonly TeamOperation[]>;

/**
 * The FR-M12 equivalent, *derived* from `ExecuteRunDeps` rather than re-declared.
 *
 * The re-declaration above was right for its moment — the two halves were landing
 * in parallel and neither could import the other's not-yet-existing field. That
 * reason does not apply here: `runner.ts` already declares `awaitClarification`,
 * so deriving it means the two can never drift, which is the failure the comment
 * above is guarding against by hand.
 */
type AwaitClarification = NonNullable<ExecuteRunDeps['awaitClarification']>;

/**
 * One run parked at `awaiting_approval`, waiting on a verdict this process
 * has not received yet.
 *
 * `resolve` is the only member because it already closes over its matching
 * `reject` (see {@link RunSupervisor.awaitTeamApproval}) — the HTTP route
 * only ever has an approval to deliver, never a reason to fail one, so a
 * second function here would have no caller. It reports whether it actually
 * settled anything, which is what lets `submitTeamDecision` and the route
 * built on it tell "resolved" apart from "there was nothing left to resolve".
 */
interface PendingTeamApproval {
  resolve: (operations: readonly TeamOperation[]) => boolean;
}

/**
 * The FR-M12 twin of {@link PendingTeamApproval}. Separate map, separate entry
 * type, same exactly-once `resolve` discipline — a run may legitimately park
 * twice (clarify, then team review), and one map keyed by run id could not hold
 * both without the second park overwriting the first's cleanup.
 */
interface PendingClarification {
  resolve: (decision: ClarificationDecision) => boolean;
}

export class RunSupervisor {
  // `stepDelayMs` is excluded because it is consumed at construction — folded
  // into the default `makeProvider` closure — and never read again.
  private readonly deps: Required<
    Omit<
      SupervisorDeps,
      'dispatchDefaults' | 'stepDelayMs' | 'produceDeliverable' | 'diagnostics' | 'getRegistry'
    >
  > &
    Pick<SupervisorDeps, 'dispatchDefaults' | 'produceDeliverable' | 'diagnostics' | 'getRegistry'>;

  /**
   * FR-R5. See {@link SupervisorDeps.getRegistry}: absent means "the value",
   * which is the behaviour every caller had before hot-reload existed.
   */
  private currentRegistry(): Registry {
    return this.deps.getRegistry?.() ?? this.deps.registry;
  }

  /**
   * Insertion-ordered, which is what makes {@link RETAINED_FINISHED_RUNS}
   * eviction a matter of walking the map front to back.
   */
  private readonly entries = new Map<string, RunEntry>();

  private readonly subscribers = new Map<string, Set<RunListener>>();
  private readonly runListListeners = new Set<RunListListener>();

  /**
   * Background `executeRun` tasks that have not settled.
   *
   * Held on the supervisor rather than on each {@link RunEntry} because the
   * entry does not exist until `store.createRun` resolves, which is *after* the
   * task has already started — so there is no moment at which the entry could
   * be constructed holding its own promise.
   */
  private readonly inFlight = new Set<Promise<void>>();

  /**
   * Runs currently parked at `awaiting_approval` (FR-M11), keyed by run id.
   *
   * A run only ever appears here between the moment `executeRun` calls the
   * `awaitTeamApproval` closure built in `startRun` and the moment that
   * promise settles — approved via `submitTeamDecision`, or torn down by an
   * abort (see {@link awaitTeamApproval}). Entries are removed on every one of
   * those exits, never left for a later run to inherit: this map is keyed by
   * run id exactly like `entries` is, and a stale entry here would let a
   * decision meant for a finished run resolve a promise a brand-new run
   * reusing that id is waiting on.
   */
  private readonly pendingTeamApprovals = new Map<string, PendingTeamApproval>();

  /** FR-M12. See {@link pendingTeamApprovals}; identical lifecycle. */
  private readonly pendingClarifications = new Map<string, PendingClarification>();

  private readonly knownAgentNames: ReadonlySet<string>;

  /**
   * DEFECT FIXED: this built `this.deps` as an enumerated object literal, and
   * the enumeration was three keys short. `getRegistry`, `produceDeliverable`
   * and `diagnostics` were declared on {@link SupervisorDeps}, documented,
   * passed by `serve.ts`, read later in this file — and dropped here, so every
   * read of them saw `undefined` for the life of the process.
   *
   * Nothing caught it, and nothing could have. All three are OPTIONAL, so
   * omitting them from the literal is a legal value for the declared type;
   * `Pick<SupervisorDeps, ...>` in the field type above says "these may be
   * absent", which is exactly what silently-dropping them produces. Each read
   * site is defensively written for the absent case (`?.`, `?? this.deps.registry`,
   * a `=== undefined` guard), so the failure was three features quietly doing
   * nothing rather than anything throwing. What it cost:
   *
   * - `diagnostics` — `runs/diagnostics.jsonl` got NOTHING from any run started
   *   through `POST /api/runs`, which is every run the web UI starts. A live
   *   run's three `tool-denied` warnings were in each assignment's own event log
   *   and absent from the cross-run log, which is the one place built to answer
   *   "what keeps being refused?". The CLI path (`scripts/run.ts`) reaches
   *   `executeRun` directly, never through here, so the log looked healthy in
   *   exactly the runs an author does by hand.
   * - `getRegistry` — FR-R5 hot reload was inert for runs. `buildServer` got its
   *   own copy and kept serving a fresh catalog over `/api/agents`, so the UI
   *   listed an edited agent while a run dispatched against the startup
   *   snapshot: the two halves of the same process disagreeing, with the visible
   *   half being the one that was right.
   * - `produceDeliverable` — no production impact (`runner.ts` falls back to the
   *   real implementation and `serve.ts` never passes an override), but every
   *   supervisor test that injected `stubDeliverable()` was silently running the
   *   real renderer instead of its stub.
   *
   * This is the SECOND time this exact shape has bitten this file: `withCreateRunHook`
   * was an enumerated literal that dropped `assignmentWorkspaceDir`, which left
   * AO-8's per-assignment workspace isolation absent on the server path through
   * eight audits. That one was fixed with a `Proxy`; the same class of bug was
   * sitting one layer up, in the constructor, and the fix did not generalise
   * because nobody looked for a second instance.
   *
   * So the fix here is structural rather than "add the three missing lines":
   * spread `deps` FIRST and override only what needs a default. A key added to
   * `SupervisorDeps` tomorrow arrives without anyone remembering to copy it,
   * which is the only version of this that stops recurring. `stepDelayMs` is
   * destructured out rather than spread, because it genuinely is consumed here
   * (folded into the `makeProvider` closure below) and the field type above
   * documents its absence.
   */
  constructor(deps: SupervisorDeps) {
    const { stepDelayMs: _stepDelayMs, ...forwarded } = deps;
    this.deps = {
      ...forwarded,
      registry: deps.registry,
      store: deps.store,
      makeProvider:
        deps.makeProvider ??
        // `options` here is the per-*run* piece (currently just `maxCostUsd`,
        // built by `startRun` from the request); `stepDelayMs` is the per-
        // *server* piece from `deps`. Both land in one `MakeProviderOptions`
        // object rather than `startRun` having to know about `stepDelayMs` or
        // this closure having to know about `maxCostUsd`.
        ((id, task, known, options) =>
          defaultMakeProvider(id, task, known, {
            ...(deps.stepDelayMs === undefined ? {} : { stepDelayMs: deps.stepDelayMs }),
            ...options,
          })),
      defaultProviderId: deps.defaultProviderId ?? 'scripted',
      onWarning: deps.onWarning ?? ((message, cause) => console.warn(`[supervisor] ${message}`, cause ?? '')),
      now: deps.now ?? Date.now,
      maxConcurrentRuns: deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
      // `dispatchDefaults` was the one optional key the old literal DID copy,
      // and it is deliberately not re-listed here: the spread above carries it,
      // and leaving a hand-written line for one of four optionals is how the
      // other three came to look like they had been considered.
    };
    this.knownAgentNames = new Set(deps.registry.agents.map((agent) => agent.name));
  }

  /**
   * NFR-2, the server-restart half: find runs a *previous* process in this
   * server left non-terminal and close them out.
   *
   * DEFECT FIXED: nothing ever called `store.listRuns()` on startup. A
   * `run.json` written with `status: 'running'` (an assignment stuck at
   * `working`, exactly the shape a crash leaves) was, on disk, indistinguishable
   * from a run this fresh process is genuinely executing — `liveRunIds()` never
   * lists it (nothing here ever called `startRun` for it), so `cancelRun`
   * returns `false` and the HTTP route answers 409 "not executing in this
   * server process" forever. NFR-2 promises "a browser refresh **or server
   * restart** reattaches to a live run rather than losing it"; only the refresh
   * half was true.
   *
   * READING IMPLEMENTED — the honest minimum: mark every non-terminal run
   * `failed` with a reason that says the process restarted, so it stops lying
   * about its own status. A run's `status` field is now a threeway of "genuinely
   * executing here", "finished", or "known to have died with the process" —
   * never again "who knows".
   *
   * READING NOT IMPLEMENTED — resuming dispatch: replaying a plan from
   * `run.json` and re-entering `dispatchRun` at the assignment a crash
   * interrupted. That needs more than this store persists: which tool calls (if
   * any) were mid-flight inside that assignment's provider call, whether a
   * partial response was ever durably committed anywhere the provider itself
   * would recognise on a fresh call, and a provider adapter able to resume a
   * conversation rather than only start one (`AgentProvider.run` takes a task
   * string, no conversation id). A half-finished assignment cannot simply be
   * re-awaited; building real resumption is a provider-and-store feature, not a
   * few lines in the supervisor, so it is out of scope here and the gap is
   * recorded rather than quietly narrowed.
   *
   * MUST be awaited before the HTTP server starts accepting connections (see
   * `serve.ts`'s `main()`) — calling this after `listen()` would race a
   * client's own `POST /api/runs`: `store.listRuns()` could observe a
   * brand-new, genuinely-live run created in that gap and misfile it as
   * crashed, since at construction time `this.entries` (this process's record
   * of what it is actually executing) is always empty.
   *
   * @returns the ids reconciled, for the startup log line.
   */
  async reconcileCrashedRuns(): Promise<string[]> {
    const summaries = await this.deps.store.listRuns();
    const reconciled: string[] = [];

    for (const summary of summaries) {
      if (isRunTerminal(summary.status)) continue;
      if (this.entries.has(summary.id)) continue; // defensive; see the doc comment

      try {
        // Re-load rather than trusting the summary: `listRuns` reads whatever
        // fields it keeps for the history browser, and re-fetching the full
        // `RunState` means `saveRun` below round-trips through the same schema
        // validation every other write does, instead of hand-building a patch.
        const run = await this.deps.store.loadRun(summary.id);
        if (isRunTerminal(run.status)) continue; // settled between the two reads

        // Someone else is still working on it. See `RunState.ownerPid`: this
        // sweep assumed it was the only process on the machine, and a second
        // server started by an agent testing the app killed four live
        // assignments in a CLI run that was executing perfectly well.
        if (isOwnedByLiveProcess(run.ownerPid)) continue;

        run.status = 'failed';
        run.error =
          'the server process restarted while this run was in progress; it cannot be resumed and was marked failed';
        run.updatedAt = this.deps.now();
        await this.deps.store.saveRun(run);
        reconciled.push(run.id);
      } catch (error) {
        // One unreconcilable run (corrupt `run.json`, a store that cannot
        // write) must not stop every other crashed run from being closed out,
        // and must not stop the server from starting at all.
        this.deps.onWarning(`could not reconcile run ${summary.id} left over from a previous process`, error);
      }
    }

    return reconciled;
  }

  /**
   * Build the `awaitClarification` closure `executeRun` calls when `clarify`
   * asked for a question round and the Manager actually asked something
   * (FR-M12).
   *
   * Structurally identical to {@link awaitTeamApproval} below, including the
   * `settled` flag that makes "an answer arrived" and "the signal fired"
   * mutually exclusive, and the abort listener without which a cancel while
   * parked here would leak both the map entry and the `RunEntry` that keeps the
   * run marked live. `awaiting_clarification -> cancelled` is legal because
   * `canTransitionRun` special-cases `cancelled` from any non-terminal status.
   */
  private awaitClarification(run: RunState, signal: AbortSignal): Promise<ClarificationDecision> {
    return new Promise<ClarificationDecision>((resolvePromise, rejectPromise) => {
      let settled = false;

      const cleanup = (): void => {
        this.pendingClarifications.delete(run.id);
        signal.removeEventListener('abort', onAbort);
      };

      const resolve = (decision: ClarificationDecision): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        resolvePromise(decision);
        return true;
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error(`run "${run.id}" was cancelled while awaiting clarification`));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort);
      this.pendingClarifications.set(run.id, { resolve });
    });
  }

  /**
   * Settle a parked clarification round with the user's answers (FR-M12).
   *
   * @returns false when there was nothing to settle — unknown run, a run that
   * never asked to pause, one already past the round, or an answer that lost a
   * race with a cancel or an earlier answer. The route turns that into a 404 or
   * 409; this method knows only whether it had something to resolve.
   */
  submitClarification(runId: string, decision: ClarificationDecision): boolean {
    const pending = this.pendingClarifications.get(runId);
    if (pending === undefined) return false;
    return pending.resolve(decision);
  }

  /**
   * Build the `awaitTeamApproval` closure `executeRun` calls once a run's plan
   * exists and `reviewTeam` asked for a pause (FR-M11).
   *
   * The promise it returns is parked in `pendingTeamApprovals` and settled
   * from exactly two places:
   *
   * - **`submitTeamDecision`**, when the user posts a verdict. This is the
   *   only path that resolves rather than rejects, and it is the only path
   *   `executeRun` is meant to see as "approved" — the operations array it
   *   returns (possibly empty) is what the runner applies to the plan before
   *   moving on to `dispatching`.
   * - **The abort listener below**, when a cancel (or `shutdown`, which is
   *   just cancelling everything) lands while the run is parked here. There is
   *   nothing else in flight to interrupt at this point — no assignment
   *   running, no provider call to abort — so without this listener the
   *   controller firing would do nothing observable: `submitTeamDecision`
   *   would still be sitting there later for a run whose page the user has
   *   already closed, and the background task in `startRun` would never reach
   *   its `finally` block, leaking both the `RunEntry` (kept alive forever as
   *   "live") and this map entry. Rejecting lets the rejection propagate out
   *   of `executeRun`'s `await deps.awaitTeamApproval(...)`, into the same
   *   catch block every other cancellation-mid-flight already goes through,
   *   which reads `signal.aborted` and calls `setStatus('cancelled')` —
   *   `awaiting_approval -> cancelled` is legal because `canTransitionRun`
   *   special-cases `cancelled` as reachable from any non-terminal status.
   *
   * Exactly-once is `PendingTeamApproval.resolve`'s job, not this method's:
   * both exits above go through it, and it is built with a `settled` flag so
   * whichever of "a decision arrived" or "the signal fired" happens first is
   * the only one that can settle the promise or run the cleanup (removing the
   * map entry and detaching the listener). Without that guard, a decision and
   * a cancel racing in the same tick could call `resolve` after `reject` (or
   * vice versa) — a no-op on an already-settled native promise, but the
   * cleanup itself is not naturally idempotent, and running it twice is
   * exactly the kind of bug that only shows up under real concurrency.
   */
  private awaitTeamApproval(run: RunState, signal: AbortSignal): Promise<readonly TeamOperation[]> {
    return new Promise<readonly TeamOperation[]>((resolvePromise, rejectPromise) => {
      let settled = false;

      const cleanup = (): void => {
        this.pendingTeamApprovals.delete(run.id);
        signal.removeEventListener('abort', onAbort);
      };

      const resolve = (operations: readonly TeamOperation[]): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        resolvePromise(operations);
        return true;
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error(`run "${run.id}" was cancelled while awaiting team approval`));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort);
      this.pendingTeamApprovals.set(run.id, { resolve });
    });
  }

  /**
   * The user's verdict on a parked run's proposed team (FR-M11): releases
   * whatever is waiting in `pendingTeamApprovals` for `runId`, handing
   * `operations` back to `executeRun` as the array to apply before dispatch.
   * An empty array is a legitimate decision — "the Manager's team is right,
   * go" — not the absence of one; `CreateRunRequestSchema`'s doc comment on
   * `TeamDecisionSchema` makes the same point about the wire shape this
   * mirrors.
   *
   * @returns false when there is nothing to resolve: an unknown run, a run
   * that never asked to pause, one already dispatching, or a decision that
   * lost a race with a cancel or a previous decision for the same run. The
   * HTTP route (`POST /api/runs/:id/team`) turns that into a 404 or 409
   * depending on which of those it actually was — this method does not have
   * enough information to tell them apart on its own, only whether it had
   * something to settle.
   */
  submitTeamDecision(runId: string, operations: readonly TeamOperation[]): boolean {
    const pending = this.pendingTeamApprovals.get(runId);
    if (pending === undefined) return false;
    return pending.resolve(operations);
  }

  /**
   * Start a run and return its id as soon as one exists.
   *
   * The provider is built and preflighted *before* returning, so an unusable
   * provider is a failed `POST /api/runs` rather than a run that appears in the
   * list and dies a second later. Everything after that is background work.
   *
   * The concurrency cap (AO-6) is checked first, before any of that —
   * cheaper than a wasted provider preflight, and it means a caller hammering
   * this past the limit costs this process nothing beyond a `liveRunIds().length`
   * read. `liveRunIds()` is the same count `GET /api/health` and the run list
   * already expose, so this is not a second notion of "how many are running";
   * a run parked at `awaiting_approval` still holds its slot, for the reason
   * given on `SupervisorDeps.maxConcurrentRuns`.
   */
  async startRun(request: CreateRunRequest): Promise<string> {
    if (this.liveRunIds().length >= this.deps.maxConcurrentRuns) {
      throw new RunConcurrencyLimitError(this.deps.maxConcurrentRuns);
    }

    const providerId = request.provider ?? this.deps.defaultProviderId;
    // DEFECT FIXED (FR-M8): this call used to pass no options at all, so
    // `request.maxCostUsd` — validated by `CreateRunRequestSchema`, shown in
    // the settings panel — never reached `makeProvider`, and from there never
    // reached the Claude Code adapter's `--max-budget-usd`. `timeoutMs` and
    // `tokenBudget` already had a working path into `DispatchOptions` via
    // `dispatchOptionsFor` below; this is the same treatment for the one
    // field that was missing it.
    const providerOptions: MakeProviderOptions = {
      ...(request.maxCostUsd === undefined ? {} : { maxCostUsd: request.maxCostUsd }),
    };
    const provider = this.deps.makeProvider(providerId, request.task, this.knownAgentNames, providerOptions);

    const availability = await provider.isAvailable();
    if (!availability.ok) {
      throw new ProviderUnavailableError(provider.id, availability.reason ?? 'unknown reason');
    }

    const controller = new AbortController();
    let entry: RunEntry | undefined;

    // `executeRun` allocates the run id itself, inside `store.createRun`. That
    // is the earliest moment an id exists, so the store is wrapped to hand it
    // back rather than waiting for the first state change — which for a slow
    // planning call could be many seconds later, all of it spent blocking the
    // HTTP response.
    let announceRunId: (runId: string) => void = () => undefined;
    let announceFailure: (error: unknown) => void = () => undefined;
    const runIdReady = new Promise<string>((resolve, reject) => {
      announceRunId = resolve;
      announceFailure = reject;
    });

    const store = withCreateRunHook(this.deps.store, (run) => {
      entry = {
        runId: run.id,
        controller,
        state: cloneRun(run),
        events: new RingBuffer<LoggedAgentEvent>(EVENT_BUFFER_LIMIT),
        logs: new RingBuffer<BufferedLogLine>(LOG_BUFFER_LIMIT),
        live: true,
      };
      this.entries.set(run.id, entry);
      this.notifyRunListChanged();
      announceRunId(run.id);
    });

    const task = (async (): Promise<void> => {
      try {
        const result = await executeRun({
          registry: this.currentRegistry(),
          provider,
          store,
          task: request.task,
          // Passed through unvalidated, deliberately, and NOT stat-checked here.
          // The CLI checks its `--subject` before spending a planning turn
          // because it can: it runs on the machine the operator typed the path
          // on. A server accepting this over HTTP is a different situation — the
          // request may come from a browser on another machine in principle, and
          // a `statSync` on a request path is a filesystem probe an unauthenticated
          // caller could use to test for the existence of arbitrary paths. It is
          // a string that reaches the prompt; an agent that cannot read it says so
          // in its report, which is the failure mode this whole field replaces.
          ...(request.subjectPath === undefined ? {} : { subjectPath: request.subjectPath }),
          signal: controller.signal,
          onEvent: (event: AgentEvent) => {
            if (entry === undefined) return;
            const logged: LoggedAgentEvent = { ts: this.deps.now(), event };
            entry.events.push(logged);
            this.emit(entry.runId, { t: 'event', runId: entry.runId, event: logged });
          },
          onStateChange: (run: RunState) => {
            if (entry === undefined) return;
            // Cloned because `executeRun` mutates one `RunState` object in place
            // for the whole run. Without this, every buffered and already-sent
            // reference would silently become the *final* state.
            entry.state = cloneRun(run);
            this.emit(entry.runId, { t: 'state', run: entry.state });
          },
          logger: (line: string) => {
            if (entry === undefined) return;
            const ts = this.deps.now();
            entry.logs.push({ line, ts });
            this.emit(entry.runId, { t: 'log', runId: entry.runId, line, ts });
          },
          dispatch: dispatchOptionsFor(request, this.deps.dispatchDefaults),
          // Resolved once per run from this process's environment. Not a request
          // field, deliberately: the floor exists so a deployment can rely on it,
          // and a client that could name its own would be able to opt back into
          // the tier the policy exists to exclude.
          modelPolicy: resolveModelPolicy(),
          ...(this.deps.diagnostics === undefined
            ? {}
            : { diagnostics: this.deps.diagnostics }),
          ...(this.deps.produceDeliverable === undefined
            ? {}
            : { produceDeliverable: this.deps.produceDeliverable }),
          // FR-M11: only present when the request opted in. `executeRun` (once
          // `runner.ts` carries the matching half of this contract) reads the
          // key's mere presence to decide whether to pause at all — an absent
          // `awaitTeamApproval` is what keeps a plain `POST /api/runs` going
          // straight from `planning` to `dispatching` exactly as before, which
          // is the whole reason `reviewTeam` is opt-in rather than a new
          // mandatory step. `run` here is `entry.state`'s live object at the
          // moment planning finished, not a snapshot — the same object
          // `onStateChange` above clones from on every later transition, so
          // its `.plan` field is already the proposed plan a client asking for
          // this run's current state would see.
          ...(request.reviewTeam
            ? {
                awaitTeamApproval: ((context) =>
                  this.awaitTeamApproval(context.run, context.signal)) satisfies AwaitTeamApproval,
              }
            : {}),
          // FR-M12, on the identical presence-means-opt-in contract. Independent
          // of `reviewTeam` above: a request may ask for both, and then the run
          // parks twice, in the order a user would expect — clarify the task,
          // then review the team that produced.
          ...(request.clarify
            ? {
                awaitClarification: ((context) =>
                  this.awaitClarification(
                    context.run,
                    context.signal,
                  )) satisfies AwaitClarification,
              }
            : {}),
        });

        if (entry !== undefined) {
          entry.state = cloneRun(result.run);
          this.emit(entry.runId, { t: 'state', run: entry.state });
        }
      } catch (error) {
        // `executeRun` turns pipeline failures into a `failed` run, so getting
        // here means something outside the pipeline broke — a store that cannot
        // write, say. It is reported and swallowed: this promise is only ever
        // awaited by `shutdown`, and an unhandled rejection would end the
        // process, taking every other run with it.
        this.deps.onWarning(`run ${entry?.runId ?? '(unstarted)'} failed outside the pipeline`, error);
        if (entry === undefined) announceFailure(error);
      } finally {
        if (entry !== undefined) {
          entry.live = false;
          this.evictFinishedRuns();
        }
        this.notifyRunListChanged();
      }
    })();

    // Two handlers rather than `.finally`, whose returned promise would itself
    // reject if the task ever did — an unhandled rejection nobody is watching.
    this.inFlight.add(task);
    const forget = (): void => {
      this.inFlight.delete(task);
    };
    void task.then(forget, forget);

    return runIdReady;
  }

  /**
   * Abort a run in flight (FR-M9).
   *
   * @returns false when the run is unknown here or has already finished, which
   * the HTTP layer turns into a 404/409 rather than pretending it worked.
   */
  cancelRun(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined || !entry.live) return false;
    entry.controller.abort();
    return true;
  }

  /** Runs executing in this process right now. */
  liveRunIds(): string[] {
    return [...this.entries.values()].filter((entry) => entry.live).map((entry) => entry.runId);
  }

  isLive(runId: string): boolean {
    return this.entries.get(runId)?.live === true;
  }

  /**
   * Latest state for a run, in-memory when we have it and from disk otherwise.
   *
   * Throws when the run is unknown to both — the store's own error, which names
   * the path it could not read.
   */
  async getRunState(runId: string): Promise<RunState> {
    const entry = this.entries.get(runId);
    if (entry !== undefined) return entry.state;
    return this.deps.store.loadRun(runId);
  }

  /**
   * The reattach payload (NFR-2).
   *
   * For a run this process is executing, the buffers are read synchronously —
   * there is no `await` before them — so no event can slip in between building
   * the snapshot and the caller subscribing to live traffic.
   */
  async snapshot(runId: string): Promise<RunSnapshot> {
    const entry = this.entries.get(runId);
    if (entry !== undefined) {
      return {
        run: entry.state,
        events: entry.events.toArray(),
        live: entry.live,
        truncated: entry.events.truncated,
        logs: entry.logs.toArray(),
      };
    }

    const run = await this.deps.store.loadRun(runId);
    return {
      run,
      events: [],
      live: false,
      // A run that got as far as having assignments certainly produced events,
      // and none of them are in this payload — the history on disk is not read
      // back here. Claiming `truncated: false` would tell the client it has the
      // whole story when it has none of it.
      truncated: run.assignments.length > 0,
      logs: [],
    };
  }

  /** The run list, with the `live` flag the wire contract asks for. */
  async listRuns(): Promise<WireRunSummary[]> {
    const stored = await this.deps.store.listRuns();
    return stored.map((summary) => ({
      id: summary.id,
      task: summary.task,
      status: summary.status,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      ...(summary.provider === undefined ? {} : { provider: summary.provider }),
      live: this.isLive(summary.id),
    }));
  }

  /** Receive `event`, `state` and `log` messages for one run. */
  subscribe(runId: string, listener: RunListener): Unsubscribe {
    const listeners = this.subscribers.get(runId) ?? new Set<RunListener>();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);

    return () => {
      const current = this.subscribers.get(runId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.subscribers.delete(runId);
    };
  }

  /** Fired when a run starts or reaches a terminal status. */
  onRunListChanged(listener: RunListListener): Unsubscribe {
    this.runListListeners.add(listener);
    return () => {
      this.runListListeners.delete(listener);
    };
  }

  /**
   * Cancel everything in flight and wait for it to unwind.
   *
   * Waiting matters: aborting and exiting immediately would kill the process
   * mid-`saveRun`, which is the one thing the store's atomic writes cannot
   * protect against because the rename would never happen.
   *
   * A run parked at `awaiting_approval` (FR-M11) needs no special case here,
   * and that is worth stating because it is not obvious from this loop alone:
   * `entry.live` stays true for the whole time a run is parked — from the
   * supervisor's point of view it is still executing, just waiting on a human
   * instead of a provider — so `entry.controller.abort()` fires for it exactly
   * like it does for a run mid-assignment. What is different is what is
   * listening: `awaitTeamApproval` (see its own doc comment) registered an
   * abort listener on this same signal when it parked the run, and that
   * listener is what turns the abort into a rejected promise `executeRun`'s
   * `await` on it can actually observe. Without that listener this loop would
   * still call `abort()`, but nothing downstream would ever notice — the
   * background task would sit forever on an unsettled promise, `inFlight`
   * would never drain, and `Promise.allSettled` below would hang until the
   * process was killed out from under it.
   */
  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.live) entry.controller.abort();
    }
    await Promise.allSettled([...this.inFlight]);
  }

  private emit(runId: string, message: ServerMessage): void {
    const listeners = this.subscribers.get(runId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (error) {
        // One socket that throws on send must not abort the run producing the
        // events, nor stop the other subscribers from getting them.
        this.deps.onWarning(`subscriber for run ${runId} threw`, error);
      }
    }
  }

  private notifyRunListChanged(): void {
    for (const listener of this.runListListeners) {
      try {
        listener();
      } catch (error) {
        this.deps.onWarning('run-list listener threw', error);
      }
    }
  }

  /** Drop the oldest finished entries; live runs are never evicted. */
  private evictFinishedRuns(): void {
    const finished = [...this.entries.values()].filter((entry) => !entry.live);
    const excess = finished.length - RETAINED_FINISHED_RUNS;
    for (let i = 0; i < excess; i += 1) {
      const victim = finished[i];
      if (victim !== undefined) this.entries.delete(victim.runId);
    }
  }
}

/**
 * Per-run dispatch options: the request's values where it supplied them, the
 * server's defaults everywhere else.
 *
 * Spread-if-defined rather than assigning `undefined`, because `DispatchOptions`
 * treats a present-but-undefined `runTokenBudget` as "no budget" only by
 * accident, and this codebase does not rely on that.
 */
function dispatchOptionsFor(
  request: CreateRunRequest,
  defaults: Partial<DispatchOptions> | undefined,
): Partial<DispatchOptions> {
  return {
    ...(defaults ?? {}),
    ...(request.concurrency === undefined ? {} : { maxConcurrency: request.concurrency }),
    ...(request.timeoutMs === undefined ? {} : { assignmentTimeoutMs: request.timeoutMs }),
    ...(request.tokenBudget === undefined ? {} : { runTokenBudget: request.tokenBudget }),
  };
}

/**
 * A {@link RunStore} that reports the run `createRun` just allocated.
 *
 * WHY THE OLD IMPLEMENTATION WAS WRONG (this replaced a hand-written object
 * literal enumerating the twelve `RunStore` interface methods, each one
 * forwarded individually to `store`). That shape looks safer than a `Proxy` —
 * the comment it used to carry argued exactly that, on the grounds that a
 * typo in a method name is a compile error instead of a silently missing key
 * on a spread. It is also precisely backwards for what actually went wrong: a
 * literal type-checks against the DECLARED return type (`RunStore`)
 * regardless of how much MORE the concrete object passed in actually has.
 * `FileRunStore` has more: it implements `assignmentWorkspaceDir` (AO-8),
 * which is deliberately not on the `RunStore` interface — `dispatcher.ts`
 * reaches it through a duck-typed extension point (`hasPerAssignmentWorkspaces`)
 * precisely so that widening `RunStore` itself, and with it every
 * implementation including the disk-free `MemoryRunStore`, was never
 * necessary. Wrapping `store` in a twelve-key literal silently narrowed
 * whatever richer object was passed in back down to exactly those twelve keys,
 * dropping `assignmentWorkspaceDir` on the floor. The observable failure: every
 * run started through `RunSupervisor` — `POST /api/runs`, the entire web UI
 * path — lost per-assignment workspace isolation and fell back to the single
 * shared `workspaceDir(runId)`, so concurrent assignments in a parallel phase
 * could read and write each other's files, which is exactly the AO-8
 * containment gap `assignmentWorkspaceDir` exists to close. `scripts/run.ts`
 * (`npm run run`) hands `FileRunStore` straight to `executeRun` with no
 * wrapper in between, so the CLI path never lost the method — and every audit
 * run to date went through the CLI, which is why this shipped unnoticed. A
 * wrapper that enumerates an interface is a trap for exactly this reason: it
 * is only ever correct for as long as nobody hands it anything richer than the
 * interface, and nothing about the literal's own type-checking enforces that.
 *
 * THE FIX: a `Proxy` whose `get` trap forwards by property NAME rather than a
 * fixed list, so it also forwards whatever gets added to the wrapped store
 * later that nobody thinks to come back and update this function for.
 *
 * `this`-BINDING HAZARD CHECKED: whether `FileRunStore` uses ECMAScript
 * `#private` fields (grepped `packages/server/src/store/fileStore.ts` for `#`
 * field declarations — none; it uses `private readonly` class fields, which
 * are a TypeScript compile-time annotation with no runtime enforcement, i.e.
 * ordinary own properties at runtime). This matters because the obvious
 * alternative, `Object.create(store)` — a fresh object with `store` as its
 * prototype, `createRun` then overridden as an own property — calls every
 * forwarded method with `this` bound to that fresh wrapper object, not to
 * `store`. Plain instance properties still resolve correctly through the
 * prototype chain in that case (`this.rootDir` on the wrapper finds `rootDir`
 * as an own property of its prototype, `store`), which is why `Object.create`
 * would not actually misbehave against `FileRunStore` as it exists today. It
 * would misbehave the moment any method needed a TRUE `#private` field,
 * because those are read through a per-class internal slot that only a real
 * instance of the class carries — `this.#field` throws a `TypeError` as soon
 * as `this` is a look-alike object rather than the actual instance, and
 * `Object.create(store)` is exactly such a look-alike. Rather than ship
 * something that is "correct until a future `#private` field is added" — the
 * same kind of latent, undetectable-until-it-breaks assumption the twelve-key
 * literal made about `RunStore` staying the whole story — every function
 * pulled off `store` below is explicitly `.bind(store)`-ed before being
 * handed to a caller, so `this` is unconditionally the real instance no
 * matter what `store`'s class does with its fields, now or later.
 *
 * `createRun` is the one property intercepted directly in the trap rather
 * than forwarded: the entire point of this function is running
 * `onCreated(run)` after the real `store.createRun` resolves and before the
 * result reaches the caller, and that hook behaviour — call through, then
 * `onCreated(run)`, then return the run — is unchanged from the literal this
 * replaced.
 */
export function withCreateRunHook(store: RunStore, onCreated: (run: RunState) => void): RunStore {
  const hookedCreateRun: RunStore['createRun'] = async (task) => {
    const run = await store.createRun(task);
    onCreated(run);
    return run;
  };

  return new Proxy(store, {
    get(target, prop, _receiver) {
      if (prop === 'createRun') return hookedCreateRun;

      // The receiver passed to `Reflect.get` is `target`, not the trap's own
      // `receiver` argument (which is the proxy) — a getter, or a future
      // method that reads other properties through `this`, must see `this`
      // as `target` for the same reason a plain method call must, per the
      // hazard checked above.
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Deep copy through the schema, matching the stores.
 *
 * The validation is not paranoia about our own code: it is the same guarantee
 * the file store gives, so a state that could not be persisted also cannot be
 * broadcast to a client that would then render something the server could never
 * reload.
 */
function cloneRun(run: RunState): RunState {
  return RunStateSchema.parse(JSON.parse(JSON.stringify(run)));
}

/**
 * Is the process that started a run still alive?
 *
 * `process.kill(pid, 0)` sends no signal — it is the standard existence probe,
 * and it works on Windows, where this application mostly runs. `EPERM` counts as
 * ALIVE: the process exists but belongs to another user, which is still not a
 * corpse to clean up.
 *
 * Every uncertain answer resolves to "leave it alone", and that asymmetry is
 * deliberate. Getting this wrong in one direction leaves a genuinely dead run
 * sitting non-terminal until someone looks at it; getting it wrong in the other
 * direction kills live work in another process and reports a restart that never
 * happened. The first is untidy, the second destroys a paid run mid-flight — so
 * an unknown pid (every run written before `ownerPid` existed) reconciles as it
 * always did, and a pid that answers reconciles never.
 *
 * Pid reuse is the known hole: the OS can hand this number to something
 * unrelated after the owner dies, and then an abandoned run is skipped forever.
 * That is the safe direction, and the run stays visible as non-terminal for a
 * human to settle rather than being silently rewritten by a guess.
 */
function isOwnedByLiveProcess(ownerPid: number | undefined): boolean {
  if (ownerPid === undefined) return false;
  // Our own pid, without one of our `entries`, is not us: this process knows
  // what it is executing. It is a stale record from a previous process that the
  // OS happened to give this number to, so treat it as dead.
  if (ownerPid === process.pid) return false;

  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
