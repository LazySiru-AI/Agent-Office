import type { ReportDocument, RosterEntry } from '@agent-office/shared';
import { escapeHtml, coerceThemeId } from './document.js';
import { renderMarkdown } from './markdown.js';
import { getReportTheme } from './themes.js';

/**
 * Per-agent export (FR-P6): pull one agent's appendix out of a
 * {@link ReportDocument} and render it — markdown and HTML forms — as a
 * standalone document that makes sense read on its own, away from the bundle.
 * The alternative to downloading the whole combined PDF just to read one
 * agent's report.
 *
 * ## Selecting an agent: name or index
 *
 * `AgentRef` accepts either, because both are the natural handle a caller has
 * to hand: the UI showing the roster knows agent names, a caller iterating
 * `doc.appendices` knows positions. A string is matched against
 * `appendix.agentName` (exact match; appendix order is dispatch order and
 * names come from `RunPlanSchema`'s closed agent-name validation, so
 * duplicates should not occur in practice — the first match wins if one
 * somehow does, same "first wins" rule `registry.byName` already uses
 * elsewhere in this codebase). A number is matched as a zero-based index into
 * `doc.appendices`, mirroring how `document.ts` numbers appendices for
 * display (`Appendix ${index + 1}`) while staying zero-based here to match
 * ordinary array indexing rather than the display numbering.
 *
 * ## Unknown agent: throws, does not return `undefined`
 *
 * {@link findAppendix} throws {@link AppendixNotFoundError} rather than
 * returning `undefined` for a name or index that does not resolve. The
 * alternative — an `Appendix | undefined` return — was rejected to stay
 * consistent with how the rest of this layer signals failure: `pdf.ts`
 * throws a single named error class (`PdfRenderError`) for every failure it
 * can produce, rather than returning a result union, and callers there
 * already have an established pattern (try/catch, log, degrade — see
 * `deliverable.ts`'s step 4) for turning a thrown report-layer error into a
 * non-fatal outcome. An `undefined` return here would need that same
 * try/catch-shaped handling at every call site anyway (a per-agent export
 * endpoint cannot serve `undefined` as a response body), just spelled as an
 * `if (result === undefined)` instead of a `catch` — strictly more to write
 * for no safety gained, and one more shape for a manager wiring routes on
 * top of this module to have to learn. A thrown, named, catchable error also
 * carries a human-readable reason (which names/indices *did* exist) for free,
 * which a bare `undefined` cannot.
 */

export type AgentRef = string | number;

/** Thrown by {@link findAppendix} (and therefore by the two export functions built on it) for an unresolvable {@link AgentRef}. */
export class AppendixNotFoundError extends Error {
  constructor(ref: AgentRef, doc: ReportDocument) {
    const known = doc.appendices.map((a) => a.agentName).join(', ');
    const knownNote = known === '' ? 'this report has no appendices at all' : `known agents: ${known}`;
    const refNote = typeof ref === 'number' ? `index ${String(ref)}` : `agent "${ref}"`;
    super(`No appendix found for ${refNote} in run "${doc.runId}" — ${knownNote}.`);
    Object.setPrototypeOf(this, AppendixNotFoundError.prototype);
    this.name = 'AppendixNotFoundError';
  }
}

/**
 * Resolve `ref` against `doc.appendices`. See the module comment for the
 * name-vs-index contract and why this throws instead of returning
 * `undefined`.
 */
export function findAppendix(
  doc: ReportDocument,
  ref: AgentRef,
): { appendix: ReportDocument['appendices'][number]; index: number } {
  if (typeof ref === 'number') {
    const appendix = doc.appendices[ref];
    if (appendix === undefined) throw new AppendixNotFoundError(ref, doc);
    return { appendix, index: ref };
  }

  const index = doc.appendices.findIndex((a) => a.agentName === ref);
  if (index === -1) throw new AppendixNotFoundError(ref, doc);
  const appendix = doc.appendices[index];
  if (appendix === undefined) throw new AppendixNotFoundError(ref, doc);
  return { appendix, index };
}

/** The roster row for `agentName`, when the roster carries one — used for the "Objective"/"Outcome" header facts. */
function findRosterEntry(doc: ReportDocument, agentName: string): RosterEntry | undefined {
  return doc.roster.find((entry) => entry.agentName === agentName);
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Reclose an odd number of ``` fence markers. Same technique and same
 * rationale as `markdownExport.ts`'s `closeFences` (not reused directly
 * across the two modules only because each is a five-line, dependency-free
 * function — the shared idea is documented once, in `markdownExport.ts`'s
 * module comment, rather than duplicated in a comment here too).
 */
function closeFences(md: string): string {
  const fenceCount = (md.match(/```/g) ?? []).length;
  return fenceCount % 2 === 1 ? `${md}\n\`\`\`` : md;
}

/**
 * Build one agent's report as a standalone markdown document: enough header
 * context (run, task, agent, objective) that the file is legible with no
 * other file from the bundle beside it, then the agent's own report
 * unmodified but for the same fence-closing safety `markdownExport.ts`
 * applies to every embedded section.
 *
 * Throws {@link AppendixNotFoundError} — see the module comment — rather
 * than returning `undefined` for an unresolvable `ref`.
 */
export function buildAgentMarkdown(doc: ReportDocument, ref: AgentRef): string {
  const { appendix } = findAppendix(doc, ref);
  const roster = findRosterEntry(doc, appendix.agentName);

  const lines: string[] = [
    `# ${appendix.agentName} — ${doc.task}`,
    '',
    `**Run ID:** ${doc.runId}`,
    `**Generated:** ${formatDate(doc.generatedAt)}`,
    `**Domain:** ${doc.domain}`,
  ];

  if (roster !== undefined) {
    lines.push(`**Objective:** ${roster.role}`, `**Outcome:** ${roster.status}`);
  }

  lines.push(`**Source:** ${appendix.path}`, '', '---', '', closeFences(appendix.markdown));

  return lines.join('\n');
}

/**
 * Build one agent's report as a standalone, self-contained HTML document
 * suitable for `pdf.ts`'s `renderPdf({ kind: 'html', html }, outputPath)` —
 * the same entry point `deliverable.ts` uses for the combined report, so a
 * per-agent PDF keeps the same offline guarantees (inlined theme CSS, no
 * external references; see `pdf.ts`'s module comment) for free.
 *
 * Deliberately reuses `document.ts`'s `escapeHtml`/`coerceThemeId` and
 * `markdown.ts`'s `renderMarkdown` rather than re-deriving a second escaping
 * story: `renderMarkdown` is what neutralises raw HTML, inert-ifies links and
 * images, and bounds pathological emphasis runs (see that module's own
 * extensive comment) for the *combined* report's appendices, and a single
 * agent's report is exactly the same kind of untrusted model output — there
 * is no argument for a lighter (or different) defense just because this
 * export renders one appendix instead of several. The HTML reuses
 * `document.ts`'s own class contract (`cover`, `cover-title`, `cover-meta`,
 * `appendix`, `appendix-header`) instead of inventing new ones, so the
 * existing theme stylesheets in `themes.ts` style this page with no changes
 * needed there.
 *
 * Throws {@link AppendixNotFoundError} for an unresolvable `ref`, same as
 * {@link buildAgentMarkdown}.
 */
export function buildAgentReportHtml(doc: ReportDocument, ref: AgentRef): string {
  const { appendix } = findAppendix(doc, ref);
  const roster = findRosterEntry(doc, appendix.agentName);
  const theme = getReportTheme(coerceThemeId(doc.theme));

  const metaRows: string[] = [
    `<dt>Run</dt><dd>${escapeHtml(doc.runId)}</dd>`,
    `<dt>Date</dt><dd>${escapeHtml(formatDate(doc.generatedAt))}</dd>`,
    `<dt>Domain</dt><dd>${escapeHtml(doc.domain)}</dd>`,
  ];
  if (roster !== undefined) {
    metaRows.push(
      `<dt>Objective</dt><dd>${escapeHtml(roster.role)}</dd>`,
      `<dt>Outcome</dt><dd>${escapeHtml(roster.status)}</dd>`,
    );
  }
  metaRows.push(`<dt>Source</dt><dd>${escapeHtml(appendix.path)}</dd>`);

  const title = `${appendix.agentName} — ${doc.task}`;

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${theme.css}\n</style>`,
    '</head>',
    `<body class="theme-${escapeHtml(theme.id)}">`,
    '<section class="cover">',
    `<h1 class="cover-title">${escapeHtml(appendix.agentName)}</h1>`,
    `<p class="appendix-path">${escapeHtml(doc.task)}</p>`,
    '<dl class="cover-meta">',
    metaRows.join('\n'),
    '</dl>',
    '</section>',
    '<section class="appendix">',
    `<h2 class="appendix-header">${escapeHtml(appendix.agentName)}</h2>`,
    renderMarkdown(appendix.markdown),
    '</section>',
    '</body>',
    '</html>',
  ].join('\n');
}
