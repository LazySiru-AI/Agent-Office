import type { PixelGrid } from './spriteContract.js';

/**
 * The drawing primitives every generated sprite and prop is built from.
 *
 * Extracted in Phase 10, when props stopped being six small shapes appended to
 * the bottom of `sprites.ts` and became a room's worth of furniture. The two
 * concerns had already diverged in everything but file location: a character is
 * a function of an `AgentAppearance` and an animation frame, a prop is a
 * constant; a character must fit the `SPRITE_WIDTH × SPRITE_HEIGHT` box, a
 * bookshelf must not. What they genuinely share is this — how to put a pixel
 * somewhere without falling off the edge.
 *
 * Every write here is bounds-checked, and that is what makes the generators
 * above total in the way `spriteContract.ts` promises. A pose that pushes a
 * pixel one row past the sprite (a slumped head, an extended stride, a hair
 * style that overhangs the skull) is silently clipped rather than throwing
 * inside a renderer's frame loop or quietly resizing a row and returning a
 * ragged grid.
 */

/**
 * A mutable working copy of {@link PixelGrid}.
 *
 * The contract's readonly arrays are a view for consumers; generation is far
 * simpler as plain arrays, and a `(string | null)[][]` is assignable to
 * `PixelGrid` without a cast because readonly-ness only restricts the type, not
 * the underlying value.
 */
export type MutableGrid = (string | null)[][];

/** A transparent grid. `null` cells stay genuinely transparent when uploaded. */
export function createGrid(width: number, height: number): MutableGrid {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  return Array.from({ length: h }, () => new Array<string | null>(w).fill(null));
}

function widthOf(grid: MutableGrid): number {
  return grid[0]?.length ?? 0;
}

export function setPixel(grid: MutableGrid, x: number, y: number, colour: string): void {
  if (y < 0 || y >= grid.length) return;
  const row = grid[y];
  if (row === undefined) return;
  if (x < 0 || x >= row.length) return;
  row[x] = colour;
}

export function clearPixel(grid: MutableGrid, x: number, y: number): void {
  if (y < 0 || y >= grid.length) return;
  const row = grid[y];
  if (row === undefined) return;
  if (x < 0 || x >= row.length) return;
  row[x] = null;
}

export function fillRect(
  grid: MutableGrid,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colour: string,
): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      setPixel(grid, x, y, colour);
    }
  }
}

/**
 * A one-pixel border drawn *around* the given rectangle, the way the reference
 * art outlines every object.
 *
 * Outlining is what separates furniture from the floor it stands on without
 * relying on the two being different brightnesses — which matters now that the
 * office has a warm floor and warm furniture on top of it.
 */
export function outlineRect(
  grid: MutableGrid,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colour: string,
): void {
  for (let x = x0; x < x0 + w; x += 1) {
    setPixel(grid, x, y0 - 1, colour);
    setPixel(grid, x, y0 + h, colour);
  }
  for (let y = y0 - 1; y <= y0 + h; y += 1) {
    setPixel(grid, x0 - 1, y, colour);
    setPixel(grid, x0 + w, y, colour);
  }
}

/**
 * Wraps into `[0, size)`, including for negative and non-finite input.
 *
 * This is the totality guarantee the contract asks for on `frame`: a renderer
 * running a loop that overshoots (or a replay seeking to a frame before an
 * animation existed) gets a valid still frame instead of an exception.
 */
export function wrap(n: number, size: number): number {
  if (size <= 0) return 0;
  if (!Number.isFinite(n)) return 0;
  const m = Math.floor(n) % size;
  return m < 0 ? m + size : m;
}

/** Horizontal mirror. `left` and `right` facings are one pose and its reflection. */
export function mirrorGrid(grid: MutableGrid): MutableGrid {
  return grid.map((row) => [...row].reverse());
}

/** Every row the same length, and at least one row — the prop contract's shape rule. */
export function isRectangular(grid: PixelGrid): boolean {
  if (grid.length === 0) return false;
  const width = grid[0]?.length ?? 0;
  if (width === 0) return false;
  return grid.every((row) => row.length === width);
}

export { widthOf };
