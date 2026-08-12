import { describe, expect, it } from 'vitest';
import type { RunPlan, TeamOperation } from '@agent-office/shared';
import { applyTeamOperations } from './team.js';

/**
 * `applyTeamOperations` (FR-M11) is the one function standing between a POST
 * body the browser sent and a `RunPlan` the dispatcher will execute for real
 * money. These tests are organised around the three things its own doc
 * comment promises — pure, non-mutating, total — plus one section per verb,
 * because a defect in any one of those promises would be a defect a user
 * could trigger simply by clicking "approve" on an edited team.
 */

const KNOWN_AGENTS = new Set(['alpha', 'beta', 'gamma', 'delta']);

/**
 * Two phases, three assignments, one real dependency edge — small enough to
 * read at a glance, shaped enough (a fan-in from `lead`) to exercise the
 * `drop` dependent-refusal and the `add` earlier-phase rule.
 */
function basePlan(): RunPlan {
  return {
    summary: 'Investigate and review.',
    domain: 'software',
    reportStyle: 'engineering',
    phases: [
      {
        id: 'analysis',
        name: 'Analysis',
        parallel: false,
        assignments: [
          {
            id: 'lead',
            agentName: 'alpha',
            objective: 'Produce the primary analysis.',
            deliverable: 'reports/01-alpha.md',
            dependsOn: [],
          },
        ],
      },
      {
        id: 'review',
        name: 'Review',
        parallel: true,
        assignments: [
          {
            id: 'review-1',
            agentName: 'beta',
            objective: 'Review the analysis.',
            deliverable: 'reports/02-beta.md',
            dependsOn: ['lead'],
          },
          {
            id: 'review-2',
            agentName: 'gamma',
            objective: 'Review the analysis again.',
            deliverable: 'reports/03-gamma.md',
            dependsOn: ['lead'],
          },
        ],
      },
    ],
  };
}

function expectOk(result: { plan: RunPlan } | { error: string }): RunPlan {
  if ('error' in result) throw new Error(`expected success, got error: ${result.error}`);
  return result.plan;
}

function expectError(result: { plan: RunPlan } | { error: string }): string {
  if (!('error' in result)) throw new Error('expected an error, got a plan');
  return result.error;
}

describe('applyTeamOperations — purity and totality', () => {
  it('never mutates the input plan, even across a batch of every verb', () => {
    // If this were violated, the caller in `runner.ts` — which reads `plan`
    // again after the call to keep synthesis and design in sync — would see
    // its pre-approval snapshot silently altered underneath it, and any log
    // line or persisted `run.json` written before this call (e.g. the
    // `awaiting_approval` snapshot the client rendered the proposed team
    // from) would retroactively disagree with what actually happened.
    const plan = basePlan();
    const before = JSON.parse(JSON.stringify(plan)) as RunPlan;

    applyTeamOperations(
      plan,
      [
        { op: 'swap', assignmentId: 'review-1', agentName: 'delta' },
        { op: 'drop', assignmentId: 'review-2' },
        { op: 'add', phaseId: 'review', agentName: 'gamma', objective: 'New objective.', dependsOn: ['lead'] },
      ],
      KNOWN_AGENTS,
    );

    expect(plan).toEqual(before);
  });

  it('is total: an empty operations list is a no-op that still returns a plan', () => {
    // FR-M11's contract: "an empty operations array means the Manager's team
    // is right, go." If this ever threw or errored, approving the plan
    // as-proposed — the overwhelmingly common case — would be the one path
    // that fails.
    const plan = basePlan();
    const result = applyTeamOperations(plan, [], KNOWN_AGENTS);
    expect(expectOk(result)).toEqual(plan);
  });

  it('never throws across a battery of malformed operations', () => {
    // "Total" is a promise about every input, not just the ones covered by
    // the more specific tests below. `runner.ts` and the (separately owned)
    // HTTP layer both rely on this function reporting failure as a return
    // value rather than an exception; a stray throw here would either crash
    // the run outside its own try/catch's expectations or, at the HTTP
    // layer, turn a 400 into a 500.
    const plan = basePlan();
    const badOps: TeamOperation[] = [
      { op: 'drop', assignmentId: 'does-not-exist' },
      { op: 'swap', assignmentId: 'does-not-exist', agentName: 'alpha' },
      { op: 'swap', assignmentId: 'lead', agentName: 'no-such-agent' },
      { op: 'add', phaseId: 'no-such-phase', agentName: 'alpha', objective: 'x' },
      { op: 'add', phaseId: 'review', agentName: 'no-such-agent', objective: 'x' },
      { op: 'add', phaseId: 'analysis', agentName: 'alpha', objective: 'x', dependsOn: ['ghost'] },
    ];

    for (const op of badOps) {
      expect(() => applyTeamOperations(plan, [op], KNOWN_AGENTS)).not.toThrow();
      expect(applyTeamOperations(plan, [op], KNOWN_AGENTS)).toHaveProperty('error');
    }
  });

  it('applies operations in order, so a later one sees an earlier one\'s effect', () => {
    // The wire contract has no "replace assignment" verb; dropping and
    // re-adding is how a client expresses that. If operations were applied
    // against the ORIGINAL plan instead of threaded through, this sequence
    // would either fail (the drop and the add both trying to reason about a
    // plan that still has the old assignment) or silently end up with both
    // the dropped and the re-added assignment present.
    const plan = basePlan();
    const result = expectOk(
      applyTeamOperations(
        plan,
        [
          { op: 'drop', assignmentId: 'review-2' },
          {
            op: 'add',
            phaseId: 'review',
            agentName: 'delta',
            objective: 'Take over the second review.',
            dependsOn: ['lead'],
          },
        ],
        KNOWN_AGENTS,
      ),
    );

    const reviewIds = result.phases.find((p) => p.id === 'review')?.assignments.map((a) => a.id);
    expect(reviewIds).toEqual(['review-1', 'delta']);
  });
});

describe('applyTeamOperations — swap', () => {
  it('replaces the agent and renames the deliverable to the new agent, leaving objective and dependsOn untouched', () => {
    // This pins the fix for the hand-found defect: a swap used to leave
    // `deliverable` pointing at the ORIGINAL agent's filename
    // (`reports/02-beta.md` staying that even after swapping in `delta`),
    // which is not cosmetic — it is the run's own artifacts (the reports
    // directory, the listing, the PDF) misattributing the work to whoever
    // was swapped OUT. `objective` and `dependsOn` still must not move,
    // which remains the actual distinction between `swap` and drop-plus-add:
    // if `swap` touched `dependsOn`, any assignment consuming this one's
    // report (`loadUpstreamReports` in dispatcher.ts) could silently lose
    // its upstream data.
    const plan = basePlan();
    const result = expectOk(
      applyTeamOperations(plan, [{ op: 'swap', assignmentId: 'review-1', agentName: 'delta' }], KNOWN_AGENTS),
    );

    const swapped = result.phases[1]?.assignments.find((a) => a.id === 'review-1');
    expect(swapped?.agentName).toBe('delta');
    expect(swapped?.objective).toBe('Review the analysis.');
    expect(swapped?.dependsOn).toEqual(['lead']);
    // The NN prefix ("02") is preserved — it encodes the assignment's
    // position in the plan, which a swap does not change — while the agent
    // name portion is replaced to match who now actually does the work. See
    // `deriveSwapDeliverable`'s comment in team.ts.
    expect(swapped?.deliverable).toBe('reports/02-delta.md');
  });

  it('renames the deliverable to a unique path when the naive rename would collide with an existing one (SEC-08)', () => {
    // The exact risk `applySwap`'s old comment cited for never renaming at
    // all: `plan.ts`'s `RunPlanSchema.superRefine` (SEC-08) now refuses two
    // assignments sharing a deliverable, so a naive rename that landed on a
    // path already claimed elsewhere in the plan would turn a cosmetic fix
    // into a plan the schema rejects outright — or, if nothing enforced
    // uniqueness at all, two assignments racing to write the same file
    // (`store.writeReport`'s own failure mode). Engineer that collision
    // directly: give `review-2` the exact path `review-1`'s naive,
    // NN-preserving rename to "delta" would also want
    // (`reports/02-delta.md`, `review-1`'s own NN with the new agent's
    // name), so the fallback path this test pins is unavoidable rather than
    // coincidental.
    const plan = basePlan();
    const collidingPlan: RunPlan = {
      ...plan,
      phases: plan.phases.map((phase) =>
        phase.id === 'review'
          ? {
              ...phase,
              assignments: phase.assignments.map((a) =>
                a.id === 'review-2' ? { ...a, deliverable: 'reports/02-delta.md' } : a,
              ),
            }
          : phase,
      ),
    };
    const result = expectOk(
      applyTeamOperations(
        collidingPlan,
        [{ op: 'swap', assignmentId: 'review-1', agentName: 'delta' }],
        KNOWN_AGENTS,
      ),
    );

    const swapped = result.phases[1]?.assignments.find((a) => a.id === 'review-1');
    const untouched = result.phases[1]?.assignments.find((a) => a.id === 'review-2');
    // The naive rename (`reports/02-delta.md`) is exactly what `review-2` now
    // occupies, so the swap must fall back to a disambiguated path instead —
    // not the same string, and still following the documented suffix scheme.
    expect(swapped?.deliverable).not.toBe('reports/02-delta.md');
    expect(swapped?.deliverable).toBe('reports/02-delta-2.md');
    expect(untouched?.deliverable).toBe('reports/02-delta.md');
    // The two deliverables in the resulting plan must be unique — this is
    // the actual guarantee SEC-08's schema will enforce; asserting it here
    // pins the fix independent of that schema also being exercised.
    const allDeliverables = result.phases.flatMap((p) => p.assignments.map((a) => a.deliverable));
    expect(new Set(allDeliverables).size).toBe(allDeliverables.length);
  });

  it('falls back to the planner numbering scheme when the old deliverable has no recoverable NN prefix', () => {
    // `deriveSwapDeliverable` reads a runtime `RunPlan`, which — like
    // `deriveDeliverable`'s own doc comment stresses for `add` — is
    // untrusted in the FR-M3 sense: it can be a hand-built fixture or an
    // LLM's plan that does not actually follow the `NN-agent.md` convention
    // it was instructed to use. If the swap's rename logic could not handle
    // that, the fix for the original defect would trade a stale filename for
    // a thrown exception, which is strictly worse for `applyTeamOperations`'s
    // documented TOTAL guarantee.
    const plan = basePlan();
    const noPrefixPlan: RunPlan = {
      ...plan,
      phases: plan.phases.map((phase) =>
        phase.id === 'review'
          ? {
              ...phase,
              assignments: phase.assignments.map((a) =>
                a.id === 'review-1' ? { ...a, deliverable: 'reports/notes.md' } : a,
              ),
            }
          : phase,
      ),
    };
    const result = expectOk(
      applyTeamOperations(noPrefixPlan, [{ op: 'swap', assignmentId: 'review-1', agentName: 'delta' }], KNOWN_AGENTS),
    );
    const swapped = result.phases[1]?.assignments.find((a) => a.id === 'review-1');
    // Falls back to `deriveDeliverable`'s own numbering: 3 assignments exist
    // already (lead, review-1, review-2), so the next number is 04.
    expect(swapped?.deliverable).toBe('reports/04-delta.md');
  });

  it('refuses to swap in an agent the registry does not know (FR-M3)', () => {
    // Without this, the approval route would be a second, unvalidated way to
    // put a hallucinated agent name into a plan — exactly what FR-M3's
    // registry check on the Manager's own output exists to prevent.
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(plan, [{ op: 'swap', assignmentId: 'review-1', agentName: 'ghost' }], KNOWN_AGENTS),
    );
    expect(error).toMatch(/ghost/);
  });

  it('refuses to swap an assignment id that is not in the plan', () => {
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(plan, [{ op: 'swap', assignmentId: 'ghost', agentName: 'alpha' }], KNOWN_AGENTS),
    );
    expect(error).toMatch(/ghost/);
  });
});

describe('applyTeamOperations — drop', () => {
  it('removes the assignment when nothing depends on it', () => {
    const plan = basePlan();
    const result = expectOk(applyTeamOperations(plan, [{ op: 'drop', assignmentId: 'review-2' }], KNOWN_AGENTS));

    const ids = result.phases.flatMap((p) => p.assignments.map((a) => a.id));
    expect(ids).toEqual(['lead', 'review-1']);
  });

  it('refuses, naming the dependents, when another assignment still depends on it', () => {
    // Cascading the drop onto `review-1` and `review-2` (both of which
    // depend on `lead`) would delete work the user never asked to lose.
    // Naming the dependents in the error is what makes this a decision the
    // user can act on rather than a silent no-op or a silent cascade.
    const plan = basePlan();
    const error = expectError(applyTeamOperations(plan, [{ op: 'drop', assignmentId: 'lead' }], KNOWN_AGENTS));
    expect(error).toMatch(/review-1/);
    expect(error).toMatch(/review-2/);
  });

  it('refuses an unknown assignment id', () => {
    const plan = basePlan();
    const error = expectError(applyTeamOperations(plan, [{ op: 'drop', assignmentId: 'ghost' }], KNOWN_AGENTS));
    expect(error).toMatch(/ghost/);
  });

  it('lets a drop resolve a dependent first, then the dependency, in the same request', () => {
    // Order-dependence again, from the drop side this time: dropping
    // `review-1` and `review-2` before `lead` must succeed even though
    // dropping `lead` alone (with the reviewers still present) is refused
    // above — by the time `lead` is dropped, nothing in the WORKING plan
    // depends on it any more.
    const plan = basePlan();
    const result = expectOk(
      applyTeamOperations(
        plan,
        [
          { op: 'drop', assignmentId: 'review-1' },
          { op: 'drop', assignmentId: 'review-2' },
          { op: 'add', phaseId: 'analysis', agentName: 'beta', objective: 'Stand in for the whole team.' },
        ],
        KNOWN_AGENTS,
      ),
    );
    const ids = result.phases.flatMap((p) => p.assignments.map((a) => a.id));
    expect(ids).toEqual(['lead', 'beta']);
  });

  it('refuses a sequence of drops that would leave the plan with nothing to dispatch', () => {
    // FR-M11's last guarantee: a run with zero assignments would reach
    // `dispatchResult.completed === 0` and fail with a confusing "no
    // assignment produced a report" — this refusal turns that into an error
    // that says what actually happened, at the point the user caused it.
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(
        plan,
        [
          { op: 'drop', assignmentId: 'review-1' },
          { op: 'drop', assignmentId: 'review-2' },
          { op: 'drop', assignmentId: 'lead' },
        ],
        KNOWN_AGENTS,
      ),
    );
    expect(error).toMatch(/no assignments left|nothing to dispatch/);
  });

  it('allows a phase to end up with no assignments, as long as the whole plan is not empty', () => {
    // Documented in `applyDrop`: `PhaseSpecSchema` normally requires at least
    // one assignment per phase, but this function does not re-enforce that
    // per-phase — an empty phase is inert to the dispatcher
    // (`assignmentsInPhase` returns `[]`, `runPool` has nothing to do), and
    // refusing the drop or silently deleting the phase would both be doing
    // more than the user asked.
    const plan = basePlan();
    const result = expectOk(
      applyTeamOperations(
        plan,
        [
          { op: 'drop', assignmentId: 'review-1' },
          { op: 'drop', assignmentId: 'review-2' },
        ],
        KNOWN_AGENTS,
      ),
    );
    const reviewPhase = result.phases.find((p) => p.id === 'review');
    expect(reviewPhase?.assignments).toEqual([]);
  });
});

describe('applyTeamOperations — add', () => {
  it('appends to the named phase with a deliverable derived the same way the planner does', () => {
    // `manager.ts`'s planning prompt documents the convention as
    // `reports/NN-<agent-name>.md`, NN "a two-digit sequence number counted
    // across the whole plan". The base plan already has three assignments
    // (`reports/01-alpha.md`..`03-gamma.md`), so the fourth must land on 04.
    const plan = basePlan();
    const result = expectOk(
      applyTeamOperations(
        plan,
        [{ op: 'add', phaseId: 'review', agentName: 'delta', objective: 'A third opinion.' }],
        KNOWN_AGENTS,
      ),
    );

    const added = result.phases.find((p) => p.id === 'review')?.assignments.find((a) => a.agentName === 'delta');
    expect(added).toBeDefined();
    expect(added?.deliverable).toBe('reports/04-delta.md');
    expect(added?.objective).toBe('A third opinion.');
    expect(added?.dependsOn).toEqual([]);
  });

  it('accepts a dependsOn on an assignment in a strictly earlier phase', () => {
    const plan = basePlan();
    const result = expectOk(
      applyTeamOperations(
        plan,
        [{ op: 'add', phaseId: 'review', agentName: 'delta', objective: 'Reviews the lead too.', dependsOn: ['lead'] }],
        KNOWN_AGENTS,
      ),
    );
    const added = result.phases.find((p) => p.id === 'review')?.assignments.find((a) => a.agentName === 'delta');
    expect(added?.dependsOn).toEqual(['lead']);
  });

  it('refuses a dependsOn on an assignment in the SAME phase (deadlock)', () => {
    // Confirmed against `dispatcher.ts`: a phase's `runnable` assignments are
    // all handed to `runPool` together, filtered only on `status ===
    // 'pending'` — nothing in that path waits for a sibling to finish first.
    // A same-phase dependency would either race the assignment it depends on
    // (and, per `loadUpstreamReports`, silently get no upstream report at
    // all — the FR-M5 "missing report degrades the brief" failure) or simply
    // have no defined order. Refusing it here is the only option that does
    // not hide that from the user.
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(
        plan,
        [
          {
            op: 'add',
            phaseId: 'review',
            agentName: 'delta',
            objective: 'Reviews review-1.',
            dependsOn: ['review-1'],
          },
        ],
        KNOWN_AGENTS,
      ),
    );
    expect(error).toMatch(/review-1/);
    expect(error).toMatch(/earlier phase/);
  });

  it('refuses a dependsOn on an assignment in a LATER phase (forward reference)', () => {
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(
        plan,
        [
          {
            op: 'add',
            phaseId: 'analysis',
            agentName: 'delta',
            objective: 'Cannot see the future.',
            dependsOn: ['review-1'],
          },
        ],
        KNOWN_AGENTS,
      ),
    );
    expect(error).toMatch(/review-1/);
  });

  it('refuses a dependsOn on an assignment id that does not exist', () => {
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(
        plan,
        [{ op: 'add', phaseId: 'review', agentName: 'delta', objective: 'x', dependsOn: ['ghost'] }],
        KNOWN_AGENTS,
      ),
    );
    expect(error).toMatch(/ghost/);
  });

  it('refuses an unknown phase id', () => {
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(plan, [{ op: 'add', phaseId: 'ghost-phase', agentName: 'alpha', objective: 'x' }], KNOWN_AGENTS),
    );
    expect(error).toMatch(/ghost-phase/);
  });

  it('refuses an agent the registry does not know (FR-M3)', () => {
    const plan = basePlan();
    const error = expectError(
      applyTeamOperations(plan, [{ op: 'add', phaseId: 'review', agentName: 'ghost', objective: 'x' }], KNOWN_AGENTS),
    );
    expect(error).toMatch(/ghost/);
  });

  it('gives two adds of the same agent in one request distinct ids and deliverables', () => {
    // Regression target: if the id/deliverable derivation read the ORIGINAL
    // plan instead of the working plan threaded through the loop, both
    // additions would collide on `delta` / `reports/04-delta.md` — the
    // second `add` has to see the first one's effect (see the
    // order-dependence test above), and this is the case where forgetting
    // that produces a silent collision rather than an obvious failure.
    const plan = basePlan();
    const result = expectOk(
      applyTeamOperations(
        plan,
        [
          { op: 'add', phaseId: 'review', agentName: 'delta', objective: 'First delta.' },
          { op: 'add', phaseId: 'review', agentName: 'delta', objective: 'Second delta.' },
        ],
        KNOWN_AGENTS,
      ),
    );
    const added = result.phases.find((p) => p.id === 'review')?.assignments.filter((a) => a.agentName === 'delta');
    expect(added).toHaveLength(2);
    expect(added?.[0]?.id).not.toBe(added?.[1]?.id);
    expect(added?.[0]?.deliverable).not.toBe(added?.[1]?.deliverable);
    expect(added?.[0]?.deliverable).toBe('reports/04-delta.md');
    expect(added?.[1]?.deliverable).toBe('reports/05-delta.md');
  });
});
