import { describe, expect, it } from 'vitest';
import { runTotalUsage, totalUsage } from '@agent-office/shared';
import { MemoryRunStore } from '../store/memoryStore.js';
import { stubDeliverable, testProviderFactory, testRegistry } from '../http/fixtures.js';
import { MANAGER_PLAN_ASSIGNMENT_ID, MANAGER_SYNTHESIS_ASSIGNMENT_ID } from './manager.js';
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

    // `totalUsage` is assignments-only; `runTotalUsage` adds the Manager's own
    // turns. This test is about that difference existing at all — that manager
    // spend is recorded somewhere rather than vanishing.
    //
    // It used to add that `totalUsage` "scopes the FR-M8 dispatch budget and
    // must stay assignments-only". It no longer does, and the claim was the
    // defect: a run whose Manager alone blew the budget completed anyway. The
    // budget now checks `runTotalUsage`, which is what "per-run token budget"
    // meant all along.
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

describe('executeRun — manager event log (NFR-7 replay)', () => {
  // Before this fix, `manager.ts`'s `runManagerTurn` never called
  // `store.appendEvent` — only `dispatcher.ts` did, and only for the
  // assignments it dispatches. Planning and synthesis streamed `usage` and
  // `text` events live through `onEvent`, but none of them ever reached
  // `logs/*.jsonl`, so `GET /api/runs/:id/events` (NFR-7 replay) reconstructed
  // total silence for the two turns that, on this very fixture, spend more
  // tokens (320 in / 100 out) than the whole team combined.

  it('persists the planning turn into logs/manager-plan.jsonl', async () => {
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'log the planning turn',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    const planEvents = await store.readEvents(run.id, MANAGER_PLAN_ASSIGNMENT_ID);
    expect(planEvents.length).toBeGreaterThan(0);
    expect(planEvents.some((logged) => logged.event.t === 'usage')).toBe(true);
    expect(planEvents.some((logged) => logged.event.t === 'text')).toBe(true);
    expect(planEvents.every((logged) => logged.event.assignmentId === MANAGER_PLAN_ASSIGNMENT_ID)).toBe(
      true,
    );
  });

  it('persists the synthesis turn into logs/manager-synthesis.jsonl', async () => {
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'log the synthesis turn',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    const synthesisEvents = await store.readEvents(run.id, MANAGER_SYNTHESIS_ASSIGNMENT_ID);
    expect(synthesisEvents.length).toBeGreaterThan(0);
    expect(synthesisEvents.some((logged) => logged.event.t === 'usage')).toBe(true);
    expect(synthesisEvents.some((logged) => logged.event.t === 'text')).toBe(true);
  });

  it('keeps manager events out of every real assignment\'s own log', async () => {
    // The reserved ids must land in their own files, never mixed into an
    // assignment's log — otherwise replay would attribute the Manager's text
    // to whichever agent happens to log around the same moment.
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'keep manager and assignment logs separate',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.assignments.length).toBeGreaterThan(0);
    for (const assignment of run.assignments) {
      const events = await store.readEvents(run.id, assignment.id);
      expect(events.every((logged) => logged.event.assignmentId === assignment.id)).toBe(true);
    }
  });
});
