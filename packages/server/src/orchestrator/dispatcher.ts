import {
  EMPTY_USAGE,
  assignmentsInPhase,
  canTransitionAssignment,
  dependenciesUnreachable,
  findAssignment,
  totalUsage,
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
  };

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
      await executeAssignment(ctx, assignment.id);
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

async function executeAssignment(ctx: DispatchContext, assignmentId: string): Promise<void> {
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
  const linked = anySignal([ctx.signal, timeout.signal]);

  let text = '';
  let fatalError: string | undefined;
  const usage = { ...EMPTY_USAGE };

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
    // Cancelled mid-flight. Leave the assignment in `working` so the persisted
    // run shows where it was interrupted rather than misreporting a failure.
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
  const decision = decideRevision({ reviewer, outcome, target });

  if (!decision.redispatch) {
    // A refusal is worth surfacing but is not a failure: the run continues with
    // the work as it stands, and the reviewer's critique is still in its report
    // for a human to read. Silence here would make an exhausted revision budget
    // indistinguishable from an approval.
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

  if (ctx.signal.aborted || ctx.halted !== undefined) return;

  ctx.pendingRevisionNotes.set(
    targetId,
    buildRevisionNote({
      reviewerAgentName: reviewer.agentName,
      critique: outcome.critique ?? '',
    }),
  );

  // `endedAt` is cleared first because the assignment has not ended any more —
  // leaving the old timestamp would make the replay show it finishing before it
  // restarted. Then it goes back through `executeAssignment` unchanged: that
  // function opens with `done -> briefing`, which `shared/src/status.ts` permits
  // for exactly this, and it will pick the critique out of the map itself.
  await patchAssignment(ctx, targetId, { endedAt: undefined });
  await executeAssignment(ctx, targetId);
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

async function enforceTokenBudget(ctx: DispatchContext): Promise<void> {
  const budget = ctx.options.runTokenBudget;
  if (budget === undefined || ctx.halted !== undefined) return;

  const used = totalUsage(ctx.run);
  if (used.inputTokens + used.outputTokens > budget) {
    ctx.halted = 'token-budget';
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
  const event: AgentEvent = { t: 'status', assignmentId, status };
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
