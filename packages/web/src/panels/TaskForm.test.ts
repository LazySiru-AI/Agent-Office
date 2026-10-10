import { describe, expect, it } from 'vitest';
import { buildCreateRunRequest, costHint } from './TaskForm.js';

/**
 * `buildCreateRunRequest` is the whole fix for the defect described in
 * `TaskForm.tsx`'s file header: a cost budget, token budget, or timeout typed
 * into `SettingsPanel` used to never reach `CreateRunRequest` because the
 * request was built as `{ task, provider, concurrency }` and nothing else.
 * These tests exercise the builder directly — no render, no DOM, per this
 * package's Node-only test convention (see `useReplay.test.ts`,
 * `useSettings.test.ts`) — and check both that every setting a user can type
 * in actually appears on the request, and that an unset optional budget is
 * genuinely absent rather than present-as-`undefined`.
 */

const BASE_SETTINGS = {
  provider: 'claude-code',
  concurrency: 3,
  assignmentTimeoutMs: 600_000,
};

describe('buildCreateRunRequest — required fields always travel', () => {
  it('carries task, provider and concurrency through unchanged', () => {
    const req = buildCreateRunRequest('write a report', BASE_SETTINGS);
    expect(req.task).toBe('write a report');
    expect(req.provider).toBe('claude-code');
    expect(req.concurrency).toBe(3);
  });

  it('always sends assignmentTimeoutMs as the wire field timeoutMs, since useSettings never leaves it unset', () => {
    const req = buildCreateRunRequest('t', { ...BASE_SETTINGS, assignmentTimeoutMs: 45_000 });
    expect(req.timeoutMs).toBe(45_000);
  });
});

describe('buildCreateRunRequest — the regression this fixes: budgets reaching the wire', () => {
  it('includes tokenBudget on the request when runTokenBudget is set (previously silently dropped)', () => {
    const req = buildCreateRunRequest('t', { ...BASE_SETTINGS, runTokenBudget: 50_000 });
    expect(req.tokenBudget).toBe(50_000);
  });

  it('includes maxCostUsd on the request when maxCostUsd is set (previously silently dropped)', () => {
    const req = buildCreateRunRequest('t', { ...BASE_SETTINGS, maxCostUsd: 2.5 });
    expect(req.maxCostUsd).toBe(2.5);
  });

  it('sends both budgets together when both are set', () => {
    const req = buildCreateRunRequest('t', { ...BASE_SETTINGS, runTokenBudget: 10_000, maxCostUsd: 1.25 });
    expect(req.tokenBudget).toBe(10_000);
    expect(req.maxCostUsd).toBe(1.25);
  });
});

describe('buildCreateRunRequest — reviewTeam (FR-M11 opt-in)', () => {
  it('includes reviewTeam: true on the request when the setting is opted in', () => {
    const req = buildCreateRunRequest('t', { ...BASE_SETTINGS, reviewTeam: true });
    expect(req.reviewTeam).toBe(true);
  });

  it('omits reviewTeam entirely when the setting is absent, matching "opt-in, absent means no"', () => {
    const req = buildCreateRunRequest('t', BASE_SETTINGS);
    expect('reviewTeam' in req).toBe(false);
  });

  it('a stored reviewTeam of false also produces an absent key, not reviewTeam: false', () => {
    const req = buildCreateRunRequest('t', { ...BASE_SETTINGS, reviewTeam: false });
    expect('reviewTeam' in req).toBe(false);
  });
});

describe('buildCreateRunRequest — absent budgets stay absent keys, not `undefined` values', () => {
  it('omits tokenBudget entirely when runTokenBudget is undefined', () => {
    const req = buildCreateRunRequest('t', BASE_SETTINGS);
    expect('tokenBudget' in req).toBe(false);
  });

  it('omits maxCostUsd entirely when maxCostUsd is undefined', () => {
    const req = buildCreateRunRequest('t', BASE_SETTINGS);
    expect('maxCostUsd' in req).toBe(false);
  });

  it('an explicit undefined for either budget still produces an absent key, not an explicit-undefined one', () => {
    // `exactOptionalPropertyTypes` distinguishes "key absent" from "key present
    // with value undefined", and now that it is genuinely enabled it stops a
    // TypeScript caller writing this at all. That is the primary defence and it
    // is a compile-time one, so it cannot be asserted from inside a test.
    //
    // This pins the other half. Settings reach this builder from
    // `localStorage` through `parseStoredSettings` — that is parsed JSON, which
    // TypeScript never checked — so a present-but-undefined budget is reachable
    // at runtime by a route the compiler does not police. `Object.assign` is
    // how the object is built here precisely because it reproduces that: it
    // sets the keys for real, rather than a cast pretending it did.
    const settings = { ...BASE_SETTINGS };
    Object.assign(settings, { runTokenBudget: undefined, maxCostUsd: undefined });

    const req = buildCreateRunRequest('t', settings);
    expect(Object.keys(req)).toEqual(['task', 'provider', 'concurrency', 'timeoutMs']);
  });
});

/**
 * D5: no invented number. `costHint` is the whole decision behind the line
 * shown next to the Start button — three tiers tried in order, and the third
 * is "say plainly that nothing is capped" rather than silence. See the
 * function's own comment in TaskForm.tsx for why each tier exists and why an
 * order matters (historical data, when present, must win over a cap that
 * says nothing about what already happened).
 */
describe('costHint (D5 — an honest cost signal, never a fabricated estimate)', () => {
  it('leads with the historical figure when a finished run is loaded, labelled as historical', () => {
    const hint = costHint({ lastFinishedRunCostUsd: 1.5 });
    expect(hint).toContain('$1.50');
    expect(hint).toContain('historical');
    // Must not read as a prediction for the run about to start.
    expect(hint).not.toMatch(/estimate for this run\.?$/);
  });

  it('falls back to the per-assignment cap when there is no historical figure', () => {
    const hint = costHint({ maxCostUsd: 2 });
    expect(hint).toContain('$2.00');
    expect(hint).toContain('per assignment');
  });

  it('prefers the historical figure over the cap when both are available', () => {
    const hint = costHint({ lastFinishedRunCostUsd: 0.75, maxCostUsd: 5 });
    expect(hint).toContain('$0.75');
    expect(hint).not.toContain('$5.00');
  });

  it('states plainly that nothing is capped when there is neither a historical figure nor a cap', () => {
    // The one case this fix exists to remove: silence. A user about to spend
    // money must see SOMETHING, even if the honest something is "no limit".
    expect(costHint({})).toBe('No cost cap is set for this run.');
  });
});
