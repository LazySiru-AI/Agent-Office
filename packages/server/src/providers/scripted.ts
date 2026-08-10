import type { AgentEvent } from '@agent-office/shared';
import type {
  AgentProvider,
  AgentRunRequest,
  ProviderAvailability,
  ProviderId,
} from './types.js';

/**
 * A deterministic fake provider.
 *
 * Phase 2 builds the orchestrator before Phase 1's Claude Code adapter exists,
 * so the dispatcher needs something to drive. This is that something — and it
 * outlives the stopgap, because testing retries, timeouts, cancellation and
 * partial failure against a real LLM would be slow, costly and non-deterministic.
 *
 * It is registered as a real `ProviderId` (`scripted`) rather than hidden in
 * test files so the run CLI can use it for a no-cost dry run.
 */

export interface ScriptedResponse {
  /** Emitted as the assignment's output, and written as its report. */
  text?: string;
  /** Tool events emitted before the text, for exercising the inspect panel. */
  toolCalls?: Array<{ name: string; summary: string }>;
  usage?: { inputTokens: number; outputTokens: number };
  /** Emit a fatal error instead of text, to exercise failure handling. */
  failWith?: string;
  /** Emit a non-fatal error before the text, to exercise NFR-8 degradation. */
  warnWith?: string;
  /** Artificial latency per event, so concurrency limits are observable. */
  delayMs?: number;
  /**
   * Never produce a terminal event; run until aborted. Exercises the
   * per-assignment timeout (FR-M8) and cancellation (FR-M9).
   */
  hang?: boolean;
}

export interface ScriptedProviderOptions {
  /** Response per agent name. Falls back to `fallback` when absent. */
  byAgent?: Record<string, ScriptedResponse>;
  /** Response per assignment id. Takes precedence over `byAgent`. */
  byAssignment?: Record<string, ScriptedResponse>;
  /** Used when neither map matches. */
  fallback?: ScriptedResponse;
  /** Lets tests simulate a provider that cannot start at all. */
  availability?: ProviderAvailability;
  /** Injected so tests can assert on what the orchestrator actually sent. */
  onRequest?: (request: AgentRunRequest) => void;
}

const DEFAULT_FALLBACK: ScriptedResponse = {
  text: 'Scripted response.',
  usage: { inputTokens: 100, outputTokens: 50 },
};

export class ScriptedProvider implements AgentProvider {
  readonly id: ProviderId = 'scripted';

  /** Every request received, in order. Assertion surface for tests. */
  readonly requests: AgentRunRequest[] = [];

  /** Peak simultaneous `run` calls. Proves the concurrency cap (FR-M4). */
  private inFlight = 0;
  private peak = 0;

  constructor(private readonly options: ScriptedProviderOptions = {}) {}

  get peakConcurrency(): number {
    return this.peak;
  }

  async isAvailable(): Promise<ProviderAvailability> {
    return this.options.availability ?? { ok: true };
  }

  /**
   * Resolve which scripted response applies. Assignment id wins over agent name
   * so a test can single out one assignment of several sharing an agent.
   */
  private responseFor(request: AgentRunRequest): ScriptedResponse {
    return (
      this.options.byAssignment?.[request.assignmentId] ??
      this.options.byAgent?.[agentNameHint(request)] ??
      this.options.fallback ??
      DEFAULT_FALLBACK
    );
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    this.options.onRequest?.(request);

    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);

    try {
      const response = this.responseFor(request);
      const { assignmentId } = request;

      if (request.signal.aborted) return;

      for (const call of response.toolCalls ?? []) {
        await pause(response.delayMs, request.signal);
        if (request.signal.aborted) return;
        yield { t: 'tool', assignmentId, name: call.name, summary: call.summary };
      }

      if (response.warnWith !== undefined) {
        yield { t: 'error', assignmentId, message: response.warnWith, fatal: false };
      }

      if (response.hang === true) {
        await untilAborted(request.signal);
        return;
      }

      await pause(response.delayMs, request.signal);
      if (request.signal.aborted) return;

      if (response.failWith !== undefined) {
        yield { t: 'error', assignmentId, message: response.failWith, fatal: true };
        return;
      }

      const usage = response.usage ?? DEFAULT_FALLBACK.usage;
      if (usage !== undefined) {
        yield {
          t: 'usage',
          assignmentId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        };
      }

      yield { t: 'text', assignmentId, chunk: response.text ?? DEFAULT_FALLBACK.text ?? '' };
    } finally {
      this.inFlight -= 1;
    }
  }
}

/**
 * The agent name is not a field on the request — the provider only ever sees a
 * system prompt. Tests key on agent name for readability, so the scripted
 * provider recovers it from the marker the brief builder emits. Falls back to
 * the empty string, which simply misses the `byAgent` map.
 */
function agentNameHint(request: AgentRunRequest): string {
  const match = /^<!-- agent: ([a-z0-9-]+) -->$/m.exec(request.task);
  return match?.[1] ?? '';
}

function pause(ms: number | undefined, signal: AbortSignal): Promise<void> {
  if (ms === undefined || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
