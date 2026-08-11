import { useMemo } from 'react';
import type { AgentSummary, AssignmentState, LoggedAgentEvent } from '@agent-office/shared';
import { assignmentCostUsd, formatCostUsd } from '../costModel.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * The click-to-inspect panel (FR-S5).
 *
 * A character in the office is a person-sized target with a name over its head
 * and nothing else; everything the user might actually want to know about that
 * assignment has to live somewhere. This is that somewhere: what the agent is,
 * what it is doing right now, what it has cost, and its report once it exists.
 *
 * It reads the same `events` array the activity log does, filtered to one
 * assignment. Nothing here is computed that the orchestrator does not own — the
 * panel is a view, so a character and its panel can never disagree.
 */

export interface InspectPanelProps {
  assignment: AssignmentState | undefined;
  agent: AgentSummary | undefined;
  events: LoggedAgentEvent[];
  agentModelByName: Map<string, string | undefined>;
  runProvider: string | undefined;
  onViewReport: (path: string) => void;
  onClose: () => void;
}

/** Tool and error lines worth showing. Text chunks belong in the log, not here. */
const ACTIVITY_LIMIT = 12;

export function InspectPanel({
  assignment,
  agent,
  events,
  agentModelByName,
  runProvider,
  onViewReport,
  onClose,
}: InspectPanelProps): JSX.Element | null {
  const activity = useMemo(() => {
    if (assignment === undefined) return [];
    return events
      .filter((logged) => logged.event.assignmentId === assignment.id)
      .filter((logged) => logged.event.t === 'tool' || logged.event.t === 'error' || logged.event.t === 'artifact')
      .slice(-ACTIVITY_LIMIT)
      .reverse();
  }, [events, assignment]);

  if (assignment === undefined) return null;

  const cost = assignmentCostUsd(assignment, agentModelByName, runProvider);
  const hasReport = assignment.status === 'done' && assignment.deliverable.length > 0;

  return (
    <aside className="inspect-panel" aria-label={`Details for ${assignment.agentName}`}>
      <header className="inspect-head">
        <div>
          <h3>{assignment.agentName}</h3>
          {agent !== undefined && <p className="inspect-category">{agent.category}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      {agent !== undefined && <p className="inspect-description">{agent.description}</p>}

      <dl className="inspect-stats">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={assignment.status} />
          </dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {assignment.usage.inputTokens.toLocaleString()} in /{' '}
            {assignment.usage.outputTokens.toLocaleString()} out
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          {/* An unpriced model is shown as unknown rather than as zero — NFR-5
              asks for visibility, and a confident $0.00 on a real run is worse
              than an honest dash. */}
          <dd>{cost === undefined ? '—' : formatCostUsd(cost)}</dd>
        </div>
      </dl>

      <section className="inspect-objective">
        <h4>Objective</h4>
        <p>{assignment.objective}</p>
      </section>

      <section className="inspect-activity">
        <h4>Recent activity</h4>
        {activity.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul>
            {activity.map((logged, index) => (
              <li key={`${String(logged.ts)}-${String(index)}`}>
                {logged.event.t === 'tool' && (
                  <>
                    <strong>{logged.event.name}</strong> {logged.event.summary}
                  </>
                )}
                {logged.event.t === 'artifact' && <>wrote {logged.event.path}</>}
                {logged.event.t === 'error' && (
                  <span className={logged.event.fatal ? 'error-fatal' : 'error-warn'}>
                    {logged.event.fatal ? 'failed: ' : 'warning: '}
                    {logged.event.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {hasReport && (
        <button type="button" onClick={() => onViewReport(assignment.deliverable)}>
          Read report
        </button>
      )}
    </aside>
  );
}
