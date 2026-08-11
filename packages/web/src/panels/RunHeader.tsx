import { isRunTerminal, type RunState } from '@agent-office/shared';
import { formatCostUsd, summariseRunCost } from '../costModel.js';
import type { SocketStatus } from '../state/socket.js';
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
  if (run === undefined) {
    return (
      <div className="run-header">
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
