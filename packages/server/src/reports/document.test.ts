import { describe, expect, it } from 'vitest';
import { formatCostUsd, type ReportDocument } from '@agent-office/shared';
import { buildReportHtml, coerceThemeId, escapeHtml } from './document.js';

/**
 * Regression coverage for the confirmed defect: `ReportDocument.costUsd` was
 * always `undefined` in production because its one populator (`runner.ts`,
 * via `deliverable.ts`'s `DeliverableDeps.costUsd`) never set it, so every
 * PDF cover page showed "—" regardless of what the run actually spent. The
 * fix lives in `deliverable.ts` (`estimateRunCostUsd`, a fallback used when
 * no caller-supplied figure exists); this file pins what `document.ts`
 * itself does with whatever number it is handed — the three cases a cover
 * page can be in: a real cost, a genuine zero, and a genuine unknown.
 *
 * A second, later defect lived in the same handful of lines: the cover
 * formatted `costUsd` with its own unconditional `toFixed(4)`, while
 * `formatCostUsd` (shared/src/wire.ts) — what the live UI calls for the same
 * number — switches to two decimals above one cent. A run costing $123.456
 * therefore read as `$123.4560` on its own cover page and `$123.46` on
 * screen: the same run disagreeing with itself. `document.ts` now calls
 * `formatCostUsd` directly instead of re-implementing its rule, so the tests
 * below pin the cover's cost cell against that shared function's actual
 * output rather than a hand-picked expectation that could drift from it
 * again the same way.
 */

function makeDocument(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    runId: 'run-1',
    task: 'Review the vendor contract',
    generatedAt: Date.UTC(2026, 7, 10, 12, 0, 0),
    domain: 'legal',
    theme: 'legal',
    roster: [],
    synthesisMarkdown: 'Synthesis body.',
    appendices: [],
    totalTokens: { inputTokens: 1000, outputTokens: 500 },
    ...overrides,
  };
}

describe('buildReportHtml — cover cost display', () => {
  it('formats a real cost exactly as formatCostUsd does — the same figure the live UI shows', () => {
    // Pinned against the shared function's actual output, not a hand-picked
    // string: that is the guard against the cover and the UI drifting apart
    // again the way `toFixed(4)` vs `formatCostUsd` once did.
    const html = buildReportHtml(makeDocument({ costUsd: 1.05 }));
    expect(html).toContain(`<dt>Estimated cost</dt><dd>${formatCostUsd(1.05)}</dd>`);
    expect(html).toContain('<dt>Estimated cost</dt><dd>$1.05</dd>');
  });

  it('shows $0.00 for a genuinely free run, not "—"', () => {
    // Zero is a real, known answer (e.g. a scripted run) and must read as
    // confidently free, not as "we don't know". Conflating the two is
    // exactly the failure mode NFR-5 exists to prevent.
    const html = buildReportHtml(makeDocument({ costUsd: 0 }));
    expect(html).toContain('<dt>Estimated cost</dt><dd>$0.00</dd>');
    expect(html).not.toContain('<dt>Estimated cost</dt><dd>—</dd>');
  });

  it('shows an em dash for a genuinely unknown cost, not $0.00', () => {
    // `costUsd` omitted entirely: no assignment or Manager usage could be
    // priced. This must not be indistinguishable from "the run was free".
    const html = buildReportHtml(makeDocument());
    expect(html).toContain('<dt>Estimated cost</dt><dd>—</dd>');
  });

  it('matches the live UI on a real run: two decimals above a cent, not four', () => {
    // The exact defect: a run costing $123.456 used to read `$123.4560` on
    // its own cover page and `$123.46` (formatCostUsd's two-decimal rule
    // above one cent) on screen — the same run disagreeing with itself.
    const html = buildReportHtml(makeDocument({ costUsd: 123.456 }));
    expect(html).toContain('<dt>Estimated cost</dt><dd>$123.46</dd>');
    expect(html).not.toContain('$123.4560');
  });

  it('still shows four decimal places for a sub-cent cost, matching formatCostUsd', () => {
    // formatCostUsd's own below-a-cent rule (shared/src/wire.ts) must survive
    // the switch to calling it — this is not a blanket "always two decimals"
    // regression in the other direction.
    const html = buildReportHtml(makeDocument({ costUsd: 0.0042 }));
    expect(html).toContain(`<dt>Estimated cost</dt><dd>${formatCostUsd(0.0042)}</dd>`);
    expect(html).toContain('<dt>Estimated cost</dt><dd>$0.0042</dd>');
  });
});

describe('buildReportHtml — structure', () => {
  it('is a single self-contained document: doctype, inlined style, no external references', () => {
    const html = buildReportHtml(makeDocument());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link ');
    expect(html).not.toContain('http://');
  });

  it('renders the token counts on the cover, British-locale grouped', () => {
    const html = buildReportHtml(
      makeDocument({ totalTokens: { inputTokens: 1_234_567, outputTokens: 89 } }),
    );
    expect(html).toContain('1,234,567 in / 89 out');
  });

  it('renders "No agents were dispatched" for an empty roster rather than an empty table', () => {
    const html = buildReportHtml(makeDocument({ roster: [] }));
    expect(html).toContain('No agents were dispatched.');
    expect(html).not.toContain('<table class="roster-table">');
  });

  it('renders one roster row per entry, escaping agent-controlled fields', () => {
    const html = buildReportHtml(
      makeDocument({
        roster: [
          {
            agentName: '<script>alert(1)</script>',
            category: 'legal',
            role: 'Review the contract',
            status: 'done',
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders the synthesis and each appendix, in order, under document-level headings', () => {
    const html = buildReportHtml(
      makeDocument({
        synthesisMarkdown: '## Summary\n\nBody text.',
        appendices: [
          { agentName: 'writer', path: 'reports/01-writer.md', markdown: '# Notes' },
          { agentName: 'reviewer', path: 'reports/02-reviewer.md', markdown: '# More notes' },
        ],
      }),
    );
    const synthesisIndex = html.indexOf('class="synthesis"');
    // Matched on the actual appendix `<h2>` tags, not the plain text
    // "Appendix 1 — writer" — this document now also has a table of
    // contents (enough sections here to clear TOC_MIN_ENTRIES) whose entry
    // for appendix 1 renders that exact text earlier in the document, inside
    // an `<a>` rather than the appendix's own header. A plain text search
    // would find the TOC's copy first and wrongly conclude the appendix
    // precedes the synthesis.
    const firstAppendixIndex = html.indexOf(
      '<h2 class="appendix-header" id="appendix-1">Appendix 1 — writer</h2>',
    );
    const secondAppendixIndex = html.indexOf(
      '<h2 class="appendix-header" id="appendix-2">Appendix 2 — reviewer</h2>',
    );
    expect(synthesisIndex).toBeGreaterThan(-1);
    expect(firstAppendixIndex).toBeGreaterThan(synthesisIndex);
    expect(secondAppendixIndex).toBeGreaterThan(firstAppendixIndex);
  });
});

describe('buildReportHtml — table of contents (Doc3/P3)', () => {
  // Regression coverage for the confirmed defect: `markdown.ts` exported a
  // fully-tested `extractHeadingOutline`, but no caller anywhere in the
  // report pipeline ever invoked it — every HTML report and every PDF built
  // from one has shipped with no table of contents at all, however many
  // appendices it contained. These tests pin the fix in `document.ts`: the
  // TOC's presence/absence threshold, its two-level structure, and — the
  // part that actually makes the links work — that two agents who write the
  // same heading text land on distinct, matching anchors instead of
  // colliding on one id.

  it('renders a table of contents for a multi-agent document, with one entry per section', () => {
    const html = buildReportHtml(
      makeDocument({
        synthesisMarkdown: '## Summary\n\nBody text.',
        appendices: [
          { agentName: 'writer', path: 'reports/01-writer.md', markdown: '# Notes\n\n## Detail' },
          { agentName: 'reviewer', path: 'reports/02-reviewer.md', markdown: '# More notes' },
        ],
      }),
    );

    expect(html).toContain('<section class="toc">');
    expect(html).toContain('Table of Contents');

    // One top-level entry per document-level anchor: Synthesis, then each
    // appendix, in document order, each linking to the anchor that section
    // actually carries.
    expect(html).toContain('<a href="#synthesis">Synthesis</a>');
    expect(html).toContain('<a href="#appendix-1">Appendix 1 — writer</a>');
    expect(html).toContain('<a href="#appendix-2">Appendix 2 — reviewer</a>');

    // The TOC appears after the cover and before the synthesis section.
    const coverIndex = html.indexOf('class="cover"');
    const tocIndex = html.indexOf('class="toc"');
    const synthesisIndex = html.indexOf('class="synthesis"');
    expect(coverIndex).toBeGreaterThan(-1);
    expect(tocIndex).toBeGreaterThan(coverIndex);
    expect(synthesisIndex).toBeGreaterThan(tocIndex);

    // A page break separates the TOC from the synthesis that follows it.
    // Searched from `tocIndex` onward: `themes.ts`'s own print-mechanics CSS
    // contains this exact string inside a comment, documenting the class for
    // callers — that earlier, unrelated occurrence must not be mistaken for
    // the actual page break this test is checking for.
    expect(html.indexOf('<div class="page-break">', tocIndex)).toBeGreaterThan(tocIndex);
  });

  it('renders nothing below the entry threshold: synthesis plus a single headingless appendix', () => {
    const html = buildReportHtml(
      makeDocument({
        synthesisMarkdown: 'Just prose, no headings.',
        appendices: [{ agentName: 'writer', path: 'reports/01-writer.md', markdown: 'Just prose too.' }],
      }),
    );

    // Two entries total (Synthesis + one appendix, neither with sub-headings)
    // is below TOC_MIN_ENTRIES: nothing to choose between, so no TOC page.
    expect(html).not.toContain('class="toc"');
    expect(html).not.toContain('Table of Contents');
  });

  it('renders a table of contents once a second, headingless appendix crosses the entry threshold', () => {
    const html = buildReportHtml(
      makeDocument({
        synthesisMarkdown: 'Just prose, no headings.',
        appendices: [
          { agentName: 'writer', path: 'reports/01-writer.md', markdown: 'Just prose too.' },
          { agentName: 'reviewer', path: 'reports/02-reviewer.md', markdown: 'More prose.' },
        ],
      }),
    );

    // Three entries (Synthesis + two appendices) clears TOC_MIN_ENTRIES.
    expect(html).toContain('class="toc"');
    expect(html).toContain('<a href="#appendix-1">Appendix 1 — writer</a>');
    expect(html).toContain('<a href="#appendix-2">Appendix 2 — reviewer</a>');
  });

  it('gives two agents who both write "## Findings" distinct anchors that resolve to their own heading', () => {
    const html = buildReportHtml(
      makeDocument({
        synthesisMarkdown: '## Summary\n\nBody text.',
        appendices: [
          { agentName: 'writer', path: 'reports/01-writer.md', markdown: '# Report\n\n## Findings\n\nWriter findings.' },
          { agentName: 'reviewer', path: 'reports/02-reviewer.md', markdown: '# Report\n\n## Findings\n\nReviewer findings.' },
        ],
      }),
    );

    // Distinct ids: the naive per-fragment slug ("findings") would collide
    // across the two appendices without the per-section idPrefix.
    expect(html).toContain('id="appendix-1-findings"');
    expect(html).toContain('id="appendix-2-findings"');
    expect(html).not.toContain('id="findings"');

    // The TOC's sub-entries link to exactly those ids, not to each other's.
    expect(html).toContain('<a href="#appendix-1-findings">Findings</a>');
    expect(html).toContain('<a href="#appendix-2-findings">Findings</a>');

    // Each id actually appears on the right agent's own heading: the first
    // "Findings" heading after appendix 1's anchor is appendix-1-findings,
    // not appendix-2-findings, and vice versa.
    const appendix1HeaderIndex = html.indexOf('id="appendix-1"');
    const appendix1FindingsIndex = html.indexOf('id="appendix-1-findings"');
    const appendix2HeaderIndex = html.indexOf('id="appendix-2"');
    const appendix2FindingsIndex = html.indexOf('id="appendix-2-findings"');
    expect(appendix1FindingsIndex).toBeGreaterThan(appendix1HeaderIndex);
    expect(appendix1FindingsIndex).toBeLessThan(appendix2HeaderIndex);
    expect(appendix2FindingsIndex).toBeGreaterThan(appendix2HeaderIndex);
  });

  it('excludes headings deeper than the depth cut from the TOC, but still renders them in the body', () => {
    const html = buildReportHtml(
      makeDocument({
        synthesisMarkdown: '## Summary\n\nBody text.',
        appendices: [
          {
            agentName: 'writer',
            path: 'reports/01-writer.md',
            markdown: '# Report\n\n## Findings\n\n### Deep detail\n\nSub-point.',
          },
          { agentName: 'reviewer', path: 'reports/02-reviewer.md', markdown: '# Report' },
        ],
      }),
    );

    // "Deep detail" (a report's `###`, shifted to h5) is noise the TOC
    // excludes; it still renders in the appendix body itself, with its own
    // anchor id, just not as a TOC entry.
    expect(html).toContain('<h5 id="appendix-1-deep-detail">Deep detail</h5>');
    expect(html).not.toContain('<a href="#appendix-1-deep-detail">');
  });
});

describe('coerceThemeId', () => {
  it('passes through a valid theme id', () => {
    expect(coerceThemeId('financial')).toBe('financial');
  });

  it('falls back to "research" for an unrecognised or missing theme id', () => {
    expect(coerceThemeId('corporate-modern')).toBe('research');
    expect(coerceThemeId(undefined)).toBe('research');
  });
});

describe('escapeHtml', () => {
  it('escapes the five reserved HTML characters', () => {
    expect(escapeHtml(`<a href="x">it's & "quoted"</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;quoted&quot;&lt;/a&gt;',
    );
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeHtml('plain text with no special characters')).toBe(
      'plain text with no special characters',
    );
  });
});
