import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isRunTerminal,
  type CreateRunRequest,
  type LoggedAgentEvent,
  type RunState,
  type RunSummary,
  type ServerMessage,
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
 *
 * ## Why the socket handler is one pure fold, not six `useState` setters
 *
 * `applyServerMessage` below is the entire transition table as a single pure
 * function — `(state, message, selectedRunId) -> state` — rather than a
 * `useEffect` closure calling `setRun`/`setEvents`/`setLogs`/`setLive`/
 * `setTruncated` individually. That mirrors `useReplay.ts`'s `foldEvents` and
 * `useSettings.ts`'s `parseStoredSettings`/`validateSettings`: this package's
 * web tests run under plain Node with no DOM, so the only way to exercise
 * "does a snapshot correctly replace live-accumulated events" or "does a
 * truncated snapshot get reflected" is to pull the transition logic out where
 * a test can call it directly (`useRun.test.ts`), not only indirectly by
 * rendering the hook and driving a real socket through it.
 */

const SELECTED_RUN_STORAGE_KEY = 'agent-office.selectedRunId';
/** Soft client-side caps, independent of the server's own ring buffers
 * (`EVENT_BUFFER_LIMIT` / `LOG_BUFFER_LIMIT`), so a very long-lived tab
 * watching a very chatty run doesn't grow its arrays without bound. */
export const MAX_CLIENT_EVENTS = 4_000;
export const MAX_CLIENT_LOGS = 1_000;

export interface LogLine {
  ts: number;
  line: string;
}

/** Everything the socket's messages feed, folded into one value so a single
 * pure function (`applyServerMessage`) can own every transition. */
export interface RunSessionState {
  run: RunState | undefined;
  events: LoggedAgentEvent[];
  logs: LogLine[];
  live: boolean;
  truncated: boolean;
  runs: RunSummary[];
  socketError: string | undefined;
}

export const INITIAL_SESSION_STATE: RunSessionState = {
  run: undefined,
  events: [],
  logs: [],
  live: false,
  truncated: false,
  runs: [],
  socketError: undefined,
};

/**
 * The one place every inbound `ServerMessage` becomes the next
 * `RunSessionState`. `selectedRunId` is passed in rather than read off
 * `state` because the hook tracks it in a ref (`selectedRunIdRef`), not
 * state — a ref so that changing the selection does not recreate the
 * socket's effect (see `useAgentOffice` below).
 *
 * `snapshot` and `state` are full replacements per `wire.ts` §2's contract
 * ("clients therefore never need to merge a partial update"); `event` and
 * `log` are the only append-only deltas. Getting that distinction backwards
 * — e.g. appending a snapshot's events onto whatever had already
 * accumulated from live `event` messages — would silently duplicate history
 * on every reconnect, which is exactly what NFR-2 promises will not happen.
 */
export function applyServerMessage(
  state: RunSessionState,
  msg: ServerMessage,
  selectedRunId: string | undefined,
): RunSessionState {
  switch (msg.t) {
    case 'hello':
      return state; // liveRunIds isn't surfaced yet — the run list already conveys this
    case 'snapshot':
      if (msg.run.id !== selectedRunId) return state; // stale reply for a since-abandoned subscription
      return {
        ...state,
        run: msg.run,
        events: msg.events,
        // The snapshot carries no log-line history (wire.ts only buffers it
        // separately for live push); the log pane necessarily starts empty
        // on reattach and fills from here on.
        logs: [],
        live: msg.live,
        truncated: msg.truncated,
      };
    case 'state':
      if (msg.run.id !== selectedRunId) return state;
      return { ...state, run: msg.run, live: !isRunTerminal(msg.run.status) };
    case 'event':
      if (msg.runId !== selectedRunId) return state;
      return { ...state, events: appendCapped(state.events, msg.event, MAX_CLIENT_EVENTS) };
    case 'log':
      if (msg.runId !== selectedRunId) return state;
      return { ...state, logs: appendCapped(state.logs, { ts: msg.ts, line: msg.line }, MAX_CLIENT_LOGS) };
    case 'runs':
      return { ...state, runs: msg.runs };
    case 'error':
      if (msg.runId !== undefined && msg.runId !== selectedRunId) return state;
      return { ...state, socketError: msg.message };
    case 'pong':
      return state;
  }
}

/**
 * What selecting a different run resets. `runs` (the sidebar's run list) is
 * not scoped to any one selection, so it survives; everything else describes
 * the previously-selected run and must not leak into the newly-selected
 * one's view (e.g. showing the old run's events for a heartbeat before the
 * new snapshot arrives).
 */
export function selectionReset(state: RunSessionState): RunSessionState {
  return { ...INITIAL_SESSION_STATE, runs: state.runs };
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
  const [session, setSession] = useState<RunSessionState>(INITIAL_SESSION_STATE);
  const [runsError, setRunsError] = useState<string | undefined>(undefined);

  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(readStoredRunId);

  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting');

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
        setSession((prev) => applyServerMessage(prev, msg, selectedRunIdRef.current));
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
      .then((runs) => setSession((prev) => ({ ...prev, runs })))
      .catch((error: unknown) => setRunsError(describeError(error)));
  }, []);

  const selectRun = useCallback((runId: string) => {
    if (runId === selectedRunIdRef.current) return;
    socketRef.current?.subscribe(runId);
    setSelectedRunId(runId);
    writeStoredRunId(runId);
    setSession(selectionReset);
  }, []);

  const startRun = useCallback(async (req: CreateRunRequest): Promise<string> => {
    const runId = await createRun(req);
    selectRun(runId);
    // Best-effort refresh in case the server's own 'runs' push hasn't arrived
    // yet by the time this resolves.
    fetchRuns()
      .then((runs) => setSession((prev) => ({ ...prev, runs })))
      .catch(() => undefined);
    return runId;
  }, [selectRun]);

  const cancelSelectedRun = useCallback(async (): Promise<void> => {
    if (selectedRunId === undefined) return;
    await cancelRun(selectedRunId);
  }, [selectedRunId]);

  // Read off the run itself, so it is correct for any run — including ones
  // this tab never started and ones from a previous browser session.
  const selectedRunProvider = session.run?.provider;

  return {
    runs: session.runs,
    runsError,
    selectedRunId,
    run: session.run,
    events: session.events,
    logs: session.logs,
    live: session.live,
    truncated: session.truncated,
    socketStatus,
    socketError: session.socketError,
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
