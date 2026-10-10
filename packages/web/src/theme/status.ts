import {
  ASSIGNMENT_STATUSES,
  RUN_STATUSES,
  type AssignmentStatus,
  type RunStatus,
} from '@agent-office/shared';
import type { ThemeTokens } from './tokens.js';

// ---------------------------------------------------------------------------
// A3: what to tell a screen-reader user when a run's status changes.
// ---------------------------------------------------------------------------

/**
 * What to announce to assistive technology when a run's status changes, or
 * `undefined` when nothing should be — which also covers the "no change"
 * case (`next === previous`), so a caller that re-renders for an unrelated
 * reason (a new log line, a token-usage update) and re-derives this from the
 * same `next` value gets `undefined` back rather than a repeated
 * announcement.
 *
 * `RunHeader.tsx` is the only live region this app had before A3
 * (`role="alert"` on `run.error`); `StatusBadge`, `LogPane` and
 * `AssignmentTable` had none, so a screen-reader user learned a run had
 * moved to `done` or `failed` only by re-reading the badge on demand. The fix
 * is not "make the status badge a live region" — a live region announces on
 * every value it is given, and this app streams token usage and log lines
 * constantly (NFR-3), so anything wired to fire on every render of anything
 * touching `RunState` would narrate noise for the entire run and drown out
 * the one thing worth saying. `RunHeader` instead tracks the PREVIOUS status
 * in a ref and calls this function only when `run.status` itself has
 * changed, and this function is deliberately choosier still about what
 * counts as worth a sentence:
 *
 * **Announced:** the run reaching a terminal state (`done` / `failed` /
 * `cancelled`) and the run reaching one of the two "waiting on you" states
 * FR-M11/FR-M12 introduce (`awaiting_approval` / `awaiting_clarification`).
 * These are exactly the moments a user who stepped away from the screen
 * needs to be told about without watching for them — the run either stopped
 * needing attention or started needing THEIRS.
 *
 * **Deliberately NOT announced:** every busy intermediate hop
 * (`queued` → `planning` → `dispatching` → `running` → `synthesizing` →
 * `designing` → `report_ready`). A run with several phases crosses most of
 * these on its way to `done`, and announcing each one would be several
 * interruptions per run for information that "the run is still going" already
 * covers — a sighted user does not get a distinct alert for each of these
 * either, they see the badge update. `LogPane`'s `role="log"` (deliberately
 * NOT `aria-live`, per that file's own comment) is where a user who wants
 * the blow-by-blow can already go looking for it.
 */
export function runStatusAnnouncement(
  previous: RunStatus | undefined,
  next: RunStatus | undefined,
): string | undefined {
  if (next === undefined || next === previous) return undefined;
  switch (next) {
    case 'done':
      return 'Run finished successfully.';
    case 'failed':
      return 'Run failed.';
    case 'cancelled':
      return 'Run was cancelled.';
    case 'awaiting_approval':
      return 'Run is waiting for you to approve the proposed team.';
    case 'awaiting_clarification':
      return 'Run is waiting for you to answer a question.';
    case 'queued':
    case 'planning':
    case 'dispatching':
    case 'running':
    case 'synthesizing':
    case 'designing':
    case 'report_ready':
      return undefined;
  }
}

/**
 * Status → colour, and the proof that the colour is legible (FR-U4).
 *
 * `tokens.ts` owns *what the palette is*; this file owns *what it means*. The
 * two are kept apart deliberately: a designer can retune a hex value in
 * `tokens.ts` without touching the semantics here, and this file can add a
 * new status without knowing anything about how `#47e07a` is made.
 *
 * `@agent-office/shared/status.ts` is the single source of truth for which
 * statuses exist — `RUN_STATUSES` and `ASSIGNMENT_STATUSES` — so this module
 * imports those unions rather than retyping the status lists. If a status is
 * ever added there, the `Record` below fails to compile until it is given a
 * colour and a glyph, which is the whole point: a status with no mapping
 * must be a build failure, not a badge that silently renders as nothing.
 */

/** Every status a run can be in, or an assignment can be in — the mapping's domain. */
type AnyStatus = RunStatus | AssignmentStatus;

/**
 * The subset of `ThemeTokens` that are status colours, derived from the
 * token interface itself (`status${string}`) rather than retyped as a
 * separate literal union. If `tokens.ts` ever renames a status token, this
 * type moves with it and every place that used the old name stops compiling.
 */
export type StatusToken = Extract<keyof ThemeTokens, `status${string}`>;

/**
 * The status → token mapping (fixed by design, see the table in the task
 * brief). Written as a `Record<AnyStatus, StatusToken>` rather than a
 * `switch` or a partial lookup: TypeScript requires an object literal typed
 * as `Record<K, V>` to supply *every* key of `K` exactly once, so this is
 * what makes the mapping total. Add a ninth `RunStatus` in shared and this
 * literal is missing a property — a compile error, not a grey badge in
 * production.
 *
 * Two different domains (`RunStatus`, `AssignmentStatus`) share several
 * literal spellings (`done`, `failed`). Where they do, the table gives them
 * the same token on purpose — `done` means the same thing whether it is a
 * run finishing or one assignment inside it finishing — so folding them into
 * one object is safe and is not losing information.
 */
export const STATUS_TOKEN: Record<AnyStatus, StatusToken> = {
  // Not yet started — a cold, idle grey. No motion, nothing to see yet.
  queued: 'statusIdle',
  pending: 'statusIdle',

  // Working out what to do, before any work is visible — the violet "thinking" hue.
  planning: 'statusPlanning',
  briefing: 'statusPlanning',

  // Waiting on something external (a slot, a dependency, a human) — amber, the
  // universal "not moving, not broken either" colour.
  dispatching: 'statusWaiting',
  blocked: 'statusWaiting',
  // FR-M11, and the clearest case this bucket has: the run is parked because it
  // is waiting on *you*. Amber rather than the violet of `planning`, because the
  // difference the user has to read at a glance is "the Manager is thinking"
  // versus "the Manager is done thinking and nothing will happen until you
  // look" — and a run that sat in the thinking colour while actually blocked on
  // a human would be the badge lying about who is holding the run up.
  awaiting_approval: 'statusWaiting',
  // FR-M12, the same bucket for the same reason: parked, waiting on you. It
  // shares `awaiting_approval`'s amber deliberately — a user does not need to
  // tell the two parks apart by colour, they need to tell "waiting on me" from
  // "working" at a glance, and the panel below the badge says which one it is.
  awaiting_clarification: 'statusWaiting',

  // Doing the work — the accent hue, because this is the state the whole
  // office exists to show.
  running: 'statusActive',
  working: 'statusActive',

  // Work is done but the output is still being assembled/handed off — a
  // cooler blue, distinct from "actively working" but not yet "successful".
  synthesizing: 'statusFinishing',
  designing: 'statusFinishing',
  reporting: 'statusFinishing',

  // Terminal success — green.
  report_ready: 'statusGood',
  done: 'statusGood',

  // Terminal failure — red. There is exactly one failure spelling in each
  // domain, so there is exactly one row here.
  failed: 'statusBad',

  // Terminal, but neither succeeded nor failed — deliberately the dimmest,
  // least saturated status colour, so it reads as "this was withdrawn" and
  // not as competing with a real result.
  cancelled: 'statusStopped',
  skipped: 'statusStopped',
  // Terminal and not a result either, but NOT `statusStopped`: a decline is
  // something the agent did and something a reader should look at, where a
  // cancel and a skip are things that happened to an assignment. Amber — the
  // "waiting on a human" colour the two parks use — because that is what a
  // decline is asking for.
  declined: 'statusWaiting',
};

/** Look up the token for any run or assignment status. Never returns `undefined`. */
export function statusToken(status: AnyStatus): StatusToken {
  return STATUS_TOKEN[status];
}

/**
 * Non-colour carriers (FR-U4): one glyph per status group, so the badge still
 * means something in greyscale, under a colour-blindness simulation, or read
 * aloud by a screen reader.
 *
 * These live here, in TypeScript, rather than as `content:` on a CSS
 * `::before`. Both would render, but only this one is a single source: the
 * `Record<StatusToken, string>` cannot be missing a tone, whereas a
 * stylesheet that forgets a selector produces a badge with no glyph and no
 * error. It also means the glyph is real text in the DOM — part of the
 * accessible name, and still there if the stylesheet fails to load.
 *
 * Single characters, so they sit next to a status word in a compact chip
 * without wrapping. The set:
 *
 *   ·   statusIdle      — queued/pending: dormant, nothing to show yet.
 *   ◆   statusPlanning  — a solid mark: deciding, not yet doing.
 *   ‼   statusWaiting   — attention wanted; stalled, not broken.
 *   ▸   statusActive    — a play head; the one state the office exists to show.
 *   »   statusFinishing — mid-transition, on its way somewhere.
 *   ✓   statusGood      — the conventional pass marker.
 *   ✕   statusBad       — the conventional fail marker.
 *   –   statusStopped   — a struck line: withdrawn, not a result.
 *
 * Each glyph is unique, so it alone — no colour, no label — disambiguates the
 * group. Asserted in `status.test.ts`.
 */
export const STATUS_GLYPH: Record<StatusToken, string> = {
  statusIdle: '·',
  statusPlanning: '◆',
  statusWaiting: '‼',
  statusActive: '▸',
  statusFinishing: '»',
  statusGood: '✓',
  statusBad: '✕',
  statusStopped: '–',
};

/** Glyph for any run or assignment status — composes `statusToken` + `STATUS_GLYPH`. */
export function statusGlyph(status: AnyStatus): string {
  return STATUS_GLYPH[statusToken(status)];
}

/**
 * The CSS class carrying a status's colour — `statusActive` →
 * `status-tone-active`.
 *
 * `styles.css` has eight `.status-tone-*` rules, one per token, instead of
 * eighteen `.status-<status>` rules. The mapping from status to tone happens
 * here, where it is total and compile-checked; the stylesheet only ever sees
 * the eight tones, so a status added to the shared union cannot slip through
 * as an unstyled chip.
 */
export function statusToneClass(status: AnyStatus): string {
  return `status-tone-${statusToken(status).replace(/^status/, '').toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// WCAG 2.1 contrast utilities.
//
// Pure functions, no DOM: they take hex strings in and return numbers out, so
// they can run in a plain Node/vitest process and be reused by any future
// tooling (a build-time palette linter, say) without pulling in a browser.
// The formulae are from WCAG 2.1 §1.4.3 / the "Relative Luminance" and
// "Contrast Ratio" definitions verbatim — see
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// ---------------------------------------------------------------------------

/** A colour's three 0-255 channels, decoded from a hex string. */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse `#rgb` or `#rrggbb` (with or without the leading `#`) into channels.
 * Every colour in `tokens.ts` is 6-digit, but 3-digit is accepted too since
 * it is valid CSS and costs nothing extra to support.
 */
export function parseHexColour(hex: string): Rgb {
  const cleaned = hex.replace('#', '');
  const expanded =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  const value = Number.parseInt(expanded, 16);
  if (expanded.length !== 6 || Number.isNaN(value)) {
    throw new Error(`parseHexColour: not a hex colour: ${JSON.stringify(hex)}`);
  }
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** One sRGB channel (0-255) to its linear-light value, per WCAG 2.1. */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG 2.1 relative luminance, 0 (black) to 1 (white).
 *
 * `0.2126`/`0.7152`/`0.0722` are the standard's own coefficients — they are
 * not arbitrary and must not be "simplified" to an even split; green
 * dominates perceived brightness far more than red or blue.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColour(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/**
 * WCAG 2.1 contrast ratio between two colours, from 1:1 (identical) to 21:1
 * (pure black on pure white). Order of arguments does not matter — the
 * formula always divides the lighter luminance by the darker one.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The AA thresholds this file cares about. Badges and body copy in this UI
 * are small text (well under the ~18pt/14pt-bold "large text" cutoff), so
 * the relevant bar is **4.5:1**, not the more lenient 3:1 that WCAG allows
 * for large text — using the large-text threshold here would be grading
 * small text against the wrong rubric.
 */
export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3.0;

/** Whether a measured ratio clears AA for normal (non-large) text. */
export function meetsAANormalText(ratio: number): boolean {
  return ratio >= WCAG_AA_NORMAL_TEXT;
}
