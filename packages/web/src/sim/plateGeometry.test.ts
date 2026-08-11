import { describe, expect, it } from 'vitest';
import { fitPlateLines, layoutOffice, TILE, type PlateBox } from './model.js';

/**
 * Plate geometry (FR-S10).
 *
 * `officeText.test.ts` grades what a plate SAYS and whether it can be read.
 * Neither it nor anything else graded whether a plate FITS, which is how the
 * office shipped with text running across neighbouring desks. Measured on the
 * running app at 1x: `architect-reviewer` renders 99px wide into a 64px column
 * gap, and a four-line verbose plate is 78px tall into a 64px row gap. At 2x
 * both fit comfortably — and 2x is what a one- or two-row team gets, which is
 * why every manual look at the office missed it. Three rows falls back to 1x,
 * so the overlap appears on exactly the runs with the most plates.
 */

/**
 * The box a plate gets at a given integer render scale, matching `scene.ts`.
 *
 * The three font sizes mirror `PLATE_NAME_SIZE`, `PLATE_DETAIL_SIZE` and
 * `PLATE_LINE_HEIGHT`, which grew from 10/8/9 to 13/11/12 in Phase 10 — the
 * office's text lives in an UNSCALED overlay, so an 8px detail line was 8px
 * whether the office rendered at 1x or 4x, and 8px is simply too small to read.
 * The margins either side (6 and 20) are unchanged: they reserve room for the
 * *neighbouring* plate and desk, so they are about spacing, not glyphs.
 */
function boxAtScale(scale: number): PlateBox {
  return {
    widthPx: 4 * TILE * scale - 6,
    heightPx: 4 * TILE * scale - 20,
    nameSizePx: 13,
    detailSizePx: 11,
    lineHeightPx: 12,
  };
}

const VERBOSE = ['architect-reviewer', 'run default', 'Grep TODO.md', '2984949in/159out', '$18.20'];

/** Same 0.6 ratio `fitPlateLines` estimates with — the bound it promises. */
function widthOf(text: string, sizePx: number): number {
  return text.length * sizePx * 0.6;
}

describe('fitPlateLines keeps a plate inside its desk (FR-S10)', () => {
  it('truncates a long name that would cross into the next column at 1x', () => {
    const box = boxAtScale(1);
    const [name] = fitPlateLines(['architect-reviewer'], box);
    expect(name).not.toBe('architect-reviewer');
    expect(name?.endsWith('…')).toBe(true);
    expect(widthOf(name ?? '', box.nameSizePx)).toBeLessThanOrEqual(box.widthPx);
  });

  it('leaves a typical agent name alone at 2x, where it fits', () => {
    // The fit is a response to real geometry, not a blanket shortening — a
    // two-row team should still read whole agent names.
    const [name] = fitPlateLines(['code-reviewer'], boxAtScale(2));
    expect(name).toBe('code-reviewer');
  });

  it('still truncates the longest names at 2x, and that is the honest outcome', () => {
    // This one CHANGED in Phase 10, and the change is worth recording rather
    // than quietly re-pinning. `architect-reviewer` used to survive at 2x; at
    // the larger, actually-readable 13px name size it no longer does — 18
    // characters is roughly 140px against the 122px a plate gets at 2x.
    //
    // The plate's width is one desk spacing, and it cannot grow: the box exists
    // precisely so a plate never runs across the neighbouring desk. So the
    // choice was a name a reader can make out with the tail elided, or a name
    // small enough to print whole and too small to read. Truncation with a
    // visible ellipsis wins, because the alternative fails at the plate's only
    // job. The full name is one hover or click away, and the office's text
    // alternative always reads it in full.
    const [name] = fitPlateLines(['architect-reviewer'], boxAtScale(2));
    expect(name).not.toBe('architect-reviewer');
    expect(name?.endsWith('…')).toBe(true);
    // Still enough of the name to tell agents apart, not a stub.
    expect(name?.length).toBeGreaterThan(8);
  });

  it('keeps every line within the box at both scales, for a full verbose plate', () => {
    for (const scale of [1, 2, 3]) {
      const box = boxAtScale(scale);
      const fitted = fitPlateLines(VERBOSE, box);
      fitted.forEach((line, i) => {
        const size = i === 0 ? box.nameSizePx : box.detailSizePx;
        expect(
          widthOf(line, size),
          `scale ${scale}, line ${i} (${JSON.stringify(line)}) overflows`,
        ).toBeLessThanOrEqual(box.widthPx);
      });
    }
  });

  it('drops detail lines that would reach the next row rather than drawing over it', () => {
    const box = boxAtScale(1);
    const fitted = fitPlateLines(VERBOSE, box);
    const height = box.nameSizePx + (fitted.length - 1) * box.lineHeightPx;
    expect(height).toBeLessThanOrEqual(box.heightPx);
    // Something actually had to give at 1x — otherwise this test would pass
    // against a function that does nothing.
    expect(fitted.length).toBeLessThan(VERBOSE.length);
  });

  it('shows the whole verbose plate at 2x, where the room exists', () => {
    expect(fitPlateLines(VERBOSE, boxAtScale(2))).toHaveLength(VERBOSE.length);
  });

  it('never drops the name, however small the box', () => {
    // A labelled desk beats an unlabelled one at any size; the name is the
    // one line that is never a candidate for the vertical trim.
    const cramped: PlateBox = {
      widthPx: 8,
      heightPx: 1,
      nameSizePx: 10,
      detailSizePx: 8,
      lineHeightPx: 9,
    };
    const fitted = fitPlateLines(VERBOSE, cramped);
    expect(fitted).toHaveLength(1);
    expect(fitted[0]?.length).toBeGreaterThan(0);
  });

  it('keeps at least one real character before the ellipsis', () => {
    // Degrading to a bare "…" would label the desk with nothing at all.
    const fitted = fitPlateLines(['backend-developer'], {
      widthPx: 7,
      heightPx: 100,
      nameSizePx: 10,
      detailSizePx: 8,
      lineHeightPx: 9,
    });
    expect(fitted[0]).toMatch(/^.+…$/);
  });

  it('leaves short lines untouched — no gratuitous ellipsis', () => {
    expect(fitPlateLines(['api', 'haiku'], boxAtScale(2))).toEqual(['api', 'haiku']);
  });

  it('handles an empty plate without throwing', () => {
    expect(() => fitPlateLines([], boxAtScale(1))).not.toThrow();
  });
});

describe('the desk-spacing constants scene.ts mirrors are still the real ones', () => {
  it('matches what layoutOffice actually produces', () => {
    // `scene.ts` hardcodes DESK_SPACING_TILES_X/Y = 4 to size the plate box,
    // because `model.ts` keeps its grid constants private. That copy is only
    // safe while it agrees with the layout it describes — so this measures the
    // real spacing rather than trusting the comment.
    const layout = layoutOffice(8); // 3 columns x 3 rows at this count
    const [first, second] = layout.desks;
    if (first === undefined || second === undefined) throw new Error('expected desks');

    const columnGap = Math.abs(second.desk.x - first.desk.x);
    expect(columnGap, 'DESK_SPACING_TILES_X in scene.ts must match this').toBe(4);

    // First desk of the second row, to measure vertical spacing.
    const perRow = layout.columns;
    const nextRow = layout.desks[perRow];
    if (nextRow === undefined) throw new Error('expected a second row');
    expect(nextRow.desk.y - first.desk.y, 'DESK_SPACING_TILES_Y must match this').toBe(4);
  });
});
