import { useCallback, useMemo, useState } from 'react';
import { readStorage, writeStorage } from '../theme/useTheme.js';

/**
 * Run defaults (Phase 7): provider, concurrency, per-assignment timeout, and
 * optional token/cost budgets — the knobs `TaskForm.tsx` and the CLI scripts
 * (`packages/server/src/scripts/{run,serve}.ts`) already expose as flags, now
 * settable without a command line.
 *
 * ## Shape, and why it follows `useTheme.ts`
 *
 * Same constraints, same answer as `theme/useTheme.ts`: this hook is tested
 * under Node with no DOM and no `localStorage` (`useSettings.test.ts`), so the
 * actual decision-making — "given whatever happens to be sitting in storage,
 * what settings does the app use?" — is pulled out into plain, exported
 * functions (`parseStoredSettings`, `validateSettings`) that take their input
 * as an argument rather than reading `window` themselves. The hook is a thin
 * shell around those functions: `readStorage`/`writeStorage` (imported from
 * `useTheme.ts` rather than re-implemented — they are generic key/value
 * helpers, not theme-specific, and already carry the private-browsing guards)
 * are the only things that touch `localStorage`.
 *
 * ## Field-by-field fallback, not object-by-object
 *
 * `localStorage` is user-writable and outlives app versions — a value written
 * by an older build, or hand-edited in devtools, can show up here in any
 * shape. `useTheme.ts` treats one bad stored string as "fall back to the
 * default", which is fine for a single scalar preference. This hook's stored
 * value is a five-field object, so the same rule applied at the object level
 * would mean a single corrupted field (say, a `concurrency` that got bumped
 * to `999` by hand) silently discards an otherwise-fine `provider` choice
 * sitting right next to it. `parseStoredSettings` therefore validates and
 * falls back *per field*, matching the task's explicit rule.
 *
 * ## Parsing vs validating — two different jobs
 *
 * `parseStoredSettings` runs once, at load, against data the user cannot see
 * being corrected — silently substituting the default for a bad field is the
 * right behaviour there. `validateSettings` runs continuously against
 * whatever is currently in `settings` (including a value the user just typed
 * a moment ago and has not finished typing) and its job is the opposite: say
 * what's wrong *without* touching the value, so `SettingsPanel.tsx` can show
 * the user's own keystrokes back to them alongside a message they can act on.
 * `setSetting` therefore never rejects a value — it stores exactly what it is
 * given, every time, and `errors` is computed fresh from that.
 */

export interface RunSettings {
  provider: string;
  concurrency: number;
  assignmentTimeoutMs: number;
  runTokenBudget?: number;
  maxCostUsd?: number;
  /**
   * FR-M11 opt-in: pause after planning so the proposed team can be
   * reviewed — add, drop or swap agents — before anything is dispatched.
   *
   * Optional and modelled exactly like the two budgets above rather than as
   * a required `boolean` defaulting to `false`, for the same reason: the
   * wire's own `CreateRunRequestSchema.reviewTeam` is "opt-in, and absent
   * means no" (see its doc comment in `wire.ts`), and a required field here
   * would mean `TaskForm.tsx`'s `buildCreateRunRequest` has to invent a
   * decision about whether `false` is worth sending at all. Absent already
   * *is* that decision, made once, here.
   */
  reviewTeam?: boolean;
}

const STORAGE_KEY = 'agent-office.settings';

/**
 * Concurrency bounds. `MAX_CONCURRENCY` mirrors
 * `CreateRunRequestSchema.concurrency` (`packages/shared/src/wire.ts`),
 * which caps at 12 — that schema is the actual authority, re-validated
 * server-side on every `POST /api/runs` regardless of what this UI does.
 *
 * So why duplicate the number here rather than trust the server to reject a
 * bad value? Because the UI's job is a *different* one: catching the mistake
 * at the moment it's made, with a message next to the field the user is
 * looking at, instead of a request round-trip and a toast. 12 is not an
 * independent opinion about a "sensible" limit invented for this panel — it
 * is this constant intentionally kept equal to the wire schema's cap, so the
 * two can never silently drift into rejecting different values. If the
 * server's cap ever changes, this constant must change with it.
 */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 12;

/**
 * Defaults mirror `DEFAULT_DISPATCH_OPTIONS` in
 * `packages/server/src/orchestrator/dispatcher.ts` (`maxConcurrency: 3`,
 * `assignmentTimeoutMs: 10 * 60 * 1000`) and the server's own
 * `DEFAULT_PROVIDER` (`'claude-code'`) — a first-time visitor with nothing
 * stored should see the same numbers the CLI falls back to, not a second,
 * independently chosen set of "reasonable" defaults.
 *
 * The provider default is the local Claude Code CLI because it is the one
 * engine that needs no key in a file — it uses the sign-in the user already
 * has. It does mean the default spends money, which is the deliberate trade:
 * the previous default called no model at all and produced a report of
 * placeholder text that read like a finished run. Budgets are omitted (rather than set
 * to `0` or some large number) because "no budget" is the actual default
 * behaviour: `runTokenBudget`/`maxCostUsd` are optional on the wire and an
 * absent value there means "don't stop the run for cost", which is what an
 * unset field here should mean too.
 */
export const DEFAULT_SETTINGS: RunSettings = {
  provider: 'claude-code',
  concurrency: 3,
  assignmentTimeoutMs: 10 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Per-field fallback helpers, used only by parseStoredSettings.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored provider must be a non-empty string; anything else is untrusted. */
function fallbackProvider(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : DEFAULT_SETTINGS.provider;
}

/** For the two required numeric fields: a stored value must pass `isValid`, or the field's own default wins. */
function fallbackRequiredNumber(value: unknown, isValid: (n: number) => boolean, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && isValid(value) ? value : fallback;
}

/**
 * For the two optional budget fields: an absent value means "no budget" (the
 * documented default) and stays absent; a present-but-invalid value also
 * falls back to "no budget" rather than being trusted — there is no
 * meaningful non-undefined default to substitute for a corrupted budget.
 */
function fallbackOptionalNumber(value: unknown, isValid: (n: number) => boolean): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && isValid(value)) return value;
  return undefined;
}

/**
 * For `reviewTeam`: the only meaningful stored value is a literal `true`.
 * There is no "invalid but recoverable" case the way a corrupted budget has
 * one — a stored `false`, or anything else that isn't `true`, means exactly
 * what an absent key means ("not opted in"), so both collapse to the same
 * `undefined` result rather than the field distinguishing three states for a
 * choice that only ever has two.
 */
function fallbackOptionalBoolean(value: unknown): boolean | undefined {
  return value === true ? true : undefined;
}

/**
 * Stored raw string -> a fully-populated, individually-validated
 * `RunSettings`. Never throws: unparseable JSON, a non-object payload, or any
 * single corrupted field all degrade to that field's default rather than
 * wedging the panel or losing every other setting alongside it.
 */
export function parseStoredSettings(raw: string | undefined): RunSettings {
  if (raw === undefined) return DEFAULT_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS; // not JSON at all: nothing in it can be trusted field-by-field
  }

  if (!isRecord(parsed)) return DEFAULT_SETTINGS; // e.g. a bare number or array — same reasoning

  const provider = fallbackProvider(parsed['provider']);
  const concurrency = fallbackRequiredNumber(
    parsed['concurrency'],
    (n) => Number.isInteger(n) && n >= MIN_CONCURRENCY && n <= MAX_CONCURRENCY,
    DEFAULT_SETTINGS.concurrency,
  );
  const assignmentTimeoutMs = fallbackRequiredNumber(
    parsed['assignmentTimeoutMs'],
    (n) => Number.isInteger(n) && n > 0,
    DEFAULT_SETTINGS.assignmentTimeoutMs,
  );
  const runTokenBudget = fallbackOptionalNumber(parsed['runTokenBudget'], (n) => Number.isInteger(n) && n > 0);
  const maxCostUsd = fallbackOptionalNumber(parsed['maxCostUsd'], (n) => n > 0);
  const reviewTeam = fallbackOptionalBoolean(parsed['reviewTeam']);

  return {
    provider,
    concurrency,
    assignmentTimeoutMs,
    // Spread rather than assign, so an absent/invalid budget is an *absent*
    // key (matching `RunSettings`'s optional fields) rather than a key
    // explicitly set to `undefined`.
    ...(runTokenBudget === undefined ? {} : { runTokenBudget }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(reviewTeam === undefined ? {} : { reviewTeam }),
  };
}

/**
 * Validates the settings currently in play — see the file header for why
 * this is a separate pass from `parseStoredSettings` rather than reused
 * fallback logic. Every message names the field, the rule, and (where
 * relevant) the boundary, so it can be shown to a person as-is rather than
 * needing a caller to translate "invalid" into something actionable.
 */
export function validateSettings(settings: RunSettings): Partial<Record<keyof RunSettings, string>> {
  const errors: Partial<Record<keyof RunSettings, string>> = {};

  if (settings.provider.trim().length === 0) {
    errors.provider = 'Choose a provider.';
  }

  if (
    !Number.isInteger(settings.concurrency) ||
    settings.concurrency < MIN_CONCURRENCY ||
    settings.concurrency > MAX_CONCURRENCY
  ) {
    errors.concurrency = `Concurrency must be a whole number between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}.`;
  }

  if (!Number.isInteger(settings.assignmentTimeoutMs) || settings.assignmentTimeoutMs <= 0) {
    errors.assignmentTimeoutMs = 'Timeout must be a positive whole number of milliseconds.';
  }

  if (settings.runTokenBudget !== undefined) {
    if (!Number.isInteger(settings.runTokenBudget) || settings.runTokenBudget <= 0) {
      errors.runTokenBudget = 'Token budget must be a positive whole number, or left blank for no limit.';
    }
  }

  if (settings.maxCostUsd !== undefined) {
    if (!Number.isFinite(settings.maxCostUsd) || settings.maxCostUsd <= 0) {
      errors.maxCostUsd =
        'Cost budget per assignment must be a positive number of US dollars, or left blank for no limit.';
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface UseSettingsResult {
  settings: RunSettings;
  setSetting: <K extends keyof RunSettings>(key: K, value: RunSettings[K]) => void;
  reset: () => void;
  /** Per-field validation messages, empty when the settings are usable. */
  errors: Partial<Record<keyof RunSettings, string>>;
}

/**
 * Applies one field update onto a `RunSettings` copy, without an `as` cast at
 * the generic call site. A plain `{ ...settings, [key]: value }` would type
 * as `RunSettings` too loosely to be trustworthy here (`value`'s type is tied
 * to `key` only through the generic `K`, not through the literal branch), so
 * this is written as an exhaustive switch instead: each branch's assignment
 * is checked against that field's own concrete type, and
 * `noFallthroughCasesInSwitch` (see `tsconfig.base.json`) plus the `never`
 * fallthrough below keep it exhaustive as `RunSettings` grows.
 */
function withSetting<K extends keyof RunSettings>(settings: RunSettings, key: K, value: RunSettings[K]): RunSettings {
  switch (key) {
    case 'provider':
      return { ...settings, provider: value as RunSettings['provider'] };
    case 'concurrency':
      return { ...settings, concurrency: value as RunSettings['concurrency'] };
    case 'assignmentTimeoutMs':
      return { ...settings, assignmentTimeoutMs: value as RunSettings['assignmentTimeoutMs'] };
    case 'runTokenBudget':
      return withOptionalNumber(settings, 'runTokenBudget', value as RunSettings['runTokenBudget']);
    case 'maxCostUsd':
      return withOptionalNumber(settings, 'maxCostUsd', value as RunSettings['maxCostUsd']);
    case 'reviewTeam':
      return withOptionalBoolean(settings, value as RunSettings['reviewTeam']);
    default: {
      const exhaustive: never = key;
      throw new Error(`unhandled RunSettings key: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Set an optional budget, or REMOVE it when the user clears the field.
 *
 * The distinction is the whole point and it used to be written as
 * `{ runTokenBudget: undefined }`, which sets the key to `undefined` rather
 * than removing it. Those are different objects: the first serialises to
 * `{"runTokenBudget": null}`-shaped JSON in some paths and, more importantly,
 * survives an `in` check and a spread as a present-but-empty field. With
 * `exactOptionalPropertyTypes` now genuinely enabled (it was declared `false`
 * while comments across the codebase asserted otherwise), the compiler says so.
 *
 * `delete` on an optional property is the honest expression of "this budget is
 * not set", and it is what makes an emptied field mean "no limit" everywhere
 * downstream rather than "a limit of nothing".
 */
function withOptionalNumber(
  settings: RunSettings,
  key: 'runTokenBudget' | 'maxCostUsd',
  value: number | undefined,
): RunSettings {
  const next = { ...settings };
  delete next[key];
  if (value !== undefined) next[key] = value;
  return next;
}

/**
 * Same `delete`-then-set discipline as `withOptionalNumber`, for the one
 * boolean field. Unlike the budgets, there is no distinct "unset" input a
 * checkbox can produce the way an emptied number field produces `undefined`
 * — the control below sends either `true` (checked) or `undefined`
 * (unchecked), never a literal `false`, so `reviewTeam` never carries a
 * `false` value to begin with and this only ever has one non-absent branch
 * to set.
 */
function withOptionalBoolean(settings: RunSettings, value: boolean | undefined): RunSettings {
  const next = { ...settings };
  delete next.reviewTeam;
  if (value === true) next.reviewTeam = true;
  return next;
}

/**
 * Owns run defaults for Phase 7: reads whatever is stored, validates it live,
 * and persists every change back to `localStorage` under
 * `agent-office.settings` — namespaced alongside `agent-office.theme` /
 * `agent-office.motion` (`theme/useTheme.ts`).
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettingsState] = useState<RunSettings>(() => parseStoredSettings(readStorage(STORAGE_KEY)));

  const setSetting = useCallback(<K extends keyof RunSettings>(key: K, value: RunSettings[K]): void => {
    setSettingsState((prev) => {
      const next = withSetting(prev, key, value);
      writeStorage(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const reset = useCallback((): void => {
    setSettingsState(DEFAULT_SETTINGS);
    writeStorage(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
  }, []);

  const errors = useMemo(() => validateSettings(settings), [settings]);

  return { settings, setSetting, reset, errors };
}
