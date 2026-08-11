import { useEffect, useMemo, useRef } from 'react';
import type { LoggedAgentEvent } from '@agent-office/shared';
import { formatToolLine } from '../sim/model.js';
import type { LogLine } from '../state/useRun.js';

/**
 * Live, auto-scrolling feed of orchestrator log lines and agent events
 * (NFR-3: the UI must reflect provider output within ~500ms — this is where
 * that shows up). Both sources are merged into one chronological list rather
 * than shown in separate panes, since reading them side by side is how you
 * correlate "the dispatcher moved to phase 2" with "agent X actually started
 * working" while debugging the orchestrator.
 */
export interface LogPaneProps {
  logs: LogLine[];
  events: LoggedAgentEvent[];
}

/**
 * How close to the bottom counts as "following the tail", in CSS pixels.
 * Roughly two lines at this pane's 0.8rem monospace — enough to absorb
 * sub-pixel scroll positions without treating a deliberate scroll-back of a
 * screenful as still being at the end.
 */
const FOLLOW_TAIL_THRESHOLD_PX = 32;

interface FeedLine {
  ts: number;
  key: string;
  kind: 'log' | 'event';
  text: string;
}

export function LogPane({ logs, events }: LogPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  const feed = useMemo<FeedLine[]>(() => {
    const logLines: FeedLine[] = logs.map((l, i) => ({
      ts: l.ts,
      key: `log-${i}-${l.ts}`,
      kind: 'log',
      text: l.line,
    }));
    const eventLines: FeedLine[] = events.map((e, i) => ({
      ts: e.ts,
      key: `event-${i}-${e.ts}`,
      kind: 'event',
      text: formatEvent(e),
    }));
    return [...logLines, ...eventLines].sort((a, b) => a.ts - b.ts);
  }, [logs, events]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    // Follow the tail only while the reader is already AT the tail. This used
    // to run unconditionally on every new line, so scrolling back through a
    // live run to read what an agent did was undone by the next event —
    // roughly once a second on a busy run, which makes the history in this
    // pane unreadable precisely while it is being written.
    //
    // The threshold is a few lines rather than exact equality: a fractional
    // `scrollTop` from a trackpad, or a line arriving mid-scroll, should still
    // count as "at the bottom".
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= FOLLOW_TAIL_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [feed.length]);

  return (
    <div
      className="log-pane"
      ref={containerRef}
      /* A 260px box with `overflow-y: auto` and nothing focusable inside it is
         unreachable by keyboard: there is no way to put the caret in it and no
         way to scroll it (WCAG 2.1.1). `tabIndex={0}` makes it a focus target,
         which is what lets the arrow keys and Page Up/Down act on it, and the
         browser's own scroll handling does the rest.

         `role="log"` gives it a name and a purpose, and marks it as a feed
         that appends. It is deliberately NOT `aria-live="polite"` on top of
         that: this pane emits several lines a second on a real run, and
         announcing each would render a screen reader useless for the rest of
         the page. The things that genuinely need announcing announce
         themselves — see `RunHeader`'s `role="alert"` on a run error. */
      tabIndex={0}
      role="log"
      aria-label="Run activity"
    >
      {feed.length === 0 && <p className="muted">No activity yet.</p>}
      {feed.map((line) => (
        <div key={line.key} className={`log-line log-line-${line.kind}`}>
          <span className="log-ts">{formatTime(line.ts)}</span>
          <span className="log-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function formatEvent(logged: LoggedAgentEvent): string {
  const e = logged.event;
  switch (e.t) {
    case 'status':
      return `[${e.assignmentId}] status -> ${e.status}`;
    case 'text':
      return `[${e.assignmentId}] ${truncate(e.chunk, 200)}`;
    // `formatToolLine` rather than an inline template: the office's desk plate
    // (FR-S10) states the same fact, and two spellings of one event is how a
    // UI comes to feel assembled rather than designed.
    case 'tool':
      return `[${e.assignmentId}] tool: ${formatToolLine(e.name, e.summary)}`;
    case 'artifact':
      return `[${e.assignmentId}] artifact: ${e.path}`;
    case 'usage':
      return `[${e.assignmentId}] usage +${e.inputTokens} in / +${e.outputTokens} out`;
    case 'error':
      return `[${e.assignmentId}] ${e.fatal ? 'ERROR' : 'warning'}: ${e.message}`;
  }
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
