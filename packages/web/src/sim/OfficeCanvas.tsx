import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AgentSummary, RunState } from '@agent-office/shared';
import { readStorage, writeStorage, type PlateDensity } from '../theme/useTheme.js';
import {
  agentIndicatorFor,
  buildScene,
  plateLines,
  type CharacterView,
  type ManagerView,
  type SceneContext,
} from './model.js';
import {
  createOfficeScene,
  MAX_ZOOM,
  MIN_ZOOM,
  parseZoomPreference,
  type OfficeSceneRenderer,
  type ZoomLevel,
  type ZoomPreference,
} from './scene.js';
import { SPRITE_MANIFEST } from './sprites.js';

/**
 * The React seam onto `OfficeSceneRenderer` (PLAN.md Phase 4).
 *
 * Everything Pixi-related lives inside the renderer, not in React state: this
 * component mounts one `<div>`, hands it to the renderer once, and from then
 * on only pushes data in (`update`, `resize`, `setSelected`) — it never reads
 * anything back out of Pixi. That is what keeps a re-render of `App.tsx`
 * cheap regardless of how many characters are on screen, and it's why a
 * fresh `OfficeSceneRenderer` per mount (rather than one that outlives
 * StrictMode's mount → unmount → mount) is the simpler, safer shape here:
 * each instance's `mount`/`destroy` pair is self-contained.
 */
export interface OfficeCanvasProps {
  run: RunState | undefined;
  onSelectAssignment?: (assignmentId: string) => void;
  selectedAssignmentId?: string;
  /**
   * The run facts the office states on each desk (FR-S10) — models, provider,
   * tool stream. Optional so the component stays renderable without the whole
   * of `App`'s machinery, matching the convention the panels follow.
   */
  context?: SceneContext;
  /** How much each desk plate states. Defaults to `normal`. */
  density?: PlateDensity;
  /**
   * The agent roster, keyed by name, for FR-S4's hover/focus reveal —
   * `CharacterView.agentName` is the only key it shares with `AgentSummary`,
   * an assignment's model/usage/cost already reach the canvas through
   * `context` but its catalog category and description never did before this
   * prop. Optional and defaulted to empty rather than required, matching
   * `context`'s own convention: `App.tsx` fetches the roster after the first
   * render, so the canvas has to be renderable — and hoverable — before it
   * resolves.
   */
  agentByName?: ReadonlyMap<string, AgentSummary>;
}

/** `OfficeCanvasProps.agentByName`'s default. A module-level constant rather
 *  than one allocated per render, since an absent prop should look exactly
 *  like an empty roster and not force a new (empty) Map identity on every
 *  render of a caller that never passes one. */
const EMPTY_AGENT_BY_NAME: ReadonlyMap<string, AgentSummary> = new Map();

/**
 * The canvas's equivalent for anyone not looking at it (WCAG 1.1.1, 2.1.1,
 * 4.1.2).
 *
 * This component used to render `<div className="office-canvas" />` and
 * nothing else: a WebGL surface with no role, no accessible name, no text
 * alternative and no keyboard route to the click-to-inspect that is its only
 * interaction — as the app's DEFAULT view. A screen reader reached the
 * "Office" heading and then found an empty box.
 *
 * The fix is not a caption. Every fact the office conveys is already in
 * `RunState` as text, so this renders it as a real list of real buttons that
 * do the same thing clicking a character does. That gets 1.1.1 (there is a
 * text alternative), 2.1.1 (selection is reachable by keyboard) and 4.1.2
 * (each character has a name, a role and a state) from one structure instead
 * of three bolted-on attributes.
 *
 * **It reads the same `CharacterView`s the canvas draws, through the same
 * `plateLines`.** That is what keeps it honest as the office gains facts:
 * FR-S10 puts the model, tool and spend on each desk, and a text alternative
 * assembled separately would have quietly kept saying only the name — the
 * canvas would have gained information and the accessible path would not.
 * Adding a line to a plate now adds it to both, or to neither.
 *
 * It is visually hidden rather than shown, because sighted users have the
 * canvas and the Table view already; `visually-hidden-focusable` brings it
 * back on screen the moment a keyboard lands in it, so a keyboard user is
 * never operating a control they cannot see.
 */
function OfficeTextAlternative({
  manager,
  characters,
  density,
  selectedAssignmentId,
  onSelectAssignment,
  onFocusAssignment,
  agentByName,
}: {
  manager: ManagerView;
  characters: readonly CharacterView[];
  density: PlateDensity;
  selectedAssignmentId: string | undefined;
  onSelectAssignment: ((assignmentId: string) => void) | undefined;
  onFocusAssignment: (assignmentId: string | undefined) => void;
  /** FR-S4's parity obligation: whatever `AgentIndicatorReveal` says on focus
   *  (below), this button's own label has to say too, or a keyboard user gets
   *  strictly less than a mouse user gets from the same interaction. */
  agentByName: ReadonlyMap<string, AgentSummary>;
}): JSX.Element {
  return (
    <div className="visually-hidden visually-hidden-focusable office-alt">
      <h3 id="office-alt-heading">Office floor</h3>
      {/* The Manager is always on screen (FR-S14 — the head desk is never
          unoccupied) but is deliberately not one of `characters`: it has no
          `assignmentId`, so there is nothing for a click or an inspect panel
          to act on. A static line rather than a button is what keeps that
          honest for a keyboard/screen-reader user the way the canvas keeps it
          honest for a pointer user — clicking the Manager's desk does
          nothing there either (`hitTestAt` never builds an entity for it). */}
      <p className="office-alt-manager">
        {/* `manager.activity.text` (model.ts's `managerActivityFor`), not a
            gloss over `manager.animation`. The animation collapses eleven run
            statuses onto five sprite poses — planning, synthesizing and
            designing all become `read` — so a translation built on top of it
            could not say which of those three was true. `activity` is derived
            straight from `RunStatus` and already carries that distinction, so
            reusing it is what keeps this line as informative as the run
            actually is, not just as informative as the pose looks. */}
        {/* No full stop after the label. Every ongoing activity already ends in
            `…` (see `ActivityLabel`'s doc comment — the trailing character is
            load-bearing, not decoration), and the sentence period this line used
            to carry rendered as "supervising….". The agent lines below never had
            one; this now matches them. */}
        {manager.name} (Manager): {manager.activity.text}
      </p>
      {/* WCAG 2.4.1 (Bypass Blocks). This list is one focus stop per agent and
          nothing caps it — `layoutOffice` lays out beyond 12 quite happily — so
          a keyboard user heading for the activity log below had to tab through
          every desk first. The skip link is the first thing in the group, so
          the cost of stepping over the whole office is one keypress. */}
      {characters.length > 1 && (
        <a className="office-alt-skip" href="#office-alt-end">
          Skip the {characters.length} agents on the floor
        </a>
      )}
      {characters.length === 0 ? (
        // `.office-empty` has existed in the stylesheet since Phase 4 and was
        // referenced by nothing: the host div was rendered unconditionally, so
        // an office with no assignments was a silent empty box. It is used
        // here, where the empty case is actually known.
        <p className="office-empty">No agents on the floor yet.</p>
      ) : (
        <ul aria-labelledby="office-alt-heading">
          {characters.map((view) => {
            // FR-S4. `undefined` while the roster hasn't loaded yet, or for an
            // agent the catalog no longer has — see `agentIndicatorFor`'s own
            // comment for why that is the ordinary case and not an error.
            const indicator = agentIndicatorFor(view.agentName, agentByName);
            return (
              <li key={view.assignmentId}>
                <button
                  type="button"
                  aria-pressed={view.assignmentId === selectedAssignmentId}
                  onClick={() => onSelectAssignment?.(view.assignmentId)}
                  /* FR-S12: focusing this button highlights the same character
                     hovering it would. Without this the phase would have built a
                     pointer-only affordance directly on top of the keyboard
                     access this list exists to provide. */
                  onFocus={() => onFocusAssignment(view.assignmentId)}
                  onBlur={() => onFocusAssignment(undefined)}
                >
                  {/* `view.activity.text` first, then whatever the density adds
                      — the plate's own lines, joined. This used to read
                      `view.status`, and that stopped being right the moment the
                      bubble arrived: for every status but `pending` and
                      `working`, `activityFor` (model.ts) prints the status word
                      itself (`blocked`, `done`, `failed`, `skipped`,
                      `cancelled`) or that word plus an ellipsis
                      (`briefing…`, `reporting…`), so pairing the two would have
                      a screen reader announce "failed: failed". Where they do
                      differ, `activity.text` is the strictly more informative
                      one — `pending` becomes the clearer `waiting`, and
                      `working` is refined by the tool actually running
                      (`reading…`/`writing…`/`thinking…`/`working…`), a
                      distinction the raw status cannot draw at all. So this line
                      carries no information the raw status had that `activity`
                      lacks, and it is what the canvas's bubble says besides —
                      the same parity `plateLines` already holds for the rest of
                      the plate. */}
                  {view.activity.text}: {plateLines(view, density).join(', ')}
                  {/* FR-S4's category/description, appended rather than woven
                      into the sentence above so a roster that hasn't loaded
                      yet changes nothing about what this button already said —
                      it only ever adds a clause, never replaces one. */}
                  {indicator !== undefined && `. ${indicator.category}: ${indicator.description}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* The skip link's destination. `tabIndex={-1}` so it can receive
          programmatic focus from the jump without becoming its own tab stop. */}
      <span id="office-alt-end" tabIndex={-1} />
    </div>
  );
}

/**
 * FR-S13 — user-controlled zoom, added after the automatic best fit turned
 * out not to be enough on its own.
 *
 * `computeViewport`'s largest-integer-that-fits already does the right thing
 * whenever the host has room, and Phase 10's own wall (`layoutOffice`'s
 * `MANAGER_BAND` growing from 5 tiles to 8) made every layout taller, which
 * pushed several real hosts down an integer step even after `styles.css`
 * widened the host box. There is no host size that wins for every window,
 * though: a real measured host at 341x418px fits a four-column office's
 * 320px width at exactly 1x regardless of how tall the box is, because WIDTH
 * is what binds there, not height. So the office also needs a control the
 * user can reach for when automatic isn't enough — not a replacement for it.
 */
const ZOOM_STORAGE_KEY = 'agent-office.zoom';

/** localStorage's string form of a `ZoomPreference`. `'auto'` unchanged; a
 *  level is written as its digit, matching the shape `parseZoomPreference`
 *  in `scene.ts` reads back. */
function zoomPreferenceToStorage(preference: ZoomPreference): string {
  return preference === 'auto' ? 'auto' : String(preference);
}

/**
 * The zoom overlay, rendered on top of the office (unlike `OfficeTextAlternative`,
 * which is visually hidden — this is a real, visible, sighted-and-keyboard
 * control, not an accessible alternative to something else).
 *
 * `+`/`-` glyphs are drawn for a sighted user who already has the visible
 * "1x"/"2x"/… label for context, but neither button's ACCESSIBLE name is the
 * glyph alone (WCAG 2.1.1, 4.1.2 — a bare "+" is not a name a screen reader
 * can announce usefully): each carries its own `aria-label` stating what it
 * does in words.
 */
function ZoomControls({
  preference,
  resolvedZoom,
  onChange,
}: {
  preference: ZoomPreference;
  resolvedZoom: ZoomLevel;
  onChange: (preference: ZoomPreference) => void;
}): JSX.Element {
  const zoomOut = useCallback(() => {
    onChange(Math.max(MIN_ZOOM, resolvedZoom - 1) as ZoomLevel);
  }, [onChange, resolvedZoom]);
  const zoomIn = useCallback(() => {
    onChange(Math.min(MAX_ZOOM, resolvedZoom + 1) as ZoomLevel);
  }, [onChange, resolvedZoom]);
  const resetToFit = useCallback(() => onChange('auto'), [onChange]);

  return (
    <div
      className="office-zoom-controls"
      role="group"
      aria-label="Office zoom"
      style={{
        position: 'absolute',
        right: 8,
        bottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 6px',
        borderRadius: 6,
        background: 'var(--ao-surface-raised)',
        border: '1px solid var(--ao-line-firm)',
        color: 'var(--ao-ink)',
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1,
        zIndex: 1,
      }}
    >
      <button
        type="button"
        aria-label="Zoom out"
        onClick={zoomOut}
        disabled={resolvedZoom <= MIN_ZOOM}
        style={zoomButtonStyle}
      >
        <span aria-hidden="true">−</span>
      </button>
      {/* `aria-live="polite"` so a screen-reader user who reaches for this
          control hears the level change without it interrupting anything —
          this is feedback for an action just taken, not an alert. */}
      <span aria-live="polite" style={{ minWidth: '4.5em', textAlign: 'center' }}>
        {resolvedZoom}x{preference === 'auto' ? ' (auto)' : ''}
      </span>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={zoomIn}
        disabled={resolvedZoom >= MAX_ZOOM}
        style={zoomButtonStyle}
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        aria-label="Reset zoom to automatically fit the window"
        onClick={resetToFit}
        disabled={preference === 'auto'}
        style={zoomButtonStyle}
      >
        Fit
      </button>
    </div>
  );
}

const zoomButtonStyle: CSSProperties = {
  minWidth: '1.6em',
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid var(--ao-line-firm)',
  background: 'var(--ao-surface)',
  color: 'var(--ao-ink)',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  cursor: 'pointer',
};

/**
 * FR-S4's hover/focus reveal: the nameplate always shows a name; this is what
 * hovering OR focusing it adds — the agent's category and one-line
 * description.
 *
 * It is driven by `indicatedId`, the same piece of state `OfficeCanvas`
 * already uses to unify pointer hover and keyboard focus into "which
 * character is the user indicating" (see that field's own comment). A second
 * hovered/focused pair here would just race the one the selection ring
 * already reads.
 *
 * Rendered as a DOM element rather than as more Pixi plate text, for two
 * reasons neither of which applies to the plate itself:
 *
 * - The plate is laid out by `fitPlateLines`/`PlateBox` against a fixed pixel
 *   budget derived from desk spacing — right for a name and a couple of short
 *   facts that must never overlap a neighbour, wrong for a one-line
 *   description that can run to a full sentence and has nothing next to it to
 *   overlap.
 * - It is transient prose shown on demand, not a permanent label; a DOM node
 *   can be read by assistive tech if it is ever un-hidden, where Pixi canvas
 *   text never can.
 *
 * `aria-hidden`: this is not that assistive-tech path. `OfficeTextAlternative`
 * already appends the same category/description to the hidden button's own
 * label for exactly that purpose (FR-S4's parity requirement), so a
 * screen-reader user who focuses a character already has this from the
 * button they are on — exposing this element too would announce it twice.
 *
 * Positioned inline with `var(--ao-*)` tokens, following `ZoomControls`
 * immediately above rather than a `styles.css` class: this component
 * positions its own overlays (the zoom controls' own comment explains why —
 * `styles.css` belongs to the coordinator, who owns the host's sizing, not
 * this box's placement above it), and a hover reveal is exactly that kind of
 * canvas-owned overlay.
 */
function AgentIndicatorReveal({
  character,
  agentByName,
}: {
  character: CharacterView | undefined;
  agentByName: ReadonlyMap<string, AgentSummary>;
}): JSX.Element | null {
  if (character === undefined) return null;
  const indicator = agentIndicatorFor(character.agentName, agentByName);

  return (
    <div className="office-indicator" aria-hidden="true" style={indicatorStyle}>
      <div style={{ fontWeight: 600, color: 'var(--ao-ink)' }}>{character.agentName}</div>
      {/* Nothing more to show while the roster hasn't loaded, or for an agent
          the catalog no longer has — the name above is already what the
          nameplate itself shows, so there is no gap here worth filling with
          placeholder text. */}
      {indicator !== undefined && (
        <>
          <div
            style={{
              color: 'var(--ao-ink-mute)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontSize: 10,
            }}
          >
            {indicator.category}
          </div>
          <div style={{ color: 'var(--ao-ink-soft)' }}>{indicator.description}</div>
        </>
      )}
    </div>
  );
}

const indicatorStyle: CSSProperties = {
  position: 'absolute',
  left: 8,
  top: 8,
  maxWidth: 'min(80%, 32em)',
  padding: '4px 8px',
  borderRadius: 6,
  background: 'var(--ao-surface-raised)',
  border: '1px solid var(--ao-line-firm)',
  fontFamily: 'var(--ao-font-sans)',
  fontSize: 12,
  lineHeight: 1.4,
  zIndex: 1,
  // Purely informational — it must never itself intercept the pointer event
  // that is indicating the character underneath it.
  pointerEvents: 'none',
};

export function OfficeCanvas({
  run,
  onSelectAssignment,
  selectedAssignmentId,
  context,
  density = 'normal',
  agentByName = EMPTY_AGENT_BY_NAME,
}: OfficeCanvasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<OfficeSceneRenderer | undefined>(undefined);

  // The renderer is constructed once per mount and never recreated just
  // because a callback prop's identity changed; the latest callback is read
  // through this ref instead, from inside a stable wrapper handed to Pixi.
  const onSelectRef = useRef(onSelectAssignment);
  onSelectRef.current = onSelectAssignment;

  // Pointer hover and keyboard focus are one piece of state — "which character
  // is the user indicating" — so they share it rather than racing to set the
  // renderer's highlight independently.
  const [indicatedId, setIndicatedId] = useState<string | undefined>(undefined);

  // FR-S13. `zoomPreference` is what the user picked (or 'auto', the
  // default); `resolvedZoom` is what the renderer actually resolved that to
  // just now, reported back through `onZoomChange` because the resolution
  // against the live container size happens entirely inside the renderer —
  // this component has no other way to know it, and needs it to render the
  // "Nx" label and to step +/- from the CURRENT level rather than from
  // whatever `zoomPreference` alone would suggest (which is meaningless while
  // it is `'auto'`).
  const [zoomPreference, setZoomPreferenceState] = useState<ZoomPreference>(() =>
    parseZoomPreference(readStorage(ZOOM_STORAGE_KEY)),
  );
  const [resolvedZoom, setResolvedZoom] = useState<ZoomLevel>(MIN_ZOOM);

  const setZoomPreference = useCallback((preference: ZoomPreference) => {
    setZoomPreferenceState(preference);
    writeStorage(ZOOM_STORAGE_KEY, zoomPreferenceToStorage(preference));
  }, []);

  // Built once per render and shared: the canvas draws these and the text
  // alternative reads them. Two `buildScene` calls would be two chances to
  // disagree, which is the whole reason the alternative sits in this file.
  const scene = useMemo(() => buildScene(run, context), [run, context]);

  // `indicatedId` is an assignment id — it comes from Pixi's hit test and from
  // the text alternative's buttons, neither of which know a `CharacterView`,
  // only the id they were given. FR-S4's reveal needs the view itself (for
  // `agentName`), so this is the one lookup back from id to view.
  const characterByAssignmentId = useMemo(
    () => new Map(scene.characters.map((view) => [view.assignmentId, view])),
    [scene.characters],
  );
  const indicatedCharacter =
    indicatedId === undefined ? undefined : characterByAssignmentId.get(indicatedId);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const renderer = createOfficeScene(SPRITE_MANIFEST, {
      onSelectAssignment: (assignmentId) => onSelectRef.current?.(assignmentId),
      onHoverAssignment: (assignmentId) => setIndicatedId(assignmentId),
      onZoomChange: (zoom) => setResolvedZoom(zoom),
    });
    rendererRef.current = renderer;
    renderer.mount(host);

    return () => {
      renderer.destroy();
      rendererRef.current = undefined;
    };
    // Deliberately empty deps: this effect owns the renderer's whole
    // lifecycle for one mounted `<div>`. `run` and `selectedAssignmentId`
    // are pushed in via the effects below instead of retriggering this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rendererRef.current?.update(scene);
  }, [scene]);

  useEffect(() => {
    rendererRef.current?.setSelected(selectedAssignmentId);
  }, [selectedAssignmentId]);

  useEffect(() => {
    rendererRef.current?.setHovered(indicatedId);
  }, [indicatedId]);

  useEffect(() => {
    rendererRef.current?.setPlateDensity(density);
  }, [density]);

  useEffect(() => {
    rendererRef.current?.setZoom(zoomPreference);
  }, [zoomPreference]);

  // The canvas is `aria-hidden`: it carries no information the list beside it
  // does not, and leaving it exposed would announce an unlabelled graphic
  // immediately before the same content in readable form.
  //
  // `position: relative` is set inline rather than added to `.office-canvas`
  // in `styles.css` — that file belongs to the coordinator, who already
  // fixed the host's own sizing there for this same requirement, and the
  // zoom overlay below is positioned entirely by this component so it has no
  // reason to reach into a stylesheet it does not own for it.
  return (
    <div className="office-canvas" style={{ position: 'relative' }}>
      <div ref={hostRef} className="office-stage" aria-hidden="true" />
      <ZoomControls preference={zoomPreference} resolvedZoom={resolvedZoom} onChange={setZoomPreference} />
      <AgentIndicatorReveal character={indicatedCharacter} agentByName={agentByName} />
      <OfficeTextAlternative
        manager={scene.manager}
        characters={scene.characters}
        density={density}
        selectedAssignmentId={selectedAssignmentId}
        onSelectAssignment={onSelectAssignment}
        onFocusAssignment={setIndicatedId}
        agentByName={agentByName}
      />
    </div>
  );
}
