import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RunState } from '@agent-office/shared';
import { readStorage, writeStorage, type PlateDensity } from '../theme/useTheme.js';
import { buildScene, plateLines, type CharacterView, type ManagerView, type SceneContext } from './model.js';
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
}

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
/**
 * A prose gloss for the Manager's animation, for the screen-reader
 * alternative only (FR-S12, FR-S14).
 *
 * `managerAnimationFor` in `model.ts` turns the run's status into one of the
 * five loops the sprite vocabulary already has, deliberately reusing a
 * character's animations rather than inventing Manager-only ones — a reader
 * who has learned that `idle_slumped` means something failed should not have
 * to learn a second dialect for the desk at the front. That reuse is exactly
 * right for the canvas, where the loop is drawn, and exactly wrong to read out
 * verbatim: "type" and "read" describe what the sprite's hands are doing, not
 * a sentence a screen-reader user should have to decode into "dispatching
 * work". This is the one place that translates the loop name back into prose,
 * and it exists only for that — the canvas never calls it.
 */
function managerActivityLabel(animation: ManagerView['animation']): string {
  switch (animation) {
    case 'read':
      return 'reviewing the plan';
    case 'type':
      return 'dispatching work to the floor';
    case 'idle_relaxed':
      return 'done for this run';
    case 'idle_slumped':
      return 'dealing with a failed run';
    case 'idle':
    case 'walk':
      return 'idle';
  }
}

function OfficeTextAlternative({
  manager,
  characters,
  density,
  selectedAssignmentId,
  onSelectAssignment,
  onFocusAssignment,
}: {
  manager: ManagerView;
  characters: readonly CharacterView[];
  density: PlateDensity;
  selectedAssignmentId: string | undefined;
  onSelectAssignment: ((assignmentId: string) => void) | undefined;
  onFocusAssignment: (assignmentId: string | undefined) => void;
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
        {manager.name} (Manager): {managerActivityLabel(manager.animation)}.
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
          {characters.map((view) => (
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
                {/* Status first, then whatever the density adds — the plate's
                    own lines, joined. Status is not on the plate because the
                    canvas carries it in the character's pose and bubble, which
                    is exactly the channel a screen-reader user does not have. */}
                {view.status}: {plateLines(view, density).join(', ')}
              </button>
            </li>
          ))}
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

export function OfficeCanvas({
  run,
  onSelectAssignment,
  selectedAssignmentId,
  context,
  density = 'normal',
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
      <OfficeTextAlternative
        manager={scene.manager}
        characters={scene.characters}
        density={density}
        selectedAssignmentId={selectedAssignmentId}
        onSelectAssignment={onSelectAssignment}
        onFocusAssignment={setIndicatedId}
      />
    </div>
  );
}
