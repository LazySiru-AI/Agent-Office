import {
  EMPTY_USAGE,
  assignmentsInPhase,
  canTransitionAssignment,
  dependenciesUnreachable,
  findAssignment,
  runTotalUsage,
  type AgentEvent,
  type AssignmentState,
  type AssignmentStatus,
  type RunPlan,
  type RunState,
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import type { AgentProvider } from '../providers/types.js';
import type { RunStore } from '../store/types.js';
import { buildAssignmentBrief, type UpstreamReport } from './brief.js';
import {
  buildRevisionNote,
  decideRevision,
  parseReviewVerdict,
  reviewTargetOf,
} from './review.js';

/**
 * The dispatcher (FR-M4, FR-M5, FR-M6, FR-M8).
 *
 * Executes a validated `RunPlan`: phases in order, assignments within a phase in
 * parallel up to a cap, each one briefed with only its own objective and its
 * dependencies' reports.
 *
 * Persistence is deliberately eager — every status change is saved before the
 * next step begins (NFR-2), so a crash leaves a run that can be inspected and
 * resumed rather than a mystery.
 */

export interface DispatchOptions {
  /** Simultaneous assignments within one parallel phase (FR-M4). */
  maxConcurrency: number;
  /** Wall-clock budget per assignment before it is aborted (FR-M8). */
  assignmentTimeoutMs: number;
  /** Total tokens across the run; exceeding it stops dispatch (FR-M8, NFR-5). */
  runTokenBudget?: number;
}

export const DEFAULT_DISPATCH_OPTIONS: DispatchOptions = {
  maxConcurrency: 3,
  assignmentTimeoutMs: 10 * 60 * 1000,
};

export interface DispatchDeps {
  run: RunState;
  registry: Registry;
  provider: AgentProvider;
  /**
   * Per-agent provider selection (Phase 7).
   *
   * Returning `undefined` means "use the run's provider", which is what makes
   * this additive: a caller that does not care never supplies it, and the run
   * behaves exactly as before. It is a function rather than a
   * `Record<agentName, AgentProvider>` because a provider is a live object with
   * a connection and a cost, and building all of them up front to route one
   * assignment would be wasteful for the common case where they are all the
   * same.
   *
   * Why per *agent* and not per *assignment*: the reason to vary a provider is
   * a property of the specialist, not of the job — a cheap model for a
   * mechanical summarisation agent, a stronger one for the reviewer. Keying on
   * assignment id would mean re-deciding for every plan.
   */
  providerFor?: (agentName: string) => AgentProvider | undefined;
  store: RunStore;
  /** Cancellation (FR-M9). */
  signal: AbortSignal;
  options?: Partial<DispatchOptions>;
  /** Streamed to the UI (NFR-3). */
  onEvent?: (event: AgentEvent) => void;
  /** Fired after every persisted state change. */
  onStateChange?: (run: RunState) => void;
}

/** Why dispatch stopped. Distinguishes "all done" from "gave up". */
export interface DispatchResult {
  run: RunState;
  completed: number;
  failed: number;
  skipped: number;
  /** Set when dispatch halted early. */
  haltedBecause?: 'cancelled' | 'token-budget';
}

/**
 * Flatten a validated plan into the assignment states the dispatcher walks.
 *
 * Order matters: `allAssignments` returns phase order, and several helpers
 * assume `run.assignments` preserves it.
 */
export function materialiseAssignments(plan: RunPlan): AssignmentState[] {
  return plan.phases.flatMap((phase) =>
    phase.assignments.map<AssignmentState>((assignment) => ({
      id: assignment.id,
      phaseId: phase.id,
      agentName: assignment.agentName,
      objective: assignment.objective,
      deliverable: assignment.deliverable,
      dependsOn: [...assignment.dependsOn],
      status: 'pending',
      attempts: 0,
      usage: { ...EMPTY_USAGE },
    })),
  );
}

interface DispatchContext {
  run: RunState;
  plan: RunPlan;
  registry: Registry;
  provider: AgentProvider;
  providerFor: ((agentName: string) => AgentProvider | undefined) | undefined;
  store: RunStore;
  signal: AbortSignal;
  options: DispatchOptions;
  onEvent: ((event: AgentEvent) => void) | undefined;
  onStateChange: ((run: RunState) => void) | undefined;
  /** Set when the token budget trips, to halt remaining phases. */
  halted?: 'cancelled' | 'token-budget';
  /**
   * Critiques waiting to be attached to a re-dispatched assignment's brief
   * (FR-M10), keyed by target assignment id.
   *
   * Held here rather than on `AssignmentState` because it is transient
   * scheduling detail, not run state: it exists for exactly one re-dispatch and
   * has no meaning once that brief is built. Putting it on the persisted state
   * would mean a resumed run carrying a critique it had already acted on.
   */
  pendingRevisionNotes: Map<string, string>;
  /**
   * Single-flight claim on "decide, then redispatch" per target assignment id,
   * guarding `applyReviewVerdict` against two reviewers of the same target
   * both deciding to redispatch it (see the comment there for the race this
   * closes). A `Set` rather than a lock with waiters because nothing needs to
   * wait: the loser is refused outright, not queued.
   */
  targetsBeingRevised: Set<string>;
  /**
   * Tripped the moment `enforceTokenBudget` judges the run over budget, so
   * assignments already mid-flight can be cut short via the same abort-signal
   * machinery used for cancellation and per-assignment timeouts, instead of
   * being left to run to completion after the run has already decided to stop
   * spending. See `enforceTokenBudget` for the honest bound on how much this
   * does and does not prevent.
   */
  haltController: AbortController;
}

export async function dispatchRun(deps: DispatchDeps): Promise<DispatchResult> {
  const plan = deps.run.plan;
  if (plan === undefined) {
    throw new Error(`run "${deps.run.id}" has no plan; cannot dispatch`);
  }

  const ctx: DispatchContext = {
    run: deps.run,
    plan,
    registry: deps.registry,
    provider: deps.provider,
    providerFor: deps.providerFor,
    store: deps.store,
    signal: deps.signal,
    options: { ...DEFAULT_DISPATCH_OPTIONS, ...deps.options },
    onEvent: deps.onEvent,
    onStateChange: deps.onStateChange,
    pendingRevisionNotes: new Map(),
    targetsBeingRevised: new Set(),
    haltController: new AbortController(),
  };

  // Checked once here, before any phase runs, not only after each assignment
  // completes: Manager planning spend (FR-M8, NFR-5) is already banked into
  // `run.managerUsage` by the time dispatch begins (see `runTotalUsage`'s doc
  // comment in `shared/src/run.ts`). Without this eager check, a run whose
  // planning turn alone had already exceeded the budget would still dispatch
  // and pay for its first assignment before `enforceTokenBudget` ever got a
  // chance to run — the phase loop below only calls it after an assignment
  // finishes. This way, the loop's own `if (ctx.halted !== undefined) break`
  // sees the halt on its very first iteration and nothing is dispatched at all.
  await enforceTokenBudget(ctx);

  for (const phase of plan.phases) {
    if (ctx.signal.aborted) {
      ctx.halted = 'cancelled';
      break;
    }
    if (ctx.halted !== undefined) break;

    const inPhase = assignmentsInPhase(ctx.run, phase.id);

    // Skip anything whose dependencies failed or were skipped, before dispatching
    // the rest. Running an assignment without an upstream report it declared a
    // dependency on would silently degrade its brief (FR-M5).
    for (const assignment of inPhase) {
      if (assignment.status === 'pending' && dependenciesUnreachable(ctx.run, assignment)) {
        await setStatus(ctx, assignment.id, 'skipped', {
          error: `skipped: a dependency did not complete (${assignment.dependsOn.join(', ')})`,
          endedAt: Date.now(),
        });
      }
    }

    const runnable = assignmentsInPhase(ctx.run, phase.id).filter((a) => a.status === 'pending');
    const limit = phase.parallel ? Math.max(1, ctx.options.maxConcurrency) : 1;

    await runPool(runnable, limit, async (assignment) => {
      if (ctx.signal.aborted || ctx.halted !== undefined) return;
      try {
        await executeAssignment(ctx, assignment.id);
      } catch (error) {
        // Defensive containment, not a substitute for the single-flight guard
        // in `applyReviewVerdict` — that guard is what makes the concurrent-
        // reviewer race impossible in the first place. This catch is a
        // backstop for whatever *other* stray throw might one day reach here
        // (a future illegal `setStatus` transition, or anything else). We
        // deliberately leave `setStatus`'s contract of throwing on an illegal
        // transition alone — it is a real programming-invariant check, worth
        // keeping loud during development — but a bug in one assignment's
        // lifecycle must not be able to discard every other assignment's
        // already-completed report, which is exactly what used to happen: the
        // throw escaped this `Promise.all`, unwound out of `dispatchRun`, and
        // `executeRun`'s top-level catch marked the whole run failed. Every
        // other per-assignment failure in this file is recorded as state
        // rather than thrown; this makes a stray throw no exception to that.
        ctx.onEvent?.({
          t: 'error',
          assignmentId: assignment.id,
          message: `assignment "${assignment.id}" errored outside normal failure handling: ${describe(error)}`,
          fatal: false,
        });
      }
      await enforceTokenBudget(ctx);
    });
  }

  if (ctx.signal.aborted) ctx.halted = 'cancelled';

  const tally = { completed: 0, failed: 0, skipped: 0 };
  for (const assignment of ctx.run.assignments) {
    if (assignment.status === 'done') tally.completed += 1;
    else if (assignment.status === 'failed') tally.failed += 1;
    else if (assignment.status === 'skipped') tally.skipped += 1;
  }

  return {
    run: ctx.run,
    ...tally,
    ...(ctx.halted === undefined ? {} : { haltedBecause: ctx.halted }),
  };
}

async function executeAssignment(
  ctx: DispatchContext,
  assignmentId: string,
  opts: { revision?: boolean } = {},
): Promise<void> {
  const assignment = findAssignment(ctx.run, assignmentId);
  if (assignment === undefined) return;

  const agent = ctx.registry.get(assignment.agentName);
  if (agent === undefined) {
    // Should be unreachable: FR-M3 validates names before dispatch. Treated as an
    // assignment failure rather than a crash so one bad name cannot sink a run.
    await failAssignment(ctx, assignmentId, `no agent named "${assignment.agentName}" in registry`);
    return;
  }

  await setStatus(ctx, assignmentId, 'briefing', {
    startedAt: assignment.startedAt ?? Date.now(),
    attempts: assignment.attempts + 1,
    // FR-M10 revision re-dispatch: the assignment has not ended any more, so
    // its stale `endedAt` from the earlier completion must be cleared — both
    // in memory (this `Object.assign`, inside `setStatus`) and in the event
    // log (`endedAtCleared`, which `setStatus` derives from the explicit
    // `endedAt: undefined` key below — see events.ts for why an absent key
    // cannot carry this meaning). Folding the clear into this call, rather
    // than a separate untracked patch before it, is what gets it into the log
    // at all: only `setStatus` emits an event.
    ...(opts.revision === true ? { endedAt: undefined } : {}),
  });

  // Consumed, not merely read: a critique is for one re-dispatch. Leaving it in
  // the map would attach it again if this assignment ever ran a third time.
  const revisionNote = ctx.pendingRevisionNotes.get(assignmentId);
  ctx.pendingRevisionNotes.delete(assignmentId);

  let brief: string;
  try {
    const upstreamReports = await loadUpstreamReports(ctx, assignment);
    brief = buildAssignmentBrief({
      agent,
      task: ctx.run.task,
      assignment,
      upstreamReports,
      isReview: reviewTargetOf(assignment) !== undefined,
      ...(revisionNote === undefined ? {} : { revisionNote }),
    });
  } catch (error) {
    await failAssignment(ctx, assignmentId, `could not assemble brief: ${describe(error)}`);
    return;
  }

  await setStatus(ctx, assignmentId, 'working');

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ctx.options.assignmentTimeoutMs);
  // `ctx.haltController.signal` joins the linked signal so a lane already
  // mid-assignment gets cut short as soon as the token budget trips elsewhere,
  // rather than running to completion regardless (FR-M8; see `enforceTokenBudget`).
  const linked = anySignal([ctx.signal, timeout.signal, ctx.haltController.signal]);

  let text = '';
  let fatalError: string | undefined;
  // Seeded from what this assignment has already spent, not from zero.
  //
  // An assignment can execute twice: FR-M10 sends one back for a single
  // revision, and that second run is a second provider call costing real money.
  // This local total used to start empty and then OVERWRITE the persisted
  // figure, so a revised assignment reported only its revision's tokens and the
  // first attempt's spend vanished from `run.json` — while the replay fold,
  // which sums the `usage` events on disk, reported the true total. The two
  // disagreeing is what made it visible; the undercount is what made it matter
  // (NFR-5). `attempts` is already incremented for exactly this case.
  const usage = { ...assignment.usage };

  // Resolved per assignment, not hoisted: a run may legitimately field two
  // providers, and caching one here would silently apply the first
  // assignment's choice to the rest.
  const provider = ctx.providerFor?.(assignment.agentName) ?? ctx.provider;

  try {
    for await (const event of provider.run({
      assignmentId,
      systemPrompt: agent.systemPrompt,
      task: brief,
      allowedTools: agent.tools,
      workspaceDir: await ctx.store.workspaceDir(ctx.run.id),
      signal: linked.signal,
      // The catalog's per-agent `model:`, forwarded verbatim. The dispatcher
      // does not interpret it — `sonnet` and `inherit` mean different things to
      // different engines, and deciding here would put provider knowledge back
      // in the orchestrator. Absent for the 8 agents that declare no model,
      // which every adapter reads as "use whatever the run is using".
      ...(agent.model === undefined ? {} : { model: agent.model }),
    })) {
      await ctx.store.appendEvent(ctx.run.id, assignmentId, event);
      ctx.onEvent?.(event);

      if (event.t === 'text') text += event.chunk;
      else if (event.t === 'usage') {
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
      } else if (event.t === 'error' && event.fatal) fatalError = event.message;
    }
  } catch (error) {
    fatalError = describe(error);
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }

  // Record usage even on failure — a failed assignment still costs money (NFR-5).
  await patchAssignment(ctx, assignmentId, { usage });

  if (timeout.signal.aborted) {
    await failAssignment(
      ctx,
      assignmentId,
      `timed out after ${ctx.options.assignmentTimeoutMs}ms`,
    );
    return;
  }
  if (ctx.signal.aborted) {
    // FR-M9: cancelled mid-flight. This used to `return` here and leave the
    // assignment in `working`, on the reasoning that the persisted run would
    // then show where it was interrupted. The intent was reasonable but
    // nothing ever revisited it: the RUN reaches terminal `cancelled` while
    // this assignment sits in `working` forever, and `working` renders as
    // "seated, typing loop" (`shared/src/status.ts`'s `ASSIGNMENT_BEHAVIOUR`),
    // so every reload or replay of a cancelled run showed that agent still
    // typing, indefinitely, for a run that was long over.
    //
    // `working`'s only legal onward transitions are `reporting` (this run did
    // not produce one) and `blocked` (also not terminal — see
    // `canTransitionAssignment` in `shared/src/status.ts`, which this package
    // may not edit). The sole terminal status reachable from `working` is
    // `failed`, via that function's "anything not otherwise reachable may
    // still fail" fallback. Calling it a failure is an imperfect fit — a
    // cancellation is not really an error — but it is the only terminal option
    // the state machine offers without changing `status.ts`, and the original
    // intent survives in the error text and `endedAt` below: a reader can
    // still see exactly which assignment was in flight when the cancel landed,
    // instead of inferring it from a character that never stops typing.
    await failAssignment(
      ctx,
      assignmentId,
      'cancelled: run was stopped while this assignment was in progress',
    );
    return;
  }
  if (ctx.haltController.signal.aborted && text.trim() === '') {
    // Unlike the timeout and cancellation checks above, this one is
    // deliberately guarded on `text.trim() === ''` rather than firing
    // unconditionally. `haltController` is shared across every lane in the
    // run (see `enforceTokenBudget`), so by the time this assignment reaches
    // this line, some *other* lane's completion may have tripped it moments
    // after this one's provider loop had already finished cleanly with a full
    // report in hand. Failing that assignment anyway would discard a
    // completed, already-paid-for report over an abort that never actually
    // touched it — the exact kind of collateral loss FR-M8's "partial results
    // preserved" promises against. Checking `text` limits this branch to
    // assignments that were genuinely cut short: some providers throw on an
    // aborted signal (caught above as a generic error) and some — like the
    // scripted test provider — simply notice `signal.aborted` and stop
    // yielding events quietly, which would otherwise fall through to a
    // misleading "produced no report" instead of naming the real cause.
    await failAssignment(
      ctx,
      assignmentId,
      'halted: run token budget exceeded while this assignment was in progress',
    );
    return;
  }
  if (fatalError !== undefined) {
    await failAssignment(ctx, assignmentId, fatalError);
    return;
  }
  if (text.trim() === '') {
    // FR-M6: a missing report is a failed assignment, not a quiet success.
    await failAssignment(ctx, assignmentId, 'produced no report');
    return;
  }

  await setStatus(ctx, assignmentId, 'reporting');

  try {
    await ctx.store.writeReport(ctx.run.id, assignment.deliverable, text.trim());
  } catch (error) {
    // `deliverable` comes from the Manager and is untrusted; the store rejects
    // anything escaping the run directory (NFR-1).
    await failAssignment(ctx, assignmentId, `could not write report: ${describe(error)}`);
    return;
  }

  await setStatus(ctx, assignmentId, 'done', {
    reportPath: assignment.deliverable,
    endedAt: Date.now(),
  });

  await applyReviewVerdict(ctx, assignment, text.trim());
}

/**
 * FR-M10: if this assignment was a review and it asked for revisions, send its
 * target back once.
 *
 * The re-dispatch runs here, inside the *reviewer's* execution, rather than by
 * rewinding the phase loop. That is the whole trick: a reviewer necessarily
 * sits in a later phase than its target, phases run strictly in order, and
 * `dispatchRun`'s loop has no notion of going back — so a design that needed to
 * re-enter a drained phase would have meant rewriting the scheduler. Re-running
 * the target from here needs none of that, and it keeps the revision inside the
 * phase that asked for it, which is also where a reader would look for it.
 *
 * The reviewer does **not** re-review the revised work. That would be the
 * natural next thing to want, and it is deliberately absent: reviewing again
 * means another provider call, and then a verdict on *that*, and the loop has
 * no principled end. FR-M10 says "once", and once is what this does.
 */
async function applyReviewVerdict(
  ctx: DispatchContext,
  reviewer: AssignmentState,
  reportText: string,
): Promise<void> {
  const targetId = reviewTargetOf(reviewer);
  if (targetId === undefined) return;

  const outcome = parseReviewVerdict(reportText);
  const target = findAssignment(ctx.run, targetId);

  // Single-flight guard (CRITICAL, confirmed 4/8 against the real
  // `FileRunStore` on real disk): nothing used to serialise "decide, then
  // redispatch" against the same section running for a second reviewer of the
  // SAME target — exactly the shape of two reviewers over one lead, in one
  // parallel phase. Both would read `target.status === 'done'` before either
  // had redispatched, both would decide `redispatch: true`, the first would
  // flip the target `done -> briefing`, and the second's own
  // `setStatus(target, 'briefing')` would then throw —
  // `canTransitionAssignment('briefing', 'briefing')` is false. That throw was
  // uncaught: it escaped `runPool`'s `Promise.all`, unwound `dispatchRun`, and
  // landed in `executeRun`'s top-level catch, which failed the WHOLE RUN and
  // discarded every completed report — for a situation FR-M10 says should
  // simply be refused.
  //
  // `alreadyClaimed` is read, and the claim below is taken, with no `await` in
  // between — this whole stretch, from `parseReviewVerdict` above through
  // `targetsBeingRevised.add` below, is synchronous. JS never preempts a
  // synchronous stretch of code, so whichever reviewer's `applyReviewVerdict`
  // reaches the claim first is guaranteed to see it unclaimed and win it before
  // the other reviewer's synchronous stretch can even begin. Everything after
  // the claim is genuinely async and free to interleave; that is fine, because
  // only the winner ever gets there — the loser has already returned, refused,
  // by the time any of it runs.
  const alreadyClaimed = ctx.targetsBeingRevised.has(targetId);
  const decision = decideRevision({
    reviewer,
    outcome,
    target,
    concurrentRevisionInFlight: alreadyClaimed,
  });

  if (!decision.redispatch) {
    // A refusal is worth surfacing but is not a failure: the run continues with
    // the work as it stands, and the reviewer's critique is still in its report
    // for a human to read. Silence here would make an exhausted revision budget
    // — or, now, a lost race for the same target — indistinguishable from an
    // approval.
    if (decision.refusedBecause !== undefined) {
      ctx.onEvent?.({
        t: 'error',
        assignmentId: reviewer.id,
        message: `revisions requested for "${targetId}" but not applied (${decision.refusedBecause})`,
        fatal: false,
      });
    }
    return;
  }

  ctx.targetsBeingRevised.add(targetId);
  try {
    if (ctx.signal.aborted || ctx.halted !== undefined) return;

    ctx.pendingRevisionNotes.set(
      targetId,
      buildRevisionNote({
        reviewerAgentName: reviewer.agentName,
        critique: outcome.critique ?? '',
      }),
    );

    // Goes back through `executeAssignment` unchanged: that function opens with
    // `done -> briefing`, which `shared/src/status.ts` permits for exactly this,
    // and it will pick the critique out of the map itself. `revision: true` is
    // what clears `endedAt` — both in memory and, via `endedAtCleared` on the
    // emitted event, in the log — inside that same opening `setStatus` call; see
    // the comment there for why this used to be a separate `patchAssignment`
    // call that never reached the log at all (a real NFR-7 gap, not merely a
    // simplification here).
    await executeAssignment(ctx, targetId, { revision: true });
  } finally {
    // Released once this redispatch has run its course. With
    // `MAX_REVIEW_REVISIONS` at 1 nothing will ever consult this claim again
    // for this target in practice — `decideRevision`'s own attempt-budget
    // check refuses a further revision on its merits — but leaving the claim
    // set would leave a stale flag behind that outlives the thing it was
    // guarding, which is its own kind of bug waiting for a future reviewer
    // shape this file does not anticipate yet.
    ctx.targetsBeingRevised.delete(targetId);
  }
}

/** Load the reports this assignment declared a dependency on, in order. */
async function loadUpstreamReports(
  ctx: DispatchContext,
  assignment: AssignmentState,
): Promise<UpstreamReport[]> {
  const reports: UpstreamReport[] = [];

  for (const depId of assignment.dependsOn) {
    const dep = findAssignment(ctx.run, depId);
    if (dep?.reportPath === undefined) continue;
    reports.push({
      assignmentId: dep.id,
      agentName: dep.agentName,
      content: await ctx.store.readReport(ctx.run.id, dep.reportPath),
    });
  }

  return reports;
}

/**
 * FR-M8's per-run token budget, checked after every assignment completes.
 *
 * Two defects lived here.
 *
 * MAJOR (confirmed): this used `totalUsage` — assignments only — so Manager
 * spend (planning, repair, synthesis) escaped the budget entirely. Measured
 * with `runTokenBudget: 400`: 225 tokens of assignment spend, 420 of Manager
 * spend, 645 true total — 61% over — and `haltedBecause` never fired, because
 * 225 alone never crosses 400. FR-M8 says "per-run token budget"; a user who
 * sets a limit means the run, not the slice of it the dispatcher happens to
 * own. Now checked against `runTotalUsage`, which is assignments plus
 * `run.managerUsage` — see that function's doc comment in `shared/src/run.ts`
 * for the full accounting, including why Manager planning spend counts
 * immediately here while synthesis spend, happening after dispatch ends,
 * cannot be pre-empted by this check at all.
 *
 * MODERATE (confirmed): even with the right total, this only runs *after* an
 * assignment finishes, and — before this fix — lanes already in flight when
 * the budget tripped ran to completion regardless. Measured at concurrency 3,
 * budget 12,000, six 10,000-token assignments: the run spent 40,000 — 28,000
 * over — before halting. A lane that has not started a *new* assignment yet
 * was already safe (the `ctx.halted !== undefined` check at the top of the
 * `runPool` worker in `dispatchRun` sees the halt and skips it), but that
 * alone does not bound the overshoot: any lane already mid-assignment, plus
 * any lane that slipped past that same check moments earlier because the halt
 * had not been observed yet, kept running unconstrained.
 *
 * The fix here is `ctx.haltController.abort()`: it reuses the same
 * abort-signal machinery already wired through `executeAssignment` for
 * cancellation and per-assignment timeouts, so every lane currently awaiting a
 * provider chunk gets the same signal a moment after this function trips. That
 * reduces the overshoot but cannot make it exact, and pretending otherwise
 * would be dishonest: usage is only known after a provider event reports it,
 * so a lane already past its last checkpoint can still bank tokens between
 * "the budget tripped" and "the provider noticed its signal aborted" — and a
 * provider that does not honour cancellation promptly (or at all) is not
 * bounded by this code no matter what it does. The only guarantee FR-M8
 * actually makes is the one it states: the run halts and partial results are
 * preserved, not that spend stays under the number.
 */
async function enforceTokenBudget(ctx: DispatchContext): Promise<void> {
  const budget = ctx.options.runTokenBudget;
  if (budget === undefined || ctx.halted !== undefined) return;

  const used = runTotalUsage(ctx.run);
  if (used.inputTokens + used.outputTokens > budget) {
    ctx.halted = 'token-budget';
    ctx.haltController.abort();
  }
}

async function setStatus(
  ctx: DispatchContext,
  assignmentId: string,
  status: AssignmentStatus,
  patch: Partial<AssignmentState> = {},
): Promise<void> {
  const assignment = findAssignment(ctx.run, assignmentId);
  if (assignment === undefined) {
    throw new Error(`assignment "${assignmentId}" not found in run "${ctx.run.id}"`);
  }
  if (!canTransitionAssignment(assignment.status, status)) {
    throw new Error(
      `illegal transition for "${assignmentId}": ${assignment.status} -> ${status}`,
    );
  }

  // Read before `Object.assign` overwrites `patch` into `assignment`: this is
  // the `in`-vs-`=== undefined` distinction events.ts's `endedAtCleared` exists
  // for. `patch.endedAt === undefined` is true both when the caller never
  // mentioned `endedAt` (every ordinary call) and when the caller explicitly
  // wrote `endedAt: undefined` to clear it (the FR-M10 revision call in
  // `executeAssignment`) — those are different intents and must not collapse
  // to the same event. `'endedAt' in patch` is what tells them apart.
  const clearsEndedAt = 'endedAt' in patch && patch.endedAt === undefined;

  Object.assign(assignment, patch, { status });
  await persist(ctx);

  // Persisted as well as broadcast (NFR-7).
  //
  // Provider events go to both the store and the live stream, but status
  // transitions used to be broadcast only — so a live viewer saw characters
  // move while the on-disk log, which is the *only* source replay has, held
  // nothing but `text` and `usage`. Replaying a real run therefore rebuilt an
  // office where every assignment sat in `pending` for ever, which looks like a
  // renderer bug and is not one. Status is the single most important thing the
  // sim reads; it has to survive the run that produced it.
  //
  // The patch fields below ride the SAME event, carrying the exact values just
  // assigned to `assignment` above (not a re-derived approximation) — this is
  // what makes `useReplay.ts`'s fold reconstruct `reportPath`/`error`/`endedAt`
  // exactly rather than guess them. See events.ts for why each is optional and
  // why `endedAtCleared` exists as a separate signal from `endedAt`'s absence.
  const event: AgentEvent = {
    t: 'status',
    assignmentId,
    status,
    ...(patch.reportPath === undefined ? {} : { reportPath: patch.reportPath }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    ...(patch.endedAt === undefined ? {} : { endedAt: patch.endedAt }),
    ...(clearsEndedAt ? { endedAtCleared: true as const } : {}),
  };
  await ctx.store.appendEvent(ctx.run.id, assignmentId, event);
  ctx.onEvent?.(event);
}

/** Update fields without a status transition. */
async function patchAssignment(
  ctx: DispatchContext,
  assignmentId: string,
  patch: Partial<AssignmentState>,
): Promise<void> {
  const assignment = findAssignment(ctx.run, assignmentId);
  if (assignment === undefined) return;
  Object.assign(assignment, patch);
  await persist(ctx);
}

async function failAssignment(
  ctx: DispatchContext,
  assignmentId: string,
  message: string,
): Promise<void> {
  await setStatus(ctx, assignmentId, 'failed', { error: message, endedAt: Date.now() });
}

async function persist(ctx: DispatchContext): Promise<void> {
  ctx.run.updatedAt = Date.now();
  await ctx.store.saveRun(ctx.run);
  ctx.onStateChange?.(ctx.run);
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Written by hand rather than pulled in as a dependency: the semantics needed
 * here are narrow, and the worker never rejects (failures are recorded as
 * assignment state), so there is no error-aggregation subtlety to get wrong.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;

  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });

  await Promise.all(lanes);
}

/**
 * Combine abort signals.
 *
 * `AbortSignal.any` exists in newer Node but its availability across the 20.x
 * line is uneven, so this is done by hand. The returned `dispose` must be called
 * or the listeners leak for the lifetime of the parent signal — which, for the
 * run-level signal, is the whole run.
 */
function anySignal(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  const onAbort = (): void => {
    controller.abort();
    dispose();
  };

  const dispose = (): void => {
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return { signal: controller.signal, dispose: () => undefined };
    }
  }
  for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });

  return { signal: controller.signal, dispose };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
