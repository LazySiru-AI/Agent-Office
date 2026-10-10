import {
  ASSIGNMENT_BEHAVIOUR,
  type AgentSummary,
  type AssignmentState,
  type AssignmentStatus,
  type CharacterBehaviour,
  type LoggedAgentEvent,
  type RunState,
  type RunStatus,
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
  /**
   * Rows at the top of the office that are wall rather than floor.
   *
   * The office had no wall until Phase 10, and the absence is most of why it
   * read as a grid of desks floating on a void: a room is legible because it
   * has a back to it. The renderer needs the count as data rather than as its
   * own constant, because the Manager's desk is positioned against the wall and
   * the two must agree about where the wall stops.
   */
  wallRows: number;
  managerDesk: DeskSlot;
  /** One slot per assignment, index-aligned with the run's assignment order. */
  desks: DeskSlot[];
}

/** Tiles of margin around the desk grid, leaving room to walk. */
const MARGIN = 2;
/** Desks are spaced two tiles apart so characters never overlap while walking. */
const DESK_SPACING_X = 4;
const DESK_SPACING_Y = 4;
/** Rows of wall across the top of the office, where the decor hangs. */
const WALL_ROWS = 3;
/**
 * Rows the wall, the Manager's desk and its walking lane consume at the top.
 *
 * Grew from 5 to 8 with the wall. The Manager sits directly against it — which
 * is what makes the desk read as the head of the room rather than as one more
 * desk that happens to be at the front.
 */
const MANAGER_BAND = 8;
/**
 * How much wider than tall the room is drawn, regardless of how many desks it
 * actually has to hold.
 *
 * This is a *rendering* fix expressed in the layout, and the arithmetic behind
 * it is worth keeping because "the office looks too small" turned out not to be
 * about size at all.
 *
 * `scene.ts` scales the world by the largest WHOLE number that fits — fractional
 * scaling is what turns crisp pixel art to mush under nearest-neighbour
 * sampling, so that floor is not negotiable. It therefore takes
 * `min(hostWidth / worldWidth, hostHeight / worldHeight)` and throws away the
 * remainder. Measured on a real 1440×960 window with five agents: the host is
 * 1055×718 and the world was 256×288 — a *portrait* room in a *landscape*
 * frame. The height ratio came out at 2.49 and the width at 4.12, so the office
 * rendered at 2x, filling 512 of 1055 available pixels. Under half the frame
 * was office, and half of a scale step was discarded, purely because the two
 * aspect ratios disagreed.
 *
 * Widening the room to roughly the shape of the pane it lives in makes both
 * axes bind at once, so almost nothing is wasted. At the same five agents the
 * world becomes 432×288 and renders at 864×576 — the same 2x, but filling ~82%
 * of the frame instead of ~48%. A twelve-agent office reaches ~97%.
 *
 * The extra floor is not padding: the desk grid stays centred on `centreX`, so
 * the width appears as open floor down both sides — which is exactly where the
 * lounge furniture goes, and exactly how the reference office is composed. A
 * room whose walls hug its desks reads as a corridor.
 *
 * 1.45 rather than a display's 16:9, because the office shares its pane with
 * the app's chrome and never gets the full window height.
 */
const ROOM_ASPECT = 1.45;

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
  const heightTiles = MANAGER_BAND + rows * DESK_SPACING_Y + MARGIN;
  // The room is widened to a landscape aspect rather than being exactly as wide
  // as its desks need. See `ROOM_ASPECT`.
  const widthTiles = Math.max(gridWidth + MARGIN * 2, 14, Math.ceil(heightTiles * ROOM_ASPECT));

  const centreX = Math.floor(widthTiles / 2);
  const managerDesk: DeskSlot = {
    // Against the wall, top-centre. Both halves of that matter: centred is what
    // makes every agent's walk to it symmetrical, and against the wall is what
    // makes it the head of the room.
    desk: { x: centreX, y: WALL_ROWS },
    seat: { x: centreX, y: WALL_ROWS + 1 },
    // Directly below the Manager's seat: where an agent stands to report.
    approach: { x: centreX, y: WALL_ROWS + 2 },
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

  return { widthTiles, heightTiles, columns, rows, wallRows: WALL_ROWS, managerDesk, desks };
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
/**
 * Hair *silhouettes*, which is a different axis from hair colour — the ramp
 * above supplies the colour, this supplies the shape, and `appearanceFor`
 * slices the hash independently for each so two agents sharing a shape are not
 * thereby pushed towards sharing a colour.
 *
 * Four through Phase 9, and four was a consequence of the 12×16 sprite box
 * rather than a design decision: at that size a head is 4×4 and there is simply
 * no room for a fifth shape anyone could tell from the other four. At 16×24
 * there is, and shape carries far more recognisability than colour does at a
 * glance across a floor of desks — so this is where the extra variety is worth
 * spending.
 */
export const HAIR_STYLES = 6;

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

// ---------------------------------------------------------------------------
// The overhead activity bubble
// ---------------------------------------------------------------------------

/**
 * How loudly a bubble should read.
 *
 * Three tones, not a colour: the renderer maps these to `OFFICE` values and the
 * text alternative ignores them entirely, which is the split that keeps WCAG
 * 1.4.1 satisfiable. Every tone's meaning is already carried by the WORD in the
 * bubble — `blocked`, `failed` — so colour is reinforcement here and never the
 * only channel, unlike the icon-only bubble this replaces.
 */
export type ActivityTone = 'normal' | 'alert' | 'error';

/** What one character's overhead bubble says right now. */
export interface ActivityLabel {
  /**
   * Short, lowercase, present tense. An ongoing activity ends in `…`; a state
   * the agent has settled into does not.
   *
   * That distinction is the whole reason the bubble is worth drawing: an office
   * of nine characters all captioned reads as noise unless a glance can
   * separate "still going" from "finished". The trailing character does that
   * before any of the words are read.
   */
  text: string;
  tone: ActivityTone;
}

/**
 * Tools that change things, for the bubble's benefit.
 *
 * The reading half is {@link READING_TOOLS}, which FR-S11 already needed to
 * pick an animation. This is deliberately NOT that set's complement: a tool
 * that is in neither list gets `working…`, not `writing…`. An MCP tool from
 * whatever server an operator configured could be doing anything at all, and
 * captioning it `writing…` would state something this code cannot know.
 */
const WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);

/**
 * What one agent's bubble says, from its status and the tool it is running.
 *
 * Derived rather than stored, from exactly the two facts the office already
 * has, so a bubble can never disagree with the pose beneath it — both are
 * functions of the same status. `shared/src/status.ts` still owns behaviour;
 * this owns only the words, for the same reason `refineAnimation` lives here
 * and not in `shared`: which tools "look like reading" is a rendering opinion,
 * and the orchestrator has no business holding it.
 *
 * `working` with no tool yet is captioned `thinking…`. That is the one label
 * here making a claim about something unobservable — every other line restates
 * a status the server sent. It earns its place because the alternative
 * (`working…` for both) collapses the single most useful distinction the office
 * can draw during a long assignment: whether the agent is generating, or has
 * gone out to a tool and is waiting on it.
 */
export function activityFor(
  status: AssignmentStatus,
  currentTool: string | undefined,
): ActivityLabel {
  switch (status) {
    case 'pending':
      // Not `waiting…`: a pending assignment is not doing anything yet, and an
      // ellipsis would suggest work in flight where there is only a queue.
      return { text: 'waiting', tone: 'normal' };
    case 'briefing':
      return { text: 'briefing…', tone: 'normal' };
    case 'working':
      if (isReadingTool(currentTool)) return { text: 'reading…', tone: 'normal' };
      if (currentTool !== undefined && WRITING_TOOLS.has(currentTool)) {
        return { text: 'writing…', tone: 'normal' };
      }
      if (currentTool !== undefined) return { text: 'working…', tone: 'normal' };
      return { text: 'thinking…', tone: 'normal' };
    case 'blocked':
      return { text: 'blocked', tone: 'alert' };
    case 'reporting':
      return { text: 'reporting…', tone: 'normal' };
    case 'done':
      return { text: 'done', tone: 'normal' };
    case 'failed':
      return { text: 'failed', tone: 'error' };
    case 'skipped':
      return { text: 'skipped', tone: 'normal' };
    // Nothing went wrong; the work simply stopped being wanted. Same reasoning
    // as `ASSIGNMENT_BEHAVIOUR` giving it `idle` rather than `idle_slumped`.
    case 'cancelled':
      return { text: 'cancelled', tone: 'normal' };
    // `alert`, not `error`: the agent finished and reported it could not do the
    // work. Something wants a human, and nothing broke — the same distinction
    // `ASSIGNMENT_BEHAVIOUR` draws by giving this an alert bubble rather than
    // the slumped, error-bubbled pose `failed` gets.
    case 'declined':
      return { text: 'declined', tone: 'alert' };
  }
}

/**
 * What the Manager's bubble says, from the run's status.
 *
 * Run status, not the Manager's animation. `managerAnimationFor` collapses
 * eleven run statuses onto five poses — `planning`, `synthesizing` and
 * `designing` all become `read` — which is right for a sprite and wrong for a
 * caption: the caption is the channel that can carry the distinction the pose
 * cannot, and captioning three different phases identically would waste it.
 *
 * Spellings match `RUN_STATUSES` rather than this file's British prose, because
 * `StatusBadge` renders the raw status a few hundred pixels away and a bubble
 * reading `synthesising…` beside a badge reading `synthesizing` looks like two
 * different facts.
 */
export function managerActivityFor(status: RunStatus | undefined): ActivityLabel {
  switch (status) {
    case 'planning':
      return { text: 'planning…', tone: 'normal' };
    // The one run status where the office is waiting on a PERSON (FR-M11), so
    // it is the one Manager caption addressed to the reader rather than
    // describing the room. `alert` for the same reason: nothing is wrong, but
    // nothing will happen either until someone acts.
    case 'awaiting_approval':
      return { text: 'needs your OK', tone: 'alert' };
    // FR-M12's park. Worded as a question rather than a demand because that is
    // what it is — the Manager asked something and is holding the run until it
    // hears back. `alert` for the same reason as above: nothing is broken, and
    // nothing will move either.
    case 'awaiting_clarification':
      return { text: 'has a question', tone: 'alert' };
    case 'dispatching':
      return { text: 'dispatching…', tone: 'normal' };
    case 'running':
      return { text: 'supervising…', tone: 'normal' };
    case 'synthesizing':
      return { text: 'synthesizing…', tone: 'normal' };
    case 'designing':
      return { text: 'designing…', tone: 'normal' };
    case 'report_ready':
      return { text: 'wrapping up…', tone: 'normal' };
    case 'done':
      return { text: 'done', tone: 'normal' };
    case 'failed':
      return { text: 'failed', tone: 'error' };
    case 'cancelled':
      return { text: 'cancelled', tone: 'normal' };
    // `queued`, and no run at all — the office open with nothing in it.
    default:
      return { text: 'idle', tone: 'normal' };
  }
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
  /**
   * The run's own status, which only the Manager needs.
   *
   * Every other character in the office derives from an `AssignmentState`; the
   * Manager has none, because it is not an assignment — it is the orchestrator
   * that hands them out. Its behaviour therefore has to come from the one piece
   * of state that describes the run as a whole. Optional so an office can still
   * be built from assignments alone, which is what replay and most tests do.
   */
  runStatus?: RunStatus;
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
  /**
   * What the overhead bubble says — see {@link activityFor}.
   *
   * Carried on the view rather than recomputed by each consumer so the canvas
   * and the screen-reader alternative cannot drift into describing the same
   * character two different ways, which is the parity obligation FR-S10's own
   * text-alternative tests already hold the plate to.
   */
  activity: ActivityLabel;
}

// ---------------------------------------------------------------------------
// FR-S4 — the nameplate's hover/focus reveal
// ---------------------------------------------------------------------------

/** What a nameplate's hover/focus reveal adds to the name it always shows. */
export interface AgentIndicator {
  category: string;
  description: string;
}

/**
 * FR-S4: "hovering shows its category and one-line description." Before this,
 * both existed only inside the click-to-inspect panel (`InspectPanel.tsx`'s
 * `agent.category`/`agent.description`) — a fact the user could only reach by
 * already having selected the agent, which is the opposite of what a hover
 * preview is for.
 *
 * Looked up by agent NAME rather than assignment id, because that is the only
 * key `CharacterView` and `AgentSummary` share: an `AgentSummary` describes
 * the catalog entry for an agent, not any particular run's assignment of it.
 *
 * Returns `undefined` rather than throwing or fabricating placeholder text
 * when the name has no match. That is the ordinary case for a moment on every
 * load — `App.tsx` fetches the roster with `fetchAgents()` after the first
 * render, so the office can draw, and be hovered, several frames before
 * `agentByName` has anything in it — and it stays possible for as long as the
 * run does, for an assignment whose agent was since removed from the catalog.
 * A hover on either one should show the name it already has and nothing more,
 * not an exception.
 */
export function agentIndicatorFor(
  agentName: string,
  agentByName: ReadonlyMap<string, AgentSummary>,
): AgentIndicator | undefined {
  const agent = agentByName.get(agentName);
  return agent === undefined ? undefined : { category: agent.category, description: agent.description };
}

/**
 * The Manager — the run's point of contact, at the desk at the head of the room
 * (FR-S14).
 *
 * The office has drawn a Manager's desk since Phase 4 and never put anyone
 * behind it. Agents walked to it to be briefed and walked back to report, and
 * the thing they were walking to was an empty piece of furniture — so the
 * office's central interaction, the one that makes it a *workplace* rather than
 * a row of independent desks, had no other party in it.
 *
 * It is deliberately **not** a `CharacterView` in `scene.characters`:
 *
 * - It has no `assignmentId`, and every map, hit test and selection path in the
 *   renderer is keyed by one. Handing them a character with a fabricated id
 *   would make clicking the Manager open an inspect panel for an assignment
 *   that does not exist.
 * - It never walks. Its whole behaviour is "sit at the head desk and look like
 *   the run is going the way it is going", so the walk interpolation, the
 *   target resolution and the carried-report prop are all inapplicable.
 *
 * A separate field states both of those in the type rather than leaving them as
 * rules a future caller has to remember.
 */
export interface ManagerView {
  /**
   * A reserved id, never an assignment's.
   *
   * The `@` prefix cannot collide: assignment ids are generated identifiers and
   * the orchestrator has no path that produces one starting with `@`.
   */
  id: string;
  /** What the plate calls it. */
  name: string;
  appearance: AgentAppearance;
  animation: SpriteAnimation;
  /** What the overhead bubble says — see {@link managerActivityFor}. */
  activity: ActivityLabel;
  /** Tile the Manager is drawn on, and the desk it sits behind. */
  seat: Point;
  desk: Point;
}

export interface OfficeScene {
  layout: OfficeLayout;
  characters: CharacterView[];
  /** Always present — the head desk is never unoccupied. */
  manager: ManagerView;
}

/** The Manager's reserved identity. Exported so the renderer can exclude it from hit testing. */
export const MANAGER_ID = '@manager';
const MANAGER_NAME = 'orchestrator';

/**
 * What the Manager is doing, from the run's status.
 *
 * The mapping is the same *kind* of thing `ASSIGNMENT_BEHAVIOUR` is for
 * assignments — state in, animation out, no memory — and it deliberately reuses
 * the animation vocabulary rather than inventing Manager-only loops. A reader
 * who has learned that a slumped character means something failed should not
 * have to learn a second dialect for the desk at the front.
 *
 * `read` for the thinking phases and `type` for the dispatching ones is the one
 * judgement call here: planning, synthesis and design are the run's reading
 * work, and it is more informative than having the Manager type throughout.
 */
export function managerAnimationFor(status: RunStatus | undefined): SpriteAnimation {
  switch (status) {
    case 'planning':
    case 'synthesizing':
    case 'designing':
      return 'read';
    case 'dispatching':
    case 'running':
    case 'report_ready':
      return 'type';
    case 'done':
      return 'idle_relaxed';
    case 'failed':
      return 'idle_slumped';
    // `queued`, `cancelled`, and no run at all. A cancelled run gets `idle`
    // rather than `idle_slumped` for the same reason a cancelled assignment
    // does: nothing went wrong, the work simply stopped being wanted.
    default:
      return 'idle';
  }
}

export function managerViewFor(layout: OfficeLayout, status: RunStatus | undefined): ManagerView {
  return {
    id: MANAGER_ID,
    name: MANAGER_NAME,
    // Derived from the name exactly as every agent's is, so the Manager is
    // recognisably the same person across runs and restarts (FR-S2). It is a
    // character in the office, not a piece of set dressing with a fixed palette.
    appearance: appearanceFor(MANAGER_NAME),
    animation: managerAnimationFor(status),
    activity: managerActivityFor(status),
    seat: { ...layout.managerDesk.seat },
    desk: { ...layout.managerDesk.desk },
  };
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
      // The same `currentTool` the animation was refined with one line up, so
      // the caption and the pose are guaranteed to be describing one moment.
      activity: activityFor(assignment.status, currentTool),
    };
  });

  return { layout, characters, manager: managerViewFor(layout, context.runStatus) };
}

export function buildScene(run: RunState | undefined, context?: SceneContext): OfficeScene {
  // The run's status is injected here rather than asked of the caller: every
  // caller already passes the run, and requiring them to copy one field out of
  // it onto the context would be one more thing to forget — with the failure
  // being a Manager permanently idle through a live run, which looks like a
  // rendering bug rather than a missing argument.
  const merged: SceneContext = {
    ...(context ?? EMPTY_CONTEXT),
    ...(run === undefined ? {} : { runStatus: run.status }),
  };
  return buildSceneFromAssignments(run?.assignments ?? [], merged);
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

/**
 * Monospace advance width as a fraction of font size.
 *
 * Measured against the stack the plate actually renders in rather than taken
 * from a table: `architect-reviewer` is 99px at 10px (5.5px/char) and
 * `run default` is 48px at 8px (4.36px/char), so real advances sit around
 * 0.44–0.55. Rounding UP to 0.6 makes every estimate here slightly wide,
 * which truncates a shade early — the safe direction, because the failure
 * being prevented is text from one desk running across its neighbour.
 */
const MONO_ADVANCE_RATIO = 0.6;

/** The box one desk plate has to live in, in *screen* pixels. */
export interface PlateBox {
  widthPx: number;
  heightPx: number;
  /** Font size of the name line; detail lines below it are smaller. */
  nameSizePx: number;
  detailSizePx: number;
  lineHeightPx: number;
}

/**
 * Trim a plate to the space it actually has (FR-S10's clutter risk, made
 * geometric).
 *
 * The office draws plates in an UNSCALED overlay so text stays crisp at any
 * zoom, while the desks they label live in the scaled world. That is the right
 * call for legibility and it means the room available to a plate halves when
 * the renderer drops from 2x to 1x — which it does for a three-row team, i.e.
 * exactly the runs with the most plates to draw. Measured at 1x: an
 * 18-character agent name is 99px against a 64px column gap, and a four-line
 * verbose plate is 78px tall against a 64px row gap. Both overlap a neighbour.
 *
 * So the plate is fitted rather than assumed to fit:
 *
 * - Every line is truncated to the available width, with an ellipsis so the
 *   reader can see that something was cut rather than misread a shortened
 *   name as the whole name.
 * - Detail lines that would not fit vertically are dropped, nearest-the-name
 *   first. Showing fewer facts is the honest response to having no room for
 *   them; drawing them over the next row is not.
 *
 * The name line is never dropped — a desk with no label is worse than a
 * truncated one — and it keeps at least one character plus the ellipsis even
 * in an absurdly narrow box.
 */
export function fitPlateLines(lines: readonly string[], box: PlateBox): string[] {
  const [name = '', ...details] = lines;

  const fitWidth = (text: string, sizePx: number): string => {
    const advance = sizePx * MONO_ADVANCE_RATIO;
    if (advance <= 0) return text;
    const maxChars = Math.floor(box.widthPx / advance);
    if (text.length <= maxChars) return text;
    // `maxChars - 1` to leave room for the ellipsis itself; never below one
    // visible character, or the plate degrades to a bare "…".
    return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
  };

  const fitted = [fitWidth(name, box.nameSizePx)];

  // How many detail rows clear the vertical budget. The name occupies the
  // first row; each detail line costs one `lineHeightPx` below it.
  const roomForDetails = Math.max(0, Math.floor((box.heightPx - box.nameSizePx) / box.lineHeightPx));
  for (const line of details.slice(0, roomForDetails)) {
    fitted.push(fitWidth(line, box.detailSizePx));
  }

  return fitted;
}
