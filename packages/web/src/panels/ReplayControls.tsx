import { REPLAY_SPEEDS, type ReplayLoadState, type ReplaySpeed } from '../state/useReplay.js';

/**
 * Play/pause/scrub/speed controls for NFR-7 replay.
 *
 * Deliberately unstyled, matching the rest of Phase 3's UI (`RunHeader.tsx`,
 * `AssignmentTable.tsx`) — plain semantic HTML, no component library. Props
 * mirror `UseReplayResult` from `../state/useReplay.js` rather than taking
 * the hook result object wholesale, following this codebase's existing panel
 * convention (`RunHeaderProps`, `AssignmentTableProps`) of individually named
 * props plus `on*` callbacks.
 *
 * Accessibility: every control is a real `<button>` or a labelled
 * `<input type="range">`, so keyboard/tab navigation and screen readers get
 * this for free — no click-handler-on-a-`<div>` shortcuts.
 */
export interface ReplayControlsProps {
  loadState: ReplayLoadState;
  error: string | undefined;
  /** True when the underlying `RunEventsResponse` was partial — some log couldn't be read. */
  partial: boolean;
  durationMs: number;
  positionMs: number;
  playing: boolean;
  speed: ReplaySpeed;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (ms: number) => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
}

export function ReplayControls({
  loadState,
  error,
  partial,
  durationMs,
  positionMs,
  playing,
  speed,
  onPlay,
  onPause,
  onSeek,
  onSpeedChange,
}: ReplayControlsProps): JSX.Element {
  if (loadState === 'idle') {
    return <p className="muted">No run selected for replay.</p>;
  }

  if (loadState === 'loading') {
    return <p className="muted">Loading replay…</p>;
  }

  if (loadState === 'error') {
    return <p className="form-error">Replay failed to load{error !== undefined && `: ${error}`}</p>;
  }

  // loadState === 'ready' from here down.
  const hasEvents = durationMs > 0;

  return (
    <div className="replay-controls">
      <div className="replay-controls-row">
        <button type="button" onClick={playing ? onPause : onPlay} disabled={!hasEvents} aria-pressed={playing}>
          {playing ? 'Pause' : 'Play'}
        </button>

        <label htmlFor="replay-speed-select">Speed</label>
        <select
          id="replay-speed-select"
          value={speed}
          onChange={(e) => onSpeedChange(Number(e.target.value) as ReplaySpeed)}
          disabled={!hasEvents}
        >
          {REPLAY_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>

        <span className="replay-elapsed">
          {formatElapsed(positionMs)} / {formatElapsed(durationMs)}
        </span>
      </div>

      {/* `styles.css` defines no visually-hidden utility class (Phase 3's UI is
          deliberately unstyled), so the label is left visible rather than
          reaching for a class that doesn't exist — still a real <label>,
          which is what keyboard/screen-reader accessibility actually needs. */}
      <label htmlFor="replay-scrub">Replay position</label>
      <input
        id="replay-scrub"
        type="range"
        min={0}
        max={durationMs}
        step={1}
        value={positionMs}
        onChange={(e) => onSeek(Number(e.target.value))}
        disabled={!hasEvents}
        aria-valuetext={`${formatElapsed(positionMs)} of ${formatElapsed(durationMs)}`}
      />

      {!hasEvents && <p className="muted">This run has no recorded events to replay yet.</p>}
      {/* `.replay-partial`, not `.muted`. The stylesheet has carried a
          `.replay-partial` rule — the amber warning tone — since Phase 8 and
          nothing ever used it, so this notice rendered in the same grey as
          "Loading…". "What you are watching is missing activity" is a caveat
          on everything else on screen; grey is the wrong weight for it. */}
      {partial && (
        <p className="replay-partial">
          Replay is partial — at least one assignment&apos;s log could not be read; the reconstruction may be
          missing activity.
        </p>
      )}
    </div>
  );
}

/** `0:00` / `1:23` — mm:ss, matching `AssignmentTable.tsx`'s duration formatting style. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
