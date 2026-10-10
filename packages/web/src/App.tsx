import { useCallback, useEffect, useMemo, useState } from 'react';
import { isRunTerminal, type AgentSummary } from '@agent-office/shared';
import type { ProviderInfo } from '@agent-office/shared';
import { fetchAgents, fetchProviders } from './api.js';
import { buildAgentModelIndex, summariseRunCost } from './costModel.js';
import { AssignmentTable } from './panels/AssignmentTable.js';
import { AuthRecovery } from './panels/AuthRecovery.js';
import { DisplayControls } from './panels/DisplayControls.js';
import { InspectPanel } from './panels/InspectPanel.js';
import { LogPane } from './panels/LogPane.js';
import { PdfDownload } from './panels/PdfDownload.js';
import { ReplayControls } from './panels/ReplayControls.js';
import { ReportViewer } from './panels/ReportViewer.js';
import { RunHeader } from './panels/RunHeader.js';
import { RunList } from './panels/RunList.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { TaskForm } from './panels/TaskForm.js';
import { TeamReview } from './panels/TeamReview.js';
import { ClarifyPanel } from './panels/ClarifyPanel.js';
import { OfficeCanvas } from './sim/OfficeCanvas.js';
import { latestToolByAssignment } from './sim/model.js';
import { useReplay } from './state/useReplay.js';
import { useAgentOffice } from './state/useRun.js';
import { useSettings } from './state/useSettings.js';
import { useTheme } from './theme/useTheme.js';

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
  // Owned at the shell, not inside a panel: `applyBootTheme()` has already
  // painted the palette before React existed (see `main.tsx`), and this hook
  // takes ownership of it from the first commit onwards. Mounting it anywhere
  // conditional would mean the palette stops tracking the OS the moment that
  // branch unmounts.
  const theme = useTheme();
  const settings = useSettings();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  // A provider the server has already said it cannot construct is not a
  // settings *error* — the value is perfectly valid — but starting a run with
  // it is guaranteed to fail a moment later. Blocking here turns a confusing
  // mid-run failure into a reason shown next to the control that caused it.
  // Unknown providers are not blocked: an empty or failed `/api/providers`
  // must not lock the user out of starting anything.
  const selectedProvider = providers.find((p) => p.id === settings.settings.provider);
  const providerUnavailable = selectedProvider !== undefined && !selectedProvider.available;
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsError, setAgentsError] = useState<string | undefined>(undefined);
  const [selectedReportPath, setSelectedReportPath] = useState<string | undefined>(undefined);
  const [view, setView] = useState<ViewMode>('office');
  const [replaying, setReplaying] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | undefined>(undefined);

  const replay = useReplay(replaying ? office.selectedRunId : undefined);

  // Pulled out of the mount effect below so S9's recovery flow can call the
  // exact same fetch again after a token is re-supplied, rather than this
  // app having two independently-maintained ways to populate `agents`. See
  // `handleReauth` further down for the other half.
  const refreshAgents = useCallback(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err: unknown) => setAgentsError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; refreshAgents is stable (empty deps)
  }, []);

  // Availability depends on the server's environment — a key, a CLI on its
  // PATH — so the browser has to ask. A failure here is deliberately not
  // surfaced as an error: the settings panel simply shows no providers, which
  // is honest, and the run itself still reports a real reason if one is picked.
  //
  // Same "pulled out for S9's reauth retry" reasoning as `refreshAgents` above.
  const refreshProviders = useCallback(() => {
    fetchProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    refreshProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; refreshProviders is stable (empty deps)
  }, []);

  /**
   * S9: the one place this shell reacts to a token being re-supplied.
   * `office.reauthenticate` (state/useRun.ts) already handles the token
   * itself — storage, the live `authToken` binding, the socket reconnect,
   * and re-fetching the run list (which is what re-arms `office.unauthorized`
   * if the token turns out to still be wrong). `agents` and `providers` are
   * fetched by THIS component, not by `useAgentOffice`, so they are not
   * covered by that retry — a 401 on either of them during the outage would
   * otherwise stay stuck showing its old error/empty state forever, even
   * after the run list and the socket had both recovered. Re-running both
   * fetches here is the same "supply a token and retry" promise, applied to
   * the two pieces of state this component itself owns.
   */
  const handleReauth = useCallback(
    (token: string) => {
      office.reauthenticate(token);
      refreshAgents();
      refreshProviders();
    },
    [office.reauthenticate, refreshAgents, refreshProviders],
  );

  // A newly selected run has no bearing on a previously chosen assignment
  // report, a character selected in the old run, or a replay of it.
  useEffect(() => {
    setSelectedReportPath(undefined);
    setSelectedAssignmentId(undefined);
    setReplaying(false);
  }, [office.selectedRunId]);

  const agentModelByName = useMemo(() => buildAgentModelIndex(agents), [agents]);
  const agentByName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);

  // D5: the one honest cost figure `TaskForm` can show without inventing an
  // estimate — the cost of the run currently loaded, IF it has already
  // finished. `office.run`, not `shownRun`: this must reflect the real
  // selected run regardless of whether replay is switched on (a replayed
  // reconstruction is not a second, different run to price), and it is data
  // this app already has loaded for the run header/table/inspect panel — no
  // extra fetch for this. `undefined` whenever there is nothing finished to
  // report (no run selected, the run is still live, or nothing on it could be
  // priced), which is exactly when `TaskForm`'s `costHint` falls back to the
  // per-assignment cap instead.
  const lastFinishedRunCost = useMemo(() => {
    if (office.run === undefined || !isRunTerminal(office.run.status)) return undefined;
    return summariseRunCost(office.run, agentModelByName, office.selectedRunProvider).costUsd;
  }, [office.run, agentModelByName, office.selectedRunProvider]);

  // Replay substitutes a reconstructed run for the live one. Everything
  // downstream — office, table, inspect panel — reads this single value, so
  // there is no second rendering path that could disagree with the first.
  const shownRun = replaying ? replay.run : office.run;
  const shownEvents = replaying ? replay.visibleEvents : office.events;

  const selectedAssignment = shownRun?.assignments.find((a) => a.id === selectedAssignmentId);

  // FR-S10: the facts the office states on each desk. All three already
  // existed here and stopped at the assignment table — which is why the app's
  // default view was its least informative one. Memoised on the pieces rather
  // than rebuilt per render, because `OfficeCanvas` keys its scene on this
  // object's identity.
  const sceneContext = useMemo(
    () => ({
      agentModelByName,
      runProvider: office.selectedRunProvider,
      toolByAssignment: latestToolByAssignment(shownEvents),
    }),
    [agentModelByName, office.selectedRunProvider, shownEvents],
  );

  // A finished run is the only thing there is to replay; a live one is already
  // showing you the same thing in real time.
  const canReplay = office.selectedRunId !== undefined && !office.live;

  return (
    <div className="app-shell">
      {/* WCAG 2.4.1 (Bypass Blocks). The sidebar below is `TaskForm` plus a
          run list that grows one focus stop per run in history
          (`RunList.tsx`'s `<ul>`) plus settings plus display controls — a
          keyboard user landing on the page can be dozens of Tab presses from
          `<main>`. This is the textbook fix: the very first focusable
          element on the page, invisible until Tab actually reaches it (see
          `.skip-link` in styles.css), so a mouse/touch user never sees it and
          a keyboard user gets an escape hatch on the first press. Targets
          `<main>` itself, which carries `tabIndex={-1}` below for exactly
          this: a fragment jump to a non-interactive landmark moves the
          scroll position in every browser but does not reliably move FOCUS
          without the target itself being focusable (Safari in particular
          does not), and a skip link that scrolls without moving focus has
          not actually skipped anything for the keyboard user it's for. */}
      <a className="visually-hidden skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar">
        {/* The page's only `h1`, and it is here rather than on the run header
            for two reasons. It names the DOCUMENT — a run id is a name for one
            thing inside it, not for the page — and it exists before a run is
            selected, which is when the header renders a `<p>` and the app used
            to have no top-level heading at all. Everything below is `h2`, so
            the outline now reads title → sections instead of opening on a
            section and hitting the `h1` three landmarks later. */}
        <h1 className="app-title">Agent Office</h1>
        {/* Every run setting is forwarded, not just the two the form used to
            display. The panel had fields for an assignment timeout, a token
            budget and a cost budget; the form built its request from `provider`
            and `concurrency` alone, so those three were collected from the user
            and silently discarded. A control that does nothing is worse than a
            missing one — the cost budget in particular read as protection
            nobody had. */}
        <TaskForm
          onStart={office.startRun}
          provider={settings.settings.provider}
          concurrency={settings.settings.concurrency}
          assignmentTimeoutMs={settings.settings.assignmentTimeoutMs}
          {...(settings.settings.runTokenBudget === undefined
            ? {}
            : { runTokenBudget: settings.settings.runTokenBudget })}
          {...(settings.settings.maxCostUsd === undefined
            ? {}
            : { maxCostUsd: settings.settings.maxCostUsd })}
          {...(lastFinishedRunCost === undefined ? {} : { lastFinishedRunCostUsd: lastFinishedRunCost })}
          {...(settings.settings.reviewTeam === undefined
            ? {}
            : { reviewTeam: settings.settings.reviewTeam })}
          {...(settings.settings.clarify === undefined
            ? {}
            : { clarify: settings.settings.clarify })}
          settingsInvalid={Object.keys(settings.errors).length > 0 || providerUnavailable}
          {...(providerUnavailable
            ? { blockedReason: selectedProvider?.reason ?? `${settings.settings.provider} is unavailable` }
            : {})}
          busy={false}
        />
        {office.runsError !== undefined && <p className="form-error">{office.runsError}</p>}
        <RunList runs={office.runs} selectedRunId={office.selectedRunId} onSelect={office.selectRun} />
        {agentsError !== undefined && (
          <p className="form-error">agent roster unavailable: {agentsError}</p>
        )}

        <SettingsPanel
          settings={settings.settings}
          errors={settings.errors}
          providers={providers}
          onChange={settings.setSetting}
          onReset={settings.reset}
        />

        {/* Last in the sidebar, and outside the `shownRun` guard below: display
            preferences must be reachable before a run exists, which is exactly
            when someone lands on the app and wants the lights turned up. */}
        <DisplayControls
          themePreference={theme.themePreference}
          resolvedTheme={theme.resolvedTheme}
          onThemePreferenceChange={theme.setThemePreference}
          motionPreference={theme.motionPreference}
          resolvedMotion={theme.resolvedMotion}
          onMotionPreferenceChange={theme.setMotionPreference}
          plateDensity={theme.plateDensity}
          onPlateDensityChange={theme.setPlateDensity}
        />
      </aside>

      <main className="main" id="main-content" tabIndex={-1}>
        {/* S9: the one screen a user sees when nothing else works, so it goes
            first — ahead of even `RunHeader` below. Everything else in `main`
            keeps rendering underneath it rather than being replaced outright:
            a run header or an office floor left over from before the token
            went bad is stale, not wrong, and hiding it would throw away
            context (which run was selected, what it looked like) a user may
            still want while they go find a new token. See
            `panels/AuthRecovery.tsx`'s own header comment for the full
            reasoning, and `state/useRun.ts`'s `unauthorized`/`reauthenticate`
            for how this flag is set and cleared. */}
        {office.unauthorized && <AuthRecovery onSubmit={handleReauth} />}

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

        {/* FR-M11: the one screen a run in `awaiting_approval` needs. Placed
            immediately after the header and ahead of everything else in
            `main` — including the office/table toggle below — because this
            status means the run is not "busy", it is idle and waiting on a
            decision only a person can make, and burying that behind the
            usual view would leave a user scrolling past a static office
            floor wondering why nothing is moving.

            Deliberately keyed off `office.run` — the live state — rather
            than `shownRun`, which becomes the *replayed* reconstruction the
            moment `replaying` is on. A finished run that happened to pass
            through `awaiting_approval` on its way to completion would
            replay that frame like any other, and this panel is a form whose
            submit calls `office.submitTeam` against the real, current
            `selectedRunId`: rendering it from replayed history would offer
            an "approve" button for a decision that was already made and
            acted on, against a run that has since moved past it entirely
            (the server rejects a `/team` POST on any status other than
            `awaiting_approval` — see `wire.ts`'s `API.runTeam` — so the
            failure mode is a confusing rejected submit, not silent data
            loss, but there is no reason to invite it). */}
        {office.run !== undefined && office.run.status === 'awaiting_approval' && (
          <TeamReview plan={office.run.plan} agents={agents} onSubmit={office.submitTeam} />
        )}

        {/* FR-M12, mounted beside FR-M11's panel and keyed off the live run for
            all the same reasons the long comment above gives — most of all that
            a replayed run passing back through `awaiting_clarification` must not
            re-offer a form for a question that was answered days ago. */}
        {office.run !== undefined &&
          office.run.status === 'awaiting_clarification' &&
          office.run.clarification !== undefined && (
            <ClarifyPanel
              questions={office.run.clarification.questions}
              onSubmit={office.submitClarification}
            />
          )}

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
                  context={sceneContext}
                  density={theme.plateDensity}
                  agentByName={agentByName}
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

            <section>
              <h2>Deliverable</h2>
              <PdfDownload
                runId={office.selectedRunId}
                pdfPath={shownRun.pdfPath}
                theme={shownRun.theme}
                rationale={shownRun.designRationale}
                runStatus={shownRun.status}
                pdfError={shownRun.pdfError}
              />
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
