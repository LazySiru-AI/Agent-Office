import { useState, type FormEvent } from 'react';
import type { CreateRunRequest } from '@agent-office/shared';

/**
 * Task input + "Start run" button.
 *
 * `PROVIDER_IDS` is duplicated here rather than imported: `web` may depend
 * only on `shared`, and the canonical list lives in
 * `packages/server/src/providers/types.ts`. Only `scripted` is wired up as
 * of Phase 3 (see PLAN.md Phase 1/7) — the others are listed so the selector
 * doesn't need editing again the moment a real adapter lands, but picking one
 * today will surface as a run failure rather than silently falling back.
 */
const KNOWN_PROVIDERS = ['scripted', 'claude-code', 'anthropic', 'openai', 'deepseek'] as const;

export interface TaskFormProps {
  onStart: (req: CreateRunRequest) => Promise<string>;
  /** Disable the form while a run is already in flight isn't required by the
   * contract (runs execute independently), but a busy indicator on the
   * button avoids double-submits while the create request is pending. */
  busy: boolean;
}

export function TaskForm({ onStart, busy }: TaskFormProps): JSX.Element {
  const [task, setTask] = useState('');
  const [provider, setProvider] = useState<string>('scripted');
  const [concurrency, setConcurrency] = useState('');
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

    const req: CreateRunRequest = { task: trimmed, provider };
    const concurrencyNum = concurrency.trim().length > 0 ? Number(concurrency) : undefined;
    if (concurrencyNum !== undefined) {
      if (!Number.isInteger(concurrencyNum) || concurrencyNum < 1) {
        setError('concurrency must be a positive whole number');
        return;
      }
      req.concurrency = concurrencyNum;
    }

    setSubmitting(true);
    onStart(req)
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
        <label htmlFor="provider-select">Provider</label>
        <select
          id="provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          disabled={submitting}
        >
          {KNOWN_PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <label htmlFor="concurrency-input">Concurrency</label>
        <input
          id="concurrency-input"
          type="number"
          min={1}
          max={12}
          placeholder="default"
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
          disabled={submitting}
        />

        <button type="submit" disabled={submitting || busy}>
          {submitting ? 'Starting…' : 'Start run'}
        </button>
      </div>

      {error !== undefined && <p className="form-error">{error}</p>}
    </form>
  );
}
