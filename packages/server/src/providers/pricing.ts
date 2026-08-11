import { DEFAULT_PRICING, type Usage } from '@agent-office/shared';

/**
 * Joins a concrete HTTP-adapter model id to `wire.ts`'s tier-keyed pricing
 * table (Phase 7's cost-cap gap — see `anthropic/provider.ts` and
 * `openai/provider.ts` for where this actually gets used).
 *
 * `DEFAULT_PRICING` (in `packages/shared/src/wire.ts`) is keyed by the
 * CATALOG's tier words — `opus`, `sonnet`, `haiku` — because that is the
 * vocabulary agent frontmatter uses and the only vocabulary the web UI's cost
 * display needs. The HTTP adapters, by contrast, send a concrete model id
 * straight to a vendor's API — `claude-sonnet-5`,
 * `claude-haiku-4-5-20251001` — and never see the bare tier word at all once
 * `apiConfig.ts`'s `resolveAgentModel` has translated it. This file is the
 * missing join between the two: given a concrete id, which tier's price (if
 * any) applies.
 *
 * **These prices are exactly as approximate as `wire.ts`'s are, and drift for
 * the same reason.** They exist to give an order-of-magnitude figure and to
 * make a spend cap enforceable at all — not to reproduce a vendor invoice.
 * Nothing in this file, or anywhere else in this repository, has ever been
 * checked against a real bill; see `wire.ts`'s own module doc and
 * `anthropic/provider.ts`'s "no API key exists on this machine" note, which
 * both carry over unchanged to this join.
 */

/** Tier words this repo has a price for, reused rather than restated — see `DEFAULT_PRICING`. */
const TIER_WORDS = Object.keys(DEFAULT_PRICING);

export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * Recognise a catalog price tier inside a concrete model id, case-
 * insensitively — `claude-sonnet-5` and `claude-haiku-4-5-20251001` both
 * contain their tier word verbatim, because Anthropic's own public id scheme
 * embeds it in every model name it has shipped. Substring matching rather
 * than an exhaustive id list because a fixed list would need a code change on
 * every new model release, and would fail closed (the honest outcome) rather
 * than silently going stale — the same trade `apiConfig.ts`'s
 * `resolveAgentModel` makes for passthrough ids.
 *
 * Returns `undefined` — never a guessed price — for anything that does not
 * contain a recognised tier word. That is every OpenAI and DeepSeek model id
 * this repo has ever sent (`gpt-4o`, `o1`, `deepseek-chat`, …): no price for
 * either vendor has ever been verified here, so inventing one would put a
 * wrong number in front of someone's money, which is worse than admitting
 * "unknown". Callers that need a cost cap enforced (`maxCostUsd` in both HTTP
 * adapters) treat an `undefined` price here as "cannot enforce a cap for this
 * model" and refuse to run rather than run uncapped — see each adapter's
 * `isAvailable()`.
 */
export function priceFor(model: string): ModelPrice | undefined {
  const lower = model.toLowerCase();
  const tier = TIER_WORDS.find((word) => lower.includes(word));
  return tier === undefined ? undefined : DEFAULT_PRICING[tier];
}

/**
 * Estimate the USD cost of one usage figure against a concrete model id, or
 * `undefined` when {@link priceFor} cannot price that id.
 *
 * Deliberately not a call into `wire.ts`'s own `estimateCostUsd`: that
 * function's `model` parameter expects a tier word or a `FREE_MODELS` entry,
 * not a concrete API id — handing it `claude-sonnet-5` would silently miss
 * (`DEFAULT_PRICING['claude-sonnet-5']` is `undefined`) rather than resolve.
 * `priceFor` is the join that makes a concrete id usable; this applies the
 * same arithmetic `wire.ts` uses once that join has succeeded, so the two
 * never disagree about what a token costs even though they key their input
 * differently.
 *
 * `usage` can be one turn's figures or a running total — this function does
 * no accumulation of its own. Both HTTP adapters accumulate the run's
 * estimated spend themselves, turn by turn, so they can compare it against
 * `maxCostUsd` between rounds; see each adapter's `run()`.
 */
export function estimateRunCostUsd(usage: Usage, model: string): number | undefined {
  const price = priceFor(model);
  if (price === undefined) return undefined;
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}
