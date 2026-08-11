import {
  ASSIGNMENT_BEHAVIOUR,
  type AssignmentState,
  type AssignmentStatus,
  type CharacterBehaviour,
  type LoggedAgentEvent,
  type RunState,
  type Usage,
} from '@agent-office/shared';
import { assignmentCostUsd, effectiveModelFor, formatCostUsd } from '../costModel.js';
import { SPRITE_RAMP } from '../theme/tokens.js';
import type { PlateDensity } from '../theme/useTheme.js';
import type { SpriteAnimation } from './spriteContract.js';

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
 *
 * FR-U2/FR-U3: these four names are aliases onto `SPRITE_RAMP` in
 * `theme/tokens.ts`, not a second definition. Before this change the office
 * carried its own 23 hex literals here, independent of the ones the chrome
 * used; a retune (this phase's phosphor palette swap) meant hunting down and
 * editing two places that were supposed to agree. Re-exporting the ramps
 * under their original names means `appearanceFor`'s slicing below — and
 * every caller of these four exports — needs no change at all: the palette
 * moved, the shapes (5/6/8/4 entries respectively) did not.
 */
export const SKIN_TONES = SPRITE_RAMP.skin;
export const HAIR_COLOURS = SPRITE_RAMP.hair;
export const SHIRT_COLOURS = SPRITE_RAMP.shirt;
export const TROUSER_COLOURS = SPRITE_RAMP.trousers;

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

/**
 * Tools that read rather than change things (FR-S11).
 *
 * The taxonomy is deliberately a small allowlist of the canonical names
 * `apiTools.ts` defines, not a heuristic over the string. An unknown tool —
 * an MCP tool, a future built-in — falls through to the writing animation,
 * which is the honest default: "this agent is doing something" is true of
 * every tool, whereas claiming it is reading would be a guess.
 */
const READING_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

export function isReadingTool(toolName: string | undefined): boolean {
  return toolName !== undefined && READING_TOOLS.has(toolName);
}

/**
 * Refine a status-derived animation with the tool actually running.
 *
 * This is the whole of FR-S11, and the narrowness is the point. Status still
 * decides *behaviour* — where the character is, what bubble it shows, whether
 * it carries paper — and `shared/src/status.ts` remains the only owner of
 * that. The tool changes exactly one thing: which working loop plays. So the
 * refinement applies to `type` and nothing else, and a tool arriving while a
 * character is walking to the Manager cannot make it sit down.
 *
 * Living here rather than in `shared` is deliberate. A tool taxonomy is a
 * rendering concern — `Grep` looks like reading — and the orchestrator has no
 * business knowing which of its tools look studious. What `shared` owns is
 * that the animation input came from an orchestrator event at all, which is
 * FR-S3's actual invariant.
 */
export function refineAnimation(
  animation: SpriteAnimation,
  currentTool: string | undefined,
): SpriteAnimation {
  if (animation !== 'type') return animation;
  return isReadingTool(currentTool) ? 'read' : 'type';
}

/**
 * The most recent `tool` event per assignment, from the persisted event log.
 *
 * Pure and exported so it is testable without a canvas or a DOM, matching the
 * convention `useReplay.ts`'s `foldEvents` and `useSettings.ts`'s parsers
 * already follow — the web package's tests run under plain Node.
 *
 * Events are scanned in order and later ones overwrite earlier ones, so this
 * does not assume the caller sorted them by anything but arrival. That matches
 * how both the live stream and replay hand them over.
 */
export function latestToolByAssignment(
  events: readonly LoggedAgentEvent[],
): Map<string, string> {
  const latest = new Map<string, string>();
  for (const logged of events) {
    if (logged.event.t === 'tool') latest.set(logged.event.assignmentId, logged.event.name);
  }
  return latest;
}

/**
 * The run facts the office needs but cannot derive from `AssignmentState`
 * alone — the agent roster's models, the run's provider, and the tool stream.
 *
 * All of it already existed in `App.tsx` and stopped at the table. Passing it
 * in rather than fetching it here keeps `model.ts` a pure function of its
 * arguments, which is what lets replay drive the identical office from
 * reconstructed state.
 */
export interface SceneContext {
  /** From `buildAgentModelIndex` — agent name to its catalog `model:` frontmatter. */
  agentModelByName: Map<string, string | undefined>;
  /** The provider this run used, which decides only whether it was free. */
  runProvider: string | undefined;
  /** From {@link latestToolByAssignment}. */
  toolByAssignment: Map<string, string>;
}

const EMPTY_CONTEXT: SceneContext = {
  agentModelByName: new Map(),
  runProvider: undefined,
  toolByAssignment: new Map(),
};

/** Everything the renderer needs about one character, for one frame. */
export interface CharacterView {
  assignmentId: string;
  agentName: string;
  status: AssignmentStatus;
  behaviour: CharacterBehaviour;
  /** `behaviour.animation` after FR-S11's tool refinement. Draw this, not the raw one. */
  animation: SpriteAnimation;
  appearance: AgentAppearance;
  /** This character's own desk. */
  home: DeskSlot;
  /** Where it should be right now, per `behaviour.location`. */
  target: Point;

  // -- FR-S10: the facts the office used to make you leave to find --------

  /** Catalog model for this agent, or `undefined` for the 8 that declare none. */
  model: string | undefined;
  /** Tokens spent so far by this assignment. */
  usage: Usage;
  /**
   * Estimated spend, or `undefined` when the model is unknown or unpriced.
   *
   * Computed by `costModel.ts`'s `assignmentCostUsd` — the same function the
   * assignment table calls, deliberately, and not a second implementation.
   * Two independent cost calculations disagreeing about one run is precisely
   * the defect class this project keeps finding, and the office showing a
   * different number from the table would be the most visible version of it.
   */
  costUsd: number | undefined;
  /** Name of the most recent tool, while this assignment is working. */
  currentTool: string | undefined;
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
export function buildSceneFromAssignments(
  assignments: readonly AssignmentState[],
  context: SceneContext = EMPTY_CONTEXT,
): OfficeScene {
  const layout = layoutOffice(assignments.length);

  const characters = assignments.map((assignment, index) => {
    const behaviour = ASSIGNMENT_BEHAVIOUR[assignment.status];
    // `layoutOffice` produced exactly one slot per assignment, but the type
    // system cannot know that; falling back to the Manager's desk keeps this
    // total rather than throwing inside a render loop.
    const home = layout.desks[index] ?? layout.managerDesk;

    // Only while the assignment is actually working. A `tool` event is the
    // last one an assignment emitted, and it stays in the log forever — so
    // without this guard a finished agent would sit at its desk under a plate
    // still reading "Grep TODO", describing work that ended minutes ago. The
    // tool is a statement about the present tense or it is noise.
    const currentTool =
      assignment.status === 'working'
        ? context.toolByAssignment.get(assignment.id)
        : undefined;

    return {
      assignmentId: assignment.id,
      agentName: assignment.agentName,
      status: assignment.status,
      behaviour,
      animation: refineAnimation(behaviour.animation, currentTool),
      appearance: appearanceFor(assignment.agentName),
      home,
      target: targetFor(behaviour, home, layout),
      model: effectiveModelFor(assignment, context.agentModelByName, context.runProvider),
      usage: assignment.usage,
      costUsd: assignmentCostUsd(assignment, context.agentModelByName, context.runProvider),
      currentTool,
    };
  });

  return { layout, characters };
}

export function buildScene(run: RunState | undefined, context?: SceneContext): OfficeScene {
  return buildSceneFromAssignments(run?.assignments ?? [], context);
}

// ---------------------------------------------------------------------------
// The desk plate (FR-S10)
// ---------------------------------------------------------------------------

/**
 * A short, human line describing what an agent is doing right now.
 *
 * `LogPane` formats the same fact for its feed and this is deliberately not a
 * second spelling of it: both call this. A tool line that read `Grep TODO` in
 * the log and `grep: TODO` on the plate would be two vocabularies for one
 * event, which is how a UI starts feeling assembled rather than designed.
 */
export function formatToolLine(name: string, summary: string): string {
  const trimmed = summary.trim();
  return trimmed.length === 0 ? name : `${name} ${trimmed}`;
}

/**
 * `inherit`, the catalog's sentinel for "whatever the run is using".
 *
 * Not a model, despite living in the `model:` frontmatter field. `provider.ts`
 * filters it out before it can reach `--model` for exactly that reason.
 */
const INHERIT_MODEL = 'inherit';

/** What a plate should call this agent's model. */
const RUN_DEFAULT_LABEL = 'run default';

/**
 * Turn a catalog `model:` value into something a reader learns from.
 *
 * The first version of this simply printed `view.model ?? '—'`, and the
 * running app showed it up immediately: two of the five agents on screen said
 * `inherit`, which names no model and reads like one. **33 of the 156 catalog
 * agents** are affected — 25 declare `inherit`, 8 declare nothing at all — so
 * over a fifth of the roster would have shipped a plate that either said
 * nothing useful or said something false.
 *
 * Both cases collapse to one label, deliberately, because operationally they
 * are one case: an agent declaring `inherit` and an agent declaring no model
 * both run on whatever the run is using. Distinguishing them on the plate
 * would be reporting a frontmatter detail rather than what is running, which
 * is the opposite of what FR-S10 is for.
 */
export function formatModelLabel(model: string | undefined): string {
  if (model === undefined || model === INHERIT_MODEL) return RUN_DEFAULT_LABEL;
  return model;
}

/**
 * The lines of one desk plate, at a given density.
 *
 * Pure, exported and returning an array of strings rather than drawing
 * anything — which is what lets the canvas and the office's screen-reader
 * alternative render the *same* words from the *same* function. FR-S12 and
 * the second QA pass's text alternative both depend on that: a plate whose
 * contents were assembled inside the Pixi renderer could not be read out, and
 * a text alternative that reassembled them independently would drift.
 *
 * Empty strings are never returned — a caller can join the array without
 * having to filter it.
 */
export function plateLines(view: CharacterView, density: PlateDensity): string[] {
  const lines = [view.agentName];
  if (density === 'minimal') return lines;

  lines.push(formatModelLabel(view.model));

  if (view.currentTool !== undefined) lines.push(view.currentTool);

  if (density === 'verbose') {
    const { inputTokens, outputTokens } = view.usage;
    if (inputTokens > 0 || outputTokens > 0) {
      lines.push(`${inputTokens}in/${outputTokens}out`);
    }
    // Only when it is actually known. `formatCostUsd` renders an unknown cost
    // as a dash, which is right in the run header where the row exists either
    // way; here an unpriced agent is better served by one fewer line than by a
    // line that says nothing.
    if (view.costUsd !== undefined) lines.push(formatCostUsd(view.costUsd));
  }

  return lines;
}
