import { useState, type FormEvent } from 'react';
import type { CreateRunRequest } from '@agent-office/shared';

/**
 * Task input + "Start run" button.
 *
 * Phase 7 took the provider and concurrency controls out of this form. They
 * used to live here because there was nowhere else to put them; now
 * `SettingsPanel` owns them, and two places to choose a provider is exactly the
 * duplication that ends with the form and the settings disagreeing about what
 * a run will do. What is left is the one thing this form is actually for.
 *
 * The settings arrive as props rather than being read from the hook here, so
 * this component stays renderable without any of that machinery, matching the
 * convention the rest of the panels follow.
 *
 * ## The defect this fixes: three settings that never left the browser
 *
 * `onStart` used to be called with `{ task, provider, concurrency }` and
 * nothing else. `useSettings`'s `RunSettings` also carries
 * `assignmentTimeoutMs` (always set), plus the optional `runTokenBudget` and
 * `maxCostUsd` — all three rendered and editable in `SettingsPanel`, all
 * three validated live, all three persisted to `localStorage`, and none of
 * them ever reached `CreateRunRequest`. A user who typed a cost budget into
 * the panel and started a run got a run with no budget at all: the value was
 * real, shown back to them, and simply discarded at the one place it needed
 * to travel. `buildCreateRunRequest` below is now the only place this
 * request is assembled, so every field `RunSettings` can hold has a named
 * destination on the wire (`wire.ts`'s `CreateRunRequestSchema`) instead of a
 * silent drop.
 */
export interface TaskFormProps {
  onStart: (req: CreateRunRequest) => Promise<string>;
  /** From `useSettings` — what the run will be started with. */
  provider: string;
  concurrency: number;
  /**
   * Per-assignment timeout, ms. `useSettings`'s `DEFAULT_SETTINGS` always
   * gives this a numeric value, so — unlike the two budgets below — it is
   * never omitted from the request.
   */
  assignmentTimeoutMs: number;
  /** Optional run-wide token budget (FR-M8); absent means "no limit", matching `RunSettings`. */
  runTokenBudget?: number;
  /** Optional run-wide USD cost budget (FR-M8, NFR-5); absent means "no limit", matching `RunSettings`. */
  maxCostUsd?: number;
  /** True when the current settings are unusable; blocks the submit. */
  settingsInvalid: boolean;
  /**
   * Why the submit is blocked, when the reason is worth stating here.
   *
   * A field-level validation error already shows next to its own field, so the
   * generic message is enough for those. An unavailable provider has no field
   * of its own to fail against — the value is valid, the world is not — so it
   * gets said in full.
   */
  blockedReason?: string;
  /** Disable the form while a run is already in flight isn't required by the
   * contract (runs execute independently), but a busy indicator on the
   * button avoids double-submits while the create request is pending. */
  busy: boolean;
}

/**
 * The `RunSettings` fields this form needs, named to match `RunSettings`
 * itself rather than the wire's `timeoutMs`/`tokenBudget` names — the
 * settings-domain names are what the rest of `TaskFormProps` already uses,
 * and the translation to wire names happens in exactly one place, below.
 */
type RunSettingsSlice = Pick<
  TaskFormProps,
  'provider' | 'concurrency' | 'assignmentTimeoutMs' | 'runTokenBudget' | 'maxCostUsd'
>;

/**
 * Builds the `POST /api/runs` body from the task text plus the run settings
 * passed down as props.
 *
 * Exported and unit-tested directly (`TaskForm.test.ts`), rather than only
 * indirectly through a render, because this package's web tests run under
 * plain Node with no DOM — see the equivalent pulls-logic-out-of-the-hook
 * convention in `useReplay.ts`'s `foldEvents` and `useSettings.ts`'s
 * `parseStoredSettings`/`validateSettings`. This is the only function in the
 * file that needs testing: the rest is a form shell around it.
 */
export function buildCreateRunRequest(task: string, settings: RunSettingsSlice): CreateRunRequest {
  return {
    task,
    provider: settings.provider,
    concurrency: settings.concurrency,
    timeoutMs: settings.assignmentTimeoutMs,
    // `exactOptionalPropertyTypes` is on: an absent budget must be an absent
    // *key*, not a key explicitly set to `undefined` — the latter would defeat
    // `CreateRunRequestSchema`'s `.optional()` and fail `CreateRunRequest`'s
    // own type, which is exactly the bug this rule exists to catch at compile
    // time rather than round-trip to the server to discover.
    ...(settings.runTokenBudget === undefined ? {} : { tokenBudget: settings.runTokenBudget }),
    ...(settings.maxCostUsd === undefined ? {} : { maxCostUsd: settings.maxCostUsd }),
  };
}

export function TaskForm({
  onStart,
  provider,
  concurrency,
  assignmentTimeoutMs,
  runTokenBudget,
  maxCostUsd,
  settingsInvalid,
  blockedReason,
  busy,
}: TaskFormProps): JSX.Element {
  const [task, setTask] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(undefined);

    const trimmed = task.trim();
    if (trimmed.length === 0) {
      setError('a task is required');
      return;
    }

    setSubmitting(true);
    // The same absent-key discipline the builder itself documents, applied one
    // level earlier: `runTokenBudget` and `maxCostUsd` are destructured props
    // typed `number | undefined`, so naming them directly would hand the
    // builder keys that are present and undefined — which is the very thing it
    // then takes care not to forward.
    onStart(
      buildCreateRunRequest(trimmed, {
        provider,
        concurrency,
        assignmentTimeoutMs,
        ...(runTokenBudget === undefined ? {} : { runTokenBudget }),
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
      }),
    )
      .then(() => setTask(''))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSubmitting(false));
  };

  return (
    <form className="task-form" onSubmit={handleSubmit}>
      <label htmlFor="task-input">Task</label>
      <textarea
        id="task-input"
        rows={4}
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="Describe what you want the team to do..."
        disabled={submitting}
      />

      <div className="task-form-row">
        {/* Not a control — a statement of what pressing the button will do.
            Someone about to spend money should be able to see which provider
            it goes to without opening the settings below. */}
        <span className="task-form-summary muted">
          via <code>{provider}</code>, {concurrency} at a time
        </span>

        <button type="submit" disabled={submitting || busy || settingsInvalid}>
          {submitting ? 'Starting…' : 'Start run'}
        </button>
      </div>

      {settingsInvalid && (
        <p className="form-error">
          {blockedReason ?? 'Fix the settings below before starting a run.'}
        </p>
      )}
      {error !== undefined && <p className="form-error">{error}</p>}
    </form>
  );
}
