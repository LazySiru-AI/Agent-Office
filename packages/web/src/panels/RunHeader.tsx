import { useEffect, useRef, useState } from 'react';
import { isRunTerminal, type RunState, type RunStatus } from '@agent-office/shared';
import { formatCostUsd, summariseRunCost } from '../costModel.js';
import type { SocketStatus } from '../state/socket.js';
import { runStatusAnnouncement } from '../theme/status.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * Run summary strip: status, cancel button, and the per-run NFR-5 cost
 * counters.
 *
 * The figures come from `summariseRunCost`, which is built on `runTotalUsage`
 * — assignments plus the Manager's own planning and synthesis turns — joined
 * against the agent roster. See `costModel.ts` for why that join is necessary
 * and why the run's provider decides only whether the run was free, not what
 * its model was priced as.
 */
export interface RunHeaderProps {
  run: RunState | undefined;
  agentModelByName: Map<string, string | undefined>;
  runProvider: string | undefined;
  live: boolean;
  truncated: boolean;
  socketStatus: SocketStatus;
  socketError: string | undefined;
  onCancel: () => void;
}

export function RunHeader({
  run,
  agentModelByName,
  runProvider,
  live,
  truncated,
  socketStatus,
  socketError,
  onCancel,
}: RunHeaderProps): JSX.Element {
  // A3: the run-status live region. `previousStatusRef` is what lets
  // `runStatusAnnouncement` (theme/status.ts) tell "the status actually
  // changed" apart from "this component re-rendered for some other reason" —
  // this file's own `run` prop is replaced wholesale on every `state`/
  // `snapshot` socket message (see `useRun.ts`'s `applyServerMessage`), which
  // includes updates to token usage and cost that have nothing to do with
  // status. Declared before the `run === undefined` branch below because
  // React hooks cannot be called conditionally — this component used to have
  // none at all, so that branch could return early with no consequence; now
  // it can't move ahead of these.
  const previousStatusRef = useRef<RunStatus | undefined>(undefined);
  const [announcement, setAnnouncement] = useState<string | undefined>(undefined);

  useEffect(() => {
    const next = run?.status;
    const message = runStatusAnnouncement(previousStatusRef.current, next);
    // Only overwrite `announcement` when there is something new to say.
    // Leaving the previous text in place on a `undefined` result means the
    // live region keeps announcing "the last thing worth saying" rather than
    // flapping to silence and back on every render, which some screen
    // readers treat as two announcements of the same text rather than one.
    if (message !== undefined) setAnnouncement(message);
    previousStatusRef.current = next;
  }, [run?.status]);

  // `role="status"` + `aria-live="polite"`, not `role="alert"`
  // (assertive) like `run.error` below: a finished/waiting transition is
  // worth hearing about but should not interrupt whatever the screen reader
  // is already reading, the way an assertive region does. Visually hidden —
  // `StatusBadge` already shows the same information to sighted users, so
  // this exists purely for the announcement, not as a second visible copy.
  const statusLiveRegion = (
    <p className="visually-hidden" role="status" aria-live="polite">
      {announcement}
    </p>
  );

  if (run === undefined) {
    return (
      <div className="run-header">
        {statusLiveRegion}
        <p className="muted">
          Select a run from the list, or start a new one below. Connection: {socketStatus}
          {socketStatus !== 'open' && ' (reconnecting…)'}
        </p>
        {socketError !== undefined && <p className="form-error">{socketError}</p>}
      </div>
    );
  }

  const cost = summariseRunCost(run, agentModelByName, runProvider);
  const canCancel = !isRunTerminal(run.status) && live;

  return (
    <div className="run-header">
      {statusLiveRegion}
      <div className="run-header-row">
        {/* `<h2>`, not `<h1>`. The page's one top-level heading is the app
            title in the sidebar; a machine-generated run id is not the name of
            the document, and making it `h1` also meant there was no `h1` at
            all until a run had been selected. See `.run-id` in styles.css —
            this looks exactly as it did. */}
        <h2 className="run-id">{run.id}</h2>
        <StatusBadge status={run.status} />
        {canCancel && (
          <button type="button" className="cancel-button" onClick={onCancel}>
            Cancel run
          </button>
        )}
        <span className="muted">socket: {socketStatus}</span>
      </div>
      <p className="run-task">{run.task}</p>
      <p className="run-cost">
        Tokens: {cost.usage.inputTokens} in / {cost.usage.outputTokens} out — Est. cost:{' '}
        {formatCostUsd(cost.costUsd)}
        {cost.partial && ' (partial — some agents have no priced model)'}
        {runProvider !== undefined && <span className="muted"> · provider: {runProvider}</span>}
      </p>
      {truncated && <p className="muted">Event history is partial — the server's buffer had already trimmed it.</p>}
      {/* `role="alert"` (WCAG 3.3.1): a run failing is the one thing on this
          screen a user must not have to notice by watching. Everything else
          here updates continuously and would be noise if announced. */}
      {run.error !== undefined && (
        <p className="form-error" role="alert">
          {run.error}
        </p>
      )}
    </div>
  );
}
