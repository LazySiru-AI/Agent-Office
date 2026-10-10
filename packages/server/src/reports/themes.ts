import { REPORT_THEME_IDS, type ReportThemeId } from '@agent-office/shared';

/**
 * Phase 5 print stylesheets (FR-P2 themed HTML, FR-P3 offline PDF, FR-P4
 * cover/roster/appendices).
 *
 * ---------------------------------------------------------------------------
 * WHY A CLOSED RECORD OF CSS STRINGS
 * ---------------------------------------------------------------------------
 * `REPORT_THEME_IDS` (packages/shared/src/report.ts) is the closed set the
 * designer agent chooses from. This module's job is narrow and mechanical:
 * for each of those four ids, hand back a complete, self-contained stylesheet
 * plus the handful of metadata fields the document builder needs outside the
 * `<style>` tag (a human-readable name, an accent colour for anything drawn
 * outside CSS, and the body font stack, exposed as data rather than left for
 * callers to regex out of the CSS text).
 *
 * Every theme's brief lives in `REPORT_THEME_BRIEFS` next to the id, and it
 * is shown to the *designer* model as the reason to pick a theme. If the
 * stylesheet does not visibly deliver on that brief, the designer's stated
 * rationale becomes a lie the reader can see. Each theme block below carries
 * a comment tracing its choices back to its brief's own words.
 *
 * ---------------------------------------------------------------------------
 * THE HTML/CLASS CONTRACT (read this before wiring `reports/markdown.ts` or
 * `reports/pdf.ts` against this file)
 * ---------------------------------------------------------------------------
 * `reports/markdown.ts` and `reports/pdf.ts` are being written in parallel by
 * other agents; this file was written without sight of either. Two kinds of
 * class are involved, and they are not the same kind of contract:
 *
 * Classes the markdown renderer emits (wrapper elements around structures
 * Chrome's print engine cannot scroll, so overflow has to be handled with CSS
 * rather than a scrollbar):
 *
 *   .ao-table-wrapper — wraps every `<table>` the markdown renderer produces.
 *   .ao-code-wrapper  — wraps every `<pre><code>` fenced/indented code block.
 *
 * These are reconciled against `reports/markdown.ts`, which owns the names and
 * lists them in its own block comment. They were originally guessed — this file
 * and the emitter were written in parallel, and the guess (`.md-table-wrap`)
 * was wrong.
 *
 * The guess being wrong cost nothing, by design: the *visual* theming below
 * targets bare `table`, `pre` and `code` selectors directly (they are
 * descendants of the wrapper regardless of its name), and the wrapper classes
 * carry only the `overflow`/`width` rules that stop a too-wide element bleeding
 * off the printed page. A name mismatch loses the overflow safety net, not the
 * theme. Keep it that way: styling that only works when two independently
 * written modules agree on a string is styling that will silently vanish.
 *
 * Classes this file DEFINES for whichever module assembles the final HTML
 * document (cover, roster, appendices — FR-P4) to emit:
 *
 *   .cover            — the cover page. One per document, first in the DOM;
 *                        forces a page break after itself.
 *   .cover-title      — the run's task, as the cover's headline.
 *   .cover-meta       — a `<dl>` of run id / date / domain / token+cost
 *                        totals (NFR-5 visibility). `<dt>`/`<dd>` pairs.
 *   .roster-table     — the team roster `<table>` on the cover (columns:
 *                        agent name, category, role, status — see
 *                        `RosterEntrySchema`).
 *   .synthesis        — wraps the Manager's synthesis section.
 *   .appendix         — wraps one per-agent appendix. Starts a fresh page
 *                        (`break-before: page`) so appendices never share a
 *                        page with the section before them.
 *   .appendix-header  — the agent name/path heading atop one appendix.
 *   .page-break       — an empty element (e.g. `<div class="page-break">`)
 *                        the document builder can insert anywhere a page
 *                        break is wanted that the structural rules above
 *                        don't already provide.
 *
 * ---------------------------------------------------------------------------
 * THE OVERFLOW DECISION (why wrap, not clip, not shrink)
 * ---------------------------------------------------------------------------
 * Printed paper has no scrollbar, so a table or code line wider than the
 * page either overflows invisibly off the edge (clipped — the reader loses
 * data with no sign anything is missing), or it has to fit. We choose to
 * make it fit by wrapping: `table-layout: fixed` divides the page's width
 * evenly among columns instead of letting content dictate column width, and
 * `overflow-wrap: anywhere` / `white-space: pre-wrap` on cells and code
 * force long tokens (a URL, an unbroken hash, a long identifier) to break
 * rather than push the layout wider than the page. This makes long content
 * look worse (ragged breaks) but never loses it — which for a document
 * nobody can scroll is the only defensible trade.
 *
 * ---------------------------------------------------------------------------
 * PRINT MECHANICS (why these rules and not others)
 * ---------------------------------------------------------------------------
 * FR-P3's PDF is produced by headless Chrome's `--print-to-pdf` (Skia/PDF
 * m151), so real CSS Paged Media rules apply and were verified directly:
 *  - `@page { size: A4; margin: ... }` sets the physical page and margins.
 *  - `break-after: avoid` on headings stops a heading being the last line on
 *    a page with its body pushed to the next one.
 *  - `break-inside: avoid` on table rows and code blocks stops a row or a
 *    short code block being sliced across a page boundary. This is "where
 *    sensible": a table or code block taller than one page cannot honour it
 *    and will still split, which is correct — the alternative is an
 *    unbounded blank page waiting for it to fit.
 *  - `orphans`/`widows` stop a paragraph leaving a single stranded line
 *    behind on the page it left, or alone at the top of the page it enters.
 *
 * ---------------------------------------------------------------------------
 * FR-P3: OFFLINE ONLY
 * ---------------------------------------------------------------------------
 * No `@font-face` pointing at a URL, no CDN stylesheet, no remote image.
 * Every font below is a system stack only (Segoe UI / Calibri / Consolas on
 * Windows, with cross-platform fallbacks so the same CSS degrades sanely if
 * this ever runs somewhere else). `themes.test.ts` asserts none of these
 * stylesheets contains `http://`, `https://`, or an off-disk `url(...)` —
 * that test is the FR-P3 guarantee for this file.
 */

/**
 * Metadata plus the complete stylesheet for one theme.
 *
 * `css` is a full stylesheet body (no `<style>` wrapper — the document
 * builder owns the HTML shell) meant to be dropped directly into a `<style>`
 * element. `displayName` and `accentColour` are for anything the document
 * builder draws outside CSS (e.g. a UI badge showing which theme a report
 * used); `bodyFontStack` is exposed as data rather than left for callers to
 * scrape out of `css` with a regex, because the "are the four themes
 * genuinely distinct" test needs it and scraping CSS text for that is
 * exactly the kind of test that breaks the moment a comment changes.
 */
export interface ReportTheme {
  readonly id: ReportThemeId;
  readonly displayName: string;
  /** A dark, print-safe accent colour (hex). Never the sole carrier of meaning. */
  readonly accentColour: string;
  readonly bodyFontStack: string;
  readonly css: string;
}

/**
 * Rules every theme needs and none of them vary: resets, the FR-P3 print
 * mechanics, and the overflow-safety net for the wrap classes. Theme-specific
 * concerns — `@page` margins, typography, colour, table and cover styling —
 * live in each theme's own block below, because those are exactly the things
 * the four themes must NOT share (see the "visibly, structurally different"
 * requirement this module exists to satisfy).
 */
const PRINT_MECHANICS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }
  p, li, blockquote { orphans: 3; widows: 3; }
  tr, pre, .ao-code-wrapper { break-inside: avoid; }

  /* Document-builder utility: an empty element that forces the next content
     onto a new page (e.g. \`<div class="page-break"></div>\` between the
     synthesis and the first appendix). Zero-sized so it never adds a blank
     visual gap of its own. */
  .page-break { break-after: page; height: 0; margin: 0; padding: 0; border: 0; }

  /* FR-P4: each per-agent appendix starts its own page, so one agent's
     output is never split across a page boundary shared with another's. */
  .appendix { break-before: page; }

  /* The overflow decision (see file header): fixed layout + forced wrapping
     instead of letting content overflow the page edge unseen. */
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { overflow-wrap: anywhere; word-break: break-word; }
  .ao-table-wrapper { width: 100%; overflow: hidden; }

  pre, code { overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
  pre { overflow: hidden; max-width: 100%; }
  .ao-code-wrapper { width: 100%; overflow: hidden; }

  img, svg { max-width: 100%; }

  .cover { break-after: page; }
`;

/**
 * ENGINEERING — "Software, infrastructure, security and technical review
 * work. Monospaced code, dense tables, terse captions." (REPORT_THEME_BRIEFS)
 *
 * Reading of the brief:
 *  - "monospaced code" -> code is the loudest thing on the page: bordered,
 *    shaded, left-barred, given its own colour accent — not a quiet inline
 *    aside the way it is treated in the other three themes.
 *  - "dense tables" -> a full grid (borders on every cell, not just a rule
 *    under the header), a dark filled header row, and zebra striping — the
 *    layout of a build report or a ticket table, optimised for scanning many
 *    short values rather than reading prose.
 *  - "terse captions" -> small, uppercase, tracked-out, unobtrusive.
 *  - Typeface: sans body (a build report is not a manuscript), tight
 *    line-height (1.35, the tightest of the four) and the narrowest page
 *    margins — density is the point.
 */
const ENGINEERING_ACCENT = '#1f5c78';

const ENGINEERING_CSS = `
  @page { size: A4; margin: 15mm 15mm 18mm 15mm; }

  body {
    font-family: 'Segoe UI', Calibri, Roboto, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.35;
    color: #1a1a1a;
    background: #ffffff;
  }

  h1, h2, h3, h4 {
    font-family: 'Segoe UI', Calibri, Arial, sans-serif;
    font-weight: 700;
    color: #123246;
    border-bottom: 2px solid ${ENGINEERING_ACCENT};
    padding-bottom: 2mm;
    margin-top: 8mm;
    margin-bottom: 3mm;
  }
  h1 { font-size: 20pt; letter-spacing: 0.5pt; text-transform: uppercase; }
  h2 { font-size: 14pt; }
  h3 { font-size: 11.5pt; border-bottom-width: 1px; }

  caption, .caption, figcaption {
    font-size: 8.5pt;
    color: #55606a;
    font-style: normal;
    text-transform: uppercase;
    letter-spacing: 0.3pt;
    text-align: left;
  }

  table { font-size: 9pt; border: 1px solid #b7c4cc; }
  th, td { border: 1px solid #b7c4cc; padding: 1.5mm 2mm; text-align: left; }
  thead th { background: #123246; color: #ffffff; font-weight: 700; }
  tbody tr:nth-child(even) { background: #f0f5f8; }

  pre, code {
    font-family: Consolas, 'Cascadia Mono', 'Courier New', monospace;
    font-size: 9pt;
  }
  pre {
    background: #f4f4f4;
    border: 1px solid #d0d7db;
    border-left: 3px solid ${ENGINEERING_ACCENT};
    padding: 3mm;
    line-height: 1.3;
  }
  code { background: #eef2f4; padding: 0.3mm 1mm; border-radius: 1mm; }
  pre code { background: none; padding: 0; border-radius: 0; }

  .cover {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 240mm;
  }
  .cover-title {
    font-size: 26pt;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.5pt;
    color: #123246;
    border-left: 6px solid ${ENGINEERING_ACCENT};
    padding-left: 5mm;
    margin-bottom: 6mm;
  }
  .cover-meta {
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 10pt;
    color: #333333;
  }
  .cover-meta dt { font-weight: 700; float: left; clear: left; width: 32mm; color: ${ENGINEERING_ACCENT}; }
  .cover-meta dd { margin: 0 0 1.5mm 34mm; }
  .roster-table { margin-top: 8mm; }

  .synthesis { margin-top: 4mm; }

  .appendix-header {
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 10pt;
    color: ${ENGINEERING_ACCENT};
    text-transform: uppercase;
    letter-spacing: 0.3pt;
    border-bottom: 1px solid #b7c4cc;
    padding-bottom: 1mm;
    margin-bottom: 4mm;
  }
`;

/**
 * LEGAL — "Contracts, compliance, regulatory and policy work. Serif body,
 * numbered clauses, generous margins, formal register." (REPORT_THEME_BRIEFS)
 *
 * Reading of the brief:
 *  - "serif body" -> Cambria/Georgia/Times, justified, with a first-line
 *    indent on paragraphs — set like a printed contract, not a screen page.
 *  - "numbered clauses" -> `counter-reset`/`counter-increment` on `h2`
 *    inside `.synthesis` and each `.appendix`, rendered as "1.", "2." ahead
 *    of the heading text — an actual clause numbering, not a decorative one.
 *  - "generous margins" -> 30mm, the widest of the four (engineering is
 *    15mm — literally double).
 *  - "formal register" -> restrained colour (a single deep maroon rule,
 *    never a fill), small-caps centred titles, minimal table ornamentation
 *    (a rule under the header and nothing else — no grid, no shading).
 */
const LEGAL_ACCENT = '#6b1f2a';

const LEGAL_CSS = `
  @page { size: A4; margin: 30mm 28mm 30mm 28mm; }

  body {
    font-family: Cambria, Georgia, 'Times New Roman', serif;
    font-size: 11.5pt;
    line-height: 1.5;
    color: #1c1c1c;
    background: #ffffff;
    text-align: justify;
  }

  p { text-indent: 8mm; margin: 0 0 3mm 0; }
  p:first-of-type, .cover p, blockquote p { text-indent: 0; }

  h1 {
    font-family: Cambria, Georgia, 'Times New Roman', serif;
    font-weight: 400;
    font-variant: small-caps;
    letter-spacing: 1pt;
    text-align: center;
    font-size: 18pt;
    border-top: 1px solid ${LEGAL_ACCENT};
    border-bottom: 1px solid ${LEGAL_ACCENT};
    padding: 3mm 0;
    margin: 0 0 6mm 0;
  }
  h2, h3 {
    font-family: Cambria, Georgia, 'Times New Roman', serif;
    font-weight: 700;
    font-size: 13pt;
    color: #1c1c1c;
    margin-top: 7mm;
    margin-bottom: 2mm;
  }

  /* "Numbered clauses" (brief): each top-level section within the synthesis
     and within an appendix is a numbered clause, not just a styled heading. */
  .synthesis, .appendix { counter-reset: clause; }
  .synthesis h2, .appendix h2 { counter-increment: clause; }
  .synthesis h2::before, .appendix h2::before {
    content: counter(clause) '. ';
    color: ${LEGAL_ACCENT};
    font-weight: 700;
  }

  caption, .caption, figcaption {
    font-style: italic;
    font-size: 9.5pt;
    color: #4a4a4a;
    text-align: center;
  }

  table { font-size: 10.5pt; }
  th, td { padding: 2mm 3mm; text-align: left; border: none; }
  thead th { border-bottom: 1px solid ${LEGAL_ACCENT}; font-weight: 700; text-align: left; }
  tbody tr td { border-bottom: 0.5px solid #d8cfc9; }

  pre, code { font-family: Consolas, 'Courier New', monospace; font-size: 9.5pt; }
  pre {
    background: #faf8f6;
    border: 0.5px solid #d8cfc9;
    padding: 3mm 4mm;
    line-height: 1.35;
  }
  code { background: #f3efec; padding: 0.3mm 1mm; }
  pre code { background: none; padding: 0; }

  .cover {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 220mm;
  }
  .cover-title {
    font-size: 22pt;
    font-weight: 400;
    font-variant: small-caps;
    letter-spacing: 1pt;
    border-top: 1px solid ${LEGAL_ACCENT};
    border-bottom: 1px solid ${LEGAL_ACCENT};
    padding: 4mm 8mm;
    margin-bottom: 10mm;
  }
  .cover-meta { font-size: 11pt; line-height: 2; text-align: left; }
  .cover-meta dt { display: inline; font-style: italic; color: ${LEGAL_ACCENT}; }
  .cover-meta dt::after { content: ': '; }
  .cover-meta dd { display: inline; margin: 0 8mm 0 0; }
  .roster-table { margin: 8mm auto 0; width: 90%; }

  .appendix-header {
    font-variant: small-caps;
    font-size: 14pt;
    text-align: center;
    border-bottom: 1px solid ${LEGAL_ACCENT};
    padding-bottom: 2mm;
    margin-bottom: 6mm;
  }
`;

/**
 * FINANCIAL — "Tax, accounting, valuation and risk work. Tabular figures,
 * aligned numerals, restrained rules and totals." (REPORT_THEME_BRIEFS)
 *
 * Reading of the brief:
 *  - "tabular figures, aligned numerals" -> `font-variant-numeric:
 *    tabular-nums` set globally, so every digit anywhere in the document
 *    (token counts, costs, any figure in prose or a table) lines up on a
 *    fixed-width grid the way a ledger's do, without requiring the document
 *    builder to mark numeric cells specially.
 *  - "restrained rules and totals" -> tables carry only a top and bottom
 *    rule (`border-top`/`border-bottom` on the table itself) plus a rule
 *    under the header row — no grid, no shading. A `tfoot` row (a totals
 *    row, if the document builder emits one) gets a double top rule, which
 *    is the traditional ledger "this is the sum" mark.
 *  - Typeface: sans (Calibri/Arial), because financial statements are set
 *    in a plain grotesque, not a manuscript serif — deliberately a
 *    different sans stack from engineering's, so the two sans themes still
 *    read as visually distinct documents.
 */
const FINANCIAL_ACCENT = '#1f5c3f';

const FINANCIAL_CSS = `
  @page { size: A4; margin: 20mm 18mm 22mm 18mm; }

  body {
    font-family: Calibri, Arial, 'Segoe UI', sans-serif;
    font-size: 10pt;
    line-height: 1.4;
    color: #1a1a1a;
    background: #ffffff;
    font-variant-numeric: tabular-nums;
  }

  h1, h2, h3 {
    font-family: Calibri, Arial, 'Segoe UI', sans-serif;
    font-weight: 700;
    color: ${FINANCIAL_ACCENT};
    margin-top: 7mm;
    margin-bottom: 2.5mm;
  }
  h1 { font-size: 19pt; border-bottom: 1px solid ${FINANCIAL_ACCENT}; padding-bottom: 2mm; }
  h2 { font-size: 13pt; }
  h3 { font-size: 11pt; color: #1a1a1a; }

  caption, .caption, figcaption {
    font-size: 8.5pt;
    color: #555555;
    text-align: right;
  }

  /* Restrained rules: a frame on the table, a rule under the header, and
     nothing else — no vertical grid lines, no zebra shading. */
  table {
    font-size: 9.5pt;
    border-top: 1.5px solid ${FINANCIAL_ACCENT};
    border-bottom: 1.5px solid ${FINANCIAL_ACCENT};
  }
  th, td { padding: 1.8mm 2.5mm; text-align: left; border: none; }
  thead th { border-bottom: 1px solid ${FINANCIAL_ACCENT}; font-weight: 700; }
  /* A totals row, if the document builder emits <tfoot> or class="totals",
     gets the traditional double rule that marks a sum in a ledger. */
  tfoot tr, tr.totals { border-top: 3px double ${FINANCIAL_ACCENT}; font-weight: 700; }

  pre, code { font-family: Consolas, 'Cascadia Mono', monospace; font-size: 9pt; }
  pre {
    background: #f4f7f5;
    border: 1px solid #cddbd3;
    padding: 3mm;
    line-height: 1.35;
  }
  code { background: #eaf1ec; padding: 0.3mm 1mm; }
  pre code { background: none; padding: 0; }

  .cover {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 230mm;
    border-top: 3px double ${FINANCIAL_ACCENT};
    padding-top: 8mm;
  }
  .cover-title { font-size: 22pt; font-weight: 700; color: ${FINANCIAL_ACCENT}; margin-bottom: 6mm; }
  .cover-meta { font-size: 10.5pt; }
  .cover-meta dt { font-weight: 700; float: left; clear: left; width: 34mm; }
  .cover-meta dd { margin: 0 0 1.5mm 36mm; }
  .roster-table { margin-top: 8mm; }

  .synthesis { margin-top: 4mm; }

  .appendix-header {
    font-size: 13pt;
    font-weight: 700;
    color: ${FINANCIAL_ACCENT};
    border-bottom: 1px solid ${FINANCIAL_ACCENT};
    padding-bottom: 2mm;
    margin-bottom: 5mm;
  }
`;

/**
 * RESEARCH — "Investigation, literature review, market and product research.
 * Readable long-form prose, pull quotes, clear source lists."
 * (REPORT_THEME_BRIEFS)
 *
 * Reading of the brief:
 *  - "readable long-form prose" -> the most generous leading of the four
 *    (1.6, versus engineering's 1.35), a humanist serif, and the widest
 *    body margins after legal — set for sustained reading, not scanning.
 *  - "pull quotes" -> `blockquote` is enlarged, italic, colour-accented and
 *    left-bordered, deliberately more decorative than the quiet blockquote
 *    treatment (or absence of one) in the other three themes, which is the
 *    one structural element unique to this theme.
 *  - "clear source lists" -> ordered/unordered lists get a hanging indent
 *    and loosened spacing, read as a bibliography/reference list rather
 *    than a dense body list.
 *  - Tables are deliberately the lightest-touch of the four (no border at
 *    all, just a single rule under the header and generous cell padding),
 *    because research is prose-led rather than table-led — the opposite
 *    choice from engineering's dense grid, for the opposite reason.
 */
const RESEARCH_ACCENT = '#8a5a2b';

const RESEARCH_CSS = `
  @page { size: A4; margin: 25mm 24mm 25mm 24mm; }

  body {
    font-family: 'Palatino Linotype', 'Book Antiqua', Georgia, serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #241d14;
    background: #ffffff;
  }

  h1, h2, h3 {
    font-family: 'Palatino Linotype', 'Book Antiqua', Georgia, serif;
    font-weight: 400;
    color: #241d14;
    margin-top: 9mm;
    margin-bottom: 3mm;
  }
  h1 { font-size: 24pt; font-style: italic; }
  h2 { font-size: 15pt; }
  h3 { font-size: 12pt; font-style: italic; }

  caption, .caption, figcaption {
    font-size: 9.5pt;
    font-style: italic;
    color: #6b5a45;
  }

  /* Deliberately the lightest table treatment of the four: no border, a
     single rule under the header, generous padding — prose-led, not
     data-led (see the theme comment above). */
  table { font-size: 10.5pt; }
  th, td { padding: 2.5mm 3mm; text-align: left; border: none; }
  thead th {
    border-bottom: 1px solid ${RESEARCH_ACCENT};
    font-weight: 700;
    font-style: italic;
    text-transform: uppercase;
    font-size: 9pt;
    letter-spacing: 0.3pt;
  }

  /* The pull quote: the one element unique to this theme. */
  blockquote {
    font-size: 13pt;
    font-style: italic;
    color: #3a2a15;
    border-left: 3px solid ${RESEARCH_ACCENT};
    padding-left: 6mm;
    margin: 6mm 4mm;
  }

  /* "Clear source lists": a bibliography-style hanging indent, not a dense
     in-prose list. */
  ol, ul { padding-left: 8mm; margin: 3mm 0; }
  li { margin-bottom: 1.5mm; }

  pre, code { font-family: Consolas, 'Courier New', monospace; font-size: 9.5pt; }
  pre {
    background: #f7f3ee;
    border: 1px solid #e2d6c4;
    padding: 3mm 4mm;
    line-height: 1.4;
  }
  code { background: #f0e9df; padding: 0.3mm 1mm; }
  pre code { background: none; padding: 0; }

  .cover {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 230mm;
  }
  .cover-title {
    font-size: 24pt;
    font-style: italic;
    font-weight: 400;
    color: #3a2a15;
    margin-bottom: 10mm;
  }
  .cover-meta { font-size: 10.5pt; color: #4a3d2c; line-height: 1.9; }
  .cover-meta dt { display: inline; font-weight: 700; color: ${RESEARCH_ACCENT}; }
  .cover-meta dt::after { content: ' \\2014 '; }
  .cover-meta dd { display: block; margin: 0 0 2mm 0; }
  .roster-table { margin-top: 10mm; }

  .synthesis { margin-top: 4mm; }

  .appendix-header {
    font-size: 15pt;
    font-style: italic;
    color: #3a2a15;
    border-bottom: 1px solid ${RESEARCH_ACCENT};
    padding-bottom: 2mm;
    margin-bottom: 6mm;
  }
`;

/**
 * The closed set of complete stylesheets, one per `ReportThemeId`. Built as
 * `PRINT_MECHANICS` (shared) followed by the theme's own rules (later rules
 * win on any overlap, which only matters for `.cover`'s `break-after: page`
 * — every theme keeps that declaration unchanged, so the cascade order here
 * is a formality, not a hazard).
 */
export const REPORT_THEMES: Readonly<Record<ReportThemeId, ReportTheme>> = {
  engineering: {
    id: 'engineering',
    displayName: 'Engineering',
    accentColour: ENGINEERING_ACCENT,
    bodyFontStack: "'Segoe UI', Calibri, Roboto, Arial, sans-serif",
    css: PRINT_MECHANICS + ENGINEERING_CSS,
  },
  legal: {
    id: 'legal',
    displayName: 'Legal',
    accentColour: LEGAL_ACCENT,
    bodyFontStack: "Cambria, Georgia, 'Times New Roman', serif",
    css: PRINT_MECHANICS + LEGAL_CSS,
  },
  financial: {
    id: 'financial',
    displayName: 'Financial',
    accentColour: FINANCIAL_ACCENT,
    bodyFontStack: "Calibri, Arial, 'Segoe UI', sans-serif",
    css: PRINT_MECHANICS + FINANCIAL_CSS,
  },
  research: {
    id: 'research',
    displayName: 'Research',
    accentColour: RESEARCH_ACCENT,
    bodyFontStack: "'Palatino Linotype', 'Book Antiqua', Georgia, serif",
    css: PRINT_MECHANICS + RESEARCH_CSS,
  },
};

/** Every id in `REPORT_THEME_IDS` has a `ReportTheme`; this is the check. */
function assertNoGaps(): void {
  for (const id of REPORT_THEME_IDS) {
    if (REPORT_THEMES[id] === undefined) {
      throw new Error(`themes.ts: missing a ReportTheme for "${id}"`);
    }
  }
}
assertNoGaps();

/** The full metadata (name, accent colour, font stack, stylesheet) for one theme. */
export function getReportTheme(themeId: ReportThemeId): ReportTheme {
  return REPORT_THEMES[themeId];
}

/**
 * Convenience for the common case: the document builder usually wants only
 * the CSS text to drop into a `<style>` element, not the whole metadata
 * object.
 */
export function getReportThemeCss(themeId: ReportThemeId): string {
  return REPORT_THEMES[themeId].css;
}
