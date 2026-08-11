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
 */
export interface TaskFormProps {
  onStart: (req: CreateRunRequest) => Promise<string>;
  /** From `useSettings` — what the run will be started with. */
  provider: string;
  concurrency: number;
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

export function TaskForm({
  onStart,
  provider,
  concurrency,
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
    onStart({ task: trimmed, provider, concurrency })
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
