import { useState, type FormEvent } from 'react';
import type { ClarificationDecision, ClarifyingQuestion } from '@agent-office/shared';

/**
 * The Manager's questions, and the form that answers them (FR-M12).
 *
 * `awaiting_clarification` is one of two run statuses meaning "nothing is
 * happening and nothing will until you act" — see `TeamReview.tsx`, which says
 * the same of `awaiting_approval` and which this panel deliberately resembles.
 * The two parks are different questions but the same situation for the user, and
 * two screens that behave differently for it would be a worse answer than one
 * shape used twice.
 *
 * ## Declining is a button, not an empty submit
 *
 * "Plan it anyway" posts `{ declined: true }`, which reaches the planner as a
 * sentence saying the user chose not to narrow the task. Submitting the form
 * with every box empty posts the same thing rather than a list of empty answers,
 * for the reason `ClarificationDecisionSchema` gives: "the jurisdiction is ''"
 * is a claim, and a false one.
 *
 * Making the decline prominent rather than hiding it is deliberate. A round the
 * user cannot easily escape is a round they learn not to ask for, and FR-M12 is
 * opt-in — the feature's whole value depends on it feeling cheap to accept.
 *
 * ## Suggestions are pre-filled, not merely shown
 *
 * When the Manager offers a `suggestion`, it starts in the box as editable text.
 * That turns the common case into "read it, press Send" instead of "read it,
 * retype it" — and a question the user can confirm in one keystroke is one that
 * actually gets answered, which is the difference between this feature working
 * and being skipped.
 */

export interface ClarifyPanelProps {
  questions: readonly ClarifyingQuestion[];
  onSubmit: (decision: ClarificationDecision) => Promise<void>;
}

export function ClarifyPanel({ questions, onSubmit }: ClarifyPanelProps): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.suggestion ?? ''])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const send = (decision: ClarificationDecision): void => {
    setBusy(true);
    setError(undefined);
    onSubmit(decision)
      .catch((err: unknown) => {
        // The run stays parked on a rejected submit — the server refuses while
        // it is still waiting rather than releasing a bad decision (see the
        // route's own comment) — so showing the reason and leaving the form
        // usable is the whole recovery path.
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();

    const given = questions
      .map((q) => ({ questionId: q.id, answer: (answers[q.id] ?? '').trim() }))
      .filter((a) => a.answer !== '');

    send(given.length === 0 ? { declined: true } : { answers: given });
  };

  return (
    <section className="panel clarify-panel" aria-labelledby="clarify-heading">
      <h2 id="clarify-heading">The Manager has {questions.length === 1 ? 'a question' : 'questions'}</h2>
      <p className="panel-lede">
        Nothing has been dispatched and nothing has been spent on the team yet. Answer what you can —
        anything you leave blank, the Manager will decide for itself.
      </p>

      <form onSubmit={handleSubmit}>
        <ol className="clarify-questions">
          {questions.map((q) => (
            <li key={q.id}>
              <label htmlFor={`clarify-${q.id}`}>{q.question}</label>
              {q.why !== undefined && q.why !== '' && <p className="clarify-why">{q.why}</p>}
              <textarea
                id={`clarify-${q.id}`}
                rows={2}
                value={answers[q.id] ?? ''}
                disabled={busy}
                onChange={(event) =>
                  setAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))
                }
              />
              {q.suggestion !== undefined && q.suggestion !== '' && (
                <p className="clarify-suggestion">
                  Manager’s guess, pre-filled — edit or clear it.
                </p>
              )}
            </li>
          ))}
        </ol>

        {error !== undefined && (
          <p className="clarify-error" role="alert">
            {error}
          </p>
        )}

        <div className="clarify-actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send answers'}
          </button>
          {/* Not a link, not buried in a menu: see the panel doc. */}
          <button type="button" disabled={busy} onClick={() => send({ declined: true })}>
            Plan it anyway
          </button>
        </div>
      </form>
    </section>
  );
}
