import { useRef, useState } from 'react';
import type { AgentSummary, RunPlan, TeamOperation } from '@agent-office/shared';

/**
 * The team-review gate (FR-M11).
 *
 * `awaiting_approval` is the one run status that means "nothing is happening
 * and nothing will, until a person acts" — `status.ts`'s own comment on the
 * status says as much. This panel is that person's entire interface to the
 * pause: the Manager's proposed `RunPlan`, laid out phase by phase, with three
 * verbs available against it (drop, swap, add) and a submit that either
 * approves it unchanged (an empty `operations` array — `wire.ts`'s
 * `TeamDecisionSchema` treats that as a real, expected request, not a no-op)
 * or forwards the accumulated edits.
 *
 * ## Why the edit list is `TeamOperation[]` wrapped in a client key, not a
 * bespoke diff shape
 *
 * The wire contract already says exactly what an edit can be — `drop`,
 * `swap`, `add` — and `packages/server` validates a `TeamDecision` against
 * the plan it actually holds, not against whatever the client claims. Given
 * that, building a second, richer "diff" representation in this file and
 * flattening it to `TeamOperation[]` only at submit time would just be a
 * second place the two could disagree. Instead the pending-edit list *is* a
 * list of `TeamOperation`s from the moment a control creates one — a `drop`
 * button click builds `{ op: 'drop', assignmentId }` directly — so
 * `buildTeamReviewModel`'s `operations` field is a straight
 * `edits.map(e => e.op)` with nothing left to translate. The only thing this
 * file adds on top of the wire type is `key`: a stable identity for React's
 * list rendering and for "undo this one edit", which `drop`/`swap` get for
 * free from `assignmentId` (see `upsertEdit`'s doc comment) and `add` needs a
 * client-generated one for, because the assignment it describes does not
 * exist server-side yet and so has no id to key on.
 *
 * ## Why the drop-blocking logic lives here and not just on the server
 *
 * `TeamOperationSchema`'s own comment says the server "refuses" a drop that
 * something still depends on. That is the correct place to enforce it —
 * this file must not be trusted the way the server is not trusted — but
 * enforcing it *only* there means the one way a user finds out is a rejected
 * submit after they have already made several other edits, with no
 * indication which one was the problem. `dropBlockers` recomputes the same
 * rule (a survivor's `dependsOn` still names the id you're trying to drop)
 * against the plan plus whatever is currently pending, so the control that
 * would produce an invalid request is simply disabled before the click,
 * with the reason written next to it (WCAG 3.3.1 — a disabled control that
 * does not say why is not accessible, it is just confusing).
 */

// ---------------------------------------------------------------------------
// Pure model: the proposed plan + the user's pending edits -> what to show,
// and what `POST /api/runs/:id/team` should receive. Exercised directly in
// `TeamReview.test.tsx`, per this package's Node-only test convention (see
// `state/useRun.ts`'s `applyServerMessage`, `sim/model.ts`'s `plateLines`) —
// none of this needs a DOM to be correct, so none of it is tested through one.
// ---------------------------------------------------------------------------

/**
 * One user edit, not yet submitted.
 *
 * `key` is what `upsertEdit` collapses repeat edits by. For `drop`/`swap` it
 * is the target `assignmentId`: that assignment can carry at most one pending
 * edit at a time by construction (swapping an already-swapped row replaces
 * the earlier swap; dropping an already-swapped row replaces the swap with
 * the drop), which is also exactly the invariant `TeamDecisionSchema` needs —
 * one operation per assignment, never two contradictory ones in the same
 * request. For `add` it is a client-generated id (`nextAddKey` below),
 * because the assignment being described has no server-side id until the
 * operation is accepted.
 */
export interface PendingTeamEdit {
  key: string;
  op: TeamOperation;
}

/** One already-proposed assignment, as the pending edits currently leave it. */
export interface AssignmentReviewRow {
  id: string;
  phaseId: string;
  originalAgentName: string;
  objective: string;
  dependsOn: string[];
  /** The pending `drop` or `swap` touching this row, if any. */
  edit: PendingTeamEdit | undefined;
  dropped: boolean;
  /** Who will actually do this work after edits: the swap target, the
   * original agent, or `undefined` once dropped. */
  effectiveAgentName: string | undefined;
  /** Whether the Drop control is currently enabled. */
  canDrop: boolean;
  /** WCAG 3.3.1: why `canDrop` is false. Present iff `!canDrop`. */
  dropBlockedReason: string | undefined;
}

/** A pending `add`, rendered as its own row alongside the phase's proposed ones. */
export interface AddedAssignmentRow {
  key: string;
  phaseId: string;
  agentName: string;
  objective: string;
  dependsOn: string[];
}

export interface PhaseReviewGroup {
  id: string;
  name: string;
  rows: AssignmentReviewRow[];
  added: AddedAssignmentRow[];
}

export interface TeamReviewModel {
  phases: PhaseReviewGroup[];
  /** Exactly what `POST /api/runs/:id/team`'s `TeamDecision.operations` should be. */
  operations: TeamOperation[];
}

/** Assignment ids with a pending `drop` edit. */
function droppedAssignmentIds(edits: PendingTeamEdit[]): Set<string> {
  const ids = new Set<string>();
  for (const edit of edits) {
    if (edit.op.op === 'drop') ids.add(edit.op.assignmentId);
  }
  return ids;
}

/**
 * Why `assignmentId` cannot currently be dropped, as a list of human-readable
 * reasons — empty when it can be.
 *
 * A survivor blocks the drop; a fellow dropped assignment does not, even if
 * its own `dependsOn` names `assignmentId`, because it will not be running
 * either (this is what lets a user drop a whole dependent chain in one pass
 * instead of being stuck re-ordering their clicks). A *pending addition*
 * blocks it too: `add`'s `dependsOn` can name an existing assignment, and a
 * newly-added step that depends on a report that will never be written is
 * exactly the dangling reference `TeamOperationSchema`'s server-side check
 * exists to prevent — this file has no server to fall back on for that case,
 * so it has to know the rule itself.
 */
export function dropBlockers(plan: RunPlan, assignmentId: string, edits: PendingTeamEdit[]): string[] {
  const dropped = droppedAssignmentIds(edits);
  const blockers: string[] = [];

  for (const phase of plan.phases) {
    for (const assignment of phase.assignments) {
      if (assignment.id === assignmentId) continue;
      if (dropped.has(assignment.id)) continue;
      if (assignment.dependsOn.includes(assignmentId)) {
        blockers.push(`${assignment.agentName} (${assignment.id})`);
      }
    }
  }

  for (const edit of edits) {
    if (edit.op.op === 'add' && (edit.op.dependsOn ?? []).includes(assignmentId)) {
      blockers.push(`the pending addition of ${edit.op.agentName}`);
    }
  }

  return blockers;
}

export function canDropAssignment(plan: RunPlan, assignmentId: string, edits: PendingTeamEdit[]): boolean {
  return dropBlockers(plan, assignmentId, edits).length === 0;
}

/**
 * Assignments a phase's new `add` may legally `dependsOn`: earlier phases
 * only (mirrors `plan.ts`'s `RunPlanSchema` "depends backwards" rule), and
 * not anything already dropped — depending on an assignment that will not
 * run would leave the new step waiting on a report that never arrives.
 */
export function availableDependencyCandidates(
  plan: RunPlan,
  phaseId: string,
  edits: PendingTeamEdit[],
): { id: string; agentName: string }[] {
  const targetIndex = plan.phases.findIndex((phase) => phase.id === phaseId);
  if (targetIndex <= 0) return [];

  const dropped = droppedAssignmentIds(edits);
  const candidates: { id: string; agentName: string }[] = [];
  for (const phase of plan.phases.slice(0, targetIndex)) {
    for (const assignment of phase.assignments) {
      if (dropped.has(assignment.id)) continue;
      candidates.push({ id: assignment.id, agentName: assignment.agentName });
    }
  }
  return candidates;
}

/**
 * Insert `edit`, or replace the existing one sharing its `key`. This is the
 * whole mechanism behind "swap it again and the first swap disappears" and
 * "drop a swapped row and the swap disappears" — both are just a second
 * `upsertEdit` call keyed on the same `assignmentId`.
 */
export function upsertEdit(edits: PendingTeamEdit[], edit: PendingTeamEdit): PendingTeamEdit[] {
  const index = edits.findIndex((e) => e.key === edit.key);
  if (index === -1) return [...edits, edit];
  const next = edits.slice();
  next[index] = edit;
  return next;
}

/** Undo one pending edit by its key. */
export function removeEdit(edits: PendingTeamEdit[], key: string): PendingTeamEdit[] {
  return edits.filter((e) => e.key !== key);
}

export function dropEdit(assignmentId: string): PendingTeamEdit {
  return { key: assignmentId, op: { op: 'drop', assignmentId } };
}

export function swapEdit(assignmentId: string, agentName: string): PendingTeamEdit {
  return { key: assignmentId, op: { op: 'swap', assignmentId, agentName } };
}

export function addEdit(
  key: string,
  phaseId: string,
  agentName: string,
  objective: string,
  dependsOn: string[],
): PendingTeamEdit {
  return {
    key,
    op: {
      op: 'add',
      phaseId,
      agentName,
      objective,
      // `exactOptionalPropertyTypes`: `dependsOn` is optional on the wire and
      // an assignment with no dependencies must omit the key entirely rather
      // than carry an empty array — both parse the same today, but only the
      // omitted form matches what `TeamOperationSchema.max(32).optional()`
      // documents as "absent" and what a hand-built fixture would expect.
      ...(dependsOn.length === 0 ? {} : { dependsOn }),
    },
  };
}

function findPlanAssignment(
  plan: RunPlan,
  assignmentId: string,
): { agentName: string } | undefined {
  for (const phase of plan.phases) {
    const found = phase.assignments.find((a) => a.id === assignmentId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** One line of plain-language summary for the pending-edits list. */
export function describeEdit(edit: PendingTeamEdit, plan: RunPlan): string {
  switch (edit.op.op) {
    case 'drop': {
      const original = findPlanAssignment(plan, edit.op.assignmentId);
      return `Drop ${original?.agentName ?? edit.op.assignmentId} (${edit.op.assignmentId}).`;
    }
    case 'swap': {
      const original = findPlanAssignment(plan, edit.op.assignmentId);
      return `Swap ${original?.agentName ?? edit.op.assignmentId} (${edit.op.assignmentId}) for ${edit.op.agentName}.`;
    }
    case 'add': {
      // Bound to a local rather than read as `edit.op.phaseId` inside the
      // `.find` callback below: TS's discriminant narrowing from the
      // `switch` above does not carry into a nested closure, only into
      // expressions evaluated directly in this block.
      const op = edit.op;
      const phase = plan.phases.find((p) => p.id === op.phaseId);
      return `Add ${op.agentName} to "${phase?.name ?? op.phaseId}".`;
    }
  }
}

/**
 * The proposed plan plus the pending edits, folded into what the panel
 * renders and what it would submit right now.
 *
 * Every `AssignmentReviewRow` is derived straight from `plan` — nothing here
 * invents state the Manager didn't propose, matching `status.ts`'s "the sim
 * never invents state the orchestrator doesn't own" rule extended to this
 * panel. `operations` is `edits.map(e => e.op)` verbatim: see the file
 * header for why there is nothing left to translate.
 */
export function buildTeamReviewModel(plan: RunPlan, edits: PendingTeamEdit[]): TeamReviewModel {
  const editByAssignmentId = new Map<string, PendingTeamEdit>();
  const addEdits: PendingTeamEdit[] = [];
  for (const edit of edits) {
    if (edit.op.op === 'add') addEdits.push(edit);
    else editByAssignmentId.set(edit.op.assignmentId, edit);
  }

  const phases: PhaseReviewGroup[] = plan.phases.map((phase) => {
    const rows: AssignmentReviewRow[] = phase.assignments.map((assignment) => {
      const edit = editByAssignmentId.get(assignment.id);
      const dropped = edit?.op.op === 'drop';
      const blockers = dropBlockers(plan, assignment.id, edits);

      let effectiveAgentName: string | undefined = assignment.agentName;
      if (dropped) effectiveAgentName = undefined;
      else if (edit?.op.op === 'swap') effectiveAgentName = edit.op.agentName;

      return {
        id: assignment.id,
        phaseId: phase.id,
        originalAgentName: assignment.agentName,
        objective: assignment.objective,
        dependsOn: assignment.dependsOn,
        edit,
        dropped,
        effectiveAgentName,
        canDrop: blockers.length === 0,
        dropBlockedReason: blockers.length === 0 ? undefined : `Still depended on by ${blockers.join(', ')}.`,
      };
    });

    const added: AddedAssignmentRow[] = addEdits
      .filter(
        (edit): edit is PendingTeamEdit & { op: Extract<TeamOperation, { op: 'add' }> } =>
          edit.op.op === 'add' && edit.op.phaseId === phase.id,
      )
      .map((edit) => ({
        key: edit.key,
        phaseId: edit.op.phaseId,
        agentName: edit.op.agentName,
        objective: edit.op.objective,
        dependsOn: edit.op.dependsOn ?? [],
      }));

    return { id: phase.id, name: phase.name, rows, added };
  });

  return { phases, operations: edits.map((e) => e.op) };
}

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------

export interface TeamReviewProps {
  /** `run.plan`. `undefined` only for a `run.json` this old (should not
   * happen for a run that reached `awaiting_approval`, but the panel would
   * rather say so plainly than throw). */
  plan: RunPlan | undefined;
  /** The full roster, already fetched by `App.tsx` (`fetchAgents`) — reused
   * here rather than fetched a second time. */
  agents: AgentSummary[];
  onSubmit: (operations: TeamOperation[]) => Promise<void>;
}

/** One phase's "add an agent" mini-form. Local, uncommitted input — nothing
 * here needs to be pure/tested, matching `TaskForm.tsx`'s own `task` state. */
interface AddFormState {
  agentName: string;
  objective: string;
  dependsOn: string[];
}

const EMPTY_ADD_FORM: AddFormState = { agentName: '', objective: '', dependsOn: [] };

export function TeamReview({ plan, agents, onSubmit }: TeamReviewProps): JSX.Element {
  const [edits, setEdits] = useState<PendingTeamEdit[]>([]);
  const [addForms, setAddForms] = useState<Record<string, AddFormState>>({});
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  // Client-only identity for pending `add` edits (see `PendingTeamEdit`'s doc
  // comment). A ref, not state: it must survive re-renders but changing it
  // must never itself trigger one.
  const addKeyCounter = useRef(0);

  if (plan === undefined) {
    return (
      <section className="team-review" aria-labelledby="team-review-heading">
        <h2 id="team-review-heading">Review the proposed team</h2>
        <p className="form-error" role="alert">
          This run is awaiting approval, but no plan was recorded for it — there is nothing to review here.
        </p>
      </section>
    );
  }

  const model = buildTeamReviewModel(plan, edits);

  const addFormFor = (phaseId: string): AddFormState => addForms[phaseId] ?? EMPTY_ADD_FORM;

  const setAddFormFor = (phaseId: string, next: AddFormState): void => {
    setAddForms((prev) => ({ ...prev, [phaseId]: next }));
  };

  const handleDrop = (assignmentId: string): void => {
    setEdits((prev) => upsertEdit(prev, dropEdit(assignmentId)));
  };

  const handleRestore = (assignmentId: string): void => {
    setEdits((prev) => removeEdit(prev, assignmentId));
  };

  const handleSwap = (assignmentId: string, originalAgentName: string, agentName: string): void => {
    setEdits((prev) => (agentName === originalAgentName ? removeEdit(prev, assignmentId) : upsertEdit(prev, swapEdit(assignmentId, agentName))));
  };

  const handleAddSubmit = (phaseId: string): void => {
    setAddError(undefined);
    const form = addFormFor(phaseId);
    const agentName = form.agentName.trim();
    const objective = form.objective.trim();

    if (agentName.length === 0) {
      setAddError('Choose an agent before adding it to this phase.');
      return;
    }
    if (objective.length === 0) {
      setAddError('An added agent needs an objective — what should it produce?');
      return;
    }

    const key = `add-${phaseId}-${addKeyCounter.current}`;
    addKeyCounter.current += 1;
    setEdits((prev) => upsertEdit(prev, addEdit(key, phaseId, agentName, objective, form.dependsOn)));
    setAddFormFor(phaseId, EMPTY_ADD_FORM);
  };

  const handleUndo = (key: string): void => {
    setEdits((prev) => removeEdit(prev, key));
  };

  const handleSubmit = (): void => {
    setSubmitError(undefined);
    setSubmitting(true);
    onSubmit(model.operations)
      .catch((err: unknown) => setSubmitError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSubmitting(false));
  };

  const agentModelByName = new Map(agents.map((a) => [a.name, a.model]));

  return (
    <section className="team-review" aria-labelledby="team-review-heading">
      {/* This heading, plus the intro line below, is the "obvious the run is
          waiting on YOU" surface FR-M11 asks for — `RunHeader`'s status chip
          already says `awaiting_approval` in amber (`theme/status.ts`'s
          `statusWaiting`), but a colour alone is not a call to action, and a
          person mid-scroll deserves a sentence that says what is expected of
          them before they reach it. */}
      <h2 id="team-review-heading">Review the proposed team</h2>
      <p className="team-review-intro">
        The Manager finished planning and is waiting for you. Nothing will be dispatched until you submit below —
        approving with no changes is enough if the plan already looks right.
      </p>

      {plan.phases.map((phase) => {
        const group = model.phases.find((p) => p.id === phase.id);
        if (group === undefined) return null;
        const form = addFormFor(phase.id);
        const dependencyCandidates = availableDependencyCandidates(plan, phase.id, edits);
        const headingId = `team-review-phase-${phase.id}`;

        return (
          <div className="team-review-phase" key={phase.id}>
            <h3 id={headingId}>{phase.name}</h3>
            <ul className="team-review-rows" aria-labelledby={headingId}>
              {group.rows.map((row) => {
                const dropReasonId = `team-review-drop-reason-${row.id}`;
                return (
                  <li
                    key={row.id}
                    className={row.dropped ? 'team-review-row team-review-row-dropped' : 'team-review-row'}
                  >
                    <div className="team-review-row-main">
                      <span className="team-review-row-id">{row.id}</span>
                      <label htmlFor={`team-review-agent-${row.id}`}>Agent</label>
                      <select
                        id={`team-review-agent-${row.id}`}
                        value={row.effectiveAgentName ?? row.originalAgentName}
                        disabled={row.dropped}
                        onChange={(e) => handleSwap(row.id, row.originalAgentName, e.target.value)}
                      >
                        {agents.length === 0 && <option value={row.originalAgentName}>{row.originalAgentName}</option>}
                        {agents.map((agent) => (
                          <option key={agent.name} value={agent.name}>
                            {agent.name}
                            {agent.model !== undefined ? ` (${agent.model})` : ''}
                          </option>
                        ))}
                      </select>
                      <span className="team-review-row-model muted">
                        {row.dropped
                          ? 'dropped'
                          : (agentModelByName.get(row.effectiveAgentName ?? row.originalAgentName) ?? 'model unknown')}
                      </span>
                    </div>
                    <p className="team-review-objective">{row.objective}</p>
                    <div className="team-review-row-actions">
                      {row.dropped ? (
                        <button type="button" onClick={() => handleRestore(row.id)}>
                          Restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cancel-button"
                          disabled={!row.canDrop}
                          aria-describedby={row.dropBlockedReason !== undefined ? dropReasonId : undefined}
                          onClick={() => handleDrop(row.id)}
                        >
                          Drop
                        </button>
                      )}
                    </div>
                    {row.dropBlockedReason !== undefined && (
                      <p className="team-review-reason" id={dropReasonId}>
                        {row.dropBlockedReason}
                      </p>
                    )}
                  </li>
                );
              })}

              {group.added.map((row) => (
                <li key={row.key} className="team-review-row team-review-row-added">
                  <div className="team-review-row-main">
                    <span className="team-review-row-id">new</span>
                    <span>{row.agentName}</span>
                  </div>
                  <p className="team-review-objective">{row.objective}</p>
                  <div className="team-review-row-actions">
                    <button type="button" className="cancel-button" onClick={() => handleUndo(row.key)}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {/* The add-to-phase mini form. A real `<form>` so Enter submits it
                and a screen reader announces it as one, but `preventDefault`
                keeps it from doing a page navigation this SPA has no route
                for. */}
            <form
              className="team-review-add-form"
              aria-label={`Add an agent to ${phase.name}`}
              onSubmit={(e) => {
                e.preventDefault();
                handleAddSubmit(phase.id);
              }}
            >
              <label htmlFor={`team-review-add-agent-${phase.id}`}>Add agent</label>
              <select
                id={`team-review-add-agent-${phase.id}`}
                value={form.agentName}
                onChange={(e) => setAddFormFor(phase.id, { ...form, agentName: e.target.value })}
              >
                <option value="">Choose an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name}
                    {agent.model !== undefined ? ` (${agent.model})` : ''}
                  </option>
                ))}
              </select>

              <label htmlFor={`team-review-add-objective-${phase.id}`}>Objective</label>
              <textarea
                id={`team-review-add-objective-${phase.id}`}
                rows={2}
                value={form.objective}
                onChange={(e) => setAddFormFor(phase.id, { ...form, objective: e.target.value })}
                placeholder="What should this agent produce?"
              />

              {dependencyCandidates.length > 0 && (
                <fieldset className="team-review-depends-on">
                  <legend>Depends on (earlier phases)</legend>
                  {dependencyCandidates.map((candidate) => {
                    const checkboxId = `team-review-depends-${phase.id}-${candidate.id}`;
                    const checked = form.dependsOn.includes(candidate.id);
                    return (
                      <div key={candidate.id}>
                        <input
                          id={checkboxId}
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setAddFormFor(phase.id, {
                              ...form,
                              dependsOn: e.target.checked
                                ? [...form.dependsOn, candidate.id]
                                : form.dependsOn.filter((id) => id !== candidate.id),
                            })
                          }
                        />
                        <label htmlFor={checkboxId}>
                          {candidate.agentName} ({candidate.id})
                        </label>
                      </div>
                    );
                  })}
                </fieldset>
              )}

              <button type="submit">Add to this phase</button>
            </form>
          </div>
        );
      })}

      {addError !== undefined && (
        <p className="form-error" role="alert">
          {addError}
        </p>
      )}

      {/* The pending-edits summary: every edit made so far, in plain
          language, each individually undoable. This exists separately from
          the inline per-row controls above because a user who has made five
          edits across three phases has no single screen showing all five at
          once otherwise — the rows only ever show their own state. */}
      <div className="team-review-edits">
        <h3>Pending changes</h3>
        {edits.length === 0 ? (
          <p className="muted">No changes yet — submitting now approves the Manager&apos;s team as proposed.</p>
        ) : (
          <ul>
            {edits.map((edit) => (
              <li key={edit.key}>
                <span>{describeEdit(edit, plan)}</span>
                <button type="button" className="link-button" onClick={() => handleUndo(edit.key)}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="team-review-actions">
        <button type="button" onClick={handleSubmit} disabled={submitting}>
          {submitting
            ? 'Submitting…'
            : edits.length === 0
              ? 'Approve team, unchanged'
              : `Submit ${edits.length} change${edits.length === 1 ? '' : 's'} and dispatch`}
        </button>
        {submitError !== undefined && (
          <p className="form-error" role="alert">
            {submitError}
          </p>
        )}
      </div>
    </section>
  );
}
