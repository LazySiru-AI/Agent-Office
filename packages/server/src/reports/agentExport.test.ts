import { describe, expect, it } from 'vitest';
import type { ReportDocument } from '@agent-office/shared';
import { AppendixNotFoundError, buildAgentMarkdown, buildAgentReportHtml, findAppendix } from './agentExport.js';

/**
 * Coverage for FR-P6's per-agent export: markdown and HTML forms of a single
 * agent's appendix, standalone away from the bundle. See `agentExport.ts`'s
 * module comment for the name-vs-index selection contract and why an unknown
 * agent throws rather than returning `undefined`.
 */

function makeDocument(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    runId: 'run-1',
    task: 'Review the vendor contract',
    generatedAt: Date.UTC(2026, 7, 10, 12, 0, 0),
    domain: 'legal',
    theme: 'legal',
    roster: [
      { agentName: 'writer', category: 'legal', role: 'Draft the review', status: 'done' },
      { agentName: 'reviewer', category: 'legal', role: 'Check the draft', status: 'done' },
    ],
    synthesisMarkdown: 'Synthesis body.',
    appendices: [
      { agentName: 'writer', path: 'reports/01-writer.md', markdown: 'Writer report body: **secret A**.' },
      { agentName: 'reviewer', path: 'reports/02-reviewer.md', markdown: 'Reviewer report body: **secret B**.' },
    ],
    totalTokens: { inputTokens: 1000, outputTokens: 500 },
    ...overrides,
  };
}

describe('findAppendix', () => {
  it('resolves by exact agent name', () => {
    const doc = makeDocument();
    const { appendix, index } = findAppendix(doc, 'reviewer');
    expect(appendix.agentName).toBe('reviewer');
    expect(index).toBe(1);
  });

  it('resolves by zero-based index', () => {
    const doc = makeDocument();
    const { appendix, index } = findAppendix(doc, 0);
    expect(appendix.agentName).toBe('writer');
    expect(index).toBe(0);
  });

  it('throws AppendixNotFoundError for an unknown agent name', () => {
    const doc = makeDocument();
    expect(() => findAppendix(doc, 'nonexistent-agent')).toThrow(AppendixNotFoundError);
  });

  it('throws AppendixNotFoundError for an out-of-range index', () => {
    const doc = makeDocument();
    expect(() => findAppendix(doc, 99)).toThrow(AppendixNotFoundError);
  });

  it('throws AppendixNotFoundError (not a generic Error) so callers can distinguish this failure', () => {
    const doc = makeDocument();
    try {
      findAppendix(doc, 'ghost');
      expect.fail('expected findAppendix to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppendixNotFoundError);
      expect((error as Error).name).toBe('AppendixNotFoundError');
      expect((error as Error).message).toContain('ghost');
      expect((error as Error).message).toContain('run-1');
    }
  });

  it('names the known agents in the error message when there is no match', () => {
    const doc = makeDocument();
    try {
      findAppendix(doc, 'ghost');
      expect.fail('expected findAppendix to throw');
    } catch (error) {
      expect((error as Error).message).toContain('writer');
      expect((error as Error).message).toContain('reviewer');
    }
  });
});

describe('buildAgentMarkdown', () => {
  it("contains the named agent's content and not the other agent's", () => {
    const doc = makeDocument();
    const md = buildAgentMarkdown(doc, 'writer');
    expect(md).toContain('secret A');
    expect(md).not.toContain('secret B');
  });

  it('carries run, task, agent and objective header context', () => {
    const doc = makeDocument();
    const md = buildAgentMarkdown(doc, 'reviewer');
    expect(md).toContain('reviewer');
    expect(md).toContain('Review the vendor contract');
    expect(md).toContain('**Run ID:** run-1');
    expect(md).toContain('**Domain:** legal');
    expect(md).toContain('**Objective:** Check the draft');
    expect(md).toContain('**Outcome:** done');
    expect(md).toContain('**Source:** reports/02-reviewer.md');
  });

  it('omits objective/outcome lines gracefully when the roster has no matching entry', () => {
    const doc = makeDocument({
      roster: [],
      appendices: [{ agentName: 'orphan', path: 'p.md', markdown: 'Orphan body.' }],
    });
    const md = buildAgentMarkdown(doc, 'orphan');
    expect(md).toContain('Orphan body.');
    expect(md).not.toContain('**Objective:**');
    expect(md).not.toContain('**Outcome:**');
  });

  it('closes an unclosed fence in the agent report', () => {
    const doc = makeDocument({
      appendices: [{ agentName: 'solo', path: 'p.md', markdown: '```js\nunclosed fence' }],
    });
    const md = buildAgentMarkdown(doc, 'solo');
    const fenceCount = (md.match(/```/g) ?? []).length;
    expect(fenceCount % 2).toBe(0);
  });

  it('throws AppendixNotFoundError for an unresolvable ref, same as findAppendix', () => {
    const doc = makeDocument();
    expect(() => buildAgentMarkdown(doc, 'nope')).toThrow(AppendixNotFoundError);
  });

  it('resolves by index identically to resolving by the same-positioned name', () => {
    const doc = makeDocument();
    expect(buildAgentMarkdown(doc, 0)).toBe(buildAgentMarkdown(doc, 'writer'));
  });
});

describe('buildAgentReportHtml', () => {
  it("contains the named agent's rendered content and not the other agent's", () => {
    const doc = makeDocument();
    const html = buildAgentReportHtml(doc, 'writer');
    expect(html).toContain('secret A');
    expect(html).not.toContain('secret B');
  });

  it('is a self-contained document: doctype, inlined style, no external references', () => {
    const doc = makeDocument();
    const html = buildAgentReportHtml(doc, 'writer');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link ');
    expect(html).not.toContain('http://');
  });

  it('renders the agent report markdown through the same escaping path as the combined document (bold, not raw markdown syntax)', () => {
    const doc = makeDocument();
    const html = buildAgentReportHtml(doc, 'writer');
    expect(html).toContain('<strong>secret A</strong>');
  });

  it('escapes an HTML-hostile agent name rather than injecting it as markup', () => {
    const doc = makeDocument({
      roster: [{ agentName: '<script>alert(1)</script>', category: 'legal', role: 'x', status: 'done' }],
      appendices: [{ agentName: '<script>alert(1)</script>', path: 'p.md', markdown: 'Body.' }],
    });
    const html = buildAgentReportHtml(doc, '<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('carries run/task/agent header context in the cover section', () => {
    const doc = makeDocument();
    const html = buildAgentReportHtml(doc, 'reviewer');
    expect(html).toContain('<dt>Run</dt><dd>run-1</dd>');
    expect(html).toContain('<dt>Domain</dt><dd>legal</dd>');
    expect(html).toContain('<dt>Objective</dt><dd>Check the draft</dd>');
    expect(html).toContain('<dt>Source</dt><dd>reports/02-reviewer.md</dd>');
    expect(html).toContain('Review the vendor contract');
  });

  it('throws AppendixNotFoundError for an unresolvable ref, same as findAppendix', () => {
    const doc = makeDocument();
    expect(() => buildAgentReportHtml(doc, 'nope')).toThrow(AppendixNotFoundError);
  });
});
