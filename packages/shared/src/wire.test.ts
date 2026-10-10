import { describe, expect, it } from 'vitest';
import { CreateRunRequestSchema } from './wire.js';

/**
 * `CreateRunRequestSchema.maxCostUsd` (FR-M8).
 *
 * This field closes a defect: the web settings panel has always sent a
 * "Cost budget (USD, optional)" value, but the schema had no field for it, so
 * it was dropped before ever reaching `RunSupervisor.startRun` — the per-
 * assignment spend cap was documented and tested in isolation while every
 * real run ignored it. These tests pin the schema half of the fix; the wiring
 * half is covered in `packages/server/src/http/supervisor.test.ts` and
 * `server.test.ts`, which prove the value actually reaches `makeProvider`.
 */
describe('CreateRunRequestSchema.maxCostUsd', () => {
  it('accepts a positive cap and leaves it undefined when omitted', () => {
    const withCap = CreateRunRequestSchema.parse({ task: 'Analyse the thing.', maxCostUsd: 2.5 });
    expect(withCap.maxCostUsd).toBe(2.5);

    const withoutCap = CreateRunRequestSchema.parse({ task: 'Analyse the thing.' });
    expect(withoutCap.maxCostUsd).toBeUndefined();
  });

  it('rejects zero, because a spend cap of zero is not "no cap"', () => {
    const result = CreateRunRequestSchema.safeParse({ task: 'Analyse the thing.', maxCostUsd: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative cap', () => {
    const result = CreateRunRequestSchema.safeParse({ task: 'Analyse the thing.', maxCostUsd: -5 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-finite cap, which a strict client can only send via a hand-built body', () => {
    const result = CreateRunRequestSchema.safeParse({
      task: 'Analyse the thing.',
      maxCostUsd: Number.POSITIVE_INFINITY,
    });
    expect(result.success).toBe(false);
  });
});
