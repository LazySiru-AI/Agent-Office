import { useMemo, useState } from 'react';
import type { RunSummary } from '@agent-office/shared';
import { EMPTY_QUERY, countRuns, formatAge, queryRuns, type RunFilter } from '../state/runHistory.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * Past and in-flight runs (`GET /api/runs`, kept live via the `runs` push
 * message). Clicking a row is how a browser refresh mid-run — or just
 * revisiting an earlier one — restores the view: the socket resubscribes,
 * the server replies with a `snapshot`, and `useAgentOffice` replaces state
 * wholesale from it.
 *
 * Phase 7 turned this from a list into a browser. The trigger was ordinary:
 * after five phases of testing there are fifty runs here, most of them starting
 * with the word "Review", and picking one out meant reading every row. Search
 * and filters live in `state/runHistory.ts` rather than here — this component
 * deliberately holds no logic beyond the query it is currently showing, because
 * the web package has no component-testing setup and anything hidden in JSX is
 * something no test can reach.
 */
export interface RunListProps {
  runs: RunSummary[];
  selectedRunId: string | undefined;
  onSelect: (runId: string) => void;
}

const FILTERS: { value: RunFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'finished', label: 'Done' },
  { value: 'failed', label: 'Failed' },
];

export function RunList({ runs, selectedRunId, onSelect }: RunListProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<RunFilter>(EMPTY_QUERY.filter);

  // Counted against the unfiltered list, so the numbers on the buttons do not
  // flicker as the search is typed.
  const counts = useMemo(() => countRuns(runs), [runs]);
  const shown = useMemo(() => queryRuns(runs, { search, filter }), [runs, search, filter]);

  // One timestamp for the whole render. Calling `Date.now()` per row would make
  // two rows a millisecond apart round differently for no reason.
  const now = Date.now();

  return (
    <div className="run-list">
      <h2>Runs</h2>

      {runs.length > 0 && (
        <div className="run-list-controls">
          <label className="run-list-search">
            <span className="muted">Search</span>
            <input
              type="search"
              value={search}
              placeholder="task or date"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          <div role="group" aria-label="Filter runs" className="run-list-filters">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label} {counts[option.value]}
              </button>
            ))}
          </div>
        </div>
      )}

      {runs.length === 0 && <p className="muted">No runs yet.</p>}
      {/* Distinguished from "no runs at all": one is a new install, the other
          is a search that needs changing, and telling a user "No runs yet"
          when they have fifty is just wrong. */}
      {runs.length > 0 && shown.length === 0 && (
        <p className="muted">No runs match that search.</p>
      )}

      <ul>
        {shown.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className={run.id === selectedRunId ? 'run-list-item selected' : 'run-list-item'}
              onClick={() => onSelect(run.id)}
            >
              <span className="run-list-head">
                <StatusBadge status={run.status} />
                {run.live && <span className="live-dot" title="executing in this server process" />}
                <span className="run-list-age">{formatAge(run.updatedAt, now)}</span>
              </span>
              <span className="run-list-task" title={run.task}>
                {truncate(run.task, 60)}
              </span>
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
