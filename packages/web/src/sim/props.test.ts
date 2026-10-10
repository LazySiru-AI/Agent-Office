import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { OFFICE, THEMES } from '../theme/tokens.js';
import { isRectangular } from './pixelGrid.js';
import type { PropName } from './spriteContract.js';
import { prop } from './props.js';

/**
 * `PropName` (`spriteContract.ts`) is a type, not a runtime value, and that
 * file deliberately does not export a parallel `PROP_NAMES` array — the same
 * reasoning `SPRITE_ANIMATIONS` in that file uses for animations does not
 * apply here, because a second list is exactly the kind of thing that drifts:
 * someone adds a fourteenth prop to the union, `props.ts`'s `Record<PropName,
 * PixelGrid>` forces them to add the case there (the compiler enforces that
 * half), but nothing forces a hand-maintained array in a test file to grow
 * with it — the suite would keep passing, having quietly stopped covering the
 * new prop.
 *
 * `Record<PropName, true>` closes that gap the same way `PROP_GRIDS` does: if
 * `PropName` gains or loses a case, this object literal fails to *compile*
 * until the case is added or removed here too, so the array below is always
 * exactly the union's members — enforced by the type checker, not by a
 * comment asking a future editor to remember.
 */
const ALL_PROP_NAMES_BY_NAME: Record<PropName, true> = {
  desk: true,
  manager_desk: true,
  chair: true,
  plant: true,
  bookshelf: true,
  wall_clock: true,
  wall_art: true,
  couch: true,
  rug: true,
  paper: true,
};
const ALL_PROP_NAMES = Object.keys(ALL_PROP_NAMES_BY_NAME) as PropName[];

/**
 * The complete set of colours this file is allowed to draw with, per FR-U2.
 * `props.ts` has no `shade()`-style derivation helper (see its file header
 * for why), so every pixel it paints must be a value that appears *literally*
 * in `OFFICE` or `THEMES.dark` — no reconstruction of a derived palette is
 * needed here, which keeps this a plain membership check rather than
 * something that has to replay how a colour was computed.
 */
const ALLOWED_COLOURS = new Set<string>([...Object.values(OFFICE), ...Object.values(THEMES.dark)]);

/** Every non-null colour string a grid actually paints with, deduplicated. */
function coloursOf(grid: readonly (readonly (string | null)[])[]): Set<string> {
  const colours = new Set<string>();
  for (const row of grid) {
    for (const cell of row) {
      if (cell !== null) colours.add(cell);
    }
  }
  return colours;
}

describe('prop() totality and shape', () => {
  it('generates a grid for every PropName — prevents a name in the union with no case in PROP_GRIDS', () => {
    // `PROP_GRIDS` in props.ts is typed `Record<PropName, PixelGrid>`, so a
    // missing case is already a compile error. This test is the regression
    // guard for a future rewrite that drops that typing (a switch statement
    // with a catch-all `default`, say) and would otherwise let a prop quietly
    // start rendering as nothing.
    for (const name of ALL_PROP_NAMES) {
      const grid = prop(name);
      expect(grid).toBeDefined();
    }
  });

  it('keeps ALL_PROP_NAMES in step with the union — a canary for this file drifting from spriteContract.ts', () => {
    expect(ALL_PROP_NAMES).toHaveLength(10);
  });

  it('produces a rectangular, non-empty grid for every prop — prevents a ragged row or a 0×0 grid reaching the renderer', () => {
    for (const name of ALL_PROP_NAMES) {
      expect(isRectangular(prop(name)), `${name} is not rectangular`).toBe(true);
    }
  });

  it('paints at least one non-null pixel for every prop — a silently blank prop would never fail any other check', () => {
    for (const name of ALL_PROP_NAMES) {
      const grid = prop(name);
      const hasPaint = grid.some((row) => row.some((cell) => cell !== null));
      expect(hasPaint, `${name} drew no pixels`).toBe(true);
    }
  });
});

describe('prop() caching', () => {
  it('returns the same object on every call — props are built once at module load, not per call', () => {
    // A regression to per-call construction would not fail any *visible*
    // test — every grid would still look right — it would just mean every
    // frame of every rendered desk, chair and bookshelf re-allocates a fresh
    // 2-D array instead of reusing the one built at import time. `toBe`
    // (reference equality), not `toEqual`, is the point of this test.
    for (const name of ALL_PROP_NAMES) {
      expect(prop(name)).toBe(prop(name));
    }
  });
});

describe('FR-U2: no hardcoded colour', () => {
  it('never writes a hex literal in props.ts — this is the test that actually stops one creeping back in', () => {
    // Membership-testing the *output* colours (below) only catches a literal
    // that happens to equal an existing token by coincidence; it would not
    // catch a literal that happens to be wrong, or one written into a branch
    // no test exercises. Reading the source and looking for the pattern
    // directly is the only check that catches a hex literal *as* a hex
    // literal, regardless of what value it holds or whether it is ever drawn.
    const here = fileURLToPath(import.meta.url);
    const sourcePath = here.replace(/props\.test\.ts$/, 'props.ts');
    const source = readFileSync(sourcePath, 'utf8');

    // Strip comments first: the file's own header prose is free to describe
    // token values in English (it doesn't, but nothing stops it), and this
    // check should only ever fire on code, not commentary.
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    const hexLiteral = /#[0-9a-fA-F]{3,8}\b/;
    expect(withoutComments).not.toMatch(hexLiteral);
  });

  it('only ever draws colours present in OFFICE or THEMES.dark', () => {
    for (const name of ALL_PROP_NAMES) {
      const colours = coloursOf(prop(name));
      for (const colour of colours) {
        expect(ALLOWED_COLOURS.has(colour), `${name} drew disallowed colour ${colour}`).toBe(true);
      }
    }
  });
});

describe('manager desk vs. ordinary desk', () => {
  it('draws the manager desk wider than the ordinary desk — the grander silhouette FR-S9 asks for is a requirement, not an accident', () => {
    const desk = prop('desk');
    const managerDesk = prop('manager_desk');
    const deskWidth = desk[0]?.length ?? 0;
    const managerWidth = managerDesk[0]?.length ?? 0;
    expect(managerWidth).toBeGreaterThan(deskWidth);
  });

  it('draws the manager desk in a visibly different palette from the ordinary desk', () => {
    const desk = prop('desk');
    const managerDesk = prop('manager_desk');
    // `managerDesk`/`managerDeskEdge` are dedicated tokens distinct from
    // `desk`/`deskEdge` specifically so this is guaranteed by the palette,
    // not by the drawing code getting the geometry right — assert the
    // colour sets actually diverge rather than trusting that intent held.
    const deskColours = coloursOf(desk);
    const managerColours = coloursOf(managerDesk);
    expect(managerColours.has(OFFICE.managerDesk)).toBe(true);
    expect(deskColours.has(OFFICE.managerDesk)).toBe(false);
  });
});
