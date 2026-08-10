import { useEffect, useRef } from 'react';
import type { RunState } from '@agent-office/shared';
import { buildScene } from './model.js';
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
}

export function OfficeCanvas({ run, onSelectAssignment, selectedAssignmentId }: OfficeCanvasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<OfficeSceneRenderer | undefined>(undefined);

  // The renderer is constructed once per mount and never recreated just
  // because a callback prop's identity changed; the latest callback is read
  // through this ref instead, from inside a stable wrapper handed to Pixi.
  const onSelectRef = useRef(onSelectAssignment);
  onSelectRef.current = onSelectAssignment;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const renderer = createOfficeScene(SPRITE_MANIFEST, {
      onSelectAssignment: (assignmentId) => onSelectRef.current?.(assignmentId),
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
    rendererRef.current?.update(buildScene(run));
  }, [run]);

  useEffect(() => {
    rendererRef.current?.setSelected(selectedAssignmentId);
  }, [selectedAssignmentId]);

  return <div ref={hostRef} className="office-canvas" />;
}
