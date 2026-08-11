import {
  REPORT_THEME_IDS,
  type ReportDocument,
  type ReportThemeId,
  type RosterEntry,
} from '@agent-office/shared';
import { renderMarkdown } from './markdown.js';
import { getReportTheme } from './themes.js';

/**
 * Document assembly (FR-P4): cover, roster, synthesis, per-agent appendices.
 *
 * A pure function of {@link ReportDocument} and a theme — no store, no run, no
 * browser. That is what makes the whole deliverable testable without executing
 * anything, and it is why the gathering of inputs lives in the runner rather
 * than here.
 *
 * Everything that reaches this file is untrusted. The task is user input; agent
 * names, objectives and report bodies are model output. Markdown bodies go
 * through `renderMarkdown`, which escapes raw HTML itself; every other value is
 * escaped here on the way into the template. There is no path by which a report
 * can inject markup into the document's own structure.
 */

/** Minimal HTML text escaping. Applied to every interpolated value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `2026-08-10` — deliberately ISO, so a PDF filed months later is unambiguous. */
function formatDate(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return iso.slice(0, 10);
}

function formatTokens(input: number, output: number): string {
  return `${input.toLocaleString('en-GB')} in / ${output.toLocaleString('en-GB')} out`;
}

/**
 * Normalise a persisted theme id back into the closed set.
 *
 * `RunState.theme` is a plain string, so a run persisted by an older build — or
 * hand-edited — can name a theme no stylesheet exists for. Falling back beats
 * throwing at the last step of an expensive run.
 */
export function coerceThemeId(value: string | undefined): ReportThemeId {
  const found = REPORT_THEME_IDS.find((id) => id === value);
  return found ?? 'research';
}

function renderRoster(roster: readonly RosterEntry[]): string {
  if (roster.length === 0) {
    return '<p class="roster-empty">No agents were dispatched.</p>';
  }

  const rows = roster
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.agentName)}</td>` +
        `<td>${escapeHtml(entry.category)}</td>` +
        `<td>${escapeHtml(entry.role)}</td>` +
        `<td>${escapeHtml(entry.status)}</td></tr>`,
    )
    .join('\n');

  return [
    '<table class="roster-table">',
    '<thead><tr><th>Agent</th><th>Category</th><th>Role</th><th>Outcome</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n');
}

function renderCover(doc: ReportDocument): string {
  const cost =
    doc.costUsd === undefined
      ? '—'
      : doc.costUsd === 0
        ? '$0.00'
        : `$${doc.costUsd.toFixed(4)}`;

  return [
    '<section class="cover">',
    `<h1 class="cover-title">${escapeHtml(doc.task)}</h1>`,
    '<dl class="cover-meta">',
    `<dt>Date</dt><dd>${escapeHtml(formatDate(doc.generatedAt))}</dd>`,
    `<dt>Domain</dt><dd>${escapeHtml(doc.domain)}</dd>`,
    `<dt>Run</dt><dd>${escapeHtml(doc.runId)}</dd>`,
    `<dt>Tokens</dt><dd>${escapeHtml(formatTokens(doc.totalTokens.inputTokens, doc.totalTokens.outputTokens))}</dd>`,
    `<dt>Estimated cost</dt><dd>${escapeHtml(cost)}</dd>`,
    '</dl>',
    '<h2 class="roster-heading">Team</h2>',
    renderRoster(doc.roster),
    '</section>',
  ].join('\n');
}

function renderAppendices(doc: ReportDocument): string {
  // Each appendix starts a page (`.appendix { break-before: page }` in the
  // shared print mechanics), so a reader can find an agent's report by flicking
  // rather than scrolling — the whole point of appendices in a printed document.
  return doc.appendices
    .map((appendix, index) =>
      [
        '<section class="appendix">',
        `<h2 class="appendix-header">Appendix ${String(index + 1)} — ${escapeHtml(appendix.agentName)}</h2>`,
        `<p class="appendix-path">${escapeHtml(appendix.path)}</p>`,
        renderMarkdown(appendix.markdown),
        '</section>',
      ].join('\n'),
    )
    .join('\n');
}

/**
 * Build the complete, self-contained HTML document.
 *
 * Self-contained is a requirement, not a convenience: FR-P3 says the PDF is
 * produced offline, and headless Chrome renders this from a `file://` URL with
 * no network. A single `<style>` block with the theme inlined is the only shape
 * that guarantees the PDF looks the same on a machine with no internet.
 */
export function buildReportHtml(doc: ReportDocument): string {
  const theme = getReportTheme(coerceThemeId(doc.theme));

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(doc.task)}</title>`,
    `<style>\n${theme.css}\n</style>`,
    '</head>',
    `<body class="theme-${escapeHtml(theme.id)}">`,
    renderCover(doc),
    '<section class="synthesis">',
    '<h2 class="synthesis-header">Synthesis</h2>',
    renderMarkdown(doc.synthesisMarkdown),
    '</section>',
    renderAppendices(doc),
    '</body>',
    '</html>',
  ].join('\n');
}
