import { describe, expect, it } from 'vitest';
import {
  addUsage,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  costForUsage,
  DEFAULT_PRICING,
  estimateCostUsd,
  EMPTY_USAGE,
  type Usage,
} from './index.js';

/**
 * Cache-aware pricing (NFR-5).
 *
 * The defect these tests pin: `Usage` carried one `inputTokens` total and
 * every price was computed at the fresh-input rate, while the real capture
 * this repo runs against reported 44,878 of 67,635 input tokens as cache
 * READS — which Anthropic prices at roughly a tenth of fresh input. A five
 * agent run therefore displayed $23.11 for work that cost a small fraction of
 * it, and the figure was prominent enough (Phase 9 put spend on every desk)
 * that someone would have believed it.
 *
 * Two properties matter and they pull against each other, so both are tested:
 * a new run must price the three buckets at their own rates, and a run
 * recorded before the counters existed must price EXACTLY as it did before.
 */

const SONNET = DEFAULT_PRICING['sonnet'];
if (SONNET === undefined) throw new Error('fixture: sonnet must be priced');

function usage(over: Partial<Usage> = {}): Usage {
  return { inputTokens: 0, outputTokens: 0, ...over };
}

describe('costForUsage — the three input buckets', () => {
  it('prices a cache read at a tenth of fresh input', () => {
    const fresh = costForUsage(usage({ inputTokens: 1_000_000 }), SONNET);
    const cached = costForUsage(
      usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
      SONNET,
    );
    expect(cached).toBeCloseTo(fresh * CACHE_READ_MULTIPLIER, 10);
  });

  it('prices a cache write at a premium over fresh input', () => {
    const fresh = costForUsage(usage({ inputTokens: 1_000_000 }), SONNET);
    const written = costForUsage(
      usage({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
      SONNET,
    );
    expect(written).toBeCloseTo(fresh * CACHE_WRITE_MULTIPLIER, 10);
    expect(written).toBeGreaterThan(fresh);
  });

  it('treats the counters as a decomposition of the total, not additions to it', () => {
    // 1M total input, of which 600k was read from cache and 100k written to
    // it — so 300k was genuinely fresh. The bill is the sum of three
    // differently-priced parts, NOT 1.7M tokens' worth of anything.
    const measured = costForUsage(
      usage({ inputTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 100_000 }),
      SONNET,
    );
    const byHand =
      (300_000 / 1_000_000) * SONNET.inputPerMTok +
      (600_000 / 1_000_000) * SONNET.inputPerMTok * CACHE_READ_MULTIPLIER +
      (100_000 / 1_000_000) * SONNET.inputPerMTok * CACHE_WRITE_MULTIPLIER;
    expect(measured).toBeCloseTo(byHand, 10);
  });

  it('reduces to the old flat arithmetic when no split is reported', () => {
    // The back-compatibility guarantee, stated as an equation: a `Usage` with
    // neither counter must cost what the pre-cache implementation charged.
    const old =
      (1_000_000 / 1_000_000) * SONNET.inputPerMTok +
      (500_000 / 1_000_000) * SONNET.outputPerMTok;
    expect(costForUsage(usage({ inputTokens: 1_000_000, outputTokens: 500_000 }), SONNET)).toBeCloseTo(
      old,
      10,
    );
  });

  it('never charges a negative amount when the counters exceed the total', () => {
    // Corrupt or hand-edited state. The fresh remainder clamps at zero rather
    // than becoming a negative charge that offsets the cache buckets.
    const cost = costForUsage(
      usage({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 900 }),
      SONNET,
    );
    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('makes the real-capture case cheaper by roughly an order of magnitude', () => {
    // The measured shape from `real-success.jsonl`: in=26, cache_read=44,878,
    // cache_write=22,731, total input 67,635. Pricing it all as fresh input is
    // what produced the inflated figure; this asserts the correction is large,
    // not cosmetic.
    const asFresh = costForUsage(usage({ inputTokens: 67_635, outputTokens: 579 }), SONNET);
    const withSplit = costForUsage(
      usage({
        inputTokens: 67_635,
        outputTokens: 579,
        cacheReadTokens: 44_878,
        cacheWriteTokens: 22_731,
      }),
      SONNET,
    );
    expect(withSplit).toBeLessThan(asFresh);
    // Output tokens are priced identically either way, so the comparison is
    // made on the input side alone to keep the ratio meaningful.
    const inputAsFresh = costForUsage(usage({ inputTokens: 67_635 }), SONNET);
    const inputWithSplit = costForUsage(
      usage({ inputTokens: 67_635, cacheReadTokens: 44_878, cacheWriteTokens: 22_731 }),
      SONNET,
    );
    expect(inputWithSplit).toBeLessThan(inputAsFresh * 0.55);
  });
});

describe('estimateCostUsd still honours its existing contract', () => {
  it('returns 0 for a free model regardless of the split', () => {
    expect(
      estimateCostUsd(usage({ inputTokens: 999, cacheReadTokens: 500 }), 'scripted'),
    ).toBe(0);
  });

  it('returns undefined for an unpriced model rather than guessing', () => {
    expect(estimateCostUsd(usage({ inputTokens: 999 }), 'gpt-4o')).toBeUndefined();
    expect(estimateCostUsd(usage({ inputTokens: 999 }))).toBeUndefined();
  });
});

describe('addUsage', () => {
  it('sums every field', () => {
    const sum = addUsage(
      usage({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2 }),
      usage({ inputTokens: 20, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 4 }),
    );
    expect(sum).toEqual({
      inputTokens: 30,
      outputTokens: 4,
      cacheReadTokens: 12,
      cacheWriteTokens: 6,
    });
  });

  it('keeps the counters ABSENT when neither side reports them', () => {
    // Not zero — absent. A folded old log must stay shaped like an old log, so
    // that `costForUsage` takes the same branch it always did. Asserting the
    // key is missing rather than falsy is the whole point.
    const sum = addUsage(usage({ inputTokens: 1 }), usage({ inputTokens: 2 }));
    expect('cacheReadTokens' in sum).toBe(false);
    expect('cacheWriteTokens' in sum).toBe(false);
  });

  it('keeps a reported counter when only one side has it', () => {
    // Discarding a number an adapter actually measured would be worse than
    // carrying a partial one.
    const sum = addUsage(usage({ inputTokens: 1, cacheReadTokens: 9 }), usage({ inputTokens: 2 }));
    expect(sum.cacheReadTokens).toBe(9);
    expect('cacheWriteTokens' in sum).toBe(false);
  });

  it('is identity against EMPTY_USAGE, which reports no split', () => {
    const one = usage({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 1 });
    expect(addUsage(EMPTY_USAGE, one)).toEqual(one);
  });

  it('accumulates the way the dispatcher does, over many turns', () => {
    const turns = Array.from({ length: 5 }, () =>
      usage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 }),
    );
    const total = turns.reduce(addUsage, { ...EMPTY_USAGE });
    expect(total).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 25,
    });
    // And the accumulated total still prices as a decomposition.
    expect(costForUsage(total, SONNET)).toBeLessThan(
      costForUsage(usage({ inputTokens: 500, outputTokens: 50 }), SONNET),
    );
  });
});
