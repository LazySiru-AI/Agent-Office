import type { AgentEvent } from '@agent-office/shared';

/**
 * The provider seam (PLAN.md §1.6).
 *
 * Every engine — the Claude Code CLI in Phase 1, raw APIs in Phase 7 — is
 * flattened to this one interface. The orchestrator must never learn which
 * provider it is talking to; that is the whole reason swapping engines later is
 * a dropdown rather than a rewrite.
 *
 * Deviation from PLAN.md §1.6, recorded deliberately: `AgentRunRequest` carries
 * an `assignmentId`. The plan's sketch omitted it, but every `AgentEvent` is
 * stamped with one, so the provider needs it to emit well-formed events. The
 * alternative — having the caller rewrite every event — puts provider knowledge
 * back in the orchestrator.
 */

export const PROVIDER_IDS = ['claude-code', 'anthropic', 'openai', 'deepseek', 'scripted'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface AgentRunRequest {
  /** Stamped onto every emitted event. */
  assignmentId: string;
  /** The agent's markdown body, used verbatim as the system prompt. */
  systemPrompt: string;
  /** The full brief: user task, this agent's objective, upstream reports. */
  task: string;
  /** From the agent's `tools:` frontmatter. The provider must not exceed it. */
  allowedTools: string[];
  /** Absolute path. NFR-1: the provider must not read or write outside this. */
  workspaceDir: string;
  /** Aborted on cancel or timeout (FR-M8, FR-M9). Providers must honour it. */
  signal: AbortSignal;
}

export interface ProviderAvailability {
  ok: boolean;
  /** Human-readable explanation when `ok` is false, shown in the UI. */
  reason?: string;
}

export interface AgentProvider {
  readonly id: ProviderId;

  /**
   * Preflight check. Called before a run starts so a missing CLI or absent API
   * key surfaces as a clear message rather than a mid-run failure.
   */
  isAvailable(): Promise<ProviderAvailability>;

  /**
   * Execute one assignment, streaming normalised events as they arrive.
   *
   * Contract:
   * - Must emit at least one `text` event carrying the agent's final answer.
   * - Should emit `usage` at least once; the orchestrator sums them (NFR-5).
   * - Must terminate the iterable when `signal` aborts.
   * - Should emit `error` with `fatal: true` rather than throwing, where it can;
   *   a thrown error is still handled, but loses the partial event stream.
   */
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
}

/** Thrown when a provider cannot start at all. Distinguished from a run failure. */
export class ProviderUnavailableError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, reason: string) {
    super(`provider "${providerId}" is unavailable: ${reason}`);
    Object.setPrototypeOf(this, ProviderUnavailableError.prototype);
    this.name = 'ProviderUnavailableError';
    this.providerId = providerId;
  }
}
