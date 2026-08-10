import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentParseError, parseAgentFile } from './parse.js';

const REPO_ROOT = path.resolve('/repo');
const CATEGORY_DIR = path.join(REPO_ROOT, 'categories', '08-business-product');
const AGENT_PATH = path.join(CATEGORY_DIR, 'legal-advisor.md');

/**
 * The real agent files in this repo use CRLF line endings, so every fixture
 * does too. That is deliberate: it is the case most likely to regress.
 */
function crlf(lines: string[]): string {
  return lines.join('\r\n');
}

describe('parseAgentFile', () => {
  it('parses a well-formed agent file into every AgentDef field', () => {
    const raw = crlf([
      '---',
      'name: legal-advisor',
      'description: "Use this agent when you need to draft contracts."',
      'tools: Read, Write, Edit, Glob, Grep, WebFetch, WebSearch',
      'model: sonnet',
      '---',
      '',
      'You are a senior legal advisor.',
      '',
      'When invoked:',
      '1. Query context manager.',
      '',
    ]);

    const agent = parseAgentFile(raw, AGENT_PATH, REPO_ROOT);

    expect(agent.name).toBe('legal-advisor');
    expect(agent.description).toBe('Use this agent when you need to draft contracts.');
    expect(agent.tools).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
    ]);
    expect(agent.model).toBe('sonnet');
    expect(agent.category).toBe('08-business-product');
    expect(agent.filePath).toBe('categories/08-business-product/legal-advisor.md');
    expect(agent.systemPrompt.startsWith('You are a senior legal advisor.')).toBe(true);
    expect(agent.systemPrompt.endsWith('1. Query context manager.')).toBe(true);
  });

  it('accepts a double-quoted description', () => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: quoted-agent',
        'description: "Coordinates work, resolves conflicts, and reports back."',
        'tools: Read',
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.description).toBe('Coordinates work, resolves conflicts, and reports back.');
  });

  it('accepts an unquoted description containing commas', () => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: unquoted-agent',
        'description: Expert Terragrunt specialist mastering orchestration, DRY configs, and IaC.',
        'tools: Read',
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.description).toBe(
      'Expert Terragrunt specialist mastering orchestration, DRY configs, and IaC.',
    );
  });

  it('accepts a quoted description containing a colon', () => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: colon-quoted',
        'description: "Use when reviewing privacy. Triggers on: \'GDPR\', \'CCPA\'."',
        'tools: Read',
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.description).toBe("Use when reviewing privacy. Triggers on: 'GDPR', 'CCPA'.");
  });

  it('accepts an UNQUOTED description containing a colon, which raw YAML rejects', () => {
    // This is the shape used by gdpr-ccpa-compliance.md, hipaa-compliance.md and
    // six others. A colon-space ends a plain scalar, so without normalisation
    // the YAML parser reports "Nested mappings are not allowed in compact
    // mappings" and the agent would be dropped.
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: gdpr-ccpa-compliance',
        "description: Use when the user needs to understand GDPR. Triggers on: 'GDPR', 'CCPA', 'consent'.",
        'tools: Read, Grep, Glob',
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.description).toBe(
      "Use when the user needs to understand GDPR. Triggers on: 'GDPR', 'CCPA', 'consent'.",
    );
    expect(agent.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('preserves tool names containing colons, underscores and dashes', () => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: tool-heavy',
        'description: Uses unusual tools.',
        'tools: Read, subagent-catalog:search, subagent-catalog:fetch, mcp__bgpt__search_papers, chrome-mcp, mcp__prompt-to-asset',
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.tools).toEqual([
      'Read',
      'subagent-catalog:search',
      'subagent-catalog:fetch',
      'mcp__bgpt__search_papers',
      'chrome-mcp',
      'mcp__prompt-to-asset',
    ]);
  });

  it('drops empty entries and trims whitespace in the tools list', () => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: sloppy-tools',
        'description: Has a trailing comma.',
        'tools: Read ,  Grep ,, Glob,',
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('treats a missing model as undefined', () => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: no-model',
        'description: Has no model key.',
        'tools: Read',
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.model).toBeUndefined();
  });

  it.each(['sonnet', 'haiku', 'inherit'])('keeps the model value %s', (model) => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: with-model',
        'description: Declares a model.',
        'tools: Read',
        `model: ${model}`,
        '---',
        'Body.',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.model).toBe(model);
  });

  it('parses LF-only files as well as CRLF ones', () => {
    const raw = ['---', 'name: lf-agent', 'description: LF only.', 'tools: Read', '---', 'Body.'].join(
      '\n',
    );

    const agent = parseAgentFile(raw, AGENT_PATH, REPO_ROOT);
    expect(agent.name).toBe('lf-agent');
    expect(agent.systemPrompt).toBe('Body.');
  });

  it('strips a UTF-8 BOM before looking for the opening delimiter', () => {
    const raw = String.fromCharCode(0xfeff) + crlf([
      '---',
      'name: bom-agent',
      'description: Starts with a BOM.',
      'tools: Read',
      '---',
      'Body.',
    ]);

    expect(parseAgentFile(raw, AGENT_PATH, REPO_ROOT).name).toBe('bom-agent');
  });

  it('keeps the body verbatim below the frontmatter, including inner --- rules', () => {
    const agent = parseAgentFile(
      crlf([
        '---',
        'name: ruled-agent',
        'description: Body contains a horizontal rule.',
        'tools: Read',
        '---',
        '',
        'Intro paragraph.',
        '',
        '---',
        '',
        'Second section.',
        '',
      ]),
      AGENT_PATH,
      REPO_ROOT,
    );

    expect(agent.systemPrompt).toBe('Intro paragraph.\n\n---\n\nSecond section.');
  });

  describe('failure modes', () => {
    it('throws when there is no opening delimiter', () => {
      const raw = crlf(['name: no-frontmatter', 'description: Nope.', 'tools: Read']);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(AgentParseError);
      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(
        /missing opening frontmatter delimiter/,
      );
    });

    it('throws when the frontmatter is unterminated', () => {
      const raw = crlf([
        '---',
        'name: unterminated',
        'description: No closing delimiter.',
        'tools: Read',
        '',
        'Body that never closes the block.',
      ]);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(/unterminated frontmatter/);
    });

    it('throws on malformed YAML', () => {
      const raw = crlf([
        '---',
        'name: malformed',
        'description: "unterminated quote',
        '  - stray: [ sequence',
        'tools: Read',
        '---',
        'Body.',
      ]);

      let caught: unknown;
      try {
        parseAgentFile(raw, AGENT_PATH, REPO_ROOT);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AgentParseError);
      expect((caught as AgentParseError).message).toMatch(/failed to parse YAML frontmatter/);
      expect((caught as AgentParseError).filePath).toBe(AGENT_PATH);
    });

    it('throws when name is missing', () => {
      const raw = crlf(['---', 'description: No name.', 'tools: Read', '---', 'Body.']);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(
        /missing required key "name"/,
      );
    });

    it('throws when name is present but empty', () => {
      const raw = crlf(['---', 'name: "  "', 'description: Blank name.', 'tools: Read', '---', 'B.']);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(/"name" is empty/);
    });

    it('throws when description is missing', () => {
      const raw = crlf(['---', 'name: no-description', 'tools: Read', '---', 'Body.']);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(
        /missing required key "description"/,
      );
    });

    it('throws when tools is missing', () => {
      const raw = crlf(['---', 'name: no-tools', 'description: Has no tools.', '---', 'Body.']);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(
        /missing required key "tools"/,
      );
    });

    it('throws when there is no body below the frontmatter', () => {
      const raw = crlf([
        '---',
        'name: bodyless',
        'description: Has frontmatter but no system prompt.',
        'tools: Read',
        '---',
        '',
        '   ',
        '',
      ]);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(
        /no body below the frontmatter/,
      );
    });

    it('throws when tools is present but resolves to an empty list', () => {
      const raw = crlf([
        '---',
        'name: empty-tools',
        'description: Commas only.',
        'tools: " , , "',
        '---',
        'Body.',
      ]);

      expect(() => parseAgentFile(raw, AGENT_PATH, REPO_ROOT)).toThrow(/"tools" is empty/);
    });

    it('reports the file path when a required key is absent entirely', () => {
      const raw = crlf(['---', 'name: line-check', 'tools: Read', '---', 'Body.']);

      let caught: unknown;
      try {
        parseAgentFile(raw, AGENT_PATH, REPO_ROOT);
      } catch (error) {
        caught = error;
      }

      const error = caught as AgentParseError;
      expect(error).toBeInstanceOf(AgentParseError);
      expect(error.filePath).toBe(AGENT_PATH);
      expect(error.message).toContain(AGENT_PATH);
    });

    it('reports a line number pointing at the offending key', () => {
      const raw = crlf([
        '---',
        'name: bad-tools',
        'description: Tools is a mapping.',
        'tools:',
        '  read: true',
        '---',
        'Body.',
      ]);

      let caught: unknown;
      try {
        parseAgentFile(raw, AGENT_PATH, REPO_ROOT);
      } catch (error) {
        caught = error;
      }

      const error = caught as AgentParseError;
      expect(error).toBeInstanceOf(AgentParseError);
      // `tools:` is line 4 of the file (line 1 is the opening delimiter).
      expect(error.line).toBe(4);
    });
  });
});
