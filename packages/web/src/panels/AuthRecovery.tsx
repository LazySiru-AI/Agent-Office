import { useState, type FormEvent } from 'react';

/**
 * S9 — the screen a user sees when a 401 has left the app with nothing else
 * to offer.
 *
 * ## Why this exists
 *
 * AO-6 (`api.ts`'s `bootstrapAuthToken`) deliberately reads the access token
 * off the URL exactly once, at first load, and never again — it is a
 * one-time bootstrap, not a channel this app keeps using, because leaving it
 * in the URL would mean it lingers in browser history, sync services and
 * crash reports for as long as the browser keeps them. That is the right
 * call for the token's whole lifetime EXCEPT the one moment it stops
 * working: a new tab never had it, a cleared session lost it, a stale
 * bookmark or a pinned tab from a previous server run points at a token that
 * expired with that process. Before S9, every one of those left the user
 * looking at an app that fetched nothing, showed nothing, and explained
 * nothing — the only way back was already knowing to re-navigate to the
 * exact `?token=...` URL `npm run serve` printed once, which nobody
 * discovers on their own.
 *
 * This panel is what `App.tsx` renders instead, driven by
 * `state/useRun.ts`'s `unauthorized` flag (itself driven by `api.ts`'s
 * `onUnauthorized` — see that module's own comment for why a callback
 * registry, not a DOM event or a new store shape, is the mechanism). It
 * asks for the same token a different way — pasted into a field, submitted
 * through `reauthenticate` — rather than the URL, so the fix does not
 * reopen the exact hole AO-6 closed.
 *
 * ## What it does and does not do with the value
 *
 * The token is never logged, never re-rendered once accepted (the field is
 * cleared in `handleSubmit` and this whole panel unmounts the moment
 * `unauthorized` goes back to `false`, win or lose — see
 * `useRun.ts`'s `reauthenticate`, which re-fetches the run list right after
 * accepting a token specifically so a STILL-wrong token brings this panel
 * straight back rather than leaving the app looking recovered while every
 * other request keeps silently failing), and the input is `type="password"`
 * so it is not shown in plain text on screen or picked up by a screenshot —
 * not because it is a password (`serve.ts` never asks for one), but because
 * it is exactly as sensitive as one for as long as it is valid.
 */

/**
 * Pure decision #1: what "the field has something worth submitting" means.
 * Exported so this can be tested — this package's suite runs under plain
 * Node with no DOM (see e.g. `sim/scene.ts`'s `shouldTickerRun`,
 * `theme/status.ts`'s `runStatusAnnouncement`), so the component's rendered
 * `disabled` attribute is unassertable here, but the boolean behind it is
 * not.
 *
 * A pasted token often carries a trailing newline (copied with the line it
 * sat on) or leading/trailing spaces (copied out of a terminal that wrapped
 * it) — `sanitizeTokenInput` trims those before anything downstream sees
 * the value, so "just whitespace" is treated the same as "nothing typed",
 * not submitted as a token that is certain to fail.
 */
export function sanitizeTokenInput(raw: string): string {
  return raw.trim();
}

/** Whether `raw` has anything left to submit once `sanitizeTokenInput` runs on it. */
export function isSubmittableToken(raw: string): boolean {
  return sanitizeTokenInput(raw).length > 0;
}

export interface AuthRecoveryProps {
  /**
   * Called with the sanitised (trimmed) token once the form is submitted.
   * `state/useRun.ts`'s `reauthenticate` is the only caller in this app —
   * see its doc comment for what happens next (storage, the live `authToken`
   * binding, and the socket reconnect).
   */
  onSubmit: (token: string) => void;
}

export function AuthRecovery({ onSubmit }: AuthRecoveryProps): JSX.Element {
  const [value, setValue] = useState('');

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const token = sanitizeTokenInput(value);
    if (token.length === 0) return; // belt-and-suspenders — the button is already disabled for this case
    onSubmit(token);
    // Cleared unconditionally, not only on a later "it worked" signal: there
    // is no reason for the value to still be sitting in this component's own
    // state a moment after it left this component, whether the token turns
    // out to be valid or not. A still-wrong token brings this whole panel
    // back (see the file header), at which point the field is empty and
    // waiting for a fresh paste rather than showing the one already proven
    // not to work.
    setValue('');
  };

  return (
    // `role="alert"` (WCAG 3.3.1), matching `RunHeader.tsx`'s `run.error`
    // rather than `runStatusAnnouncement`'s `role="status"`: this is not a
    // routine transition a user can pick up on their own time, it is the
    // single most important thing on the page the instant it appears — every
    // other panel that still renders underneath it is either stale or about
    // to fail its own next request.
    <section className="panel auth-recovery" aria-labelledby="auth-recovery-heading" role="alert">
      <h2 id="auth-recovery-heading">This tab lost its access token</h2>
      <p className="panel-lede">
        A request just came back <strong>401 Unauthorized</strong>. The token this tab was using is
        missing, expired, or belongs to a different run of the server — most often because this is a
        new tab, the browser session was cleared, or the link that opened this page is old. Nothing
        else here will work until a valid token is supplied again.
      </p>
      <p className="auth-recovery-help">
        Paste the token below — the value that appeared after <code>?token=</code> in the URL printed
        when the server started (<code>npm run serve</code>), or wherever it was saved from that.
        It stays in this tab only (not the address bar, not browser history) and disappears from this
        screen the moment it is submitted.
      </p>

      <form onSubmit={handleSubmit} className="auth-recovery-form">
        <label htmlFor="auth-recovery-token" className="visually-hidden">
          Access token
        </label>
        <input
          id="auth-recovery-token"
          name="auth-recovery-token"
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste the access token"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" disabled={!isSubmittableToken(value)}>
          Reconnect
        </button>
      </form>
    </section>
  );
}
