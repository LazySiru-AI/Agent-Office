import {
  estimateCostUsd,
  formatCostUsd,
  runTotalUsage,
  FREE_MODELS,
  type AgentSummary,
  type AssignmentState,
  type RunState,
  type Usage,
} from '@agent-office/shared';

/**
 * NFR-5 cost visibility, joined client-side.
 *
 * `AssignmentState` carries no `model` field — only `agentName` — so pricing
 * has to be looked up through the agent roster (`GET /api/agents`), which is
 * where the catalog's `model:` frontmatter lives. This is the intended shape
 * of the join: `DEFAULT_PRICING` in `wire.ts` is keyed by exactly the model
 * strings the registry emits (`sonnet` / `haiku` / `opus`).
 *
 * `runProvider` is `RunState.provider` — the provider that actually executed
 * the run, recorded server-side. It is a PROVIDER id (`claude-code`,
 * `anthropic`, `openai`, `deepseek`, `scripted`, `none`), never a pricing
 * key — `DEFAULT_PRICING` is keyed by CATALOG MODEL names (`sonnet` /
 * `haiku` / `opus`) and knows nothing about provider ids. The only thing the
 * provider legitimately decides is whether the run is free: `scripted` and
 * `none` call no model at all, so every assignment underneath them must
 * price at zero regardless of what the catalog says the agent would have
 * used. Every other provider is priced off the agent's catalog model, same
 * as a run with no recorded provider at all.
 */

export function buildAgentModelIndex(agents: AgentSummary[]): Map<string, string | undefined> {
  return new Map(agents.map((a) => [a.name, a.model]));
}

/** `undefined` when the model behind this assignment's agent is unknown or unpriced. */
export function effectiveModelFor(
  assignment: AssignmentState,
  agentModelByName: Map<string, string | undefined>,
  runProvider: string | undefined,
): string | undefined {
  // Previously this substituted `runProvider` for the pricing key whenever it
  // was set, which happens to work for `scripted`/`none` (they are also
  // FREE_MODELS entries) but silently breaks every real provider: `sonnet`'s
  // price never gets looked up because `DEFAULT_PRICING['claude-code']` does
  // not exist, so the run reports `partial` and shows "—" even though the
  // agent's model is priced. Only branch on the provider when it actually
  // means "this run is free" — otherwise fall through to the catalog model,
  // exactly as if no provider had been recorded at all.
  if (runProvider !== undefined && FREE_MODELS.has(runProvider)) return runProvider;
  return agentModelByName.get(assignment.agentName);
}

export function assignmentCostUsd(
  assignment: AssignmentState,
  agentModelByName: Map<string, string | undefined>,
  runProvider: string | undefined,
): number | undefined {
  const model = effectiveModelFor(assignment, agentModelByName, runProvider);
  return estimateCostUsd(assignment.usage, model);
}

export interface RunCostSummary {
  usage: Usage;
  /** `undefined` only when every assignment's model is unknown; otherwise the best-effort sum. */
  costUsd: number | undefined;
  /** True when at least one assignment's cost could not be estimated (unpriced/unknown model). */
  partial: boolean;
}

export function summariseRunCost(
  run: RunState,
  agentModelByName: Map<string, string | undefined>,
  runProvider: string | undefined,
): RunCostSummary {
  // `costUsd` stays undefined until at least one assignment prices
  // successfully, which is also exactly when we have anything worth summing.
  let costUsd: number | undefined;
  let partial = false;

  for (const assignment of run.assignments) {
    const cost = assignmentCostUsd(assignment, agentModelByName, runProvider);
    if (cost === undefined) {
      if (assignment.usage.inputTokens > 0 || assignment.usage.outputTokens > 0) partial = true;
      continue;
    }
    costUsd = (costUsd ?? 0) + cost;
  }

  // The Manager's own turns (planning, repairs, synthesis) are real spend and
  // often exceed the agents' combined usage. They have no agent and therefore
  // no catalog model, so they can only be priced when the run records its
  // provider — otherwise they count towards `partial` rather than being
  // silently dropped from the total.
  const managerUsage = run.managerUsage;
  if (managerUsage !== undefined) {
    const managerCost = estimateCostUsd(managerUsage, runProvider);
    if (managerCost === undefined) {
      if (managerUsage.inputTokens > 0 || managerUsage.outputTokens > 0) partial = true;
    } else {
      costUsd = (costUsd ?? 0) + managerCost;
    }
  }

  return { usage: runTotalUsage(run), costUsd, partial };
}

export { formatCostUsd };
