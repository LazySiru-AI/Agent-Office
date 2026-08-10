import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isRunTerminal,
  type CreateRunRequest,
  type LoggedAgentEvent,
  type RunState,
  type RunSummary,
} from '@agent-office/shared';
import { cancelRun, createRun, fetchRuns } from '../api.js';
import { RunSocket, type SocketStatus } from './socket.js';

/**
 * Central run-session state (PLAN.md Phase 3, deliverable 3).
 *
 * One `RunSocket` is opened for the lifetime of the app. This hook owns it,
 * plus every piece of state that socket feeds: the run list, the currently
 * selected run's `RunState`, its event stream and its orchestrator log lines.
 *
 * The contract in `wire.ts` is deliberately designed so a client never merges
 * a partial update: `snapshot` and `state` are full replacements of
 * `RunState`, so this hook always assigns wholesale on those. Only `event`
 * and `log` are append-only deltas.
 */

const SELECTED_RUN_STORAGE_KEY = 'agent-office.selectedRunId';
/** Soft client-side caps, independent of the server's own ring buffers
 * (`EVENT_BUFFER_LIMIT` / `LOG_BUFFER_LIMIT`), so a very long-lived tab
 * watching a very chatty run doesn't grow its arrays without bound. */
const MAX_CLIENT_EVENTS = 4_000;
const MAX_CLIENT_LOGS = 1_000;

export interface LogLine {
  ts: number;
  line: string;
}

function readStoredRunId(): string | undefined {
  try {
    return window.localStorage.getItem(SELECTED_RUN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined; // localStorage can throw in private-browsing / disabled-storage modes
  }
}

function writeStoredRunId(runId: string | undefined): void {
  try {
    if (runId === undefined) window.localStorage.removeItem(SELECTED_RUN_STORAGE_KEY);
    else window.localStorage.setItem(SELECTED_RUN_STORAGE_KEY, runId);
  } catch {
    // best-effort persistence only
  }
}

export interface UseAgentOfficeResult {
  runs: RunSummary[];
  runsError: string | undefined;

  selectedRunId: string | undefined;
  run: RunState | undefined;
  events: LoggedAgentEvent[];
  logs: LogLine[];
  /** Whether the subscribed run is still executing server-side. */
  live: boolean;
  /** True when the server's event buffer had already dropped older history. */
  truncated: boolean;

  socketStatus: SocketStatus;
  /** Last `error` frame from the server, or a local transport error. */
  socketError: string | undefined;

  /**
   * The provider that executed the selected run, as recorded server-side on
   * `RunState`. Absent only for runs persisted before that field existed.
   */
  selectedRunProvider: string | undefined;

  selectRun: (runId: string) => void;
  startRun: (req: CreateRunRequest) => Promise<string>;
  cancelSelectedRun: () => Promise<void>;
}

export function useAgentOffice(): UseAgentOfficeResult {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsError, setRunsError] = useState<string | undefined>(undefined);

  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(readStoredRunId);
  const [run, setRun] = useState<RunState | undefined>(undefined);
  const [events, setEvents] = useState<LoggedAgentEvent[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [live, setLive] = useState(false);
  const [truncated, setTruncated] = useState(false);

  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting');
  const [socketError, setSocketError] = useState<string | undefined>(undefined);

  const socketRef = useRef<RunSocket | undefined>(undefined);
  // Mirrors `selectedRunId` inside the message handler without re-creating the
  // socket (and thus the closure) on every selection change.
  const selectedRunIdRef = useRef<string | undefined>(selectedRunId);
  selectedRunIdRef.current = selectedRunId;

  useEffect(() => {
    const socket = new RunSocket({
      onStatusChange: setSocketStatus,
      onParseError: (error) => {
        // eslint-disable-next-line no-console -- deliberately ugly Phase 3: no telemetry pipeline yet
        console.warn('discarding malformed server message', error);
      },
      onMessage: (msg) => {
        switch (msg.t) {
          case 'hello':
            break; // liveRunIds isn't surfaced yet — the run list already conveys this
          case 'snapshot':
            if (msg.run.id !== selectedRunIdRef.current) break; // stale reply for a since-abandoned subscription
            setRun(msg.run);
            setEvents(msg.events);
            // The snapshot carries no log-line history (wire.ts only buffers
            // it separately for live push); the log pane necessarily starts
            // empty on reattach and fills from here on.
            setLogs([]);
            setLive(msg.live);
            setTruncated(msg.truncated);
            break;
          case 'state':
            if (msg.run.id !== selectedRunIdRef.current) break;
            setRun(msg.run);
            setLive(!isRunTerminal(msg.run.status));
            break;
          case 'event':
            if (msg.runId !== selectedRunIdRef.current) break;
            setEvents((prev) => appendCapped(prev, msg.event, MAX_CLIENT_EVENTS));
            break;
          case 'log':
            if (msg.runId !== selectedRunIdRef.current) break;
            setLogs((prev) => appendCapped(prev, { ts: msg.ts, line: msg.line }, MAX_CLIENT_LOGS));
            break;
          case 'runs':
            setRuns(msg.runs);
            break;
          case 'error':
            if (msg.runId !== undefined && msg.runId !== selectedRunIdRef.current) break;
            setSocketError(msg.message);
            break;
          case 'pong':
            break;
        }
      },
    });
    socketRef.current = socket;
    socket.connect();

    const initial = readStoredRunId();
    if (initial !== undefined) socket.subscribe(initial);

    return () => {
      socket.close();
      socketRef.current = undefined;
    };
    // Intentionally empty deps: the socket is created once for the app's
    // lifetime. Selection changes are handled via `selectedRunIdRef` plus the
    // explicit subscribe/unsubscribe calls in `selectRun`, not by recreating
    // this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchRuns()
      .then(setRuns)
      .catch((error: unknown) => setRunsError(describeError(error)));
  }, []);

  const selectRun = useCallback((runId: string) => {
    if (runId === selectedRunIdRef.current) return;
    socketRef.current?.subscribe(runId);
    setSelectedRunId(runId);
    writeStoredRunId(runId);
    setRun(undefined);
    setEvents([]);
    setLogs([]);
    setLive(false);
    setTruncated(false);
    setSocketError(undefined);
  }, []);

  const startRun = useCallback(async (req: CreateRunRequest): Promise<string> => {
    const runId = await createRun(req);
    selectRun(runId);
    // Best-effort refresh in case the server's own 'runs' push hasn't arrived
    // yet by the time this resolves.
    fetchRuns()
      .then(setRuns)
      .catch(() => undefined);
    return runId;
  }, [selectRun]);

  const cancelSelectedRun = useCallback(async (): Promise<void> => {
    if (selectedRunId === undefined) return;
    await cancelRun(selectedRunId);
  }, [selectedRunId]);

  // Read off the run itself, so it is correct for any run — including ones
  // this tab never started and ones from a previous browser session.
  const selectedRunProvider = run?.provider;

  return {
    runs,
    runsError,
    selectedRunId,
    run,
    events,
    logs,
    live,
    truncated,
    socketStatus,
    socketError,
    selectedRunProvider,
    selectRun,
    startRun,
    cancelSelectedRun,
  };
}

function appendCapped<T>(prev: T[], next: T, max: number): T[] {
  const combined = [...prev, next];
  return combined.length > max ? combined.slice(combined.length - max) : combined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
