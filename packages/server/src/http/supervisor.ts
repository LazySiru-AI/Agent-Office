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
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import type { DispatchOptions } from '../orchestrator/dispatcher.js';
import { executeRun, type ExecuteRunDeps } from '../orchestrator/runner.js';
import { makeProvider as defaultMakeProvider } from '../providers/factory.js';
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
  store: RunStore;
  /**
   * Injected so tests can drive a run without the real scripted plan, and so
   * Phase 7's provider-per-run selection has an obvious seam.
   */
  makeProvider?: (id: string, task: string, knownAgentNames: ReadonlySet<string>) => AgentProvider;
  /** Used when a request omits `provider`. */
  defaultProviderId?: string;
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

export class RunSupervisor {
  // `stepDelayMs` is excluded because it is consumed at construction — folded
  // into the default `makeProvider` closure — and never read again.
  private readonly deps: Required<
    Omit<SupervisorDeps, 'dispatchDefaults' | 'stepDelayMs' | 'produceDeliverable'>
  > &
    Pick<SupervisorDeps, 'dispatchDefaults' | 'produceDeliverable'>;

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

  private readonly knownAgentNames: ReadonlySet<string>;

  constructor(deps: SupervisorDeps) {
    this.deps = {
      registry: deps.registry,
      store: deps.store,
      makeProvider:
        deps.makeProvider ??
        ((id, task, known) => defaultMakeProvider(id, task, known, { ...(deps.stepDelayMs === undefined ? {} : { stepDelayMs: deps.stepDelayMs }) })),
      defaultProviderId: deps.defaultProviderId ?? 'scripted',
      onWarning: deps.onWarning ?? ((message, cause) => console.warn(`[supervisor] ${message}`, cause ?? '')),
      now: deps.now ?? Date.now,
      ...(deps.dispatchDefaults === undefined ? {} : { dispatchDefaults: deps.dispatchDefaults }),
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
   * Start a run and return its id as soon as one exists.
   *
   * The provider is built and preflighted *before* returning, so an unusable
   * provider is a failed `POST /api/runs` rather than a run that appears in the
   * list and dies a second later. Everything after that is background work.
   */
  async startRun(request: CreateRunRequest): Promise<string> {
    const providerId = request.provider ?? this.deps.defaultProviderId;
    const provider = this.deps.makeProvider(providerId, request.task, this.knownAgentNames);

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
          registry: this.deps.registry,
          provider,
          store,
          task: request.task,
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
          ...(this.deps.produceDeliverable === undefined
            ? {}
            : { produceDeliverable: this.deps.produceDeliverable }),
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
 * Explicit forwarding rather than a `Proxy` or `Object.assign`: the store's
 * methods are class instance methods, so they must stay bound to the original,
 * and a typo here is a compile error whereas a missing key on a spread is not.
 */
function withCreateRunHook(store: RunStore, onCreated: (run: RunState) => void): RunStore {
  return {
    createRun: async (task) => {
      const run = await store.createRun(task);
      onCreated(run);
      return run;
    },
    loadRun: (runId) => store.loadRun(runId),
    saveRun: (run) => store.saveRun(run),
    listRuns: () => store.listRuns(),
    runDir: (runId) => store.runDir(runId),
    workspaceDir: (runId) => store.workspaceDir(runId),
    writeReport: (runId, relativePath, content) => store.writeReport(runId, relativePath, content),
    readReport: (runId, relativePath) => store.readReport(runId, relativePath),
    readBinary: (runId, relativePath) => store.readBinary(runId, relativePath),
    appendEvent: (runId, assignmentId, event) => store.appendEvent(runId, assignmentId, event),
    readEvents: (runId, assignmentId) => store.readEvents(runId, assignmentId),
  };
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
