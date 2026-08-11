import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunState } from '@agent-office/shared';
import type { PlateDensity } from '../theme/useTheme.js';
import { buildScene, plateLines, type CharacterView, type SceneContext } from './model.js';
import { createOfficeScene, type OfficeSceneRenderer } from './scene.js';
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
function OfficeTextAlternative({
  characters,
  density,
  selectedAssignmentId,
  onSelectAssignment,
  onFocusAssignment,
}: {
  characters: readonly CharacterView[];
  density: PlateDensity;
  selectedAssignmentId: string | undefined;
  onSelectAssignment: ((assignmentId: string) => void) | undefined;
  onFocusAssignment: (assignmentId: string | undefined) => void;
}): JSX.Element {
  return (
    <div className="visually-hidden visually-hidden-focusable office-alt">
      <h3 id="office-alt-heading">Office floor</h3>
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
    </div>
  );
}

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

  // The canvas is `aria-hidden`: it carries no information the list beside it
  // does not, and leaving it exposed would announce an unlabelled graphic
  // immediately before the same content in readable form.
  return (
    <div className="office-canvas">
      <div ref={hostRef} className="office-stage" aria-hidden="true" />
      <OfficeTextAlternative
        characters={scene.characters}
        density={density}
        selectedAssignmentId={selectedAssignmentId}
        onSelectAssignment={onSelectAssignment}
        onFocusAssignment={setIndicatedId}
      />
    </div>
  );
}
