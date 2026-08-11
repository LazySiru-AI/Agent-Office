import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_BEHAVIOUR,
  ASSIGNMENT_STATUSES,
  type AssignmentState,
  type AssignmentStatus,
} from '@agent-office/shared';
import {
  appearanceFor,
  buildSceneFromAssignments,
  hashName,
  layoutOffice,
  targetFor,
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
