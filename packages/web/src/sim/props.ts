import { OFFICE, THEMES } from '../theme/tokens.js';
import { createGrid, fillRect, setPixel, clearPixel, outlineRect } from './pixelGrid.js';
import type { PixelGrid, PropGenerator, PropName } from './spriteContract.js';

/**
 * The office's furniture (FR-S9's prop half, FR-U3).
 *
 * Split out of `sprites.ts` in Phase 10. A prop shares nothing with a character
 * but the drawing primitives: it takes no {@link AgentAppearance}, no animation
 * and no frame, so unlike a character it is a *constant* — which is why every
 * one of these is built once at module load into a fixed table rather than
 * memoised per call. That is the cheapest possible caching, bounded by
 * construction instead of by a size check.
 *
 * Props are also free of the character box. `spriteContract.ts` confines a
 * frame to `SPRITE_WIDTH × SPRITE_HEIGHT`; a bookshelf is wider than it is tall
 * and a rug is wider still, so each prop below declares its own dimensions and
 * the renderer reads them off the grid when it uploads the texture.
 *
 * ## What changed in the Phase 10 repaint
 *
 * The first pass through this file got the module compiling but drew every
 * prop as a flat, mostly-unoutlined rectangle — which is exactly what the
 * office's own repaint (`theme/tokens.ts`'s `OFFICE`) turned from a cosmetic
 * miss into a real bug: a `desk` coloured `#b38856` sitting on a `floorLight`
 * of `#734728` is two different browns with nothing between them, so on a
 * warm wood floor an unoutlined desk did not read as furniture, it read as a
 * lighter patch of floor. Every shape below now follows two rules the
 * reference art itself follows: a 1px `OFFICE.outline` ring around the
 * object's silhouette (drawn with `outlineRect`, which stamps the border
 * *outside* the rectangle it is given — call it on a rectangle already 1px
 * shy of the grid edge and the border lands exactly on that edge; call it on
 * a rectangle that already fills the grid and the border is computed
 * off-canvas and silently clipped to nothing, which is why the full-bleed
 * shapes below — the bookshelf carcass, the wall art canvas — inset their
 * fill by 1px before outlining rather than outlining the raw grid bounds),
 * and a lit top/front face plus a darker one beneath or behind it, so a
 * surface reads as having a top rather than being a silhouette filled with
 * one flat colour.
 *
 * One deliberate exception: where a shape is flush against the *bottom* edge
 * of its own grid (desk legs, the chair's base, the plant's pot), the outline
 * calls at that edge land one row past the grid and are clipped the same way
 * a full-bleed outline would be. That is left as-is rather than worked
 * around, because the missing line is exactly where the object meets the
 * floor it stands on — there is nothing to outline there, the object simply
 * continues into the tile.
 *
 * FR-U2 still applies in full: every colour here comes from `theme/tokens.ts`.
 * Props carry no per-agent ramp, so their colours are ordinary constants rather
 * than slices of an appearance — but a constant is exactly the kind of value
 * that gets typed in as a hex literal and then forgotten when the palette is
 * retuned, which is the failure FR-U2 exists to prevent. There is no `shade()`
 * derivation helper in this file: `OFFICE` already supplies a lit/dark pair
 * for every material the room needs (`desk`/`deskEdge`, `plant`/`plantLight`,
 * `couch`/`couchLight`, `carpet`/`carpetDark`, and so on), so deriving further
 * variants at runtime would just be another way to spell a token that already
 * exists, and would also weaken `props.test.ts`'s FR-U2 check from "every
 * colour drawn is literally one of these tokens" to something that has to
 * replay a derivation to know what is allowed. Keeping every colour a direct
 * token reference keeps that test a plain membership check.
 */

// -- palette aliases ---------------------------------------------------------
//
// Named for what they are *in the room* rather than for the token they come
// from, so the drawing code below reads as furniture rather than as colour
// lookups.

const OUTLINE = OFFICE.outline;

const DESK_TOP = OFFICE.desk;
const DESK_EDGE = OFFICE.deskEdge;
const DESK_LEG = OFFICE.deskLeg;
const MANAGER_TOP = OFFICE.managerDesk;
const MANAGER_EDGE = OFFICE.managerDeskEdge;

const CHAIR = OFFICE.chair;
const CHAIR_DARK = OFFICE.chairDark;

const MONITOR = OFFICE.monitor;
const MONITOR_DARK = OFFICE.monitorDark;
const SCREEN = OFFICE.screen;
const SCREEN_GLOW = OFFICE.screenGlow;

const PLANT = OFFICE.plant;
const PLANT_LIGHT = OFFICE.plantLight;
const PLANT_POT = OFFICE.plantPot;

const SHELF = OFFICE.shelf;
const BOOKS = OFFICE.shelfBooks;
const BOOKS_ALT = OFFICE.shelfBooksAlt;

const FRAME = OFFICE.frame;
const COUCH = OFFICE.couch;
const COUCH_LIGHT = OFFICE.couchLight;
const CARPET = OFFICE.carpet;
const CARPET_DARK = OFFICE.carpetDark;

const PAPER_COLOUR = OFFICE.paper;
const PAPER_LINE = OFFICE.paperLine;

// The neutral speech bubble and the light mark drawn on the alert/error
// bubbles both want the same thing: the office's lightest, most paper-like tone
// for contrast against a dark or saturated fill.
const SPEECH_FILL = OFFICE.paper;
const MARK_LIGHT = OFFICE.paper;
// Alert/error bubbles intentionally track the chrome's own status hues
// (`THEMES.dark`, not `THEMES[mode]` — the office never follows the light
// theme, see `theme/tokens.ts`), so "blocked" and "failed" read as the same
// colour here as they do everywhere else the app shows status.
const ALERT_FILL = THEMES.dark.statusWaiting;
const ERROR_FILL = THEMES.dark.statusBad;

// -- workstations ------------------------------------------------------------

/**
 * A desk with a monitor on it.
 *
 * The monitor is part of the desk rather than a prop of its own, because it is
 * never drawn anywhere else and a separate prop would mean the renderer having
 * to know how far up a desk a screen sits — geometry that belongs here, with
 * the thing it describes.
 *
 * `width` is the only thing that differs between the ordinary desk and the
 * Manager's: a wider slab, wider legs spacing and (via the `top`/`edge`
 * arguments) a lighter wood, all in service of FR-S9's requirement that the
 * Manager's desk be the one a reader can pick out of a floor of identical
 * workstations without reading a single nameplate.
 */
function buildDeskLike(top: string, edge: string, width: number): PixelGrid {
  const height = 24;
  const grid = createGrid(width, height);
  const left = 1;
  const span = width - 2;

  // -- the monitor --------------------------------------------------------
  //
  // Centred over the desk and drawn first, so the desk's own outline (drawn
  // after) does not have to route around it.
  const bezelWidth = 8;
  const bezelHeight = 6;
  const bezelLeft = left + Math.floor((span - bezelWidth) / 2);
  const bezelTop = 3;

  fillRect(grid, bezelLeft, bezelTop, bezelWidth, bezelHeight, MONITOR);
  fillRect(grid, bezelLeft + 1, bezelTop + 1, bezelWidth - 2, bezelHeight - 2, SCREEN);
  // Two lit rows: the phosphor is the one place the terminal identity is
  // literally true, so it is spent here and nowhere else in the room.
  fillRect(grid, bezelLeft + 2, bezelTop + 2, bezelWidth - 4, 1, SCREEN_GLOW);
  setPixel(grid, bezelLeft + 2, bezelTop + 3, SCREEN_GLOW);
  setPixel(grid, bezelLeft + 3, bezelTop + 3, SCREEN_GLOW);
  outlineRect(grid, bezelLeft, bezelTop, bezelWidth, bezelHeight, OUTLINE);

  // The stand: a dark strip for the monitor's underside, then a short neck
  // down to the desk surface. The strip sits one row below the bezel's own
  // outline (rather than on it) so the black outline ring survives instead of
  // being painted over by the strip that follows it.
  const stripRow = bezelTop + bezelHeight + 1;
  fillRect(grid, bezelLeft, stripRow, bezelWidth, 1, MONITOR_DARK);
  const neckTop = stripRow + 1;
  const neckWidth = 2;
  const neckLeft = bezelLeft + Math.floor(bezelWidth / 2) - 1;

  // -- the desk slab --------------------------------------------------------
  const surfaceTop = 13;
  const surfaceRows = 3;
  const edgeRows = 2;
  fillRect(grid, left, surfaceTop, span, surfaceRows, top);
  fillRect(grid, left, surfaceTop + surfaceRows, span, edgeRows, edge);
  outlineRect(grid, left, surfaceTop, span, surfaceRows + edgeRows, OUTLINE);

  // The neck's height is derived from the gap it actually has to cross, not a
  // constant, so a future retune of `surfaceTop` cannot silently leave the
  // monitor floating above the desk or buried inside it.
  const neckHeight = Math.max(1, surfaceTop - neckTop);
  fillRect(grid, neckLeft, neckTop, neckWidth, neckHeight, MONITOR_DARK);

  // A keyboard: the one desk detail that is neither monitor nor slab, and the
  // cheapest way to make the surface read as "in use" rather than bare.
  fillRect(grid, bezelLeft, surfaceTop, bezelWidth, 1, MONITOR_DARK);

  // -- legs -----------------------------------------------------------------
  //
  // Inset one pixel from the slab's own corners, so the desk reads as a frame
  // standing on two feet rather than a box on stilts.
  const legTop = surfaceTop + surfaceRows + edgeRows;
  const legBottom = height - 1;
  const legHeight = legBottom - legTop + 1;
  const legWidth = 2;
  const legInset = 1;
  const leftLegX = left + legInset;
  const rightLegX = left + span - legInset - legWidth;

  fillRect(grid, leftLegX, legTop, legWidth, legHeight, DESK_LEG);
  fillRect(grid, rightLegX, legTop, legWidth, legHeight, DESK_LEG);
  // Only the top of each leg gets an explicit outline call: the bottom would
  // land one row past the grid (the legs are flush with the tile floor) and
  // clip to nothing, and the sides double as the divider between leg and the
  // desk's own underside colour without needing a black line there too.
  outlineRect(grid, leftLegX, legTop, legWidth, legHeight, OUTLINE);
  outlineRect(grid, rightLegX, legTop, legWidth, legHeight, OUTLINE);

  return grid;
}

/** An office chair, drawn from behind — the back is what you see at a desk. */
function buildChair(): PixelGrid {
  const grid = createGrid(16, 24);

  // Backrest: a lit main panel with a darker seam along the bottom, so it
  // reads as upholstery with a fold rather than a flat tile.
  const backLeft = 5;
  const backWidth = 6;
  const backTop = 7;
  const backHeight = 6;
  fillRect(grid, backLeft, backTop, backWidth, backHeight - 1, CHAIR);
  fillRect(grid, backLeft, backTop + backHeight - 1, backWidth, 1, CHAIR_DARK);
  outlineRect(grid, backLeft, backTop, backWidth, backHeight, OUTLINE);

  // Seat: wider than the back, the way an office chair's cushion overhangs
  // its own backrest when seen from behind.
  const seatLeft = 4;
  const seatWidth = 8;
  const seatTop = backTop + backHeight;
  const seatHeight = 3;
  fillRect(grid, seatLeft, seatTop, seatWidth, seatHeight - 1, CHAIR);
  fillRect(grid, seatLeft, seatTop + seatHeight - 1, seatWidth, 1, CHAIR_DARK);
  outlineRect(grid, seatLeft, seatTop, seatWidth, seatHeight, OUTLINE);

  // Post and a five-point base flattened to a single bar — legible at 16px is
  // the bar; a literal five-point star is not.
  const postTop = seatTop + seatHeight;
  const postHeight = 3;
  fillRect(grid, 7, postTop, 2, postHeight, CHAIR_DARK);
  const baseTop = postTop + postHeight;
  fillRect(grid, 3, baseTop, 10, 1, CHAIR_DARK);
  outlineRect(grid, 3, baseTop, 10, 1, OUTLINE);

  return grid;
}

// -- the room ----------------------------------------------------------------

/**
 * A potted plant. The reference's most recognisable furnishing, so ours too.
 *
 * Foliage is drawn as four overlapping leaf clusters of different sizes and
 * offsets rather than one symmetric blob: a single mirrored silhouette reads
 * as a logo at this size, where four unequal clumps — each with its own top
 * highlight and its own outline — read as leaves.
 */
function buildPlant(): PixelGrid {
  const grid = createGrid(14, 19);

  const clusters: readonly { x: number; y: number; w: number; h: number }[] = [
    { x: 2, y: 4, w: 5, h: 4 }, // main left mass
    { x: 6, y: 2, w: 5, h: 6 }, // taller right mass, sets the plant's peak
    { x: 1, y: 8, w: 4, h: 2 }, // low left frond, drooping past the main mass
    { x: 9, y: 7, w: 3, h: 2 }, // small right frond — deliberately the smallest, for asymmetry
  ];
  for (const c of clusters) {
    fillRect(grid, c.x, c.y, c.w, c.h, PLANT);
    fillRect(grid, c.x, c.y, c.w, 1, PLANT_LIGHT);
    outlineRect(grid, c.x, c.y, c.w, c.h, OUTLINE);
  }

  // Stem, bridging the foliage to the pot.
  fillRect(grid, 6, 10, 2, 3, PLANT);
  outlineRect(grid, 6, 10, 2, 3, OUTLINE);

  // Pot: flush with the bottom of the grid, so it sits on the tile with no
  // gap — its own bottom outline is therefore clipped away, by design (see
  // the file header): there is nothing to outline where the pot meets floor.
  const potLeft = 3;
  const potTop = 13;
  const potWidth = 8;
  const potHeight = 6;
  fillRect(grid, potLeft, potTop, potWidth, potHeight, PLANT_POT);
  fillRect(grid, potLeft + 1, potTop, potWidth - 2, 1, OUTLINE);
  outlineRect(grid, potLeft, potTop, potWidth, potHeight, OUTLINE);

  return grid;
}

/**
 * A wall bookshelf. Wider than it is tall — hence props not being box-bound.
 *
 * The carcass fills the entire grid (there is no room around a wall shelf the
 * way there is around a desk), so its outline is drawn inset by one pixel
 * rather than via a plain `outlineRect` call on the full bounds — see the file
 * header for why the latter would silently draw nothing.
 */
function buildBookshelf(): PixelGrid {
  const width = 28;
  const height = 18;
  const grid = createGrid(width, height);

  fillRect(grid, 0, 0, width, height, SHELF);
  fillRect(grid, 1, 8, width - 2, 1, OUTLINE); // the divider board between the two compartments
  outlineRect(grid, 1, 1, width - 2, height - 2, OUTLINE);

  // Spines: a fixed palette cycled with alternating widths and an occasional
  // shorter spine, so the run reads as a shelf of different books rather than
  // a striped pattern — a perfectly uniform repeat here would look like a
  // barcode, not a bookshelf. None of these tokens is "book-coloured" by
  // name; FR-U2 only asks that every colour trace back to `OFFICE`, and a
  // shelf wants more variety than the two dedicated `shelfBooks*` tokens
  // alone provide.
  const spinePalette = [BOOKS, BOOKS_ALT, PLANT_LIGHT, MANAGER_TOP, COUCH_LIGHT, CARPET];
  const compartments = [
    { top: 1, bottom: 7 },
    { top: 9, bottom: 16 },
  ];

  let paletteIndex = 0;
  for (const row of compartments) {
    let x = 1;
    let bookIndex = 0;
    while (x < width - 1) {
      const bookWidth = bookIndex % 3 === 2 ? 1 : 2;
      if (x + bookWidth > width - 1) break;
      const shrink = bookIndex % 4 === 1 ? 1 : 0;
      const colour = spinePalette[paletteIndex % spinePalette.length] ?? BOOKS;
      fillRect(grid, x, row.top + shrink, bookWidth, row.bottom - row.top - shrink, colour);
      x += bookWidth;
      bookIndex += 1;
      paletteIndex += 1;
    }
  }

  return grid;
}

/** A wall clock. Small, round-ish, and the room's only moving-looking detail. */
function buildWallClock(): PixelGrid {
  const grid = createGrid(12, 12);
  // A circle at 12px is faked the way pixel art always fakes one: a wide
  // middle band and narrower caps above and below it.
  fillRect(grid, 2, 0, 8, 12, OUTLINE);
  fillRect(grid, 0, 2, 12, 8, OUTLINE);
  fillRect(grid, 3, 1, 6, 10, PAPER_COLOUR);
  fillRect(grid, 1, 3, 10, 6, PAPER_COLOUR);
  // Tick marks at 12/3/6/9, dim against the face the way printed numerals
  // would be — the same lit/dim relationship `plateDetail` has to `nameplate`.
  setPixel(grid, 6, 2, PAPER_LINE);
  setPixel(grid, 6, 9, PAPER_LINE);
  setPixel(grid, 2, 6, PAPER_LINE);
  setPixel(grid, 9, 6, PAPER_LINE);
  // Hands, at a fixed hour — a clock that told the wrong time would be worse
  // than one that plainly tells none.
  setPixel(grid, 6, 5, OUTLINE);
  setPixel(grid, 6, 6, OUTLINE);
  setPixel(grid, 7, 6, OUTLINE);
  return grid;
}

/**
 * A framed picture on the wall.
 *
 * Like the bookshelf, the frame fills the whole grid, so its outer edge is
 * drawn directly rather than via an out-of-bounds `outlineRect` call.
 */
function buildWallArt(): PixelGrid {
  const width = 16;
  const height = 12;
  const grid = createGrid(width, height);

  fillRect(grid, 0, 0, width, height, FRAME);
  outlineRect(grid, 1, 1, width - 2, height - 2, OUTLINE);
  fillRect(grid, 2, 2, width - 4, height - 4, CARPET);
  fillRect(grid, 2, 2, width - 4, 1, OUTLINE); // the mat line between frame lip and canvas
  // A horizon and a sun disc: the least amount of detail that still reads as
  // "picture" rather than "blank rectangle" at 16×12.
  fillRect(grid, 2, height - 5, width - 4, 3, PLANT);
  fillRect(grid, width - 6, 3, 2, 2, PAPER_COLOUR);
  return grid;
}

/** A two-seat couch for the lounge strip. */
function buildCouch(): PixelGrid {
  const width = 26;
  const height = 16;
  const grid = createGrid(width, height);

  const armWidth = 2;
  const bodyLeft = armWidth;
  const bodyWidth = width - armWidth * 2;
  const backTop = 3;
  const seatTop = 8;
  const seatBottom = 12;

  // Back cushion: a lit top band, a darker seat band beneath it, so the couch
  // reads as two stacked cushions rather than one flat block.
  fillRect(grid, bodyLeft, backTop, bodyWidth, seatTop - backTop, COUCH_LIGHT);
  fillRect(grid, bodyLeft, seatTop, bodyWidth, seatBottom - seatTop, COUCH);
  outlineRect(grid, bodyLeft, backTop, bodyWidth, seatBottom - backTop, OUTLINE);

  // Arms: their own outlined blocks, taller than the back cushion by one row
  // on each end, so they read as bolsters rather than a wider backrest. Each
  // touches its own side of the grid, so (matching the file header's flush
  // convention) only the outer column of each arm goes without a line — the
  // couch is meant to run edge-to-edge in its footprint.
  const armTop = backTop - 1;
  const armHeight = seatBottom - backTop + 2;
  fillRect(grid, 0, armTop, armWidth, armHeight, COUCH);
  fillRect(grid, width - armWidth, armTop, armWidth, armHeight, COUCH);
  outlineRect(grid, 0, armTop, armWidth, armHeight, OUTLINE);
  outlineRect(grid, width - armWidth, armTop, armWidth, armHeight, OUTLINE);

  // Seam between the two seat cushions — the one interior line the reference
  // draws on its couch.
  const seamX = bodyLeft + Math.floor(bodyWidth / 2);
  fillRect(grid, seamX, seatTop, 1, seatBottom - seatTop, COUCH_LIGHT);

  return grid;
}

/**
 * The rug under the Manager's desk, and the lounge floor.
 *
 * Unlike every other prop, this one deliberately carries no black outline.
 * Rule 1 in the file header exists because furniture and the floor were both
 * shades of the same wood; a rug's whole job is to be a *different* material
 * from the floor around it (`carpet`/`carpetDark` against `floorLight`/
 * `floorDark`), so the contrast an outline would otherwise supply is already
 * there. Outlining it in black in addition would make a floor covering read
 * as a solid object sitting a pixel above the boards, which is worse, not
 * better. Its two nested borders (edge and inset) are its two-tone treatment.
 */
function buildRug(): PixelGrid {
  const width = 48;
  const height = 24;
  const grid = createGrid(width, height);

  fillRect(grid, 0, 0, width, height, CARPET);
  fillRect(grid, 0, 0, width, 1, CARPET_DARK);
  fillRect(grid, 0, height - 1, width, 1, CARPET_DARK);
  fillRect(grid, 0, 0, 1, height, CARPET_DARK);
  fillRect(grid, width - 1, 0, 1, height, CARPET_DARK);
  fillRect(grid, 3, 3, width - 6, 1, CARPET_DARK);
  fillRect(grid, 3, height - 4, width - 6, 1, CARPET_DARK);
  fillRect(grid, 3, 3, 1, height - 6, CARPET_DARK);
  fillRect(grid, width - 4, 3, 1, height - 6, CARPET_DARK);

  return grid;
}

// -- carried and overhead ----------------------------------------------------

function buildPaper(): PixelGrid {
  const grid = createGrid(16, 24);
  fillRect(grid, 5, 8, 6, 8, PAPER_COLOUR);
  outlineRect(grid, 5, 8, 6, 8, OUTLINE);
  for (const y of [10, 11, 12, 13]) fillRect(grid, 6, y, 4, 1, PAPER_LINE);
  // A folded corner: the cheapest way to say "page", not "tile".
  clearPixel(grid, 10, 8);
  setPixel(grid, 9, 9, PAPER_LINE);
  return grid;
}

// A one-pixel margin on every side, so the bubble's `outlineRect` call always
// has room to draw its border without landing off-canvas (see the file
// header's full-bleed note) — the earlier revision had the shell flush with
// the top of the grid and relied on hand-drawn corner clears instead of a
// real border.
const BUBBLE_LEFT = 3;
const BUBBLE_RIGHT = 12;
const BUBBLE_TOP = 1;
const BUBBLE_BOTTOM = 9;

/**
 * The shared bubble shell: a filled rectangle, outlined, with its four
 * corners knocked back out to transparent so it reads as "rounded" rather
 * than as a hard rectangle, plus a two-pixel tail pointing at the speaker.
 * The mark inside is what distinguishes the three kinds, and is drawn in a
 * colour that contrasts with the fill rather than relying on shape alone —
 * useful for anyone who cannot rely on shape alone either.
 */
function buildBubble(fill: string, mark: string, kind: 'dots' | 'exclaim' | 'cross'): PixelGrid {
  const grid = createGrid(16, 24);
  const width = BUBBLE_RIGHT - BUBBLE_LEFT + 1;
  const height = BUBBLE_BOTTOM - BUBBLE_TOP + 1;
  fillRect(grid, BUBBLE_LEFT, BUBBLE_TOP, width, height, fill);
  outlineRect(grid, BUBBLE_LEFT, BUBBLE_TOP, width, height, OUTLINE);
  clearPixel(grid, BUBBLE_LEFT, BUBBLE_TOP);
  clearPixel(grid, BUBBLE_RIGHT, BUBBLE_TOP);
  clearPixel(grid, BUBBLE_LEFT, BUBBLE_BOTTOM);
  clearPixel(grid, BUBBLE_RIGHT, BUBBLE_BOTTOM);

  setPixel(grid, 7, BUBBLE_BOTTOM + 1, fill);
  setPixel(grid, 7, BUBBLE_BOTTOM + 2, fill);

  switch (kind) {
    case 'dots':
      for (const x of [5, 7, 9]) fillRect(grid, x, 5, 1, 1, mark);
      break;
    case 'exclaim':
      fillRect(grid, 7, 3, 2, 4, mark);
      fillRect(grid, 7, 8, 2, 1, mark);
      break;
    case 'cross':
      for (let i = 0; i < 5; i += 1) {
        setPixel(grid, 5 + i, 3 + i, mark);
        setPixel(grid, 9 - i, 3 + i, mark);
      }
      break;
  }

  return grid;
}

const PROP_GRIDS: Record<PropName, PixelGrid> = {
  desk: buildDeskLike(DESK_TOP, DESK_EDGE, 18),
  // Wider and lighter than an ordinary desk: grander by silhouette alone,
  // before its colour is even considered.
  manager_desk: buildDeskLike(MANAGER_TOP, MANAGER_EDGE, 26),
  chair: buildChair(),
  plant: buildPlant(),
  bookshelf: buildBookshelf(),
  wall_clock: buildWallClock(),
  wall_art: buildWallArt(),
  couch: buildCouch(),
  rug: buildRug(),
  paper: buildPaper(),
  bubble_speech: buildBubble(SPEECH_FILL, OUTLINE, 'dots'),
  bubble_alert: buildBubble(ALERT_FILL, MARK_LIGHT, 'exclaim'),
  bubble_error: buildBubble(ERROR_FILL, MARK_LIGHT, 'cross'),
};

export const prop: PropGenerator = (name) => PROP_GRIDS[name];
