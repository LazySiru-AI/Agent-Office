import { describe, expect, it } from 'vitest';
import { TILE } from './model.js';
import {
  ARRIVAL_EPSILON_TILES,
  canvasToWorld,
  computeViewport,
  hasArrived,
  hitTest,
  nextAnimationFrame,
  resolveFacing,
  stepTowards,
  tileToPixel,
  worldToCanvas,
  type HitTestEntity,
} from './scene.js';

/**
 * The renderer's testable core (see the header comment in `scene.ts`).
 *
 * Vitest runs this suite in plain Node with no DOM and no WebGL, so nothing
 * here constructs an `OfficeSceneRenderer` or a Pixi `Application` — only the
 * plain functions that class delegates to for geometry and timing, which is
 * deliberately everything about the renderer that has a "correct answer" a
 * test can check.
 */

describe('tileToPixel', () => {
  it('scales tile coordinates by the tile size', () => {
    expect(tileToPixel({ x: 2, y: 3 })).toEqual({ x: 2 * TILE, y: 3 * TILE });
  });

  it('accepts a custom tile size', () => {
    expect(tileToPixel({ x: 2, y: 3 }, 10)).toEqual({ x: 20, y: 30 });
  });

  it('handles the origin and negative tiles', () => {
    expect(tileToPixel({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(tileToPixel({ x: -1, y: -2 })).toEqual({ x: -TILE, y: -2 * TILE });
  });
});

describe('stepTowards (FR-S6 walking)', () => {
  it('moves partway towards the target, not all the way, within a small time slice', () => {
    const next = stepTowards({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.1, 4);
    expect(next.x).toBeCloseTo(0.4, 5);
    expect(next.y).toBeCloseTo(0, 5);
    expect(next.x).toBeLessThan(10);
  });

  it('snaps to the target rather than overshooting when the step is larger than the remaining distance', () => {
    const next = stepTowards({ x: 9.9, y: 0 }, { x: 10, y: 0 }, 1, 4);
    expect(next).toEqual({ x: 10, y: 0 });
  });

  it('does nothing when already at the target', () => {
    const next = stepTowards({ x: 5, y: 5 }, { x: 5, y: 5 }, 0.5, 4);
    expect(next).toEqual({ x: 5, y: 5 });
  });

  it('moves diagonally in a straight line towards the target', () => {
    const next = stepTowards({ x: 0, y: 0 }, { x: 3, y: 4 }, 1, 5); // 3-4-5 triangle, distance 5, speed 5 -> arrives
    expect(next).toEqual({ x: 3, y: 4 });
  });

  it('produces no movement for a non-positive time slice', () => {
    const next = stepTowards({ x: 0, y: 0 }, { x: 10, y: 0 }, 0, 4);
    expect(next).toEqual({ x: 0, y: 0 });
  });

  it('re-routes from wherever it currently is when the target changes mid-walk, rather than restarting from the origin', () => {
    // Walk a third of the way towards A...
    const afterFirstLeg = stepTowards({ x: 0, y: 0 }, { x: 12, y: 0 }, 1, 4);
    expect(afterFirstLeg).toEqual({ x: 4, y: 0 });

    // ...then the assignment flips status and the target becomes B. The next
    // step must depart from the character's current position (4, 0), not
    // from (0, 0) or from A — there is no hidden "path" to unwind.
    const afterRetarget = stepTowards(afterFirstLeg, { x: 4, y: 8 }, 1, 4);
    expect(afterRetarget).toEqual({ x: 4, y: 4 });

    // A third target change re-routes again, from (4, 4).
    const afterSecondRetarget = stepTowards(afterRetarget, { x: 0, y: 4 }, 1, 4);
    expect(afterSecondRetarget).toEqual({ x: 0, y: 4 });
  });
});

describe('hasArrived', () => {
  it('is false while outside the epsilon', () => {
    expect(hasArrived({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(false);
  });

  it('is true once within the epsilon', () => {
    expect(hasArrived({ x: 0, y: 0 }, { x: ARRIVAL_EPSILON_TILES / 2, y: 0 })).toBe(true);
  });

  it('is true exactly at the target', () => {
    expect(hasArrived({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(true);
  });

  it('respects a custom epsilon', () => {
    expect(hasArrived({ x: 0, y: 0 }, { x: 1, y: 0 }, 2)).toBe(true);
  });
});

describe('resolveFacing', () => {
  it('faces right when moving in +x', () => {
    expect(resolveFacing({ x: 0, y: 0 }, { x: 1, y: 0 }, 'down')).toBe('right');
  });

  it('faces left when moving in -x', () => {
    expect(resolveFacing({ x: 1, y: 0 }, { x: 0, y: 0 }, 'down')).toBe('left');
  });

  it('faces down when moving in +y', () => {
    expect(resolveFacing({ x: 0, y: 0 }, { x: 0, y: 1 }, 'left')).toBe('down');
  });

  it('faces up when moving in -y', () => {
    expect(resolveFacing({ x: 0, y: 1 }, { x: 0, y: 0 }, 'left')).toBe('up');
  });

  it('picks the dominant axis on a diagonal move', () => {
    expect(resolveFacing({ x: 0, y: 0 }, { x: 3, y: 1 }, 'down')).toBe('right');
    expect(resolveFacing({ x: 0, y: 0 }, { x: 1, y: 3 }, 'right')).toBe('down');
  });

  it('keeps the fallback facing when there is no meaningful movement', () => {
    expect(resolveFacing({ x: 5, y: 5 }, { x: 5, y: 5 }, 'left')).toBe('left');
  });
});

describe('nextAnimationFrame', () => {
  it('holds the current frame until the frame duration has elapsed', () => {
    const state = nextAnimationFrame(0, 4, 0, 50);
    expect(state).toEqual({ frameIndex: 0, elapsedMs: 50 });
  });

  it('advances exactly one frame once the duration is crossed', () => {
    const state = nextAnimationFrame(0, 4, 100, 60); // 150ms duration, 100+60=160
    expect(state.frameIndex).toBe(1);
    expect(state.elapsedMs).toBeCloseTo(10, 5);
  });

  it('wraps around the end of the loop', () => {
    const state = nextAnimationFrame(3, 4, 0, 150);
    expect(state.frameIndex).toBe(0);
  });

  it('advances multiple frames after a large delta (e.g. tab resumed from background)', () => {
    const state = nextAnimationFrame(0, 4, 0, 150 * 5 + 20); // five frame-durations plus a bit
    expect(state.frameIndex).toBe(1); // (0 + 5) % 4 = 1
    expect(state.elapsedMs).toBeCloseTo(20, 5);
  });

  it('is a no-op for zero animation frames rather than dividing by zero', () => {
    expect(nextAnimationFrame(0, 0, 0, 500)).toEqual({ frameIndex: 0, elapsedMs: 0 });
  });
});

describe('computeViewport (pixel-art scaling and letterboxing)', () => {
  it('picks the largest integer scale that fits the container', () => {
    // World is 100x100px; container is 350x220px -> scale 2 fits both axes (3 would overflow height).
    const viewport = computeViewport(350, 220, 100, 100);
    expect(viewport.scale).toBe(2);
  });

  it('never scales below 1x even when the container is smaller than the world', () => {
    const viewport = computeViewport(50, 50, 200, 200);
    expect(viewport.scale).toBe(1);
  });

  it('centres the scaled world in the container (letterboxing)', () => {
    const viewport = computeViewport(320, 200, 100, 100); // scale 2 -> 200x200 world, 320x200 container
    expect(viewport.scale).toBe(2);
    expect(viewport.offsetX).toBe(Math.floor((320 - 200) / 2));
    expect(viewport.offsetY).toBe(Math.floor((200 - 200) / 2));
  });

  it('degrades to an identity viewport for degenerate (zero or negative) sizes', () => {
    expect(computeViewport(0, 100, 100, 100)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(computeViewport(100, 100, 0, 100)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(computeViewport(-10, 100, 100, 100)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });
});

describe('canvasToWorld / worldToCanvas', () => {
  it('are inverses of one another', () => {
    const viewport = computeViewport(320, 200, 100, 100);
    const world = { x: 37, y: 12 };
    const canvas = worldToCanvas(world, viewport);
    const back = canvasToWorld(canvas, viewport);
    expect(back.x).toBeCloseTo(world.x, 5);
    expect(back.y).toBeCloseTo(world.y, 5);
  });

  it('maps the world origin to the letterbox offset', () => {
    const viewport = { scale: 3, offsetX: 10, offsetY: 20 };
    expect(worldToCanvas({ x: 0, y: 0 }, viewport)).toEqual({ x: 10, y: 20 });
  });

  it('maps a canvas point inside the letterbox bars to a coordinate outside the world', () => {
    const viewport = { scale: 2, offsetX: 50, offsetY: 0 };
    const world = canvasToWorld({ x: 10, y: 10 }, viewport); // left of the letterboxed world
    expect(world.x).toBeLessThan(0);
  });
});

describe('hitTest (FR-S5 inspect)', () => {
  function entity(id: string, x: number, y: number, width = 12, height = 16): HitTestEntity {
    return { assignmentId: id, x, y, width, height };
  }

  it('finds the entity whose footprint box contains the point', () => {
    const entities = [entity('a', 50, 50)];
    // Box spans x:[44,56], y:[34,50] for a 12x16 footprint anchored bottom-centre.
    expect(hitTest(entities, { x: 50, y: 40 })).toBe('a');
  });

  it('misses when the point is outside every box', () => {
    const entities = [entity('a', 50, 50)];
    expect(hitTest(entities, { x: 0, y: 0 })).toBeUndefined();
  });

  it('returns undefined for an empty entity list', () => {
    expect(hitTest([], { x: 0, y: 0 })).toBeUndefined();
  });

  it('resolves overlaps in favour of the later (topmost-drawn) entity', () => {
    const entities = [entity('behind', 50, 50), entity('front', 50, 50)];
    expect(hitTest(entities, { x: 50, y: 40 })).toBe('front');
  });

  it('is inclusive of the box edges', () => {
    // Footprint anchored at (50, 50), width 12, height 16 -> box x:[44,56] y:[34,50].
    const entities = [entity('a', 50, 50)];
    expect(hitTest(entities, { x: 44, y: 34 })).toBe('a');
    expect(hitTest(entities, { x: 56, y: 50 })).toBe('a');
  });

  it('misses one pixel outside the box edge', () => {
    const entities = [entity('a', 50, 50)];
    expect(hitTest(entities, { x: 43, y: 40 })).toBeUndefined();
    expect(hitTest(entities, { x: 50, y: 33 })).toBeUndefined();
    expect(hitTest(entities, { x: 50, y: 51 })).toBeUndefined();
  });
});
