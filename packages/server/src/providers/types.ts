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
  /**
   * Absolute path to what the task is ABOUT (`RunState.subjectPath`), when the
   * run was given one — a repository or directory the agent may READ.
   *
   * Separate from `workspaceDir` because the two grant different things and
   * must never be confused: the workspace is where an agent writes, and this is
   * somewhere it may only look. `apiTools.ts` and `mcpTools.ts` enforce that
   * asymmetry structurally (no write tool can even name this root); this field
   * is how the value reaches them.
   *
   * Absent means no subject was supplied, which is every run before the feature
   * existed and every run started without `--subject`. The brief already tells
   * the agent the path either way — this is what makes the tools able to honour
   * it, on the three adapters that sandbox file access to a single root.
   */
  subjectPath?: string;
  /** Aborted on cancel or timeout (FR-M8, FR-M9). Providers must honour it. */
  signal: AbortSignal;

  /**
   * The agent's catalog `model:` frontmatter, verbatim — `sonnet`, `haiku` or
   * `inherit` are the only values the vendored catalog uses, and 8 of the 156
   * agents omit it entirely.
   *
   * Deliberately the catalog's own vocabulary rather than a resolved API model
   * id, because there is no single id these words map to: `sonnet` names a
   * concrete model to the Anthropic API, is a first-class alias to the Claude
   * Code CLI, and means nothing at all to OpenAI or DeepSeek. Resolving it here
   * would force this seam to pick one provider's naming, which is the exact
   * coupling the seam exists to prevent. Each adapter resolves it in the way its
   * own engine can, and says so when it cannot.
   *
   * `inherit` is a catalog convention meaning "whatever the run is using", not a
   * model name — never send it to an engine.
   *
   * An explicit provider-level model (the `--model` flag, or the settings panel)
   * outranks this: it is a direct instruction about this run, whereas the
   * frontmatter is the catalog's standing default for the agent.
   */
  model?: string;
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
