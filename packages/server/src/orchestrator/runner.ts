import {
  EMPTY_USAGE,
  canTransitionRun,
  isRunTerminal,
  type AgentEvent,
  type RunState,
  type RunStatus,
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import type { AgentProvider } from '../providers/types.js';
import type { RunStore } from '../store/types.js';
import {
  dispatchRun,
  materialiseAssignments,
  type DispatchOptions,
  type DispatchResult,
} from './dispatcher.js';
import {
  MANAGER_PLAN_ASSIGNMENT_ID,
  MANAGER_SYNTHESIS_ASSIGNMENT_ID,
  planRun,
  synthesiseReport,
  type AssignmentReport,
} from './manager.js';
import { produceDeliverable } from '../reports/deliverable.js';

/**
 * The end-to-end run (PLAN.md Phase 2).
 *
 * Walks one task through the whole pipeline: plan, dispatch, synthesise. This is
 * the only place the run-level state machine is driven, so the legality of every
 * transition is checked in one function rather than scattered across the
 * orchestrator.
 */

/** Where the Manager's synthesis lands, relative to the run directory. */
export const SYNTHESIS_REPORT_PATH = 'report.md';

export interface ExecuteRunDeps {
  registry: Registry;
  provider: AgentProvider;
  /**
   * Per-agent provider override (Phase 7). Passed straight through to the
   * dispatcher; see the note on `DispatchDeps.providerFor`.
   *
   * Only the *assignment* dispatch consults it. The Manager's planning and
   * synthesis turns stay on the run's provider deliberately: they are the two
   * calls that decide what the whole run does and how it reads, and letting
   * them vary per agent would mean a run whose plan came from one model and
   * whose report came from another, with nothing recording which.
   */
  providerFor?: (agentName: string) => AgentProvider | undefined;
  store: RunStore;
  /** The user's task, verbatim. */
  task: string;
  signal?: AbortSignal;
  dispatch?: Partial<DispatchOptions>;
  /** FR-M2 repair budget for planning. */
  maxRepairAttempts?: number;
  onEvent?: (event: AgentEvent) => void;
  onStateChange?: (run: RunState) => void;
  logger?: (message: string) => void;
  /**
   * The `designing` step (FR-P2–FR-P5). Defaults to the real one.
   *
   * Injectable because the real implementation spawns a headless browser, and
   * that is the wrong dependency for a test about event fan-out or run state:
   * it makes every such test cost a browser launch and quietly requires Chromium
   * to be installed wherever the suite runs. Production keeps the real default;
   * only tests substitute.
   */
  produceDeliverable?: typeof produceDeliverable;
}

export interface ExecuteRunResult {
  run: RunState;
  /** The synthesis markdown, when the run got that far. */
  report?: string;
  /** Per-assignment tally, when dispatch ran. */
  dispatch?: DispatchResult;
}

export async function executeRun(deps: ExecuteRunDeps): Promise<ExecuteRunResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const log = deps.logger ?? ((message: string) => console.log(message));
  const run = await deps.store.createRun(deps.task);

  // Stamped before the first transition so every persisted state carries it,
  // including a run that fails during planning. NFR-5 costing reads this.
  run.provider = deps.provider.id;

  /**
   * The Manager's turns are not assignments, so nothing in the dispatcher
   * records their token usage. Intercept it here — this is the only layer that
   * sees both manager calls — so the run's true cost is persisted (NFR-5).
   */
  const onEvent = (event: AgentEvent): void => {
    if (
      event.t === 'usage' &&
      (event.assignmentId === MANAGER_PLAN_ASSIGNMENT_ID ||
        event.assignmentId === MANAGER_SYNTHESIS_ASSIGNMENT_ID)
    ) {
      const current = run.managerUsage ?? EMPTY_USAGE;
      run.managerUsage = {
        inputTokens: current.inputTokens + event.inputTokens,
        outputTokens: current.outputTokens + event.outputTokens,
      };
    }
    deps.onEvent?.(event);
  };

  const setStatus = async (status: RunStatus): Promise<void> => {
    if (!canTransitionRun(run.status, status)) {
      throw new Error(`illegal run transition: ${run.status} -> ${status}`);
    }
    run.status = status;
    run.updatedAt = Date.now();
    await deps.store.saveRun(run);
    deps.onStateChange?.(run);
  };

  let dispatchResult: DispatchResult | undefined;

  try {
    // --- Planning (FR-M1, FR-M2, FR-M3) ---
    await setStatus('planning');
    log(`[${run.id}] planning`);

    const plan = await planRun({
      registry: deps.registry,
      provider: deps.provider,
      task: deps.task,
      signal,
      ...(deps.maxRepairAttempts === undefined
        ? {}
        : { maxRepairAttempts: deps.maxRepairAttempts }),
      onEvent,
      workspaceDir: await deps.store.workspaceDir(run.id),
    });

    run.plan = plan;
    run.assignments = materialiseAssignments(plan);
    await setStatus('dispatching');
    log(
      `[${run.id}] plan: ${plan.phases.length} phase(s), ` +
        `${run.assignments.length} assignment(s), domain "${plan.domain}"`,
    );

    // --- Dispatch (FR-M4 through FR-M6) ---
    await setStatus('running');
    dispatchResult = await dispatchRun({
      run,
      registry: deps.registry,
      provider: deps.provider,
      store: deps.store,
      signal,
      ...(deps.dispatch === undefined ? {} : { options: deps.dispatch }),
      onEvent,
      ...(deps.onStateChange === undefined ? {} : { onStateChange: deps.onStateChange }),
    });

    if (dispatchResult.haltedBecause === 'cancelled' || signal.aborted) {
      await setStatus('cancelled');
      return { run, dispatch: dispatchResult };
    }

    if (dispatchResult.haltedBecause === 'token-budget') {
      // FR-M8: fail cleanly with partial results preserved on disk. Synthesis is
      // deliberately skipped — it is itself a large call, and spending more
      // tokens to report that we ran out of tokens is the wrong trade.
      run.error =
        'run token budget exhausted; partial reports preserved, synthesis skipped';
      await setStatus('failed');
      return { run, dispatch: dispatchResult };
    }

    if (dispatchResult.completed === 0) {
      run.error = 'no assignment produced a report; nothing to synthesise';
      await setStatus('failed');
      return { run, dispatch: dispatchResult };
    }

    // --- Synthesis (FR-M7) ---
    await setStatus('synthesizing');
    log(
      `[${run.id}] synthesising ${dispatchResult.completed} report(s)` +
        (dispatchResult.failed + dispatchResult.skipped > 0
          ? ` (${dispatchResult.failed} failed, ${dispatchResult.skipped} skipped)`
          : ''),
    );

    const reports = await collectReports(deps.store, run);
    const report = await synthesiseReport({
      registry: deps.registry,
      provider: deps.provider,
      plan,
      reports,
      signal,
      task: run.task,
      onEvent,
      workspaceDir: await deps.store.workspaceDir(run.id),
    });

    await deps.store.writeReport(run.id, SYNTHESIS_REPORT_PATH, report);
    run.reportPath = SYNTHESIS_REPORT_PATH;

    // --- Design and export (Phase 5, FR-P2–FR-P5) ---
    await setStatus('designing');

    // Everything expensive is already on disk. `produceDeliverable` therefore
    // degrades rather than throwing: a machine with no Chromium still finishes
    // the run, with the reports intact and a reason recorded for the missing
    // PDF (NFR-8). Only cancellation escapes, and it is handled by the catch.
    const deliverable = await (deps.produceDeliverable ?? produceDeliverable)({
      run,
      plan,
      registry: deps.registry,
      provider: deps.provider,
      store: deps.store,
      synthesisMarkdown: report,
      appendices: reports.map((entry) => ({
        agentName: entry.agentName,
        // The report's own path, printed under each appendix header so a reader
        // can find the source file. `collectReports` drops it, so it is looked
        // up here rather than widening that type for one caller.
        path:
          run.assignments.find((a) => a.id === entry.assignmentId)?.reportPath ?? entry.assignmentId,
        markdown: entry.markdown,
      })),
      signal,
      logger: log,
    });

    run.theme = deliverable.theme;
    run.designRationale = deliverable.rationale;
    if (deliverable.pdfPath !== undefined) run.pdfPath = deliverable.pdfPath;

    await setStatus('report_ready');
    await setStatus('done');
    log(`[${run.id}] done`);

    return { run, report, dispatch: dispatchResult };
  } catch (error) {
    run.error = describe(error);
    if (!isRunTerminal(run.status)) {
      await setStatus(signal.aborted ? 'cancelled' : 'failed');
    }
    log(`[${run.id}] ${run.status}: ${run.error}`);
    return { run, ...(dispatchResult === undefined ? {} : { dispatch: dispatchResult }) };
  }
}

/**
 * Gather the reports of every completed assignment, in plan order.
 *
 * Failed and skipped assignments contribute nothing — the Manager is told what
 * it has, not what it is missing, because a synthesis prompt padded with absent
 * sections invites the model to invent their contents.
 */
async function collectReports(store: RunStore, run: RunState): Promise<AssignmentReport[]> {
  const reports: AssignmentReport[] = [];

  for (const assignment of run.assignments) {
    if (assignment.status !== 'done' || assignment.reportPath === undefined) continue;
    reports.push({
      assignmentId: assignment.id,
      agentName: assignment.agentName,
      objective: assignment.objective,
      markdown: await store.readReport(run.id, assignment.reportPath),
    });
  }

  return reports;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
