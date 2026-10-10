import { describe, expect, it } from 'vitest';
import type { ReportDocument } from '@agent-office/shared';
import { buildMarkdownBundle } from './markdownExport.js';

/**
 * Coverage for FR-P6's markdown export: a single self-contained `.md` file
 * carrying cover facts, the synthesis, and every appendix — see
 * `markdownExport.ts`'s module comment for why this is a distinct code path
 * from `document.ts`'s HTML/PDF rendering rather than a thin wrapper over it.
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

describe('buildMarkdownBundle — structure and cover facts', () => {
  it('opens with the task as an H1 and states run id, date, domain, tokens and cost', () => {
    const md = buildMarkdownBundle(makeDocument({ costUsd: 1.05 }));
    expect(md.startsWith('# Review the vendor contract')).toBe(true);
    expect(md).toContain('**Run ID:** run-1');
    expect(md).toContain('**Generated:** 2026-08-10');
    expect(md).toContain('**Domain:** legal');
    expect(md).toContain('**Tokens:** 1,000 in / 500 out');
    expect(md).toContain('**Estimated cost:** $1.05');
  });

  it('shows a genuine zero cost as $0.00, not an em dash', () => {
    const md = buildMarkdownBundle(makeDocument({ costUsd: 0 }));
    expect(md).toContain('**Estimated cost:** $0.00');
  });

  it('shows an em dash for a genuinely unknown cost', () => {
    const md = buildMarkdownBundle(makeDocument());
    expect(md).toContain('**Estimated cost:** —');
  });

  it('renders the team roster as a markdown table, escaping a literal pipe in a cell', () => {
    const md = buildMarkdownBundle(
      makeDocument({
        roster: [{ agentName: 'writer', category: 'legal', role: 'Draft | review', status: 'done' }],
      }),
    );
    expect(md).toContain('| Agent | Category | Role | Outcome |');
    expect(md).toContain('| writer | legal | Draft \\| review | done |');
  });

  it('renders "No agents were dispatched" prose for an empty roster rather than an empty table', () => {
    const md = buildMarkdownBundle(makeDocument({ roster: [] }));
    expect(md).toContain('_No agents were dispatched._');
    expect(md).not.toContain('| Agent | Category | Role | Outcome |');
  });
});

describe('buildMarkdownBundle — design rationale (judgement call)', () => {
  it('includes the rationale when the document carries one — the gap document.ts leaves unrendered', () => {
    const md = buildMarkdownBundle(makeDocument({ rationale: 'Chose legal for the formal register.' }));
    expect(md).toContain('## Design rationale');
    expect(md).toContain('Chose legal for the formal register.');
  });

  it('omits the rationale section entirely when the document has none', () => {
    const md = buildMarkdownBundle(makeDocument());
    expect(md).not.toContain('## Design rationale');
  });
});

describe('buildMarkdownBundle — synthesis and appendices', () => {
  it('contains the synthesis and every appendix, in dispatch order, each under its own heading', () => {
    const md = buildMarkdownBundle(
      makeDocument({
        synthesisMarkdown: '## Executive summary\n\nEverything looks fine.',
        appendices: [
          { agentName: 'writer', path: 'reports/01-writer.md', markdown: '# Notes\n\nWriter content.' },
          { agentName: 'reviewer', path: 'reports/02-reviewer.md', markdown: '# More\n\nReviewer content.' },
        ],
      }),
    );

    expect(md).toContain('## Synthesis');
    expect(md).toContain('Everything looks fine.');
    expect(md).toContain('## Appendix 1 — writer');
    expect(md).toContain('Writer content.');
    expect(md).toContain('## Appendix 2 — reviewer');
    expect(md).toContain('Reviewer content.');

    // Order: synthesis before appendix 1 before appendix 2.
    const synthesisIndex = md.indexOf('## Synthesis');
    const appendix1Index = md.indexOf('## Appendix 1 — writer');
    const appendix2Index = md.indexOf('## Appendix 2 — reviewer');
    expect(synthesisIndex).toBeLessThan(appendix1Index);
    expect(appendix1Index).toBeLessThan(appendix2Index);
  });

  it('includes the appendix source path', () => {
    const md = buildMarkdownBundle(
      makeDocument({
        appendices: [{ agentName: 'writer', path: 'reports/01-writer.md', markdown: 'Body.' }],
      }),
    );
    expect(md).toContain('_Source: reports/01-writer.md_');
  });

  it('does not run appendix or synthesis markdown through any HTML renderer', () => {
    const md = buildMarkdownBundle(
      makeDocument({
        synthesisMarkdown: '**bold synthesis**',
        appendices: [{ agentName: 'writer', path: 'p.md', markdown: '**bold appendix**' }],
      }),
    );
    // Left as literal markdown syntax, not converted to <strong>.
    expect(md).toContain('**bold synthesis**');
    expect(md).toContain('**bold appendix**');
    expect(md).not.toContain('<strong>');
    expect(md).not.toContain('<h1>');
    expect(md).not.toContain('<p>');
  });
});

describe('buildMarkdownBundle — fence safety (escaping judgement call)', () => {
  it('closes an unclosed code fence in the synthesis, so it cannot swallow the appendices after it', () => {
    const md = buildMarkdownBundle(
      makeDocument({
        synthesisMarkdown: 'Before.\n```js\nconst x = 1;\n// no closing fence',
        appendices: [{ agentName: 'writer', path: 'p.md', markdown: 'Appendix body, unharmed.' }],
      }),
    );

    // An even number of ``` markers overall means the dangling fence was closed.
    const fenceCount = (md.match(/```/g) ?? []).length;
    expect(fenceCount % 2).toBe(0);

    // The appendix heading and body must still appear as real markdown structure,
    // i.e. outside of whatever code block the synthesis started.
    expect(md).toContain('## Appendix 1 — writer');
    expect(md).toContain('Appendix body, unharmed.');
  });

  it('closes an unclosed fence in one appendix without touching a later, well-formed appendix', () => {
    const md = buildMarkdownBundle(
      makeDocument({
        appendices: [
          { agentName: 'first', path: 'p1.md', markdown: '```\nunclosed' },
          { agentName: 'second', path: 'p2.md', markdown: 'Well-formed, no fences.' },
        ],
      }),
    );
    expect(md).toContain('## Appendix 2 — second');
    expect(md).toContain('Well-formed, no fences.');
  });

  it('leaves a well-formed, already-balanced fence untouched', () => {
    const md = buildMarkdownBundle(
      makeDocument({
        synthesisMarkdown: '```js\nconst x = 1;\n```',
      }),
    );
    expect(md).toContain('```js\nconst x = 1;\n```');
    // No extra fence appended beyond the two that were already there.
    const fenceCount = (md.match(/```/g) ?? []).length;
    expect(fenceCount).toBe(2);
  });
});
