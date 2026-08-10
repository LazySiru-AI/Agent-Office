import { useEffect, useMemo, useRef } from 'react';
import type { LoggedAgentEvent } from '@agent-office/shared';
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
    el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  return (
    <div className="log-pane" ref={containerRef}>
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
    case 'tool':
      return `[${e.assignmentId}] tool: ${e.name} — ${e.summary}`;
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
