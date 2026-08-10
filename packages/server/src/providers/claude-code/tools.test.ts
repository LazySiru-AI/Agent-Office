import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../../registry/index.js';
import {
  CLAUDE_CODE_BUILTIN_TOOLS,
  resolveClaudeCodeTools,
  toArgvToken,
  type DroppedTool,
} from './tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `src/providers/claude-code` -> providers -> src -> server -> packages ->
 * repo root. One level deeper than `src/registry/index.test.ts` (which is
 * itself four `..` up), because this file sits one directory further from
 * `src` than `src/registry` does.
 */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

describe('resolveClaudeCodeTools: real catalog tool strings', () => {
  // categories/04-quality-security/code-reviewer.md
  it('resolves code-reviewer\'s tools, remapping Bash to PowerShell on win32', () => {
    const requested = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];
    const result = resolveClaudeCodeTools(requested, { platform: 'win32' });

    expect(result.resolved).toEqual(['Read', 'Write', 'Edit', 'PowerShell', 'Glob', 'Grep']);
    expect(result.dropped).toEqual([]);

    const bashGrant = result.granted.find((g) => g.requested === 'Bash');
    expect(bashGrant).toEqual({ requested: 'Bash', builtin: 'PowerShell', remapped: true });
  });

  it('leaves Bash as Bash on a non-Windows platform (assumed, not verified)', () => {
    const result = resolveClaudeCodeTools(['Read', 'Bash'], { platform: 'linux' });

    expect(result.resolved).toEqual(['Read', 'Bash']);
    const bashGrant = result.granted.find((g) => g.requested === 'Bash');
    expect(bashGrant).toEqual({ requested: 'Bash', builtin: 'Bash', remapped: false });
  });

  // categories/08-business-product/legal-advisor.md
  it('resolves legal-advisor\'s tools, which never request Bash at all', () => {
    const requested = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
    const result = resolveClaudeCodeTools(requested, { platform: 'win32' });

    expect(result.resolved).toEqual(requested);
    expect(result.dropped).toEqual([]);
    expect(result.granted.every((g) => !g.remapped)).toBe(true);
  });

  // categories/04-quality-security/ui-ux-tester.md
  it('resolves ui-ux-tester\'s tools, dropping chrome-mcp and computer-use as unknown', () => {
    const requested = [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'WebSearch',
      'chrome-mcp',
      'computer-use',
    ];
    const result = resolveClaudeCodeTools(requested, { platform: 'win32' });

    expect(result.resolved).toEqual(['Read', 'Write', 'Edit', 'PowerShell', 'Glob', 'Grep', 'WebSearch']);
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped.map((d) => d.requested).sort()).toEqual(['chrome-mcp', 'computer-use']);
    for (const drop of result.dropped) {
      expect(drop.reason).toBe('not-a-builtin');
    }
  });

  // categories/06-developer-experience/visual-asset-generator.md
  it('resolves visual-asset-generator\'s tools, dropping the mcp__ tool without throwing', () => {
    const requested = ['Read', 'Write', 'Bash', 'mcp__prompt-to-asset'];
    const result = resolveClaudeCodeTools(requested, { platform: 'win32' });

    expect(result.resolved).toEqual(['Read', 'Write', 'PowerShell']);
    expect(result.dropped).toEqual([
      {
        requested: 'mcp__prompt-to-asset',
        reason: 'not-a-builtin',
        detail: expect.stringContaining('mcp__prompt-to-asset'),
      },
    ]);
  });

  // categories/10-research-analysis/scientific-literature-researcher.md
  it('resolves scientific-literature-researcher\'s tools, dropping the mcp__bgpt__ tool', () => {
    const requested = ['Read', 'WebFetch', 'WebSearch', 'mcp__bgpt__search_papers'];
    const result = resolveClaudeCodeTools(requested, { platform: 'win32' });

    expect(result.resolved).toEqual(['Read', 'WebFetch', 'WebSearch']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.requested).toBe('mcp__bgpt__search_papers');
    expect(result.dropped[0]?.reason).toBe('not-a-builtin');
  });

  // categories/09-meta-orchestration/codebase-orchestrator.md
  it('resolves codebase-orchestrator\'s tools: colon and double-underscore names survive parsing verbatim, then get dropped as non-builtins', () => {
    const requested = [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'WebFetch',
      'airis-mcp-gateway',
      'context-manager',
      'error-coordinator',
      'pied-piper',
      'subagent-catalog:search',
      'subagent-catalog:fetch',
    ];
    const result = resolveClaudeCodeTools(requested, { platform: 'win32' });

    expect(result.resolved).toEqual([
      'Read',
      'Write',
      'Edit',
      'PowerShell',
      'Glob',
      'Grep',
      'WebFetch',
    ]);

    const droppedNames = result.dropped.map((d) => d.requested);
    expect(droppedNames).toEqual([
      'airis-mcp-gateway',
      'context-manager',
      'error-coordinator',
      'pied-piper',
      'subagent-catalog:search',
      'subagent-catalog:fetch',
    ]);
    // The colon-bearing names must appear byte-for-byte, not split or mangled.
    expect(droppedNames).toContain('subagent-catalog:search');
    expect(droppedNames).toContain('subagent-catalog:fetch');
    for (const drop of result.dropped) {
      expect(drop.reason).toBe('not-a-builtin');
    }
  });
});

describe('resolveClaudeCodeTools: names with colons and double underscores survive verbatim', () => {
  it('preserves mcp__bgpt__search_papers exactly, including double underscores', () => {
    const result = resolveClaudeCodeTools(['mcp__bgpt__search_papers']);
    expect(result.dropped[0]?.requested).toBe('mcp__bgpt__search_papers');
  });

  it('preserves subagent-catalog:search exactly, including the colon', () => {
    const result = resolveClaudeCodeTools(['subagent-catalog:search']);
    expect(result.dropped[0]?.requested).toBe('subagent-catalog:search');
  });
});

describe('resolveClaudeCodeTools: sandbox-unsafe built-ins are excluded regardless of frontmatter', () => {
  it('excludes SendMessage even though it is a real captured built-in', () => {
    const result = resolveClaudeCodeTools(['Read', 'SendMessage'], { platform: 'win32' });

    expect(result.resolved).toEqual(['Read']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({
      requested: 'SendMessage',
      reason: 'unsafe-for-sandbox',
    });
  });

  it.each([
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
    'PushNotification',
    'EnterWorktree',
    'ExitWorktree',
    'Task',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskOutput',
    'TaskStop',
    'TaskUpdate',
    'DesignSync',
  ] as const)('excludes the sandbox-unsafe built-in %s', (name) => {
    const result = resolveClaudeCodeTools([name], { platform: 'win32' });
    expect(result.resolved).toEqual([]);
    expect(result.dropped[0]?.reason).toBe('unsafe-for-sandbox');
  });

  it('the excluded set is a subset of the captured built-ins, not an invented name', () => {
    const result = resolveClaudeCodeTools(['SendMessage']);
    const drop = result.dropped[0] as DroppedTool;
    expect(CLAUDE_CODE_BUILTIN_TOOLS as readonly string[]).toContain('SendMessage');
    expect(drop.reason).toBe('unsafe-for-sandbox');
  });
});

describe('resolveClaudeCodeTools: empty and all-dropped cases', () => {
  it('an empty request resolves to an empty set with no drops', () => {
    const result = resolveClaudeCodeTools([]);
    expect(result.resolved).toEqual([]);
    expect(result.granted).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(toArgvToken(result.resolved)).toBe('');
  });

  it('a request that is entirely unknown tools resolves to empty, reporting every drop, without throwing', () => {
    const result = resolveClaudeCodeTools(['chrome-mcp', 'pied-piper', 'mcp__foo__bar']);
    expect(result.resolved).toEqual([]);
    expect(result.dropped).toHaveLength(3);
    expect(toArgvToken(result.resolved)).toBe('');
  });

  it('a request that is entirely sandbox-unsafe tools resolves to empty, reporting every drop', () => {
    const result = resolveClaudeCodeTools(['SendMessage', 'CronCreate', 'Task']);
    expect(result.resolved).toEqual([]);
    expect(result.dropped).toHaveLength(3);
    expect(result.dropped.every((d) => d.reason === 'unsafe-for-sandbox')).toBe(true);
  });

  it('duplicate requests are deduplicated in the resolved set but each still gets a granted entry', () => {
    const result = resolveClaudeCodeTools(['Read', 'Read', 'Glob'], { platform: 'win32' });
    expect(result.resolved).toEqual(['Read', 'Glob']);
    expect(result.granted).toHaveLength(3);
  });
});

describe('toArgvToken: single-argv-token safety', () => {
  it('joins multiple names into one comma-separated string with no spaces', () => {
    const token = toArgvToken(['Read', 'Write', 'Edit', 'PowerShell']);
    expect(token).toBe('Read,Write,Edit,PowerShell');
    // The whole point: this must be ONE argv element. If it contained a raw
    // space, a naive `spawn(cmd, token.split(' '))`-style caller could still
    // shatter it back into several — asserting no spaces here is the cheapest
    // regression guard against that class of mistake for the tool names this
    // module actually produces (none of which contain spaces themselves).
    expect(token).not.toMatch(/\s/);
    expect(token.split(',')).toHaveLength(4);
  });

  it('produces the empty string, not a comma or undefined, for an empty list', () => {
    expect(toArgvToken([])).toBe('');
  });

  it('is a single value regardless of list length when placed in an argv array', () => {
    const resolved = resolveClaudeCodeTools(
      ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      { platform: 'win32' },
    ).resolved;
    const argv = ['claude', '--print', '--tools', toArgvToken(resolved), '--verbose', 'the prompt text'];

    // The flag's value and the positional prompt remain distinct argv
    // elements — a variadic --tools could not have swallowed the prompt,
    // because the value it received was always exactly one array entry.
    expect(argv).toHaveLength(6);
    expect(argv[argv.length - 1]).toBe('the prompt text');
    expect(argv[3]).toBe(toArgvToken(resolved));
  });
});

describe('resolveClaudeCodeTools: against the real 154-agent registry', () => {
  it('handles every agent\'s tools string without throwing, and reports aggregate stats', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    expect(registry.agents.length).toBeGreaterThan(0);

    let totalRequested = 0;
    let totalResolved = 0;
    let totalDroppedUnknown = 0;
    let totalDroppedUnsafe = 0;
    let agentsWithAtLeastOneTool = 0;
    let agentsWithZeroResolvedTools = 0;
    const bashAgents: string[] = [];

    for (const agent of registry.agents) {
      // Must never throw, for any of the 154 real frontmatter tool strings.
      const result = resolveClaudeCodeTools(agent.tools, { platform: 'win32' });

      totalRequested += agent.tools.length;
      totalResolved += result.resolved.length;
      totalDroppedUnknown += result.dropped.filter((d) => d.reason === 'not-a-builtin').length;
      totalDroppedUnsafe += result.dropped.filter((d) => d.reason === 'unsafe-for-sandbox').length;

      if (result.resolved.length > 0) agentsWithAtLeastOneTool += 1;
      else agentsWithZeroResolvedTools += 1;

      if (agent.tools.includes('Bash')) bashAgents.push(agent.name);

      // Every requested name is accounted for exactly once, either granted or
      // dropped — nothing vanishes silently (FR-R2).
      expect(result.granted.length + result.dropped.length).toBe(agent.tools.length);
    }

    // Sanity bounds on the real catalog, established by the grep in the task
    // brief: 154 agents, 114 of which request Bash, and a handful of MCP-style
    // names that cannot be honoured.
    expect(registry.agents.length).toBe(154);
    expect(bashAgents.length).toBe(114);
    expect(totalRequested).toBeGreaterThan(totalResolved);
    expect(totalDroppedUnknown).toBeGreaterThan(0);
    // No catalog agent currently spells a sandbox-unsafe built-in by name.
    expect(totalDroppedUnsafe).toBe(0);
    // Every agent resolves at least Read (154 of 154 request it), so nobody
    // should land on the empty/all-dropped case in the current catalog.
    expect(agentsWithZeroResolvedTools).toBe(0);
    expect(agentsWithAtLeastOneTool).toBe(154);

    // Every Bash request on win32 resolves to PowerShell, never left as Bash
    // and never dropped.
    for (const agent of registry.agents) {
      if (!agent.tools.includes('Bash')) continue;
      const result = resolveClaudeCodeTools(agent.tools, { platform: 'win32' });
      expect(result.resolved).toContain('PowerShell');
      expect(result.resolved).not.toContain('Bash');
    }
  });

  it('produces a valid non-empty argv token for every agent in the registry', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    for (const agent of registry.agents) {
      const result = resolveClaudeCodeTools(agent.tools, { platform: 'win32' });
      const token = toArgvToken(result.resolved);
      expect(token).not.toMatch(/\s/);
      // Every current agent resolves at least one tool (asserted above), so
      // the token must be non-empty for the whole catalog today.
      expect(token.length).toBeGreaterThan(0);
    }
  });
});
