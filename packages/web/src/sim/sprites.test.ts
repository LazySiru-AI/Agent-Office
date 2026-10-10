import { describe, expect, it } from 'vitest';
import { appearanceFor, type AgentAppearance } from './model.js';
import { isRectangular } from './pixelGrid.js';
import { OFFICE } from '../theme/tokens.js';
import { FRAMES_PER_ANIMATION, SPRITE_ANIMATIONS, SPRITE_HEIGHT, SPRITE_WIDTH, type Facing, type PropName } from './spriteContract.js';
import { SPRITE_MANIFEST } from './sprites.js';

/**
 * The generator's contract, tested without a canvas (FR-S2, FR-S3, FR-S9).
 *
 * `spriteContract.ts` promises the renderer a total, pure `frame()` — any
 * combination of inputs returns a well-formed grid, never an exception. That
 * promise is what lets the renderer call this inside a frame loop without a
 * try/catch, so it is tested exhaustively here rather than spot-checked.
 */

// Taken from the contract, not retyped. This list was a hardcoded copy, which
// meant an animation added to the union was exercised by nothing: every test
// below iterates this array, so the suite would have stayed green while
// silently covering one fewer animation than existed. Importing it makes the
// coverage follow the type.
const ANIMATIONS = SPRITE_ANIMATIONS;
const FACINGS: readonly Facing[] = ['down', 'up', 'left', 'right'];
const PROP_NAMES: readonly PropName[] = ['desk', 'manager_desk', 'paper'];

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

/**
 * The obligation `spriteContract.ts` actually places on a prop grid: every
 * row the same length, and at least one row. Props are explicitly **not**
 * confined to the `SPRITE_WIDTH x SPRITE_HEIGHT` character box — a bookshelf
 * is wider than it is tall, a rug wider still — so asserting the character
 * box here (as `assertWellFormed` does for `frame()`) would fail correctly
 * shaped furniture for no real defect. That is precisely the bug this
 * assertion replaces: the desk and manager's desk props are deliberately not
 * 16px wide, and a check that demanded they were would fail on every future
 * repaint of the room's furniture, not just a genuine one.
 */
function assertPropWellFormed(grid: readonly (readonly (string | null)[])[]): void {
  expect(isRectangular(grid)).toBe(true);
}

describe('SPRITE_MANIFEST dimensions', () => {
  it('advertises the contract constants', () => {
    expect(SPRITE_MANIFEST.spriteWidth).toBe(SPRITE_WIDTH);
    expect(SPRITE_MANIFEST.spriteHeight).toBe(SPRITE_HEIGHT);
    expect(SPRITE_MANIFEST.framesPerAnimation).toBe(FRAMES_PER_ANIMATION);
  });

  // Pins the literal Phase 10 numbers rather than only cross-checking against
  // the contract's own constants above: that check alone would stay green
  // even if `spriteContract.ts` and `sprites.ts` drifted back down to 12x16
  // together, since both sides would still agree with each other. This is
  // the test that would actually catch the box shrinking back.
  it('is drawn at the 16x24 box the Phase 10 repaint grew into, not the old 12x16 one', () => {
    expect(SPRITE_WIDTH).toBe(16);
    expect(SPRITE_HEIGHT).toBe(24);
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

  // The same exhaustive sweep again, but seated. `seated` is drawn by a
  // completely different code path in `paintCharacter` (legs are skipped
  // outright, the torso is shortened and shifted) so it earns its own pass
  // rather than trusting that a totality guarantee proven for standing
  // characters happens to hold for seated ones too.
  it('returns an exact SPRITE_HEIGHT x SPRITE_WIDTH grid for every animation x frame x facing, seated', () => {
    const appearance = SAMPLE_APPEARANCES[0]!;
    for (const animation of ANIMATIONS) {
      for (const facing of FACINGS) {
        for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
          const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing, seated: true });
          assertWellFormed(grid);
        }
      }
    }
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

  // The out-of-range appearance (index 4 of SAMPLE_APPEARANCES: a negative
  // body, a hairStyle of 99) combined with a pathological frame and the
  // seated flag, all at once — the combination a fuzzer would try, not a
  // human writing a fixture. Nothing in `paintCharacter`'s seated branch is
  // exempt from the same totality promise `frame()` makes for standing
  // characters, so this is the test that would catch a `wrap()` call
  // forgotten on the seated-only code path.
  it('stays well-formed for an out-of-range appearance, a pathological frame, and seated all at once', () => {
    const appearance = SAMPLE_APPEARANCES[4]!;
    for (const frame of [-1000, NaN, Infinity]) {
      for (const animation of ANIMATIONS) {
        for (const facing of FACINGS) {
          const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing, seated: true });
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

  // Determinism has to hold for the seated axis too, since the cache key
  // (`cacheKey` in sprites.ts) folds `seated` in alongside every other field
  // — if seated ever fell out of the key by accident, this is the test that
  // would notice a standing grid served back for a seated request.
  it('is stable across repeated calls with seated set', () => {
    const appearance = appearanceFor('repeat-seated-agent');
    const first = SPRITE_MANIFEST.frame({ appearance, animation: 'type', frame: 2, facing: 'down', seated: true });
    const second = SPRITE_MANIFEST.frame({ appearance, animation: 'type', frame: 2, facing: 'down', seated: true });
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

  // Mirroring has to keep holding once seated draws a genuinely different
  // silhouette (no legs, a shifted torso) — this is what would catch a
  // seated-only branch that forgot the pose still has to be mirror-safe.
  it('keeps left as an exact horizontal mirror of right while seated', () => {
    const appearance = appearanceFor('mirrored-seated-agent');
    for (const animation of ANIMATIONS) {
      for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
        const right = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing: 'right', seated: true });
        const left = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing: 'left', seated: true });
        const mirroredRight = right.map((row) => [...row].reverse());
        expect(left).toEqual(mirroredRight);
      }
    }
  });
});

describe('seated pose (Phase 10)', () => {
  // The whole point of the seated axis is that it is unmistakable at a
  // glance (see the doc comment on `SpriteKey.seated` in spriteContract.ts
  // and on `SEAT_DROP` in sprites.ts): legs are omitted outright rather than
  // merely shortened, which is what guarantees the seated and standing grids
  // can never coincide for any animation or facing. This is the exhaustive
  // sweep that would catch a regression collapsing the two back together —
  // e.g. a seated branch that got the `if (!seated)` guard around
  // `paintLegs` deleted or inverted.
  it('draws a genuinely different grid from standing, for every animation and facing', () => {
    const appearance = appearanceFor('seated-vs-standing');
    for (const animation of ANIMATIONS) {
      for (const facing of FACINGS) {
        for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
          const standing = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing });
          const seated = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing, seated: true });
          expect(seated).not.toEqual(standing);
        }
      }
    }
  });

  // `seated: false` and an omitted `seated` field are the same request (the
  // field defaults to standing — see spriteContract.ts), so the cache key
  // and the renderer must not treat them as two different things.
  it('treats an explicit seated: false the same as an omitted seated field', () => {
    const appearance = appearanceFor('explicit-false-agent');
    const omitted = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'down' });
    const explicit = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'down', seated: false });
    expect(explicit).toEqual(omitted);
  });

  // Trousers are only ever painted by `paintLegs`, so their absence from a
  // seated grid is a direct, structural check that legs really were skipped
  // rather than merely drawn off-screen somewhere the pixel-equality check
  // above would still happen to catch.
  it('never paints the trouser colour anywhere in a seated grid', () => {
    const appearance = appearanceFor('seated-no-trousers');
    for (const animation of ANIMATIONS) {
      for (const facing of FACINGS) {
        const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame: 0, facing, seated: true });
        const pixels = new Set(grid.flat());
        expect(pixels.has(appearance.trousers)).toBe(false);
      }
    }
  });
});

describe('silhouette outline (Phase 10)', () => {
  // The office floor turned warm brown this phase (`OFFICE.floorLight` /
  // `floorDark` in theme/tokens.ts), and an unoutlined character silhouette
  // reads as camouflaged against it — the direction this file's header
  // explains at length. `outlineSilhouette` is what fixes that, so its
  // output must actually contain `OFFICE.outline` pixels, not just compile.
  it('paints OFFICE.outline somewhere in every standing and seated frame', () => {
    const appearance = appearanceFor('outlined-agent');
    for (const animation of ANIMATIONS) {
      for (const facing of FACINGS) {
        for (const seated of [false, true]) {
          const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame: 0, facing, seated });
          const pixels = new Set(grid.flat());
          expect(pixels.has(OFFICE.outline)).toBe(true);
        }
      }
    }
  });

  // A meaningful outline has to actually hug the silhouette rather than fill
  // the whole box, or a future regression that swapped `outlineSilhouette`
  // for "paint the border black" would slip through the presence check
  // above. Cheap proxy: the outline should never be the majority colour of
  // the grid.
  it('does not flood the whole sprite — the outline is a border, not a fill', () => {
    const appearance = appearanceFor('outline-is-a-border');
    const grid = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'down' });
    const flat = grid.flat();
    const outlineCount = flat.filter((cell) => cell === OFFICE.outline).length;
    const paintedCount = flat.filter((cell) => cell !== null).length;
    expect(outlineCount).toBeLessThan(paintedCount / 2);
  });
});

describe('face (Phase 10.2 — sclera and pupil)', () => {
  // The failure this guards against already happened once: a head can render
  // with the correct dimensions, the correct two-tone shading, a correctly
  // outlined silhouette and a hair silhouette that passes every test above,
  // while having no visible face at all — a coordinator caught it by reading
  // a rendered PNG, not by a failing test, because none of the tests above
  // look *inside* the head for a face specifically.
  //
  // `EYE_WHITE` (`OFFICE.eyeWhite`) is used nowhere in this file except an
  // eye's sclera, so any `OUTLINE`-coloured cell orthogonally adjacent to one
  // can only be `paintEye`'s pupil — `outlineSilhouette` only ever writes to
  // a *transparent* cell, and a sclera pixel is never transparent. That makes
  // "an eyeWhite cell has an outline-coloured neighbour" a precise proxy for
  // "a pupil sits inside a sclera", not a coincidence of the silhouette
  // border or a shoe sole happening to land nearby.
  it('OFFICE.eyeWhite and OFFICE.outline are distinct colours', () => {
    // A degenerate palette where the two matched would make every check
    // below pass vacuously — a pupil would be indistinguishable from its own
    // sclera, and "a face" would collapse back into a blank socket.
    expect(OFFICE.eyeWhite).not.toBe(OFFICE.outline);
  });

  function hasPupilInSclera(grid: readonly (readonly (string | null)[])[]): boolean {
    const height = grid.length;
    const width = grid[0]?.length ?? 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (grid[y]?.[x] !== OFFICE.eyeWhite) continue;
        const neighbours: readonly (readonly [number, number])[] = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        if (neighbours.some(([nx, ny]) => grid[ny]?.[nx] === OFFICE.outline)) return true;
      }
    }
    return false;
  }

  it('draws a face — a sclera pixel with an adjacent pupil pixel — for every animation and every face-showing facing', () => {
    const appearance = appearanceFor('face-check-agent');
    for (const animation of ANIMATIONS) {
      // 'up' is the back of the head — by design there is no face there (see
      // paintHair's back-view override, which covers the whole head box in
      // hair) — so it is deliberately excluded rather than asserted false,
      // which would make this test also a (weaker, redundant) re-statement
      // of that design choice instead of a check on the face itself.
      for (const facing of ['down', 'left', 'right'] as const) {
        for (const seated of [false, true]) {
          for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
            // `idle`'s blink frame and `read`'s closing-eyes frame
            // legitimately hide the eyes (`hideEyes` in `poseFor`) — real
            // omissions by design, not the defect this test exists to catch.
            const blinking = (animation === 'idle' && frame === 2) || (animation === 'read' && frame === 3);
            if (blinking) continue;
            const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing, seated });
            expect(hasPupilInSclera(grid)).toBe(true);
          }
        }
      }
    }
  });
});

describe('hair silhouettes (Phase 10)', () => {
  // `HAIR_STYLES` was raised to 6 specifically so every style could be a
  // distinct shape rather than a recolour of the same cap — see the header
  // comment on `paintHair` in sprites.ts. Six appearances that differ only in
  // `hairStyle` should therefore never collapse onto the same grid.
  it('draws a pairwise-distinct grid for each hairStyle index, all else held constant', () => {
    const base = appearanceFor('hair-style-probe');
    const grids = [0, 1, 2, 3, 4, 5].map((hairStyle) =>
      SPRITE_MANIFEST.frame({
        appearance: { ...base, hairStyle },
        animation: 'idle',
        frame: 0,
        facing: 'down',
      }),
    );
    for (let i = 0; i < grids.length; i += 1) {
      for (let j = i + 1; j < grids.length; j += 1) {
        expect(grids[i]).not.toEqual(grids[j]);
      }
    }
  });

  // `paintHair`'s `switch` reaches every explicit case through `wrap()`
  // rather than trusting the caller to stay in range — this is the test for
  // that: an index nobody could obtain from `appearanceFor` today (since
  // `HAIR_STYLES` bounds it) still has to produce a real, well-formed shape,
  // because the field is a plain `number` on `AgentAppearance` and nothing
  // stops a future caller from constructing one directly.
  it('still draws a well-formed grid for a hairStyle index outside [0, HAIR_STYLES)', () => {
    const base = appearanceFor('hair-out-of-range-probe');
    const grid = SPRITE_MANIFEST.frame({
      appearance: { ...base, hairStyle: 4200 },
      animation: 'idle',
      frame: 0,
      facing: 'down',
    });
    assertWellFormed(grid);
    const pixels = new Set(grid.flat());
    expect(pixels.has(base.hair)).toBe(true);
  });
});

describe('chibi proportions (Phase 10 re-tune)', () => {
  // The reference art is deliberately chibi, and the first pass at the 16x24
  // box got that backwards: a coordinator sampled the reference character
  // sheet and found the head+hair mass wider than the torso and occupying
  // roughly the top 58% of the figure, where this file's first draft drew a
  // 6-row head over an 18-row body — a realistic adult ratio, not the
  // reference's. These two tests pin the corrected ratio against rendered
  // pixels rather than against `sprites.ts`'s private layout constants, so a
  // future re-tune has to keep clearing an actual visual bar, not just keep
  // some numbers internally consistent with each other.
  function rowWidth(row: readonly (string | null)[]): number {
    return row.reduce((count: number, cell) => (cell === null ? count : count + 1), 0);
  }

  it('draws the head wider than the torso, even for the broadest body variant', () => {
    // A hand-built appearance rather than a hashed one, so `body` can be
    // pinned to the broad variant deliberately — the case where a
    // narrow-head regression would be hardest to catch by eye, since a wide
    // torso is the one most likely to accidentally out-measure a shrunken
    // head.
    const appearance: AgentAppearance = { ...appearanceFor('proportions-agent'), body: 2 };
    const grid = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'down' });
    const headRows = grid.slice(0, 14); // the head+hair zone — see HEAD_* in sprites.ts
    const torsoRows = grid.slice(14, 20); // the torso zone — see TORSO_* in sprites.ts
    const maxHeadWidth = Math.max(...headRows.map(rowWidth));
    const maxTorsoWidth = Math.max(...torsoRows.map(rowWidth));
    expect(maxHeadWidth).toBeGreaterThan(maxTorsoWidth);
  });

  it('keeps the head+hair zone at roughly the top half of the figure, not a small cap over a tall body', () => {
    // Cheap proxy for "big head, small body": count how many of the head
    // zone's 14 rows actually carry paint. The pre-fix figure had a 6-row
    // skull and next to no hair headroom, so at most 7-8 of these 14 rows
    // were ever painted; the corrected skull alone (HEAD_ROWS = 10) clears
    // this bar on its own, which is the point — the threshold is set above
    // what a regression back to realistic proportions could reach.
    const appearance = appearanceFor('head-zone-agent');
    const grid = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'down' });
    const headRows = grid.slice(0, 14);
    const paintedHeadRows = headRows.filter((row) => row.some((cell) => cell !== null)).length;
    expect(paintedHeadRows).toBeGreaterThanOrEqual(9);
  });
});

describe('appearance colours reach the grid', () => {
  // Checked per animation across the *union* of its facings and frames,
  // rather than demanding all four colours in every single grid — because
  // one legitimate combination genuinely cannot show skin: `idle` draws no
  // hand pixels (its structural tell is stillness, not a hand position — see
  // `poseFor`), and `paintHair`'s back view (facing 'up') now correctly
  // covers the *entire* head box with hair rather than leaving most of it as
  // an unrealistic bald patch, since there is no face back there to expose.
  // `idle` facing `up` therefore has zero skin pixels by design, and a
  // per-grid check would fail that combination for a reason that is not a
  // defect. Checking the union still catches the actual regression this
  // guards against: an appearance colour that never reaches the grid at all.
  it('draws every one of skin, hair, shirt and trousers somewhere across the character, for every animation', () => {
    for (const appearance of [appearanceFor('colour-check-1'), appearanceFor('colour-check-2')]) {
      for (const animation of ANIMATIONS) {
        const pixels = new Set<string | null>();
        for (const facing of FACINGS) {
          for (let frame = 0; frame < FRAMES_PER_ANIMATION; frame += 1) {
            const grid = SPRITE_MANIFEST.frame({ appearance, animation, frame, facing });
            for (const row of grid) for (const cell of row) pixels.add(cell);
          }
        }
        expect(pixels.has(appearance.skin)).toBe(true);
        expect(pixels.has(appearance.hair)).toBe(true);
        expect(pixels.has(appearance.shirt)).toBe(true);
        expect(pixels.has(appearance.trousers)).toBe(true);
      }
    }
  });
});

describe('prop()', () => {
  it('returns a well-formed, non-empty grid for every PropName', () => {
    for (const name of PROP_NAMES) {
      const grid = SPRITE_MANIFEST.prop(name);
      assertPropWellFormed(grid);
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

  // The same validity check, once for a seated grid — `shade()` is the one
  // place this file computes a colour rather than copying one from
  // `AgentAppearance` or `OFFICE`, so it is the one place a clamping bug
  // could produce something that is not a clean 6-digit hex string (an
  // out-of-range channel, a missing leading zero after `toString(16)`).
  it('produces only valid CSS hex colours from the two-tone shading path too', () => {
    const appearance = appearanceFor('shading-validity-agent');
    for (const seated of [false, true]) {
      const grid = SPRITE_MANIFEST.frame({ appearance, animation: 'idle', frame: 0, facing: 'down', seated });
      for (const row of grid) {
        for (const cell of row) {
          if (cell === null) continue;
          expect(cell).toMatch(HEX_COLOUR);
        }
      }
    }
  });
});
