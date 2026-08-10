import type { RunSummary } from '@agent-office/shared';

/**
 * Past and in-flight runs (`GET /api/runs`, kept live via the `runs` push
 * message). Clicking a row is how a browser refresh mid-run — or just
 * revisiting an earlier one — restores the view: the socket resubscribes,
 * the server replies with a `snapshot`, and `useAgentOffice` replaces state
 * wholesale from it.
 */
export interface RunListProps {
  runs: RunSummary[];
  selectedRunId: string | undefined;
  onSelect: (runId: string) => void;
}

export function RunList({ runs, selectedRunId, onSelect }: RunListProps): JSX.Element {
  const sorted = [...runs].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="run-list">
      <h2>Runs</h2>
      {sorted.length === 0 && <p className="muted">No runs yet.</p>}
      <ul>
        {sorted.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className={run.id === selectedRunId ? 'run-list-item selected' : 'run-list-item'}
              onClick={() => onSelect(run.id)}
            >
              <span className={`status-badge status-${run.status}`}>{run.status}</span>
              <span className="run-list-task" title={run.task}>
                {truncate(run.task, 60)}
              </span>
              {run.live && <span className="live-dot" title="executing in this server process" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
