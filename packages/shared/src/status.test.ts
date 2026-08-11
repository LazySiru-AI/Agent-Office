import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_BEHAVIOUR,
  ASSIGNMENT_STATUSES,
  RUN_STATUSES,
  canTransitionAssignment,
  canTransitionRun,
  isAssignmentTerminal,
  isRunTerminal,
} from './status.js';

describe('run transitions', () => {
  it('walks the happy path', () => {
    const path = [
      'queued',
      'planning',
      'dispatching',
      'running',
      'synthesizing',
      'designing',
      'report_ready',
      'done',
    ] as const;

    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionRun(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows failure and cancellation from any non-terminal state', () => {
    for (const status of RUN_STATUSES) {
      if (isRunTerminal(status)) continue;
      expect(canTransitionRun(status, 'failed')).toBe(true);
      expect(canTransitionRun(status, 'cancelled')).toBe(true);
    }
  });

  it('allows nothing out of a terminal state', () => {
    for (const from of RUN_STATUSES.filter(isRunTerminal)) {
      for (const to of RUN_STATUSES) {
        expect(canTransitionRun(from, to)).toBe(false);
      }
    }
  });

  it('rejects skipping a stage', () => {
    expect(canTransitionRun('queued', 'running')).toBe(false);
    expect(canTransitionRun('planning', 'report_ready')).toBe(false);
  });
});

describe('assignment transitions', () => {
  it('walks the happy path', () => {
    expect(canTransitionAssignment('pending', 'briefing')).toBe(true);
    expect(canTransitionAssignment('briefing', 'working')).toBe(true);
    expect(canTransitionAssignment('working', 'reporting')).toBe(true);
    expect(canTransitionAssignment('reporting', 'done')).toBe(true);
  });

  it('supports the reviewer send-back loop (FR-M10)', () => {
    // From `done`, not from `reporting`. A reviewer runs in a later phase than
    // the work it reviews, and phases drain before the next one starts, so its
    // target is always `done` by the time a critique exists. The old
    // `reporting -> working` edge was unreachable in practice.
    // To `briefing`, because a re-dispatch is an ordinary dispatch and goes
    // through the same path as the first one.
    expect(canTransitionAssignment('done', 'briefing')).toBe(true);
    expect(canTransitionAssignment('done', 'working')).toBe(false);
    expect(canTransitionAssignment('reporting', 'working')).toBe(false);
  });

  it('lets a blocked assignment resume', () => {
    expect(canTransitionAssignment('working', 'blocked')).toBe(true);
    expect(canTransitionAssignment('blocked', 'working')).toBe(true);
  });

  it('allows nothing out of a terminal state, except the one FR-M10 revision edge', () => {
    // `done -> working` is the single documented exception, and it is written
    // into the transition table rather than granted by a general rule. Anything
    // else escaping a terminal status is a bug — most of all out of `failed` or
    // `skipped`, which must stay sealed.
    for (const from of ASSIGNMENT_STATUSES.filter(isAssignmentTerminal)) {
      for (const to of ASSIGNMENT_STATUSES) {
        const isRevisionEdge = from === 'done' && to === 'briefing';
        expect(
          canTransitionAssignment(from, to),
          `${from} -> ${to} should be ${isRevisionEdge ? 'legal' : 'illegal'}`,
        ).toBe(isRevisionEdge);
      }
    }
  });

  it('keeps failed and skipped completely sealed', () => {
    for (const to of ASSIGNMENT_STATUSES) {
      expect(canTransitionAssignment('failed', to)).toBe(false);
      expect(canTransitionAssignment('skipped', to)).toBe(false);
    }
  });

  it('rejects jumping straight from pending to done', () => {
    expect(canTransitionAssignment('pending', 'done')).toBe(false);
  });
});

describe('animation binding', () => {
  it('covers every assignment status, so the sim can never hit an unmapped state', () => {
    for (const status of ASSIGNMENT_STATUSES) {
      expect(ASSIGNMENT_BEHAVIOUR[status]).toBeDefined();
    }
  });

  it('only carries the report prop while reporting', () => {
    const carrying = ASSIGNMENT_STATUSES.filter((s) => ASSIGNMENT_BEHAVIOUR[s].carrying);
    expect(carrying).toEqual(['reporting']);
  });

  it('walks only when heading somewhere', () => {
    for (const status of ASSIGNMENT_STATUSES) {
      const b = ASSIGNMENT_BEHAVIOUR[status];
      const travelling = b.location === 'to_manager' || b.location === 'to_desk';
      expect(travelling).toBe(b.animation === 'walk');
    }
  });
});
