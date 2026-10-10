import {
  EMPTY_USAGE,
  addUsage,
  canTransitionRun,
  isRunTerminal,
  type AgentEvent,
  type RunState,
  type RunStatus,
  type ClarificationDecision,
  type TeamOperation,
} from '@agent-office/shared';
import {
  MANAGER_CLARIFY_ASSIGNMENT_ID,
  askClarifyingQuestions,
  buildClarificationBlock,
} from './clarify.js';
import type { DiagnosticsSink } from '../diagnostics/log.js';
import { errorDetail } from '../errors.js';
import type { ModelPolicy } from '../providers/modelPolicy.js';
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
import { applyTeamOperations } from './team.js';
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
  /**
   * Floor and ceiling on the model tier an assignment may run on
   * (`providers/modelPolicy.ts`). Absent uses the default `sonnet`–`opus` range.
   */
  modelPolicy?: ModelPolicy;
  /**
   * Absolute path to what the task is ABOUT (`RunState.subjectPath`).
   *
   * Stamped on the run, given to the planner so its objectives point there, and
   * given to every assignment brief so a specialist does not have to deduce it.
   * Absent means nobody said — the behaviour every run had before this existed.
   */
  subjectPath?: string;
  signal?: AbortSignal;
  dispatch?: Partial<DispatchOptions>;
  /** FR-M2 repair budget for planning. */
  maxRepairAttempts?: number;
  /**
   * FR-R4: shrink the planning prompt to this many ranked candidates instead of
   * the whole roster. Unset — the default — shows every agent.
   *
   * Forwarded to `planRun`, whose `candidateLimit` doc carries the measured
   * token-saving-versus-recall trade this is opting into. It is surfaced here so
   * the choice is reachable by an operator, not so it should be taken lightly.
   */
  candidateLimit?: number;
  onEvent?: (event: AgentEvent) => void;
  onStateChange?: (run: RunState) => void;
  /**
   * Cross-run diagnostics (`diagnostics/log.ts`), forwarded to the dispatcher
   * and used here for the failures the dispatcher never sees — a planning turn
   * that ran out of repair attempts happens before any assignment exists.
   */
  diagnostics?: DiagnosticsSink;
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
  /**
   * FR-M11. When present, the run parks in `awaiting_approval` after planning
   * and waits for the user's verdict before dispatching.
   *
   * Absent — the default — means the run goes `planning -> dispatching`
   * exactly as it did before this feature existed, which is what
   * `RUN_TRANSITIONS` in `shared/src/status.ts` calls out as the reason both
   * edges out of `planning` are legal: this is an opt-in pause, and every
   * caller that never passes this function (every existing test fixture, the
   * CLI, and any HTTP run created without `reviewTeam`) must be unable to
   * tell the difference from before FR-M11 was written.
   *
   * A function rather than a plain awaited value because the run has to
   * reach `awaiting_approval` and be persisted (so a client reconnecting
   * mid-pause sees it) *before* anything can be waited on — there is no
   * value to hand over at the point `ExecuteRunDeps` is constructed, only a
   * promise that resolves once a human somewhere else decides.
   */
  awaitTeamApproval?: (context: {
    run: RunState;
    signal: AbortSignal;
  }) => Promise<readonly TeamOperation[]>;

  /**
   * FR-M12. When present, the Manager gets a question turn before planning, and
   * the run parks in `awaiting_clarification` if it asks anything.
   *
   * Absent — the default — skips the turn entirely: no extra model call, no
   * `clarification` block in the planning prompt, no new status ever reached.
   * The same opt-in guarantee `awaitTeamApproval` makes, and for the same
   * reason: every existing caller must be unable to tell this feature was added.
   *
   * A function for the same reason as its FR-M11 sibling — the questions have to
   * be persisted and pushed to the client *before* anything can be waited on, so
   * there is no value to hand over when `ExecuteRunDeps` is built, only a promise
   * that settles when a human somewhere else answers.
   */
  awaitClarification?: (context: {
    run: RunState;
    signal: AbortSignal;
  }) => Promise<ClarificationDecision>;
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

  // Same reasoning, and the same line to change if `createRun` ever takes more
  // than a task: a run that fails during planning should still record what it
  // was pointed at, because "it looked in the wrong place" is exactly the
  // diagnosis you want available for a run that produced nothing.
  if (deps.subjectPath !== undefined) run.subjectPath = deps.subjectPath;

  // Who is executing this, so a second process reconciling crashed runs can tell
  // a live run from an abandoned one instead of failing both. See
  // `RunState.ownerPid` for the incident that made this necessary.
  run.ownerPid = process.pid;

  /**
   * The Manager's turns are not assignments, so nothing in the dispatcher
   * records their token usage — or, until this fix, their event log. Intercept
   * both here: this is the only layer that sees both manager calls *and* holds
   * the store, so it is the natural place for either concern, and keeping them
   * together means one gate (`isManagerAssignmentId`) decides both.
   *
   * DEFECT FIXED: planning and synthesis stream `usage`/`text` events live
   * through `onEvent`, exactly like a real assignment's — but unlike a real
   * assignment, `dispatcher.ts` never persists them (it only calls
   * `store.appendEvent` for the assignments it dispatches). The aggregate
   * survived on `run.managerUsage`; the event-by-event record NFR-7 promises
   * ("replay a finished run from its saved event log") did not — replay read
   * `logs/*.jsonl` and got silence for the two turns that, on a small run,
   * outspend the entire team.
   *
   * `manager.ts` stays free of store knowledge on purpose: it only awaits
   * whatever `onEvent` hook it is given (see `runManagerTurn`'s comment), and
   * this closure is that hook. That keeps the store dependency in the one
   * layer that already has it, rather than teaching `manager.ts` — which is
   * about prompts and plan validation — what a `RunStore` is.
   *
   * `appendEvent` is awaited *before* usage accumulation and before forwarding
   * to `deps.onEvent`, matching `dispatcher.ts`'s own write-before-notify
   * ordering for real assignments (`setStatus`/the provider loop in
   * dispatcher.ts): a client can never observe a manager event over the
   * WebSocket before it is durable on disk.
   *
   * Logged under the event's own `assignmentId` — always one of the two
   * `MANAGER_*_ASSIGNMENT_ID` constants here, since that is what
   * `runManagerTurn` stamps on every event a manager turn emits. Two things
   * make that a safe log key rather than a landmine:
   *   - It lands in its own `logs/manager-plan.jsonl` / `logs/manager-
   *     synthesis.jsonl` file, never a real assignment's, because
   *     `materialiseAssignments` builds `run.assignments` entirely from the
   *     Manager's own plan and the plan is produced *after* planning's events
   *     already exist — so at the moment these ids are chosen, no assignment
   *     id exists to collide with them yet, and by convention (documented on
   *     the constants in manager.ts) real plans do not choose them either.
   *   - Even in the paranoid case where a plan *did* name an assignment
   *     `manager-plan`, the web client's replay fold (`useReplay.ts`'s
   *     `foldEvents`) explicitly skips any event whose `assignmentId` is not
   *     found in `base.assignments` rather than throwing — so the worst case
   *     is one assignment's replay under-rendering, never a crash.
   */
  const isManagerAssignmentId = (assignmentId: string): boolean =>
    assignmentId === MANAGER_PLAN_ASSIGNMENT_ID ||
    assignmentId === MANAGER_SYNTHESIS_ASSIGNMENT_ID ||
    // FR-M12's question turn is a Manager turn like the other two: real spend
    // (NFR-5) and real events (NFR-7). Omitting it here would have reproduced,
    // for the newest turn, exactly the defect this gate was written to fix —
    // a model call whose tokens are invisible to the cost display and whose
    // events replay as silence.
    assignmentId === MANAGER_CLARIFY_ASSIGNMENT_ID;

  // F4: manager-turn events are persisted here exactly as they arrive, with
  // no `agentName`/`phaseId` added. This is a deliberate omission, not an
  // oversight matching dispatcher.ts's — planning, synthesis and the FR-M12
  // clarification turn are Manager turns, not dispatched `AssignmentState`s
  // (see the long comment above `isManagerAssignmentId`), so there is no
  // agent and no phase to read off anything held here. `run` — the one piece
  // of context this closure has — has no field naming "the Manager" as an
  // agent, because the Manager is not one: it is not in the registry, has no
  // catalog entry, and is not a row `buildRoster` produces.
  //
  // The rejected alternative was inventing a synthetic value — `agentName:
  // 'manager'`, or similar — for these three events specifically. That was
  // rejected because `events.ts`'s `agentName` field documents its contract
  // as "denormalised from `AssignmentState.agentName`": every other value
  // that ever appears there names something in the registry a reader could
  // look up and brief. `'manager'` would be a string that LOOKS like an
  // agent name in every downstream consumer — replay, the inspect panel, a
  // future export — while resolving to nothing in `registry.byName`, which
  // is a worse failure mode than an absent field: absent reads honestly as
  // "unknown", where a fabricated name reads as a wrong answer presented
  // with the same confidence as a real one. The event's own `assignmentId`
  // (one of the `MANAGER_*_ASSIGNMENT_ID` constants) and its log filename
  // already say "this was a Manager turn" as plainly as `agentName` would,
  // without inventing a value that F4's own fix is trying to stop operators
  // from having to guess at.
  const onEvent = async (event: AgentEvent): Promise<void> => {
    if (isManagerAssignmentId(event.assignmentId)) {
      await deps.store.appendEvent(run.id, event.assignmentId, event);

      if (event.t === 'usage') {
        run.managerUsage = addUsage(run.managerUsage ?? EMPTY_USAGE, {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: event.cacheReadTokens }),
          ...(event.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: event.cacheWriteTokens }),
        });
      }
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

    // --- Clarification round (FR-M12) ---
    //
    // Inside `planning`, before the planning call, which is what the self-loop
    // in `RUN_TRANSITIONS` describes: the question turn is itself a model call
    // against the roster, so the run genuinely is planning while it asks.
    //
    // The whole block is skipped when the run did not ask for it, and `planRun`
    // below then receives no `clarification` at all — so an unclarified run
    // sends byte-for-byte the prompt it sent before this existed.
    let clarification: string | undefined;
    if (deps.awaitClarification !== undefined) {
      const asked = await askClarifyingQuestions({
        registry: deps.registry,
        provider: deps.provider,
        task: deps.task,
        signal,
        ...(deps.maxRepairAttempts === undefined
          ? {}
          : { maxRepairAttempts: deps.maxRepairAttempts }),
        onEvent,
        workspaceDir: await deps.store.workspaceDir(run.id),
        logger: log,
      });

      // No questions is the expected outcome for a clear task, and it must not
      // park: a run that stopped to show an empty form would make asking for the
      // round something users learn to avoid.
      if (asked.questions.length > 0) {
        // Stamped and persisted BEFORE anything is awaited, for the reason
        // `awaiting_approval` stamps the plan first: a client reconnecting to a
        // parked run has to be able to render the form, not an idle run with no
        // explanation.
        run.clarification = { questions: asked.questions };
        await setStatus('awaiting_clarification');
        log(`[${run.id}] awaiting clarification: ${asked.questions.length} question(s)`);

        const decision = await raceClarificationAgainstAbort(
          deps.awaitClarification,
          run,
          signal,
        );

        // Same defensive recheck as the team pause: a cancel landing in the tick
        // the answer settles could resolve a decision while `signal` is already
        // aborted, and FR-M9 says a cancelled run plans nothing further.
        if (decision === 'aborted' || signal.aborted) {
          await setStatus('cancelled');
          return { run };
        }

        run.clarification = {
          questions: asked.questions,
          ...(decision.answers === undefined ? {} : { answers: [...decision.answers] }),
          ...(decision.declined === undefined ? {} : { declined: decision.declined }),
        };

        clarification = buildClarificationBlock(asked.questions, decision);
        await setStatus('planning');
        log(
          `[${run.id}] clarified: ${
            decision.declined === true ? 'declined' : `${decision.answers?.length ?? 0} answer(s)`
          }`,
        );
      }
    }

    let plan = await planRun({
      registry: deps.registry,
      provider: deps.provider,
      task: deps.task,
      signal,
      ...(deps.maxRepairAttempts === undefined
        ? {}
        : { maxRepairAttempts: deps.maxRepairAttempts }),
      ...(deps.candidateLimit === undefined ? {} : { candidateLimit: deps.candidateLimit }),
      ...(clarification === undefined || clarification === '' ? {} : { clarification }),
      ...(deps.subjectPath === undefined ? {} : { subjectPath: deps.subjectPath }),
      onEvent,
      workspaceDir: await deps.store.workspaceDir(run.id),
    });

    run.plan = plan;
    run.assignments = materialiseAssignments(plan);
    log(
      `[${run.id}] plan: ${plan.phases.length} phase(s), ` +
        `${run.assignments.length} assignment(s), domain "${plan.domain}"`,
    );

    // --- Team review pause (FR-M11) ---
    //
    // `run.plan`/`run.assignments` are stamped and persisted (via the
    // `awaiting_approval` `setStatus` call below) BEFORE anything is
    // awaited, so a client that subscribes or reconnects while the run is
    // parked sees the proposed team, not an empty plan — that persisted
    // snapshot is the whole reason `awaiting_approval` exists as a status a
    // client can render against, per its doc comment in
    // `shared/src/status.ts`.
    if (deps.awaitTeamApproval !== undefined) {
      await setStatus('awaiting_approval');
      log(`[${run.id}] awaiting team approval`);

      const verdict = await raceApprovalAgainstAbort(deps.awaitTeamApproval, run, signal);

      // Checked defensively in addition to the sentinel `raceApprovalAgainstAbort`
      // returns: a cancel that lands in the same tick the approval promise
      // settles could resolve `verdict` with real operations while `signal`
      // is already aborted, and FR-M9 says a cancelled run dispatches
      // nothing — applying the edits and proceeding to `dispatching` here
      // would race a genuine cancellation against a genuine approval and let
      // approval sometimes win.
      if (verdict === 'aborted' || signal.aborted) {
        await setStatus('cancelled');
        return { run };
      }

      const knownAgentNames = new Set(deps.registry.byName.keys());
      const applied = applyTeamOperations(plan, verdict, knownAgentNames);
      if ('error' in applied) {
        // Failed cleanly rather than dispatching a half-edited plan: the
        // alternative — falling back to the Manager's original proposal and
        // silently ignoring a rejected edit — would dispatch work the user
        // never approved, which is the exact failure mode FR-M11 exists to
        // prevent.
        run.error = `team approval could not be applied: ${applied.error}`;
        await setStatus('failed');
        return { run };
      }

      plan = applied.plan;
      run.plan = plan;
      run.assignments = materialiseAssignments(plan);
      log(
        `[${run.id}] team approved: ${verdict.length} edit(s), ` +
          `${run.assignments.length} assignment(s) now`,
      );
    }

    await setStatus('dispatching');

    // --- Dispatch (FR-M4 through FR-M6) ---
    await setStatus('running');
    dispatchResult = await dispatchRun({
      run,
      registry: deps.registry,
      provider: deps.provider,
      // Forwarded, not merely accepted. This was declared and documented one
      // layer up and then dropped here, which made per-agent provider selection
      // inert for every real run: both the CLI and the HTTP supervisor reach the
      // dispatcher only through this function, and the tests that covered the
      // feature called `dispatchRun` directly, so nothing noticed.
      ...(deps.providerFor === undefined ? {} : { providerFor: deps.providerFor }),
      store: deps.store,
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
      // Forwarded for the same reason `providerFor` above carries that comment:
      // a field declared one layer up and dropped here is inert for every real
      // run, because both the CLI and the HTTP supervisor reach the dispatcher
      // only through this function.
      ...(deps.modelPolicy === undefined ? {} : { modelPolicy: deps.modelPolicy }),
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
      //
      // "Partial results preserved" used to be stated unconditionally, but
      // `enforceTokenBudget` can trip before a single assignment ever runs — the
      // Manager's own planning turn is charged against the budget, and a budget
      // set below what planning alone costs halts here with every assignment
      // still `pending` and nothing on disk. Reproduced live (`--budget 1`):
      // `reports/` was empty and all three assignments read
      // `"status":"pending","attempts":0`, while the run's own error claimed
      // reports had been preserved. A user who reads that claim, checks the
      // (empty) directory, and finds it false has no reason to trust the next
      // message this system prints either. `dispatchResult.completed` is the
      // dispatcher's own count of assignments that finished with a usable
      // report, so it is the honest source for which sentence applies here —
      // not a guess based on how far into the plan the halt landed.
      run.error =
        dispatchResult.completed > 0
          ? 'run token budget exhausted; partial reports preserved, synthesis skipped'
          : 'run token budget exhausted before any assignment produced a report; synthesis skipped';
      await setStatus('failed');
      // This mirrors the all-assignments-failed guard just below (the other way
      // a run ends `failed` without throwing): no `detail`, because there is no
      // thrown error to take a stack from — `enforceTokenBudget` sets a flag, it
      // does not throw — and the per-assignment records (for any that ran)
      // already carry their own detail. Before this, a whole class of run
      // failure wrote nothing to `runs/diagnostics.jsonl` at all: reproduced
      // live as run `20260820-024537-uv59`, which failed via this exact branch
      // and left zero records under its run id in the cross-run log whose
      // entire purpose is answering "what went wrong lately". The neighbouring
      // guard already fixed the same gap for its own path one failed-run reason
      // over; this closes it for this one.
      await deps.diagnostics?.record({
        kind: 'run-failed',
        runId: run.id,
        message: run.error,
        task: deps.task,
      });
      return { run, dispatch: dispatchResult };
    }

    // A DECLINED assignment produced a report too — one that says why the work is
    // missing. `collectReports` includes and flags them for exactly that reason,
    // so the test here has to be "did anything write a document", not "did
    // anything succeed".
    //
    // This was a regression introduced by adding `declined`: those assignments
    // used to be counted as `completed`, so a run of all declines synthesised. As
    // a separate bucket they made `completed === 0` true, and the run failed with
    // "no assignment produced a report" while the reports sat on disk — a message
    // that is not merely unhelpful but false, and a synthesis that `collectReports`
    // was already equipped to produce ("here is why nothing could be done") never
    // ran.
    //
    // Found by `error-detective` auditing this repository, in the run that first
    // exercised `declined` end to end. It reached the contradiction by reading
    // this line against `collectReports`'s own doc comment and noticing they
    // disagreed.
    //
    // WHY THIS GUARD LIVES HERE, and not further down: `collectReports` (below)
    // would return an empty array for exactly the case this checks, and nothing
    // downstream of that would notice — `synthesiseReport` synthesises fine from
    // zero inputs (it is a model call; it will happily narrate an empty list),
    // `produceDeliverable` renders whatever synthesis produced, and the run would
    // reach `done`, the strongest claim the state machine can make, for a run
    // that produced no agent work at all. Checking here, before `setStatus
    // ('synthesizing')` and before `collectReports` is even called, is what stops
    // the spend from happening rather than merely disclosing it after the fact:
    // a synthesis turn is a paid provider call, and the `designing` step behind
    // it launches headless Chromium to render a PDF of whatever synthesis wrote.
    // Both of those are real cost — money and a browser process — and both would
    // be spent summarising nothing if this lived after `collectReports` instead
    // of before it. Failing first is strictly cheaper than failing after paying.
    //
    // WHAT THIS GUARD DELIBERATELY DOES NOT DO: it does not fail a run where SOME
    // assignments produced a report and others failed or were skipped. The
    // condition is `completed === 0 && declined === 0` — one success anywhere in
    // the team, even one out of twenty, is enough to pass. That is intentional,
    // not an oversight: a run that got one real report out of a failed team still
    // produced a deliverable, and synthesis (with `collectReports`'s doc comment
    // above explaining how it is told what it has, not what it is missing) is the
    // place a documented shortfall belongs — not a `failed` status that would
    // discard the one piece of real work that did land. Widening this guard to
    // "any failure at all" would trade an honest partial deliverable for a false
    // negative on every run that wasn't perfect, which is the opposite failure
    // mode from the one this guard exists to close.
    if (dispatchResult.completed === 0 && dispatchResult.declined === 0) {
      run.error =
        `all ${run.assignments.length} assignment(s) failed or were skipped; ` +
        'no report was produced, so there is nothing to synthesise';
      await setStatus('failed');
      // This `return` leaves before the catch below, so without this call the
      // whole-team-failure path — one of the two ways a run can end `failed` —
      // wrote no run-level diagnostic at all. The dispatcher's per-assignment
      // records explain WHY each agent failed; they do not answer "which of my
      // runs failed", which is the question `run-failed` exists for, and a
      // filter on that kind would silently have skipped every run that failed
      // this way. No `detail`: there is no thrown error here to take a stack
      // from, and the per-assignment records already carry theirs.
      await deps.diagnostics?.record({
        kind: 'run-failed',
        runId: run.id,
        message: run.error,
        task: deps.task,
      });
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

    // Doc4: `report.md` used to be written as the raw model output and
    // nothing else. Its sibling export, `report.bundle.md`
    // (`buildMarkdownBundle` in `reports/markdownExport.ts`), opens with a
    // cover of facts — run id, generated date, domain, tokens, cost, team —
    // and the HTML/PDF cover does too, which made `report.md` the one
    // artifact that carried no way to identify the run that produced it once
    // it left the run directory: copied into an email, pasted into a wiki
    // page, or simply sitting in a Downloads folder next to five others.
    //
    // The header below is deliberately a small subset of the bundle's,
    // reusing its exact vocabulary (`Run ID`, `Generated`) rather than
    // inventing a second format for the same facts — see
    // `buildSynthesisReportHeader`'s own comment for which three facts were
    // chosen and why the rest of the bundle's cover was left out.
    const header = buildSynthesisReportHeader(run, reports);
    await deps.store.writeReport(run.id, SYNTHESIS_REPORT_PATH, `${header}\n\n---\n\n${report}`);
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
    // The other half of `produceDeliverable`'s own comment, which said the
    // reason was "recorded on the run so the UI can say why" while nothing
    // carried it here. Without this, a run whose Chromium launch failed is
    // indistinguishable — in `run.json`, over the wire, and in the UI — from one
    // that simply has not reached `designing` yet.
    if (deliverable.pdfError !== undefined) run.pdfError = deliverable.pdfError;

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

    // A run-level failure — a planning turn that exhausted its repair budget, a
    // provider that died before dispatch, a synthesis that threw. The dispatcher
    // records assignment failures, and by definition cannot record these: they
    // happen when there is no assignment to attach them to.
    //
    // This capture was MISSING while this file's own `diagnostics` doc comment
    // claimed it existed, and a real run found it: `--max-cost 0.30` was below
    // what the planning turn costs with a 156-agent roster, the CLI returned
    // `budget_exhausted`, the run failed, and the log — whose entire purpose is
    // to be the place you look afterwards — stayed empty.
    //
    // A cancellation is deliberately NOT logged: the user pressing Cancel is the
    // button working, and filing it beside real failures would make the log's
    // error count meaningless within a week.
    if (!signal.aborted) {
      // `run.error` stays one line, because it is rendered in the UI and
      // written to `run.json` as the run's own summary of what went wrong. The
      // stack and the cause chain go to `detail`, which the diagnostics schema
      // leaves untruncated to 8,000 characters for exactly this. That split is
      // the whole fix: the audit's finding here was not that the message was
      // wrong but that it was ALL there was — a bare string, with the error it
      // came from unrecoverable the moment this catch ran.
      const detail = errorDetail(error);
      await deps.diagnostics?.record({
        // Not `assignment-failed`: this comment's own first paragraph says the
        // dispatcher records those and "by definition cannot record these:
        // they happen when there is no assignment to attach them to". Filing a
        // run-level failure under the assignment kind made that true in prose
        // and false in the data, so a reader grouping by kind could not tell a
        // planning turn that died from an agent that did.
        kind: 'run-failed',
        runId: run.id,
        message: run.error,
        task: deps.task,
        ...(detail === undefined ? {} : { detail }),
      });
    }
    return { run, ...(dispatchResult === undefined ? {} : { dispatch: dispatchResult }) };
  }
}

/**
 * Wait for the user's team verdict (FR-M11), but never wait past a
 * cancellation (FR-M9).
 *
 * `awaitTeamApproval` is supplied by a caller this file does not control — in
 * production, the HTTP layer resolves it when a `POST .../team` request
 * lands; in tests, a hand-written stub. Nothing here assumes that caller
 * remembers to watch `signal` itself and settle promptly. Racing its promise
 * against the abort signal is the same defensive posture `dispatcher.ts`
 * already takes with its own `haltController`/`anySignal` machinery:
 * cancellation must keep working even against a dependency that does not
 * cooperate, not merely one that does — a run parked here "may sit
 * indefinitely" by design, so this is the one await in the whole file that
 * most needs an escape hatch that does not depend on the other side.
 *
 * Returns the literal string `'aborted'` rather than throwing, so the cancel
 * path in `executeRun` reads as an ordinary branch — `setStatus('cancelled')`
 * — instead of a caught exception standing in for something that is not
 * really exceptional: a user cancelling a run they are looking at is the
 * expected outcome of the Cancel button, not a failure.
 *
 * A genuine rejection from `awaitTeamApproval` (a bug in whatever supplied
 * it, not a cancellation) is deliberately left to propagate. Swallowing it
 * here would need a second error channel just for this one await, which is
 * exactly what `dispatcher.ts`'s per-assignment catch (see its comment on
 * "Defensive containment, not a substitute...") warns against inventing;
 * `executeRun`'s existing top-level try/catch already turns any such throw
 * into a clean run failure.
 */
/**
 * The FR-M12 twin of {@link raceApprovalAgainstAbort}, with the identical
 * contract: `'aborted'` rather than a throw for a cancellation, a genuine
 * rejection left to propagate, and no assumption that the supplier of
 * `awaitClarification` watches `signal` itself.
 *
 * Kept as a second function rather than a generic one over both. The two differ
 * only in the type they resolve, and a generic would save six lines at the cost
 * of making each site's own doc — which is where the reasoning lives — apply to
 * something else as well. The duplication is the readable half of that trade.
 */
function raceClarificationAgainstAbort(
  awaitClarification: NonNullable<ExecuteRunDeps['awaitClarification']>,
  run: RunState,
  signal: AbortSignal,
): Promise<ClarificationDecision | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');

  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });

    awaitClarification({ run, signal }).then(
      (decision) => {
        signal.removeEventListener('abort', onAbort);
        resolve(decision);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function raceApprovalAgainstAbort(
  awaitTeamApproval: NonNullable<ExecuteRunDeps['awaitTeamApproval']>,
  run: RunState,
  signal: AbortSignal,
): Promise<readonly TeamOperation[] | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');

  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });

    awaitTeamApproval({ run, signal }).then(
      (operations) => {
        signal.removeEventListener('abort', onAbort);
        resolve(operations);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Gather the reports of every assignment that produced one, in plan order.
 *
 * Failed and skipped assignments contribute nothing — the Manager is told what
 * it has, not what it is missing, because a synthesis prompt padded with absent
 * sections invites the model to invent their contents.
 *
 * `declined` is the exception, and it is not an inconsistency with that rule.
 * A declined assignment DID produce a document; it just says why the work is
 * missing rather than containing it. Passing it on, flagged, is the difference
 * between a synthesis that records a gap and one that quietly covers two
 * objectives out of three — which is the silence this status exists to end.
 */
async function collectReports(store: RunStore, run: RunState): Promise<AssignmentReport[]> {
  const reports: AssignmentReport[] = [];

  for (const assignment of run.assignments) {
    const produced = assignment.status === 'done' || assignment.status === 'declined';
    if (!produced || assignment.reportPath === undefined) continue;
    reports.push({
      assignmentId: assignment.id,
      agentName: assignment.agentName,
      objective: assignment.objective,
      markdown: await store.readReport(run.id, assignment.reportPath),
      ...(assignment.status === 'declined' ? { declined: true } : {}),
    });
  }

  return reports;
}

/**
 * `YYYY-MM-DD`, matching `reports/markdownExport.ts`'s own (unexported)
 * `formatDate` byte for byte, so the two headers agree on what "Generated"
 * looks like. Not imported from there: that module's scope in this fix is
 * read-only (it belongs to `report.bundle.md`, not `report.md`), and the
 * function is two lines behind no export — reimplementing it here is
 * cheaper and safer than widening that file's exports for one caller this
 * task is not allowed to touch.
 */
function formatRunDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Doc4: the header prepended to `report.md`, minimal and factual by design.
 *
 * Three facts, chosen to answer exactly "which run made this and who worked
 * on it" — the question `report.md` could not answer on its own once it left
 * the run directory (see the comment at this function's call site):
 *   - **Run ID** — the same label `buildMarkdownBundle`'s cover uses, so a
 *     reader who has seen one recognises the other.
 *   - **Generated** — the date this synthesis was written, in the bundle's
 *     own `YYYY-MM-DD` format (`formatRunDate` above). Not "when the run
 *     finished": at the point this is called the run is still mid-pipeline
 *     — `designing` and its PDF/HTML export are still ahead of it — so
 *     "finished" would overclaim. `buildMarkdownBundle`'s cover has the
 *     identical property (`doc.generatedAt` is stamped in `deliverable.ts`,
 *     which runs after this write) and uses "Generated" for exactly that
 *     reason; matching its vocabulary here is also matching its honesty.
 *   - **Agents** — the agents whose reports fed this synthesis, i.e. every
 *     `agentName` in `reports` (both `done` and `declined` — see
 *     `collectReports`'s own doc comment for why a declined assignment still
 *     counts as having contributed), deduplicated but otherwise in the plan
 *     order `collectReports` produced them in.
 *
 * Deliberately NOT the rest of the bundle's cover — no domain, no token
 * count, no cost, no full roster table. The task scope is explicit that
 * `report.md` is the synthesis, not the record: `report.bundle.md` already
 * is the record, sitting one call further down this same function, and a
 * second copy of the same six-line cover block in two files would be a
 * maintenance seam (two places to update if the cover facts ever change)
 * bought for a document whose entire job is to be readable as *just the
 * synthesis*, with only enough provenance to say where it came from.
 */
function buildSynthesisReportHeader(run: RunState, reports: readonly AssignmentReport[]): string {
  const agentNames = [...new Set(reports.map((r) => r.agentName))];

  return [
    `**Run ID:** ${run.id}`,
    `**Generated:** ${formatRunDate(Date.now())}`,
    `**Agents:** ${agentNames.length > 0 ? agentNames.join(', ') : '_none_'}`,
  ].join('\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
