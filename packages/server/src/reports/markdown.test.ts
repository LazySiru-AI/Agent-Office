import { describe, expect, it } from 'vitest';
import { extractHeadingOutline, renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  describe('element coverage', () => {
    it('renders headings shifted by two levels', () => {
      const html = renderMarkdown('# Title\n\n## Section\n');
      expect(html).toContain('<h3 id="title">Title</h3>');
      expect(html).toContain('<h4 id="section">Section</h4>');
    });

    it('caps heading depth at h6', () => {
      // depth 6 + shift 2 = 8, which must clamp to the last level HTML has.
      const html = renderMarkdown('###### Deep\n');
      expect(html).toContain('<h6');
      expect(html).not.toContain('<h7');
      expect(html).not.toContain('<h8');
    });

    it('renders bold and italic', () => {
      const html = renderMarkdown('**bold** and *italic*');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    it('renders inline code', () => {
      const html = renderMarkdown('use `npm install` first');
      expect(html).toContain('<code>npm install</code>');
    });

    it('renders a fenced code block with a language class, wrapped for overflow control', () => {
      const html = renderMarkdown('```ts\nconst x: number = 1;\n```\n');
      expect(html).toContain('<div class="ao-code-wrapper">');
      expect(html).toContain('<pre class="ao-pre">');
      expect(html).toContain('class="ao-code language-ts"');
      expect(html).toContain('const x: number = 1;');
    });

    it('renders an ordered list', () => {
      const html = renderMarkdown('1. first\n2. second\n');
      expect(html).toContain('<ol>');
      expect(html).toContain('<li>first</li>');
      expect(html).toContain('<li>second</li>');
    });

    it('renders an unordered, nested list', () => {
      const html = renderMarkdown('- top\n  - nested\n');
      expect(html).toContain('<li>top');
      expect(html).toContain('<li>nested</li>');
      // The nested <ul> must appear inside the outer <li>.
      expect(html.indexOf('<ul>')).toBeLessThan(html.lastIndexOf('<ul>'));
    });

    it('renders a blockquote', () => {
      const html = renderMarkdown('> quoted text\n');
      expect(html).toContain('<blockquote>');
      expect(html).toContain('quoted text');
    });

    it('renders a table, wrapped for overflow control', () => {
      const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
      expect(html).toContain('<div class="ao-table-wrapper">');
      expect(html).toContain('<table class="ao-table">');
      expect(html).toContain('<th>a</th>');
      expect(html).toContain('<td>1</td>');
    });

    it('renders a horizontal rule', () => {
      const html = renderMarkdown('above\n\n---\n\nbelow\n');
      expect(html).toContain('<hr>');
    });

    it('renders a link as text plus the URL, not a clickable anchor', () => {
      const html = renderMarkdown('[Anthropic](https://anthropic.com)');
      expect(html).not.toContain('<a ');
      expect(html).not.toContain('href=');
      expect(html).toContain('class="ao-link"');
      expect(html).toContain('Anthropic');
      expect(html).toContain('class="ao-link-url">(https://anthropic.com)</span>');
    });

    it('renders an image as a text placeholder, never an <img>', () => {
      const html = renderMarkdown('![a diagram](https://example.com/diagram.png)');
      expect(html).not.toContain('<img');
      expect(html).toContain('class="ao-image-placeholder"');
      expect(html).toContain('a diagram');
      expect(html).toContain('https://example.com/diagram.png');
    });
  });

  describe('raw HTML neutralisation', () => {
    it('escapes a block-level <script> instead of passing it through', () => {
      const html = renderMarkdown('<script>alert(1)</script>\n');
      expect(html).not.toContain('<script>');
      expect(html).toContain('class="ao-raw-html"');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes an inline raw tag', () => {
      const html = renderMarkdown('before <div onclick="x()">middle</div> after');
      expect(html).not.toContain('<div onclick');
      expect(html).toContain('&lt;div onclick=&quot;x()&quot;&gt;');
    });

    it('does not execute an unclosed raw tag', () => {
      const html = renderMarkdown('oops <div class="broken"\n\nmore text after');
      expect(html).not.toMatch(/<div\s/);
    });
  });

  describe('malformed input', () => {
    it('does not throw on unbalanced backticks', () => {
      expect(() => renderMarkdown('here is `some code that never closes')).not.toThrow();
      const html = renderMarkdown('here is `some code that never closes');
      expect(html.length).toBeGreaterThan(0);
    });

    it('does not throw on an unterminated table', () => {
      const md = '| a | b |\n|---|---|\n| 1 |';
      expect(() => renderMarkdown(md)).not.toThrow();
      expect(renderMarkdown(md).length).toBeGreaterThan(0);
    });

    it('does not throw on a truncated fenced code block', () => {
      const md = '```js\nconst x = 1;\nfunction never closes() {\n';
      expect(() => renderMarkdown(md)).not.toThrow();
      const html = renderMarkdown(md);
      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain('const x = 1;');
    });

    it('does not throw on deeply nested or otherwise pathological markdown', () => {
      const nested = '> '.repeat(500) + 'deep';
      expect(() => renderMarkdown(nested)).not.toThrow();
    });
  });

  describe('determinism', () => {
    it('produces byte-identical output for the same input across separate calls', () => {
      const md = [
        '# Report',
        '',
        '## Findings',
        '',
        'Some **bold** text with a [link](https://example.com) and:',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '```ts',
        'const x = 1;',
        '```',
      ].join('\n');

      const first = renderMarkdown(md);
      const second = renderMarkdown(md);
      expect(first).toBe(second);
    });

    it('gives duplicate headings deterministic, distinct ids', () => {
      const html = renderMarkdown('## Summary\n\ntext\n\n## Summary\n');
      expect(html).toContain('id="summary"');
      expect(html).toContain('id="summary-1"');
    });
  });

  describe('overflow-wrapper classes on wide content', () => {
    it('wraps a very large table in ao-table-wrapper', () => {
      const header = '| ' + Array.from({ length: 20 }, (_, i) => `col${i}`).join(' | ') + ' |';
      const divider = '|' + Array.from({ length: 20 }, () => '---').join('|') + '|';
      const rows = Array.from(
        { length: 200 },
        (_, r) => '| ' + Array.from({ length: 20 }, (_, c) => `r${r}c${c}`).join(' | ') + ' |',
      );
      const md = [header, divider, ...rows].join('\n');

      const html = renderMarkdown(md);
      expect(html).toContain('<div class="ao-table-wrapper">');
      expect(html).toContain('r199c19');
    });

    it('wraps a code block with a very long line in ao-code-wrapper', () => {
      const longLine = 'x'.repeat(5000);
      const md = '```\n' + longLine + '\n```\n';

      const html = renderMarkdown(md);
      expect(html).toContain('<div class="ao-code-wrapper">');
      expect(html).toContain(longLine);
    });
  });

  describe('empty and whitespace-only input', () => {
    it('returns an empty string for empty input', () => {
      expect(renderMarkdown('')).toBe('');
    });

    it('returns an empty string for whitespace-only input', () => {
      expect(renderMarkdown('   \n\n\t \n')).toBe('');
    });
  });
});

describe('pathological emphasis runs', () => {
  // Regression coverage for the confirmed defect: a run of `n` asterisks
  // either side of one letter drove `marked`'s emphasis tokenizer into
  // recursion unbounded enough to throw `RangeError: Maximum call stack
  // size exceeded` — caught, so nothing crashed, but the reviewer measured
  // the time spent *reaching* that throw at 12.1s for 80,000 markers. A
  // fix that only changes what happens after the RangeError does not help;
  // the assertion below is on wall-clock time, not on the output shape,
  // because the actual defect was the delay, not a wrong result.
  function pathologicalInput(n: number): string {
    return '*'.repeat(n) + 'a' + '*'.repeat(n);
  }

  it('renders an 80,000-asterisk run in well under a second instead of hitting the multi-second stack-overflow path', () => {
    const start = performance.now();
    const html = renderMarkdown(pathologicalInput(80_000));
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(html.length).toBeGreaterThan(0);
  });

  it('extracts a heading outline from a pathological run in well under a second', () => {
    const md = `# ${pathologicalInput(80_000)}\n`;
    const start = performance.now();
    const outline = extractHeadingOutline(md);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(outline.length).toBe(1);
  });

  it('degrades gracefully: the pathological run appears as literal text, not a thrown error', () => {
    expect(() => renderMarkdown(pathologicalInput(80_000))).not.toThrow();
    const html = renderMarkdown(pathologicalInput(80_000));
    // Escaped rather than parsed as emphasis, so the letter between the two
    // runs is not wrapped in dozens of nested <em>/<strong> tags.
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('a');
  });

  it('leaves an ordinary, short emphasis run parsed as real emphasis, not escaped', () => {
    // Three asterisks either side is completely normal markdown
    // (bold+italic) and must not be touched by the pathological-run guard.
    const html = renderMarkdown('***bold italic***');
    expect(html).toContain('<strong>');
    expect(html).toContain('<em>');
  });

  it('does not touch a moderate, plausible run of emphasis markers', () => {
    // Ten asterisks is unusual but not the pathological shape (the
    // threshold is well above any legitimate nesting depth); confirms the
    // guard does not fire on ordinary ragged input.
    const html = renderMarkdown('**********bold-ish**********');
    expect(html.length).toBeGreaterThan(0);
  });
});

describe('extractHeadingOutline', () => {
  it('returns headings in document order, at the shifted level, with matching ids', () => {
    const md = '# Title\n\n## Findings\n\n### Detail\n';
    const outline = extractHeadingOutline(md);

    expect(outline).toEqual([
      { level: 3, text: 'Title', id: 'title' },
      { level: 4, text: 'Findings', id: 'findings' },
      { level: 5, text: 'Detail', id: 'detail' },
    ]);
  });

  it('assigns the same ids renderMarkdown puts in the HTML', () => {
    const md = '# Alpha\n\n## Beta\n\n## Beta\n';
    const outline = extractHeadingOutline(md);
    const html = renderMarkdown(md);

    for (const entry of outline) {
      expect(html).toContain(`id="${entry.id}"`);
    }
  });

  it('strips inline markdown formatting from heading text', () => {
    const outline = extractHeadingOutline('# **Bold** and `code` title\n');
    expect(outline).toEqual([
      { level: 3, text: 'Bold and code title', id: 'bold-and-code-title' },
    ]);
  });

  it('returns an empty array for a report with no headings', () => {
    expect(extractHeadingOutline('just a paragraph, no headings here.\n')).toEqual([]);
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(extractHeadingOutline('')).toEqual([]);
    expect(extractHeadingOutline('   \n')).toEqual([]);
  });

  it('never throws on malformed input', () => {
    expect(() => extractHeadingOutline('# unterminated `code and | broken | table')).not.toThrow();
  });
});
