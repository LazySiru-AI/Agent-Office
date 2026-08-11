import type { AgentAppearance } from './model.js';

/**
 * The seam between sprite *generation* and sprite *rendering* (FR-S2, FR-S9).
 *
 * Sprites are generated procedurally from an {@link AgentAppearance} rather than
 * loaded from an art pack. That is a deliberate departure from PLAN.md §2.3,
 * which assumed a CC0 pack, and the reasoning is recorded in `ASSETS.md`: a
 * generated sprite has no licence to verify, nothing to download, and no risk of
 * an asset landing in the repo whose terms nobody checked. The manifest
 * abstraction FR-S9 asks for is kept regardless — this interface *is* that
 * abstraction, so a real art pack can be dropped in later by implementing it.
 *
 * The unit of exchange is a {@link PixelGrid}, not a canvas or a texture,
 * because the office runs in a browser and the tests do not. Keeping generation
 * as pure data means every sprite can be asserted about in Node, and the only
 * thing needing a GPU is the part that uploads it.
 */

/**
 * Sprite cell size in pixels. Characters are drawn within this box.
 *
 * 12×16 through Phase 9, and the reason it grew is worth recording: at 12×16 a
 * head is a 4×4 block, which leaves no row for a hairline, no column for a
 * shoulder, and exactly one pixel per eye. Every character therefore came out
 * as the same silhouette in different colours — the art was not crude by
 * intention, it was crude because the box could not hold anything else, and no
 * amount of palette work was going to fix that.
 *
 * 16×24 is the smallest box that holds the three things the direction actually
 * asks for: a hair *shape* distinct enough to recognise an agent by, a two-tone
 * shade on every body part so figures read as rounded rather than as flat
 * rectangles, and a seated pose that is legibly different from a standing one.
 * It is one tile wide and one and a half tall, which is also the proportion the
 * reference draws its characters at.
 *
 * Nothing derives layout from these arithmetically — a 12×16 character does not
 * scale to 16×24 by ratio, and `sprites.ts` re-tunes its constants by hand —
 * but every draw call there is bounds-checked, so a future change clips rather
 * than crashes while it is being re-tuned.
 */
export const SPRITE_WIDTH = 16;
export const SPRITE_HEIGHT = 24;

/** Frames in every animation loop. Uniform so the renderer needs no table. */
export const FRAMES_PER_ANIMATION = 4;

/**
 * Every animation loop the manifest can draw.
 *
 * A `const` array with the union derived from it, rather than the union
 * written by hand — the same shape `shared/src/status.ts` uses for the status
 * vocabularies, and for the same reason. `sprites.test.ts` used to carry its
 * own hardcoded copy of this list, so an animation added to the type was
 * simply never exercised by the suite: the tests would still pass, having
 * quietly tested one fewer thing. Now the list has one home and the tests
 * iterate it.
 *
 * `read` is the newest and is the only one not selected by assignment status
 * alone. Status picks `type` for `working`; the current tool then refines it
 * to `read` (FR-S11). See `toolAnimation` in `model.ts` — the refinement lives
 * there, not here, because this file knows about pixels and nothing about what
 * an agent is doing.
 */
export const SPRITE_ANIMATIONS = [
  'idle',
  'idle_relaxed',
  'idle_slumped',
  'walk',
  'type',
  'read',
] as const;

export type SpriteAnimation = (typeof SPRITE_ANIMATIONS)[number];
export type Facing = 'down' | 'up' | 'left' | 'right';

/**
 * Row-major pixels: `grid[y][x]`. `null` is transparent.
 *
 * CSS colour strings rather than packed integers — they are what
 * `AgentAppearance` already carries, and the conversion belongs at the GPU
 * boundary rather than smeared through generation.
 */
export type PixelGrid = readonly (readonly (string | null)[])[];

export interface SpriteKey {
  appearance: AgentAppearance;
  animation: SpriteAnimation;
  /** 0-based, always less than {@link FRAMES_PER_ANIMATION}. */
  frame: number;
  facing: Facing;
  /**
   * Drawn sitting rather than standing.
   *
   * An axis of its own rather than three more animations (`sit_idle`,
   * `sit_type`, `sit_read`, …), for the same reason `facing` is: sitting is
   * orthogonal to what the character is *doing*, so folding it into the
   * animation union would multiply every future animation by two and let the
   * two halves drift — a `read` that had a seated variant and a `walk` that
   * nonsensically did.
   *
   * The renderer sets it from geometry, not from status: a character is seated
   * when it has arrived at its own desk. That keeps `shared/src/status.ts` the
   * sole owner of behaviour (FR-S3) — sitting down is not a new state, it is
   * what being at your desk looks like.
   *
   * Optional, defaulting to standing, so every existing caller and fixture
   * still typechecks and still describes exactly what it did before.
   */
  seated?: boolean;
}

/**
 * Generate one frame.
 *
 * Must be pure and total: any combination of the above returns a grid of
 * exactly `SPRITE_HEIGHT` rows by `SPRITE_WIDTH` columns. A renderer calling
 * this inside a frame loop cannot handle exceptions usefully, and a missing
 * frame must degrade to a still character rather than a crashed canvas.
 */
export type FrameGenerator = (key: SpriteKey) => PixelGrid;

/**
 * Props drawn beside characters, keyed by name so the renderer needs no
 * knowledge of what they look like.
 *
 * Six of these through Phase 9 — a desk, the Manager's desk, the report page a
 * character carries while `reporting`, and three bubbles — which is why the
 * office read as a grid of desks on a void rather than as a room. The rest
 * furnish it: a chair to sit on, and the things that make a space identifiable
 * as a workplace at a glance (screens, plants, shelves, a clock, art, a couch,
 * a rug under the Manager).
 *
 * They carry no {@link AgentAppearance} and no frame index — a prop is static
 * and identical everywhere it appears, which is what lets the implementation
 * build all of them once at module load instead of caching per call.
 */
export type PropName =
  // furniture a character interacts with
  | 'desk'
  | 'manager_desk'
  | 'chair'
  // the room
  | 'plant'
  | 'bookshelf'
  | 'wall_clock'
  | 'wall_art'
  | 'couch'
  | 'rug'
  // carried and overhead
  | 'paper'
  | 'bubble_speech'
  | 'bubble_alert'
  | 'bubble_error';

/**
 * Unlike {@link FrameGenerator}, a prop is **not** confined to the
 * `SPRITE_WIDTH × SPRITE_HEIGHT` character box: a bookshelf is wider than it is
 * tall and a rug is wider still, and forcing both into a 16×24 cell would mean
 * drawing them at a size the room does not want. The renderer reads each grid's
 * own dimensions when it uploads the texture and anchors it bottom-centre on
 * its tile, so an oversized prop simply overhangs symmetrically.
 *
 * The obligations that remain are that every grid is rectangular (all rows the
 * same length), non-empty, and — as with frames — that generation is total: a
 * name in the union always yields a grid.
 */
export type PropGenerator = (name: PropName) => PixelGrid;

/**
 * What a sprite source must provide. Swapping in a real art pack means
 * implementing this and nothing else (FR-S9).
 *
 * By convention the concrete implementation is exported as `SPRITE_MANIFEST`
 * from `./sprites.js`. That is stated here because it is the one thing this
 * interface cannot enforce: a mismatched export name typechecks fine in
 * isolation on both sides and only fails where they meet.
 */
export interface SpriteManifest {
  readonly id: string;
  readonly spriteWidth: number;
  readonly spriteHeight: number;
  readonly framesPerAnimation: number;
  readonly frame: FrameGenerator;
  readonly prop: PropGenerator;
}
