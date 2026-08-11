import { describe, expect, it } from 'vitest';
import type { ReportDocument } from '@agent-office/shared';
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
  it('shows a real cost, formatted to four decimal places', () => {
    const html = buildReportHtml(makeDocument({ costUsd: 1.05 }));
    expect(html).toContain('<dt>Estimated cost</dt><dd>$1.0500</dd>');
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

  it('escapes nothing extra into the cost cell — it is always a fixed, safe format', () => {
    const html = buildReportHtml(makeDocument({ costUsd: 123.456 }));
    expect(html).toContain('<dt>Estimated cost</dt><dd>$123.4560</dd>');
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
    const firstAppendixIndex = html.indexOf('Appendix 1 — writer');
    const secondAppendixIndex = html.indexOf('Appendix 2 — reviewer');
    expect(synthesisIndex).toBeGreaterThan(-1);
    expect(firstAppendixIndex).toBeGreaterThan(synthesisIndex);
    expect(secondAppendixIndex).toBeGreaterThan(firstAppendixIndex);
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
