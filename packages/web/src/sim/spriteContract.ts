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

/** Sprite cell size in pixels. Characters are drawn within this box. */
export const SPRITE_WIDTH = 12;
export const SPRITE_HEIGHT = 16;

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
 * `desk`, `paper` (the report a character carries while `reporting`), and the
 * overhead bubbles the behaviour table can ask for.
 */
export type PropName = 'desk' | 'manager_desk' | 'paper' | 'bubble_speech' | 'bubble_alert' | 'bubble_error';

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
