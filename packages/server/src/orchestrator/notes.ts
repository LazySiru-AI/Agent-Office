import type { DiagnosticKind } from '@agent-office/shared';
import { maskFencedCode } from './markdown.js';

/**
 * Agent-authored diagnostics, parsed out of a finished report.
 *
 * An agent doing the work is the only participant that sees the brief, the tools
 * it was actually granted, and the distance between them. Until this existed it
 * had nowhere to say so: a remark about a missing tool went into the body of a
 * report about something else, where it reads as a caveat and is never read
 * again.
 *
 * ## The marker
 *
 * `[[ENHANCEMENT: text]]`, `[[BLOCKER: text]]`, `[[NOTE: text]]` — the shape
 * `review.ts` already established for `[[REVIEW_VERDICT: ...]]`, reused rather
 * than re-invented. Its reasoning carries over exactly: double square brackets
 * are not markdown syntax, so a model that bolds its report, puts the line under
 * a heading, or fences the whole thing as a code block cannot destroy the
 * marker — those wrappers add characters *around* the token.
 *
 * ## What this deliberately does not do
 *
 * **It does not strip the markers from the report.** The alternative is a report
 * whose text differs from what the agent wrote, and a reader comparing the PDF
 * against the transcript would find the difference and have no way to explain
 * it. The markers are short, they read as a footnote, and leaving them in place
 * keeps "the report" one thing.
 *
 * **It does not interpret, rank or dedupe.** A note saying the same thing as one
 * from a run last week is still a second occurrence, and the count is the signal
 * — `scripts/diagnostics.ts` groups at read time for exactly that reason. Losing
 * one here to avoid a duplicate would throw away the frequency that makes the log
 * worth keeping.
 */

/** One marker an agent placed in its report. */
export interface AgentNote {
  kind: Extract<DiagnosticKind, 'enhancement' | 'blocker' | 'note'>;
  text: string;
}

/**
 * The markers, mapped to their diagnostic kinds.
 *
 * `SUGGESTION` is accepted as a synonym for `ENHANCEMENT` because it is the word
 * a model reaches for unprompted about half the time, and refusing it would mean
 * silently dropping the note — the one failure this parser must not have, since
 * nothing downstream can tell "the agent had nothing to say" from "the agent said
 * it in a word we do not accept".
 */
const MARKERS: ReadonlyArray<{ token: string; kind: AgentNote['kind'] }> = [
  { token: 'ENHANCEMENT', kind: 'enhancement' },
  { token: 'SUGGESTION', kind: 'enhancement' },
  { token: 'BLOCKER', kind: 'blocker' },
  { token: 'NOTE', kind: 'note' },
];

/**
 * Cap on a single note.
 *
 * A marker whose closing bracket the model forgot would otherwise swallow the
 * rest of the report — the regex is non-greedy, but an unterminated marker at the
 * end of a 24k report would still match nothing at all, and a terminated one two
 * thousand lines later would match everything between. Bounding the body means
 * the worst case is a truncated note rather than a report pasted into the
 * diagnostics log.
 */
const MAX_NOTE_CHARS = 2_000;

/**
 * A marker counts only when it OPENS A LINE.
 *
 * The rule exists because a live run produced the failure it prevents.
 * `error-detective` wrote a 10,017-byte audit whose findings discussed this very
 * mechanism, and quoted the marker mid-sentence while doing so:
 *
 *     ...every specialist the Manager picked reports `[[BLOCKER: ...]]` because
 *     the request is genuinely out of scope for them...
 *
 * The old pattern matched anywhere in the text, so the citation was read as a
 * declaration: a completed assignment was recorded `declined`, and the diagnostics
 * log gained a blocker whose entire message was `...` — the placeholder from this
 * file's own brief text.
 *
 * Position is the discriminator, and the real data says so cleanly. In the same
 * run, the genuine note (`code-reviewer`'s) began at column 0 on its own line; the
 * citation sat mid-sentence inside inline code. An agent DECLARING something puts
 * the marker where a reader will see it; an agent DESCRIBING one writes it into a
 * sentence. `review.ts` already asks its verdict marker to stand alone for the
 * same reason — this makes the parser enforce what the brief asks for rather than
 * trusting it.
 *
 * A leading list bullet or bold wrapper is allowed, because that is how a model
 * formats a line it considers important, and neither turns a declaration into a
 * quotation.
 */
const MARKER_TOKENS = MARKERS.map((m) => m.token).join('|');

const NOTE_PATTERN = new RegExp(
  String.raw`^[ 	]*(?:[-*+][ 	]*)?(?:\*\*)?\[\[\s*(${MARKER_TOKENS})\s*:\s*([\s\S]{1,${MAX_NOTE_CHARS}}?)\s*\]\]`,
  'gim',
);

/**
 * Fenced code blocks are removed before matching.
 *
 * A report explaining this system will quote the markers, and a fenced block is
 * where documentation examples live. Stripping them first means the parser never
 * has to distinguish "an agent showing what a marker looks like" from "an agent
 * using one" inside a context that exists to display text literally.
 *
 * The implementation lives in `./markdown.js` — `review.ts`'s
 * `parseReviewVerdict` needs this exact same rule, and a second copy of the
 * regex here is how the two parsers would quietly drift apart.
 */

/**
 * A body with no letter or digit in it is a placeholder, not a note.
 *
 * `[[BLOCKER: ...]]` is the literal example this file's brief text prints, and a
 * model copying the shape rather than filling it in produced exactly that in a
 * real run — a record whose whole message was three dots, which then flipped an
 * assignment's status. Rejecting it costs nothing: there is no note worth keeping
 * that contains no word.
 */
function isPlaceholder(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

export function parseAgentNotes(report: string): AgentNote[] {
  const notes: AgentNote[] = [];

  for (const match of maskFencedCode(report).matchAll(NOTE_PATTERN)) {
    const token = match[1]?.toUpperCase();
    const text = match[2]?.trim();
    if (token === undefined || text === undefined || text === '') continue;
    if (isPlaceholder(text)) continue;

    const marker = MARKERS.find((m) => m.token === token);
    if (marker === undefined) continue;

    notes.push({ kind: marker.kind, text });
  }

  return notes;
}

/**
 * The paragraph in the assignment brief that tells an agent this channel exists.
 *
 * Kept here rather than inline in `brief.ts` so the wording and the parser that
 * has to match it live in one file. A brief that documented a marker this module
 * does not accept would produce notes that vanish silently, which is worse than
 * having no channel at all — the agent would believe it had reported something.
 */
export const AGENT_NOTES_BRIEF_SECTION = [
  '# Telling the operators something',
  '',
  'If something about this system — not the task — got in your way or could be',
  'better, say so with a marker. These are collected across all runs and read by',
  'the people who maintain this office; nothing else in your report is.',
  '',
  '- `[[BLOCKER: ...]]` — something stopped you producing what was asked for, and',
  '  **you did not produce it**. This one changes the outcome: an assignment whose',
  '  report carries a BLOCKER is recorded as *declined* rather than done, and the',
  '  manager is told the work is missing. Use it only when that is true.',
  '- `[[ENHANCEMENT: ...]]` — you could have done this better with X. You still did',
  '  the work.',
  '- `[[NOTE: ...]]` — worth knowing, neither of the above. **If you completed the',
  '  work and want to flag a limitation, this is the marker, not BLOCKER.**',
  '',
  '**Put a marker on its own line.** A marker written inside a sentence is read as',
  'a quotation, not a declaration — so you can describe these markers in a report',
  'without accidentally filing one. Only a line that starts with the marker counts.',
  '',
  'Use them only for the system itself: a missing tool, a brief that omitted',
  'something you needed, a capability that would have changed your answer. Findings',
  'about the TASK belong in the report body, not here. Most reports should carry',
  'none of these, and a report that carries one for the sake of it costs the next',
  'reader the time to dismiss it.',
].join('\n');
