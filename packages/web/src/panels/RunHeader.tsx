import { isRunTerminal, type RunState } from '@agent-office/shared';
import { formatCostUsd, summariseRunCost } from '../costModel.js';
import type { SocketStatus } from '../state/socket.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * Run summary strip: status, cancel button, and the per-run NFR-5 cost
 * counters (`totalUsage` + `estimateCostUsd` from `shared`, joined against
 * the agent roster — see `costModel.ts` for why that join is necessary).
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
        <h1>{run.id}</h1>
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
      {run.error !== undefined && <p className="form-error">{run.error}</p>}
    </div>
  );
}
