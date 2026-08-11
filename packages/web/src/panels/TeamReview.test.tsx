import { describe, expect, it } from 'vitest';
import type { RunPlan } from '@agent-office/shared';
import {
  addEdit,
  availableDependencyCandidates,
  buildTeamReviewModel,
  canDropAssignment,
  describeEdit,
  dropBlockers,
  dropEdit,
  removeEdit,
  swapEdit,
  upsertEdit,
  type PendingTeamEdit,
} from './TeamReview.js';

/**
 * `TeamReview.tsx`'s pure model — `dropBlockers`, `buildTeamReviewModel`, the
 * `PendingTeamEdit` list operations — is where FR-M11's actual rules live, so
 * this is where they're exercised: no render, no DOM, per this package's
 * Node-only test convention (`state/useRun.test.ts`'s `applyServerMessage`,
 * `sim/model.test.ts`'s `plateLines`).
 *
 * Fixture shape: three phases chained by dependency —
 *
 *   plan  : p1 (agent-a)
 *   build : b1 (agent-b, depends on p1),  b2 (agent-c, depends on p1)
 *   review: r1 (agent-d, depends on b1)
 *
 * which is the minimum shape that can prove both halves of the drop rule:
 * "p1 cannot be dropped while b1 or b2 survive" and "a whole dependent chain
 * can be dropped together, because none of it survives to be blocked".
 */
const PLAN: RunPlan = {
  summary: 'test plan',
  domain: 'software',
  reportStyle: 'concise',
  phases: [
    {
      id: 'plan',
      name: 'Plan',
      parallel: true,
      assignments: [
        { id: 'p1', agentName: 'agent-a', objective: 'scope the work', deliverable: 'reports/01-p1.md', dependsOn: [] },
      ],
    },
    {
      id: 'build',
      name: 'Build',
      parallel: true,
      assignments: [
        {
          id: 'b1',
          agentName: 'agent-b',
          objective: 'implement the feature',
          deliverable: 'reports/02-b1.md',
          dependsOn: ['p1'],
        },
        {
          id: 'b2',
          agentName: 'agent-c',
          objective: 'implement the tests',
          deliverable: 'reports/03-b2.md',
          dependsOn: ['p1'],
        },
      ],
    },
    {
      id: 'review',
      name: 'Review',
      parallel: true,
      assignments: [
        {
          id: 'r1',
          agentName: 'agent-d',
          objective: 'review the implementation',
          deliverable: 'reports/04-r1.md',
          dependsOn: ['b1'],
        },
      ],
    },
  ],
};

describe('dropBlockers / canDropAssignment — the illegal-drop rule', () => {
  it('an assignment nothing depends on can be dropped', () => {
    expect(dropBlockers(PLAN, 'r1', [])).toEqual([]);
    expect(canDropAssignment(PLAN, 'r1', [])).toBe(true);
  });

  it('an assignment with a surviving dependent cannot be dropped, and says who blocks it', () => {
    const blockers = dropBlockers(PLAN, 'p1', []);
    expect(blockers).toContain('agent-b (b1)');
    expect(blockers).toContain('agent-c (b2)');
    expect(canDropAssignment(PLAN, 'p1', [])).toBe(false);
  });

  it('dropping one of two dependents first leaves only the survivor blocking the shared dependency', () => {
    // b1 alone (not b2) blocks p1's drop when b2 is separately dropped first.
    const edits: PendingTeamEdit[] = [dropEdit('b2')];
    const blockers = dropBlockers(PLAN, 'p1', edits);
    expect(blockers).toEqual(['agent-b (b1)']);
  });

  it('dropping a whole dependent chain together is allowed: once b1 is also pending drop, p1 is unblocked', () => {
    // r1 depends on b1, so b1 alone still blocks nothing above it directly,
    // but b1 itself must be dropped for p1 to clear — drop both.
    const edits: PendingTeamEdit[] = [dropEdit('b1'), dropEdit('b2')];
    expect(canDropAssignment(PLAN, 'p1', edits)).toBe(true);
  });

  it('dropping b1 alone is blocked by r1, which still depends on it', () => {
    expect(canDropAssignment(PLAN, 'b1', [])).toBe(false);
    expect(dropBlockers(PLAN, 'b1', [])).toEqual(['agent-d (r1)']);
  });

  it('a pending addition that depends on the target blocks its drop too', () => {
    const edits: PendingTeamEdit[] = [addEdit('add-1', 'review', 'agent-e', 'audit b2', ['b2'])];
    const blockers = dropBlockers(PLAN, 'b2', edits);
    expect(blockers).toEqual(['the pending addition of agent-e']);
  });

  it('undoing the blocking addition clears the drop block again', () => {
    const withAdd: PendingTeamEdit[] = [addEdit('add-1', 'review', 'agent-e', 'audit b2', ['b2'])];
    expect(canDropAssignment(PLAN, 'b2', withAdd)).toBe(false);
    expect(canDropAssignment(PLAN, 'b2', removeEdit(withAdd, 'add-1'))).toBe(true);
  });
});

describe('availableDependencyCandidates — earlier phases only, dropped ones excluded', () => {
  it('the first phase has no earlier phase to depend on', () => {
    expect(availableDependencyCandidates(PLAN, 'plan', [])).toEqual([]);
  });

  it('a later phase can depend on every assignment in every strictly earlier phase', () => {
    const candidates = availableDependencyCandidates(PLAN, 'review', []);
    expect(candidates.map((c) => c.id).sort()).toEqual(['b1', 'b2', 'p1']);
  });

  it('an assignment pending drop is not offered as a dependency', () => {
    const candidates = availableDependencyCandidates(PLAN, 'review', [dropEdit('b2')]);
    expect(candidates.map((c) => c.id).sort()).toEqual(['b1', 'p1']);
  });

  it('an unknown phase id yields no candidates rather than throwing', () => {
    expect(availableDependencyCandidates(PLAN, 'does-not-exist', [])).toEqual([]);
  });
});

describe('upsertEdit / removeEdit — the pending-edit list', () => {
  it('appends a new edit under a key not already present', () => {
    const edits = upsertEdit([], dropEdit('p1'));
    expect(edits).toEqual([{ key: 'p1', op: { op: 'drop', assignmentId: 'p1' } }]);
  });

  it('a second edit on the same assignment replaces the first rather than stacking', () => {
    const first = upsertEdit([], swapEdit('b1', 'agent-x'));
    const second = upsertEdit(first, swapEdit('b1', 'agent-y'));
    expect(second).toHaveLength(1);
    expect(second[0]?.op).toEqual({ op: 'swap', assignmentId: 'b1', agentName: 'agent-y' });
  });

  it('dropping an already-swapped assignment replaces the swap with the drop, same key', () => {
    const swapped = upsertEdit([], swapEdit('b1', 'agent-x'));
    const dropped = upsertEdit(swapped, dropEdit('b1'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.op.op).toBe('drop');
  });

  it('edits on different assignments accumulate independently', () => {
    const edits = upsertEdit(upsertEdit([], dropEdit('p1')), swapEdit('b1', 'agent-x'));
    expect(edits).toHaveLength(2);
  });

  it('removeEdit undoes exactly the named edit and leaves the rest untouched', () => {
    const edits = upsertEdit(upsertEdit([], dropEdit('p1')), swapEdit('b1', 'agent-x'));
    const afterUndo = removeEdit(edits, 'p1');
    expect(afterUndo).toHaveLength(1);
    expect(afterUndo[0]?.key).toBe('b1');
  });

  it('removeEdit on an absent key is a no-op', () => {
    const edits = upsertEdit([], dropEdit('p1'));
    expect(removeEdit(edits, 'not-there')).toEqual(edits);
  });
});

describe('addEdit — the operation the server actually accepts', () => {
  it('carries phaseId, agentName and objective, and never a deliverable', () => {
    const edit = addEdit('add-1', 'build', 'agent-e', 'write docs', []);
    expect(edit.op).toEqual({ op: 'add', phaseId: 'build', agentName: 'agent-e', objective: 'write docs' });
    expect('deliverable' in edit.op).toBe(false);
  });

  it('an empty dependsOn is an absent key, not an empty array — exactOptionalPropertyTypes discipline', () => {
    const edit = addEdit('add-1', 'build', 'agent-e', 'write docs', []);
    expect('dependsOn' in edit.op).toBe(false);
  });

  it('a non-empty dependsOn is carried through', () => {
    const edit = addEdit('add-1', 'review', 'agent-e', 'audit', ['b1', 'b2']);
    expect(edit.op).toEqual({
      op: 'add',
      phaseId: 'review',
      agentName: 'agent-e',
      objective: 'audit',
      dependsOn: ['b1', 'b2'],
    });
  });
});

describe('buildTeamReviewModel — the rendered view and the submitted operations', () => {
  it('with no edits, every row is untouched and operations is empty (approval-unchanged)', () => {
    const model = buildTeamReviewModel(PLAN, []);
    expect(model.operations).toEqual([]);
    const p1 = model.phases[0]?.rows[0];
    expect(p1?.dropped).toBe(false);
    expect(p1?.effectiveAgentName).toBe('agent-a');
    expect(p1?.canDrop).toBe(false); // b1/b2 still depend on it
    expect(p1?.dropBlockedReason).toContain('agent-b (b1)');
  });

  it('a swap edit changes effectiveAgentName but not dropped', () => {
    const model = buildTeamReviewModel(PLAN, [swapEdit('p1', 'agent-z')]);
    const p1 = model.phases[0]?.rows[0];
    expect(p1?.dropped).toBe(false);
    expect(p1?.effectiveAgentName).toBe('agent-z');
  });

  it('a drop edit sets dropped and clears effectiveAgentName', () => {
    const model = buildTeamReviewModel(PLAN, [dropEdit('r1')]);
    const r1 = model.phases[2]?.rows[0];
    expect(r1?.dropped).toBe(true);
    expect(r1?.effectiveAgentName).toBeUndefined();
  });

  it('an add edit appears under its phase as an AddedAssignmentRow, not among the original rows', () => {
    const model = buildTeamReviewModel(PLAN, [addEdit('add-1', 'build', 'agent-e', 'extra tests', ['p1'])]);
    const buildGroup = model.phases[1];
    expect(buildGroup?.rows).toHaveLength(2); // b1, b2 unchanged
    expect(buildGroup?.added).toEqual([
      { key: 'add-1', phaseId: 'build', agentName: 'agent-e', objective: 'extra tests', dependsOn: ['p1'] },
    ]);
  });

  it('operations reflects every pending edit, in the order they were made, as plain TeamOperations', () => {
    const edits: PendingTeamEdit[] = [
      dropEdit('r1'),
      swapEdit('b2', 'agent-z'),
      addEdit('add-1', 'review', 'agent-e', 'final check', ['b1']),
    ];
    const model = buildTeamReviewModel(PLAN, edits);
    expect(model.operations).toEqual([
      { op: 'drop', assignmentId: 'r1' },
      { op: 'swap', assignmentId: 'b2', agentName: 'agent-z' },
      { op: 'add', phaseId: 'review', agentName: 'agent-e', objective: 'final check', dependsOn: ['b1'] },
    ]);
  });

  it('dropping a whole dependent chain together produces a model where the root is unblocked', () => {
    const model = buildTeamReviewModel(PLAN, [dropEdit('b1'), dropEdit('b2'), dropEdit('p1')]);
    const p1 = model.phases[0]?.rows[0];
    expect(p1?.dropped).toBe(true);
    expect(p1?.canDrop).toBe(true);
    expect(p1?.dropBlockedReason).toBeUndefined();
  });
});

describe('describeEdit — the plain-language summary shown in the pending-edits list', () => {
  it('describes a drop by the original agent and assignment id', () => {
    expect(describeEdit(dropEdit('p1'), PLAN)).toBe('Drop agent-a (p1).');
  });

  it('describes a swap by original agent, id, and the new agent', () => {
    expect(describeEdit(swapEdit('b1', 'agent-z'), PLAN)).toBe('Swap agent-b (b1) for agent-z.');
  });

  it('describes an add by agent and phase name', () => {
    expect(describeEdit(addEdit('add-1', 'review', 'agent-e', 'final check', []), PLAN)).toBe(
      'Add agent-e to "Review".',
    );
  });

  it('falls back to the raw id if an edit somehow names an assignment no longer in the plan', () => {
    expect(describeEdit(dropEdit('ghost'), PLAN)).toBe('Drop ghost (ghost).');
  });
});
