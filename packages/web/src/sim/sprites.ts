import { BODY_VARIANTS, HAIR_STYLES, type AgentAppearance } from './model.js';
import { OFFICE } from '../theme/tokens.js';
import {
  clearPixel,
  createGrid,
  fillRect,
  mirrorGrid,
  setPixel,
  widthOf,
  wrap,
  type MutableGrid,
} from './pixelGrid.js';
import { prop } from './props.js';
import {
  FRAMES_PER_ANIMATION,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
  type Facing,
  type FrameGenerator,
  type PixelGrid,
  type PropName,
  type SpriteAnimation,
  type SpriteKey,
  type SpriteManifest,
} from './spriteContract.js';

/**
 * The procedural sprite pack (FR-S2 deterministic sprites, FR-S9 swappable pack).
 *
 * Everything here is arithmetic over an {@link AgentAppearance} — no randomness,
 * no I/O, no DOM. That is what lets `spriteContract.ts` promise a total, pure
 * `FrameGenerator`: the same inputs always draw the same pixels, and every
 * input, including ones a real caller would never send (a negative frame, a
 * body index out of range), still returns a well-formed grid rather than
 * throwing inside the renderer's frame loop.
 *
 * FR-S3 (status drives behaviour, not the other way round) is why the six
 * animations below are drawn to be tell-apart-able at a glance rather than
 * merely different in code: `idle_relaxed` (a `done` agent) and `idle_slumped`
 * (a `failed` one) exist so a user can read run health off the office without
 * opening a single assignment. Colour comes entirely from `AgentAppearance` —
 * skin, hair, shirt and trousers are never hardcoded here.
 *
 * Phase 10 redraws every character for the 16×24 box `spriteContract.ts` grew
 * to (see that file for why 12×16 could not hold this). Four things changed
 * beyond a bigger canvas:
 *
 * - **Chibi proportions.** The first pass at this box kept an anatomically
 *   plausible ratio — a 6-row head over an 18-row body — and it was wrong: a
 *   reviewer sampled the reference character sheet and found the head+hair
 *   mass occupying the *top ~58%* of the figure and measuring *wider* than
 *   the torso, not narrower. That is deliberately chibi, not a stylistic
 *   accident — a big head is where the hair silhouette (the thing an agent is
 *   actually recognised by) gets the pixels to read at this size, and it is
 *   also most of the reference's charm. `HEAD_ROWS` and `HEAD_LEFT`/`RIGHT`
 *   below are tuned to that measurement, not to what a realistic figure would
 *   use.
 *
 * - **Two-tone shading**. `shade()` derives a lighter and a darker variant of
 *   an appearance colour, and `fillShadedRect()` uses both to give every mass
 *   — head, torso, legs — a one-pixel lit edge and a one-pixel shadowed edge
 *   instead of a flat fill. That, more than the extra pixels, is what stops a
 *   character reading as coloured rectangles.
 * - **A silhouette outline.** `outlineSilhouette()` runs once per frame after
 *   every part is painted and draws `OFFICE.outline` around whatever shape the
 *   pose actually produced — not a fixed rectangle, because a raised hand or an
 *   overhanging hairstyle changes the silhouette's outline from pose to pose.
 *   The office floor is warm wood now, not near-black, so an unoutlined figure
 *   genuinely disappears into it without this.
 * - **Six real hair silhouettes.** `HAIR_STYLES` is exported from `model.ts`,
 *   which this file does not own, and its owner raised it from 4 to 6 for this
 *   phase specifically so each style could be a genuinely distinct shape — a
 *   side-parted fringe, a tall wavy crown, a round afro, a bob, a spiky crop
 *   and a close-cropped short cut — rather than a handful of near-identical
 *   caps. `paintHair` reads the count off `HAIR_STYLES` and reaches every case
 *   through `wrap()`, so an out-of-range index still clips to a real shape
 *   instead of drawing nothing.
 *
 * `OUTLINE` below is the one fixed colour a character still carries on top of
 * its palette: eyes, shoe soles and the new silhouette border are a structural
 * detail of "this is a person", not part of any agent's identity, so they stay
 * constant while skin/hair/shirt/trousers are palette-driven.
 *
 * A second pass followed once the first render of all this was actually
 * looked at rather than read as a diff: the chibi proportions above were
 * right, but the head they were applied to had nothing in it — a full block
 * of skin with a thin hair cap, no visible eyes, hands lost against the
 * torso's own shading. Three fixes, all still governed by the same rules
 * above:
 *
 * - **Hair frames the face instead of capping it.** `paintHair` no longer
 *   draws a shape that merely sits above the skull; `paintHairFrame` gives
 *   every style a full-width band across the top of the head *and* two
 *   darker columns running down its sides, so the face — narrower than the
 *   head, inset `FACE_INSET` columns each side — reads as peeking out from
 *   inside a mass of hair rather than wearing a hat.
 * - **Eyes are a sclera and a pupil, not two dots.** `paintEye` fills a 2×2
 *   `EYE_WHITE` square with a single `OUTLINE` pixel punched into its inner
 *   column. This is the highest-value single change in the file: a light
 *   eye with a dark pupil is unmistakably a face at 16px in a way two flat
 *   `OUTLINE` dots never were.
 * - **Hands stand off the torso by a transparent column.** `outlineSilhouette`
 *   borders silhouette-to-background edges, not boundaries between two
 *   differently-coloured filled cells — so a hand painted flush against a
 *   sleeve got no dividing line and read as lost in the shading. `poseFor`'s
 *   outward-hanging poses now offset hands by `dx: ±2` instead of `±1`,
 *   leaving the gap the outline needs to trace an outline around them.
 */

/**
 * A transparent character-sized grid.
 *
 * The drawing primitives themselves now live in `pixelGrid.ts`, shared with
 * `props.ts` — see that file for why the two split. This wrapper exists so the
 * character code below never has to restate its own box size.
 */
function createCharacterGrid(): MutableGrid {
  return createGrid(SPRITE_WIDTH, SPRITE_HEIGHT);
}

// Eyes, shoe soles and the silhouette outline: a structural detail of "this is
// a person", not part of any agent's identity, so it stays constant while
// skin/hair/shirt/trousers are palette-driven (see the file header). It still
// has to come from tokens (FR-U2 — no second colour source in this
// directory). It has its own token rather than borrowing the backdrop's: an
// outline that tracked `OFFICE.background` would silently disappear the day
// the floor is retuned darker, and "the characters lost their outline" is not
// a bug anyone would trace back to a background tweak.
const OUTLINE = OFFICE.outline;

// The sclera: a light colour behind the dark `OUTLINE` pupil, and the single
// highest-value detail in the whole sprite — a coordinator who compared a
// rendered sheet against the reference art directly found that two dark dots
// (this file's first pass at eyes) read as a smudge at 16px, while a light
// sclera behind a dark pupil reads unmistakably as a face. Its own token
// rather than reusing `paper` (a near-white already in `OFFICE`): an eye and
// a sheet of paper have no reason to move together, and aliasing them would
// mean a future warm-up of the report page silently tinting everybody's eyes.
const EYE_WHITE = OFFICE.eyeWhite;

/**
 * Darken (`amount` negative) or lighten (`amount` positive) a `#rrggbb`
 * colour by adding `amount` to every channel and clamping back into
 * `[0, 255]`.
 *
 * This is what keeps the two-tone shading below inside FR-U2's rule: every
 * shaded pixel is *derived* from an `AgentAppearance` colour rather than a
 * second, independently chosen one, so a palette retune in `theme/tokens.ts`
 * still reaches every lit and shadowed pixel automatically — there is nothing
 * here for a future repaint to forget to update. Malformed input (anything
 * that is not six hex digits) is handed back unchanged rather than guessed
 * at: the only colours this is ever called with come from `SPRITE_RAMP`,
 * which is always well-formed, so this branch exists for `frame()`'s
 * totality guarantee, not because it is expected to run.
 */
function shade(hex: string, amount: number): string {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) return hex;
  const value = Number.parseInt(cleaned, 16);
  if (Number.isNaN(value)) return hex;
  const clamp = (channel: number): number => Math.max(0, Math.min(255, Math.round(channel + amount)));
  const toHex = (channel: number): string => channel.toString(16).padStart(2, '0');
  const r = clamp((value >> 16) & 0xff);
  const g = clamp((value >> 8) & 0xff);
  const b = clamp(value & 0xff);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** How far `shade()` moves a channel for the lit/shadowed edge of a mass. */
const LIGHT_AMOUNT = 34;
const DARK_AMOUNT = 34;

/**
 * A flat fill with a one-pixel highlight down its lit (left) edge and a
 * one-pixel shadow down its shaded (right) edge.
 *
 * This is FR-U2's two-tone requirement without abandoning the same
 * requirement's other half. A clean 50/50 split would put half of every mass
 * in a colour that is not literally `appearance.shirt` (or skin, or
 * trousers) — and the reference art does not shade that way either: a rim of
 * light and dark around an otherwise flat fill is what makes a mass read as
 * rounded, whereas a half-and-half split reads as two adjacent flat objects
 * glued together. The bulk of every rect therefore stays the caller's exact
 * colour, which is also what keeps `appearance.skin`/`shirt`/`trousers`
 * literally findable in the output grid, not just something derived from
 * them. Rects narrower than 2 columns skip the edges entirely rather than
 * let the highlight and shadow columns collide and cancel out.
 */
function fillShadedRect(
  grid: MutableGrid,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colour: string,
): void {
  fillRect(grid, x0, y0, w, h, colour);
  if (w < 2) return;
  fillRect(grid, x0, y0, 1, h, shade(colour, LIGHT_AMOUNT));
  fillRect(grid, x0 + w - 1, y0, 1, h, shade(colour, -DARK_AMOUNT));
}

/**
 * A hand: two pixels tall rather than the single dot the old 12×16 box could
 * afford, now that there is room for one. Kept as its own function because
 * `paintTorsoAndArms`'s left and right hand must share the exact same shape —
 * a divergence there would be an accident of which call site got edited, not
 * a meaningful difference between a character's two hands.
 */
function paintHand(grid: MutableGrid, x: number, y: number, colour: string): void {
  fillRect(grid, x, y, 1, 2, colour);
}

/**
 * A one-pixel black border traced around whatever silhouette the character's
 * parts actually painted, run once after all of them are down.
 *
 * A fixed `outlineRect` (the primitive `props.ts` uses for furniture) will
 * not do here: a character's silhouette is not a rectangle — a raised hand
 * pokes past the torso, a bushy hairstyle overhangs the head, a lifted leg
 * shortens the bottom edge — and it changes from pose to pose and frame to
 * frame. So instead of tracing a fixed shape, this walks every cell of the
 * grid and paints `OUTLINE` on any transparent cell that is orthogonally
 * adjacent to a painted one. That makes it correct for any silhouette the
 * poses above can produce, including ones nobody drawing this file by hand
 * anticipated.
 *
 * It reads from a snapshot taken before any outline pixel is written, not
 * from the grid being mutated in place. Without that, an outline pixel
 * placed early in the left-to-right, top-to-bottom sweep would itself read
 * as "part of the silhouette" to a cell examined moments later, thickening
 * the border by more than one pixel wherever two body parts meet at a
 * diagonal — a slumped hand next to a leg, say.
 */
function outlineSilhouette(grid: MutableGrid): void {
  const height = grid.length;
  const width = widthOf(grid);
  const snapshot = grid.map((row) => [...row]);
  const filled = (x: number, y: number): boolean => {
    if (y < 0 || y >= height) return false;
    const row = snapshot[y];
    if (row === undefined || x < 0 || x >= width) return false;
    return row[x] !== null;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (filled(x, y)) continue;
      if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) {
        setPixel(grid, x, y, OUTLINE);
      }
    }
  }
}

// Layout constants for the 16×24 box (see spriteContract.ts for why it grew
// from 12×16, and the file header for why the head is disproportionately
// large). None of this is derived from SPRITE_WIDTH/SPRITE_HEIGHT by formula
// — a 12×16 figure does not scale to 16×24 by simple ratio, so every value
// below was worked out by hand for this specific box — but every draw call is
// bounds-checked regardless, so a future contract change would clip rather
// than crash even before the numbers here were re-tuned for it.
//
// The head+hair zone is rows 0-13 (58% of the box, matching the reference
// measurement in the file header) and the skull itself — the part
// `fillShadedRect` fills solid — is HEAD_ROWS = 10 of those 14, rows 4-13,
// leaving rows 0-3 as headroom the hair layer sits in and overhangs into.
// HEAD_LEFT/RIGHT give the skull a 10px width, wider than the broadest torso
// span below (8px) at every body variant — the chibi proportion the file
// header explains is the point, not an accident of these two numbers landing
// how they did.
const HEAD_LEFT = 3;
const HEAD_RIGHT = 12;
const HEAD_TOP = 4;
const HEAD_ROWS = 10;

// The face is not the whole head box — see the file header on why a full
// skin block with a hair cap on top read as a flat rectangle with nothing in
// it. `paintHead` still fills the *entire* HEAD_LEFT..HEAD_RIGHT box with
// skin (so every hairstyle in `paintHair` has skin underneath wherever it
// doesn't paint over), but the face — the columns eyes are placed in, and the
// columns `paintHair` leaves alone by convention — is inset FACE_INSET
// columns from each edge. HAIR_CAP_ROWS is the deepest any style's cap is
// allowed to reach: it is what guarantees EYE_ROW below always has a clear
// skin row above it (row `HEAD_TOP + HAIR_CAP_ROWS`, never touched by a cap)
// no matter which of the six styles is drawn.
const FACE_INSET = 2;
const HAIR_CAP_ROWS = 6;
const EYE_ROW_OFFSET = HAIR_CAP_ROWS + 1; // one clear skin row below the deepest cap

const TORSO_TOP = 14;
const TORSO_ROWS = 6;
const LEGS_TOP = 20;
const LEFT_LEG: readonly [number, number] = [5, 7];
const RIGHT_LEG: readonly [number, number] = [8, 10];

// Leg lengths for `walk`. FORWARD only ever pairs with `bodyBob === 0` — see
// `poseFor`'s walk case, where the frames that put a leg forward are exactly
// the frames the whole body is level — so `LEGS_TOP + FORWARD_LEG_LEN - 1`
// landing precisely on the sprite's bottom row (23) is not a coincidence to
// re-derive if either constant ever changes: it is the reason FORWARD_LEG_LEN
// is 4 and not some other number that would clip a planted foot off the grid.
// The whole leg zone is now only 4 rows (20-23, the reference's bottom ~17%)
// — short legs under a big head is the other half of the chibi proportion,
// not a separate decision from the head's.
const NEUTRAL_LEG_LEN = 3;
const FORWARD_LEG_LEN = 4; // reaches the sprite's bottom row: this leg is planted
const BACK_LEG_LEN = 2; // lifted clear of the floor: this leg is mid-stride

const DEFAULT_TORSO_SPAN: readonly [number, number] = [5, 10];
/** Left/right columns (inclusive) of the torso, indexed by `AgentAppearance.body`. */
const TORSO_SPANS: readonly (readonly [number, number])[] = [
  [6, 9], // slim
  [5, 10], // regular
  [4, 11], // broad — 8px, still narrower than the 10px head at HEAD_LEFT/RIGHT
];

// -- the seated pose ----------------------------------------------------
//
// Sitting is an axis of its own (`SpriteKey.seated`), not three more
// animations — see the doc comment on that field in `spriteContract.ts` for
// why. What it changes here is deliberately blunt: no legs at all (the
// renderer draws a chair prop behind a seated character and a desk in front
// of it, so the lower body has nothing to usefully be visible against
// anyway), and the torso drops and shortens as if settled onto a seat rather
// than standing at full height. Presence-vs-absence of an entire body part,
// rather than a subtler shift, is what guarantees the seated and standing
// grids can never coincide for any animation or facing — exactly the
// property `sprites.test.ts`'s seated-axis check asserts.
const SEAT_DROP = 2;
const SEAT_TORSO_ROWS = 5;

interface HandPositions {
  /** Column offset from the torso's left edge, row offset from the shoulder. */
  left?: { dx: number; dy: number };
  /** Column offset from the torso's right edge, row offset from the shoulder. */
  right?: { dx: number; dy: number };
}

interface Pose {
  /**
   * Vertical shift applied to the whole body — head, torso and legs move
   * together. Keeping the shift uniform (rather than bobbing the torso while
   * the legs stay put) is what keeps a constant gap between them at every
   * bob value, so a large slump can never push the torso down far enough to
   * paint straight over the legs.
   */
  bodyBob: number;
  legLeftLen: number;
  legRightLen: number;
  hands: HandPositions;
  hideEyes: boolean;
}

/**
 * The pose for one animation frame. Each animation is built from a different
 * *structural* feature (hands present or not, where they sit, whether the legs
 * are level) rather than a shared pose nudged by a parameter, precisely so that
 * `idle` / `idle_relaxed` / `idle_slumped` / `walk` / `type` / `read` cannot
 * converge on the same pixels for some unlucky combination of frame and body
 * variant.
 */
function poseFor(animation: SpriteAnimation, frameIn: number): Pose {
  const frame = wrap(frameIn, FRAMES_PER_ANIMATION);

  switch (animation) {
    case 'idle':
      // `pending` / `skipped` / `blocked`: near-stillness. A one-pixel bob and
      // a blink (eyes skipped) on the third frame is deliberately the only tell.
      return {
        bodyBob: frame === 2 ? -1 : 0,
        legLeftLen: NEUTRAL_LEG_LEN,
        legRightLen: NEUTRAL_LEG_LEN,
        hands: {},
        hideEyes: frame === 2,
      };

    case 'idle_relaxed':
      // `done`: a permanently looser stance — hands on hips, standing a
      // pixel taller — rather than a frame-to-frame difference, so it reads
      // as relaxed at every point in the loop, not just intermittently. `dx`
      // of ±2, not ±1, leaves one transparent column between hand and
      // sleeve: `outlineSilhouette` only borders a silhouette-to-background
      // edge, not a boundary between two differently-coloured filled cells,
      // so a hand painted flush against the torso got no dividing line at
      // all and read as lost in the shading at 1x. The gap is what gives the
      // hand its own outline.
      return {
        bodyBob: -1,
        legLeftLen: NEUTRAL_LEG_LEN,
        legRightLen: NEUTRAL_LEG_LEN,
        hands: { left: { dx: -2, dy: 2 }, right: { dx: 2, dy: 2 } },
        hideEyes: false,
      };

    case 'idle_slumped':
      // `failed`: the torso sinks, the legs shorten to match (bent, not
      // planted), and the hands hang below the torso instead of at its
      // sides. Every one of those is a structural difference from every
      // other animation, not a shade of the same pose. The bob stays small
      // (1/2, not the larger values a taller box could tempt) specifically
      // so `LEGS_TOP + bodyBob + (NEUTRAL_LEG_LEN - 1) - 1` never exceeds the
      // sprite's bottom row across either frame. The hand `dy` of 6 is
      // exactly one row past `TORSO_ROWS`'s last index (5), which is what
      // makes the hands read as hanging below the torso rather than resting
      // at its hem.
      return {
        bodyBob: frame % 2 === 0 ? 1 : 2,
        legLeftLen: NEUTRAL_LEG_LEN - 1,
        legRightLen: NEUTRAL_LEG_LEN - 1,
        hands: { left: { dx: -2, dy: 6 }, right: { dx: 2, dy: 6 } },
        hideEyes: false,
      };

    case 'walk': {
      // `briefing` / `reporting`: legs alternate which one is planted. The
      // body bob per frame is [0,-1,0,1] — asymmetric on purpose, so all four
      // frames stay pairwise distinct instead of the two "neutral" frames
      // collapsing onto each other.
      const leftForward = frame === 0;
      const rightForward = frame === 2;
      const bobByFrame: readonly number[] = [0, -1, 0, 1];
      // Frames 1 and 3 (neither leg forward, both legs NEUTRAL_LEG_LEN) are
      // where this animation gets closest to `idle_relaxed`'s pose — frame 1
      // even shares its bodyBob of -1 — so their hand dy (1) is chosen to be
      // distinct from `idle_relaxed`'s constant dy of 2 rather than reusing
      // the swing frames' dy of 2, which is what the shorter TORSO_ROWS this
      // phase re-tuned to made an actual collision out of.
      const neutralDy = 1;
      return {
        bodyBob: bobByFrame[frame] ?? 0,
        legLeftLen: leftForward ? FORWARD_LEG_LEN : rightForward ? BACK_LEG_LEN : NEUTRAL_LEG_LEN,
        legRightLen: rightForward ? FORWARD_LEG_LEN : leftForward ? BACK_LEG_LEN : NEUTRAL_LEG_LEN,
        hands: {
          // dx ±2, not ±1 — see idle_relaxed's comment on why the hands need
          // a transparent column between them and the torso to pick up their
          // own outline instead of blending into the sleeve.
          left: { dx: -2, dy: rightForward ? 2 : leftForward ? 1 : neutralDy },
          right: { dx: 2, dy: leftForward ? 2 : rightForward ? 1 : neutralDy },
        },
        hideEyes: false,
      };
    }

    case 'type': {
      // `working`: hands sit in front of the torso — crossed inward, unlike
      // every other animation's hands which sit at or outside its edges —
      // and hop between two rows as if typing. That crossed-inward position
      // is the tell, not the hop.
      const up = frame % 2 === 0;
      return {
        bodyBob: 0,
        legLeftLen: NEUTRAL_LEG_LEN,
        legRightLen: NEUTRAL_LEG_LEN,
        hands: {
          left: { dx: 1, dy: up ? 1 : 3 },
          right: { dx: -1, dy: up ? 3 : 1 },
        },
        hideEyes: false,
      };
    }

    case 'read': {
      // `working` refined by a reading tool (FR-S11). Both hands sit at
      // `dx: 0` — exactly on the torso's own edge columns, neither splayed
      // outward (`idle_relaxed`/`idle_slumped`, dx ±1 past the edge) nor
      // crossed inward (`type`, dx ±1 into the torso) — as if holding a page
      // up between them. That offset-of-zero is the structural tell, and it
      // is unique: no other pose leaves both hands sitting exactly on the
      // boundary.
      //
      // The motion is a slow scan rather than a hop: the hands drop on the
      // second half of the loop and the eyes close on the last frame, which
      // reads as looking down a page. Deliberately calmer than `type` — an
      // agent reading should look less busy than one writing, since that
      // difference is the information this animation exists to carry.
      const lowered = frame >= 2;
      return {
        bodyBob: 0,
        legLeftLen: NEUTRAL_LEG_LEN,
        legRightLen: NEUTRAL_LEG_LEN,
        hands: {
          left: { dx: 0, dy: lowered ? 3 : 1 },
          right: { dx: 0, dy: lowered ? 3 : 1 },
        },
        hideEyes: frame === 3,
      };
    }
  }
}

function paintLegs(
  grid: MutableGrid,
  appearance: AgentAppearance,
  bodyBob: number,
  leftLen: number,
  rightLen: number,
): void {
  // Legs move with the same `bodyBob` as the head and torso — not fixed in
  // place while the rest of the body bobs above them — so the gap between
  // torso and legs stays constant instead of closing up (and the torso
  // painting over the legs entirely) whenever a pose leans on a large bob,
  // as `idle_slumped` does.
  const top = LEGS_TOP + bodyBob;
  if (leftLen > 0) {
    fillShadedRect(grid, LEFT_LEG[0], top, LEFT_LEG[1] - LEFT_LEG[0] + 1, leftLen, appearance.trousers);
    // Shoe sole: fixed colour, not palette-driven — see the file header.
    fillRect(grid, LEFT_LEG[0], top + leftLen - 1, LEFT_LEG[1] - LEFT_LEG[0] + 1, 1, OUTLINE);
  }
  if (rightLen > 0) {
    fillShadedRect(grid, RIGHT_LEG[0], top, RIGHT_LEG[1] - RIGHT_LEG[0] + 1, rightLen, appearance.trousers);
    fillRect(grid, RIGHT_LEG[0], top + rightLen - 1, RIGHT_LEG[1] - RIGHT_LEG[0] + 1, 1, OUTLINE);
  }
}

function paintTorsoAndArms(
  grid: MutableGrid,
  appearance: AgentAppearance,
  torsoLeft: number,
  torsoRight: number,
  bodyBob: number,
  hands: HandPositions,
  seated: boolean,
): void {
  // Seated drops and shortens the torso rather than reusing the standing
  // rows verbatim — see the seated-pose comment by SEAT_DROP for why the
  // shortening matters as much as the drop.
  const top = TORSO_TOP + (seated ? SEAT_DROP : 0) + bodyBob;
  const rows = seated ? SEAT_TORSO_ROWS : TORSO_ROWS;
  fillShadedRect(grid, torsoLeft, top, torsoRight - torsoLeft + 1, rows, appearance.shirt);

  const shoulderRow = top + 1;
  if (hands.left) paintHand(grid, torsoLeft + hands.left.dx, shoulderRow + hands.left.dy, appearance.skin);
  if (hands.right) paintHand(grid, torsoRight + hands.right.dx, shoulderRow + hands.right.dy, appearance.skin);
}

/**
 * One eye: a 2×2 light sclera (`EYE_WHITE`) with a single dark pupil
 * (`OUTLINE`) punched into its inner column — the column nearer the other
 * eye, so a pair drawn with `innerColumn` 1 then 0 converges slightly toward
 * the centre of the face rather than staring straight out. This, not the
 * bigger head or the reframed hair, is the single highest-value change this
 * pass makes: see the file header for why two flat `OUTLINE` dots read as a
 * smudge where this reads as a face.
 */
function paintEye(grid: MutableGrid, x: number, y: number, innerColumn: 0 | 1): void {
  fillRect(grid, x, y, 2, 2, EYE_WHITE);
  setPixel(grid, x + innerColumn, y, OUTLINE);
}

function paintHead(
  grid: MutableGrid,
  appearance: AgentAppearance,
  view: 'front' | 'back' | 'side',
  bodyBob: number,
  hideEyes: boolean,
  seated: boolean,
): void {
  const top = HEAD_TOP + (seated ? SEAT_DROP : 0) + bodyBob;
  const width = HEAD_RIGHT - HEAD_LEFT + 1;
  // The whole box, not just the face — `paintHair` (which runs next) paints
  // over most of this with the cap and the side columns, leaving only the
  // inset face window exposed. Filling the full box here rather than just
  // the face window is what keeps every hairstyle safe regardless of how
  // little of the head it actually covers: a short-crop style exposes more
  // skin than a bob does, and that skin already exists underneath either way
  // rather than needing to be painted per-style.
  fillShadedRect(grid, HEAD_LEFT, top, width, HEAD_ROWS, appearance.skin);

  if (view === 'back' || hideEyes) return; // the back of a head has no face to draw

  // The face window: inset FACE_INSET columns from each edge, starting
  // EYE_ROW_OFFSET rows below the head's top — see the comment on those
  // constants for why that offset is always clear of every style's cap.
  const faceLeft = HEAD_LEFT + FACE_INSET;
  const faceWidth = width - FACE_INSET * 2;
  const eyeRow = top + EYE_ROW_OFFSET;
  if (view === 'side') {
    // Three-quarter turn: only the leading eye is visible. Facing 'left' is
    // this exact pose mirrored, not a separately authored one — see `frame`.
    paintEye(grid, faceLeft + faceWidth - 2, eyeRow, 0);
  } else {
    paintEye(grid, faceLeft, eyeRow, 1);
    paintEye(grid, faceLeft + faceWidth - 2, eyeRow, 0);
  }
}

/**
 * The shared shape every hairstyle below is built from: a full-width cap over
 * the top `capRows` of the head, and two darker side columns running down
 * `sideRows` of it. This is the fix for the defect a rendered sheet exposed
 * in the first version of this file — a full skin block with a thin hair cap
 * on top read as a flat tan rectangle sitting on a shirt, because nothing
 * about it *framed* a face. The reference art's actual construction is the
 * opposite emphasis: hair is the big mass, spanning the full head width and
 * running down both sides, and the face is the *inset* area peeking out from
 * inside it — narrower than the head (by `FACE_INSET` columns each side) and
 * sitting in the head's lower portion, below the cap.
 *
 * `paintHead` already painted skin across the *entire* head box before this
 * runs, so painting less cap or fewer side rows than the maximum never
 * leaves a transparent gap — it just exposes more of the skin already
 * underneath, which is exactly how a shorter haircut should read (more
 * forehead and temple visible, not a hole in the silhouette).
 *
 * The two-tone split is not a one-pixel accent this time but the shape's
 * whole logic: the cap's own top row is lightened (the crown catching light)
 * and the side columns are darkened for their entire run (hair falling away
 * from the light in shadow at the temples) — `shade()`'s two derived tones
 * doing the actual work of making the mass read as volume instead of a flat
 * silhouette.
 */
function paintHairFrame(grid: MutableGrid, hair: string, top: number, capRows: number, sideRows: number): void {
  const width = HEAD_RIGHT - HEAD_LEFT + 1;
  fillRect(grid, HEAD_LEFT, top, width, capRows, hair);
  fillRect(grid, HEAD_LEFT + FACE_INSET, top, width - FACE_INSET * 2, 1, shade(hair, LIGHT_AMOUNT));
  fillRect(grid, HEAD_LEFT, top, FACE_INSET, sideRows, shade(hair, -DARK_AMOUNT));
  fillRect(grid, HEAD_RIGHT - FACE_INSET + 1, top, FACE_INSET, sideRows, shade(hair, -DARK_AMOUNT));
}

/**
 * Six genuinely different hair silhouettes, all built from `paintHairFrame`
 * above so every one of them frames the face the same way, differing in how
 * much of the head that frame covers (`capRows`/`sideRows`, both capped at
 * `HAIR_CAP_ROWS`/`HEAD_ROWS` so no style's frame can ever reach `EYE_ROW`)
 * and in a per-style texture drawn *above* `top` for extra silhouette: a
 * side-parted fringe (a shallow frame with a one-pixel part), a tall wavy
 * crown (a full frame plus a jagged skyline above it — the tallest style), a
 * round afro (a full frame with the longest side coverage plus a 1px
 * overhang past the head's own edges), a bob (the shallowest cap but the
 * *longest* sides, running the full head height), a spiky crop (the
 * shortest frame plus 2px-wide tufts above it, separated by gaps of bare
 * scalp), and a short crop (the shallowest frame of all, no extra texture —
 * the closest-cropped style in the set). `HAIR_STYLES` is `model.ts`'s
 * constant, not this file's, and `wrap()` below is what lets it be raised
 * again later without this `switch` needing a bounds check of its own: every
 * index in range gets an explicit case, and `default` (reached today only by
 * index 5) still hands back a real shape rather than nothing.
 *
 * Per-style texture above `top` follows the same rule the first version of
 * this function learned the hard way: it stays anchored to a full-width or
 * near-full-width row rather than floating as single-pixel points, which is
 * what stops a jagged crown or a set of tufts reading as a row of separated
 * teeth instead of hair.
 */
function paintHair(
  grid: MutableGrid,
  appearance: AgentAppearance,
  view: 'front' | 'back' | 'side',
  bodyBob: number,
  seated: boolean,
): void {
  const style = wrap(appearance.hairStyle, HAIR_STYLES);
  const hair = appearance.hair;
  const top = HEAD_TOP + (seated ? SEAT_DROP : 0) + bodyBob;

  switch (style) {
    case 0: {
      // Side-parted fringe: a shallow frame (most of HAIR_CAP_ROWS, short
      // sides) with a one-pixel part near the crown.
      paintHairFrame(grid, hair, top, HAIR_CAP_ROWS - 1, 4);
      clearPixel(grid, HEAD_LEFT + 4, top); // the part
      break;
    }
    case 1: {
      // Tall wavy: the full frame, plus a jagged crown rising above `top` by
      // a different amount per column — deliberately the tallest silhouette
      // of the six.
      paintHairFrame(grid, hair, top, HAIR_CAP_ROWS, HAIR_CAP_ROWS);
      const waveOffsets: readonly number[] = [0, 1, 2, 1, 0, 0, 1, 2, 1, 0];
      for (let i = 0; i < waveOffsets.length; i += 1) {
        const x = HEAD_LEFT + i;
        const extra = waveOffsets[i] ?? 0;
        for (let y = top - extra; y < top; y += 1) setPixel(grid, x, y, hair);
      }
      setPixel(grid, HEAD_LEFT + 2, top - 2, shade(hair, LIGHT_AMOUNT)); // crest of a tall wave
      setPixel(grid, HEAD_RIGHT - 2, top - 2, shade(hair, -DARK_AMOUNT)); // crest of another, in shadow
      break;
    }
    case 2: {
      // Round afro: the full frame with the deepest side coverage, plus a
      // 1px overhang past the head's own left/right edges — wider than any
      // other style, on purpose.
      paintHairFrame(grid, hair, top, HAIR_CAP_ROWS, HEAD_ROWS - 2);
      fillRect(grid, HEAD_LEFT - 1, top, 1, HAIR_CAP_ROWS, shade(hair, -DARK_AMOUNT));
      fillRect(grid, HEAD_RIGHT + 1, top, 1, HAIR_CAP_ROWS, shade(hair, -DARK_AMOUNT));
      setPixel(grid, HEAD_LEFT + 2, top - 1, hair); // crown bump
      setPixel(grid, HEAD_RIGHT - 2, top - 1, hair);
      break;
    }
    case 3: {
      // Bob: the shallowest cap in the set but the sides run the full head
      // height — the longest sides, not the tallest crown, are this style's
      // tell.
      paintHairFrame(grid, hair, top, HAIR_CAP_ROWS - 2, HEAD_ROWS);
      break;
    }
    case 4: {
      // Spiky: the shortest frame, plus 2px-wide tufts rising above `top` at
      // varying heights, separated by 1px gaps of bare scalp. Widening each
      // tuft to two columns (rather than one) and anchoring all of them to
      // the frame's own cap is what stops this reading as a row of
      // separated teeth — the defect a rendered sheet caught in the first
      // version of this style, worst on the palette's lightest hair colour.
      paintHairFrame(grid, hair, top, 3, 3);
      const tufts: readonly (readonly [number, number])[] = [
        [HEAD_LEFT, 1],
        [HEAD_LEFT + 3, 2],
        [HEAD_LEFT + 6, 1],
        [HEAD_LEFT + 8, 2],
      ];
      for (const [x, height] of tufts) {
        for (let y = top - height; y < top; y += 1) {
          setPixel(grid, x, y, hair);
          setPixel(grid, x + 1, y, hair);
        }
      }
      setPixel(grid, HEAD_LEFT + 3, top - 2, shade(hair, LIGHT_AMOUNT));
      setPixel(grid, HEAD_LEFT + 8, top - 2, shade(hair, -DARK_AMOUNT));
      break;
    }
    default: {
      // Short crop: the shallowest frame of all — the closest-cropped style
      // in the set, with no extra texture, so it reads as unmistakably
      // shorter than every other style rather than a smaller version of one.
      paintHairFrame(grid, hair, top, 2, 2);
      break;
    }
  }

  if (view === 'back') {
    // From behind there is no face to distinguish any style from a bald
    // patch, so the crown always reads as fully covered back here — the
    // whole head box, the same footprint `paintHead`'s skin fill uses —
    // regardless of which style's (possibly much shallower) frame the front
    // view drew.
    fillRect(grid, HEAD_LEFT, top, HEAD_RIGHT - HEAD_LEFT + 1, HEAD_ROWS, hair);
  }
}

function paintCharacter(
  grid: MutableGrid,
  appearance: AgentAppearance,
  animation: SpriteAnimation,
  frame: number,
  view: 'front' | 'back' | 'side',
  seated: boolean,
): void {
  const [torsoLeft, torsoRight] = TORSO_SPANS[wrap(appearance.body, BODY_VARIANTS)] ?? DEFAULT_TORSO_SPAN;
  const pose = poseFor(animation, frame);

  // Back-to-front, so nearer parts overwrite anything a shifted pose pushed
  // behind them (a slumped head dipping into the torso's top row, etc). Legs
  // are skipped outright when seated — see the seated-pose comment above
  // SEAT_DROP — rather than drawn shorter, which is what makes seated
  // unmistakable from standing at every frame rather than merely different.
  if (!seated) {
    paintLegs(grid, appearance, pose.bodyBob, pose.legLeftLen, pose.legRightLen);
  }
  paintTorsoAndArms(grid, appearance, torsoLeft, torsoRight, pose.bodyBob, pose.hands, seated);
  paintHead(grid, appearance, view, pose.bodyBob, pose.hideEyes, seated);
  paintHair(grid, appearance, view, pose.bodyBob, seated);
  // Last, once every part has committed its pixels, so the border traces the
  // pose's actual silhouette rather than some part's alone.
  outlineSilhouette(grid);
}

function renderFrame(key: SpriteKey): MutableGrid {
  const grid = createCharacterGrid();
  const frame = wrap(key.frame, FRAMES_PER_ANIMATION);
  const seated = key.seated === true;

  if (key.facing === 'up') {
    paintCharacter(grid, key.appearance, key.animation, frame, 'back', seated);
    return grid;
  }
  if (key.facing === 'down') {
    paintCharacter(grid, key.appearance, key.animation, frame, 'front', seated);
    return grid;
  }
  // 'left' and 'right' are the same asymmetric 'side' pose, one of them
  // mirrored — never two independently authored poses that could drift out
  // of sync with each other.
  paintCharacter(grid, key.appearance, key.animation, frame, 'side', seated);
  return key.facing === 'left' ? mirrorGrid(grid) : grid;
}

/**
 * Memoisation, bounded by a hard cap rather than an eviction policy.
 *
 * The renderer calls `frame()` per character per tick, and generation is pure
 * arithmetic over a handful of fields, so a cheap string key is enough to
 * avoid repainting a grid whose inputs have not changed. A realistic office —
 * a few dozen agents × 6 animations × FRAMES_PER_ANIMATION × 4 facings × 2
 * seated states — is a few thousand entries at most, comfortably under the cap
 * below. If it is somehow exceeded (e.g. a long-lived session that has
 * rendered a great many distinct agent names), the whole cache is dropped and
 * rebuilt rather than evicting piecemeal: correctness never depends on what
 * happens to be cached, so a full clear is one size check instead of an LRU
 * structure to maintain.
 */
const MAX_CACHE_ENTRIES = 4000;
const frameCache = new Map<string, PixelGrid>();

function cacheKey(key: SpriteKey): string {
  const a = key.appearance;
  // `seated` is part of the key, not an afterthought: two calls differing only
  // in it draw genuinely different pixels, so omitting it would serve a
  // standing sprite to a seated character for as long as the entry lived.
  const seated = key.seated === true ? 'sit' : 'stand';
  return `${String(a.body)}|${String(a.hairStyle)}|${a.skin}|${a.hair}|${a.shirt}|${a.trousers}|${key.animation}|${String(key.frame)}|${key.facing}|${seated}`;
}

const frame: FrameGenerator = (key) => {
  const existing = frameCache.get(cacheKey(key));
  if (existing !== undefined) return existing;

  if (frameCache.size >= MAX_CACHE_ENTRIES) frameCache.clear();

  const grid = renderFrame(key);
  frameCache.set(cacheKey(key), grid);
  return grid;
};

/**
 * The procedural sprite pack. Swapping in a real art pack later (FR-S9) means
 * implementing {@link SpriteManifest} and nothing else — this object is the
 * whole of that seam.
 */
export const SPRITE_MANIFEST: SpriteManifest = {
  // Bumped with the Phase 10 repaint. The id is the manifest's identity, and a
  // 16×24 character pack that still called itself `procedural-v1` would make
  // any future cache or snapshot keyed on it silently wrong.
  id: 'procedural-v2',
  spriteWidth: SPRITE_WIDTH,
  spriteHeight: SPRITE_HEIGHT,
  framesPerAnimation: FRAMES_PER_ANIMATION,
  frame,
  prop,
};

export type { Facing, PixelGrid, PropName, SpriteAnimation, SpriteKey };
