import {
  allAssignments,
  type AssignmentSpec,
  type RunPlan,
  type TeamOperation,
} from '@agent-office/shared';

/**
 * Applying the user's team edits to the Manager's plan (FR-M11).
 *
 * `applyTeamOperations` is the one place `TeamOperation`s become a `RunPlan` —
 * everything downstream of `awaiting_approval` (re-materialising assignments,
 * dispatching, the office sim) reads the plan this returns and has no idea an
 * edit ever happened. That is only safe if this function is trustworthy in a
 * very literal sense:
 *
 *   - PURE: no I/O, no clock, no randomness. Given the same plan and the same
 *     operations it always returns the same result, which is what makes it
 *     testable without a store or a provider and safe to call from inside
 *     `runner.ts`'s pause without smuggling in some other kind of side effect.
 *   - NON-MUTATING: the input `plan` is never written to. Every helper below
 *     builds new phase and assignment objects with `map`/spread rather than
 *     `Object.assign`-ing into the caller's arrays; the original argument is
 *     safe to keep using (or to log, or to diff against) after the call.
 *   - TOTAL: this never throws. A bad operation — an unknown id, an unknown
 *     agent, a dependency edge that would deadlock — returns `{ error }`
 *     instead. `runner.ts` turns that into a clean run failure and the HTTP
 *     layer (owned elsewhere) turns the same shape into a 400; neither of
 *     those callers should need a try/catch around a plan edit.
 *
 * The three verbs mirror `TeamOperationSchema` in `shared/src/wire.ts` exactly
 * — see that file's doc comments for why the wire contract is narrow verbs
 * rather than a whole replacement plan. This module is where that narrowness
 * pays off: because `swap` cannot touch `dependsOn` and `add` cannot supply
 * its own `deliverable`, every invariant the planner already guarantees
 * (`plan.ts`'s `RunPlanSchema.superRefine` — unique ids, backward-only
 * dependencies, at least one assignment per phase... with one exception noted
 * on {@link applyDrop}) survives an edit without this file having to
 * re-implement that whole validator.
 */

/** Zero-pad to two digits, matching the `NN-<agent>.md` convention below. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface AssignmentLocation {
  phaseIndex: number;
  assignment: AssignmentSpec;
}

/** Find an assignment and which phase (by index) it currently lives in. */
function locateAssignment(plan: RunPlan, assignmentId: string): AssignmentLocation | undefined {
  for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex += 1) {
    const phase = plan.phases[phaseIndex];
    if (phase === undefined) continue;
    const assignment = phase.assignments.find((a) => a.id === assignmentId);
    if (assignment !== undefined) return { phaseIndex, assignment };
  }
  return undefined;
}

/**
 * Turn an agent name into a fresh, unique assignment id.
 *
 * `add` deliberately does not accept a client-supplied id — the same NFR-1
 * reasoning `TeamOperationSchema` gives for omitting `deliverable` applies
 * here too, and an id is exactly the kind of string that ends up embedded in
 * event logs (`logs/<assignmentId>.jsonl`) and file paths. The agent name is
 * usually already a reasonable id by itself (the catalog's names are
 * kebab-case), so the common case is `id === agentName`; the loop below only
 * engages when that collides with something already in the plan, e.g. the
 * same agent added twice, or an agent name that happens to equal an
 * assignment id the planner chose independently.
 */
function deriveAssignmentId(plan: RunPlan, agentName: string): string {
  const existingIds = new Set(allAssignments(plan).map((a) => a.id));
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug.length > 0 ? slug : 'agent';

  if (!existingIds.has(base)) return base;

  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Derive a deliverable path the same way the planner does, rather than
 * inventing a second convention.
 *
 * `manager.ts`'s planning prompt tells the Manager to name deliverables
 * `reports/NN-<agent-name>.md`, NN "a two-digit sequence number counted
 * across the whole plan" (see `PLANNING_OUTPUT_CONTRACT`), and
 * `dispatcher.ts`'s `materialiseAssignments` never touches `deliverable` at
 * all — it copies whatever the plan says verbatim. So there is no code path
 * that *computes* NN today; it exists only as an instruction the Manager
 * follows. This function is the first place that has to compute it for
 * real, and it follows the same rule: `allAssignments(plan).length + 1` is
 * exactly "one more than the count of assignments across the whole plan so
 * far", which reproduces the Manager's own numbering when operations are
 * applied one at a time (see `applyTeamOperations`'s doc comment on why that
 * matters for two `add`s in one request).
 *
 * The `while` guard below is defensive, not load-bearing in the common case:
 * a plan that already follows the convention can never collide, because the
 * next sequence number is always one past every number already in use. It
 * exists because `RunPlan` here is a runtime value that came out of an LLM's
 * planning turn — untrusted in the FR-M3 sense — and this function has to
 * stay total even if that plan does not actually follow its own numbering
 * convention (a duplicate NN, a gap, a hand-built test fixture). Silently
 * overwriting an existing deliverable string would mean two assignments
 * racing to write the same file in `store.writeReport` (NFR-1's containment
 * check would not catch this — the path is legitimately inside `reports/`),
 * which is a worse failure than counting one higher until the name is free.
 */
function deriveDeliverable(plan: RunPlan, agentName: string): string {
  const existingPaths = new Set(allAssignments(plan).map((a) => a.deliverable));
  let n = allAssignments(plan).length + 1;
  let candidate = `reports/${pad2(n)}-${agentName}.md`;
  while (existingPaths.has(candidate)) {
    n += 1;
    candidate = `reports/${pad2(n)}-${agentName}.md`;
  }
  return candidate;
}

type DropOp = Extract<TeamOperation, { op: 'drop' }>;
type SwapOp = Extract<TeamOperation, { op: 'swap' }>;
type AddOp = Extract<TeamOperation, { op: 'add' }>;

type OpResult = { plan: RunPlan } | { error: string };

/**
 * Remove an assignment.
 *
 * Refuses outright if anything else in the plan still `dependsOn` it, naming
 * every dependent in the error rather than picking one. The alternative —
 * cascading the drop onto every dependent, and everything that depends on
 * *them*, and so on — was considered and rejected: the user asked to remove
 * one assignment, not to find out after the fact that half the plan
 * disappeared with it. An error the user can read and act on (drop the
 * dependents too, in a follow-up decision, or swap them onto something that
 * does not need this report) is strictly better than a plan quietly missing
 * work nobody asked to lose.
 *
 * One planner invariant this deliberately does NOT re-enforce:
 * `PhaseSpecSchema.assignments` requires at least one assignment per phase,
 * but dropping the last assignment in a phase here simply leaves that phase
 * with an empty `assignments` array. That is intentional rather than an
 * oversight — `dispatcher.ts`'s `assignmentsInPhase` and the phase loop in
 * `dispatchRun` both handle a phase with nothing runnable in it as a matter
 * of course (an empty `runnable` list just means `runPool` has nothing to
 * do), so an empty phase is inert rather than broken. Refusing the drop, or
 * silently deleting the now-empty phase, would both be doing more than the
 * user asked; the plan-level "at least one assignment total" rule below is
 * the one guarantee that actually matters for dispatch to have something to
 * do.
 */
function applyDrop(plan: RunPlan, op: DropOp): OpResult {
  const location = locateAssignment(plan, op.assignmentId);
  if (location === undefined) {
    return { error: `cannot drop "${op.assignmentId}": no such assignment in the plan` };
  }

  const dependents = allAssignments(plan)
    .filter((a) => a.id !== op.assignmentId && a.dependsOn.includes(op.assignmentId))
    .map((a) => a.id);
  if (dependents.length > 0) {
    return {
      error:
        `cannot drop "${op.assignmentId}": still depended on by ${dependents.join(', ')}. ` +
        'Drop or swap those first if the work truly should not happen.',
    };
  }

  const phases = plan.phases.map((phase, index) =>
    index === location.phaseIndex
      ? { ...phase, assignments: phase.assignments.filter((a) => a.id !== op.assignmentId) }
      : phase,
  );

  return { plan: { ...plan, phases } };
}

/**
 * Replace who does an assignment, without moving the work itself.
 *
 * `objective` and `dependsOn` are untouched by construction — this function
 * never reads or writes them, so there is no way for a swap to accidentally
 * rewire what the assignment produces or what it consumes.
 *
 * `deliverable` is untouched too, and that is a decision worth writing down
 * rather than an accident of the implementation being lazy. The filename
 * embeds the *original* agent's name (`reports/03-security-auditor.md`
 * stays exactly that even after swapping in a different reviewer), which
 * looks stale the moment you list the directory. Renaming it to match the
 * new agent was considered and rejected for two reasons. First, the wire
 * contract already settles this: `TeamOperationSchema`'s `swap` variant
 * carries only `assignmentId` and `agentName`, and its doc comment says
 * plainly "keeping its objective, its dependency edges and its deliverable
 * ... that is what makes it a swap rather than a drop plus an add" — a swap
 * that silently changed the deliverable would contradict its own contract.
 * Second, and more concretely: `deliverable` is a stable identity for the
 * *work slot*, not a label for whoever currently fills it — nothing in the
 * dispatcher, the brief builder, or the synthesis step parses an agent name
 * back out of the report path, they all just carry the string through
 * (`materialiseAssignments` copies it verbatim; `loadUpstreamReports` reads
 * `dep.reportPath`, which came from this same field). The only reader who
 * would ever notice a mismatched filename is a human browsing `reports/`
 * directly, and that mismatch is a minor, purely cosmetic paper cut against
 * the alternative: rewriting a path after the fact risks colliding with
 * some other assignment's deliverable (if the new agent's name happens to
 * collide once slotted into the same `NN-` position) for a rename nothing
 * downstream needed.
 */
function applySwap(plan: RunPlan, op: SwapOp, knownAgentNames: ReadonlySet<string>): OpResult {
  const location = locateAssignment(plan, op.assignmentId);
  if (location === undefined) {
    return { error: `cannot swap "${op.assignmentId}": no such assignment in the plan` };
  }
  if (!knownAgentNames.has(op.agentName)) {
    // FR-M3's guarantee — every agentName resolves in the registry — must
    // hold no matter which door a name comes in through. Without this check
    // the approval route would be a second, unvalidated way to put a
    // hallucinated or simply misspelled agent name into a plan that the
    // Manager's own planning turn would never have been allowed to produce.
    return { error: `cannot swap "${op.assignmentId}" to unknown agent "${op.agentName}"` };
  }

  const phases = plan.phases.map((phase, index) => {
    if (index !== location.phaseIndex) return phase;
    return {
      ...phase,
      assignments: phase.assignments.map((a) =>
        a.id === op.assignmentId ? { ...a, agentName: op.agentName } : a,
      ),
    };
  });

  return { plan: { ...plan, phases } };
}

/**
 * Append a new assignment to an existing phase.
 *
 * The `dependsOn` check below is the one place this file had to go read what
 * the dispatcher actually does with a same-phase dependency edge, because
 * `plan.ts`'s own validator refuses same-phase and forward references for a
 * reason stated only in a comment ("what guarantees the dispatcher can
 * execute phase-by-phase without deadlocking") and this function has to
 * reproduce that guarantee for a plan the schema will never see again post
 * `awaiting_approval`. What `dispatchRun` (`dispatcher.ts`) actually does:
 * for each phase it builds `runnable` by filtering that phase's assignments
 * to `status === 'pending'`, then hands the whole list to `runPool` with a
 * concurrency cap — there is no check anywhere in that path for whether a
 * same-phase sibling has finished. A same-phase dependency would therefore
 * either (a) start running alongside the assignment it depends on, in which
 * case `loadUpstreamReports` finds `dep.reportPath === undefined` because
 * the dependency has not written its report yet and silently drops it from
 * the brief — exactly the "missing report degrades the brief" failure
 * `dependenciesSatisfied`'s doc comment in `shared/src/run.ts` warns about
 * for FR-M5 — or (b) if scheduled after, still runs in the same
 * unconstrained pool with no ordering guarantee, so which of (a) or (b)
 * happens is a race, not a decision. Silently downgrading such an edge (drop
 * it and proceed) would hide a plan the user explicitly asked to be a
 * certain shape; refusing it here, at the moment it is requested, is the
 * only option that tells the truth.
 */
function applyAdd(plan: RunPlan, op: AddOp, knownAgentNames: ReadonlySet<string>): OpResult {
  const phaseIndex = plan.phases.findIndex((phase) => phase.id === op.phaseId);
  if (phaseIndex === -1) {
    return { error: `cannot add to phase "${op.phaseId}": no such phase in the plan` };
  }
  if (!knownAgentNames.has(op.agentName)) {
    // Same FR-M3 guarantee as `applySwap` above: the approval route must not
    // be a way to smuggle an unknown agent into the plan.
    return { error: `cannot add "${op.agentName}" to "${op.phaseId}": unknown agent` };
  }

  const dependsOn = op.dependsOn ?? [];
  const phaseOfAssignment = new Map<string, number>();
  plan.phases.forEach((phase, index) => {
    for (const assignment of phase.assignments) phaseOfAssignment.set(assignment.id, index);
  });

  for (const depId of dependsOn) {
    const depPhaseIndex = phaseOfAssignment.get(depId);
    if (depPhaseIndex === undefined) {
      return {
        error:
          `cannot add "${op.agentName}" to "${op.phaseId}": dependsOn references ` +
          `unknown assignment "${depId}"`,
      };
    }
    if (depPhaseIndex >= phaseIndex) {
      return {
        error:
          `cannot add "${op.agentName}" to "${op.phaseId}": "${depId}" is not in a strictly ` +
          'earlier phase. Same-phase and forward dependencies deadlock — a phase\'s assignments ' +
          'are all dispatched together with no ordering between them (see dispatcher.ts).',
      };
    }
  }

  const newAssignment: AssignmentSpec = {
    id: deriveAssignmentId(plan, op.agentName),
    agentName: op.agentName,
    objective: op.objective,
    deliverable: deriveDeliverable(plan, op.agentName),
    dependsOn: [...dependsOn],
  };

  const phases = plan.phases.map((phase, index) =>
    index === phaseIndex ? { ...phase, assignments: [...phase.assignments, newAssignment] } : phase,
  );

  return { plan: { ...plan, phases } };
}

/**
 * Apply the user's team edits to the Manager's plan (FR-M11).
 *
 * Operations apply strictly in the order given, each seeing the plan as the
 * previous one left it — so `[{ op: 'drop', assignmentId: 'x' }, { op: 'add',
 * agentName: 'x-replacement', ... }]` is a legal way to replace an
 * assignment's agent AND its objective in one request (unlike `swap`, which
 * only ever changes the agent), and dropping an assignment and then adding a
 * differently-shaped one back to the same phase works exactly as the two
 * operations read. This is also why `deriveDeliverable`'s numbering is safe
 * across two `add`s in one request: each call recomputes against whatever
 * `allAssignments` returns for the plan *at that point in the sequence*, so
 * the second `add` counts the first one's new assignment too.
 *
 * The empty-plan check runs once, after every operation, rather than after
 * each individual one — a sequence that drops every assignment and then adds
 * one back is legal (see above), and refusing the momentarily-empty
 * intermediate state would make that sequence fail for no reason a user
 * could act on. What must never happen is *finishing* with nothing to
 * dispatch: `dispatchRun` would loop over phases with nothing runnable in any
 * of them, `dispatchResult.completed` would be `0`, and `executeRun` already
 * treats that as `run.error = 'no assignment produced a report; nothing to
 * synthesise'` — a confusing failure for what is actually a user error made
 * at approval time, catchable here with a message that says what actually
 * happened.
 */
export function applyTeamOperations(
  plan: RunPlan,
  operations: readonly TeamOperation[],
  knownAgentNames: ReadonlySet<string>,
): { plan: RunPlan } | { error: string } {
  let working = plan;

  for (const op of operations) {
    const result: OpResult =
      op.op === 'drop'
        ? applyDrop(working, op)
        : op.op === 'swap'
          ? applySwap(working, op, knownAgentNames)
          : applyAdd(working, op, knownAgentNames);

    if ('error' in result) return result;
    working = result.plan;
  }

  if (allAssignments(working).length === 0) {
    return {
      error: 'the proposed team has no assignments left; a run with nothing to dispatch cannot proceed',
    };
  }

  return { plan: working };
}
