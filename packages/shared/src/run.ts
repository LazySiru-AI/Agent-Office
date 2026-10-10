import { z } from 'zod';
import { RunPlanSchema } from './plan.js';
import { AssignmentStatusSchema, RunStatusSchema, isRunTerminal } from './status.js';

/**
 * Persisted run state (PLAN.md NFR-2).
 *
 * This is the shape written to `runs/<id>/run.json` after every transition, and
 * the shape the web client renders. It lives in `shared` for that second reason:
 * Phase 3's UI and Phase 4's office sim both read it, so it must not be a
 * server-private type.
 *
 * Everything here is plain JSON — no class instances, no Dates — so that a
 * reload is a `JSON.parse` plus a schema check and nothing more.
 */

export const UsageSchema = z.object({
  /**
   * Every input token the model processed, cached or not.
   *
   * This is a TOTAL, and the two counters below are a decomposition of it —
   * not additions to it. `inputTokens - cacheReadTokens - cacheWriteTokens` is
   * the fresh remainder. Keeping the total here rather than splitting it into
   * three peers is what makes the change back-compatible: a `run.json` written
   * before the counters existed still reports the same token figure and, with
   * both counters absent, still prices exactly as it did.
   */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * The part of `inputTokens` served from the prompt cache, priced at roughly
   * **0.1x** the fresh input rate.
   *
   * Optional, and the optionality is load-bearing rather than defensive: every
   * run recorded before this field existed parses without it, and absent has
   * to keep meaning "this adapter did not report a split" rather than "nothing
   * was cached" — the two are different claims and only the first is true of
   * an old log.
   */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /**
   * The part of `inputTokens` written INTO the cache, priced at roughly
   * **1.25x** the fresh input rate (the 5-minute TTL; a 1-hour TTL is 2x, and
   * nothing in this repo requests one — see `pricing.ts`).
   */
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});

export type Usage = z.infer<typeof UsageSchema>;

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/**
 * Add two usage figures.
 *
 * Exists because five separate places were summing usage by hand — the
 * dispatcher's per-assignment accumulator, the runner's Manager accumulator,
 * `totalUsage`, `runTotalUsage`, and replay's fold — each spelling out
 * `inputTokens + inputTokens, outputTokens + outputTokens`. That was fine
 * while `Usage` had exactly two fields and became a liability the moment it
 * had four: adding the cache counters to four of the five and missing the
 * fifth would silently zero them on one path, and the resulting cost error
 * would look like a pricing bug rather than a dropped field.
 *
 * **Absence is preserved.** When neither side reports a cache split the result
 * has neither key, so folding a log written before those counters existed
 * yields a `Usage` shaped exactly as it was then — and therefore priced
 * exactly as it was then (NFR-7). A single reported split is enough to make
 * the result carry one, because the alternative is discarding a number the
 * adapter actually measured.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const cacheRead = sumOptional(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWrite = sumOptional(a.cacheWriteTokens, b.cacheWriteTokens);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

/** `undefined` only when BOTH sides are absent — one reported counter survives. */
function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export const AssignmentStateSchema = z.object({
  id: z.string().min(1),
  /** Phase this assignment belongs to; phases execute in order. */
  phaseId: z.string().min(1),
  agentName: z.string().min(1),
  objective: z.string().min(1),
  deliverable: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),

  status: AssignmentStatusSchema,
  /** Dispatch attempts so far. Bounded by the reviewer send-back budget (FR-M10). */
  attempts: z.number().int().nonnegative(),
  usage: UsageSchema,

  /**
   * The model this assignment actually ran on, after `dispatcher.ts` applies
   * this deployment's model policy (`server/src/providers/modelPolicy.ts`) to
   * the agent's catalog `model:` word.
   *
   * Exists because the policy can raise what actually runs above what the
   * catalog says: 18 of the 156 vendored agents declare `haiku`, and the
   * default floor runs every one of them on `sonnet` instead. Before this
   * field, nothing recorded that substitution anywhere on the assignment, so
   * both cost sites (`packages/web/src/costModel.ts`,
   * `packages/server/src/reports/deliverable.ts`) priced every one of those
   * 18 as `haiku` forever — a real, silent understatement of spend, not a
   * rounding error.
   *
   * **Absence means "unknown, use the catalog word" — never "free" and never
   * "cheapest tier".** Two different situations both leave this absent, and
   * both must fall back the same way:
   *   - A `run.json` written before this field existed has no way to have
   *     recorded it. Pricing it off the catalog `model:` is exactly how it
   *     priced before this fix, and it must keep doing so — a run cannot
   *     retroactively acquire information about what it actually ran on.
   *   - `applyModelPolicy` itself returns `model: undefined` for the ~8
   *     catalog agents that declare no `model:` at all, deliberately (see its
   *     doc comment: inventing a tier for them would be the policy putting
   *     words in an author's mouth). Those assignments stay absent here too,
   *     and the catalog lookup they fall back to is ALSO undefined, so the
   *     net effect is unchanged from before this field existed.
   *
   * Set once, by `patchAssignment` alongside `usage` at the end of
   * `executeAssignment` — recorded even when the assignment goes on to fail,
   * because a failed assignment still spent real tokens on whatever it ran on
   * (NFR-5). Not part of the `status` event stream for the same reason
   * `usage` is not: it is derived dispatch bookkeeping, not a status
   * transition a live viewer needs to render.
   */
  model: z.string().min(1).optional(),

  /** Epoch ms. Absent until the assignment first leaves `pending`. */
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  /** Run-relative path, e.g. `reports/03-security-auditor.md`. Set on success. */
  reportPath: z.string().min(1).optional(),
  /** Failure reason, when status is `failed`. */
  error: z.string().optional(),
});

export type AssignmentState = z.infer<typeof AssignmentStateSchema>;

/**
 * One question the Manager wants answered before it plans (FR-M12).
 *
 * Lives here rather than in `wire.ts` because it is part of run state — the
 * questions are persisted on the run so a client reconnecting to a parked round
 * can render them — and `wire.ts` already imports this module, so defining it
 * there would make the dependency circular.
 *
 * `id` is the Manager's own handle for the question and is what an answer is
 * keyed by. Matching on question *text* would break the moment a model reworded
 * anything; matching on array position would silently misattribute an answer if
 * the list were ever reordered between the push and the post.
 *
 * `suggestion` exists because the most useful clarifying question is often one
 * the model can already guess the answer to ("which jurisdiction? — Ireland,
 * from the task"). Offering it turns a text box into a confirmation, which is
 * the difference between a round the user answers and one they skip.
 */
export const ClarifyingQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  /**
   * Short by construction. A question needing a paragraph to ask is usually
   * several questions, and the cap is what stops a model spending its one round
   * on a sprawling prompt nobody reads to the end.
   */
  question: z.string().min(1).max(500),
  /** Why the answer changes the plan. Shown beneath the question. */
  why: z.string().max(500).optional(),
  suggestion: z.string().max(500).optional(),
});

export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>;

export const RunStateSchema = z.object({
  id: z.string().min(1),
  /** The user's original task text, verbatim. */
  task: z.string().min(1),
  /**
   * Absolute path to the thing the task is ABOUT — a repository, a project
   * directory, a folder of documents.
   *
   * Optional, and absent means what every run before it meant: the subject is
   * wherever the task text says it is, if it says at all.
   *
   * It exists because "if it says at all" turned out to be a coin flip. In one
   * UAT run of five assignments against a dashboard living one directory above
   * this checkout, three specialists found it by walking up the tree and two
   * concluded the application did not exist and filed blockers — same task text,
   * same brief, opposite answers, and the two that failed produced nothing. An
   * agent's working directory is an empty scratch dir inside THIS application's
   * checkout (AO-8), so an agent reasoning from where it is standing learns
   * something false about what it was asked to examine.
   *
   * Stated as a path rather than seeded as a copy — the alternative the agents
   * themselves proposed — because copying a repository per assignment per
   * attempt costs disk and time proportional to the subject, silently diverges
   * from the original the moment anything writes to it, and answers a question
   * ("where is it") with a duplicate. NFR-1 containment is unaffected either
   * way: this is a place to READ, and every write an agent makes still lands in
   * its own workspace.
   */
  subjectPath: z.string().min(1).optional(),
  status: RunStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),

  /**
   * The provider that executed this run, e.g. `scripted` or `claude-code`.
   *
   * Recorded because cost (NFR-5) cannot be derived from the agents alone: an
   * agent's catalog `model:` says what it *would* cost through a real provider,
   * not what this run actually spent. Without this field a `scripted` run —
   * which calls no model at all — prices itself off `sonnet` and reports money
   * that was never spent.
   *
   * Optional so that `run.json` files written before this field existed still
   * load; a run without it prices off the catalog model as before.
   */
  provider: z.string().min(1).optional(),

  /** Absent until planning succeeds. */
  plan: RunPlanSchema.optional(),
  /** Flattened across phases, in execution order. Empty before planning. */
  assignments: z.array(AssignmentStateSchema),

  /**
   * Tokens spent by the Manager's own turns — planning, repair retries and
   * synthesis — which are not assignments and so appear nowhere in
   * `assignments[].usage`.
   *
   * They are real spend, and on a small run they exceed the agents' combined
   * usage, so a cost display built on `totalUsage` alone understates the run
   * badly (NFR-5). Kept separate rather than folded into the assignment totals
   * because the dispatcher's token budget (FR-M8) is scoped to dispatch.
   */
  managerUsage: UsageSchema.optional(),

  /**
   * FR-M12: the Manager's questions, and what the user said back.
   *
   * On the run rather than only in the event log because the questions are what
   * a client reconnecting to a parked run needs to render — the same reason
   * `plan` is stamped before `awaiting_approval` is persisted. A user who
   * refreshes the page mid-round must get the form back, not an idle run with no
   * explanation.
   *
   * Both halves are kept after the round closes rather than cleared. The answers
   * are an input to the plan, so a reader asking "why did it choose this team"
   * needs them as much as they need the plan itself, and a replayed run that
   * dropped them would reconstruct a plan whose inputs are invisible (NFR-7).
   */
  clarification: z
    .object({
      questions: z.array(ClarifyingQuestionSchema).max(5),
      /** Keyed by question id. Absent until the user answers. */
      answers: z.array(z.object({ questionId: z.string(), answer: z.string() })).max(5).optional(),
      /**
       * True when the user chose to plan without answering. Distinct from
       * `answers: []`, which would say the user answered nothing — see
       * `ClarificationDecisionSchema` for why the difference matters in a prompt.
       */
      declined: z.boolean().optional(),
    })
    .optional(),

  /** Run-relative path to the Manager's synthesis, once written. */
  reportPath: z.string().min(1).optional(),
  /** Run-relative path to the exported PDF (Phase 5). */
  pdfPath: z.string().min(1).optional(),
  /**
   * The theme the designer step chose, and why (FR-P2).
   *
   * Persisted rather than recomputed because the choice is a model's, and a
   * regenerated PDF that silently changed appearance would be indistinguishable
   * from a styling bug. Kept as a plain string here so `run.ts` does not depend
   * on `report.ts`; it is validated against the closed theme set at the point
   * the designer produces it.
   */
  theme: z.string().min(1).optional(),
  designRationale: z.string().optional(),
  /**
   * Why this run has no `pdfPath`, when the render was attempted and failed.
   *
   * A run whose PDF render fails still reaches `done` — the reports are on disk
   * and the attachment is the only thing missing (NFR-8), which is the right
   * call and the reason this is not a run-level failure. But "the PDF is
   * missing" and "the PDF was never attempted because the run is still working"
   * look identical to a reader without this field, and only one of them is worth
   * acting on.
   *
   * `produceDeliverable` has recorded this since it was written, with a comment
   * promising it was "shown to the user" — and nothing carried it out of that
   * function. An audit of this repository found the field written and never
   * read, anywhere. This is the missing half rather than a new feature.
   */
  pdfError: z.string().optional(),
  /**
   * OS process id of whatever is executing this run.
   *
   * Written when the run starts and never cleared. It exists for exactly one
   * question, asked by `RunSupervisor.reconcileCrashedRuns` at startup: is this
   * non-terminal run abandoned, or is something still working on it?
   *
   * That reconciliation used to assume it was the only process on the machine,
   * and marked every non-terminal run `failed`. It is not the only process. A
   * UAT agent asked to exercise the app started a second server against the same
   * `runs/` root, and the sweep killed four live assignments belonging to a CLI
   * run in another process — reported to their own client as "the server process
   * restarted while this run was in progress", which was true of a server nobody
   * had restarted and false about the run.
   *
   * A pid is enough here because this is a single-user, loopback application
   * (NFR-6): every process that touches a given `runs/` root is on this machine,
   * so `process.kill(pid, 0)` answers the question directly. Absent — every run
   * written before this field existed — means "unknown", and unknown reconciles
   * exactly as it did before.
   */
  ownerPid: z.number().int().positive().optional(),
  /** Failure reason, when status is `failed`. */
  error: z.string().optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

/**
 * Everything the run actually spent: assignments plus the Manager's own turns.
 *
 * This is the number to show a user (NFR-5), and it is also what
 * `dispatcher.ts`'s `enforceTokenBudget` checks FR-M8's per-run token budget
 * against. It was not always the latter: the budget used to be checked with
 * {@link totalUsage} alone, on the reasoning that "the dispatcher's budget is
 * about dispatch". That reasoning was itself the bug, not a justification for
 * one — FR-M8 says "per-run token budget", and a user who sets a limit means
 * the whole run, not the slice of it the dispatcher happens to own. Measured
 * before the fix: `runTokenBudget: 400`, 225 tokens of assignment spend, 420
 * tokens of Manager spend — 645 true total, 61% over — and the run never
 * halted, because 225 alone never crossed 400.
 *
 * The two components are not equally reachable by a dispatch-time check,
 * which matters for what this guarantees. Manager *planning* spend is banked
 * into `run.managerUsage` before dispatch begins, so it counts from the very
 * first budget check `enforceTokenBudget` makes — an oversized planning turn
 * alone can now halt a run before a single assignment is dispatched. Manager
 * *synthesis* spend, by contrast, happens after dispatch has already finished
 * and returned, so no check made during dispatch — this one included — can
 * ever pre-empt it. A run can therefore still finish having spent more than
 * its budget once synthesis is counted; that is an inherent limit of checking
 * the budget during dispatch, not a gap this function could close.
 */
export function runTotalUsage(run: RunState): Usage {
  return addUsage(totalUsage(run), run.managerUsage ?? EMPTY_USAGE);
}

/**
 * Sum of every assignment's usage, excluding the Manager's own planning and
 * synthesis turns.
 *
 * No longer what FR-M8's dispatch budget is checked against — see
 * {@link runTotalUsage}'s doc comment for why that changed. Kept as its own
 * function because some callers legitimately want the assignments-only
 * figure (e.g. a per-assignment cost breakdown, or a test asserting the two
 * totals actually differ), not because dispatch still scopes to it.
 */
export function totalUsage(run: RunState): Usage {
  return run.assignments.reduce<Usage>(
    (acc, assignment) => addUsage(acc, assignment.usage),
    { ...EMPTY_USAGE },
  );
}

export function findAssignment(run: RunState, assignmentId: string): AssignmentState | undefined {
  return run.assignments.find((a) => a.id === assignmentId);
}

/** Assignments belonging to one phase, in plan order. */
export function assignmentsInPhase(run: RunState, phaseId: string): AssignmentState[] {
  return run.assignments.filter((a) => a.phaseId === phaseId);
}

/**
 * Whether every dependency of `assignment` has completed successfully.
 *
 * A dependency that failed or was skipped is NOT satisfied — dependents must be
 * skipped rather than run against a missing report (FR-M5 gives each assignment
 * the reports of its `dependsOn`, so a missing one would silently degrade the
 * brief).
 */
export function dependenciesSatisfied(run: RunState, assignment: AssignmentState): boolean {
  return assignment.dependsOn.every((depId) => findAssignment(run, depId)?.status === 'done');
}

/** True when a dependency has failed or been skipped, so this one cannot run. */
export function dependenciesUnreachable(run: RunState, assignment: AssignmentState): boolean {
  return assignment.dependsOn.some((depId) => {
    const status = findAssignment(run, depId)?.status;
    return status === 'failed' || status === 'skipped' || status === undefined;
  });
}

export function isRunFinished(run: RunState): boolean {
  return isRunTerminal(run.status);
}
