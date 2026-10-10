import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  EMPTY_USAGE,
  addUsage,
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
  type Usage,
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import type { AgentProvider } from '../providers/types.js';
import type { RunStore } from '../store/types.js';
import { classifyProviderWarning, type DiagnosticsSink } from '../diagnostics/log.js';
import { applyModelPolicy, type ModelPolicy } from '../providers/modelPolicy.js';
import { buildAssignmentBrief, type UpstreamReport } from './brief.js';
import { parseAgentNotes } from './notes.js';
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
 *
 * AO-8: the sandbox each assignment's provider call runs against is likewise
 * per-assignment, not per-run. Every assignment in a parallel phase used to be
 * handed the SAME workspace directory, which meant FR-M5's careful briefing
 * boundary — an agent sees only its own objective and its declared
 * dependencies' reports — was only one of two channels between concurrent
 * assignments, the other being an ordinary shared folder neither logged nor
 * declared in the plan. `resolveWorkspaceDir` below, and
 * `FileRunStore.assignmentWorkspaceDir` in `store/fileStore.ts`, are the fix;
 * see the doc comments on both for the isolation, re-dispatch and cleanup
 * decisions involved.
 */

export interface DispatchOptions {
  /** Simultaneous assignments within one parallel phase (FR-M4). */
  maxConcurrency: number;
  /** Wall-clock budget per assignment before it is aborted (FR-M8). */
  assignmentTimeoutMs: number;
  /** Total tokens across the run; exceeding it stops dispatch (FR-M8, NFR-5). */
  runTokenBudget?: number;
}

/**
 * 20 minutes, raised from 10 after a real assignment hit the old ceiling doing
 * legitimate work.
 *
 * `code-reviewer` auditing this repository's 101-source-file server package timed
 * out at exactly 600,000ms in run `20260814-221223-ckji`, taking a dependent
 * assignment down with it. The two runs before it had failed on `--max-cost`
 * instead; raising that moved the wall into wall-clock, which is the sign that
 * neither limit was measuring the task and both were measuring the default.
 *
 * The two bounds are not interchangeable, and that is the argument for moving
 * this one rather than leaving it. `--max-cost` is the SPEND bound and it is
 * enforced per invocation by the CLI itself. This is a LIVENESS bound: it exists
 * so a hung provider cannot hold a run open indefinitely (FR-M8), not to control
 * money. With spend capped separately, a longer wall-clock buys a slow-but-honest
 * assignment room to finish and costs only a later detection of a genuine hang —
 * and a hang detected at 20 minutes instead of 10 is still detected.
 *
 * Not raised further, because the failure mode at the other end is a run that
 * looks alive for most of an hour while nothing is happening. `--timeout` on
 * `npm run run` remains for anyone who has measured their own task shape and
 * wants a different number, which is the honest place for a value this
 * task-dependent.
 */
export const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 20 * 60 * 1000;

export const DEFAULT_DISPATCH_OPTIONS: DispatchOptions = {
  maxConcurrency: 3,
  assignmentTimeoutMs: DEFAULT_ASSIGNMENT_TIMEOUT_MS,
};

/**
 * AO-8: the narrow extension point a {@link RunStore} may implement for
 * per-assignment workspace isolation.
 *
 * `FileRunStore.assignmentWorkspaceDir` (`store/fileStore.ts`) is the real
 * implementation; this interface is declared here, in the dispatcher, rather
 * than added to `RunStore` itself in `store/types.ts`. That is not a style
 * preference — it is what keeps this fix inside the two files it actually
 * needed to touch. Widening the shared `RunStore` interface would have
 * obligated every implementation of it, including `MemoryRunStore`, which is
 * an intentionally virtual, no-disk store used to test everything about
 * dispatch that is NOT filesystem isolation (concurrency caps, cancellation,
 * token budgets, the review loop) cheaply and deterministically. Giving it a
 * real `assignmentWorkspaceDir` would mean either making it do real `mkdir`
 * calls against a directory nobody asked it to create (defeating the point of
 * an in-memory store, and doing it on a machine-dependent default path no
 * test controls) or making it a documented no-op that fails to isolate
 * anything — silently reintroducing the exact bug this fix closes, for every
 * test that happens to use it.
 *
 * Duck-typing this instead costs nothing at either end: a store that does not
 * implement it (today, only `MemoryRunStore`) is simply not asked to, and
 * `resolveWorkspaceDir` below falls back to the pre-AO-8 `workspaceDir(runId)`
 * for it — correct, because a store with nothing on real disk has nothing for
 * two assignments to actually collide over in the first place. A store that
 * does implement it — `FileRunStore`, and any future one that manages real
 * files — gets genuine per-assignment, per-attempt isolation without either
 * store needing to know the other exists.
 */
interface AssignmentWorkspaceStore {
  assignmentWorkspaceDir(runId: string, assignmentId: string, attempt: number): Promise<string>;
}

function hasPerAssignmentWorkspaces(
  store: RunStore,
): store is RunStore & AssignmentWorkspaceStore {
  return (
    typeof (store as Partial<AssignmentWorkspaceStore>).assignmentWorkspaceDir === 'function'
  );
}

/**
 * Resolve the directory a provider's tools may read and write for one
 * assignment's current attempt (AO-8, NFR-1).
 *
 * Called from inside `executeAssignment`, after that function's opening
 * `setStatus(..., 'briefing', { attempts: assignment.attempts + 1 })` has
 * already run — `assignment.attempts` at the point this is called is
 * therefore THIS dispatch's own attempt number (1 for the original dispatch,
 * 2 for the one revision FR-M10 grants), not the count before it. Using it
 * directly, rather than re-deriving "+1" here, is what keeps this function
 * and `review.ts`'s `decideRevision` reading the same number the same way —
 * see the comment on `decideRevision` for the off-by-one this exact field has
 * to avoid.
 */
async function resolveWorkspaceDir(ctx: DispatchContext, assignment: AssignmentState): Promise<string> {
  if (hasPerAssignmentWorkspaces(ctx.store)) {
    return ctx.store.assignmentWorkspaceDir(ctx.run.id, assignment.id, assignment.attempts);
  }
  return ctx.store.workspaceDir(ctx.run.id);
}

/**
 * The report an assignment *wrote*, when it wrote one at the deliverable path.
 *
 * FR-M6 says an assignment must produce a markdown report at
 * `reports/NN-<agent>.md`, and `buildAssignmentBrief` tells the agent that path.
 * Until this function existed, the report persisted was the agent's accumulated
 * assistant **text** and nothing else — so an agent that satisfied the brief the
 * most literal way available to it, by using its `Write` tool on exactly the
 * named path, had its work discarded and a sentence about the work kept.
 *
 * That is not hypothetical. Phase 13's first live-model matrix produced it on
 * the tax run: `tax-advisor` wrote 24,566 bytes of analysis to
 * `workspace/irish-tax-treatment/attempt-1/reports/01-tax-advisor.md`, and the
 * deliverable recorded 735 bytes reading "Report written to
 * `reports/01-tax-advisor.md`. It covers the 12.5%/25% rate split…". Three
 * downstream assignments depended on it and were briefed on the sentence.
 * FR-M6's own guard passed, because narration is not an empty string, so the run
 * reported four done and no failures.
 *
 * Six phases and 1,765 tests never caught it because the two paths coincide for
 * every provider that cannot write files: the scripted provider's canned output
 * *is* its text. Whether this fires depends on a live model choosing a tool over
 * an answer, which is why it took a real one to surface.
 *
 * **The written file wins when it exists.** Both can be non-empty — an agent may
 * write the file and then summarise it — and in that case the file is the
 * deliberate artifact: the agent named that exact path, which is a stronger
 * statement of intent than prose that happens to be in the reply. The summary is
 * not lost; it stays in the event log and the transcript.
 *
 * ## Containment
 *
 * `deliverable` comes from the Manager and is untrusted (the same reason
 * `store.writeReport` re-checks it), and the workspace is a directory an agent
 * has just been writing to — so a component of the path may be a symlink that
 * did not exist when the assignment started. Resolution is therefore done with
 * `realpath` on both sides and the containment check applied to the *resolved*
 * target, which covers every component rather than just the last one. A path
 * that escapes is treated as "no file written" rather than an error: the agent
 * still produced text, and failing the assignment over a symlink would discard a
 * usable report to punish something the report's author may not have done.
 *
 * Following an escaping link would matter most for the raw-API providers, whose
 * `apiTools.ts` sandbox exists precisely to stop an assignment reading outside
 * its workspace — reading one here, after the fact, would walk around that.
 */
async function readWrittenDeliverable(
  workspaceDir: string,
  deliverable: string,
): Promise<string | undefined> {
  try {
    const root = await fsp.realpath(workspaceDir);
    const target = await fsp.realpath(path.resolve(root, deliverable));

    const relative = path.relative(root, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }

    const stat = await fsp.stat(target);
    if (!stat.isFile()) return undefined;

    const written = (await fsp.readFile(target, 'utf8')).trim();
    return written === '' ? undefined : written;
  } catch {
    // Missing is the overwhelmingly common case — most agents answer rather
    // than write — and is not worth distinguishing from unreadable here: both
    // mean "there is no written report to prefer", and the text path handles it.
    return undefined;
  }
}

/**
 * The report an agent wrote SOMEWHERE ELSE in its workspace.
 *
 * `readWrittenDeliverable` above finds the exact declared path, which is what
 * most file-writing agents produce. This is the fallback for the ones that
 * write a report under a name of their own choosing — and it exists because
 * one did, expensively:
 *
 * `sre-engineer`, in a UAT of this application, spent a full assignment
 * measuring a live deployment and wrote 15,211 bytes of findings to
 * `report.md` in its working directory. Its declared deliverable was
 * `reports/06-sre-engineer.md`, so nothing looked at `report.md`, and capture
 * fell back to the reply text — which was 601 bytes of narration ending "Report
 * complete at reports/06-sre-engineer.md". The assignment was recorded `done`.
 * Ten findings, every one of them reproduced live, were dropped from the
 * deliverable, the synthesis and the PDF, and the run reported success.
 *
 * ## Why recover rather than only instruct
 *
 * The brief now states the deliverable path more plainly, and that helps. It
 * cannot be the whole answer: the agent is a language model, the instruction is
 * one line among many, and the cost of it going wrong is a silently empty
 * report that still reports success. Recovery makes the failure survivable
 * instead of merely less likely.
 *
 * ## What it will and will not take
 *
 * Only markdown, only inside the assignment's own workspace, only when the
 * declared path produced nothing, and never silently — the caller records a
 * diagnostic naming the file it used. Preference order is deliberate: a file
 * whose NAME matches the deliverable's (written to the right name in the wrong
 * place), then `report.md` at the workspace root (the name agents actually
 * reach for), then the largest markdown file, on the theory that a report is
 * bigger than a scratch note. A tie or a wrong guess costs a diagnostic saying
 * exactly which file was used, which is recoverable; the alternative is 601
 * bytes of narration and no way to know anything was lost.
 */
async function recoverWrittenReport(
  workspaceDir: string,
  deliverable: string,
): Promise<{ text: string; from: string } | undefined> {
  let root: string;
  try {
    root = await fsp.realpath(workspaceDir);
  } catch {
    return undefined;
  }

  const wanted = path.basename(deliverable).toLowerCase();
  const candidates: Array<{ file: string; size: number; rank: number }> = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    // Depth-bounded because a workspace can contain anything an agent chose to
    // create — one in the same UAT unpacked a whole scratch `runs/` tree — and
    // this runs on the completion path of every assignment.
    if (depth > 3 || candidates.length > 200) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        continue;
      }
      if (size === 0) continue;
      const name = entry.name.toLowerCase();
      const rank = name === wanted ? 0 : name === 'report.md' && dir === root ? 1 : 2;
      candidates.push({ file: full, size, rank });
    }
  };

  await walk(root, 0);
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.size - a.size));
  const best = candidates[0];
  if (best === undefined) return undefined;

  try {
    const text = (await fsp.readFile(best.file, 'utf8')).trim();
    if (text === '') return undefined;
    return { text, from: path.relative(root, best.file).split(path.sep).join('/') };
  } catch {
    return undefined;
  }
}

/**
 * Doc1: split a markdown ATX heading onto its own line when an agent's
 * narration runs straight into it with no line break.
 *
 * Reproduced today at `runs/20260819-194636-kocc/reports/02-cli-developer.md`:
 * the captured report's first line is `...verify behavior.# CLI Ergonomics
 * Report — Agent Office`, because the reply-text path (`text.trim()`) keeps
 * whatever the model actually emitted, and a model that writes a sentence of
 * preamble and then starts its markdown without a newline produces exactly
 * that — a `#` heading fused to the end of a sentence, on one line. A `#`
 * that does not start its own line is not a heading to any markdown renderer;
 * it is a literal hash character in the middle of a paragraph, so the report
 * silently loses its title.
 *
 * ## The rule, and why it is this narrow
 *
 * Insert a blank line immediately before an ATX heading marker (`#` through
 * `######`, followed by whitespace) whenever it is glued directly onto the
 * preceding character with NO whitespace at all between them — the exact
 * shape of the reproduction above (`behavior.#` — period then hash, nothing
 * between). That is deliberately the whole rule. Two things it does NOT
 * attempt, on purpose:
 *
 *   - **A heading preceded by a space, mid-line, is left alone.** `"see the
 *     # notes below"` is genuinely ambiguous — it could be a stray hash a
 *     model produced in prose, or content someone wanted read literally — and
 *     nothing about this function's job (fixing a STRUCTURAL problem: a
 *     heading that cannot render as one) requires guessing at that. Only the
 *     zero-whitespace case is unambiguous: no legitimate use of `#` in prose
 *     is spelled with no space or punctuation-then-space before it AND a
 *     space after it in heading position.
 *   - **This does not attempt to strip or relocate the preamble itself.**
 *     The brief in this task is explicit that deciding what counts as
 *     "preamble" is a judgement this code cannot make safely — a sentence
 *     before a heading might be load-bearing context, not throat-clearing.
 *     The fix makes the heading a heading; the sentence in front of it stays
 *     exactly where the agent put it, on its own line above.
 *
 * ## What it will not touch, and why that is the safe failure
 *
 * Fenced code blocks (` ``` `/`~~~`) are tracked and skipped entirely — a
 * code sample that happens to contain a glued `#` (a shell comment, a C
 * preprocessor directive typo, anything) must be reproduced verbatim, not
 * "corrected" by a heuristic that has no idea it is looking at code. Getting
 * this wrong inside a fence would be exactly the "mangling a legitimate
 * report" outcome the task warns is worse than the one ugly line being fixed.
 * A heading glued with a SPACE before it, a Setext heading (`===`/`---`
 * underlines), or a `#` with no trailing whitespace (`#tag`, a URL fragment
 * like `page.html#section`) are left untouched for the same reason: none of
 * them is the unambiguous case this function knows how to fix without risking
 * a well-formed report.
 */
export function normaliseGluedHeading(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    // Fenced code blocks toggle on any line whose first non-space characters
    // are ``` or ~~~ (CommonMark allows indentation up to 3 spaces before the
    // fence marker). Everything between an opening and closing fence is
    // reproduced untouched, including a line that itself looks like a fence
    // toggle inside — which is exactly right, because that is how fences work.
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Look for a heading marker glued to a non-whitespace character earlier
    // in the same line. `[^\s#]` as the preceding character (rather than just
    // "not whitespace") also refuses to split a line like `## Subheading`
    // where the outer hashes are the marker itself, not glued prose — that
    // line has no non-`#` character immediately before its hashes, so it
    // cannot match at all and is correctly left alone.
    const match = /[^\s#](#{1,6})(?=[ \t])/.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }

    const splitAt = match.index + 1; // keep the glued character, split before '#'
    out.push(line.slice(0, splitAt));
    out.push(''); // blank line, so the heading is unambiguously its own block
    out.push(line.slice(splitAt));
  }

  return out.join('\n');
}

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
  /** Cross-run diagnostics (`diagnostics/log.ts`). Absent logs nothing. */
  diagnostics?: DiagnosticsSink;
  /**
   * Floor and ceiling on the model tier an agent may run on
   * (`providers/modelPolicy.ts`). Absent uses the default range — `sonnet`
   * through `opus`, which excludes `haiku`.
   *
   * Injectable so a test can state the range it is testing instead of depending
   * on the deployment default, and so an operator's `AGENT_OFFICE_MIN_MODEL`
   * override has somewhere to arrive.
   */
  modelPolicy?: ModelPolicy;
}

/** Why dispatch stopped. Distinguishes "all done" from "gave up". */
export interface DispatchResult {
  run: RunState;
  completed: number;
  failed: number;
  skipped: number;
  /**
   * Assignments stopped mid-flight by FR-M9 cancellation.
   *
   * Its own bucket rather than folded into `failed`, which is where these used
   * to land back when `cancelled` was not an assignment status: the four
   * counters are supposed to partition the assignment list, and a status with
   * no bucket is one that quietly stops being counted anywhere.
   */
  cancelled: number;
  /**
   * Assignments whose agent reported it could not produce the work.
   *
   * Its own bucket for the reason stated on `cancelled` above — the counters
   * partition the assignment list, and a status with no bucket quietly stops
   * being counted. This one exists because a run reported `3 done, 0 failed`
   * while a third of it had declined.
   */
  declined: number;
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
  /** See `DispatchDeps.modelPolicy`. Undefined means the module default. */
  modelPolicy: ModelPolicy | undefined;
  registry: Registry;
  provider: AgentProvider;
  providerFor: ((agentName: string) => AgentProvider | undefined) | undefined;
  store: RunStore;
  signal: AbortSignal;
  options: DispatchOptions;
  onEvent: ((event: AgentEvent) => void) | undefined;
  onStateChange: ((run: RunState) => void) | undefined;
  /**
   * The cross-run diagnostics log, when one is configured.
   *
   * Optional so every existing caller — the CLI, and every test that constructs
   * a dispatch directly — keeps working untouched and simply logs nothing. An
   * observability channel that made itself mandatory would be one more thing to
   * stub in forty tests that do not care about it.
   */
  diagnostics: DiagnosticsSink | undefined;
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
    diagnostics: deps.diagnostics,
    modelPolicy: deps.modelPolicy,
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
        const message = `assignment "${assignment.id}" errored outside normal failure handling: ${describe(error)}`;
        ctx.onEvent?.({
          t: 'error',
          assignmentId: assignment.id,
          message,
          fatal: false,
        });

        // Containing the throw was only ever half the fix. Broadcasting it
        // and stopping there — which is what this branch used to do — traded
        // "the whole run dies" for a quieter version of the exact defect this
        // file already fixed once, on the FR-M9 cancellation path (see the
        // long comment in `executeAssignment` at the `ctx.signal.aborted`
        // check above, describing an agent left "still typing, indefinitely,
        // for a run that was long over"). The shape repeats exactly:
        //
        //   1. Nothing durable is written. `runner.ts`'s `onEvent` only
        //      persists an event via `store.appendEvent` when
        //      `isManagerAssignmentId` is true; a real assignment's `error`
        //      event above reaches only the live broadcast and `diagnostics`
        //      is never touched, so there is no `diagnostics.jsonl` record and
        //      no store record of what happened.
        //   2. The assignment stays non-terminal. The tally a few lines below
        //      buckets only `done | failed | skipped | cancelled | declined`;
        //      whatever status `assignment` was in when `executeAssignment`
        //      threw (`pending | briefing | working | blocked | reporting`)
        //      counts in none of them.
        //   3. The run still reports `done`. `runner.ts` only fails the run
        //      when `completed === 0 && declined === 0`, so if any other
        //      assignment in this run succeeded, the run walks all the way to
        //      `done` with an assignment frozen mid-flight — rendered exactly
        //      like the cancellation defect: an agent shown "still working",
        //      forever, on a finished run.
        //
        // The triggers are as ordinary as the cancellation defect's was too:
        // `setStatus` throwing on an illegal transition (see its check below,
        // "illegal transition for..."), or `persist`/`store.saveRun` or
        // `patchAssignment` throwing on a store write failure. This backstop
        // was added, after that fix, specifically to stop one assignment's
        // throw from failing the whole run — and in doing so it reopened the
        // identical defect for a different trigger, on a status the
        // cancellation fix never reaches.
        //
        // The fix is the same shape: force a terminal status and make it
        // durable. `failAssignment` is reused rather than duplicated — it is
        // already the one function every OTHER per-assignment failure in this
        // file goes through (see its own doc comment), which is what makes it
        // usable here unchanged: it calls `setStatus(..., 'failed', ...)` and
        // then records an `assignment-failed` diagnostic through
        // `ctx.diagnostics` when one is configured, which is exactly "record
        // the error the same way an ordinary failure does" and exactly the
        // durable record `diagnostics.jsonl` was missing above.
        try {
          await failAssignment(ctx, assignment.id, message);
        } catch (recoveryError) {
          // `setStatus` throwing is one of the two ways control arrives in
          // THIS catch block in the first place — so calling it again via
          // `failAssignment` can throw a second time, and that second throw
          // must not be allowed to do what the first one used to: escape this
          // `Promise.all` and fail the whole run. Concretely, this fires when
          // the assignment had already reached a terminal status before the
          // stray throw (e.g. a throw inside `applyReviewVerdict`, called
          // after the reviewer's own `setStatus(..., 'done', ...)` already
          // succeeded) — `canTransitionAssignment` seals every terminal
          // status against a further `-> failed` edge, so `failAssignment`'s
          // own `setStatus` call throws "illegal transition", and if the
          // ORIGINAL throw was itself a store write failure, the store is
          // presumably still failing and a retried write throws again for the
          // same reason. Either way, there is nothing safe left to do that
          // itself cannot throw: the transient event above has already gone
          // out, and the assignment degrades to "recorded live, not on disk,
          // and possibly stuck non-terminal" rather than the run silently
          // eating a second exception. That is worse than the normal case
          // this fix targets and better than the alternative of one
          // assignment's double failure taking down every other assignment's
          // completed work a second time.
          //
          // There IS one durable channel left, though, and it is worth using:
          // the diagnostics sink writes to `runs/diagnostics.jsonl`, a
          // different file from the `run.json` whose write just failed, and
          // its whole contract is that it swallows its own errors rather than
          // propagating them (see `diagnostics/log.ts`). So the case this
          // block exists for — a persistently broken store, where
          // `failAssignment` never reaches its own diagnostics call because
          // `setStatus` threw first — is precisely the case that would
          // otherwise leave NO record anywhere, which is the defect being
          // fixed above, merely one layer deeper. The message names both
          // failures, because "the assignment threw" and "and then could not
          // be marked failed" are different things to wake up to.
          if (ctx.diagnostics !== undefined) {
            try {
              await ctx.diagnostics.record({
                kind: 'assignment-failed',
                runId: ctx.run.id,
                assignmentId: assignment.id,
                agentName: assignment.agentName,
                message: `${message}; and could not be marked failed: ${describe(recoveryError)}`,
                task: ctx.run.task,
              });
            } catch {
              // A sink that throws is out of contract, but this is the last
              // line of a recovery path — there is nothing above it left to
              // protect but the other assignments, so it stops here.
            }
          }
        }
      }
      await enforceTokenBudget(ctx);
    });
  }

  if (ctx.signal.aborted) ctx.halted = 'cancelled';

  const tally = { completed: 0, failed: 0, skipped: 0, cancelled: 0, declined: 0 };
  for (const assignment of ctx.run.assignments) {
    if (assignment.status === 'done') tally.completed += 1;
    else if (assignment.status === 'failed') tally.failed += 1;
    else if (assignment.status === 'skipped') tally.skipped += 1;
    else if (assignment.status === 'cancelled') tally.cancelled += 1;
    else if (assignment.status === 'declined') tally.declined += 1;
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

  // Resolved once, here, and used by all three of the things that must agree
  // about which directory this attempt owns: the brief that tells the agent
  // where it is standing, the provider's tool sandbox, and the report capture
  // that looks for a written deliverable afterwards. Re-resolving per use would
  // risk two of them naming different attempts.
  const workspaceDir = await resolveWorkspaceDir(ctx, assignment);

  let brief: string;
  try {
    const upstreamReports = await loadUpstreamReports(ctx, assignment);
    brief = buildAssignmentBrief({
      agent,
      task: ctx.run.task,
      assignment,
      upstreamReports,
      isReview: reviewTargetOf(assignment) !== undefined,
      // The same directory the provider's tools are given below, so the brief
      // cannot describe a workspace the agent is not standing in.
      workspaceDir,
      // Read off the run rather than threaded through `DispatchOptions`: it is a
      // property of what was asked, not of how this dispatch is configured, and
      // every assignment in a run has the same subject by definition.
      ...(ctx.run.subjectPath === undefined ? {} : { subjectPath: ctx.run.subjectPath }),
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
  let usage: Usage = { ...assignment.usage };

  // Resolved per assignment, not hoisted: a run may legitimately field two
  // providers, and caching one here would silently apply the first
  // assignment's choice to the rest.
  const provider = ctx.providerFor?.(assignment.agentName) ?? ctx.provider;

  // The deployment's floor and ceiling on model tier (`modelPolicy.ts`). By
  // default an agent whose catalog file says `haiku` runs on `sonnet` instead:
  // an assignment is a specialist reading real material and writing a report
  // someone acts on, and the cheapest tier is the wrong tool for that.
  const modelDecision = applyModelPolicy(agent.model, ctx.modelPolicy);
  if (modelDecision.reason !== undefined) {
    // Recorded rather than only applied. An agent running on a model its own
    // file does not name is exactly the kind of thing that is invisible until
    // someone is trying to explain a cost or a result months later — and
    // `provider-warning`'s own definition already names "a model override" as
    // what it is for. Not fatal, and not a reason to skip the assignment: the
    // policy raising a model is the policy working.
    if (ctx.diagnostics !== undefined) {
      await ctx.diagnostics.record({
        kind: 'provider-warning',
        runId: ctx.run.id,
        assignmentId,
        agentName: assignment.agentName,
        message: `model policy: ${modelDecision.reason}`,
        task: ctx.run.task,
      });
    }
    ctx.onEvent?.({
      t: 'error',
      assignmentId,
      message: `model policy: ${modelDecision.reason}`,
      fatal: false,
    });
  }

  try {
    for await (const event of provider.run({
      assignmentId,
      systemPrompt: agent.systemPrompt,
      task: brief,
      allowedTools: agent.tools,
      // AO-8: per-assignment, per-attempt sandbox — see `resolveWorkspaceDir`
      // and `FileRunStore.assignmentWorkspaceDir` for why this is no longer
      // the one directory every assignment in the phase shared.
      workspaceDir,
      // The subject the brief already names, now also reaching the TOOLS. Until
      // this line the sandboxed adapters were told about a path their own file
      // tools would refuse — worse than silence, because an agent reads a
      // refusal as evidence about the SUBJECT rather than about its sandbox.
      // `apiTools.ts` and `mcpTools.ts` expose it as a read-only second root
      // that no write tool can name.
      ...(ctx.run.subjectPath === undefined ? {} : { subjectPath: ctx.run.subjectPath }),
      signal: linked.signal,
      // The catalog's per-agent `model:`, clamped into this deployment's range
      // (`modelPolicy.ts`) and otherwise forwarded verbatim. The dispatcher
      // still does not INTERPRET the word — `sonnet` and `inherit` mean
      // different things to different engines, and resolving one to an API id
      // here would put provider knowledge back in the orchestrator. Ranking
      // three tier words cheapest-first is a different and much smaller claim
      // than knowing what any of them resolves to.
      //
      // This is the one place every provider passes through, which is why the
      // clamp lives here rather than in each adapter: three adapters enforcing
      // the same floor separately is three chances for one of them to drift.
      // Absent for the 8 agents that declare no model, which every adapter
      // reads as "use whatever the run is using".
      ...(modelDecision.model === undefined ? {} : { model: modelDecision.model }),
    })) {
      // F4: stamp who produced this event before it is persisted or
      // broadcast. `event` itself, as built by the provider, only ever knows
      // `assignmentId` — the provider has no notion of `AssignmentState` at
      // all — so `assignment` (looked up once, at the top of this function)
      // is the only place `agentName`/`phaseId` can come from without a
      // second lookup per event. See `withAssignmentProvenance`'s own
      // comment for why this enriches both the persisted copy and the live
      // broadcast rather than only the one written to disk.
      const logged = withAssignmentProvenance(event, assignment);
      await ctx.store.appendEvent(ctx.run.id, assignmentId, logged);
      ctx.onEvent?.(logged);

      if (event.t === 'text') text += event.chunk;
      else if (event.t === 'usage') {
        // Reassigned through `addUsage` rather than mutated field by field:
        // `Usage` carries the cache split now, and `+=` on two of four fields
        // would drop it — understating nothing and OVERstating the bill, since
        // an unreported cache read is priced as fresh input.
        usage = addUsage(usage, {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: event.cacheReadTokens }),
          ...(event.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: event.cacheWriteTokens }),
        });
      } else if (event.t === 'error') {
        if (event.fatal) fatalError = event.message;
        else {
          // A non-fatal provider complaint — a refused tool grant, an
          // unregistered MCP server, a model override. Already an event in this
          // run's own log; recorded here so it is answerable ACROSS runs, which
          // is the question these actually get asked ("what keeps being
          // refused?") and the one a per-run log cannot answer.
          // Guarded rather than `await ctx.diagnostics?.record(...)`: optional
          // chaining still yields a microtask when the sink is absent, and the
          // absent case is every existing caller. `await undefined` in an event
          // loop is a real scheduling change to buy nothing, and this dispatcher
          // has timing-sensitive behaviour (the FR-M8 halt, the FR-M10 reviewer
          // race) that has no business shifting because an observability hook
          // was added and not configured.
          if (ctx.diagnostics !== undefined) {
            await ctx.diagnostics.record({
            kind: classifyProviderWarning(event.message),
            runId: ctx.run.id,
            assignmentId,
            agentName: assignment.agentName,
            message: event.message,
            task: ctx.run.task,
            });
          }
        }
      }
    }
  } catch (error) {
    fatalError = describe(error);
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }

  // Record usage even on failure — a failed assignment still costs money (NFR-5).
  //
  // The resolved model rides along in the same patch, for the identical
  // reason: `modelDecision`, computed above before the provider call, is the
  // only place in this whole path that knows the difference between what the
  // agent's catalog file says and what actually ran once the deployment's
  // floor (`modelPolicy.ts`) clamped it. Persist nothing when the policy left
  // `model` undefined (an agent that declares no `model:` at all) — see
  // `AssignmentStateSchema.model`'s doc comment in `shared/src/run.ts` for why
  // an explicit `undefined` key would be the wrong shape here under
  // `exactOptionalPropertyTypes`, and why leaving the key absent is exactly
  // the "fall back to the catalog word" behaviour those ~8 agents need.
  await patchAssignment(ctx, assignmentId, {
    usage,
    ...(modelDecision.model === undefined ? {} : { model: modelDecision.model }),
  });

  if (timeout.signal.aborted) {
    await failAssignment(
      ctx,
      assignmentId,
      `timed out after ${ctx.options.assignmentTimeoutMs}ms`,
      text,
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
    // It then spent four phases recorded as `failed`, because that was the
    // only terminal status `working` could reach. That was documented as an
    // imperfect fit and it was worse than imperfect: the office rendered a
    // slumped agent under an error bubble, and the run list counted the
    // assignment under "Failed", for work the user had deliberately called
    // off. `shared/src/status.ts` now has a terminal `cancelled` that means
    // stopped rather than broken, and this is the one place that reaches it.
    //
    // `endedAt` and the message are kept from the old path: a reader still
    // sees exactly which assignment was in flight when the cancel landed.
    await setStatus(ctx, assignmentId, 'cancelled', {
      error: 'cancelled: run was stopped while this assignment was in progress',
      endedAt: Date.now(),
    });
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
      text,
    );
    return;
  }
  if (fatalError !== undefined) {
    await failAssignment(ctx, assignmentId, fatalError, text);
    return;
  }
  // FR-M6: prefer the report the agent WROTE at the deliverable path over the
  // report it merely described. See `readWrittenDeliverable` for the live-model
  // defect that made this necessary and why the file wins when both exist.
  const written = await readWrittenDeliverable(workspaceDir, assignment.deliverable);

  // Nothing at the declared path. Before falling back to the reply — which may
  // be nothing but "Report complete at reports/06-sre-engineer.md" — look for a
  // report the agent wrote under a name of its own. See `recoverWrittenReport`
  // for the assignment that lost 15,211 bytes of live measurements this way and
  // was recorded `done`.
  let recovered: { text: string; from: string } | undefined;
  if (written === undefined) {
    recovered = await recoverWrittenReport(workspaceDir, assignment.deliverable);
    if (recovered !== undefined) {
      const note =
        `report recovered from "${recovered.from}" in the workspace; ` +
        `the brief asked for it at "${assignment.deliverable}"`;
      // Never silently. If the guess is wrong, this line is how anyone finds
      // out — and if it is right, it is how the agent's own filing habit gets
      // noticed and fixed rather than absorbed forever.
      if (ctx.diagnostics !== undefined) {
        await ctx.diagnostics.record({
          kind: 'provider-warning',
          runId: ctx.run.id,
          assignmentId,
          agentName: assignment.agentName,
          message: note,
          task: ctx.run.task,
        });
      }
      ctx.onEvent?.({ t: 'error', assignmentId, message: note, fatal: false });
    }
  }

  // Doc1: a captured report's first line can be prose and a markdown heading
  // fused with no line break between them — see `normaliseGluedHeading`'s own
  // doc comment for the real report this reproduces and exactly what this
  // does and does not fix.
  const report = normaliseGluedHeading(written ?? recovered?.text ?? text.trim());

  if (report === '') {
    // FR-M6: a missing report is a failed assignment, not a quiet success.
    //
    // Checked against the resolved report rather than `text` alone, so an agent
    // that wrote its whole answer to the file and said nothing in the reply is a
    // success — which is what it is. Before the written path existed, that agent
    // failed with "produced no report" while its report sat on disk.
    await failAssignment(ctx, assignmentId, 'produced no report', text);
    return;
  }

  await setStatus(ctx, assignmentId, 'reporting');

  try {
    await ctx.store.writeReport(ctx.run.id, assignment.deliverable, report);
  } catch (error) {
    // `deliverable` comes from the Manager and is untrusted; the store rejects
    // anything escaping the run directory (NFR-1).
    await failAssignment(ctx, assignmentId, `could not write report: ${describe(error)}`, report);
    return;
  }

  // Agent-authored diagnostics (`[[ENHANCEMENT: ...]]` and friends), read from
  // the report that was PERSISTED — so a note the agent wrote into its
  // deliverable file is found, exactly like the FR-M10 verdict above it. Parsed
  // after the write rather than before, because a note in a report that failed
  // to persist is a note about work nobody can read.
  // Parsed unconditionally now, not only when a diagnostics sink exists: the
  // markers decide the assignment's terminal status, so this is no longer purely
  // observational. A run's outcome must not depend on whether observability
  // happens to be configured.
  const notes = parseAgentNotes(report);

  const diagnostics = ctx.diagnostics;
  if (diagnostics !== undefined) {
    for (const note of notes) {
      await diagnostics.record({
        kind: note.kind,
        runId: ctx.run.id,
        assignmentId,
        agentName: assignment.agentName,
        message: note.text,
        task: ctx.run.task,
      });
    }
  }

  // The agent's own verdict on whether it produced the work (see `declined` in
  // `shared/src/status.ts`). `[[BLOCKER: ...]]` means "something stopped me
  // producing what was asked for", so a report carrying one is a decline, not a
  // success — and the brief says plainly that an agent which DID the work uses
  // `NOTE` instead, because acting on the marker makes that distinction
  // load-bearing.
  //
  // The report is still written, still reaches dependents, and still reaches
  // synthesis: it explains why, which is the most useful thing anyone
  // downstream can be told. Only the status changes.
  const declined = notes.some((note) => note.kind === 'blocker');

  await setStatus(ctx, assignmentId, declined ? 'declined' : 'done', {
    reportPath: assignment.deliverable,
    endedAt: Date.now(),
  });

  // The verdict is read from the report that was PERSISTED, not from the reply.
  // A reviewer that wrote its verdict into the deliverable file would otherwise
  // have `parseReviewVerdict` scanning narration for a marker that is sitting in
  // the report itself — FR-M10 silently never firing, in exactly the case this
  // fix exists to handle.
  await applyReviewVerdict(ctx, assignment, report);
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

/**
 * F4: attach `agentName`/`phaseId` to an event about to be persisted,
 * reading both off the `AssignmentState` this dispatcher already has in
 * hand — never re-derived from the registry or the plan, which would risk
 * disagreeing with what `run.json` itself records for this assignment.
 *
 * `AssignmentState.agentName` and `.phaseId` are required, non-optional
 * strings (`shared/src/run.ts`), so there is no `exactOptionalPropertyTypes`
 * concern here the way there is on the `patch.*` fields in `setStatus`
 * below: every real assignment has both, always, so both are set
 * unconditionally rather than conditionally spread.
 *
 * Applied to BOTH the copy handed to `store.appendEvent` and the one handed
 * to `ctx.onEvent` (the live WebSocket broadcast), not only the persisted
 * one. The two are the same object at every call site in this file, and a
 * live viewer asking "which agent is this" mid-run has exactly the same
 * need the operator reading a finished log does — there is no reason for
 * the two channels to disagree about a fact that is already known before
 * either one fires.
 */
function withAssignmentProvenance(event: AgentEvent, assignment: AssignmentState): AgentEvent {
  return { ...event, agentName: assignment.agentName, phaseId: assignment.phaseId };
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
  // F4: `agentName`/`phaseId` set directly from `assignment` (read above,
  // before `Object.assign` applied `patch`) rather than through
  // `withAssignmentProvenance` — this event is being built fresh, field by
  // field, not enriched from one a provider already handed back, so there is
  // nothing to spread over. Both are required, non-optional fields on
  // `AssignmentState`, so — unlike every other field on this event literal —
  // they need no `exactOptionalPropertyTypes` conditional spread.
  const event: AgentEvent = {
    t: 'status',
    assignmentId,
    agentName: assignment.agentName,
    phaseId: assignment.phaseId,
    status,
    ...(patch.reportPath === undefined ? {} : { reportPath: patch.reportPath }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    ...(patch.endedAt === undefined ? {} : { endedAt: patch.endedAt }),
    ...(clearsEndedAt ? { endedAtCleared: true as const } : {}),
    ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
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
  /**
   * Whatever the agent said before it failed, when the provider ran at all.
   *
   * Markers are read from this as well as from a successful report, and the
   * reason is a real run: an audit whose two assignments both hit
   * `budget_exhausted` produced no reports, so `parseAgentNotes` — which ran
   * only on the success path — saw nothing. `[[BLOCKER: ...]]` exists precisely
   * for "something stopped me producing what was asked for", which makes the
   * kind defined for failures the one that could not survive a failure.
   *
   * Absent at the two sites that fail before the provider is invoked (an unknown
   * agent, a brief that could not be assembled), where there is no agent text to
   * read because the agent never spoke.
   */
  agentText?: string,
): Promise<void> {
  await setStatus(ctx, assignmentId, 'failed', { error: message, endedAt: Date.now() });

  // Recorded here rather than at each of the six call sites, because this is the
  // one function every assignment failure already goes through — and a capture
  // point that has to be remembered is one that eventually is not.
  const diagnostics = ctx.diagnostics;
  if (diagnostics === undefined) return;
  const assignment = findAssignment(ctx.run, assignmentId);
  await diagnostics.record({
    kind: 'assignment-failed',
    runId: ctx.run.id,
    assignmentId,
    ...(assignment === undefined ? {} : { agentName: assignment.agentName }),
    message,
    task: ctx.run.task,
  });

  // The agent's own account of why, when it managed to say anything. Logged
  // after the failure record so the two read in that order.
  for (const note of agentText === undefined ? [] : parseAgentNotes(agentText)) {
    await diagnostics.record({
      kind: note.kind,
      runId: ctx.run.id,
      assignmentId,
      ...(assignment === undefined ? {} : { agentName: assignment.agentName }),
      message: note.text,
      task: ctx.run.task,
    });
  }
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
