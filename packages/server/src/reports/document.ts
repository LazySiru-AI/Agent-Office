import {
  REPORT_THEME_IDS,
  formatCostUsd,
  type ReportDocument,
  type ReportThemeId,
  type RosterEntry,
} from '@agent-office/shared';
import { extractHeadingOutline, renderMarkdown, type HeadingOutlineEntry } from './markdown.js';
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
  // `formatCostUsd` (shared/src/wire.ts) is what the live UI renders cost
  // with — two decimals above a cent, four below, `$0.00` for a genuine zero,
  // an em dash for "unknown". This used to be reimplemented here with an
  // unconditional `toFixed(4)`, so a real run's cover page read
  // `$123.4560` while the same run's UI read `$123.46` — the same number,
  // disagreeing with itself, which looks like a bug in one of the two
  // renderers when it was really two independent formatters drifting apart.
  // Calling the shared function instead of matching it by hand is what makes
  // that drift structurally impossible rather than merely fixed for now.
  const cost = formatCostUsd(doc.costUsd);

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

/**
 * Doc3 (P3): the id namespace assigned to appendix `index` (0-based) and to
 * every heading id `renderMarkdown` produces inside it.
 *
 * Keyed on the appendix's 1-based position, not the agent's name: an agent
 * name is model-supplied text and two assignments can legitimately share one
 * (a retried or duplicated agent), which would make a name-derived prefix
 * exactly the kind of collision this scheme exists to prevent. Position in
 * `doc.appendices` is stable, unique by construction, and requires no
 * escaping or slugifying of its own — it is already a bare integer.
 */
function appendixIdPrefix(index: number): string {
  return `appendix-${String(index + 1)}-`;
}

/** The id on an appendix's own `<h2>` — what a TOC entry for "the appendix" (as opposed to a heading inside it) links to. */
function appendixAnchorId(index: number): string {
  return `appendix-${String(index + 1)}`;
}

/** Same idea as {@link appendixIdPrefix}/{@link appendixAnchorId}, for the one synthesis section. */
const SYNTHESIS_ANCHOR_ID = 'synthesis';
const SYNTHESIS_ID_PREFIX = 'synthesis-';

function renderAppendices(doc: ReportDocument): string {
  // Each appendix starts a page (`.appendix { break-before: page }` in the
  // shared print mechanics), so a reader can find an agent's report by flicking
  // rather than scrolling — the whole point of appendices in a printed document.
  return doc.appendices
    .map((appendix, index) =>
      [
        '<section class="appendix">',
        `<h2 class="appendix-header" id="${appendixAnchorId(index)}">Appendix ${String(index + 1)} — ${escapeHtml(appendix.agentName)}</h2>`,
        `<p class="appendix-path">${escapeHtml(appendix.path)}</p>`,
        // idPrefix namespaces every heading id this appendix's markdown
        // produces (see `appendixIdPrefix`'s doc comment and
        // "Cross-document id namespacing" in markdown.ts), so two agents who
        // both write `## Findings` — which happens routinely — get distinct,
        // stable ids instead of colliding in the final document.
        renderMarkdown(appendix.markdown, appendixIdPrefix(index)),
        '</section>',
      ].join('\n'),
    )
    .join('\n');
}

/**
 * Doc3 (P3): how deep a table-of-contents entry can be, expressed as the
 * *shifted* level `extractHeadingOutline` returns (see `HEADING_SHIFT` in
 * markdown.ts — a report's own `#` arrives here as level 3, its `##` as
 * level 4, and so on).
 *
 * Cut at level 4 — a report's top-level title (`#`) plus its immediate
 * sections (`##`) — and nothing deeper. The brief for this fix put it well:
 * an outline of every `######` in every appendix is noise, while one entry
 * per report is useful. Level 3 alone (title only) would satisfy that
 * literally but leaves the synthesis section contributing nothing to the
 * TOC in the (typical) case where the Manager's synthesis is written as a
 * sequence of `##` sections with no `#` title of its own — the document's
 * own most important section would be the one part of the TOC that never
 * grows past a single, page-anchoring line. Including `##` as well as `#`
 * keeps that section's Findings/Recommendations/Gaps-style headers visible
 * without going anywhere near `###` and deeper, which is exactly the
 * "flicking through one agent's internal sub-sections" detail a reader only
 * wants once they are already on that page.
 */
const TOC_MAX_HEADING_LEVEL = 4;

/**
 * Doc3 (P3): below this many total entries, `renderTableOfContents` renders
 * nothing at all.
 *
 * A table of contents earns its place by letting a reader jump to one
 * destination among several without reading past the others. Below three
 * entries there is no such choice to make — one or two destinations are
 * exactly what a reader passes on the way to the end regardless, so a
 * contents page ahead of them adds a page to flip past rather than saving
 * one. Three is also the smallest run this can realistically stay at:
 * `buildTocSections` always contributes one entry for "Synthesis" before a
 * single appendix is even counted, so the threshold has to be strictly above
 * "synthesis plus one appendix, neither with any sub-headings" for a
 * one-agent run not to grow a contents page it does not need.
 */
const TOC_MIN_ENTRIES = 3;

/** One section of the table of contents: a document-level anchor (Synthesis, or one Appendix) plus its own filtered heading outline. */
interface TocSection {
  id: string;
  label: string;
  entries: HeadingOutlineEntry[];
}

/**
 * The table of contents' full structure — one section per document-level
 * anchor (the synthesis, then each appendix, matching `buildReportHtml`'s
 * actual document order), each carrying the sub-headings from its own
 * markdown that pass {@link TOC_MAX_HEADING_LEVEL}.
 *
 * Split out from `renderTableOfContents` so the threshold check
 * (`TOC_MIN_ENTRIES`) can count entries before any HTML is built — rendering
 * a TOC only to discard it would work, but computing the count first is what
 * lets `renderTableOfContents` stay a single pass with no wasted string work
 * on the (common, for a small run) case where nothing is rendered at all.
 */
function buildTocSections(doc: ReportDocument): TocSection[] {
  const synthesisEntries = extractHeadingOutline(doc.synthesisMarkdown, SYNTHESIS_ID_PREFIX).filter(
    (entry) => entry.level <= TOC_MAX_HEADING_LEVEL,
  );

  const sections: TocSection[] = [
    { id: SYNTHESIS_ANCHOR_ID, label: 'Synthesis', entries: synthesisEntries },
  ];

  doc.appendices.forEach((appendix, index) => {
    const entries = extractHeadingOutline(appendix.markdown, appendixIdPrefix(index)).filter(
      (entry) => entry.level <= TOC_MAX_HEADING_LEVEL,
    );
    sections.push({
      id: appendixAnchorId(index),
      // Matches the visible text on the appendix's own `<h2>` in
      // `renderAppendices`, so the TOC entry and the page it points to read
      // as the same heading rather than two different labels for one thing.
      label: `Appendix ${String(index + 1)} — ${appendix.agentName}`,
      entries,
    });
  });

  return sections;
}

/** Total TOC line count (one per section anchor, plus its filtered sub-headings) — what {@link TOC_MIN_ENTRIES} is compared against. */
function countTocEntries(sections: readonly TocSection[]): number {
  return sections.reduce((total, section) => total + 1 + section.entries.length, 0);
}

/**
 * Doc3 (P3): the table of contents, or `''` below {@link TOC_MIN_ENTRIES}.
 *
 * Two nesting levels: an outer, numbered list with exactly one entry per
 * document-level anchor (Synthesis, then each appendix — see
 * `buildTocSections`), and — only where headings exist to show — an inner,
 * bulleted list of that section's own top-level headings. The numbered outer
 * list mirrors the appendix numbering already printed on each appendix's own
 * header (`Appendix 1`, `Appendix 2`, …); the unordered inner list marks
 * those entries as "contents of the page above", not siblings of it.
 *
 * Deliberately built from bare `<h2>`/`<ol>`/`<ul>`/`<a>` with no new class
 * names beyond `.toc` itself: `reports/themes.ts` and `reports/designer.ts`
 * are owned by other work in flight right now, so this cannot add a class
 * those files would need to style for the four themes to stay visually
 * distinct. Every theme already has an opinion on how it renders a heading
 * and a list; reusing those elements means the TOC inherits each theme's
 * typography for free rather than rendering as a fifth, unstyled visual
 * language bolted onto whichever theme a run happens to pick. The one thing
 * no theme has an opinion on — link colour, since `renderMarkdown` never
 * emits an `<a>` — is set locally by {@link TOC_CSS} rather than added to
 * `themes.ts`, for the same reason.
 */
function renderTableOfContents(doc: ReportDocument): string {
  const sections = buildTocSections(doc);
  if (countTocEntries(sections) < TOC_MIN_ENTRIES) return '';

  const items = sections
    .map((section) => {
      const sub =
        section.entries.length === 0
          ? ''
          : [
              '<ul class="toc-sublist">',
              section.entries
                .map(
                  (entry) =>
                    `<li><a href="#${escapeAttribute(entry.id)}">${escapeHtml(entry.text)}</a></li>`,
                )
                .join('\n'),
              '</ul>',
            ].join('\n');

      return [
        '<li>',
        `<a href="#${escapeAttribute(section.id)}">${escapeHtml(section.label)}</a>`,
        sub,
        '</li>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<section class="toc">',
    '<h2 class="toc-header">Table of Contents</h2>',
    `<ol class="toc-list">${items}</ol>`,
    '</section>',
  ].join('\n');
}

/** Same as {@link escapeHtml}; named separately at attribute-value call sites for clarity (matches the convention `markdown.ts` uses for the same distinction). */
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

/**
 * Doc3 (P3): the small amount of CSS the TOC needs that no theme already
 * provides. Appended to the chosen theme's own stylesheet rather than added
 * to `reports/themes.ts` — see `renderTableOfContents`'s doc comment for why
 * that file is off-limits here.
 *
 * - Link colour/underline: `renderMarkdown` never emits an `<a>` (see its
 *   "Links render as text plus URL" section), so no theme has ever needed an
 *   `a` rule; without one, these links would fall back to the browser/
 *   Chromium default blue, which no theme's palette was designed against.
 *   `color: inherit` keeps a TOC entry the same colour as the section label
 *   next to it in every theme; the underline is kept (rather than removed)
 *   as the one visual cue that these entries are links at all, screen or
 *   print.
 * - `break-inside: avoid` on TOC list items: the same print concern
 *   `themes.ts`'s shared print mechanics already apply to table rows and
 *   code blocks (see its `PRINT_MECHANICS` block) — headless Chrome's
 *   paginator can otherwise slice a single `<li>` across a page boundary,
 *   leaving an entry's link on one page and its visible text on the next.
 */
const TOC_CSS = `
  .toc a { color: inherit; text-decoration: underline; }
  .toc-list > li { break-inside: avoid; margin-bottom: 2mm; }
  .toc-sublist li { break-inside: avoid; }
`;

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
  const toc = renderTableOfContents(doc);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(doc.task)}</title>`,
    // TOC_CSS is a fixed, non-agent-controlled string local to this module —
    // see `renderTableOfContents`'s doc comment for why it lives here rather
    // than in `reports/themes.ts`.
    `<style>\n${theme.css}\n${TOC_CSS}\n</style>`,
    '</head>',
    `<body class="theme-${escapeHtml(theme.id)}">`,
    renderCover(doc),
    // Between the cover and the synthesis, matching the document's actual
    // reading order: a reader opens the cover, then either reads on or (for
    // a long, many-appendix run) jumps straight to the appendix they want.
    // `toc` is already '' below TOC_MIN_ENTRIES, and the `.page-break` after
    // it is skipped along with it — an empty TOC must not still force the
    // synthesis onto its own page, which would just be a blank gap with
    // nothing to justify it.
    toc,
    toc === '' ? '' : '<div class="page-break"></div>',
    '<section class="synthesis">',
    `<h2 class="synthesis-header" id="${SYNTHESIS_ANCHOR_ID}">Synthesis</h2>`,
    // idPrefix namespaces this section's heading ids exactly as each
    // appendix's does below — see `appendixIdPrefix`'s doc comment.
    renderMarkdown(doc.synthesisMarkdown, SYNTHESIS_ID_PREFIX),
    '</section>',
    renderAppendices(doc),
    '</body>',
    '</html>',
  ].join('\n');
}
