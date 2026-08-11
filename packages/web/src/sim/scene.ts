import { Application, Container, Graphics, Sprite, Text, Texture, type Ticker } from 'pixi.js';
import type { AssignmentStatus, CharacterBehaviour } from '@agent-office/shared';
import {
  fitPlateLines,
  layoutOffice,
  plateLines,
  TILE,
  type PlateBox,
  type AgentAppearance,
  type CharacterView,
  type DeskSlot,
  type ManagerView,
  type OfficeLayout,
  type OfficeScene,
  type Point,
} from './model.js';
import type { Facing, PixelGrid, PropName, SpriteAnimation, SpriteManifest } from './spriteContract.js';
import { OFFICE, toPixiColour } from '../theme/tokens.js';
import type { PlateDensity } from '../theme/useTheme.js';

/**
 * The pixel-office renderer (PLAN.md §1.2, FR-S1–FR-S7).
 *
 * `model.ts` already decided everything the office *means* — this file only
 * decides what it *looks like*. That split is what makes half of this file
 * testable without a GPU: tile↔pixel conversion, walk interpolation, arrival,
 * hit testing and viewport letterboxing are all plain functions with no Pixi
 * import in their signature, gathered in the section below. The renderer
 * class beneath it is the imperative shell that drives Pixi from those
 * functions' output — it owns no logic of its own that isn't already
 * expressible as "apply this pure function to the current frame".
 *
 * Framework-free by design: nothing here imports React. `OfficeCanvas.tsx` is
 * the (thin) seam to the app; this class works identically in a test harness,
 * a Storybook, or a future non-React shell.
 */

// ---------------------------------------------------------------------------
// Pure, GPU-free geometry and timing. Vitest exercises this section directly.
// ---------------------------------------------------------------------------

/** Tile-space point → world pixel-space point (top-left of the tile). */
export function tileToPixel(tile: Point, tileSize: number = TILE): Point {
  return { x: tile.x * tileSize, y: tile.y * tileSize };
}

/** How fast a character crosses the floor, in tiles of `model.ts` grid per second. */
export const WALK_SPEED_TILES_PER_SECOND = 4;
/**
 * Below this distance (in tiles) a character is considered to have arrived.
 * Without an epsilon, floating-point interpolation approaches but never
 * exactly equals its target, and `hasArrived` would never fire.
 */
export const ARRIVAL_EPSILON_TILES = 0.02;

/**
 * One tick of walk interpolation (FR-S6).
 *
 * Deliberately stateless beyond its arguments: it takes wherever the
 * character currently *is*, not wherever it was heading a moment ago. That is
 * what makes re-routing free — if the caller passes a different `target`
 * than last tick (an assignment flipped from `working` to `reporting` mid-walk,
 * say), this function has no memory of the old target to unwind. It simply
 * steps from `current` towards whatever `target` is *now*.
 */
export function stepTowards(
  current: Point,
  target: Point,
  deltaSeconds: number,
  speedTilesPerSecond: number = WALK_SPEED_TILES_PER_SECOND,
): Point {
  if (deltaSeconds <= 0) return { x: current.x, y: current.y }; // no time passed, no movement

  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const distance = Math.hypot(dx, dy);

  if (distance <= ARRIVAL_EPSILON_TILES) {
    return { x: target.x, y: target.y };
  }

  const maxStep = speedTilesPerSecond * deltaSeconds;
  if (maxStep >= distance) {
    return { x: target.x, y: target.y }; // this tick's step would overshoot — snap instead of oscillating past it
  }

  const ratio = maxStep / distance;
  return { x: current.x + dx * ratio, y: current.y + dy * ratio };
}

export function hasArrived(current: Point, target: Point, epsilon: number = ARRIVAL_EPSILON_TILES): boolean {
  return Math.hypot(target.x - current.x, target.y - current.y) <= epsilon;
}

/**
 * Which way a character should face, derived from the direction it is
 * travelling (`from` → `to`) rather than from any stored "current heading".
 * When there is no meaningful travel this tick (arrived, or not yet moved),
 * `fallback` — the previous facing — is returned so a stationary character
 * doesn't snap back to facing "down" between animation frames.
 */
export function resolveFacing(from: Point, to: Point, fallback: Facing): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < ARRIVAL_EPSILON_TILES && Math.abs(dy) < ARRIVAL_EPSILON_TILES) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/**
 * Per-tick facing, arrival-aware (FR-S14 — the Manager now has someone to
 * report to, and reporting to their back reads as a mistake, not a choice).
 *
 * `resolveFacing` above answers "which way is this character walking", and
 * once movement stops it deliberately falls back to whatever the character
 * was already facing — the right general rule when nothing on screen says
 * what a stationary character *should* be looking at. In this office
 * something always does: every target a character is ever given
 * (`targetFor` in `model.ts`, and the errand destination below) is either its
 * own seat or the Manager's approach tile, and both sit exactly one row south
 * of the thing that matters — the character's own desk, or the Manager who is
 * about to be reported to. Without this override, an agent that walked up to
 * the Manager from the east came to rest still facing east, side-on to the
 * desk it had just crossed the room to reach, and an agent that had just sat
 * down kept facing whatever direction its last step happened to point rather
 * than the screen in front of it.
 *
 * So arrival replaces the general "keep the fallback" rule with a fixed answer
 * rather than deferring to it; short of arrival, movement still decides,
 * unchanged.
 *
 * **Which** fixed answer depends on where the character arrived, and the two
 * cases genuinely differ:
 *
 * - **At the Manager's approach tile: `up`.** The Manager is one row north, and
 *   reporting to somebody's back reads as a bug rather than a choice.
 * - **At its own desk: `down`, facing the viewer.** This is a deliberate trade
 *   and it is worth being honest that it is one. The realistic pose is `up`,
 *   towards the monitor — that is what the reference art draws and what the
 *   first version of this did. But our office is *entirely* agents at desks, so
 *   `up` meant every character on screen was a back of a head, permanently: the
 *   faces, the hair silhouettes that FR-S2 derives per agent, and the blink and
 *   eye-line that make a character look busy were all invisible in the default
 *   view, all of the time. A depiction that never shows anyone's face is not
 *   more realistic, it is less informative. So a seated agent looks up from its
 *   screen at you.
 */
export function arrivalAwareFacing(
  current: Point,
  target: Point,
  fallback: Facing,
  homeSeat?: Point,
): Facing {
  if (!hasArrived(current, target)) return resolveFacing(current, target, fallback);
  // `homeSeat` is optional so the errand tests and any caller that only cares
  // about the Manager case keep working unchanged — an absent seat means "not
  // at a desk", which is exactly the Manager-approach case.
  if (homeSeat !== undefined && hasArrived(current, homeSeat)) return 'down';
  return 'up';
}

/**
 * Whether a character should be drawn seated (`spriteContract.ts`'s `seated`
 * axis), from pure geometry rather than status.
 *
 * FR-S3 makes `shared/src/status.ts` the sole owner of *behaviour* — where a
 * character is, what it carries, which bubble it shows — precisely so the
 * renderer never invents a second idea of what an assignment is doing. Sitting
 * down does not need a new status to describe it, because it is not a new
 * fact: a character is seated exactly when it has arrived at its own desk,
 * which `hasArrived` against its home seat already says. Naming that check
 * here, rather than inlining it at the one call site, is what makes it a
 * guarantee `scene.test.ts` can pin directly — the alternative, computing it
 * ad hoc in `onTick`, would let the "seated" and "at your desk" ideas drift
 * apart the first time someone touched that loop for an unrelated reason.
 */
export function isSeatedAt(currentPos: Point, homeSeat: Point): boolean {
  return hasArrived(currentPos, homeSeat);
}

/** Milliseconds each animation frame is held before advancing to the next. */
export const FRAME_DURATION_MS = 150;

export interface AnimationFrameState {
  frameIndex: number;
  elapsedMs: number;
}

/**
 * Advances a per-character animation-frame counter by `deltaMs`.
 *
 * A plain accumulator rather than `setInterval`, so it is driven by the same
 * ticker delta as movement (and therefore pauses with it — FR-S7) and copes
 * correctly with a large `deltaMs` after the tab was backgrounded and resumed:
 * `Math.floor` below advances by however many frames actually elapsed rather
 * than skipping straight to frame 0.
 */
export function nextAnimationFrame(
  frameIndex: number,
  framesPerAnimation: number,
  elapsedMs: number,
  deltaMs: number,
  frameDurationMs: number = FRAME_DURATION_MS,
): AnimationFrameState {
  if (framesPerAnimation <= 0) return { frameIndex: 0, elapsedMs: 0 };

  const total = elapsedMs + deltaMs;
  const framesAdvanced = Math.floor(total / frameDurationMs);
  if (framesAdvanced <= 0) return { frameIndex, elapsedMs: total };

  return {
    frameIndex: (frameIndex + framesAdvanced) % framesPerAnimation,
    elapsedMs: total % frameDurationMs,
  };
}

/**
 * How the tile grid maps onto the canvas (FR — "pixel art stays crisp").
 *
 * `scale` is always a whole number: fractional scaling is exactly what turns
 * crisp pixel art into a blurry mess under nearest-neighbour sampling, so
 * this floors to the nearest integer rather than fitting the container
 * exactly. The leftover space becomes a centred letterbox (`offsetX`/`offsetY`)
 * instead of stretching the office to fill it.
 */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function computeViewport(
  containerWidthPx: number,
  containerHeightPx: number,
  worldWidthPx: number,
  worldHeightPx: number,
): Viewport {
  if (containerWidthPx <= 0 || containerHeightPx <= 0 || worldWidthPx <= 0 || worldHeightPx <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }

  const rawScale = Math.min(containerWidthPx / worldWidthPx, containerHeightPx / worldHeightPx);
  const scale = Math.max(1, Math.floor(rawScale));
  const offsetX = Math.floor((containerWidthPx - worldWidthPx * scale) / 2);
  const offsetY = Math.floor((containerHeightPx - worldHeightPx * scale) / 2);
  return { scale, offsetX, offsetY };
}

// ---------------------------------------------------------------------------
// FR-S13 — user-controlled zoom.
//
// `computeViewport`'s own comment already names the failure this phase's wall
// made worse: `Math.floor` on the best-fit scale is a hard floor, and growing
// the wall band from 5 tiles to 8 (Phase 10) pushed several real layouts from
// 2x down to 1x against the host's old fixed size. The host box was widened
// in `styles.css` to recover most of that, but there is no host size that
// wins for every window — a host measured at 341x418px fits a four-column
// office's 320px width at 1x regardless of how tall the box is, because
// WIDTH is what binds there, not height. Below that width, "automatic" has no
// better answer to give, so the office needs a control the user can reach for
// instead.
// ---------------------------------------------------------------------------

/** The only zoom steps the office ever renders at. Integer-only, per
 *  `computeViewport`'s own reasoning: fractional scaling is precisely what
 *  turns crisp pixel art to mush under nearest-neighbour sampling. */
export const ZOOM_LEVELS = [1, 2, 3, 4] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];
// Written as literals, not `ZOOM_LEVELS[0]`/`[...length - 1]` — with
// `noUncheckedIndexedAccess` on, indexing even a `const` tuple widens the
// result to include `undefined`, which is exactly the kind of value these
// two constants exist to rule out.
export const MIN_ZOOM: ZoomLevel = 1;
export const MAX_ZOOM: ZoomLevel = 4;

/**
 * What the user has picked. `'auto'` — the default — means "keep doing
 * `computeViewport`'s largest-integer-that-fits", not a fixed number: that
 * behaviour is correct whenever the host has room, and the explicit levels
 * exist for when it does not, not to replace it as the default.
 */
export type ZoomPreference = 'auto' | ZoomLevel;

export function isZoomLevel(value: number): value is ZoomLevel {
  return (ZOOM_LEVELS as readonly number[]).includes(value);
}

/**
 * Preference + the automatic best-fit scale → the concrete integer scale to
 * render at.
 *
 * Pure and exported so `scene.test.ts` can drive it directly without a DOM —
 * the same convention every other decision in this file's top half follows.
 * `autoFitScale` is trusted to be a `computeViewport` result in the running
 * app (already an integer >= 1), but this floors and clamps it anyway rather
 * than assuming: a caller in a test, or a future `computeViewport` change,
 * should not be able to make this function hand back a fractional or
 * out-of-range scale.
 */
export function resolveZoom(preference: ZoomPreference, autoFitScale: number): ZoomLevel {
  const source = preference === 'auto' ? autoFitScale : preference;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(source)));
  // `clamped` is an integer inside `[MIN_ZOOM, MAX_ZOOM]`, and `ZOOM_LEVELS`
  // is every integer in that closed range, so the cast is exhaustive rather
  // than an assumption.
  return clamped as ZoomLevel;
}

/** `localStorage`'s string form of a `ZoomPreference` → the preference, or
 *  `'auto'` for anything missing, corrupted or hand-edited — a broken stored
 *  value must fall back to the safe default, not wedge the office at 0x. */
export function parseZoomPreference(stored: string | undefined): ZoomPreference {
  if (stored === 'auto') return 'auto';
  if (stored !== undefined) {
    const parsed = Number(stored);
    if (isZoomLevel(parsed)) return parsed;
  }
  return 'auto';
}

/**
 * A `Viewport` plus the pixel size the `<canvas>` element itself needs to be
 * to show the whole scaled world without clipping.
 *
 * Ordinarily — auto-fit, or an explicit zoom the container still has room
 * for — `canvasWidthPx`/`canvasHeightPx` are just the container's own size,
 * exactly `computeViewport`'s letterboxed behaviour. Once an explicit zoom
 * makes the scaled world bigger than the container on an axis, the canvas
 * grows to that axis's full scaled size instead of clipping it. The renderer
 * resizes the actual `<canvas>` element to match, which is what lets the
 * host's own `overflow: auto` (added in `styles.css` alongside this feature)
 * turn the excess into a real, native scrollbar — panning by scrolling
 * rather than a bespoke drag handler this file would otherwise need to invent
 * and keep in sync with hit testing.
 */
export interface ZoomedViewport extends Viewport {
  /** Narrower than `Viewport.scale: number` — a `ZoomedViewport` is always
   *  the result of resolving a `ZoomPreference`, so its scale is always one
   *  of the four real steps, not an arbitrary integer. */
  scale: ZoomLevel;
  canvasWidthPx: number;
  canvasHeightPx: number;
}

export function computeZoomedViewport(
  containerWidthPx: number,
  containerHeightPx: number,
  worldWidthPx: number,
  worldHeightPx: number,
  scale: number,
): ZoomedViewport {
  // Same clamp as `resolveZoom`, and the same reasoning for the cast: this is
  // an integer inside `[MIN_ZOOM, MAX_ZOOM]`, which is exhaustively `ZoomLevel`.
  const safeScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(scale))) as ZoomLevel;
  const safeContainerWidth = Math.max(1, Math.floor(containerWidthPx));
  const safeContainerHeight = Math.max(1, Math.floor(containerHeightPx));

  if (worldWidthPx <= 0 || worldHeightPx <= 0) {
    return { scale: safeScale, offsetX: 0, offsetY: 0, canvasWidthPx: safeContainerWidth, canvasHeightPx: safeContainerHeight };
  }

  // The larger of "the container's own box" and "the whole world at this
  // scale" on each axis, independently — a wide-but-short office and a
  // narrow-but-tall one can each need the canvas to grow on only one axis.
  const canvasWidthPx = Math.max(safeContainerWidth, worldWidthPx * safeScale);
  const canvasHeightPx = Math.max(safeContainerHeight, worldHeightPx * safeScale);
  // Centring against the CANVAS size, not the container's: when the canvas
  // is exactly the scaled world (the zoomed-past-fit case) this is 0 on that
  // axis, correctly — there is no spare room to centre into, the world fills
  // the canvas edge to edge, and any scrolling happens at the DOM level
  // above this, outside what offsetX/Y describe.
  const offsetX = Math.floor((canvasWidthPx - worldWidthPx * safeScale) / 2);
  const offsetY = Math.floor((canvasHeightPx - worldHeightPx * safeScale) / 2);
  return { scale: safeScale, offsetX, offsetY, canvasWidthPx, canvasHeightPx };
}

/** Canvas (client) pixel → world pixel, inverting the letterbox transform. */
export function canvasToWorld(canvasPoint: Point, viewport: Viewport): Point {
  return {
    x: (canvasPoint.x - viewport.offsetX) / viewport.scale,
    y: (canvasPoint.y - viewport.offsetY) / viewport.scale,
  };
}

/** World pixel → canvas (client) pixel, applying the letterbox transform. */
export function worldToCanvas(worldPoint: Point, viewport: Viewport): Point {
  return {
    x: worldPoint.x * viewport.scale + viewport.offsetX,
    y: worldPoint.y * viewport.scale + viewport.offsetY,
  };
}

/**
 * Hit testing (FR-S5), in world pixel space.
 *
 * `x`/`y` are the entity's footprint anchor — bottom-centre, matching how
 * characters are actually positioned and drawn (see `CharacterRenderState`
 * below) — so this box lines up with what the user sees without the caller
 * needing to know sprite-anchor conventions.
 */
export interface HitTestEntity {
  assignmentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Later entries win ties. Entities are appended in draw order, so the last
 * one is whatever was painted on top — the intuitive choice for overlapping
 * sprites (which can briefly happen when two characters cross paths).
 */
export function hitTest(entities: readonly HitTestEntity[], point: Point): string | undefined {
  for (let i = entities.length - 1; i >= 0; i -= 1) {
    const entity = entities[i];
    if (entity === undefined) continue;
    const left = entity.x - entity.width / 2;
    const right = entity.x + entity.width / 2;
    const top = entity.y - entity.height;
    const bottom = entity.y;
    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
      return entity.assignmentId;
    }
  }
  return undefined;
}

/**
 * Whether a desk should show the work glow (FR-U3's one new affordance for
 * this phase).
 *
 * Reads the RAW `behaviour.animation` rather than the tool-refined
 * `view.animation` that `syncCharacters` now draws, and the distinction is
 * load-bearing rather than an oversight. FR-S11 splits the working loop into
 * `type` and `read` according to which tool is running, but an agent running
 * `Grep` is working exactly as much as one running `Write` — the glow means
 * "this desk is busy", so it must survive the split. Keying it on the refined
 * animation would switch the light off every time an agent read a file.
 *
 * Still not `status === 'working'`, for the original reason:
 * `ASSIGNMENT_BEHAVIOUR` in `@agent-office/shared` is the single place status
 * maps to what's on screen (FR-S3), and a second comparison here could drift
 * from it. No new state is introduced — this is a pure read of a
 * `CharacterView` the scene already has.
 */
export function isWorkGlowing(behaviour: CharacterView['behaviour']): boolean {
  return behaviour.animation === 'type';
}

/**
 * Which row-kind tile row `y` belongs to (FR-S1 — the room needs a back, not
 * just a floor).
 *
 * Pure so `rebuildFloorAndDesks` needs no duplicate arithmetic to decide what
 * it is painting, and so the one invariant that actually matters — the wall
 * is exactly `layout.wallRows` rows deep, no more, no less, because
 * `layoutOffice` positions the Manager's desk assuming exactly that — has a
 * function `scene.test.ts` can pin directly rather than trusting a `Graphics`
 * call list nothing in this environment can inspect (there is no canvas or
 * WebGL context in the Vitest run — see the header comment above).
 */
export type RoomRowKind = 'wall' | 'floor';

export function roomRowKind(y: number, layout: OfficeLayout): RoomRowKind {
  return y < layout.wallRows ? 'wall' : 'floor';
}

/** Width of one floorboard, in tiles — wider than it is tall, so the boards
 *  read as planks laid on the floor rather than as a repainted checkerboard. */
const FLOOR_BOARD_WIDTH_TILES = 2;

/**
 * Which of the two floor tones a board at `(x, y)` gets, laid in a brick
 * bond: every other row of boards is offset by half a board width, the way
 * real flooring staggers its seams so they never all line up in one column.
 * Pure for the same reason `roomRowKind` is — this is geometry, not drawing.
 */
export function floorBoardShade(x: number, y: number, layout: OfficeLayout): 'light' | 'dark' {
  const floorRow = y - layout.wallRows;
  const stagger = Math.abs(floorRow) % 2 === 0 ? 0 : 1;
  const board = Math.floor((x + stagger) / FLOOR_BOARD_WIDTH_TILES);
  return board % 2 === 0 ? 'light' : 'dark';
}

// ---------------------------------------------------------------------------
// The errand: a renderer-owned visit to the Manager (FR-S6, FR-S14).
//
// `briefing` and `reporting` are the two statuses that send a character to
// `to_manager`, and both are astonishingly short-lived in a real run — a
// briefing is a handful of file reads and some string assembly, a report is
// one file write, both comfortably inside 10ms in `dispatcher.ts`. The walk
// from a desk to the Manager's approach tile, at `WALK_SPEED_TILES_PER_SECOND`,
// takes on the order of a second. Left alone, `onTick` calls `stepTowards`
// with whatever `state.target` is *right now* every frame — which is exactly
// the design `stepTowards`'s own doc comment defends, re-routing being free —
// but it means a character given a target for 10ms and then a new one gets a
// single tick's worth of travel towards the first, about one pixel, before
// reversing towards the second. The office's central interaction — an agent
// walking up to report to the Manager — was therefore never actually visible
// on a live run: it existed in `target` for less than a frame and nowhere on
// screen.
//
// The fix is not to slow the statuses down (they are not wrong; the walk
// merely can't consume a status that has already moved on) and it is not to
// give `stepTowards` a memory (that would break the re-routing guarantee
// every other target change relies on, briefing/reporting included). Instead
// the renderer keeps its own travel record — an "errand" — that, once
// started, ignores `view.target` until the errand itself decides it is done:
// walk to the Manager, dwell there for a fixed beat, then release back to
// following whatever `view.target` says by then (almost always the character's
// own desk, since `briefing`/`reporting` have long since resolved).
//
// This does not reach across FR-S3's line between behaviour and rendering.
// FR-S3 says the renderer owns no *status* of its own — it must not decide
// that an assignment is briefing, or invent a bubble or a carried-paper prop
// `shared/src/status.ts` didn't hand it. An errand decides none of that: it
// is travel state, the same category `currentPos` already is, which the
// renderer has always owned (see `CharacterRenderState.currentPos`'s comment).
// The orchestrator's status already sent this character on the trip by
// setting `location: 'to_manager'` for one snapshot; the errand's only job is
// finishing the journey that status started, once, rather than letting a
// faster subsequent snapshot cut it off after a single pixel.
// ---------------------------------------------------------------------------

/** How long a character dwells at the Manager's desk before turning back.
 *  Long enough to read as an actual exchange rather than a blip — a walk that
 *  arrived and immediately reversed would look exactly like the bug this
 *  errand exists to fix — short enough not to visibly stall a fast-moving run. */
export const ERRAND_DWELL_MS = 1000;

/**
 * Upper bound on an errand's total lifetime, walking and dwelling combined.
 *
 * This is a deadlock guard, not a walk-time budget: if a layout change moved
 * the approach tile (an agent count change mid-run reflows every desk) out
 * from under an in-flight errand, or arrival simply never resolves for some
 * reason this file hasn't anticipated, the errand must still let go rather
 * than pin the character mid-stride forever. 10s comfortably covers the walk
 * (a few seconds even across an unusually wide office at
 * `WALK_SPEED_TILES_PER_SECOND`) plus the dwell, with room to spare — and if
 * it is ever exceeded, the character simply resumes following `view.target`
 * a little early rather than the office silently wedging one desk.
 */
export const ERRAND_MAX_LIFETIME_MS = 10_000;

export type ErrandPhase = 'walking' | 'dwelling';

/** One character's in-flight visit to the Manager. See the section header for why this exists. */
export interface Errand {
  /**
   * Captured once, at `startErrand`, rather than re-read from `layout` every
   * tick — so a layout reflow mid-errand cannot retarget a walk that is
   * already underway.
   */
  destination: Point;
  phase: ErrandPhase;
  /** Time spent dwelling so far, ms. Only meaningful once `phase` is `'dwelling'`. */
  dwellElapsedMs: number;
  /** Time since the errand started, ms — what `ERRAND_MAX_LIFETIME_MS` bounds. */
  totalElapsedMs: number;
}

export function startErrand(destination: Point): Errand {
  return { destination: { ...destination }, phase: 'walking', dwellElapsedMs: 0, totalElapsedMs: 0 };
}

/**
 * Whether a fresh errand should begin this sync.
 *
 * Only when the behaviour the orchestrator just sent is `to_manager` AND no
 * errand is already running — the second half matters as much as the first:
 * without it, a `briefing` that happens to still read `to_manager` on the
 * very next snapshot (a slow provider, say) would restart the walk-and-dwell
 * from scratch on every scene push instead of letting the one already running
 * finish.
 */
export function shouldStartErrand(location: CharacterBehaviour['location'], existing: Errand | undefined): boolean {
  return location === 'to_manager' && existing === undefined;
}

/**
 * The errand a character should carry after this scene sync, combining
 * {@link shouldStartErrand} with FR-U5's reduced-motion carve-out.
 *
 * Under `prefers-reduced-motion` a character already snaps straight to its
 * target (`onTick`'s `reducedMotion` branch) — that is the setting doing
 * exactly what it promises, removing motion the user asked not to see. An
 * errand that forced a one-second dwell on top of an instant snap would
 * quietly reintroduce the motion the setting exists to remove, so reduced
 * motion skips the errand entirely: it never starts one, and it drops one
 * already in flight rather than let it keep dwelling into a mode that is
 * supposed to have no dwelling left anywhere in the office.
 */
export function nextErrand(
  current: Errand | undefined,
  location: CharacterBehaviour['location'],
  destination: Point,
  reducedMotion: boolean,
): Errand | undefined {
  if (reducedMotion) return undefined;
  if (shouldStartErrand(location, current)) return startErrand(destination);
  return current;
}

/**
 * Whether an in-flight errand must be abandoned rather than allowed to finish.
 *
 * An assignment that resolves to `failed` or `cancelled` while its character
 * is mid-errand must not be shown completing the trip — walking up to the
 * Manager, dwelling, and walking back would read as "this agent delivered its
 * report", which is false for work that was stopped rather than finished. Every
 * other status (including the terminal `done`/`skipped`, which never send a
 * character on an errand in the first place) leaves an existing errand alone.
 */
export function shouldAbandonErrand(status: AssignmentStatus): boolean {
  return status === 'failed' || status === 'cancelled';
}

/**
 * One tick of an errand's own state machine — walk, then dwell, then release.
 *
 * Takes `currentPos` (this tick's post-movement position, from `stepTowards`
 * called against `errand.destination`) rather than recomputing distance
 * itself, so there is exactly one place — `stepTowards` — that knows how a
 * character covers ground; this function only ever asks "has it arrived".
 * Returns `undefined` once the errand is over (dwell complete, or the
 * lifetime cap tripped), which is the caller's cue to resume following
 * `view.target` directly.
 */
export function advanceErrand(errand: Errand, currentPos: Point, deltaMs: number): Errand | undefined {
  const totalElapsedMs = errand.totalElapsedMs + deltaMs;
  if (totalElapsedMs >= ERRAND_MAX_LIFETIME_MS) return undefined;

  if (errand.phase === 'walking') {
    if (!hasArrived(currentPos, errand.destination)) return { ...errand, totalElapsedMs };
    return { ...errand, phase: 'dwelling', dwellElapsedMs: 0, totalElapsedMs };
  }

  const dwellElapsedMs = errand.dwellElapsedMs + deltaMs;
  if (dwellElapsedMs >= ERRAND_DWELL_MS) return undefined;
  return { ...errand, dwellElapsedMs, totalElapsedMs };
}

// ---------------------------------------------------------------------------
// Sprite-texture plumbing. Talks to the DOM (canvas, `Texture.from`) but not
// to an `Application`, so it stays out of the way of the pure section above.
// ---------------------------------------------------------------------------

/**
 * A stable cache key for one agent's look. Two agents that hash to the same
 * palette entries (rare, but `appearanceFor` makes no uniqueness promise)
 * correctly share a texture — that's a cache hit, not a bug.
 */
function appearanceKey(appearance: AgentAppearance): string {
  return `${String(appearance.body)}-${String(appearance.hairStyle)}-${appearance.skin}-${appearance.hair}-${appearance.shirt}-${appearance.trousers}`;
}

/**
 * A stable cache key for one frame texture.
 *
 * `seated` is part of the key, not an afterthought, mirroring
 * `sprites.ts`'s own `cacheKey` for exactly the reason its comment there
 * gives: a standing pose and a seated pose are genuinely different pixels for
 * the same appearance/animation/frame/facing, so a key that ignored `seated`
 * would serve whichever pose happened to be generated first to every
 * subsequent lookup — a seated character rendered standing (or vice versa)
 * for as long as the cache entry lived. Exported so `scene.test.ts` can pin
 * that two calls differing only in `seated` produce different keys, which is
 * the whole guarantee.
 */
export function frameTextureKey(
  appearance: AgentAppearance,
  animation: SpriteAnimation,
  frame: number,
  facing: Facing,
  seated: boolean,
): string {
  return `${appearanceKey(appearance)}|${animation}|${String(frame)}|${facing}|${seated ? 'sit' : 'stand'}`;
}

/**
 * `PixelGrid` → GPU texture, painted onto an offscreen canvas one CSS-colour
 * cell at a time. A `<canvas>` (not `ImageData`) because `null` cells must
 * stay genuinely transparent, and an untouched canvas pixel already is.
 */
function pixelGridToTexture(grid: PixelGrid): Texture {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);

  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    for (let y = 0; y < height; y += 1) {
      const row = grid[y];
      if (row === undefined) continue;
      for (let x = 0; x < width; x += 1) {
        const colour = row[x];
        if (colour === null || colour === undefined) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  const texture = Texture.from(canvas);
  // Nearest-neighbour sampling is the whole reason pixel art stays crisp when
  // the world container below is scaled up by an integer factor.
  texture.source.scaleMode = 'nearest';
  return texture;
}

function bubblePropFor(bubble: 'speech' | 'alert' | 'error'): PropName {
  switch (bubble) {
    case 'speech':
      return 'bubble_speech';
    case 'alert':
      return 'bubble_alert';
    case 'error':
      return 'bubble_error';
  }
}

// ---------------------------------------------------------------------------
// The renderer.
// ---------------------------------------------------------------------------

export interface OfficeSceneCallbacks {
  /** Fired on hover-in/hover-out over a character; `undefined` on hover-out. */
  onHoverAssignment?: (assignmentId: string | undefined) => void;
  /** Fired on click over a character (FR-S5 — the caller opens the inspect panel). */
  onSelectAssignment?: (assignmentId: string) => void;
  /**
   * Fired whenever the resolved (FR-S13) zoom level changes — a window
   * resize under `'auto'`, or `setZoom` being called with a different
   * preference. `OfficeCanvas.tsx`'s zoom overlay needs this to show the
   * concrete level actually on screen and to step `+`/`-` from it, neither of
   * which it could otherwise know: the resolution against the live container
   * size happens entirely inside this class.
   */
  onZoomChange?: (zoom: ZoomLevel) => void;
}

/** Everything the renderer keeps about one on-screen character between frames. */
interface CharacterRenderState {
  root: Container;
  bodySprite: Sprite;
  bubbleSprite: Sprite;
  paperSprite: Sprite;
  selectionRing: Graphics;
  /** The whole plate — name line plus however many detail lines the density asks for. */
  plate: Container;
  nameplate: Text;
  /** Detail lines under the name, created lazily and reused across renders. */
  detailLines: Text[];
  /** Tile-space, floating-point — this is the walk-interpolation state (FR-S6). */
  currentPos: Point;
  target: Point;
  facing: Facing;
  animation: SpriteAnimation;
  appearance: AgentAppearance;
  /**
   * Static tile the plate is pinned under; does not move when the character
   * walks, so a desk stays labelled while its occupant is at the Manager.
   *
   * The SEAT, not the desk. Pinning it under the desk tile put the text one
   * tile above the character's feet — i.e. straight through its body — which
   * a single short nameplate mostly got away with and a two- or four-line
   * plate does not: the screenshot that caught this had "run default" printed
   * across a sprite's chest. The seat's own tile is where the character
   * stands, so one tile below it is the first row that is reliably clear.
   */
  plateAnchorTile: Point;
  /**
   * The character's own desk seat — the arrival target `isSeatedAt` checks
   * `currentPos` against.
   *
   * Currently always equal to `plateAnchorTile` (both come from
   * `view.home.seat`), but kept as its own field rather than reusing that one:
   * the two exist for unrelated reasons — one anchors a label, the other
   * decides which sprite pose to draw — and a future change to how plates are
   * pinned should not be able to silently change which tile counts as
   * "seated" too.
   */
  homeSeat: Point;
  /** The opaque backing panel behind this plate's lines (FR-S10 legibility). */
  plateBackground: Graphics;
  /** In-flight visit to the Manager, if any — see the errand section above. */
  errand: Errand | undefined;
  frameIndex: number;
  frameElapsedMs: number;
  lastTextureKey: string | undefined;
}

/** Everything the renderer keeps about the Manager between frames — the same
 *  shape a character gets, minus every field that only makes sense for
 *  something that walks (`target`, `facing`, `errand`): the Manager never
 *  moves from its seat, so those axes simply don't apply to it. */
interface ManagerRenderState {
  root: Container;
  bodySprite: Sprite;
  plate: Container;
  nameplate: Text;
  plateBackground: Graphics;
  /**
   * The Manager's un-truncated name, kept separately from `nameplate.text`
   * (which may already hold a fitted, ellipsised version). `fitPlateLines`
   * must always be given the source string — re-fitting an already-truncated
   * one on a later viewport change would double up the ellipsis instead of
   * re-deriving the correct cut for the new width.
   */
  name: string;
  /** Tile the Manager is drawn on. Captured once at creation; `syncManager`
   *  re-derives it from the current view on every call in case the layout
   *  ever moves the head desk, and only writes it back here for
   *  `repositionNameplates`' benefit. */
  seat: Point;
  animation: SpriteAnimation;
  appearance: AgentAppearance;
  frameIndex: number;
  frameElapsedMs: number;
  lastTextureKey: string | undefined;
}

// FR-U2/FR-U3: every colour the renderer paints comes from `OFFICE` via
// `toPixiColour` — Pixi wants numbers, `OFFICE` holds strings for the DOM
// side of the same palette, so this is the one conversion point rather than
// a second copy of the values themselves.
const FLOOR_LIGHT = toPixiColour(OFFICE.floorLight);
const FLOOR_DARK = toPixiColour(OFFICE.floorDark);
const FLOOR_SEAM_COLOUR = toPixiColour(OFFICE.floorSeam);
const BACKGROUND_COLOUR = toPixiColour(OFFICE.background);
/** The wall's face, its lit top band, and the skirting line where it meets
 *  the floor — the room's one hard edge (FR-S1). */
const WALL_COLOUR = toPixiColour(OFFICE.wall);
const WALL_TOP_COLOUR = toPixiColour(OFFICE.wallTop);
const WALL_TRIM_COLOUR = toPixiColour(OFFICE.wallTrim);
/** Thickness, in screen pixels at 1x, of the lit band along the very top of
 *  the wall and of the skirting line at its base. */
const WALL_TOP_BAND_PX = 3;
const WALL_TRIM_PX = 2;
const NAMEPLATE_GAP_PX = 2;
const NAMEPLATE_COLOUR = toPixiColour(OFFICE.nameplate);
const SELECTION_RING_COLOUR = toPixiColour(OFFICE.selection);
/**
 * The plate's secondary lines — model, tool, spend (FR-S10).
 *
 * Dimmer than the name on purpose. The agent's name is what you scan a floor
 * of desks for; everything under it is detail you read once you have found the
 * desk you wanted. Giving all four lines equal weight would make a five-agent
 * office twenty equally-loud strings, which is the clutter failure the phase's
 * own risk note calls out.
 */
const PLATE_DETAIL_COLOUR = toPixiColour(OFFICE.plateDetail);
/**
 * Point size of the name line, and of the detail lines beneath it — in the
 * UNSCALED `uiLayer` (see `plateBox`'s own doc comment), which is exactly why
 * these cannot just be left at their original 10/8: everything else in the
 * office gets physically bigger as `viewport.scale` climbs with FR-S13's zoom,
 * but a `Text` object at a fixed point size does not, so an 8px detail line
 * was still an 8px detail line at 4x — genuinely too small to read even once
 * the rest of the room had grown to fill the frame.
 *
 * Raised from 10/8 to 13/11 for that reason (a user-reported legibility
 * complaint, not a guess): large enough to read comfortably at any zoom
 * level, while `fitPlateLines` still has room, at the box `plateBox()`
 * computes at 2x and above, to show a normal-density plate's name and model
 * in full rather than ellipsing the name away — `scene.test.ts` pins that
 * directly, since it is the one thing this bump could plausibly have broken.
 */
const PLATE_NAME_SIZE = 13;
const PLATE_DETAIL_SIZE = 11;
/**
 * Leading between plate lines, in unscaled pixels.
 *
 * Re-derived from the same relationship the original 9/10/8 triple already
 * had, not picked independently: 9 was `PLATE_DETAIL_SIZE + 1`, one pixel of
 * clear leading past the shorter of the two fonts. `12 = PLATE_DETAIL_SIZE +
 * 1` keeps that identical ratio at the new sizes rather than inventing a new
 * one, which is what "grow proportionally" means here — enough gap that
 * consecutive detail lines (both drawn at `PLATE_DETAIL_SIZE`) don't collide,
 * without wasting the vertical room `plateBox()` has to fit them in.
 */
const PLATE_LINE_HEIGHT = 12;
/** The plate's opaque backing panel (FR-S10's legibility fix — see
 *  `OFFICE.plateBg`'s doc comment for the 2.18:1 measurement that made it
 *  necessary) and its hairline border. */
const PLATE_BG_COLOUR = toPixiColour(OFFICE.plateBg);
const PLATE_EDGE_COLOUR = toPixiColour(OFFICE.plateEdge);
/** Clearance between a plate's text and the edge of its backing panel. */
const PLATE_PANEL_PADDING_X = 4;
const PLATE_PANEL_PADDING_Y = 2;
/**
 * The plate panel's opacity — a legibility guarantee, not a style choice, so
 * it is pinned exactly rather than left as a literal at the draw call.
 *
 * `OFFICE.plateBg`'s doc comment and `officeText.test.ts`'s contrast suite
 * both depend on this being exactly 1: at any lower alpha the colour actually
 * on screen would be a blend of `plateBg` and whatever floorboard sits
 * underneath, which is not the colour either of those checks measures. This
 * constant, and `scene.test.ts` pinning it, are what keep that assumption
 * honest rather than merely hoped-for.
 */
export const PLATE_PANEL_ALPHA = 1;
/**
 * Hover (and keyboard-focus) ring strength, against selection's full opacity.
 *
 * Two strengths for one ring rather than two different shapes, which is the
 * approach pixel-agents takes for the same problem: hover is a question ("this
 * one?") and selection is a statement ("this one"), and the reader needs to
 * tell them apart at a glance without learning a second visual vocabulary.
 */
const HOVER_RING_ALPHA = 0.45;
/**
 * Desk spacing, in tiles, mirrored from `layoutOffice`'s own constants.
 *
 * Duplicated deliberately and narrowly: `model.ts` keeps these private because
 * they describe how the grid is BUILT, and this is the one consumer that needs
 * to know how much room the grid leaves — the gap a plate must fit inside.
 * `plateGeometry.test.ts` asserts the two stay equal, so the copy cannot drift
 * silently the way an unwatched duplicate would.
 */
const DESK_SPACING_TILES_X = 4;
const DESK_SPACING_TILES_Y = 4;
/**
 * Kept clear between two adjacent plates so they never appear to touch.
 *
 * Left unchanged by the FR-S13/legibility text-size bump above, deliberately:
 * this reserves screen space so the NEXT plate has a gap, not room for THIS
 * plate's own glyphs — `fitPlateLines` is what absorbs a bigger font by
 * fitting fewer characters into the same `widthPx`, and it does; shrinking
 * the gutter to buy back width would trade the "plates never touch" guarantee
 * for a few more characters, which is the wrong side of that trade.
 */
const PLATE_GUTTER_PX = 6;
/** Kept clear below a plate so it never reaches the next row's desk. Left
 *  unchanged for the same reason as `PLATE_GUTTER_PX` just above. */
const PLATE_VERTICAL_MARGIN_PX = 20;
/** Cast under a desk whose agent is currently `working` — see `isWorkGlowing`. */
const WORK_GLOW_COLOUR = toPixiColour(OFFICE.workGlow);
/** Soft, not solid — a glow that competed with the selection ring or a status
 * bubble for attention would defeat the point of keeping status legible. */
const WORK_GLOW_ALPHA = 0.35;

/**
 * Drives one PixiJS `Application` from a stream of `OfficeScene` snapshots.
 *
 * Lifecycle is `mount` → any number of `update`/`resize` → `destroy`, and
 * every one of those is safe to call at the "wrong" time (before mount,
 * twice, out of order) because React StrictMode's double-invoke in
 * development will do exactly that to whatever this class exposes.
 */
export class OfficeSceneRenderer {
  private readonly manifest: SpriteManifest;
  private readonly callbacks: OfficeSceneCallbacks;

  private app: Application | undefined;
  private world: Container | undefined; // scaled+letterboxed: floor, glow, desks, characters
  private floorLayer: Container | undefined;
  // Between the floor and the desks, so a glow reads as light spilling out
  // from under a desk rather than painted on top of it.
  private workGlowLayer: Container | undefined;
  private deskLayer: Container | undefined;
  private characterLayer: Container | undefined;
  private uiLayer: Container | undefined; // unscaled overlay: nameplates, kept crisp at any zoom

  private resizeObserver: ResizeObserver | undefined;
  private visibilityHandler: (() => void) | undefined;
  private mediaQuery: MediaQueryList | undefined;
  private mediaQueryHandler: (() => void) | undefined;
  private canvasEl: HTMLCanvasElement | undefined;
  private pointerMoveHandler: ((ev: PointerEvent) => void) | undefined;
  private pointerLeaveHandler: (() => void) | undefined;
  private clickHandler: ((ev: MouseEvent) => void) | undefined;

  private readonly textureCache = new Map<string, Texture>();
  private readonly characters = new Map<string, CharacterRenderState>();
  /**
   * The Manager, kept entirely apart from `characters` (FR-S14).
   *
   * `hitTestAt` below builds its search list from `characters` alone, so
   * simply never putting the Manager into that map — rather than putting it
   * there and filtering it back out at hit-test time — is what makes
   * "the Manager cannot be clicked" true by construction instead of by a
   * remembered exception. See `ManagerView`'s doc comment in `model.ts` for
   * why it has no `assignmentId` to key a map entry with in the first place.
   */
  private managerState: ManagerRenderState | undefined;

  private latestLayout: OfficeLayout = layoutOffice(0);
  private pendingScene: OfficeScene | undefined;
  private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  private lastContainerWidth: number | undefined;
  private lastContainerHeight: number | undefined;
  private selectedId: string | undefined;
  private lastHoverId: string | undefined;
  private hoveredId: string | undefined;
  private plateDensity: PlateDensity = 'normal';
  /** Kept so a density change can redraw plates without waiting for the next scene push. */
  private latestCharacters: readonly CharacterView[] = [];

  /** FR-S13. `'auto'` until `setZoom` says otherwise. */
  private zoomPreference: ZoomPreference = 'auto';
  /** The zoom level `onZoomChange` last reported, so a resize that resolves
   *  to the same level `applyViewport` already showed doesn't fire the
   *  callback (and therefore a React re-render) for nothing. */
  private lastReportedZoom: ZoomLevel | undefined;

  private reducedMotion = false;
  private initialized = false;
  private mounting = false;
  private destroyed = true; // true until the first successful `mount`
  private mountToken = 0;

  constructor(manifest: SpriteManifest, callbacks: OfficeSceneCallbacks = {}) {
    this.manifest = manifest;
    this.callbacks = callbacks;
  }

  /**
   * Attaches a canvas to `container` and starts the render loop.
   *
   * Safe to call again on the same instance (e.g. a fast unmount/remount):
   * any previous mount is torn down first via `destroy`.
   */
  mount(container: HTMLElement): void {
    if (this.app !== undefined || this.mounting) this.destroy();

    this.destroyed = false;
    this.mounting = true;
    const token = (this.mountToken += 1);

    const app = new Application();
    this.app = app;

    void this.initApp(app, container, token);
  }

  private async initApp(app: Application, container: HTMLElement, token: number): Promise<void> {
    await app.init({
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      backgroundColor: BACKGROUND_COLOUR,
      antialias: false, // pixel art: no smoothing
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preference: 'webgl',
    });

    // `destroy()` (or a newer `mount()`) may have run while `init` was
    // in flight. Finish tearing this instance down rather than attaching a
    // canvas nobody asked for any more.
    if (token !== this.mountToken || this.destroyed) {
      app.destroy(true, { children: true, texture: true, textureSource: true });
      return;
    }

    container.appendChild(app.canvas);
    this.canvasEl = app.canvas;

    this.world = new Container();
    this.floorLayer = new Container();
    this.workGlowLayer = new Container();
    this.deskLayer = new Container();
    this.characterLayer = new Container();
    this.world.addChild(this.floorLayer, this.workGlowLayer, this.deskLayer, this.characterLayer);

    this.uiLayer = new Container();

    app.stage.addChild(this.world, this.uiLayer);

    this.attachInteraction(app.canvas);
    this.attachVisibilityHandling(app);
    this.attachReducedMotionHandling();

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      this.resize(entry.contentRect.width, entry.contentRect.height);
    });
    this.resizeObserver.observe(container);

    this.initialized = true;
    this.mounting = false;
    this.resize(container.clientWidth, container.clientHeight);

    const pending = this.pendingScene;
    this.pendingScene = undefined;
    if (pending !== undefined) this.applyScene(pending);

    app.ticker.add(this.onTick);
  }

  /** Feeds a new `OfficeScene` snapshot in. Cheap to call on every state update. */
  update(scene: OfficeScene): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.pendingScene = scene; // applied once `mount`'s async init resolves
      return;
    }
    this.applyScene(scene);
  }

  private applyScene(scene: OfficeScene): void {
    this.latestLayout = scene.layout;
    this.latestCharacters = scene.characters;
    this.rebuildFloorAndDesks(scene.layout);
    this.syncCharacters(scene.characters);
    this.syncManager(scene.manager);
    this.rebuildWorkGlows(scene.characters);
    if (this.lastContainerWidth !== undefined && this.lastContainerHeight !== undefined) {
      this.applyViewport(this.lastContainerWidth, this.lastContainerHeight);
    }
  }

  /** Marks one assignment's character as selected (or none, for `undefined`). */
  setSelected(assignmentId: string | undefined): void {
    this.selectedId = assignmentId;
    this.refreshHighlights();
  }

  /**
   * Marks one character as hovered — by pointer, or by keyboard focus landing
   * on its button in the office's text alternative (FR-S12).
   *
   * Separate from `setSelected` because they mean different things and can be
   * true at once: selected is "the inspect panel is showing this one", hovered
   * is "you are pointing at, or focused on, this one". They render at
   * different strengths for the same reason.
   */
  setHovered(assignmentId: string | undefined): void {
    this.hoveredId = assignmentId;
    this.refreshHighlights();
  }

  /** How much of each desk plate to draw (FR-S10). Applies immediately. */
  setPlateDensity(density: PlateDensity): void {
    if (this.plateDensity === density) return;
    this.plateDensity = density;
    // Redraw from the characters already on screen rather than waiting for the
    // next scene push: on a finished run there is no next push, and a density
    // control that only takes effect when something else changes reads as
    // broken.
    for (const view of this.latestCharacters) {
      const state = this.characters.get(view.assignmentId);
      if (state !== undefined) this.syncPlate(state, view);
    }
  }

  /**
   * FR-S13 — the user's zoom preference. `'auto'` returns to the automatic
   * largest-integer-that-fits; an explicit level overrides it outright.
   *
   * Re-derives the viewport immediately from whatever container size the
   * last `resize` recorded, the same "apply from what's already known rather
   * than wait for the next push" shape `setPlateDensity` follows just above —
   * a zoom control that only took effect on the next window resize would
   * read as broken.
   */
  setZoom(preference: ZoomPreference): void {
    if (this.zoomPreference === preference) return;
    this.zoomPreference = preference;
    if (this.lastContainerWidth !== undefined && this.lastContainerHeight !== undefined) {
      this.applyViewport(this.lastContainerWidth, this.lastContainerHeight);
    }
  }

  /**
   * One place that decides what each character's ring looks like.
   *
   * Selection wins over hover when both point at the same character — the
   * stronger statement is the true one, and flickering between two ring
   * alphas as the pointer crosses the selected desk would be noise.
   */
  private refreshHighlights(): void {
    for (const [id, state] of this.characters) {
      const selected = id === this.selectedId;
      const hovered = id === this.hoveredId;
      state.selectionRing.visible = selected || hovered;
      state.selectionRing.alpha = selected ? 1 : HOVER_RING_ALPHA;
    }
  }

  /** Resizes to fill `width`×`height` CSS pixels of the HOST container and
   *  recomputes the letterbox/zoom. The actual `<canvas>` element's own size
   *  is decided inside `applyViewport` (FR-S13) — it is no longer always
   *  equal to the host's, see `ZoomedViewport`'s doc comment. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.lastContainerWidth = w;
    this.lastContainerHeight = h;

    if (this.app === undefined || !this.initialized) return; // recorded for once init finishes

    this.applyViewport(w, h);
  }

  private applyViewport(containerWidth: number, containerHeight: number): void {
    const worldWidthPx = this.latestLayout.widthTiles * TILE;
    const worldHeightPx = this.latestLayout.heightTiles * TILE;

    // The automatic best-fit scale still has to be computed even when an
    // explicit zoom overrides it — `'auto'` needs it to resolve to, and
    // `resolveZoom` needs SOME auto-fit figure to fall back on regardless of
    // preference, which is what it is given here.
    const autoFit = computeViewport(containerWidth, containerHeight, worldWidthPx, worldHeightPx);
    const scale = resolveZoom(this.zoomPreference, autoFit.scale);
    const zoomed = computeZoomedViewport(containerWidth, containerHeight, worldWidthPx, worldHeightPx, scale);
    this.viewport = { scale: zoomed.scale, offsetX: zoomed.offsetX, offsetY: zoomed.offsetY };

    // The canvas element itself, not just the world inside it: growing this
    // past the host's own box is what lets the host's `overflow: auto`
    // (styles.css) turn an explicit zoom that no longer fits into a real,
    // native scrollbar instead of silently cropping the office — see
    // `ZoomedViewport`'s doc comment for the reasoning in full.
    if (this.app !== undefined) {
      this.app.renderer.resize(zoomed.canvasWidthPx, zoomed.canvasHeightPx);
    }

    if (this.world !== undefined) {
      this.world.position.set(this.viewport.offsetX, this.viewport.offsetY);
      this.world.scale.set(this.viewport.scale, this.viewport.scale);
    }
    if (this.uiLayer !== undefined) {
      this.uiLayer.position.set(this.viewport.offsetX, this.viewport.offsetY);
    }
    // Re-fit before repositioning: how much a plate may say depends on
    // `viewport.scale`, which this method just recomputed. A window resize
    // that drops the office from 2x to 1x halves the room each plate has, and
    // without this the previous 2x text would stay on screen and overlap.
    for (const view of this.latestCharacters) {
      const state = this.characters.get(view.assignmentId);
      if (state !== undefined) this.syncPlate(state, view);
    }
    if (this.managerState !== undefined) this.syncManagerPlateText(this.managerState);
    this.repositionNameplates();

    // Only on an actual change — a resize that resolves to the same level as
    // last time (or a scene push that recomputes an unchanged viewport)
    // should not re-fire a callback that exists to drive a React state
    // update in `OfficeCanvas.tsx`.
    if (zoomed.scale !== this.lastReportedZoom) {
      this.lastReportedZoom = zoomed.scale;
      this.callbacks.onZoomChange?.(zoomed.scale);
    }
  }

  /**
   * Which assignment (if any) sits under a canvas-space point (FR-S5), e.g.
   * `clientX/Y - canvas.getBoundingClientRect().{left,top}`.
   */
  hitTestAt(canvasX: number, canvasY: number): string | undefined {
    const worldPoint = canvasToWorld({ x: canvasX, y: canvasY }, this.viewport);
    const entities: HitTestEntity[] = [];
    for (const [id, state] of this.characters) {
      const px = tileToPixel(state.currentPos);
      entities.push({
        assignmentId: id,
        x: px.x + TILE / 2,
        y: px.y + TILE,
        width: this.manifest.spriteWidth,
        height: this.manifest.spriteHeight,
      });
    }
    return hitTest(entities, worldPoint);
  }

  /** Tears down the canvas, listeners and GPU resources. Idempotent. */
  destroy(): void {
    // Whether `initApp` ever finished. In Pixi v8 `Application` is a bare shell
    // until `await app.init()` resolves — `app.ticker` and the renderer simply
    // do not exist before that — so tearing down an app that is still
    // initialising throws rather than cleaning up.
    //
    // React StrictMode makes this the *common* path, not an edge case: it
    // mounts, unmounts and remounts synchronously in development, so the
    // unmount always lands mid-`init`. The in-flight init is already orphaned
    // by the token bump below and destroys itself when it settles; this method
    // must simply not reach into the half-built app on the way past.
    const wasInitialised = this.initialized;

    this.destroyed = true;
    this.mountToken += 1; // orphans any in-flight `initApp`
    this.mounting = false;
    this.initialized = false;

    this.detachInteraction();
    this.detachVisibilityHandling();
    this.detachReducedMotionHandling();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;

    if (this.app !== undefined && wasInitialised) {
      this.app.ticker.remove(this.onTick);
      // `true` also removes the canvas element from the DOM; the texture/
      // textureSource flags cascade-destroy everything still attached to the
      // stage. Cached prop/frame textures are destroyed explicitly below
      // since some may have been created but never attached (e.g. a bubble
      // texture generated for a status no character currently shows).
      this.app.destroy(true, { children: true, texture: true, textureSource: true });
    }
    this.app = undefined;

    for (const texture of this.textureCache.values()) {
      if (!texture.destroyed) texture.destroy(true);
    }
    this.textureCache.clear();
    this.characters.clear();
    this.managerState = undefined;

    this.world = undefined;
    this.floorLayer = undefined;
    this.workGlowLayer = undefined;
    this.deskLayer = undefined;
    this.characterLayer = undefined;
    this.uiLayer = undefined;
    this.canvasEl = undefined;
  }

  // -- interaction -----------------------------------------------------------

  private attachInteraction(canvas: HTMLCanvasElement): void {
    this.pointerMoveHandler = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const id = this.hitTestAt(ev.clientX - rect.left, ev.clientY - rect.top);
      canvas.style.cursor = id !== undefined ? 'pointer' : 'default';
      if (id === this.lastHoverId) return;
      this.lastHoverId = id;
      this.callbacks.onHoverAssignment?.(id);
    };
    this.pointerLeaveHandler = () => {
      canvas.style.cursor = 'default';
      if (this.lastHoverId === undefined) return;
      this.lastHoverId = undefined;
      this.callbacks.onHoverAssignment?.(undefined);
    };
    this.clickHandler = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const id = this.hitTestAt(ev.clientX - rect.left, ev.clientY - rect.top);
      if (id !== undefined) this.callbacks.onSelectAssignment?.(id);
    };

    canvas.addEventListener('pointermove', this.pointerMoveHandler);
    canvas.addEventListener('pointerleave', this.pointerLeaveHandler);
    canvas.addEventListener('click', this.clickHandler);
  }

  private detachInteraction(): void {
    const canvas = this.canvasEl;
    if (canvas !== undefined) {
      if (this.pointerMoveHandler !== undefined) canvas.removeEventListener('pointermove', this.pointerMoveHandler);
      if (this.pointerLeaveHandler !== undefined) canvas.removeEventListener('pointerleave', this.pointerLeaveHandler);
      if (this.clickHandler !== undefined) canvas.removeEventListener('click', this.clickHandler);
    }
    this.pointerMoveHandler = undefined;
    this.pointerLeaveHandler = undefined;
    this.clickHandler = undefined;
    this.lastHoverId = undefined;
  }

  // -- FR-S7: pause when hidden, respect reduced motion -----------------------

  private attachVisibilityHandling(app: Application): void {
    this.visibilityHandler = () => {
      if (document.hidden) app.ticker.stop();
      else app.ticker.start();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    if (document.hidden) app.ticker.stop(); // the tab may already be hidden by the time mount finishes
  }

  private detachVisibilityHandling(): void {
    if (this.visibilityHandler !== undefined) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = undefined;
  }

  private attachReducedMotionHandling(): void {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.mediaQuery = mediaQuery;
    this.reducedMotion = mediaQuery.matches;
    this.mediaQueryHandler = () => {
      this.reducedMotion = mediaQuery.matches;
    };
    mediaQuery.addEventListener('change', this.mediaQueryHandler);
  }

  private detachReducedMotionHandling(): void {
    if (this.mediaQuery !== undefined && this.mediaQueryHandler !== undefined) {
      this.mediaQuery.removeEventListener('change', this.mediaQueryHandler);
    }
    this.mediaQuery = undefined;
    this.mediaQueryHandler = undefined;
  }

  // -- drawing -----------------------------------------------------------

  /**
   * Paints the room shell and every desk, chair and furnishing (FR-S1, FR-U3).
   *
   * Rebuilt whole on every scene push rather than diffed, exactly like
   * `rebuildWorkGlows` below: the layout only actually changes when the
   * agent count does, which is rare next to how often a scene updates, so
   * repainting a few hundred `rect().fill()` calls a handful of times a run
   * is cheaper than the bookkeeping needed to avoid it.
   */
  private rebuildFloorAndDesks(layout: OfficeLayout): void {
    if (this.floorLayer === undefined || this.deskLayer === undefined) return;

    for (const child of this.floorLayer.removeChildren()) child.destroy();
    for (const child of this.deskLayer.removeChildren()) child.destroy();

    this.paintRoomShell(layout);

    const rugTexture = this.getOrCreatePropTexture('rug');
    this.floorLayer.addChild(
      this.makePropSprite(rugTexture, { x: layout.managerDesk.desk.x, y: layout.managerDesk.approach.y }),
    );

    this.placeWallDecor(layout);

    const chairTexture = this.getOrCreatePropTexture('chair');

    const managerTexture = this.getOrCreatePropTexture('manager_desk');
    this.deskLayer.addChild(this.makePropSprite(managerTexture, layout.managerDesk.desk));
    // A chair behind every seated character, the Manager included — drawn on
    // the desk layer so a character (on the layer above) sits visually in
    // front of it rather than the chair painting over their legs.
    this.deskLayer.addChild(this.makePropSprite(chairTexture, layout.managerDesk.seat));

    const deskTexture = this.getOrCreatePropTexture('desk');
    for (const slot of layout.desks) {
      this.deskLayer.addChild(this.makePropSprite(deskTexture, slot.desk));
      this.deskLayer.addChild(this.makePropSprite(chairTexture, slot.seat));
    }
  }

  /**
   * The wall across `layout.wallRows` rows, its lit top band and skirting
   * line, and floorboards in a brick bond below it.
   *
   * `roomRowKind`/`floorBoardShade` above decide *which* tile gets which
   * treatment; this method only ever asks them and draws the answer, so the
   * geometry those two pin in `scene.test.ts` is guaranteed to be the same
   * geometry actually painted here.
   */
  private paintRoomShell(layout: OfficeLayout): void {
    if (this.floorLayer === undefined) return;

    const shell = new Graphics();
    for (let y = 0; y < layout.heightTiles; y += 1) {
      for (let x = 0; x < layout.widthTiles; x += 1) {
        if (roomRowKind(y, layout) === 'wall') {
          shell.rect(x * TILE, y * TILE, TILE, TILE).fill(WALL_COLOUR);
        } else {
          const shade = floorBoardShade(x, y, layout) === 'light' ? FLOOR_LIGHT : FLOOR_DARK;
          shell.rect(x * TILE, y * TILE, TILE, TILE).fill(shade);
        }
      }
    }

    const widthPx = layout.widthTiles * TILE;
    shell.rect(0, 0, widthPx, WALL_TOP_BAND_PX).fill(WALL_TOP_COLOUR);
    shell.rect(0, layout.wallRows * TILE - WALL_TRIM_PX, widthPx, WALL_TRIM_PX).fill(WALL_TRIM_COLOUR);

    // Board seams: a horizontal line under every row of boards, and a
    // vertical one wherever `floorBoardShade` actually changes — which,
    // thanks to the stagger, is not at the same column on every row. Reading
    // the shade back rather than re-deriving "is this a board edge"
    // separately keeps the seams and the shading unable to disagree with
    // each other.
    for (let y = layout.wallRows; y < layout.heightTiles; y += 1) {
      shell.rect(0, y * TILE + TILE - 1, widthPx, 1).fill(FLOOR_SEAM_COLOUR);
      for (let x = 1; x < layout.widthTiles; x += 1) {
        if (floorBoardShade(x, y, layout) !== floorBoardShade(x - 1, y, layout)) {
          shell.rect(x * TILE, y * TILE, 1, TILE).fill(FLOOR_SEAM_COLOUR);
        }
      }
    }

    this.floorLayer.addChild(shell);
  }

  /**
   * Wall decor and the lounge corner (FR-U3 — what makes the room read as a
   * workplace rather than a floor plan).
   *
   * Every placement is derived from `layout.widthTiles`/`heightTiles` and
   * checked against the Manager's desk footprint before it is used, rather
   * than hardcoded to fixed tiles: a 1-agent office is only 14 tiles wide
   * (`layoutOffice`'s own floor), and a fixed layout tuned for a full 4-column
   * room would either overlap the Manager's desk or run off the wall
   * entirely at that width. A narrow office simply carries less decor than a
   * wide one — the requirement is "never collide", not "always show everything".
   */
  private placeWallDecor(layout: OfficeLayout): void {
    if (this.deskLayer === undefined) return;

    const row = layout.wallRows - 1; // the wall's bottom row, flush with the floor line
    const margin = 2; // mirrors layoutOffice's own MARGIN: stay clear of the outer walls
    const centreX = layout.managerDesk.desk.x;
    const deskClearance = 2; // half the Manager's desk footprint either side, so decor never overlaps it

    const leftOfDesk = centreX - deskClearance;
    const rightOfDesk = centreX + deskClearance;

    // Clock and art flank the desk symmetrically. Both are small enough
    // (<=14px, under one tile) to fit even the narrowest office once the desk
    // itself fits, so they are the two pieces of decor placed unconditionally.
    if (leftOfDesk - 1 >= margin) {
      this.deskLayer.addChild(this.makePropSprite(this.getOrCreatePropTexture('wall_clock'), { x: leftOfDesk - 1, y: row }));
    }
    if (rightOfDesk + 1 <= layout.widthTiles - margin - 1) {
      this.deskLayer.addChild(this.makePropSprite(this.getOrCreatePropTexture('wall_art'), { x: rightOfDesk + 1, y: row }));
    }

    // Bookshelf and a plant go further out still, and only once the room is
    // wide enough that they land clear of the clock/art already placed.
    const bookshelfX = margin + 1;
    if (bookshelfX <= leftOfDesk - 3) {
      this.deskLayer.addChild(this.makePropSprite(this.getOrCreatePropTexture('bookshelf'), { x: bookshelfX, y: row }));
    }
    const wallPlantX = layout.widthTiles - margin - 2;
    if (wallPlantX >= rightOfDesk + 3) {
      this.deskLayer.addChild(this.makePropSprite(this.getOrCreatePropTexture('plant'), { x: wallPlantX, y: row }));
    }

    // The lounge corner used to be a single couch and plant placed here, in the
    // walking lane `layoutOffice` reserves past the last desk row. They are gone
    // rather than kept: `furnishSideAisles` below now runs furniture down both
    // sides for the room's whole depth and reaches this row too, so the two
    // placements landed one tile apart and rendered as a couch stacked on a
    // couch. Two rules owning one corner is how that happens; one rule owns it
    // now.
    this.furnishSideAisles(layout, margin, layout.heightTiles - 2);
  }

  /**
   * Furniture down the open floor either side of the desk grid.
   *
   * `layoutOffice` widens the room to a landscape aspect so the office fills
   * its pane instead of sitting in a letterbox (see `ROOM_ASPECT` in
   * `model.ts`), and the desks stay centred — so the width arrives as two open
   * aisles rather than as a bigger grid. The first version of the repaint left
   * those aisles bare, and a screenshot of the running office made the cost
   * obvious: a wide room, correctly filling the frame, that read as a warehouse
   * with a few desks in the middle of it. Empty floor is what the aspect change
   * *bought*; furniture is what makes it worth having.
   *
   * The pattern is a deterministic function of the tile, never random. Two
   * calls with the same layout must place the same furniture in the same
   * places, or the office would reshuffle itself on every scene push — several
   * times a second on a live run — and replay (NFR-7) would not reproduce the
   * room it is replaying.
   *
   * Aisle bounds come from the desks themselves rather than from arithmetic on
   * the room's centre, because `layoutOffice` centres each ROW independently: a
   * final row holding fewer desks than the others is narrower, and a rule
   * derived from the grid's nominal width would put a plant on a desk in
   * exactly the layouts where the grid is not a clean rectangle.
   */
  private furnishSideAisles(layout: OfficeLayout, margin: number, lastAisleRow: number): void {
    if (this.deskLayer === undefined || layout.desks.length === 0) return;

    const deskXs = layout.desks.map((d) => d.desk.x);
    // One tile of clearance past the outermost desk, plus one more so a plant
    // never crowds the character sitting at it.
    const gridLeft = Math.min(...deskXs) - 2;
    const gridRight = Math.max(...deskXs) + 2;

    const firstRow = layout.managerDesk.approach.y + 1;
    if (lastAisleRow < firstRow) return;

    // Alternating down each aisle, and offset between the two sides so the room
    // never looks mirrored — a symmetrical office reads as wallpaper.
    const leftColumn = margin + 1;
    const rightColumn = layout.widthTiles - margin - 2;

    for (let row = firstRow, i = 0; row <= lastAisleRow; row += 3, i += 1) {
      if (gridLeft >= leftColumn) {
        const prop: PropName = i % 2 === 0 ? 'plant' : 'couch';
        this.deskLayer.addChild(this.makePropSprite(this.getOrCreatePropTexture(prop), { x: leftColumn, y: row }));
      }
      if (gridRight <= rightColumn) {
        const prop: PropName = i % 2 === 0 ? 'couch' : 'plant';
        this.deskLayer.addChild(this.makePropSprite(this.getOrCreatePropTexture(prop), { x: rightColumn, y: row }));
      }
    }
  }

  private makePropSprite(texture: Texture, tile: Point): Sprite {
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    const px = tileToPixel(tile);
    sprite.position.set(px.x + TILE / 2, px.y + TILE);
    return sprite;
  }

  /**
   * The one new affordance this phase adds (FR-U3): a glow under every desk
   * whose character `isWorkGlowing`.
   *
   * Rebuilt from `scene.characters` on every `applyScene` call rather than
   * kept as incremental per-character state — exactly how `rebuildFloorAndDesks`
   * just above already treats the desks themselves. That keeps this method
   * total and stateless: there is nothing here to get out of sync, because
   * nothing here is remembered between calls.
   *
   * FR-U5: no animation loop reads or writes anything on this layer — the
   * glow is a flat fill, so it is motion-safe by construction rather than by
   * checking `reducedMotion` (that flag only matters to `onTick`, which never
   * touches `workGlowLayer`).
   */
  private rebuildWorkGlows(characters: readonly CharacterView[]): void {
    if (this.workGlowLayer === undefined) return;

    for (const child of this.workGlowLayer.removeChildren()) child.destroy();

    for (const view of characters) {
      if (!isWorkGlowing(view.behaviour)) continue;

      const px = tileToPixel(view.home.desk);
      const glow = new Graphics();
      glow
        .ellipse(px.x + TILE / 2, px.y + TILE, TILE * 0.6, TILE * 0.3)
        .fill({ color: WORK_GLOW_COLOUR, alpha: WORK_GLOW_ALPHA });
      this.workGlowLayer.addChild(glow);
    }
  }

  private syncCharacters(characters: readonly CharacterView[]): void {
    if (this.characterLayer === undefined || this.uiLayer === undefined) return;

    const seen = new Set<string>();
    for (const view of characters) {
      seen.add(view.assignmentId);
      let state = this.characters.get(view.assignmentId);
      if (state === undefined) {
        state = this.createCharacterState(view);
        this.characters.set(view.assignmentId, state);
      }

      state.target = view.target;
      // The tool-refined animation (FR-S11), not `behaviour.animation`.
      state.animation = view.animation;
      state.appearance = view.appearance;
      state.plateAnchorTile = view.home.seat;
      state.homeSeat = view.home.seat;

      // The errand (see the section above `frameTextureKey`): started or kept
      // running from `view.behaviour.location` regardless of what `target`
      // above was just set to, abandoned outright if this assignment just
      // resolved to `failed`/`cancelled` while mid-errand, and never started
      // at all under reduced motion.
      state.errand = shouldAbandonErrand(view.status)
        ? undefined
        : nextErrand(state.errand, view.behaviour.location, this.latestLayout.managerDesk.approach, this.reducedMotion);

      this.syncPlate(state, view);

      state.bubbleSprite.visible = view.behaviour.bubble !== 'none';
      if (view.behaviour.bubble !== 'none') {
        state.bubbleSprite.texture = this.getOrCreatePropTexture(bubblePropFor(view.behaviour.bubble));
      }
      state.paperSprite.visible = view.behaviour.carrying;
    }

    for (const [id, state] of this.characters) {
      if (seen.has(id)) continue;
      state.root.destroy({ children: true });
      // `{ children: true }` — the plate owns the name line and every detail
      // line, so destroying it destroys them. Before the plate existed this
      // destroyed the single `nameplate` directly; leaving that call in place
      // would have leaked one `Text` per detail line per finished run.
      state.plate.destroy({ children: true });
      this.characters.delete(id);
    }

    this.repositionNameplates();
  }

  private createCharacterState(view: CharacterView): CharacterRenderState {
    const bodySprite = new Sprite();
    bodySprite.anchor.set(0.5, 1);

    const bubbleSprite = new Sprite();
    bubbleSprite.anchor.set(0.5, 1);
    bubbleSprite.position.set(0, -this.manifest.spriteHeight - 2);
    bubbleSprite.visible = false;

    const paperSprite = new Sprite(this.getOrCreatePropTexture('paper'));
    paperSprite.anchor.set(0.5, 1);
    paperSprite.position.set(this.manifest.spriteWidth * 0.6, -this.manifest.spriteHeight * 0.5);
    paperSprite.visible = false;

    const selectionRing = new Graphics();
    selectionRing.ellipse(0, -1, this.manifest.spriteWidth * 0.6, 3).fill({ color: SELECTION_RING_COLOUR, alpha: 0.85 });
    selectionRing.visible = view.assignmentId === this.selectedId;

    const root = new Container();
    root.addChild(selectionRing, bodySprite, bubbleSprite, paperSprite);
    this.characterLayer?.addChild(root);

    const nameplate = new Text({
      text: view.agentName,
      anchor: { x: 0.5, y: 0 },
      style: { fill: NAMEPLATE_COLOUR, fontFamily: 'monospace', fontSize: PLATE_NAME_SIZE },
    });

    // The backing panel behind the plate's lines (FR-S10's legibility fix),
    // added FIRST so it is drawn first — i.e. behind — every line the
    // container ever gains, including detail lines `syncPlate` appends later.
    const plateBackground = new Graphics();

    // One container per plate rather than positioning each line against the
    // desk independently: the plate moves as a unit when the viewport rescales,
    // and `repositionNameplates` stays a single write per character however
    // many lines the density asks for.
    const plate = new Container();
    plate.addChild(plateBackground, nameplate);
    this.uiLayer?.addChild(plate);

    return {
      root,
      bodySprite,
      bubbleSprite,
      paperSprite,
      selectionRing,
      plate,
      nameplate,
      plateBackground,
      detailLines: [],
      currentPos: { ...view.home.seat },
      target: { ...view.target },
      facing: 'down',
      animation: view.animation,
      appearance: view.appearance,
      plateAnchorTile: { ...view.home.seat },
      homeSeat: { ...view.home.seat },
      errand: undefined,
      frameIndex: 0,
      frameElapsedMs: 0,
      lastTextureKey: undefined,
    };
  }

  /**
   * The Manager's render state, created once and updated thereafter — never
   * torn down and recreated the way a character's is, because `scene.manager`
   * is always present (see its doc comment in `model.ts`): there is no
   * "Manager left the scene" case for `syncManager` to detect and clean up
   * after, so this is simpler as an update-only method with lazy creation.
   */
  private createManagerState(view: ManagerView): ManagerRenderState {
    const bodySprite = new Sprite();
    bodySprite.anchor.set(0.5, 1);

    const root = new Container();
    root.addChild(bodySprite);
    this.characterLayer?.addChild(root);

    const nameplate = new Text({
      text: view.name,
      anchor: { x: 0.5, y: 0 },
      style: { fill: NAMEPLATE_COLOUR, fontFamily: 'monospace', fontSize: PLATE_NAME_SIZE },
    });

    const plateBackground = new Graphics();
    const plate = new Container();
    plate.addChild(plateBackground, nameplate);
    this.uiLayer?.addChild(plate);

    return {
      root,
      bodySprite,
      plate,
      nameplate,
      plateBackground,
      name: view.name,
      seat: { ...view.seat },
      animation: view.animation,
      appearance: view.appearance,
      frameIndex: 0,
      frameElapsedMs: 0,
      lastTextureKey: undefined,
    };
  }

  /**
   * Brings the Manager's render state into line with `scene.manager` (FR-S14).
   *
   * Position, unlike a character's, is set here directly rather than through
   * `onTick`'s walk interpolation — the Manager never walks, so there is no
   * `currentPos` to converge on a target, only a fixed seat to sit at.
   */
  private syncManager(view: ManagerView): void {
    if (this.characterLayer === undefined || this.uiLayer === undefined) return;

    let state = this.managerState;
    if (state === undefined) {
      state = this.createManagerState(view);
      this.managerState = state;
    }

    state.animation = view.animation;
    state.appearance = view.appearance;
    state.seat = { ...view.seat };
    state.name = view.name;

    const px = tileToPixel(view.seat);
    state.root.position.set(px.x + TILE / 2, px.y + TILE);

    this.syncManagerPlateText(state);
  }

  /** The Manager's plate has exactly one line — its name — but still goes
   *  through `fitPlateLines` so it gets the same narrow-viewport truncation
   *  every character's name line does, rather than a second, unfitted path. */
  private syncManagerPlateText(state: ManagerRenderState): void {
    const [name = state.name] = fitPlateLines([state.name], this.plateBox());
    if (state.nameplate.text !== name) state.nameplate.text = name;
    this.paintPlateBackground(state.plateBackground, [state.nameplate]);
  }

  /**
   * Bring one character's plate into line with its view (FR-S10).
   *
   * `plateLines` decides the words — the same function the office's
   * screen-reader alternative calls, so the two cannot describe the same desk
   * differently. This method only decides how many `Text` objects exist and
   * what they say.
   *
   * Lines are pooled rather than recreated: a plate updates on every scene
   * push, several times a second on a live run, and destroying and rebuilding
   * three `Text` objects at that rate churns GPU texture uploads for text that
   * usually has not changed. Surplus lines are hidden rather than destroyed
   * for the same reason — a density toggle should not cost a reallocation.
   */
  /**
   * The screen-pixel box one plate may occupy, derived from the live viewport.
   *
   * Plates render in the UNSCALED `uiLayer`, so their font size is fixed while
   * the gaps between desks are not: a column gap is `DESK_SPACING_X` tiles of
   * *world* space, which is `× viewport.scale` on screen. At 2x there is room
   * for a full plate; at 1x — the fallback for a three-row team — there is
   * half as much, and an untrimmed plate runs across its neighbours. This is
   * what `fitPlateLines` is given.
   *
   * A margin is held back on each axis so two adjacent plates that both fill
   * their box still have a visible gutter between them rather than meeting.
   */
  private plateBox(): PlateBox {
    const scale = this.viewport.scale;
    return {
      widthPx: Math.max(1, DESK_SPACING_TILES_X * TILE * scale - PLATE_GUTTER_PX),
      heightPx: Math.max(1, DESK_SPACING_TILES_Y * TILE * scale - PLATE_VERTICAL_MARGIN_PX),
      nameSizePx: PLATE_NAME_SIZE,
      detailSizePx: PLATE_DETAIL_SIZE,
      lineHeightPx: PLATE_LINE_HEIGHT,
    };
  }

  private syncPlate(state: CharacterRenderState, view: CharacterView): void {
    const [name = view.agentName, ...details] = fitPlateLines(
      plateLines(view, this.plateDensity),
      this.plateBox(),
    );

    if (state.nameplate.text !== name) state.nameplate.text = name;

    for (let i = 0; i < details.length; i += 1) {
      let line = state.detailLines[i];
      if (line === undefined) {
        line = new Text({
          anchor: { x: 0.5, y: 0 },
          style: { fill: PLATE_DETAIL_COLOUR, fontFamily: 'monospace', fontSize: PLATE_DETAIL_SIZE },
        });
        state.detailLines.push(line);
        state.plate.addChild(line);
      }
      const text = details[i] ?? '';
      if (line.text !== text) line.text = text;
      line.visible = true;
      line.position.set(0, PLATE_LINE_HEIGHT * (i + 1));
    }

    for (let i = details.length; i < state.detailLines.length; i += 1) {
      const line = state.detailLines[i];
      if (line !== undefined) line.visible = false;
    }

    this.paintPlateBackground(state.plateBackground, [state.nameplate, ...state.detailLines]);
  }

  /**
   * Draws the opaque backing panel behind a plate's lines (FR-S10's
   * legibility fix — see `PLATE_PANEL_ALPHA`'s comment for why it must stay
   * fully opaque). Shared between characters and the Manager, both of which
   * print through the same kind of panel, sized to whichever lines are
   * actually visible right now rather than to a worst case — a `minimal`
   * character plate or the Manager's own name-only plate gets a small panel,
   * a `verbose` one gets a taller one.
   */
  private paintPlateBackground(background: Graphics, lines: readonly Text[]): void {
    const visible = lines.filter((line) => line.visible);
    const contentWidth = visible.reduce((max, line) => Math.max(max, line.width), 0);
    const panelWidth = contentWidth + PLATE_PANEL_PADDING_X * 2;
    const contentHeight =
      visible.length <= 1 ? PLATE_NAME_SIZE : PLATE_LINE_HEIGHT * (visible.length - 1) + PLATE_DETAIL_SIZE;
    const panelHeight = contentHeight + PLATE_PANEL_PADDING_Y * 2;

    background.clear();
    background
      .rect(-panelWidth / 2, -PLATE_PANEL_PADDING_Y, panelWidth, panelHeight)
      .fill({ color: PLATE_BG_COLOUR, alpha: PLATE_PANEL_ALPHA })
      .stroke({ width: 1, color: PLATE_EDGE_COLOUR, alpha: PLATE_PANEL_ALPHA });
  }

  private repositionNameplates(): void {
    for (const state of this.characters.values()) {
      this.positionPlateBelowSeat(state.plate, state.plateAnchorTile);
    }
    if (this.managerState !== undefined) this.positionPlateBelowSeat(this.managerState.plate, this.managerState.seat);
  }

  private positionPlateBelowSeat(plate: Container, seatTile: Point): void {
    const seatPx = tileToPixel(seatTile);
    plate.position.set(
      (seatPx.x + TILE / 2) * this.viewport.scale,
      // Immediately below the character's feet, which sit at the seat tile's
      // bottom edge — so `+ TILE` is the first row clear of the sprite.
      //
      // It was `+ TILE * 2`, chosen to leave a verbose four-line plate room to
      // grow, and a screenshot of the running office showed what that costs:
      // rows are `DESK_SPACING_Y` (4) tiles apart, so a plate two tiles below
      // its own seat lands almost exactly HALFWAY between its character and the
      // next row's, and reads as labelling whichever one the eye reaches first.
      // With five agents on screen the first row's plates sat directly above
      // the second row's characters — pointing at the wrong desks entirely.
      //
      // Proximity is what assigns a label to a thing, so the plate is pinned to
      // its own character and the vertical budget gives way instead:
      // `fitPlateLines` already drops detail lines that will not fit, which is
      // the honest trade. A plate that says less about the right agent beats one
      // that says everything about the wrong one.
      (seatPx.y + TILE + NAMEPLATE_GAP_PX) * this.viewport.scale,
    );
  }

  private getOrCreateFrameTexture(
    appearance: AgentAppearance,
    animation: SpriteAnimation,
    frame: number,
    facing: Facing,
    seated: boolean,
  ): Texture {
    const key = frameTextureKey(appearance, animation, frame, facing, seated);
    const cached = this.textureCache.get(key);
    if (cached !== undefined) return cached;
    const texture = pixelGridToTexture(this.manifest.frame({ appearance, animation, frame, facing, seated }));
    this.textureCache.set(key, texture);
    return texture;
  }

  private getOrCreatePropTexture(name: PropName): Texture {
    const key = `prop:${name}`;
    const cached = this.textureCache.get(key);
    if (cached !== undefined) return cached;
    const texture = pixelGridToTexture(this.manifest.prop(name));
    this.textureCache.set(key, texture);
    return texture;
  }

  /** Advances one render state's animation-frame counter, respecting FR-U5
   *  (reduced motion holds every character on its first frame rather than
   *  animating a loop the setting asked not to be shown). Shared between
   *  characters and the Manager, whose animation loop is driven exactly the
   *  same way once its lack of a walk cycle is accounted for by the caller. */
  private advanceFrame(frameIndex: number, frameElapsedMs: number, deltaMs: number): AnimationFrameState {
    if (this.reducedMotion) return { frameIndex: 0, elapsedMs: 0 };
    return nextAnimationFrame(frameIndex, this.manifest.framesPerAnimation, frameElapsedMs, deltaMs);
  }

  // -- the render loop -----------------------------------------------------

  private readonly onTick = (ticker: Ticker): void => {
    const dtSeconds = ticker.deltaMS / 1000;

    for (const state of this.characters.values()) {
      const previous = state.currentPos;
      // While an errand is active it overrides `target` — that is the whole
      // point of it (see the errand section above `frameTextureKey`): the
      // character keeps walking to (and dwelling at) the Manager even though
      // `view.target`, and therefore `state.target`, may already have flipped
      // back to the desk by the time this tick runs.
      const effectiveTarget = state.errand !== undefined ? state.errand.destination : state.target;

      state.facing = arrivalAwareFacing(previous, effectiveTarget, state.facing, state.homeSeat);
      state.currentPos = this.reducedMotion ? { ...effectiveTarget } : stepTowards(previous, effectiveTarget, dtSeconds);

      if (state.errand !== undefined && !this.reducedMotion) {
        state.errand = advanceErrand(state.errand, state.currentPos, ticker.deltaMS);
      }

      const px = tileToPixel(state.currentPos);
      state.root.position.set(px.x + TILE / 2, px.y + TILE);

      const next = this.advanceFrame(state.frameIndex, state.frameElapsedMs, ticker.deltaMS);
      state.frameIndex = next.frameIndex;
      state.frameElapsedMs = next.elapsedMs;

      // Geometry, not status (FR-S3) — seated is true exactly when the
      // character has actually reached its own desk, errand or no errand.
      const seated = isSeatedAt(state.currentPos, state.homeSeat);

      const key = frameTextureKey(state.appearance, state.animation, state.frameIndex, state.facing, seated);
      if (key !== state.lastTextureKey) {
        state.bodySprite.texture = this.getOrCreateFrameTexture(
          state.appearance,
          state.animation,
          state.frameIndex,
          state.facing,
          seated,
        );
        state.lastTextureKey = key;
      }
    }

    const manager = this.managerState;
    if (manager !== undefined) {
      const next = this.advanceFrame(manager.frameIndex, manager.frameElapsedMs, ticker.deltaMS);
      manager.frameIndex = next.frameIndex;
      manager.frameElapsedMs = next.elapsedMs;

      // The Manager never walks and never leaves its seat, so neither
      // `facing` nor `seated` is derived from geometry the way a character's
      // is — both are fixed: seated, and facing 'down' into the room rather
      // than 'up' at a desk, since the room is what the Manager is facing.
      const key = frameTextureKey(manager.appearance, manager.animation, manager.frameIndex, 'down', true);
      if (key !== manager.lastTextureKey) {
        manager.bodySprite.texture = this.getOrCreateFrameTexture(
          manager.appearance,
          manager.animation,
          manager.frameIndex,
          'down',
          true,
        );
        manager.lastTextureKey = key;
      }
    }
  };
}

/** Convenience factory — reads a little more like the task at hand than `new`. */
export function createOfficeScene(manifest: SpriteManifest, callbacks: OfficeSceneCallbacks = {}): OfficeSceneRenderer {
  return new OfficeSceneRenderer(manifest, callbacks);
}

// Re-exported so callers (and tests) needing the desk-slot shape don't have
// to reach into `model.ts` themselves just to describe a fixture.
export type { DeskSlot };
