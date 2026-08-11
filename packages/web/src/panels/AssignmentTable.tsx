import type { AssignmentState } from '@agent-office/shared';
import { assignmentCostUsd, formatCostUsd } from '../costModel.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * The plain table PLAN.md Phase 3 asks for — no office sim yet (that's
 * Phase 4). Every column is a direct read of `AssignmentState`; nothing here
 * derives status itself, matching §1.5's rule that the sim (and this table,
 * its ancestor) never invents state the orchestrator doesn't own.
 *
 * Covers every `AssignmentStatus` from `status.ts`:
 * pending | briefing | working | blocked | reporting | done | failed | skipped.
 */
export interface AssignmentTableProps {
  assignments: AssignmentState[];
  agentModelByName: Map<string, string | undefined>;
  runProvider: string | undefined;
  onViewReport: (reportPath: string) => void;
  selectedReportPath: string | undefined;
}

export function AssignmentTable({
  assignments,
  agentModelByName,
  runProvider,
  onViewReport,
  selectedReportPath,
}: AssignmentTableProps): JSX.Element {
  if (assignments.length === 0) {
    return <p className="muted">No assignments yet — the Manager hasn't finished planning.</p>;
  }

  return (
    <table className="assignment-table">
      <thead>
        <tr>
          <th>Id</th>
          <th>Agent</th>
          <th>Phase</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Tokens (in / out)</th>
          <th>Cost</th>
          <th>Duration</th>
          <th>Report</th>
        </tr>
      </thead>
      <tbody>
        {assignments.map((a) => {
          const cost = assignmentCostUsd(a, agentModelByName, runProvider);
          return (
            <tr key={a.id} className={a.status === 'failed' ? 'row-failed' : undefined}>
              <td>{a.id}</td>
              <td>{a.agentName}</td>
              <td>{a.phaseId}</td>
              <td>
                <StatusBadge status={a.status} />
              </td>
              <td>{a.attempts}</td>
              <td>
                {a.usage.inputTokens} / {a.usage.outputTokens}
              </td>
              <td>{formatCostUsd(cost)}</td>
              <td>{formatDuration(a.startedAt, a.endedAt)}</td>
              <td>
                {a.reportPath !== undefined ? (
                  <button
                    type="button"
                    className={a.reportPath === selectedReportPath ? 'link-button selected' : 'link-button'}
                    onClick={() => onViewReport(a.reportPath as string)}
                  >
                    view
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function formatDuration(startedAt: number | undefined, endedAt: number | undefined): string {
  if (startedAt === undefined) return '—';
  const end = endedAt ?? Date.now();
  const seconds = Math.max(0, (end - startedAt) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rest}s`;
}
