import { describe, expect, it } from 'vitest';
import { runTotalUsage, totalUsage, type RunState, type TeamOperation } from '@agent-office/shared';
import type { DiagnosticInput } from '../diagnostics/log.js';
import { MemoryRunStore } from '../store/memoryStore.js';
import {
  stubDeliverable,
  testProviderFactory,
  testRegistry,
  waitFor,
  TEST_PLAN,
  TEST_SYNTHESIS,
} from '../http/fixtures.js';
import { ScriptedProvider } from '../providers/scripted.js';
import { MANAGER_PLAN_ASSIGNMENT_ID, MANAGER_SYNTHESIS_ASSIGNMENT_ID } from './manager.js';
import { executeRun, SYNTHESIS_REPORT_PATH } from './runner.js';

/**
 * A promise this file can settle from the outside, standing in for the real
 * `awaitTeamApproval` implementation (the HTTP layer, owned elsewhere, which
 * resolves it when a `POST .../team` request lands). Every FR-M11 test below
 * needs to control exactly when — or whether — the pause ends.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe('executeRun — the subject of the task', () => {
  it('reaches the planner AND every assignment brief, and is stamped on the run', () => {
    // The end-to-end property, because every link in this chain was a separate
    // edit and any one of them silently not wired would look exactly like the
    // defect it fixes: the planner's prompt, each specialist's brief, and the
    // persisted run all have to carry it.
    //
    // A real run of five assignments against a dashboard one directory above
    // this checkout had three specialists find it and two conclude it did not
    // exist. Same task, same brief, opposite answers — which is what makes this
    // worth an end-to-end assertion rather than three unit ones.
    return (async () => {
      // The fixture factory, not a bare ScriptedProvider: planning needs a
      // valid RunPlan back or the run fails before any brief is built. It
      // returns a ScriptedProvider, so `.requests` is still the record of every
      // prompt that went out.
      const provider = testProviderFactory()() as ScriptedProvider;
      const subjectPath = 'D:/work/Investing dashboard';

      const { run } = await executeRun({
        registry: testRegistry(),
        provider,
        store: new MemoryRunStore(),
        task: 'UAT the dashboard',
        subjectPath,
        logger: () => undefined,
        produceDeliverable: stubDeliverable(),
      });

      expect(run.subjectPath).toBe(subjectPath);

      const planning = provider.requests.filter(
        (r) => r.assignmentId === MANAGER_PLAN_ASSIGNMENT_ID,
      );
      expect(planning.length).toBeGreaterThan(0);
      expect(planning[0]?.task).toContain(subjectPath);

      // Every dispatched specialist, not just the first: an objective that
      // reaches one agent and not another is the same failure in miniature.
      const assignmentRequests = provider.requests.filter(
        (r) =>
          r.assignmentId !== MANAGER_PLAN_ASSIGNMENT_ID &&
          r.assignmentId !== MANAGER_SYNTHESIS_ASSIGNMENT_ID,
      );
      expect(assignmentRequests.length).toBeGreaterThan(1);
      for (const request of assignmentRequests) {
        expect(request.task).toContain(subjectPath);
      }
    })();
  });

  it('says nothing about a subject when none was given', () => {
    return (async () => {
      const provider = testProviderFactory()() as ScriptedProvider;

      const { run } = await executeRun({
        registry: testRegistry(),
        provider,
        store: new MemoryRunStore(),
        task: 'no subject supplied',
        logger: () => undefined,
        produceDeliverable: stubDeliverable(),
      });

      expect(run.subjectPath).toBeUndefined();
      for (const request of provider.requests) {
        expect(request.task).not.toContain('What this task is about');
      }
    })();
  });
});

describe('executeRun — what survives a run-level failure', () => {
  /** Array-backed sink; the interface exists so a test needs no filesystem. */
  function recordingSink(): {
    sink: { record: (input: DiagnosticInput) => Promise<undefined> };
    records: DiagnosticInput[];
  } {
    const records: DiagnosticInput[] = [];
    return {
      records,
      sink: {
        record: async (input: DiagnosticInput) => {
          records.push(input);
          return undefined;
        },
      },
    };
  }

  it('files a run-level failure under run-failed, not under the assignment kind', async () => {
    // `runner.ts`'s own comment has always said the dispatcher records
    // assignment failures and "by definition cannot record these: they happen
    // when there is no assignment to attach them to" — while filing them under
    // `assignment-failed` anyway. That made the distinction true in prose and
    // false in the data: an operator grouping `runs/diagnostics.jsonl` by kind
    // could not tell a planning turn that died from an agent that did.
    const { sink, records } = recordingSink();

    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory({ lead: { failWith: 'provider exploded' } })(),
      store: new MemoryRunStore(),
      task: 'file it under the right kind',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      diagnostics: sink,
    });

    expect(run.status).toBe('failed');
    const runLevel = records.filter((r) => r.kind === 'run-failed');
    expect(runLevel).toHaveLength(1);
    expect(runLevel[0]?.runId).toBe(run.id);
    // No assignment id, which is the whole reason this kind exists.
    expect(runLevel[0]?.assignmentId).toBeUndefined();
    expect(runLevel[0]?.task).toBe('file it under the right kind');
  });

  it('keeps the message a summary and puts the stack in detail', async () => {
    // The audit's finding at this boundary was not that `run.error` was wrong —
    // it is rendered in the UI and belongs as one line — but that it was ALL
    // there was. The error it came from was unrecoverable the moment the catch
    // ran, because `describe` reduces it to `.message` and nothing kept the
    // original.
    //
    // A THROWN failure, deliberately: a run can end `failed` two ways, and only
    // this one has an error object to take a stack from. The other (every
    // assignment failed) is covered by the test above, which is also where the
    // absence of `detail` there is the honest answer rather than a gap.
    const { sink, records } = recordingSink();

    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'keep the stack somewhere',
      logger: () => undefined,
      produceDeliverable: () => {
        throw new Error('headless chromium exploded');
      },
      diagnostics: sink,
    });

    expect(run.status).toBe('failed');
    const record = records.find((r) => r.kind === 'run-failed');
    expect(record?.message).toBe(run.error);
    expect(record?.message).toContain('headless chromium exploded');
    expect(record?.message).not.toContain('\n');
    // A stack, in the field the diagnostics schema leaves untruncated for it.
    expect(record?.detail).toBeDefined();
    expect(record?.detail).toContain('runner.test.ts');
  });

  it('still logs nothing for a cancellation, which is the button working', async () => {
    // Guards the decision recorded beside this code: filing a user's own Cancel
    // beside real failures would make the log's error count meaningless within
    // a week. Changing the KIND must not quietly change WHEN it is written.
    const { sink, records } = recordingSink();
    const controller = new AbortController();
    controller.abort();

    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'cancelled before it began',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      diagnostics: sink,
      signal: controller.signal,
    });

    expect(run.status).toBe('cancelled');
    expect(records).toEqual([]);
  });

  it('records a run-failed diagnostic when the token budget halts dispatch before anything completes', async () => {
    // F1: this branch used to `return` as soon as it set `run.error`, unlike
    // its two neighbours — the all-assignments-failed guard just below it,
    // and the catch-all at the end — which both file a `run-failed` record on
    // their way out. Reproduced live with a forced `--budget 1`: the run
    // failed and `runs/diagnostics.jsonl` had zero records under its run id,
    // though the whole point of that log is answering "what went wrong
    // lately" without having to know which of forty run directories to open.
    //
    // Budget 100 trips before dispatch ever starts: the fixture's planning
    // turn alone costs 160 tokens (120 in + 40 out — see
    // `testProviderFactory`), and `enforceTokenBudget` is checked against the
    // run total, planning included, before the first assignment is
    // dispatched (see `dispatcher.ts`'s own comment on that check, "NFR-5").
    const { sink, records } = recordingSink();

    const { run, dispatch } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'trip the budget before any assignment runs',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      diagnostics: sink,
      dispatch: { runTokenBudget: 100 },
    });

    expect(run.status).toBe('failed');
    expect(dispatch?.haltedBecause).toBe('token-budget');
    expect(dispatch?.completed).toBe(0);

    const runLevel = records.filter((r) => r.kind === 'run-failed');
    expect(runLevel).toHaveLength(1);
    expect(runLevel[0]?.runId).toBe(run.id);
    expect(runLevel[0]?.message).toBe(run.error);

    // F7: nothing was preserved (reports/ is empty, every assignment stayed
    // pending), so the message must not claim otherwise.
    expect(run.error).toBe(
      'run token budget exhausted before any assignment produced a report; synthesis skipped',
    );
  });

  it('keeps the "partial reports preserved" wording when the token budget halts after some work landed', async () => {
    // F7's other half, and the regression guard for it: the message must stay
    // true, in both directions, not just get more cautious. `maxConcurrency:
    // 1` makes the review phase sequential so the halt lands deterministically
    // right after `review-1` finishes and before `review-2` starts, instead of
    // racing two assignments that would otherwise dispatch together.
    //
    // Budget 300 covers planning (160) plus one assignment's worth of fallback
    // usage (75, from `testProviderFactory`'s fallback) — 235 — but not two —
    // 310 — so the halt fires once `review-1` (the second assignment overall,
    // after `lead`) reports its usage.
    const { sink, records } = recordingSink();

    const { run, dispatch } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store: new MemoryRunStore(),
      task: 'trip the budget after partial work landed',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      diagnostics: sink,
      dispatch: { runTokenBudget: 300, maxConcurrency: 1 },
    });

    expect(run.status).toBe('failed');
    expect(dispatch?.haltedBecause).toBe('token-budget');
    expect(dispatch?.completed).toBeGreaterThan(0);

    const runLevel = records.filter((r) => r.kind === 'run-failed');
    expect(runLevel).toHaveLength(1);
    expect(runLevel[0]?.runId).toBe(run.id);

    expect(run.error).toBe('run token budget exhausted; partial reports preserved, synthesis skipped');
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

describe('executeRun — all-assignment failure guard', () => {
  // The guard lives in `runner.ts` just above
  // `if (dispatchResult.completed === 0 && dispatchResult.declined === 0)`,
  // with the full reasoning in its own doc comment: it exists so a run that
  // produced no usable report cannot reach `done` — the strongest claim the
  // state machine can make — and it sits BEFORE `collectReports` /
  // `synthesiseReport` specifically so a run that has nothing to summarise
  // never pays for the summarising: no synthesis provider call, no headless
  // Chromium launch for a PDF of an empty list. These two tests pin both
  // halves of that guard: that it actually fires (and fires early enough to
  // skip the paid call) when nothing survived, and — just as importantly —
  // that it does NOT fire when even one assignment produced a report, since a
  // partial deliverable with a documented shortfall is still a deliverable.

  it('fails the run, without writing a report or spending a synthesis call, when every assignment fails or is skipped', async () => {
    const provider = new ScriptedProvider({
      byAssignment: {
        [MANAGER_PLAN_ASSIGNMENT_ID]: {
          text: JSON.stringify(TEST_PLAN),
          usage: { inputTokens: 120, outputTokens: 40 },
        },
        [MANAGER_SYNTHESIS_ASSIGNMENT_ID]: {
          text: TEST_SYNTHESIS,
          usage: { inputTokens: 200, outputTokens: 60 },
        },
        // 'lead' has no dependencies; failing it strands both reviewers
        // (which `dependsOn: ['lead']`) as 'skipped' by the dispatcher's own
        // dependency check, before either is ever sent to the provider. Every
        // one of the plan's three assignments therefore ends either failed or
        // skipped, and none produces a report.
        lead: { failWith: 'provider exploded' },
      },
    });

    const store = new MemoryRunStore();
    const { run, dispatch } = await executeRun({
      registry: testRegistry(),
      provider,
      store,
      task: 'a run where nothing survives',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/all 3 assignment\(s\) failed or were skipped/);
    expect(dispatch?.completed).toBe(0);
    expect(dispatch?.declined).toBe(0);
    expect(dispatch?.failed).toBe(1);
    expect(dispatch?.skipped).toBe(2);

    // No report file was ever written for the synthesis path.
    expect(run.reportPath).toBeUndefined();
    await expect(store.readReport(run.id, SYNTHESIS_REPORT_PATH)).rejects.toThrow();

    // The provider was asked for the planning turn and for 'lead' (the only
    // assignment actually dispatched), and never for the synthesis turn —
    // proof the guard fired before `synthesiseReport` was ever called, not
    // merely that its output was discarded afterward.
    expect(
      provider.requests.some((r) => r.assignmentId === MANAGER_SYNTHESIS_ASSIGNMENT_ID),
    ).toBe(false);
    expect(provider.requests.map((r) => r.assignmentId)).toEqual([
      MANAGER_PLAN_ASSIGNMENT_ID,
      'lead',
    ]);
  });

  it('still reaches done when one assignment succeeds and the rest fail — a partial deliverable is still a deliverable', async () => {
    const provider = new ScriptedProvider({
      byAssignment: {
        [MANAGER_PLAN_ASSIGNMENT_ID]: {
          text: JSON.stringify(TEST_PLAN),
          usage: { inputTokens: 120, outputTokens: 40 },
        },
        [MANAGER_SYNTHESIS_ASSIGNMENT_ID]: {
          text: TEST_SYNTHESIS,
          usage: { inputTokens: 200, outputTokens: 60 },
        },
        // 'lead' has no override, so it succeeds on the provider's default
        // fallback response. Both reviewers depend on 'lead', which
        // succeeded, so — unlike the sibling test above — they are actually
        // dispatched and each fails independently rather than being skipped.
        'review-1': { failWith: 'reviewer one exploded' },
        'review-2': { failWith: 'reviewer two exploded' },
      },
    });

    const { run, dispatch } = await executeRun({
      registry: testRegistry(),
      provider,
      store: new MemoryRunStore(),
      task: 'a run where only the lead survives',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(dispatch?.completed).toBe(1);
    expect(dispatch?.failed).toBe(2);
    expect(dispatch?.skipped).toBe(0);

    // This is the regression guard for the distinction the guard's own doc
    // comment draws: SOME reports (here, one out of three) is not the same as
    // NO reports, and only the latter should fail the run before synthesis.
    expect(run.status).toBe('done');
    expect(run.error).toBeUndefined();
    expect(run.reportPath).toBe(SYNTHESIS_REPORT_PATH);
    expect(
      provider.requests.some((r) => r.assignmentId === MANAGER_SYNTHESIS_ASSIGNMENT_ID),
    ).toBe(true);
  });
});

describe('executeRun — FR-M11 team review pause', () => {
  it('parks in awaiting_approval with the proposed team visible, then dispatches once approved', async () => {
    // The core of FR-M11: the run must actually stop and wait, not merely
    // pass the plan through a no-op hook. `statuses` proves the pause was
    // real (the run sat in `awaiting_approval` before ever reaching
    // `dispatching`), and `capturedRun` proves the pause happens AFTER the
    // proposed team is persisted and visible — a client reconnecting while
    // parked must see the team, per `awaiting_approval`'s doc comment in
    // `shared/src/status.ts` ("so the client can render the proposed team").
    const store = new MemoryRunStore();
    const statuses: string[] = [];
    const approval = deferred<readonly TeamOperation[]>();
    let capturedRun: RunState | undefined;

    const runPromise = executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'review before dispatch',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      onStateChange: (r) => statuses.push(r.status),
      awaitTeamApproval: async ({ run }) => {
        capturedRun = run;
        return approval.promise;
      },
    });

    await waitFor(() => statuses.includes('awaiting_approval'), 'run to reach awaiting_approval');

    expect(capturedRun?.plan).toBeDefined();
    expect(capturedRun?.assignments.map((a) => a.id)).toEqual(['lead', 'review-1', 'review-2']);
    expect(capturedRun?.assignments.every((a) => a.status === 'pending')).toBe(true);

    // Approve with no edits — the "the Manager's team is right, go" case.
    approval.resolve([]);
    const { run } = await runPromise;

    expect(run.status).toBe('done');
    expect(statuses).toContain('awaiting_approval');
    expect(statuses.indexOf('awaiting_approval')).toBeLessThan(statuses.indexOf('dispatching'));
    expect(run.assignments.map((a) => a.id)).toEqual(['lead', 'review-1', 'review-2']);
  });

  it('applies the approved operations before dispatch, so a dropped assignment is never run', async () => {
    // Not just "the run parks and resumes" — the edits themselves have to
    // reach the assignments the dispatcher actually executes. If
    // `runner.ts` re-materialised from the ORIGINAL plan instead of
    // `applyTeamOperations`'s result, this would dispatch `review-2` anyway
    // and this test would catch it via both the assignment list and the
    // empty event log.
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'drop review-2 before dispatch',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      awaitTeamApproval: async () => [{ op: 'drop', assignmentId: 'review-2' }],
    });

    expect(run.status).toBe('done');
    expect(run.assignments.map((a) => a.id)).toEqual(['lead', 'review-1']);
    expect(run.plan?.phases.find((p) => p.id === 'review')?.assignments.map((a) => a.id)).toEqual([
      'review-1',
    ]);

    // Nothing was ever dispatched for the dropped assignment.
    const dropped = await store.readEvents(run.id, 'review-2');
    expect(dropped).toEqual([]);
  });

  it('fails the run cleanly, without dispatching, when the approved operations do not apply', async () => {
    // `applyTeamOperations` is total and returns `{ error }` rather than
    // throwing; this is the test that the runner actually reads that shape
    // and fails the run instead of either crashing or silently dispatching
    // the Manager's original, unedited plan as if the bad edit had never
    // been requested.
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'approve a swap to an unknown agent',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      awaitTeamApproval: async () => [{ op: 'swap', assignmentId: 'review-1', agentName: 'no-such-agent' }],
    });

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/no-such-agent/);
    const events = await store.readEvents(run.id, 'lead');
    expect(events).toEqual([]);
  });

  it('goes planning -> dispatching exactly as before when awaitTeamApproval is absent', async () => {
    // FR-M11 is opt-in, and `RUN_TRANSITIONS['planning']` allows both
    // `awaiting_approval` and `dispatching` for exactly this reason: every
    // run that does not ask to review its team — which, before this
    // feature, was every run — must be unable to tell the pause exists at
    // all. This test is the negative space the other three don't cover: no
    // `awaitTeamApproval` in `deps` means `awaiting_approval` must never
    // appear in the status history.
    const store = new MemoryRunStore();
    const statuses: string[] = [];

    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'no review requested',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      onStateChange: (r) => statuses.push(r.status),
    });

    expect(run.status).toBe('done');
    expect(statuses).not.toContain('awaiting_approval');
    expect(run.assignments.map((a) => a.id)).toEqual(['lead', 'review-1', 'review-2']);
  });

  it('cancels cleanly with nothing dispatched when the run is stopped while parked (FR-M9)', async () => {
    // The pause can "sit here indefinitely" by design, which makes it the
    // one await most exposed to a cancel landing while nothing else is
    // happening. `hang.promise` never resolves on its own — the only thing
    // that ends the wait is `controller.abort()` — so if the runner did not
    // race the approval promise against `signal` (see
    // `raceApprovalAgainstAbort`), this test would time out instead of
    // observing `cancelled`.
    const store = new MemoryRunStore();
    const statuses: string[] = [];
    const hang = deferred<readonly TeamOperation[]>();
    const controller = new AbortController();

    const runPromise = executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'cancel while awaiting approval',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
      signal: controller.signal,
      onStateChange: (r) => statuses.push(r.status),
      awaitTeamApproval: () => hang.promise,
    });

    await waitFor(() => statuses.includes('awaiting_approval'), 'run to reach awaiting_approval');
    controller.abort();
    const { run, dispatch } = await runPromise;

    expect(run.status).toBe('cancelled');
    // Never reached the dispatcher at all — `dispatchResult` stays
    // `undefined` in `executeRun` unless `dispatchRun` was actually called.
    expect(dispatch).toBeUndefined();
    expect(run.assignments.every((a) => a.status === 'pending')).toBe(true);

    for (const assignment of run.assignments) {
      const events = await store.readEvents(run.id, assignment.id);
      expect(events).toEqual([]);
    }
  });
});

describe('executeRun — Doc4: report.md carries a minimal provenance header', () => {
  it('prepends run id, a Generated date and the contributing agents ahead of the raw synthesis', async () => {
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'header on report.md',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    const written = await store.readReport(run.id, SYNTHESIS_REPORT_PATH);
    const lines = written.split('\n');

    // Exact vocabulary match with `buildMarkdownBundle`'s own cover
    // (`reports/markdownExport.ts`) — "Run ID" and "Generated", not a
    // second format for the same two facts.
    expect(lines[0]).toBe(`**Run ID:** ${run.id}`);
    expect(lines[1]).toMatch(/^\*\*Generated:\*\* \d{4}-\d{2}-\d{2}$/);
    // TEST_PLAN's three assignments are 'lead'→alpha, 'review-1'→beta,
    // 'review-2'→gamma, all succeeding on the provider's default fallback —
    // so all three contributed and should be named, in plan order.
    expect(lines[2]).toBe('**Agents:** alpha, beta, gamma');
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('---');
    expect(lines[5]).toBe('');

    // The header is prepended, not substituted for the model's own output —
    // `report.md` must still contain the exact synthesis text a caller
    // reading only from `SYNTHESIS_REPORT_PATH` used to see in full.
    expect(written).toContain(TEST_SYNTHESIS);
    expect(written.endsWith(TEST_SYNTHESIS)).toBe(true);
  });

  it('lists only the agents whose reports actually reached synthesis, not the whole team, when one assignment produced nothing', async () => {
    // 'review-2' fails outright and produces no report; 'lead' and
    // 'review-1' succeed. `collectReports` (and therefore this header) must
    // reflect what synthesis actually received, not `run.assignments` in
    // full — a header naming an agent whose work never reached the Manager
    // would misrepresent the document exactly as badly as omitting one that
    // did contribute.
    const provider = testProviderFactory({ 'review-2': { failWith: 'reviewer two exploded' } })();
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider,
      store,
      task: 'header omits the failed agent',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');
    const written = await store.readReport(run.id, SYNTHESIS_REPORT_PATH);
    const agentsLine = written.split('\n')[2];
    expect(agentsLine).toBe('**Agents:** alpha, beta');
  });
});

describe('executeRun — F4: manager-turn events carry no agentName/phaseId', () => {
  it('leaves both fields absent on the planning and synthesis events, rather than inventing a value for "the Manager"', async () => {
    const store = new MemoryRunStore();
    const { run } = await executeRun({
      registry: testRegistry(),
      provider: testProviderFactory()(),
      store,
      task: 'manager events have no agent or phase',
      logger: () => undefined,
      produceDeliverable: stubDeliverable(),
    });

    expect(run.status).toBe('done');

    const planningEvents = await store.readEvents(run.id, MANAGER_PLAN_ASSIGNMENT_ID);
    const synthesisEvents = await store.readEvents(run.id, MANAGER_SYNTHESIS_ASSIGNMENT_ID);
    expect(planningEvents.length).toBeGreaterThan(0);
    expect(synthesisEvents.length).toBeGreaterThan(0);

    for (const entry of [...planningEvents, ...synthesisEvents]) {
      expect(entry.event.agentName).toBeUndefined();
      expect(entry.event.phaseId).toBeUndefined();
    }

    // Contrast: a real assignment's own events DO carry both, proving the
    // absence above is a deliberate choice for manager turns specifically,
    // not a sign the whole feature is inert in this test's setup.
    const leadEvents = await store.readEvents(run.id, 'lead');
    expect(leadEvents.length).toBeGreaterThan(0);
    expect(leadEvents.every((entry) => entry.event.agentName === 'alpha')).toBe(true);
    expect(leadEvents.every((entry) => entry.event.phaseId === 'analysis')).toBe(true);
  });
});
