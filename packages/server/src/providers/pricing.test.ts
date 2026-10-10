import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING } from '@agent-office/shared';
import { estimateRunCostUsd, priceFor } from './pricing.js';

/**
 * The join between concrete HTTP-adapter model ids and `wire.ts`'s
 * tier-keyed `DEFAULT_PRICING` table. See `pricing.ts`'s module doc for why
 * this join exists and why it refuses rather than guesses for OpenAI and
 * DeepSeek ids.
 */

describe('priceFor', () => {
  it('prices a concrete Anthropic sonnet-tier id as the sonnet tier', () => {
    expect(priceFor('claude-sonnet-5')).toEqual(DEFAULT_PRICING['sonnet']);
  });

  it('prices a concrete Anthropic haiku-tier id as the haiku tier', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(DEFAULT_PRICING['haiku']);
  });

  it('prices a concrete Anthropic opus-tier id as the opus tier', () => {
    expect(priceFor('claude-opus-5')).toEqual(DEFAULT_PRICING['opus']);
  });

  it('recognises a tier word regardless of case', () => {
    expect(priceFor('Claude-Sonnet-5')).toEqual(DEFAULT_PRICING['sonnet']);
  });

  it('returns undefined for an OpenAI model id, because no OpenAI price has ever been verified here', () => {
    expect(priceFor('gpt-4o')).toBeUndefined();
  });

  it('returns undefined for a hyphen-free OpenAI id that names no tier word', () => {
    expect(priceFor('o1')).toBeUndefined();
  });

  it('returns undefined for a DeepSeek model id, because no DeepSeek price has ever been verified here', () => {
    expect(priceFor('deepseek-chat')).toBeUndefined();
  });

  it('returns undefined for a model id that names no recognised tier word at all', () => {
    expect(priceFor('some-future-model-9')).toBeUndefined();
  });
});

describe('estimateRunCostUsd', () => {
  it('computes the same figure DEFAULT_PRICING would for a priced model', () => {
    const usage = { inputTokens: 2_000_000, outputTokens: 1_000_000 };
    const sonnet = DEFAULT_PRICING['sonnet'];
    expect(sonnet).toBeDefined();
    const expected = 2 * (sonnet?.inputPerMTok ?? 0) + 1 * (sonnet?.outputPerMTok ?? 0);
    expect(estimateRunCostUsd(usage, 'claude-sonnet-5')).toBeCloseTo(expected, 10);
  });

  it('returns undefined for an unpriced model rather than a guessed figure', () => {
    expect(estimateRunCostUsd({ inputTokens: 1000, outputTokens: 500 }, 'gpt-4o')).toBeUndefined();
  });

  it('returns zero for zero usage on a priced model', () => {
    expect(estimateRunCostUsd({ inputTokens: 0, outputTokens: 0 }, 'claude-haiku-4-5-20251001')).toBe(0);
  });
});
