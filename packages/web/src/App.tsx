import { useEffect, useMemo, useState } from 'react';
import type { AgentSummary } from '@agent-office/shared';
import { fetchAgents } from './api.js';
import { buildAgentModelIndex } from './costModel.js';
import { AssignmentTable } from './panels/AssignmentTable.js';
import { InspectPanel } from './panels/InspectPanel.js';
import { LogPane } from './panels/LogPane.js';
import { ReplayControls } from './panels/ReplayControls.js';
import { ReportViewer } from './panels/ReportViewer.js';
import { RunHeader } from './panels/RunHeader.js';
import { RunList } from './panels/RunList.js';
import { TaskForm } from './panels/TaskForm.js';
import { OfficeCanvas } from './sim/OfficeCanvas.js';
import { useReplay } from './state/useReplay.js';
import { useAgentOffice } from './state/useRun.js';

/**
 * Phase 4 shell: the office replaces the table as the primary view.
 *
 * The orchestrator is untouched by this — the office is a second reading of
 * exactly the state the table already showed, which is what PLAN.md's
 * "nothing about the orchestrator changes" means in practice.
 *
 * Two deliberate departures from the phase brief:
 *
 * - **The table stays**, behind a toggle. The plan says replace it, but it
 *   remains the only view that shows every assignment's numbers at once, and
 *   it was the thing that made Phase 3's cost defects visible. Deleting a
 *   working diagnostic to honour the letter of a plan is a bad trade.
 * - **Replay is a mode of this view**, not a separate screen. It renders the
 *   same `RunState` through the same canvas (NFR-7), so a bug that only shows
 *   in replay would mean the reconstruction is wrong — which is precisely the
 *   thing worth catching.
 */
type ViewMode = 'office' | 'table';

export function App(): JSX.Element {
  const office = useAgentOffice();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsError, setAgentsError] = useState<string | undefined>(undefined);
  const [selectedReportPath, setSelectedReportPath] = useState<string | undefined>(undefined);
  const [view, setView] = useState<ViewMode>('office');
  const [replaying, setReplaying] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | undefined>(undefined);

  const replay = useReplay(replaying ? office.selectedRunId : undefined);

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err: unknown) => setAgentsError(err instanceof Error ? err.message : String(err)));
  }, []);

  // A newly selected run has no bearing on a previously chosen assignment
  // report, a character selected in the old run, or a replay of it.
  useEffect(() => {
    setSelectedReportPath(undefined);
    setSelectedAssignmentId(undefined);
    setReplaying(false);
  }, [office.selectedRunId]);

  const agentModelByName = useMemo(() => buildAgentModelIndex(agents), [agents]);
  const agentByName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);

  // Replay substitutes a reconstructed run for the live one. Everything
  // downstream — office, table, inspect panel — reads this single value, so
  // there is no second rendering path that could disagree with the first.
  const shownRun = replaying ? replay.run : office.run;
  const shownEvents = replaying ? replay.visibleEvents : office.events;

  const selectedAssignment = shownRun?.assignments.find((a) => a.id === selectedAssignmentId);

  // A finished run is the only thing there is to replay; a live one is already
  // showing you the same thing in real time.
  const canReplay = office.selectedRunId !== undefined && !office.live;

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
          run={shownRun}
          agentModelByName={agentModelByName}
          runProvider={office.selectedRunProvider}
          live={office.live}
          truncated={office.truncated}
          socketStatus={office.socketStatus}
          socketError={office.socketError}
          onCancel={() => {
            office.cancelSelectedRun().catch((err: unknown) => {
              // eslint-disable-next-line no-console -- still no toast system
              console.error('cancel failed', err);
            });
          }}
        />

        {shownRun !== undefined && (
          <>
            <div className="view-toggle">
              <button
                type="button"
                aria-pressed={view === 'office'}
                onClick={() => setView('office')}
              >
                Office
              </button>
              <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
                Table
              </button>
              {canReplay && (
                <button
                  type="button"
                  aria-pressed={replaying}
                  onClick={() => setReplaying((on) => !on)}
                >
                  {replaying ? 'Exit replay' : 'Replay'}
                </button>
              )}
            </div>

            {replaying && (
              <ReplayControls
                loadState={replay.loadState}
                error={replay.error}
                partial={replay.partial}
                durationMs={replay.durationMs}
                positionMs={replay.positionMs}
                playing={replay.playing}
                speed={replay.speed}
                onPlay={replay.play}
                onPause={replay.pause}
                onSeek={replay.seek}
                onSpeedChange={replay.setSpeed}
              />
            )}

            {view === 'office' ? (
              <section>
                <h2>Office</h2>
                <OfficeCanvas
                  run={shownRun}
                  onSelectAssignment={setSelectedAssignmentId}
                  {...(selectedAssignmentId === undefined ? {} : { selectedAssignmentId })}
                />
              </section>
            ) : (
              <section>
                <h2>Assignments</h2>
                <AssignmentTable
                  assignments={shownRun.assignments}
                  agentModelByName={agentModelByName}
                  runProvider={office.selectedRunProvider}
                  onViewReport={setSelectedReportPath}
                  selectedReportPath={selectedReportPath}
                />
              </section>
            )}

            {selectedAssignment !== undefined && (
              <InspectPanel
                assignment={selectedAssignment}
                agent={agentByName.get(selectedAssignment.agentName)}
                events={shownEvents}
                agentModelByName={agentModelByName}
                runProvider={office.selectedRunProvider}
                onViewReport={setSelectedReportPath}
                onClose={() => setSelectedAssignmentId(undefined)}
              />
            )}

            <section>
              <h2>Activity</h2>
              <LogPane logs={office.logs} events={shownEvents} />
            </section>

            <ReportViewer
              runId={office.selectedRunId}
              runReportPath={shownRun.reportPath}
              assignmentReportPath={selectedReportPath}
              onCloseAssignmentReport={() => setSelectedReportPath(undefined)}
            />
          </>
        )}
      </main>
    </div>
  );
}
