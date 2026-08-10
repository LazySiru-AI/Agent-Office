import {
  ASSIGNMENT_BEHAVIOUR,
  type AssignmentState,
  type AssignmentStatus,
  type CharacterBehaviour,
  type RunState,
} from '@agent-office/shared';

/**
 * The office as data (PLAN.md §1.2, FR-S1–FR-S3).
 *
 * Every visual property of the sim is derived here, as a pure function of
 * orchestrator state. Nothing in this file imports Pixi, React or the DOM, and
 * that is the point: the renderer owns no status of its own, so "what the
 * office shows" cannot drift from "what is actually running". If a character is
 * typing, it is because an assignment is `working` — not because an animation
 * decided to keep playing.
 *
 * The practical consequence is that the whole sim is testable without a canvas,
 * and that replay (NFR-7) needs no separate code path: feed reconstructed run
 * state through the same functions and the office is whatever it was then.
 */

/** Pixels per tile at 1× scale. Everything below is in tile units, not pixels. */
export const TILE = 16;

export interface Point {
  x: number;
  y: number;
}

export interface DeskSlot {
  /** Tile the desk sprite occupies. */
  desk: Point;
  /** Tile the character occupies while seated. */
  seat: Point;
  /** Tile the character stands on to hand something over. */
  approach: Point;
}

export interface OfficeLayout {
  widthTiles: number;
  heightTiles: number;
  columns: number;
  rows: number;
  managerDesk: DeskSlot;
  /** One slot per assignment, index-aligned with the run's assignment order. */
  desks: DeskSlot[];
}

/** Tiles of margin around the desk grid, leaving room to walk. */
const MARGIN = 2;
/** Desks are spaced two tiles apart so characters never overlap while walking. */
const DESK_SPACING_X = 4;
const DESK_SPACING_Y = 4;
/** Rows the Manager's desk and its walking lane consume at the top. */
const MANAGER_BAND = 5;

/**
 * Desk grid that reflows for 1–12 agents (FR-S1).
 *
 * Columns grow to at most four before rows do. A single long row reads as a
 * queue rather than an office, and past four columns the walk from the far desk
 * to the Manager crosses the whole floor and dominates the animation — so the
 * cap is about how the sim reads, not about arithmetic.
 *
 * Counts beyond 12 still lay out correctly; they simply keep adding rows, which
 * is the honest degradation for a plan whose concurrency cap defaults to 3.
 */
export function layoutOffice(agentCount: number): OfficeLayout {
  const count = Math.max(0, Math.floor(agentCount));
  const columns = count === 0 ? 1 : Math.min(4, Math.ceil(Math.sqrt(count)));
  const rows = count === 0 ? 0 : Math.ceil(count / columns);

  const gridWidth = Math.max(columns, 1) * DESK_SPACING_X;
  const widthTiles = Math.max(gridWidth + MARGIN * 2, 14);
  const heightTiles = MANAGER_BAND + rows * DESK_SPACING_Y + MARGIN;

  const centreX = Math.floor(widthTiles / 2);
  const managerDesk: DeskSlot = {
    desk: { x: centreX, y: 1 },
    seat: { x: centreX, y: 2 },
    // Directly below the Manager's seat: where an agent stands to report.
    approach: { x: centreX, y: 3 },
  };

  const desks: DeskSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    // Centre each row's block of desks rather than left-aligning it, so a row
    // holding fewer desks than `columns` (the last one, usually) still sits
    // under the Manager instead of drifting to one side.
    const inThisRow = Math.min(columns, count - row * columns);
    const rowWidth = inThisRow * DESK_SPACING_X;
    const startX = centreX - Math.floor(rowWidth / 2) + Math.floor(DESK_SPACING_X / 2);

    const x = startX + column * DESK_SPACING_X;
    const y = MANAGER_BAND + row * DESK_SPACING_Y;

    desks.push({
      desk: { x, y },
      seat: { x, y: y + 1 },
      approach: { x, y: y + 2 },
    });
  }

  return { widthTiles, heightTiles, columns, rows, managerDesk, desks };
}

/**
 * A character's look, derived from its agent's name alone (FR-S2).
 *
 * Same agent, same appearance, in every run and after any restart — which is
 * what makes the office readable across runs rather than a fresh puzzle each
 * time. Deriving from the name rather than assigning at random is the whole
 * requirement; there is deliberately no seed and no persistence.
 */
export interface AgentAppearance {
  /** Index into the sprite manifest's body variants. */
  body: number;
  hairStyle: number;
  skin: string;
  hair: string;
  shirt: string;
  trousers: string;
}

/**
 * Palettes kept small and deliberately low-saturation, so status colour — the
 * one thing the user must read at a glance — is never competing with a shirt.
 */
export const SKIN_TONES = ['#f0c9a4', '#dda57c', '#b57c53', '#8d5a3b', '#6b4227'] as const;
export const HAIR_COLOURS = ['#2b2118', '#5a3a22', '#8a5a2b', '#c9a227', '#9a9a9a', '#3a2b4a'] as const;
export const SHIRT_COLOURS = [
  '#4a6b8a',
  '#6b7f5a',
  '#8a5f4a',
  '#5f5a7f',
  '#7f6f4a',
  '#4a7f75',
  '#7a4a5f',
  '#5b6470',
] as const;
export const TROUSER_COLOURS = ['#3a3f4a', '#4a4030', '#2f3a35', '#443344'] as const;

export const BODY_VARIANTS = 3;
export const HAIR_STYLES = 4;

/**
 * FNV-1a, chosen because it is short, stable and has no dependencies. The hash
 * quality only has to spread a few hundred agent names across a handful of
 * buckets, so anything stronger would be ceremony.
 */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    // >>> 0 keeps it an unsigned 32-bit value; JS bitwise ops are signed.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function appearanceFor(agentName: string): AgentAppearance {
  const hash = hashName(agentName);
  // Independent slices of the hash, so two agents sharing a skin tone are not
  // thereby pushed towards sharing a shirt as well.
  const pick = (shift: number, size: number): number => Math.floor(hash / 2 ** shift) % size;

  return {
    body: pick(0, BODY_VARIANTS),
    hairStyle: pick(3, HAIR_STYLES),
    skin: SKIN_TONES[pick(6, SKIN_TONES.length)] ?? SKIN_TONES[0],
    hair: HAIR_COLOURS[pick(10, HAIR_COLOURS.length)] ?? HAIR_COLOURS[0],
    shirt: SHIRT_COLOURS[pick(14, SHIRT_COLOURS.length)] ?? SHIRT_COLOURS[0],
    trousers: TROUSER_COLOURS[pick(19, TROUSER_COLOURS.length)] ?? TROUSER_COLOURS[0],
  };
}

/** Everything the renderer needs about one character, for one frame. */
export interface CharacterView {
  assignmentId: string;
  agentName: string;
  status: AssignmentStatus;
  behaviour: CharacterBehaviour;
  appearance: AgentAppearance;
  /** This character's own desk. */
  home: DeskSlot;
  /** Where it should be right now, per `behaviour.location`. */
  target: Point;
}

export interface OfficeScene {
  layout: OfficeLayout;
  characters: CharacterView[];
}

/** Resolve `behaviour.location` into an actual tile. */
export function targetFor(
  behaviour: CharacterBehaviour,
  home: DeskSlot,
  layout: OfficeLayout,
): Point {
  switch (behaviour.location) {
    case 'desk':
      return home.seat;
    case 'to_desk':
      return home.seat;
    case 'manager_desk':
    case 'to_manager':
      return layout.managerDesk.approach;
  }
}

/**
 * The office for a given run state.
 *
 * Takes the assignments rather than the whole `RunState` where it can, so
 * replay can call it with reconstructed assignments without having to
 * manufacture a plausible run around them.
 */
export function buildSceneFromAssignments(assignments: readonly AssignmentState[]): OfficeScene {
  const layout = layoutOffice(assignments.length);

  const characters = assignments.map((assignment, index) => {
    const behaviour = ASSIGNMENT_BEHAVIOUR[assignment.status];
    // `layoutOffice` produced exactly one slot per assignment, but the type
    // system cannot know that; falling back to the Manager's desk keeps this
    // total rather than throwing inside a render loop.
    const home = layout.desks[index] ?? layout.managerDesk;

    return {
      assignmentId: assignment.id,
      agentName: assignment.agentName,
      status: assignment.status,
      behaviour,
      appearance: appearanceFor(assignment.agentName),
      home,
      target: targetFor(behaviour, home, layout),
    };
  });

  return { layout, characters };
}

export function buildScene(run: RunState | undefined): OfficeScene {
  return buildSceneFromAssignments(run?.assignments ?? []);
}
