import { BODY_VARIANTS, HAIR_STYLES, type AgentAppearance } from './model.js';
import { OFFICE, THEMES } from '../theme/tokens.js';
import {
  FRAMES_PER_ANIMATION,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
  type Facing,
  type FrameGenerator,
  type PixelGrid,
  type PropGenerator,
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
 * FR-S3 (status drives behaviour, not the other way round) is why the five
 * animations below are drawn to be tell-apart-able at a glance rather than
 * merely different in code: `idle_relaxed` (a `done` agent) and `idle_slumped`
 * (a `failed` one) exist so a user can read run health off the office without
 * opening a single assignment. Colour comes entirely from `AgentAppearance` —
 * skin, hair, shirt and trousers are never hardcoded here. `OUTLINE` below is
 * the one fixed colour in a character: eyes and shoe soles are a structural
 * detail of "this is a person", not part of any agent's identity, so they stay
 * constant while everything else is palette-driven.
 */

// A mutable working copy of PixelGrid. The contract's readonly arrays are a
// view for consumers; generation is far simpler as plain arrays, and a
// `(string | null)[][]` is assignable to `PixelGrid` without a cast because
// readonly-ness only restricts the type, not the underlying value.
type MutableGrid = (string | null)[][];

function createGrid(): MutableGrid {
  return Array.from({ length: SPRITE_HEIGHT }, () => new Array<string | null>(SPRITE_WIDTH).fill(null));
}

/**
 * Bounds-checked writes are what make every drawing routine below total: a
 * pose that pushes a pixel one row past the sprite (a slumped head, an
 * extended stride) is silently clipped instead of throwing or resizing a row,
 * which is also what keeps every returned grid exactly SPRITE_HEIGHT ×
 * SPRITE_WIDTH regardless of which animation or facing produced it.
 */
function setPixel(grid: MutableGrid, x: number, y: number, colour: string): void {
  if (x < 0 || x >= SPRITE_WIDTH || y < 0 || y >= SPRITE_HEIGHT) return;
  const row = grid[y];
  if (row === undefined) return;
  row[x] = colour;
}

function clearPixel(grid: MutableGrid, x: number, y: number): void {
  if (x < 0 || x >= SPRITE_WIDTH || y < 0 || y >= SPRITE_HEIGHT) return;
  const row = grid[y];
  if (row === undefined) return;
  row[x] = null;
}

function fillRect(grid: MutableGrid, x0: number, y0: number, w: number, h: number, colour: string): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      setPixel(grid, x, y, colour);
    }
  }
}

/**
 * Wraps into `[0, size)`, including for negative and non-finite input. This is
 * the totality guarantee the contract asks for on `frame`: a renderer running
 * a loop that overshoots (or a replay seeking to a frame before an animation
 * existed) gets a valid still frame instead of an exception.
 */
function wrap(n: number, size: number): number {
  if (!Number.isFinite(n)) return 0;
  const m = Math.floor(n) % size;
  return m < 0 ? m + size : m;
}

// Eyes and shoe soles: a structural detail of "this is a person", not part of
// any agent's identity, so it stays constant while skin/hair/shirt/trousers
// are palette-driven (see the file header). It still has to come from tokens
// (FR-U2 — no second colour source in this directory). It has its own token
// rather than borrowing the backdrop's: an outline that tracked
// `OFFICE.background` would silently disappear the day the floor is retuned
// darker, and "the characters lost their eyes" is not a bug anyone would
// trace back to a background tweak.
const OUTLINE = OFFICE.outline;

// Layout constants below assume the contract's current 12×16 box. They are
// not derived from SPRITE_WIDTH/SPRITE_HEIGHT arithmetically — a 12×16 pixel
// character does not scale by simple ratio to, say, 24×32 — but every draw
// call is bounds-checked regardless, so a future contract change would clip
// rather than crash even though the proportions would need re-tuning by hand.
const HEAD_LEFT = 4;
const HEAD_RIGHT = 7;
const HEAD_TOP = 1;
const HEAD_ROWS = 4;
const TORSO_TOP = 5;
const TORSO_ROWS = 5;
const LEGS_TOP = 10;
const LEFT_LEG: readonly [number, number] = [4, 5];
const RIGHT_LEG: readonly [number, number] = [6, 7];

const NEUTRAL_LEG_LEN = 5;
const FORWARD_LEG_LEN = 6; // reaches the sprite's bottom row: this leg is planted
const BACK_LEG_LEN = 4; // lifted clear of the floor: this leg is mid-stride

const DEFAULT_TORSO_SPAN: readonly [number, number] = [4, 7];
/** Left/right columns (inclusive) of the torso, indexed by `AgentAppearance.body`. */
const TORSO_SPANS: readonly (readonly [number, number])[] = [
  [4, 7], // slim
  [3, 8], // regular
  [2, 9], // broad
];

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
 * `idle` / `idle_relaxed` / `idle_slumped` / `walk` / `type` cannot converge on
 * the same pixels for some unlucky combination of frame and body variant.
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
      // as relaxed at every point in the loop, not just intermittently. The
      // bob stays a constant -1 (rather than varying further) so the hair
      // layer, which for some styles is only a pixel or two wide, never gets
      // pushed off the top edge of the sprite and clipped away entirely.
      return {
        bodyBob: -1,
        legLeftLen: NEUTRAL_LEG_LEN,
        legRightLen: NEUTRAL_LEG_LEN,
        hands: { left: { dx: -1, dy: 2 }, right: { dx: 1, dy: 2 } },
        hideEyes: false,
      };

    case 'idle_slumped':
      // `failed`: the torso sinks, the legs shorten to match (bent, not
      // planted), and the hands hang below the torso instead of at its
      // sides. Every one of those is a structural difference from every
      // other animation, not a shade of the same pose.
      return {
        bodyBob: frame % 2 === 0 ? 2 : 3,
        legLeftLen: NEUTRAL_LEG_LEN - 1,
        legRightLen: NEUTRAL_LEG_LEN - 1,
        hands: { left: { dx: -1, dy: 4 }, right: { dx: 1, dy: 4 } },
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
      return {
        bodyBob: bobByFrame[frame] ?? 0,
        legLeftLen: leftForward ? FORWARD_LEG_LEN : rightForward ? BACK_LEG_LEN : NEUTRAL_LEG_LEN,
        legRightLen: rightForward ? FORWARD_LEG_LEN : leftForward ? BACK_LEG_LEN : NEUTRAL_LEG_LEN,
        hands: {
          left: { dx: -1, dy: rightForward ? 0 : 1 },
          right: { dx: 1, dy: leftForward ? 0 : 1 },
        },
        hideEyes: false,
      };
    }

    case 'type': {
      // `working`: hands sit in front of the torso — not at its sides, unlike
      // every other animation — and hop between two rows as if typing. That
      // front-and-centre position is the tell, not the hop.
      const up = frame % 2 === 0;
      return {
        bodyBob: 0,
        legLeftLen: NEUTRAL_LEG_LEN,
        legRightLen: NEUTRAL_LEG_LEN,
        hands: {
          left: { dx: 1, dy: up ? 1 : 2 },
          right: { dx: -1, dy: up ? 2 : 1 },
        },
        hideEyes: false,
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
    fillRect(grid, LEFT_LEG[0], top, LEFT_LEG[1] - LEFT_LEG[0] + 1, leftLen, appearance.trousers);
    // Shoe sole: fixed colour, not palette-driven — see the file header.
    fillRect(grid, LEFT_LEG[0], top + leftLen - 1, LEFT_LEG[1] - LEFT_LEG[0] + 1, 1, OUTLINE);
  }
  if (rightLen > 0) {
    fillRect(grid, RIGHT_LEG[0], top, RIGHT_LEG[1] - RIGHT_LEG[0] + 1, rightLen, appearance.trousers);
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
): void {
  fillRect(grid, torsoLeft, TORSO_TOP + bodyBob, torsoRight - torsoLeft + 1, TORSO_ROWS, appearance.shirt);

  const shoulderRow = TORSO_TOP + bodyBob + 1;
  if (hands.left) setPixel(grid, torsoLeft + hands.left.dx, shoulderRow + hands.left.dy, appearance.skin);
  if (hands.right) setPixel(grid, torsoRight + hands.right.dx, shoulderRow + hands.right.dy, appearance.skin);
}

function paintHead(
  grid: MutableGrid,
  appearance: AgentAppearance,
  view: 'front' | 'back' | 'side',
  bodyBob: number,
  hideEyes: boolean,
): void {
  const top = HEAD_TOP + bodyBob;
  fillRect(grid, HEAD_LEFT, top, HEAD_RIGHT - HEAD_LEFT + 1, HEAD_ROWS, appearance.skin);

  if (view === 'back' || hideEyes) return; // the back of a head has no face to draw

  const eyeRow = top + 1;
  if (view === 'side') {
    // Three-quarter turn: only the leading eye is visible. Facing 'left' is
    // this exact pose mirrored, not a separately authored one — see `frame`.
    setPixel(grid, HEAD_RIGHT, eyeRow, OUTLINE);
  } else {
    setPixel(grid, HEAD_LEFT + 1, eyeRow, OUTLINE);
    setPixel(grid, HEAD_RIGHT - 1, eyeRow, OUTLINE);
  }
}

function paintHair(
  grid: MutableGrid,
  appearance: AgentAppearance,
  view: 'front' | 'back' | 'side',
  bodyBob: number,
): void {
  const style = wrap(appearance.hairStyle, HAIR_STYLES);
  const hair = appearance.hair;
  const top = HEAD_TOP - 1 + bodyBob;

  switch (style) {
    case 0: // short crop
      fillRect(grid, HEAD_LEFT, top, HEAD_RIGHT - HEAD_LEFT + 1, 1, hair);
      setPixel(grid, HEAD_LEFT, top + 1, hair);
      setPixel(grid, HEAD_RIGHT, top + 1, hair);
      break;
    case 1: // bushy: a cap that overflows past the head box on both sides
      fillRect(grid, HEAD_LEFT - 1, top, HEAD_RIGHT - HEAD_LEFT + 3, 1, hair);
      setPixel(grid, HEAD_LEFT - 1, top + 1, hair);
      setPixel(grid, HEAD_RIGHT + 1, top + 1, hair);
      break;
    case 2: // long: cap plus strands running past the shoulders on both sides
      fillRect(grid, HEAD_LEFT, top, HEAD_RIGHT - HEAD_LEFT + 1, 1, hair);
      for (let y = top + 1; y <= top + 5; y += 1) {
        setPixel(grid, HEAD_LEFT - 1, y, hair);
        setPixel(grid, HEAD_RIGHT + 1, y, hair);
      }
      break;
    default: // buzzed: a thin centre strip only — the sides read as bald
      setPixel(grid, HEAD_LEFT + 1, top, hair);
      setPixel(grid, HEAD_RIGHT - 1, top, hair);
      break;
  }

  if (view === 'back') {
    // From behind there is no face to distinguish a 'buzzed' agent from a
    // bald patch, so the crown always reads as fully covered back here,
    // regardless of which style the front view drew.
    fillRect(grid, HEAD_LEFT, top + 1, HEAD_RIGHT - HEAD_LEFT + 1, 1, hair);
  }
}

function paintCharacter(
  grid: MutableGrid,
  appearance: AgentAppearance,
  animation: SpriteAnimation,
  frame: number,
  view: 'front' | 'back' | 'side',
): void {
  const [torsoLeft, torsoRight] = TORSO_SPANS[wrap(appearance.body, BODY_VARIANTS)] ?? DEFAULT_TORSO_SPAN;
  const pose = poseFor(animation, frame);

  // Back-to-front, so nearer parts overwrite anything a shifted pose pushed
  // behind them (a slumped head dipping into the torso's top row, etc).
  paintLegs(grid, appearance, pose.bodyBob, pose.legLeftLen, pose.legRightLen);
  paintTorsoAndArms(grid, appearance, torsoLeft, torsoRight, pose.bodyBob, pose.hands);
  paintHead(grid, appearance, view, pose.bodyBob, pose.hideEyes);
  paintHair(grid, appearance, view, pose.bodyBob);
}

function mirrorGrid(grid: MutableGrid): MutableGrid {
  return grid.map((row) => [...row].reverse());
}

function renderFrame(key: SpriteKey): MutableGrid {
  const grid = createGrid();
  const frame = wrap(key.frame, FRAMES_PER_ANIMATION);

  if (key.facing === 'up') {
    paintCharacter(grid, key.appearance, key.animation, frame, 'back');
    return grid;
  }
  if (key.facing === 'down') {
    paintCharacter(grid, key.appearance, key.animation, frame, 'front');
    return grid;
  }
  // 'left' and 'right' are the same asymmetric 'side' pose, one of them
  // mirrored — never two independently authored poses that could drift out
  // of sync with each other.
  paintCharacter(grid, key.appearance, key.animation, frame, 'side');
  return key.facing === 'left' ? mirrorGrid(grid) : grid;
}

/**
 * Memoisation, bounded by a hard cap rather than an eviction policy.
 *
 * The renderer calls `frame()` per character per tick, and generation is pure
 * arithmetic over a handful of fields, so a cheap string key is enough to
 * avoid repainting a grid whose inputs have not changed. A realistic office —
 * a few dozen agents × 5 animations × FRAMES_PER_ANIMATION × 4 facings — is a
 * few thousand entries at most, comfortably under the cap below. If it is
 * somehow exceeded (e.g. a long-lived session that has rendered a great many
 * distinct agent names), the whole cache is dropped and rebuilt rather than
 * evicting piecemeal: correctness never depends on what happens to be cached,
 * so a full clear is one size check instead of an LRU structure to maintain.
 */
const MAX_CACHE_ENTRIES = 4000;
const frameCache = new Map<string, PixelGrid>();

function cacheKey(key: SpriteKey): string {
  const a = key.appearance;
  return `${String(a.body)}|${String(a.hairStyle)}|${a.skin}|${a.hair}|${a.shirt}|${a.trousers}|${key.animation}|${String(key.frame)}|${key.facing}`;
}

const frame: FrameGenerator = (key) => {
  const existing = frameCache.get(cacheKey(key));
  if (existing !== undefined) return existing;

  if (frameCache.size >= MAX_CACHE_ENTRIES) frameCache.clear();

  const grid = renderFrame(key);
  frameCache.set(cacheKey(key), grid);
  return grid;
};

// --- Props -------------------------------------------------------------
//
// Props carry no AgentAppearance, so unlike the character above their
// colours are ordinary constants rather than slices of a per-agent ramp —
// but they are still office colours, so FR-U2 still applies: every one below
// is sourced from `theme/tokens.ts`, not authored here. They are static (no
// inputs at all), so rather than the keyed cache above each is simply built
// once at module load into a fixed six-entry table: the cheapest possible
// memoisation, bounded by construction rather than a check.

// Naturalistic wood browns before this phase; now the office's own dark
// terminal tones, exactly as FR-U3 asks — a palette swap, not a redraw. The
// names on the right read oddly against "wood" only until you remember there
// is no wood on a CRT.
const DESK_WOOD = OFFICE.desk;
const DESK_WOOD_DARK = OFFICE.deskEdge;
// Darker than the desktop, so the furniture reads as solid rather than as a
// floating plank.
const DESK_LEG = OFFICE.deskLeg;
// The one visual cue that this is the Manager's desk and not an agent's.
// `OFFICE.managerDesk` exists precisely for this — a distinct desk colour
// standing in for what used to be a brass trim stripe.
const MANAGER_TRIM = OFFICE.managerDesk;
const PAPER_COLOUR = OFFICE.paper;
// The tick marks drawn on the paper prop — dimmer than the page they sit on,
// so a report reads as written-on rather than as a blank rectangle.
const PAPER_LINE = OFFICE.paperLine;
// The neutral speech bubble and the light mark drawn on the alert/error
// bubbles both want the same thing: the office's lightest, most paper-like
// tone for contrast against a dark or saturated fill. `OFFICE.paper` is that
// tone, so both alias it rather than each inventing its own near-white.
const SPEECH_FILL = OFFICE.paper;
const MARK_LIGHT = OFFICE.paper;
// Alert/error bubbles intentionally track the chrome's own status hues
// (`THEMES.dark`, not `THEMES[mode]` — the office never follows the light
// theme, see `theme/tokens.ts`), so "blocked" and "failed" read as the same
// colour here as they do everywhere else the app shows status.
const ALERT_FILL = THEMES.dark.statusWaiting;
const ERROR_FILL = THEMES.dark.statusBad;

function buildDesk(): PixelGrid {
  const grid = createGrid();
  fillRect(grid, 1, 6, 10, 3, DESK_WOOD);
  fillRect(grid, 1, 9, 10, 1, DESK_WOOD_DARK);
  setPixel(grid, 2, 10, DESK_LEG);
  setPixel(grid, 2, 11, DESK_LEG);
  setPixel(grid, 9, 10, DESK_LEG);
  setPixel(grid, 9, 11, DESK_LEG);
  return grid;
}

function buildManagerDesk(): PixelGrid {
  const grid = createGrid();
  // Wider and a row taller than the ordinary desk — grander by silhouette
  // alone, before the trim is even considered.
  fillRect(grid, 0, 5, 12, 4, DESK_WOOD);
  fillRect(grid, 0, 5, 12, 1, MANAGER_TRIM);
  fillRect(grid, 0, 8, 12, 1, DESK_WOOD_DARK);
  setPixel(grid, 5, 6, MANAGER_TRIM);
  setPixel(grid, 6, 6, MANAGER_TRIM);
  setPixel(grid, 1, 9, DESK_LEG);
  setPixel(grid, 1, 10, DESK_LEG);
  setPixel(grid, 1, 11, DESK_LEG);
  setPixel(grid, 10, 9, DESK_LEG);
  setPixel(grid, 10, 10, DESK_LEG);
  setPixel(grid, 10, 11, DESK_LEG);
  return grid;
}

function buildPaper(): PixelGrid {
  const grid = createGrid();
  fillRect(grid, 4, 5, 5, 6, PAPER_COLOUR);
  setPixel(grid, 5, 7, PAPER_LINE);
  setPixel(grid, 6, 7, PAPER_LINE);
  setPixel(grid, 5, 8, PAPER_LINE);
  setPixel(grid, 6, 8, PAPER_LINE);
  setPixel(grid, 5, 9, PAPER_LINE);
  return grid;
}

const BUBBLE_LEFT = 2;
const BUBBLE_RIGHT = 9;
const BUBBLE_TOP = 0;
const BUBBLE_BOTTOM = 6;

/**
 * The shared bubble shell, bold and simple by construction: a filled
 * rectangle with its four corners knocked out to read as "rounded" and a
 * two-pixel tail, which is as much geometry as a 12×16 box can afford while
 * staying legible. The mark inside is what actually distinguishes the three
 * bubble kinds, so it is drawn in a colour that contrasts with the fill
 * rather than relying on shape alone.
 */
function buildBubble(fill: string, mark: string, kind: 'dots' | 'exclaim' | 'cross'): PixelGrid {
  const grid = createGrid();
  fillRect(grid, BUBBLE_LEFT, BUBBLE_TOP, BUBBLE_RIGHT - BUBBLE_LEFT + 1, BUBBLE_BOTTOM - BUBBLE_TOP + 1, fill);
  clearPixel(grid, BUBBLE_LEFT, BUBBLE_TOP);
  clearPixel(grid, BUBBLE_RIGHT, BUBBLE_TOP);
  clearPixel(grid, BUBBLE_LEFT, BUBBLE_BOTTOM);
  clearPixel(grid, BUBBLE_RIGHT, BUBBLE_BOTTOM);

  setPixel(grid, 5, BUBBLE_BOTTOM + 1, fill);
  setPixel(grid, 5, BUBBLE_BOTTOM + 2, fill);

  switch (kind) {
    case 'dots':
      setPixel(grid, 4, 3, mark);
      setPixel(grid, 6, 3, mark);
      setPixel(grid, 8, 3, mark);
      break;
    case 'exclaim':
      fillRect(grid, 5, 1, 2, 3, mark);
      setPixel(grid, 5, 5, mark);
      setPixel(grid, 6, 5, mark);
      break;
    case 'cross':
      setPixel(grid, 4, 1, mark);
      setPixel(grid, 5, 2, mark);
      setPixel(grid, 6, 3, mark);
      setPixel(grid, 7, 4, mark);
      setPixel(grid, 7, 1, mark);
      setPixel(grid, 6, 2, mark);
      setPixel(grid, 5, 3, mark);
      setPixel(grid, 4, 4, mark);
      break;
  }

  return grid;
}

const PROP_GRIDS: Record<PropName, PixelGrid> = {
  desk: buildDesk(),
  manager_desk: buildManagerDesk(),
  paper: buildPaper(),
  bubble_speech: buildBubble(SPEECH_FILL, OUTLINE, 'dots'),
  bubble_alert: buildBubble(ALERT_FILL, MARK_LIGHT, 'exclaim'),
  bubble_error: buildBubble(ERROR_FILL, MARK_LIGHT, 'cross'),
};

const prop: PropGenerator = (name) => PROP_GRIDS[name];

/**
 * The procedural sprite pack. Swapping in a real art pack later (FR-S9) means
 * implementing {@link SpriteManifest} and nothing else — this object is the
 * whole of that seam.
 */
export const SPRITE_MANIFEST: SpriteManifest = {
  id: 'procedural-v1',
  spriteWidth: SPRITE_WIDTH,
  spriteHeight: SPRITE_HEIGHT,
  framesPerAnimation: FRAMES_PER_ANIMATION,
  frame,
  prop,
};

export type { Facing, PixelGrid, PropName, SpriteAnimation, SpriteKey };
