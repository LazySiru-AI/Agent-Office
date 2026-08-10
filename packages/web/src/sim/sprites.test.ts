import { describe, expect, it } from 'vitest';
import { appearanceFor, type AgentAppearance } from './model.js';
import { FRAMES_PER_ANIMATION, SPRITE_HEIGHT, SPRITE_WIDTH, type Facing, type PropName, type SpriteAnimation } from './spriteContract.js';
import { SPRITE_MANIFEST } from './sprites.js';

/**
 * The generator's contract, tested without a canvas (FR-S2, FR-S3, FR-S9).
 *
 * `spriteContract.ts` promises the renderer a total, pure `frame()` — any
 * combination of inputs returns a well-formed grid, never an exception. That
 * promise is what lets the renderer call this inside a frame loop without a
 * try/catch, so it is tested exhaustively here rather than spot-checked.
 */

const ANIMATIONS: readonly SpriteAnimation[] = ['idle', 'idle_relaxed', 'idle_slumped', 'walk', 'type'];
const FACINGS: readonly Facing[] = ['down', 'up', 'left', 'right'];
const PROP_NAMES: readonly PropName[] = [
  'desk',
  'manager_desk',
  'paper',
  'bubble_speech',
  'bubble_alert',
  'bubble_error',
];

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

// A handful of real, hash-derived appearances (covering different agent
// names, so different body/hairStyle/palette picks) plus one hand-built one
// used to probe field values `appearanceFor` would never itself produce.
const SAMPLE_APPEARANCES: readonly AgentAppearance[] = [
  appearanceFor('alice'),
  appearanceFor('bob-the-builder'),
  appearanceFor('Cassandra Ng'),
  appearanceFor(''),
  {
    body: -7, // deliberately out of the [0, BODY_VARIANTS) range
    hairStyle: 99, // deliberately out of the [0, HAIR_STYLES) range
    skin: '#f0c9a4',
    hair: '#2b2118',
    shirt: '#4a6b8a',
    trousers: '#3a3f4a',
  },
];

function assertWellFormed(grid: readonly (readonly (string | null)[])[]): void {
  expect(grid).toHaveLength(SPRITE_HEIGHT);
  for (const row of grid) {
    expect(row).toHaveLength(SPRITE_WIDTH);
  }
}

describe('SPRITE_MANIFEST dimensions', () => {
  it('advertises the contract constants', () => {
    expect(SPRITE_MANIFEST.spriteWidth).toBe(SPRITE_WIDTH);
    expect(SPRITE_MANIFEST.spriteHeight).toBe(SPRITE_HEIGHT);
    expect(SPRITE_MANIFEST.framesPerAnimation).toBe(FRAMES_PER_ANIMATION);
  });
});

describe('frame() totality', () => {
  it('returns an exact SPRITE_HEIGHT x SPRITE_WIDTH grid for every animation x frame x facing x appearance', () => {
    let checked = 0;
    for (const appearance of SAMPLE_APPEARANCES) {
      for (const animation of ANIMATIONS) {
        for (const facing of FACINGS) {
          for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
            const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing });
            assertWellFormed(grid);
            checked += 1;
          }
        }
      }
    }
    // Sanity check on the exhaustive sweep itself: this should be exactly
    // appearances x animations x facings x frames worth of assertions.
    expect(checked).toBe(SAMPLE_APPEARANCES.length * ANIMATIONS.length * FACINGS.length * FRAMES_PER_ANIMATION);
  });

  it('never returns a ragged grid, even for pathological frame numbers', () => {
    const appearance = SAMPLE_APPEARANCES[0]!;
    const pathological = [-1000, -1, 0, 3, 4, 4.7, -4.7, 1000, NaN, Infinity, -Infinity];
    for (const frame of pathological) {
      for (const animation of ANIMATIONS) {
        for (const facing of FACINGS) {
          const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing });
          assertWellFormed(grid);
        }
      }
    }
  });
});

describe('frame() frame-index wrapping', () => {
  const appearance = appearanceFor('wraps-agent');

  it('wraps frames past FRAMES_PER_ANIMATION back to the start of the loop', () => {
    for (const animation of ANIMATIONS) {
      for (const facing of FACINGS) {
        const first = SPRITE_MANIFEST.frame({ appearance, animation, frame: 0, facing });
        const wrapped = SPRITE_MANIFEST.frame({ appearance, animation, frame: FRAMES_PER_ANIMATION, facing });
        expect(wrapped).toEqual(first);
      }
    }
  });

  it('wraps negative frames onto the same tail frame a positive equivalent would use', () => {
    const animation = 'walk';
    const facing = 'down';
    // -1 should land on the last frame of the loop, same as FRAMES_PER_ANIMATION - 1.
    const negative = SPRITE_MANIFEST.frame({ appearance, animation, frame: -1, facing });
    const tail = SPRITE_MANIFEST.frame({
      appearance,
      animation,
      frame: FRAMES_PER_ANIMATION - 1,
      facing,
    });
    expect(negative).toEqual(tail);
  });

  it('wraps arbitrarily large multiples consistently', () => {
    const animation = 'type';
    const facing = 'right';
    const base = SPRITE_MANIFEST.frame({ appearance, animation, frame: 2, facing });
    const farAhead = SPRITE_MANIFEST.frame({
      appearance,
      animation,
      frame: 2 + FRAMES_PER_ANIMATION * 37,
      facing,
    });
    expect(farAhead).toEqual(base);
  });
});

describe('frame() determinism (FR-S2)', () => {
  it('returns identical grids for two structurally-equal but distinct appearance objects', () => {
    for (const animation of ANIMATIONS) {
      for (const facing of FACINGS) {
        for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
          const a = appearanceFor('deterministic-agent');
          const b = appearanceFor('deterministic-agent');
          expect(a).not.toBe(b); // distinct objects, same values
          const gridA = SPRITE_MANIFEST.frame({ appearance: a, animation, frame, facing });
          const gridB = SPRITE_MANIFEST.frame({ appearance: b, animation, frame, facing });
          expect(gridA).toEqual(gridB);
        }
      }
    }
  });

  it('is stable across repeated calls with the very same appearance object', () => {
    const appearance = appearanceFor('repeat-agent');
    const first = SPRITE_MANIFEST.frame({ appearance, animation: 'idle_relaxed', frame: 1, facing: 'left' });
    const second = SPRITE_MANIFEST.frame({ appearance, animation: 'idle_relaxed', frame: 1, facing: 'left' });
    expect(second).toEqual(first);
  });
});

describe('animations are visually distinguishable (FR-S3)', () => {
  // If a generator silently returned the same body for every animation, the
  // office would be useless for reading status at a glance — this is the
  // test that would catch exactly that regression.
  it('produces different pixels for every pair of animations, at every frame and facing', () => {
    const appearance = appearanceFor('status-reader');
    for (const facing of FACINGS) {
      for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
        const grids = ANIMATIONS.map((animation) =>
          SPRITE_MANIFEST.frame({ appearance, animation, frame, facing }),
        );
        for (let i = 0; i < grids.length; i += 1) {
          for (let j = i + 1; j < grids.length; j += 1) {
            expect(grids[i]).not.toEqual(grids[j]);
          }
        }
      }
    }
  });

  it('keeps idle_relaxed (done) and idle_slumped (failed) apart from plain idle across the whole loop', () => {
    // These three share the same location/desk behaviour and are the ones
    // most likely to be eyeballed side by side, so they get their own check
    // beyond the general pairwise sweep above.
    const appearance = appearanceFor('done-vs-failed');
    for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
      const idle = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame, facing: 'down' });
      const relaxed = SPRITE_MANIFEST.frame({ appearance, animation: 'idle_relaxed', frame, facing: 'down' });
      const slumped = SPRITE_MANIFEST.frame({ appearance, animation: 'idle_slumped', frame, facing: 'down' });
      expect(relaxed).not.toEqual(idle);
      expect(slumped).not.toEqual(idle);
      expect(slumped).not.toEqual(relaxed);
    }
  });
});

describe('walk animation (FR-S3)', () => {
  it('produces four pairwise-distinct frames, so the legs read as actually moving', () => {
    const appearance = appearanceFor('walker');
    for (const facing of FACINGS) {
      const frames = [0, 1, 2, 3].map((frame) =>
        SPRITE_MANIFEST.frame({ appearance, animation: 'walk', frame, facing }),
      );
      for (let i = 0; i < frames.length; i += 1) {
        for (let j = i + 1; j < frames.length; j += 1) {
          expect(frames[i]).not.toEqual(frames[j]);
        }
      }
    }
  });
});

describe('facing (mirroring and back view)', () => {
  it('renders left as an exact horizontal mirror of right, for every animation and frame', () => {
    const appearance = appearanceFor('mirrored-agent');
    for (const animation of ANIMATIONS) {
      for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
        const right = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing: 'right' });
        const left = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing: 'left' });
        const mirroredRight = right.map((row) => [...row].reverse());
        expect(left).toEqual(mirroredRight);
      }
    }
  });

  it('draws a distinct back view for facing up (no face) versus down (a face)', () => {
    const appearance = appearanceFor('facing-agent');
    const down = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'down' });
    const up = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'up' });
    expect(up).not.toEqual(down);
  });
});

describe('appearance colours reach the grid', () => {
  it('draws every one of skin, hair, shirt and trousers somewhere in the character', () => {
    for (const appearance of [appearanceFor('colour-check-1'), appearanceFor('colour-check-2')]) {
      for (const animation of ANIMATIONS) {
        for (const facing of FACINGS) {
          for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
            const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing });
            const pixels = new Set(grid.flat());
            expect(pixels.has(appearance.skin)).toBe(true);
            expect(pixels.has(appearance.hair)).toBe(true);
            expect(pixels.has(appearance.shirt)).toBe(true);
            expect(pixels.has(appearance.trousers)).toBe(true);
          }
        }
      }
    }
  });
});

describe('prop()', () => {
  it('returns a well-formed, non-empty grid for every PropName', () => {
    for (const name of PROP_NAMES) {
      const grid = SPRITE_MANIFEST.prop(name);
      assertWellFormed(grid);
      const hasPaint = grid.some((row) => row.some((cell) => cell !== null));
      expect(hasPaint).toBe(true);
    }
  });

  it('is deterministic and referentially stable across calls (props are static)', () => {
    for (const name of PROP_NAMES) {
      const first = SPRITE_MANIFEST.prop(name);
      const second = SPRITE_MANIFEST.prop(name);
      expect(second).toEqual(first);
    }
  });

  it('gives the manager desk a visibly different look from the ordinary desk', () => {
    const desk = SPRITE_MANIFEST.prop('desk');
    const managerDesk = SPRITE_MANIFEST.prop('manager_desk');
    expect(managerDesk).not.toEqual(desk);
  });

  it('gives each bubble a distinct look, so the mark (not just the colour) is legible', () => {
    const speech = SPRITE_MANIFEST.prop('bubble_speech');
    const alert = SPRITE_MANIFEST.prop('bubble_alert');
    const error = SPRITE_MANIFEST.prop('bubble_error');
    expect(speech).not.toEqual(alert);
    expect(speech).not.toEqual(error);
    expect(alert).not.toEqual(error);
  });
});

describe('pixel data validity', () => {
  it('contains only null or valid CSS hex colour strings, across characters and props', () => {
    for (const appearance of SAMPLE_APPEARANCES) {
      for (const animation of ANIMATIONS) {
        for (const facing of FACINGS) {
          const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame: 0, facing });
          for (const row of grid) {
            for (const cell of row) {
              if (cell === null) continue;
              expect(cell).toMatch(HEX_COLOUR);
            }
          }
        }
      }
    }

    for (const name of PROP_NAMES) {
      const grid = SPRITE_MANIFEST.prop(name);
      for (const row of grid) {
        for (const cell of row) {
          if (cell === null) continue;
          expect(cell).toMatch(HEX_COLOUR);
        }
      }
    }
  });
});
