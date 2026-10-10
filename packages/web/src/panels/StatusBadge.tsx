import type { AssignmentStatus, RunStatus } from '@agent-office/shared';
import { statusGlyph, statusToneClass } from '../theme/status.js';

/**
 * One status chip (FR-U4).
 *
 * Four panels used to build this inline as
 * `<span className={`status-badge status-${status}`}>`, which pushed the
 * whole status vocabulary into the stylesheet: eighteen `.status-*` rules,
 * each of which had to be remembered when a status was added, and none of
 * which could fail loudly if it were forgotten — an unmatched CSS selector is
 * not an error, it is an unstyled grey chip.
 *
 * Routing every badge through here moves that decision into TypeScript,
 * where `statusToken` is a total `Record` over the shared unions and a new
 * status is a compile error until it has a colour and a glyph.
 *
 * The glyph is rendered as a real element rather than a CSS `::before` so it
 * is part of the accessible name and survives a stylesheet that never
 * arrives. It is `aria-hidden` only in the sense that it needs no separate
 * announcement — the status word next to it already says the same thing, and
 * a screen reader reading "tick done" is noise, so the glyph is marked
 * decorative and the text carries the meaning.
 */
export function StatusBadge({ status }: { status: RunStatus | AssignmentStatus }): JSX.Element {
  return (
    <span className={`status-badge ${statusToneClass(status)}`}>
      <span className="status-glyph" aria-hidden="true">
        {statusGlyph(status)}
      </span>
      {status}
    </span>
  );
}
