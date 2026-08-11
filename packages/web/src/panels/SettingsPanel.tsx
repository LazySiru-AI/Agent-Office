import type { RunSettings } from '../state/useSettings.js';

/**
 * One provider the run could use, and whether it actually can right now.
 *
 * `available`/`reason` come from the server (Phase 1's adapters live in
 * `packages/server/src/providers/`, built in parallel with this panel) —
 * this component only renders what it is handed, it never guesses at
 * provider readiness itself.
 */
export interface ProviderOption {
  id: string;
  available: boolean;
  /**
   * Why it is unavailable — e.g. "ANTHROPIC_API_KEY is not set".
   *
   * `| undefined` is explicit rather than redundant. These values arrive from
   * `ProviderInfoSchema`, whose `z.string().optional()` infers `reason?: string
   * | undefined` — a property that may be *present and undefined*, not merely
   * absent. Under `exactOptionalPropertyTypes` those are different types and a
   * bare `reason?: string` will not accept one, so this mirrors what the wire
   * contract actually produces instead of a tidier shape it does not.
   */
  reason?: string | undefined;
}

export interface SettingsPanelProps {
  settings: RunSettings;
  errors: Partial<Record<keyof RunSettings, string>>;
  providers: ProviderOption[];
  onChange: <K extends keyof RunSettings>(key: K, value: RunSettings[K]) => void;
  onReset: () => void;
}

/**
 * Run defaults (Phase 7): which provider to use, and the concurrency/timeout/
 * budget knobs that used to require editing `packages/server/src/scripts/
 * {run,serve}.ts`'s command-line flags by hand.
 *
 * Deliberately unstyled, matching the rest of this codebase's panels
 * (`DisplayControls.tsx`, `ReplayControls.tsx`) — plain semantic HTML, no
 * component library, no colour or layout of its own. The class names below
 * (`settings-panel`, `settings-group`, `settings-label`, `settings-field`,
 * `settings-error`, `settings-provider-reason`) are the only styling hooks,
 * left for the CSS agent — this file does not decide what any of them look
 * like.
 *
 * Props mirror `UseSettingsResult` (`../state/useSettings.ts`) rather than
 * taking the hook result wholesale, following this codebase's existing panel
 * convention (`DisplayControlsProps`, `ReplayControlsProps`) of individually
 * named props plus callbacks — it keeps this component renderable/testable
 * without the hook itself. `providers` is the one addition the task's prop
 * contract didn't already name: `RunSettings` has no notion of "which
 * providers exist and can they run", and that list has to come from
 * somewhere outside this file (the server, via whatever endpoint the parallel
 * provider work exposes) since a browser tab cannot see the server's
 * environment variables to work it out itself.
 *
 * Accessibility: provider selection is a set of real `<button>`s with
 * `aria-pressed`, grouped under `role="group"` with its own `aria-label` —
 * matching `DisplayControls.tsx` exactly, including its reasoning for why a
 * `role="group"` + `aria-label` pairing stands in for a labelled
 * `<fieldset>` in this deliberately-unstyled UI. Numeric fields are real
 * `<input type="number">`s with an associated `<label>`, `aria-invalid` when
 * their value fails validation, and `aria-describedby` pointing at the
 * error message so a screen reader announces *why* alongside the field
 * itself rather than leaving the user to find a floating paragraph.
 */
export function SettingsPanel({ settings, errors, providers, onChange, onReset }: SettingsPanelProps): JSX.Element {
  return (
    <div className="settings-panel">
      <div role="group" aria-label="Provider" className="settings-group">
        <span className="settings-label">Provider</span>
        {providers.map((provider) => (
          <div key={provider.id}>
            <button
              type="button"
              aria-pressed={settings.provider === provider.id}
              /* Selectable even when unavailable, deliberately. Disabling it
                 was the first instinct and it strands people: availability is
                 fetched once at mount, so a user who signs the CLI in — or
                 adds a key to `.env` — cannot pick the provider they just
                 enabled without reloading the page. Nothing is lost by
                 allowing the selection, because the run is blocked upstream
                 with this same reason shown next to the Start button. */
              aria-describedby={provider.available ? undefined : `provider-reason-${provider.id}`}
              onClick={() => onChange('provider', provider.id)}
            >
              {provider.id}
            </button>
            {/* An unavailable provider stays visible rather than being filtered
                out — a user needs to see that e.g. `anthropic` exists and read
                why it can't be used (a missing API key), which is more useful
                than a selector that silently shrinks depending on server
                environment. */}
            {!provider.available && provider.reason !== undefined && (
              <span className="settings-provider-reason" id={`provider-reason-${provider.id}`}>
                {provider.reason}
              </span>
            )}
          </div>
        ))}
        {errors.provider !== undefined && <p className="settings-error">{errors.provider}</p>}
      </div>

      <div className="settings-group">
        <span className="settings-label">Run limits</span>

        <div className="settings-field">
          <label htmlFor="settings-concurrency">Concurrency</label>
          <input
            id="settings-concurrency"
            type="number"
            value={settings.concurrency}
            aria-invalid={errors.concurrency !== undefined}
            aria-describedby={errors.concurrency !== undefined ? 'settings-concurrency-error' : undefined}
            onChange={(e) => onChange('concurrency', Number(e.target.value))}
          />
          {errors.concurrency !== undefined && (
            <p className="settings-error" id="settings-concurrency-error">
              {errors.concurrency}
            </p>
          )}
        </div>

        <div className="settings-field">
          <label htmlFor="settings-timeout">Assignment timeout (ms)</label>
          <input
            id="settings-timeout"
            type="number"
            value={settings.assignmentTimeoutMs}
            aria-invalid={errors.assignmentTimeoutMs !== undefined}
            aria-describedby={errors.assignmentTimeoutMs !== undefined ? 'settings-timeout-error' : undefined}
            onChange={(e) => onChange('assignmentTimeoutMs', Number(e.target.value))}
          />
          {errors.assignmentTimeoutMs !== undefined && (
            <p className="settings-error" id="settings-timeout-error">
              {errors.assignmentTimeoutMs}
            </p>
          )}
        </div>

        <div className="settings-field">
          <label htmlFor="settings-token-budget">Token budget (optional)</label>
          <input
            id="settings-token-budget"
            type="number"
            placeholder="no limit"
            value={settings.runTokenBudget ?? ''}
            aria-invalid={errors.runTokenBudget !== undefined}
            aria-describedby={errors.runTokenBudget !== undefined ? 'settings-token-budget-error' : undefined}
            onChange={(e) => onChange('runTokenBudget', parseOptionalNumber(e.target.value))}
          />
          {errors.runTokenBudget !== undefined && (
            <p className="settings-error" id="settings-token-budget-error">
              {errors.runTokenBudget}
            </p>
          )}
        </div>

        <div className="settings-field">
          <label htmlFor="settings-cost-budget">Cost budget (USD, optional)</label>
          <input
            id="settings-cost-budget"
            type="number"
            step="0.01"
            placeholder="no limit"
            value={settings.maxCostUsd ?? ''}
            aria-invalid={errors.maxCostUsd !== undefined}
            aria-describedby={errors.maxCostUsd !== undefined ? 'settings-cost-budget-error' : undefined}
            onChange={(e) => onChange('maxCostUsd', parseOptionalNumber(e.target.value))}
          />
          {errors.maxCostUsd !== undefined && (
            <p className="settings-error" id="settings-cost-budget-error">
              {errors.maxCostUsd}
            </p>
          )}
        </div>
      </div>

      <div className="settings-group">
        <button type="button" onClick={onReset}>
          Reset to defaults
        </button>

        {/*
         * No API keys anywhere in this panel — deliberate, not an omission.
         *
         * A provider's key lives in the *server's* environment
         * (`ANTHROPIC_API_KEY` etc. — see `packages/server/src/providers/`)
         * because the server is what actually calls the provider; the
         * browser tab never needs to see it. Putting a key-entry field here
         * would mean either (a) shipping it to the server on every run
         * start, which turns a same-origin loopback app (NFR-6) into
         * something that transmits a secret over the wire for no operational
         * reason, or (b) storing it in `localStorage`, which is readable by
         * any script that ever runs on this origin and survives long after
         * the tab closes. Both are worse than the actual answer: keys are an
         * operator/deployment concern, set once in the environment the
         * server runs in, and this panel's job is only to say which
         * providers that environment currently supports.
         */}
        <p className="settings-provider-reason">
          Provider API keys come from the server&apos;s environment, not from this panel — they are never entered,
          stored, or displayed here.
        </p>
      </div>
    </div>
  );
}

/**
 * `<input type="number">` reports its value as a string; an emptied field is
 * `''`, which `Number('')` would turn into `0` (a real, if wrong, number)
 * rather than "unset". Budgets are optional — an emptied field means "no
 * budget", so it must map to `undefined`, not `0`. A non-empty-but-unparsable
 * string still becomes `NaN`, deliberately: `validateSettings` catches that
 * and reports it back through `errors` instead of this function silently
 * discarding what the user typed.
 */
function parseOptionalNumber(raw: string): number | undefined {
  return raw.trim().length === 0 ? undefined : Number(raw);
}
