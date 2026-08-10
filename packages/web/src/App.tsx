import { useEffect, useMemo, useState } from 'react';
import type { AgentSummary } from '@agent-office/shared';
import { fetchAgents } from './api.js';
import { buildAgentModelIndex } from './costModel.js';
import { AssignmentTable } from './panels/AssignmentTable.js';
import { LogPane } from './panels/LogPane.js';
import { ReportViewer } from './panels/ReportViewer.js';
import { RunHeader } from './panels/RunHeader.js';
import { RunList } from './panels/RunList.js';
import { TaskForm } from './panels/TaskForm.js';
import { useAgentOffice } from './state/useRun.js';

/**
 * Phase 3 web shell (PLAN.md "Web shell + live wiring").
 *
 * Deliberately a plain table-and-panel layout, not the pixel office — that's
 * Phase 4. This component's only job is proving the data flow: task in,
 * statuses updating live, refresh-safe, reports readable. `useAgentOffice`
 * owns all the state; this file is composition and layout only.
 */
export function App(): JSX.Element {
  const office = useAgentOffice();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsError, setAgentsError] = useState<string | undefined>(undefined);
  const [selectedReportPath, setSelectedReportPath] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err: unknown) => setAgentsError(err instanceof Error ? err.message : String(err)));
  }, []);

  // A newly selected run has no bearing on a previously chosen assignment report.
  useEffect(() => {
    setSelectedReportPath(undefined);
  }, [office.selectedRunId]);

  const agentModelByName = useMemo(() => buildAgentModelIndex(agents), [agents]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <TaskForm onStart={office.startRun} busy={false} />
        {office.runsError !== undefined && <p className="form-error">{office.runsError}</p>}
        <RunList runs={office.runs} selectedRunId={office.selectedRunId} onSelect={office.selectRun} />
        {agentsError !== undefined && (
          <p className="form-error">agent roster unavailable: {agentsError}</p>
        )}
      </aside>

      <main className="main">
        <RunHeader
          run={office.run}
          agentModelByName={agentModelByName}
          runProvider={office.selectedRunProvider}
          live={office.live}
          truncated={office.truncated}
          socketStatus={office.socketStatus}
          socketError={office.socketError}
          onCancel={() => {
            office.cancelSelectedRun().catch((err: unknown) => {
              // eslint-disable-next-line no-console -- Phase 3 has no toast system yet
              console.error('cancel failed', err);
            });
          }}
        />

        {office.run !== undefined && (
          <>
            <section>
              <h2>Assignments</h2>
              <AssignmentTable
                assignments={office.run.assignments}
                agentModelByName={agentModelByName}
                runProvider={office.selectedRunProvider}
                onViewReport={setSelectedReportPath}
                selectedReportPath={selectedReportPath}
              />
            </section>

            <section>
              <h2>Activity</h2>
              <LogPane logs={office.logs} events={office.events} />
            </section>

            <ReportViewer
              runId={office.selectedRunId}
              runReportPath={office.run.reportPath}
              assignmentReportPath={selectedReportPath}
              onCloseAssignmentReport={() => setSelectedReportPath(undefined)}
            />
          </>
        )}
      </main>
    </div>
  );
}
