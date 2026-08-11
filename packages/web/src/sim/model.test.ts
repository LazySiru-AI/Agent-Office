import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_BEHAVIOUR,
  ASSIGNMENT_STATUSES,
  type AssignmentState,
  type AssignmentStatus,
} from '@agent-office/shared';
import {
  appearanceFor,
  buildScene,
  buildSceneFromAssignments,
  hashName,
  layoutOffice,
  managerAnimationFor,
  managerViewFor,
  targetFor,
  MANAGER_ID,
  type OfficeLayout,
} from './model.js';

/**
 * The sim's contract, tested without a canvas.
 *
 * That this is possible at all is the design working: FR-S3 requires character
 * behaviour to be a pure function of orchestrator state, so the only thing a
 * renderer adds is pixels.
 */

function assignment(id: string, agentName: string, status: AssignmentStatus): AssignmentState {
  // Fully constructed rather than cast. A cast here would have silently hidden
  // a missing field, and if the sim ever starts reading one, these tests would
  // pass against a shape the orchestrator never produces.
  return {
    id,
    phaseId: 'phase-1',
    agentName,
    objective: 'do the thing',
    deliverable: `reports/${id}.md`,
    dependsOn: [],
    status,
    attempts: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe('layoutOffice (FR-S1)', () => {
  it('produces one desk per agent for every supported team size', () => {
    for (let n = 1; n <= 12; n += 1) {
      expect(layoutOffice(n).desks).toHaveLength(n);
    }
  });

  it('never places two desks on the same tile', () => {
    for (let n = 1; n <= 12; n += 1) {
      const layout = layoutOffice(n);
      const seen = new Set(layout.desks.map((d) => `${String(d.desk.x)},${String(d.desk.y)}`));
      expect(seen.size).toBe(n);
    }
  });

  it('keeps every desk inside the office bounds', () => {
    for (let n = 1; n <= 12; n += 1) {
      const layout = layoutOffice(n);
      for (const slot of layout.desks) {
        for (const point of [slot.desk, slot.seat, slot.approach]) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThan(layout.widthTiles);
          expect(point.y).toBeLessThan(layout.heightTiles);
        }
      }
    }
  });

  it('caps at four columns, so the walk to the Manager stays legible', () => {
    expect(layoutOffice(12).columns).toBeLessThanOrEqual(4);
    expect(layoutOffice(9).columns).toBeLessThanOrEqual(4);
  });

  it('grows in rows rather than failing beyond twelve', () => {
    const big = layoutOffice(20);
    expect(big.desks).toHaveLength(20);
    expect(big.rows).toBeGreaterThan(layoutOffice(12).rows);
  });

  it('handles an empty team without throwing', () => {
    const layout = layoutOffice(0);
    expect(layout.desks).toHaveLength(0);
    // The Manager is always present — the office exists before a plan does.
    expect(layout.managerDesk.seat).toBeDefined();
  });

  it('never puts an agent desk on top of the Manager', () => {
    for (let n = 1; n <= 12; n += 1) {
      const layout = layoutOffice(n);
      const manager = `${String(layout.managerDesk.desk.x)},${String(layout.managerDesk.desk.y)}`;
      const collisions = layout.desks.filter(
        (d) => `${String(d.desk.x)},${String(d.desk.y)}` === manager,
      );
      expect(collisions).toHaveLength(0);
    }
  });
});

describe('appearanceFor (FR-S2)', () => {
  it('is deterministic — the same agent looks the same every time', () => {
    expect(appearanceFor('code-reviewer')).toEqual(appearanceFor('code-reviewer'));
  });

  it('gives different agents different appearances', () => {
    const a = appearanceFor('code-reviewer');
    const b = appearanceFor('legal-advisor');
    expect(a).not.toEqual(b);
  });

  it('always selects real palette entries, never undefined', () => {
    const names = ['a', '', 'code-reviewer', 'security-auditor', 'zzzzzzzzzzzzzzzz'];
    for (const name of names) {
      const look = appearanceFor(name);
      expect(look.skin).toMatch(/^#[0-9a-f]{6}$/i);
      expect(look.hair).toMatch(/^#[0-9a-f]{6}$/i);
      expect(look.shirt).toMatch(/^#[0-9a-f]{6}$/i);
      expect(look.trousers).toMatch(/^#[0-9a-f]{6}$/i);
      expect(Number.isInteger(look.body)).toBe(true);
    }
  });

  it('spreads a realistic roster across the shirt palette rather than clustering', () => {
    // A hash that fed correlated bits into every slot would look deterministic
    // and still produce an office where everyone wears the same shirt.
    const names = Array.from({ length: 60 }, (_, i) => `agent-number-${String(i)}`);
    const shirts = new Set(names.map((n) => appearanceFor(n).shirt));
    expect(shirts.size).toBeGreaterThan(3);
  });

  it('hashes stably and stays within 32 bits', () => {
    expect(hashName('code-reviewer')).toBe(hashName('code-reviewer'));
    expect(hashName('a')).not.toBe(hashName('b'));
    expect(hashName('x')).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('buildSceneFromAssignments (FR-S3)', () => {
  it('derives behaviour purely from assignment status', () => {
    const scene = buildSceneFromAssignments([
      assignment('a', 'code-reviewer', 'working'),
      assignment('b', 'security-auditor', 'failed'),
    ]);

    expect(scene.characters[0]?.behaviour).toEqual(ASSIGNMENT_BEHAVIOUR.working);
    expect(scene.characters[1]?.behaviour).toEqual(ASSIGNMENT_BEHAVIOUR.failed);
  });

  it('covers every assignment status without a gap', () => {
    // A status with no behaviour would render as a frozen character, which is
    // exactly the drift FR-S3 exists to prevent. The list under test must be
    // the canonical `ASSIGNMENT_STATUSES` (shared/src/status.ts), not
    // `Object.keys(ASSIGNMENT_BEHAVIOUR)` — deriving the expected set from the
    // very map being checked means a status missing from that map is also
    // missing from the check, so the test can never observe the gap it
    // claims to guard against. `status.test.ts:105`'s "animation binding"
    // describe block does the equivalent check the same way, for the same
    // reason.
    const statuses = ASSIGNMENT_STATUSES;
    const scene = buildSceneFromAssignments(
      statuses.map((status, i) => assignment(`a${String(i)}`, `agent-${status}`, status)),
    );

    expect(scene.characters).toHaveLength(statuses.length);
    for (const character of scene.characters) {
      expect(character.behaviour).toBeDefined();
      expect(character.target).toBeDefined();
    }
  });

  it('sends reporting and briefing characters to the Manager, and everyone else to their desk', () => {
    const scene = buildSceneFromAssignments([
      assignment('a', 'one', 'reporting'),
      assignment('b', 'two', 'working'),
      assignment('c', 'three', 'briefing'),
    ]);

    const manager = scene.layout.managerDesk.approach;
    expect(scene.characters[0]?.target).toEqual(manager);
    expect(scene.characters[2]?.target).toEqual(manager);
    expect(scene.characters[1]?.target).toEqual(scene.characters[1]?.home.seat);
  });

  it('is a pure function — same input, same scene', () => {
    const input = [assignment('a', 'code-reviewer', 'working')];
    expect(buildSceneFromAssignments(input)).toEqual(buildSceneFromAssignments(input));
  });

  it('handles a run with no assignments yet (planning)', () => {
    const scene = buildSceneFromAssignments([]);
    expect(scene.characters).toHaveLength(0);
    expect(scene.layout.managerDesk).toBeDefined();
  });
});

describe('targetFor', () => {
  const layout: OfficeLayout = layoutOffice(2);

  it('resolves every location the behaviour table can produce', () => {
    const home = layout.desks[0];
    if (home === undefined) throw new Error('expected a desk');

    const locations = new Set(Object.values(ASSIGNMENT_BEHAVIOUR).map((b) => b.location));
    for (const location of locations) {
      const point = targetFor({ animation: 'idle', location, bubble: 'none', carrying: false }, home, layout);
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-S14 — the desk at the head of the room finally has someone at it
// ---------------------------------------------------------------------------

describe('the Manager (FR-S14)', () => {
  it('is present in every scene, including an empty one', () => {
    // The office drew a Manager's desk from Phase 4 and never put anyone behind
    // it, so the interaction the whole sim is built around — agents walking up
    // to be briefed and back to report — had no other party in it. A run with
    // no assignments yet is exactly when the Manager is the only thing on
    // screen, so "empty run" is the case that must not be the exception.
    expect(buildSceneFromAssignments([]).manager).toBeDefined();
    expect(buildSceneFromAssignments([assignment('a', 'coder', 'working')]).manager).toBeDefined();
  });

  it('sits at the head desk, against the wall and centred', () => {
    // Both halves carry meaning. Centred is what makes every agent's walk to it
    // symmetrical rather than favouring one side of the floor; against the wall
    // is what makes it read as the head of the room instead of one more desk
    // that happens to be at the front.
    for (const n of [0, 1, 4, 9, 12]) {
      const layout = layoutOffice(n);
      const manager = managerViewFor(layout, 'running');
      expect(manager.desk).toEqual(layout.managerDesk.desk);
      expect(manager.seat).toEqual(layout.managerDesk.seat);
      expect(manager.desk.y, `n=${String(n)}: desk should sit on the wall's last row`).toBe(
        layout.wallRows,
      );
      expect(manager.desk.x).toBe(Math.floor(layout.widthTiles / 2));
    }
  });

  it('leaves the whole approach lane clear of the first row of desks', () => {
    // The reporting walk ends on `managerDesk.approach`, and an agent standing
    // there must not be standing on someone else's desk. Nothing pinned this
    // before, which is how the top band could be re-sized from 5 tiles to 8
    // without a single test noticing.
    for (let n = 1; n <= 12; n += 1) {
      const layout = layoutOffice(n);
      const firstDeskRow = Math.min(...layout.desks.map((d) => d.desk.y));
      expect(
        layout.managerDesk.approach.y,
        `n=${String(n)}: the approach tile collides with the first desk row`,
      ).toBeLessThan(firstDeskRow);
    }
  });

  it('takes a reserved id that no assignment can produce', () => {
    // Every map, hit test and selection path in the renderer is keyed by
    // assignment id. A Manager sharing that namespace would make clicking it
    // open an inspect panel for an assignment that does not exist.
    expect(MANAGER_ID.startsWith('@')).toBe(true);
    const scene = buildSceneFromAssignments([assignment('a', 'coder', 'working')]);
    expect(scene.characters.map((c) => c.assignmentId)).not.toContain(scene.manager.id);
  });

  it('looks the same in every run, like every other character', () => {
    // FR-S2 applies to the Manager too: its appearance is derived from its name
    // rather than fixed as set dressing, so it is a person in the office who
    // stays recognisable across runs and restarts.
    const a = managerViewFor(layoutOffice(3), 'running');
    const b = managerViewFor(layoutOffice(7), 'done');
    expect(a.appearance).toEqual(b.appearance);
    expect(a.appearance).toEqual(appearanceFor(a.name));
  });

  it('reflects what the run is doing, and never invents a state', () => {
    expect(managerAnimationFor('planning')).toBe('read');
    expect(managerAnimationFor('synthesizing')).toBe('read');
    expect(managerAnimationFor('running')).toBe('type');
    expect(managerAnimationFor('done')).toBe('idle_relaxed');
    expect(managerAnimationFor('failed')).toBe('idle_slumped');
    // A cancelled run gets `idle`, not `idle_slumped`, for exactly the reason a
    // cancelled assignment does: nothing went wrong, the work simply stopped
    // being wanted, and the office must not show a defeated Manager because the
    // user pressed Cancel.
    expect(managerAnimationFor('cancelled')).toBe('idle');
    expect(managerAnimationFor('queued')).toBe('idle');
    expect(managerAnimationFor(undefined)).toBe('idle');
  });

  it('picks up the run status without the caller having to pass it', () => {
    // `buildScene` injects it from the run it was already given. Requiring
    // every caller to copy one field onto the context would be one more thing
    // to forget, and the failure — a Manager idle through a live run — reads as
    // a rendering bug rather than as a missing argument.
    const run = {
      id: 'run-1',
      task: 'do the thing',
      status: 'running' as const,
      createdAt: 0,
      updatedAt: 0,
      assignments: [assignment('a', 'coder', 'working')],
    };
    expect(buildScene(run).manager.animation).toBe('type');
    expect(buildScene({ ...run, status: 'done' as const }).manager.animation).toBe('idle_relaxed');
    expect(buildScene(undefined).manager.animation).toBe('idle');
  });
});

describe('the room is drawn landscape, not desk-shaped (FR-S13)', () => {
  it('is always wider than it is tall, at every team size', () => {
    // Not cosmetic. `scene.ts` scales by the largest WHOLE number that fits and
    // discards the remainder, so a portrait room in a landscape pane wastes
    // most of a scale step: measured at five agents in a 1055x718 host, a
    // 256x288 world rendered at 2x and filled 512 of 1055 pixels. Matching the
    // room's shape to the pane's makes both axes bind at once.
    for (let n = 0; n <= 20; n += 1) {
      const layout = layoutOffice(n);
      expect(
        layout.widthTiles,
        `n=${String(n)}: ${String(layout.widthTiles)}x${String(layout.heightTiles)} is not landscape`,
      ).toBeGreaterThan(layout.heightTiles);
    }
  });

  it('still leaves the desk grid centred, so the extra width is floor on both sides', () => {
    // The point of the width is open floor for the lounge furniture to stand
    // on, down both sides of the desks. If widening had pushed the grid to one
    // edge it would have bought a wider room and lost a symmetrical one.
    for (const n of [1, 5, 12]) {
      const layout = layoutOffice(n);
      const xs = layout.desks.map((d) => d.desk.x);
      const midpoint = (Math.min(...xs) + Math.max(...xs)) / 2;
      // Within one desk spacing of the room's centre line, which is as exact as
      // an integer grid holding an even or odd number of columns can be.
      expect(Math.abs(midpoint - layout.widthTiles / 2)).toBeLessThanOrEqual(2);
    }
  });
});
