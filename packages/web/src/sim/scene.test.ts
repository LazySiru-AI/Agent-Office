import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_BEHAVIOUR, type AssignmentState, type AssignmentStatus, type CharacterBehaviour } from '@agent-office/shared';
import { buildSceneFromAssignments, fitPlateLines, layoutOffice, TILE, type PlateBox } from './model.js';
import { SPRITE_HEIGHT, SPRITE_WIDTH } from './spriteContract.js';
import {
  advanceErrand,
  ARRIVAL_EPSILON_TILES,
  arrivalAwareFacing,
  canvasToWorld,
  computeViewport,
  computeZoomedViewport,
  ERRAND_DWELL_MS,
  ERRAND_MAX_LIFETIME_MS,
  floorBoardShade,
  frameTextureKey,
  hasArrived,
  hitTest,
  isSeatedAt,
  isWorkGlowing,
  isZoomLevel,
  MAX_ZOOM,
  MIN_ZOOM,
  nextAnimationFrame,
  nextErrand,
  parseZoomPreference,
  PLATE_PANEL_ALPHA,
  resolveFacing,
  resolveZoom,
  roomRowKind,
  shouldAbandonErrand,
  shouldStartErrand,
  startErrand,
  stepTowards,
  tileToPixel,
  worldToCanvas,
  ZOOM_LEVELS,
  type Errand,
  type HitTestEntity,
  type ZoomLevel,
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
  // Phase 10 grew the sprite box from 12x16 to 16x24 (spriteContract.ts) so a
  // character has room for a recognisable hair shape and a seated pose; every
  // footprint box below is recomputed for that size, not the old one.
  function entity(id: string, x: number, y: number, width = SPRITE_WIDTH, height = SPRITE_HEIGHT): HitTestEntity {
    return { assignmentId: id, x, y, width, height };
  }

  it('finds the entity whose footprint box contains the point', () => {
    const entities = [entity('a', 50, 50)];
    // Box spans x:[42,58], y:[26,50] for a 16x24 footprint anchored bottom-centre.
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
    // Footprint anchored at (50, 50), width 16, height 24 -> box x:[42,58] y:[26,50].
    const entities = [entity('a', 50, 50)];
    expect(hitTest(entities, { x: 42, y: 26 })).toBe('a');
    expect(hitTest(entities, { x: 58, y: 50 })).toBe('a');
  });

  it('misses one pixel outside the box edge', () => {
    const entities = [entity('a', 50, 50)];
    expect(hitTest(entities, { x: 41, y: 40 })).toBeUndefined();
    expect(hitTest(entities, { x: 50, y: 25 })).toBeUndefined();
    expect(hitTest(entities, { x: 50, y: 51 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 10: the room has a back, the Manager has a seat, and the walk to
// report to them is finally observable on screen.
// ---------------------------------------------------------------------------

describe('roomRowKind (FR-S1 — the office needs a back, not just a floor)', () => {
  it('classifies exactly layout.wallRows rows as wall, and every row below as floor', () => {
    // Pins the one invariant `paintRoomShell` depends on without ever being
    // able to inspect the `Graphics` calls it makes (no canvas or WebGL
    // context exists in this Vitest run — see the file header). If a future
    // change to `layoutOffice`'s wall depth and this function's boundary ever
    // drifted apart, the Manager's desk (positioned against the wall at
    // `y: wallRows`) would end up sitting on top of, or floating above, the
    // wall it is supposed to be flush against.
    const layout = layoutOffice(5);
    let wallRowCount = 0;
    for (let y = 0; y < layout.heightTiles; y += 1) {
      if (roomRowKind(y, layout) === 'wall') wallRowCount += 1;
    }
    expect(wallRowCount).toBe(layout.wallRows);
  });

  it('places the boundary row itself correctly on each side', () => {
    const layout = layoutOffice(1);
    expect(roomRowKind(layout.wallRows - 1, layout)).toBe('wall');
    expect(roomRowKind(layout.wallRows, layout)).toBe('floor');
  });

  it('never classifies a negative or out-of-range row as anything but a row kind (totality)', () => {
    const layout = layoutOffice(1);
    expect(roomRowKind(-1, layout)).toBe('wall');
    expect(roomRowKind(layout.heightTiles + 100, layout)).toBe('floor');
  });
});

describe('floorBoardShade (brick-bond floorboards, not a checkerboard)', () => {
  const layout = layoutOffice(2);

  it('alternates shade along one row of boards, two tiles at a time', () => {
    // A 2-tile-wide board means adjacent COLUMNS only flip shade every other
    // tile, not every tile — the tell that distinguishes a plank floor from
    // the single-tile checkerboard this replaced.
    const row = layout.wallRows;
    const shades = [0, 1, 2, 3, 4, 5].map((x) => floorBoardShade(x, row, layout));
    expect(shades).toEqual(['light', 'light', 'dark', 'dark', 'light', 'light']);
  });

  it('staggers the seam between one row of boards and the next', () => {
    // Real flooring never lines every row's seams up in one column; the
    // stagger is what makes it read as laid boards. Two adjacent rows must
    // therefore disagree about at least one column's shade.
    const rowA = layout.wallRows;
    const rowB = layout.wallRows + 1;
    const shadesA = [0, 1, 2, 3].map((x) => floorBoardShade(x, rowA, layout));
    const shadesB = [0, 1, 2, 3].map((x) => floorBoardShade(x, rowB, layout));
    expect(shadesA).not.toEqual(shadesB);
  });
});

describe('arrivalAwareFacing (FR-S14 — reporting to a back is a mistake, not a choice)', () => {
  it('faces up once arrived, overriding whatever direction the final step of movement happened to be', () => {
    // Before this function existed, `resolveFacing`'s "keep the fallback"
    // rule left an agent that walked up from the east standing side-on to
    // the desk it had just crossed the room to reach. Every destination in
    // this office (a home seat or the Manager's approach tile) is one row
    // south of the thing that matters, so arrival always resolves to 'up'.
    expect(arrivalAwareFacing({ x: 5, y: 5 }, { x: 5, y: 5 }, 'right')).toBe('up');
    expect(arrivalAwareFacing({ x: 5, y: 5 }, { x: 5, y: 5 }, 'left')).toBe('up');
  });

  it('turns to face the viewer once seated at its OWN desk', () => {
    // The realistic pose at a desk is `up`, towards the monitor, and that is
    // what this did first. But the office is entirely agents at desks, so `up`
    // meant every character on screen was a back of a head, permanently — the
    // faces, the per-agent hair silhouettes FR-S2 derives, and the eye-line
    // that makes a character look busy were invisible in the default view all
    // of the time. A depiction that never shows anyone's face is not more
    // realistic, it is less informative.
    const seat = { x: 5, y: 5 };
    expect(arrivalAwareFacing(seat, seat, 'right', seat)).toBe('down');
  });

  it('still faces the Manager when it has arrived to report, not the viewer', () => {
    // The distinction the `homeSeat` argument exists to draw. A character at
    // the Manager's approach tile is mid-conversation with someone one row
    // north; turning to face the camera there would be the original defect
    // wearing a different direction.
    const approach = { x: 9, y: 3 };
    const ownSeat = { x: 5, y: 9 };
    expect(arrivalAwareFacing(approach, approach, 'left', ownSeat)).toBe('up');
  });

  it('is unaffected while still walking, wherever it is heading', () => {
    // The override is strictly an ARRIVAL rule. A character crossing the floor
    // must still face its direction of travel, or the walk animation plays
    // sideways to the movement.
    const seat = { x: 5, y: 9 };
    expect(arrivalAwareFacing({ x: 5, y: 5 }, seat, 'left', seat)).toBe('down');
    expect(arrivalAwareFacing({ x: 1, y: 9 }, seat, 'up', seat)).toBe('right');
  });

  it('still tracks the direction of travel while short of arrival', () => {
    expect(arrivalAwareFacing({ x: 0, y: 0 }, { x: 1, y: 0 }, 'down')).toBe('right');
    expect(arrivalAwareFacing({ x: 0, y: 1 }, { x: 0, y: 0 }, 'left')).toBe('up');
  });

  it('treats "within the arrival epsilon" as arrived, exactly matching hasArrived', () => {
    const current = { x: 5, y: 5 };
    const target = { x: 5 + ARRIVAL_EPSILON_TILES / 2, y: 5 };
    expect(hasArrived(current, target)).toBe(true);
    expect(arrivalAwareFacing(current, target, 'left')).toBe('up');
  });
});

describe('isSeatedAt (FR-S3 — sitting down is geometry, not a new status)', () => {
  it('is seated once the character has actually reached its own home seat', () => {
    expect(isSeatedAt({ x: 4, y: 4 }, { x: 4, y: 4 })).toBe(true);
  });

  it('is standing everywhere else — mid-walk, or standing at the Manager', () => {
    expect(isSeatedAt({ x: 4, y: 6 }, { x: 4, y: 4 })).toBe(false);
    // Exactly at the Manager's approach tile, but that is not this
    // character's home seat, so it must still read as standing.
    expect(isSeatedAt({ x: 10, y: 2 }, { x: 4, y: 4 })).toBe(false);
  });
});

describe('frameTextureKey (a seated character must not be served a standing texture from the cache)', () => {
  const appearance = { body: 0, hairStyle: 0, skin: '#f0cdae', hair: '#8a5a2b', shirt: '#2f4a7a', trousers: '#26303f' };

  it('produces a different key for seated vs standing, everything else held equal', () => {
    // `sprites.ts`'s own frame cache already keys on `seated` for the same
    // reason (see its `cacheKey` comment); this is the renderer's half of
    // that guarantee — without it, whichever pose the texture cache saw
    // first would be served to both for as long as the entry lived.
    const standing = frameTextureKey(appearance, 'idle', 0, 'down', false);
    const seated = frameTextureKey(appearance, 'idle', 0, 'down', true);
    expect(standing).not.toBe(seated);
  });

  it('is otherwise stable for identical inputs, so the cache actually hits', () => {
    expect(frameTextureKey(appearance, 'walk', 2, 'left', false)).toBe(frameTextureKey(appearance, 'walk', 2, 'left', false));
  });
});

describe('PLATE_PANEL_ALPHA (the backing panel is a legibility guarantee, not a style choice)', () => {
  it('is fully opaque', () => {
    // A translucent panel would make its true on-screen colour a blend of
    // `OFFICE.plateBg` and whatever floorboard sits underneath it, and
    // `officeText.test.ts` grades `OFFICE.plateBg`'s own text contrast on the
    // assumption that `plateBg` is exactly what appears on screen. Any alpha
    // below 1 would make that test measure a colour nobody actually sees.
    expect(PLATE_PANEL_ALPHA).toBe(1);
  });
});

function fixtureAssignment(id: string, agentName: string, overrides: Partial<AssignmentState> = {}): AssignmentState {
  return {
    id,
    phaseId: 'phase-1',
    agentName,
    objective: 'do the thing',
    deliverable: `reports/${id}.md`,
    dependsOn: [],
    status: 'working',
    attempts: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

describe('the Manager is on screen but not hit-testable (FR-S14)', () => {
  it('finds nothing at the Manager’s seat tile, because hit-test entities are built from scene.characters alone', () => {
    // `OfficeSceneRenderer.hitTestAt` builds its search list from `this.characters`,
    // which `syncCharacters` populates from `scene.characters` — never from
    // `scene.manager`. That split is enforced by the type system
    // (`ManagerView` carries no `assignmentId` for a map to key on), but the
    // guarantee that actually matters is behavioural: a click on the tile the
    // Manager is drawn on must find nothing. This mirrors `hitTestAt`'s own
    // construction exactly (one entity per `CharacterView`, positioned the way
    // `createCharacterState` seeds a fresh character's `currentPos`, at its
    // `home.seat`) and confirms clicking the Manager's seat — where, by
    // construction, no such entity is ever created — resolves to nobody.
    const scene = buildSceneFromAssignments([fixtureAssignment('a', 'code-reviewer')]);

    const entities: HitTestEntity[] = scene.characters.map((view) => {
      const px = tileToPixel(view.home.seat);
      return {
        assignmentId: view.assignmentId,
        x: px.x + TILE / 2,
        y: px.y + TILE,
        width: SPRITE_WIDTH,
        height: SPRITE_HEIGHT,
      };
    });

    const managerPx = tileToPixel(scene.manager.seat);
    const point = { x: managerPx.x + TILE / 2, y: managerPx.y + TILE };
    expect(hitTest(entities, point)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The errand: the walk to the Manager is now actually visible on a real run,
// not just in `target`'s value for less than a frame. See scene.ts's own
// section header (above `frameTextureKey`) for the timing bug this fixes.
// ---------------------------------------------------------------------------

describe('the errand keeps the visit to the Manager on screen for its full length', () => {
  const destination = { x: 10, y: 5 };
  const home = { x: 2, y: 5 };
  const dtMs = 16; // one frame at roughly 60fps

  it('reaches the approach tile and dwells there before releasing, even though the underlying status reverts a few milliseconds later', () => {
    // This is the test that pins the actual bug: `briefing` and `reporting`
    // resolve to their next status in single-digit milliseconds in
    // `dispatcher.ts`, so by the time a second scene update arrives,
    // `view.target` is already back at the character's desk. An errand
    // started from the one `to_manager` snapshot must still walk the whole
    // way there and dwell, ignoring `view.target` throughout — simulated here
    // by simply never consulting a "view" at all after the errand starts,
    // exactly as `onTick` doesn't once `state.errand` is set.
    let pos = { ...home };
    let errand: Errand | undefined = startErrand(destination);
    let reachedDestination = false;
    let elapsedMs = 0;

    while (errand !== undefined) {
      pos = stepTowards(pos, errand.destination, dtMs / 1000);
      if (hasArrived(pos, destination)) reachedDestination = true;
      errand = advanceErrand(errand, pos, dtMs);
      elapsedMs += dtMs;
      if (elapsedMs > ERRAND_MAX_LIFETIME_MS + 1000) throw new Error('errand never released — looks like a deadlock');
    }

    expect(reachedDestination).toBe(true);
    // Released only after walking there AND dwelling for the full beat — not
    // the moment the underlying status moved on, which is the failure mode
    // being tested against.
    expect(elapsedMs).toBeGreaterThanOrEqual(ERRAND_DWELL_MS);
  });

  it('does not restart the dwell if the location is still to_manager on a later sync (a slow briefing, not a new one)', () => {
    const running = startErrand(destination);
    expect(shouldStartErrand('to_manager', running)).toBe(false);
    expect(shouldStartErrand('to_manager', undefined)).toBe(true);
    expect(shouldStartErrand('desk', undefined)).toBe(false);
  });

  it('gives up after ERRAND_MAX_LIFETIME_MS if arrival never resolves (deadlock guard)', () => {
    // Stands in for a layout reflow stranding the approach tile mid-errand:
    // the character's position never moves, so `phase` can never leave
    // 'walking'. Without the lifetime cap this would hold the character
    // (and its facing, and its animation) hostage to an arrival that is
    // never coming.
    let errand: Errand | undefined = startErrand({ x: 10, y: 10 });
    const stuckPos = { x: 0, y: 0 };
    let elapsedMs = 0;

    while (errand !== undefined) {
      errand = advanceErrand(errand, stuckPos, 100);
      elapsedMs += 100;
      if (elapsedMs > ERRAND_MAX_LIFETIME_MS + 1000) throw new Error('the deadlock guard itself deadlocked');
    }

    expect(elapsedMs).toBeLessThanOrEqual(ERRAND_MAX_LIFETIME_MS + 100);
  });

  it('abandons rather than completes when the assignment resolves to failed or cancelled mid-errand', () => {
    // The office must not show an agent cheerfully delivering a report for
    // work that was just stopped or that blew up.
    expect(shouldAbandonErrand('failed')).toBe(true);
    expect(shouldAbandonErrand('cancelled')).toBe(true);
    for (const status of ['pending', 'briefing', 'working', 'blocked', 'reporting', 'done', 'skipped'] as const) {
      expect(shouldAbandonErrand(status)).toBe(false);
    }
  });

  it('never starts, and drops one already running, under reduced motion (FR-U5)', () => {
    // Reduced motion already snaps characters straight to their targets; an
    // errand that forced a one-second dwell on top of that snap would
    // reintroduce exactly the motion the setting asks not to be shown.
    expect(nextErrand(undefined, 'to_manager', destination, true)).toBeUndefined();
    const inFlight = startErrand(destination);
    expect(nextErrand(inFlight, 'desk', destination, true)).toBeUndefined();
  });

  it('starts one under ordinary motion the instant to_manager is observed', () => {
    expect(nextErrand(undefined, 'to_manager', destination, false)).toEqual({
      destination,
      phase: 'walking',
      dwellElapsedMs: 0,
      totalElapsedMs: 0,
    });
  });

  it('leaves a running errand alone once view.target has already moved on', () => {
    // The whole point: `location` flipping back to 'desk' must not cancel an
    // errand that is already in flight.
    const inFlight = startErrand(destination);
    expect(nextErrand(inFlight, 'desk', destination, false)).toBe(inFlight);
  });
});

describe('isWorkGlowing (FR-U3 — the desk glow)', () => {
  function behaviourFor(animation: CharacterBehaviour['animation']): CharacterBehaviour {
    return { animation, location: 'desk', bubble: 'none', carrying: false };
  }

  it('glows only for the "type" animation, which only "working" ever produces', () => {
    expect(isWorkGlowing(behaviourFor('type'))).toBe(true);
    expect(isWorkGlowing(behaviourFor('idle'))).toBe(false);
    expect(isWorkGlowing(behaviourFor('idle_relaxed'))).toBe(false);
    expect(isWorkGlowing(behaviourFor('idle_slumped'))).toBe(false);
    expect(isWorkGlowing(behaviourFor('walk'))).toBe(false);
  });

  it('agrees with ASSIGNMENT_BEHAVIOUR — exactly the "working" status glows', () => {
    // This is the guarantee that matters: the glow tracks the same table
    // FR-S3 already uses to drive everything else about a character, so
    // there is no second "is this agent busy" answer that could disagree
    // with the animation actually on screen.
    const statuses = Object.keys(ASSIGNMENT_BEHAVIOUR) as AssignmentStatus[];
    for (const status of statuses) {
      const glowing = isWorkGlowing(ASSIGNMENT_BEHAVIOUR[status]);
      expect(glowing).toBe(status === 'working');
    }
  });
});

describe('FR-U2 — one palette, no second copy in this directory', () => {
  // The exit criterion, made mechanical: after the FR-U3 palette swap, every
  // colour in the pixel office comes from `theme/tokens.ts`. A literal hex or
  // Pixi-number colour reappearing in one of these three files is exactly
  // how the office and the chrome drifted apart before this phase — so this
  // reads the files back and greps them the same way the requirement does,
  // rather than trusting that a future edit will remember the rule.
  const COLOUR_LITERAL = /#[0-9a-fA-F]{6}|0x[0-9a-fA-F]{6}/g;
  const sourceFiles = ['model.ts', 'sprites.ts', 'scene.ts'];

  it('contains no hex or Pixi-number colour literal outside theme/tokens.ts', () => {
    for (const file of sourceFiles) {
      const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
      const text = readFileSync(path, 'utf8');
      const matches = text.match(COLOUR_LITERAL) ?? [];
      // `hashName` in model.ts uses FNV-1a magic numbers (0x811c9dc5,
      // 0x01000193) which are hash constants, not colours, and happen to
      // contain six-hex-digit runs the same regex the requirement specifies
      // would flag. They are the one expected match; anything beyond them is
      // a real colour literal that should have come from a token instead.
      const unexpected = matches.filter((m) => m !== '0x811c9d' && m !== '0x010001');
      expect(unexpected, `${file} should source all colour from theme/tokens.ts, found: ${unexpected.join(', ')}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-S13 — user-controlled zoom. See scene.ts's own section header (above
// `resolveZoom`) for why "automatic" alone stopped being enough: a host box
// can be narrow enough that WIDTH binds the best-fit scale to 1x regardless
// of how tall it is, and no host-sizing fix in styles.css covers every window.
// ---------------------------------------------------------------------------

describe('resolveZoom (auto-vs-override precedence, integer-only, clamped)', () => {
  it('follows the automatic best-fit scale when the preference is "auto"', () => {
    expect(resolveZoom('auto', 2)).toBe(2);
  });

  it('floors a fractional auto-fit scale rather than rounding it up past what actually fits', () => {
    expect(resolveZoom('auto', 2.9)).toBe(2);
  });

  it('clamps the automatic scale into the four real steps at both ends', () => {
    // computeViewport already guarantees >= 1, but resolveZoom must not
    // assume its input was validated -- a future caller, or a test fixture,
    // could hand it anything.
    expect(resolveZoom('auto', 0.4)).toBe(MIN_ZOOM);
    expect(resolveZoom('auto', 12)).toBe(MAX_ZOOM);
  });

  it('an explicit preference overrides the automatic fit outright, in either direction', () => {
    expect(resolveZoom(3, 1)).toBe(3);
    expect(resolveZoom(1, 4)).toBe(1);
  });

  it('only ever returns one of the four integer steps', () => {
    for (const level of ZOOM_LEVELS) {
      expect(resolveZoom(level, 999)).toBe(level);
    }
    for (const autoFit of [-5, 0, 0.5, 1.4, 2.6, 3.999, 4, 100]) {
      expect(ZOOM_LEVELS).toContain(resolveZoom('auto', autoFit));
    }
  });
});

describe('isZoomLevel / parseZoomPreference (a corrupted stored value must not wedge the office)', () => {
  it('accepts exactly the four real levels', () => {
    for (const level of ZOOM_LEVELS) expect(isZoomLevel(level)).toBe(true);
    expect(isZoomLevel(0)).toBe(false);
    expect(isZoomLevel(5)).toBe(false);
    expect(isZoomLevel(2.5)).toBe(false);
  });

  it('parses a stored level back to itself, and "auto" back to "auto"', () => {
    expect(parseZoomPreference('auto')).toBe('auto');
    expect(parseZoomPreference('1')).toBe(1);
    expect(parseZoomPreference('4')).toBe(4);
  });

  it('falls back to "auto" -- the safe default, not a fixed number -- for anything missing or unrecognised', () => {
    // A hand-edited or stale localStorage value (an old scheme's number, a
    // typo, "null" stringified) must degrade to the same "keep fitting the
    // window" behaviour a first-time visitor gets, never to a level that
    // could be nonsensical for whatever host box loads next.
    expect(parseZoomPreference(undefined)).toBe('auto');
    expect(parseZoomPreference('')).toBe('auto');
    expect(parseZoomPreference('0')).toBe('auto');
    expect(parseZoomPreference('9')).toBe('auto');
    expect(parseZoomPreference('huge')).toBe('auto');
  });
});

describe('computeZoomedViewport (the canvas grows to fit an explicit zoom instead of clipping it)', () => {
  it('behaves exactly like computeViewport when the (already-in-range) scale fits the container', () => {
    // A 4x4 world in a 400x400 box: computeViewport's own best fit is a
    // realistic, in-range 2x here, unlike a tiny world in a huge container
    // (see the clamp test below), so this is the honest "nothing forced"
    // baseline the two functions should agree on.
    const auto = computeViewport(400, 400, 200, 200);
    const zoomed = computeZoomedViewport(400, 400, 200, 200, auto.scale);
    expect(zoomed.scale).toBe(auto.scale);
    expect(zoomed.offsetX).toBe(auto.offsetX);
    expect(zoomed.offsetY).toBe(auto.offsetY);
    // No overflow needed, so the canvas stays exactly the container's own size.
    expect(zoomed.canvasWidthPx).toBe(400);
    expect(zoomed.canvasHeightPx).toBe(400);
  });

  it('caps even an automatic best fit at MAX_ZOOM, so the zoom control never has to represent a step it cannot reach', () => {
    // A tiny world in a huge container: computeViewport's own best fit is an
    // uncapped 10x here (it existed before FR-S13 and has no reason to know
    // about the zoom steps). Routing it through here is what keeps the whole
    // office's effective scale on the same 1x-4x ladder the user's own
    // +/- control walks, auto included -- if "auto" could land on a fifth
    // step the stepper has no button for, "zoom out one step" from there
    // would have no well-defined next state.
    const auto = computeViewport(1000, 1000, 100, 100);
    expect(auto.scale).toBeGreaterThan(MAX_ZOOM);
    const zoomed = computeZoomedViewport(1000, 1000, 100, 100, auto.scale);
    expect(zoomed.scale).toBe(MAX_ZOOM);
  });

  it('grows the canvas past the container on whichever axis the forced zoom overflows', () => {
    // The coordinator's own measurement: a real host box came back at
    // 341x418px, and a four-column office is 320px of world width. 1x fits;
    // forcing 3x makes the scaled world 960px wide, well past the container.
    const viewport = computeZoomedViewport(341, 418, 320, 200, 3);
    expect(viewport.scale).toBe(3);
    expect(viewport.canvasWidthPx).toBe(320 * 3);
    // No spare room on that axis to centre into once the canvas exactly
    // matches the scaled world -- the DOM's own scrolling takes over from here.
    expect(viewport.offsetX).toBe(0);
  });

  it('keeps letterboxing on an axis the forced zoom still has room on', () => {
    const viewport = computeZoomedViewport(1000, 1000, 100, 50, 2);
    // World is 200x100 at 2x, well inside the 1000x1000 container on both axes.
    expect(viewport.canvasWidthPx).toBe(1000);
    expect(viewport.canvasHeightPx).toBe(1000);
    expect(viewport.offsetX).toBe(Math.floor((1000 - 200) / 2));
    expect(viewport.offsetY).toBe(Math.floor((1000 - 100) / 2));
  });

  it('clamps an out-of-range requested scale into the four real steps', () => {
    expect(computeZoomedViewport(500, 500, 100, 100, 0).scale).toBe(MIN_ZOOM);
    expect(computeZoomedViewport(500, 500, 100, 100, 99).scale).toBe(MAX_ZOOM);
  });

  it('degrades to a safe identity viewport for a degenerate world size, without dividing by it', () => {
    const viewport = computeZoomedViewport(500, 400, 0, 100, 3);
    expect(viewport).toEqual({ scale: 3, offsetX: 0, offsetY: 0, canvasWidthPx: 500, canvasHeightPx: 400 });
  });

  it('round-trips canvasToWorld/worldToCanvas correctly at a forced, non-default zoom -- the regression that would otherwise ship silently, because the office would still look right and only click wrong', () => {
    const viewport = computeZoomedViewport(341, 418, 320, 400, 4);
    const worldPoint = { x: 137, y: 52 };
    const canvasPoint = worldToCanvas(worldPoint, viewport);
    const back = canvasToWorld(canvasPoint, viewport);
    expect(back.x).toBeCloseTo(worldPoint.x, 5);
    expect(back.y).toBeCloseTo(worldPoint.y, 5);
  });

  it('hitTest still finds the right character through a forced zoom that grew the canvas', () => {
    // Mirrors hitTestAt: a click point in canvas space is converted to world
    // space via canvasToWorld, then matched against entities built in world
    // space. Before computeZoomedViewport existed, only the auto-fit
    // viewport was ever handed to this pipeline; a forced zoom that changed
    // the canvas's own pixel size without updating offsetX/offsetY to match
    // would desync the two, and a click would silently resolve to the wrong
    // desk (or none) even though the office was drawn at the right size.
    const viewport = computeZoomedViewport(341, 418, 320, 400, 3);
    const characterWorldPos = { x: 150, y: 208 };
    const entities: HitTestEntity[] = [
      { assignmentId: 'a', x: characterWorldPos.x, y: characterWorldPos.y, width: SPRITE_WIDTH, height: SPRITE_HEIGHT },
    ];

    const canvasClickPoint = worldToCanvas(characterWorldPos, viewport);
    const resolvedWorldPoint = canvasToWorld(canvasClickPoint, viewport);
    expect(hitTest(entities, resolvedWorldPoint)).toBe('a');
  });
});

describe('ZOOM_LEVELS / ZoomLevel (integer-only, per FR-S13)', () => {
  it('is exactly the four whole-number steps, nothing fractional between them', () => {
    expect(ZOOM_LEVELS).toEqual([1, 2, 3, 4]);
    for (const level of ZOOM_LEVELS) expect(Number.isInteger(level)).toBe(true);
  });

  it('MIN_ZOOM/MAX_ZOOM bound the same range ZOOM_LEVELS enumerates', () => {
    const levels: readonly ZoomLevel[] = ZOOM_LEVELS;
    expect(Math.min(...levels)).toBe(MIN_ZOOM);
    expect(Math.max(...levels)).toBe(MAX_ZOOM);
  });
});

// ---------------------------------------------------------------------------
// Plate legibility at the sizes FR-S13's zoom pass forced a second look at.
//
// PLATE_NAME_SIZE/PLATE_DETAIL_SIZE/PLATE_LINE_HEIGHT live in the UNSCALED
// `uiLayer`, so they were still 10/8/9 literal pixels at 4x zoom -- a fixed
// point size that does not grow the way everything else in the office now
// can. Raised to 13/11/12 (a user-reported "the text is too small" complaint,
// not a guess), which shrinks how much `plateBox()`'s unchanged width/height
// budget has left for `fitPlateLines` to work with. This is that function
// doing its job correctly, not a bug -- but it needed checking, not assuming,
// that the one thing which must not happen (a normal-length agent name
// getting ellipsised away at a normal, filled-frame zoom) does not.
// ---------------------------------------------------------------------------

describe('plate legibility at the larger (FR-S13) text sizes', () => {
  // Mirrors `plateBox()`'s own private constants in scene.ts, the same
  // convention `plateGeometry.test.ts` already uses for its own `boxAtScale`
  // helper (that file mirrors these numbers rather than importing them, and
  // its owner re-derives its copy whenever these change -- 10/8/9 became
  // 13/11/12 here). `PLATE_GUTTER_PX`/`PLATE_VERTICAL_MARGIN_PX` are
  // deliberately UNCHANGED from before this pass: they reserve room for the
  // NEXT plate and the next row's desk, not for this plate's own glyphs, and
  // shrinking them to buy back width would trade "plates never touch" for a
  // few more characters -- the wrong side of that trade.
  function boxAtScale(scale: number): PlateBox {
    const DESK_SPACING_TILES = 4;
    const TILE_PX = 16;
    const GUTTER_PX = 6;
    const VERTICAL_MARGIN_PX = 20;
    return {
      widthPx: Math.max(1, DESK_SPACING_TILES * TILE_PX * scale - GUTTER_PX),
      heightPx: Math.max(1, DESK_SPACING_TILES * TILE_PX * scale - VERTICAL_MARGIN_PX),
      nameSizePx: 13,
      detailSizePx: 11,
      lineHeightPx: 12,
    };
  }

  it('shows a normal-density plate\'s full name and model at 2x, not an ellipsised name', () => {
    // The one guarantee this whole pass could plausibly have broken: at 2x
    // (the default fit for most real team sizes per the coordinator's own
    // host measurements), an ordinary agent name must still read in full.
    const lines = fitPlateLines(['code-reviewer', 'haiku', 'Grep'], boxAtScale(2));
    expect(lines[0]).toBe('code-reviewer'); // untruncated -- no ellipsis
    expect(lines[1]).toBe('haiku');
    expect(lines[2]).toBe('Grep');
  });

  it('still fits a short agent name and model at 1x', () => {
    // 1x is the tightest box the office ever hands a plate, and it was
    // already tight for longer names before this pass (an 11-character name
    // truncated under the OLD 10/8/9 sizes too -- verified by hand against
    // `fitPlateLines`'s own MONO_ADVANCE_RATIO). A short, realistic name
    // still fits in full even here.
    const lines = fitPlateLines(['dev', 'haiku'], boxAtScale(1));
    expect(lines).toEqual(['dev', 'haiku']);
  });

  it('degrades a name too long for its box to an ellipsis rather than dropping it entirely', () => {
    // The box got tighter; the response to that must still be "trim with an
    // ellipsis", never "show nothing" -- `fitPlateLines` itself guarantees
    // this (see model.ts), and this pins it against the actual new sizes
    // rather than trusting the general guarantee transfers unchanged.
    const lines = fitPlateLines(['a-genuinely-very-long-agent-name-for-this-test'], boxAtScale(1));
    expect(lines[0]?.endsWith('…')).toBe(true);
    expect(lines[0]?.length).toBeGreaterThan(1);
  });
});
