import { Application, Container, Graphics, Sprite, Text, Texture, type Ticker } from 'pixi.js';
import {
  layoutOffice,
  TILE,
  type AgentAppearance,
  type CharacterView,
  type DeskSlot,
  type OfficeLayout,
  type OfficeScene,
  type Point,
} from './model.js';
import type { Facing, PixelGrid, PropName, SpriteAnimation, SpriteManifest } from './spriteContract.js';
import { OFFICE, toPixiColour } from '../theme/tokens.js';

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
 * Reads `behaviour.animation` — the same field `syncCharacters` already uses
 * to pick the body sprite — rather than comparing `status === 'working'`
 * separately. `ASSIGNMENT_BEHAVIOUR` in `@agent-office/shared` is the single
 * place status maps to what's on screen (FR-S3); a second comparison here
 * would be a second source that could quietly drift from the first if the
 * behaviour table ever changed. No new state is introduced — this is a pure
 * read of a `CharacterView` the scene already has.
 */
export function isWorkGlowing(behaviour: CharacterView['behaviour']): boolean {
  return behaviour.animation === 'type';
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

function frameTextureKey(appearance: AgentAppearance, animation: SpriteAnimation, frame: number, facing: Facing): string {
  return `${appearanceKey(appearance)}|${animation}|${String(frame)}|${facing}`;
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
}

/** Everything the renderer keeps about one on-screen character between frames. */
interface CharacterRenderState {
  root: Container;
  bodySprite: Sprite;
  bubbleSprite: Sprite;
  paperSprite: Sprite;
  selectionRing: Graphics;
  nameplate: Text;
  /** Tile-space, floating-point — this is the walk-interpolation state (FR-S6). */
  currentPos: Point;
  target: Point;
  facing: Facing;
  animation: SpriteAnimation;
  appearance: AgentAppearance;
  /** Static desk tile the nameplate is pinned under; does not move when the character walks. */
  homeDeskTile: Point;
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
const BACKGROUND_COLOUR = toPixiColour(OFFICE.background);
const NAMEPLATE_GAP_PX = 2;
const NAMEPLATE_COLOUR = toPixiColour(OFFICE.nameplate);
const SELECTION_RING_COLOUR = toPixiColour(OFFICE.selection);
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

  private latestLayout: OfficeLayout = layoutOffice(0);
  private pendingScene: OfficeScene | undefined;
  private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  private lastContainerWidth: number | undefined;
  private lastContainerHeight: number | undefined;
  private selectedId: string | undefined;
  private lastHoverId: string | undefined;

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
    this.rebuildFloorAndDesks(scene.layout);
    this.syncCharacters(scene.characters);
    this.rebuildWorkGlows(scene.characters);
    if (this.lastContainerWidth !== undefined && this.lastContainerHeight !== undefined) {
      this.applyViewport(this.lastContainerWidth, this.lastContainerHeight);
    }
  }

  /** Marks one assignment's character as selected (or none, for `undefined`). */
  setSelected(assignmentId: string | undefined): void {
    this.selectedId = assignmentId;
    for (const [id, state] of this.characters) {
      state.selectionRing.visible = id === assignmentId;
    }
  }

  /** Resizes the canvas to fill `width`×`height` CSS pixels and recomputes the letterbox. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.lastContainerWidth = w;
    this.lastContainerHeight = h;

    if (this.app === undefined || !this.initialized) return; // recorded for once init finishes

    this.app.renderer.resize(w, h);
    this.applyViewport(w, h);
  }

  private applyViewport(containerWidth: number, containerHeight: number): void {
    const worldWidthPx = this.latestLayout.widthTiles * TILE;
    const worldHeightPx = this.latestLayout.heightTiles * TILE;
    this.viewport = computeViewport(containerWidth, containerHeight, worldWidthPx, worldHeightPx);

    if (this.world !== undefined) {
      this.world.position.set(this.viewport.offsetX, this.viewport.offsetY);
      this.world.scale.set(this.viewport.scale, this.viewport.scale);
    }
    if (this.uiLayer !== undefined) {
      this.uiLayer.position.set(this.viewport.offsetX, this.viewport.offsetY);
    }
    this.repositionNameplates();
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

  private rebuildFloorAndDesks(layout: OfficeLayout): void {
    if (this.floorLayer === undefined || this.deskLayer === undefined) return;

    for (const child of this.floorLayer.removeChildren()) child.destroy();
    for (const child of this.deskLayer.removeChildren()) child.destroy();

    const floor = new Graphics();
    for (let y = 0; y < layout.heightTiles; y += 1) {
      for (let x = 0; x < layout.widthTiles; x += 1) {
        const shade = (x + y) % 2 === 0 ? FLOOR_LIGHT : FLOOR_DARK;
        floor.rect(x * TILE, y * TILE, TILE, TILE).fill(shade);
      }
    }
    this.floorLayer.addChild(floor);

    const managerTexture = this.getOrCreatePropTexture('manager_desk');
    this.deskLayer.addChild(this.makePropSprite(managerTexture, layout.managerDesk.desk));

    const deskTexture = this.getOrCreatePropTexture('desk');
    for (const slot of layout.desks) {
      this.deskLayer.addChild(this.makePropSprite(deskTexture, slot.desk));
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
      state.animation = view.behaviour.animation;
      state.appearance = view.appearance;
      state.homeDeskTile = view.home.desk;

      if (state.nameplate.text !== view.agentName) state.nameplate.text = view.agentName;

      state.bubbleSprite.visible = view.behaviour.bubble !== 'none';
      if (view.behaviour.bubble !== 'none') {
        state.bubbleSprite.texture = this.getOrCreatePropTexture(bubblePropFor(view.behaviour.bubble));
      }
      state.paperSprite.visible = view.behaviour.carrying;
    }

    for (const [id, state] of this.characters) {
      if (seen.has(id)) continue;
      state.root.destroy({ children: true });
      state.nameplate.destroy();
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
      style: { fill: NAMEPLATE_COLOUR, fontFamily: 'monospace', fontSize: 10 },
    });
    this.uiLayer?.addChild(nameplate);

    return {
      root,
      bodySprite,
      bubbleSprite,
      paperSprite,
      selectionRing,
      nameplate,
      currentPos: { ...view.home.seat },
      target: { ...view.target },
      facing: 'down',
      animation: view.behaviour.animation,
      appearance: view.appearance,
      homeDeskTile: { ...view.home.desk },
      frameIndex: 0,
      frameElapsedMs: 0,
      lastTextureKey: undefined,
    };
  }

  private repositionNameplates(): void {
    for (const state of this.characters.values()) {
      const deskPx = tileToPixel(state.homeDeskTile);
      state.nameplate.position.set(
        (deskPx.x + TILE / 2) * this.viewport.scale,
        (deskPx.y + TILE + NAMEPLATE_GAP_PX) * this.viewport.scale,
      );
    }
  }

  private getOrCreateFrameTexture(appearance: AgentAppearance, animation: SpriteAnimation, frame: number, facing: Facing): Texture {
    const key = frameTextureKey(appearance, animation, frame, facing);
    const cached = this.textureCache.get(key);
    if (cached !== undefined) return cached;
    const texture = pixelGridToTexture(this.manifest.frame({ appearance, animation, frame, facing }));
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

  // -- the render loop -----------------------------------------------------

  private readonly onTick = (ticker: Ticker): void => {
    const dtSeconds = ticker.deltaMS / 1000;

    for (const state of this.characters.values()) {
      const previous = state.currentPos;
      state.facing = resolveFacing(previous, state.target, state.facing);
      state.currentPos = this.reducedMotion ? { ...state.target } : stepTowards(previous, state.target, dtSeconds);

      const px = tileToPixel(state.currentPos);
      state.root.position.set(px.x + TILE / 2, px.y + TILE);

      if (this.reducedMotion) {
        state.frameIndex = 0;
        state.frameElapsedMs = 0;
      } else {
        const next = nextAnimationFrame(state.frameIndex, this.manifest.framesPerAnimation, state.frameElapsedMs, ticker.deltaMS);
        state.frameIndex = next.frameIndex;
        state.frameElapsedMs = next.elapsedMs;
      }

      const key = frameTextureKey(state.appearance, state.animation, state.frameIndex, state.facing);
      if (key !== state.lastTextureKey) {
        state.bodySprite.texture = this.getOrCreateFrameTexture(state.appearance, state.animation, state.frameIndex, state.facing);
        state.lastTextureKey = key;
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
