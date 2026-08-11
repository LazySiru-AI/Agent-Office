import { describe, expect, it } from 'vitest';
import { runTotalUsage, totalUsage } from '@agent-office/shared';
import { MemoryRunStore } from '../store/memoryStore.js';
import { stubDeliverable, testProviderFactory, testRegistry } from '../http/fixtures.js';
import { executeRun } from './runner.js';

/**
 * Run-level bookkeeping that only `executeRun` can do (NFR-5).
 *
 * The dispatcher records usage per assignment, but the Manager's own turns are
 * not assignments — nothing below this layer ever sees them. These tests exist
 * because a cost display built on assignment usage alone silently understated
 * every run: on a three-agent run the Manager outspends the whole team.
 */

describe('executeRun — run provenance', () => {
  it('records the provider that executed the run', async () => {
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'record the provider',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    // Without this, cost falls back to each agent's catalog model and a
    // scripted run — which calls no model at all — reports money as spent.
    expect(run.provider).toBe('scripted');
  });
});

describe('executeRun — manager token accounting (NFR-5)', () => {
  it('accumulates planning and synthesis usage into managerUsage', async () => {
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'count the manager',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    // The fixture scripts planning at 120/40 and synthesis at 200/60.
    expect(run.managerUsage).toEqual({ inputTokens: 320, outputTokens: 100 });
  });

  it('keeps manager usage out of the dispatch budget total', async () => {
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'separate the totals',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    // `totalUsage` scopes the FR-M8 dispatch budget and must stay
    // assignments-only; `runTotalUsage` is what a user is shown.
    const assignments = totalUsage(run);
    const whole = runTotalUsage(run);

    expect(whole.inputTokens).toBe(assignments.inputTokens + 320);
    expect(whole.outputTokens).toBe(assignments.outputTokens + 100);
    expect(whole.inputTokens).toBeGreaterThan(assignments.inputTokens);
  });

  it('records manager usage even when the run never reaches synthesis', async () => {
    // Planning succeeds and bills tokens; the lead assignment then fails, which
    // strands both reviewers that depend on it. Nothing produces a report, so
    // the run ends without a synthesis turn — but the planning spend was real.
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory({
        lead: { failWith: 'provider exploded' },
      })(),
      store: new MemoryRunStore(),
      task: 'bill planning anyway',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('failed');
    expect(run.managerUsage?.inputTokens).toBe(120);
    expect(run.managerUsage?.outputTokens).toBe(40);
  });
});
