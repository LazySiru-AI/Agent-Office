import { formatCostUsd, type ReportDocument, type RosterEntry } from '@agent-office/shared';

/**
 * Markdown export (FR-P6): the whole deliverable as one self-contained `.md`
 * file, offered as an alternative to the themed PDF built by `document.ts` /
 * `pdf.ts`.
 *
 * This module deliberately does **not** reuse `document.ts` or
 * `reports/markdown.ts`. Those two exist to turn agent-authored markdown into
 * *HTML* that headless Chromium then prints — every design choice in them
 * (escaping raw HTML into a `<span>`, turning links into inert text-plus-URL,
 * replacing images with a placeholder, running everything through `marked`'s
 * lexer at all) is there because the output is live markup navigated to by a
 * real browser process (see `pdf.ts`'s AO-7 discussion). A `.md` file has no
 * such consumer built into this pipeline: nothing here parses or renders it,
 * so there is no lexer to defend, no `<a href>` to neutralise, no image to
 * fetch. The one property this module must still guarantee is structural —
 * the file must remain a single, complete, unbroken markdown document no
 * matter what an agent's report contains. See "Escaping" below for what that
 * means in practice and what it deliberately does not mean.
 *
 * ## Escaping: fences are closed, nothing else is transformed
 *
 * `synthesisMarkdown` and every appendix's `markdown` are model output and
 * therefore untrusted in the sense that they may be malformed, not in the
 * sense that embedding them can execute anything — there is no interpreter
 * downstream of this file within Agent Office itself (contrast the HTML/PDF
 * path, where headless Chromium *is* such an interpreter). The one way
 * malformed markdown breaks the *document* rather than just looking odd
 * locally is an odd number of ``` fence markers: an unclosed fence started in
 * one agent's report would swallow every heading and every subsequent
 * appendix into a single literal code block when the bundle is opened in any
 * markdown viewer, silently hiding the rest of the file. {@link closeFences}
 * guards exactly that, per section, independently — so one agent's malformed
 * report cannot corrupt how the sections after it render, only how its own
 * section renders.
 *
 * This is intentionally not the same job as `truncateReport`
 * (`orchestrator/manager.ts`): that function bounds *length* and only checks
 * fence parity on the slice it just cut, because closing a fence is only
 * needed there when truncation itself opened the wound. This export never
 * truncates anything — the whole point of a bundle export is the *complete*
 * report, unlike the length-capped copies inlined into upstream prompts — so
 * there is nothing to reuse from `truncateReport` beyond the same technique
 * (count the markers, close if odd), reimplemented here as
 * {@link closeFences} rather than misusing a length-bounding function on
 * unbounded input to borrow four lines of it.
 *
 * Nothing else about a section's markdown is rewritten: heading levels are
 * left as the agent wrote them (unlike `reports/markdown.ts`'s HTML path,
 * there is no outer `<h1>`/`<h2>` structure a plain-text heading could
 * collide with — multiple top-level `#` headings in one `.md` file is normal
 * and does not break anything), and raw HTML an agent happened to type is
 * left as literal text, because that is what "readable as plain text" means:
 * a viewer that does not render markdown at all still shows exactly what the
 * agent wrote, unmangled.
 *
 * ## Design rationale: included
 *
 * `ReportDocument.rationale` (the designer's stated reason for the chosen
 * theme, set at `deliverable.ts:175`) is never rendered by `document.ts`, so
 * today it reaches no PDF and no HTML — a genuine gap, not a deliberate
 * omission; nothing in `document.ts`'s own comments argues against showing
 * it. The alternative considered was to leave it out of the markdown bundle
 * too, on the theory that a second export should mirror the first exactly.
 * That was rejected: this bundle is a *new* surface being built with full
 * knowledge of the gap, so silently reproducing it here would be choosing to
 * keep information away from the reader for no reason connected to this
 * export's own design, only inertia. The rationale is shown in a "Design
 * rationale" section on the cover, and omitted entirely (not rendered as an
 * empty heading) when `doc.rationale` is unset, matching how every other
 * optional cover fact in `document.ts` degrades.
 */

/** `2026-08-10` — matches `document.ts`'s cover date format for consistency across exports. */
function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function formatTokens(inputTokens: number, outputTokens: number): string {
  return `${inputTokens.toLocaleString('en-GB')} in / ${outputTokens.toLocaleString('en-GB')} out`;
}

/**
 * Reclose an odd number of ``` fence markers in `md`. See the module comment
 * ("Escaping") for why this exists and why it is not `truncateReport`.
 */
function closeFences(md: string): string {
  const fenceCount = (md.match(/```/g) ?? []).length;
  return fenceCount % 2 === 1 ? `${md}\n\`\`\`` : md;
}

/**
 * Escape a value bound for one cell of a markdown table: a literal `|` would
 * otherwise be read as a new column boundary, and a literal newline would
 * break the row onto multiple lines — both plausible in an agent's freeform
 * `role`/`status` text (`RosterEntry` is built from assignment objectives and
 * statuses an agent or the Manager wrote, not from a closed vocabulary).
 */
function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function renderRosterTable(roster: readonly RosterEntry[]): string {
  if (roster.length === 0) return '_No agents were dispatched._';

  const rows = roster.map(
    (entry) =>
      `| ${escapeTableCell(entry.agentName)} | ${escapeTableCell(entry.category)} | ` +
      `${escapeTableCell(entry.role)} | ${escapeTableCell(entry.status)} |`,
  );

  return ['| Agent | Category | Role | Outcome |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

/**
 * Build the complete markdown bundle: cover facts, team roster, design
 * rationale (when present), the Manager's synthesis, then every appendix in
 * dispatch order — one self-contained `.md` file, the alternative FR-P6 asks
 * for to the themed PDF `produceDeliverable` already writes.
 *
 * Pure function of {@link ReportDocument}, exactly like `buildReportHtml` —
 * no store, no filesystem, no browser — so it is testable and callable
 * without a run in flight. Writing the result to disk and exposing it over
 * HTTP is the manager's job, not this module's (see the task's scope fence).
 */
export function buildMarkdownBundle(doc: ReportDocument): string {
  const cost = formatCostUsd(doc.costUsd);

  const sections: string[] = [
    `# ${doc.task}`,
    '',
    `**Run ID:** ${doc.runId}`,
    `**Generated:** ${formatDate(doc.generatedAt)}`,
    `**Domain:** ${doc.domain}`,
    `**Tokens:** ${formatTokens(doc.totalTokens.inputTokens, doc.totalTokens.outputTokens)}`,
    `**Estimated cost:** ${cost}`,
    '',
    '## Team',
    '',
    renderRosterTable(doc.roster),
  ];

  if (doc.rationale !== undefined && doc.rationale.trim() !== '') {
    sections.push('', '## Design rationale', '', doc.rationale.trim());
  }

  sections.push('', '---', '', '## Synthesis', '', closeFences(doc.synthesisMarkdown));

  doc.appendices.forEach((appendix, index) => {
    sections.push(
      '',
      '---',
      '',
      `## Appendix ${String(index + 1)} — ${appendix.agentName}`,
      '',
      `_Source: ${appendix.path}_`,
      '',
      closeFences(appendix.markdown),
    );
  });

  return sections.join('\n');
}
