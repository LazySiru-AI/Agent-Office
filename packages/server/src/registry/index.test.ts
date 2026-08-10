import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_CATEGORIES } from '@agent-office/shared';
import {
  RegistryLoadError,
  buildRegistry,
  buildRosterDigest,
  estimateTokens,
  loadRegistry,
} from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `src/registry` -> src -> server -> packages -> agent-office -> output -> repo root.
 */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..', '..');

/**
 * Every category directory the repo currently ships. Taken from the shared
 * contract so the two packages cannot drift apart silently.
 */
const EXPECTED_CATEGORIES: string[] = [...AGENT_CATEGORIES];

/**
 * Locked count. If this changes, an agent was added or removed and both this
 * number and the main README should be updated together.
 */
const EXPECTED_AGENT_COUNT = 154;

function agentFile(name: string, description: string, extra: string[] = []): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'tools: Read, Grep, Glob',
    ...extra,
    '---',
    '',
    `You are ${name}.`,
    '',
  ].join('\r\n');
}

describe('loadRegistry against the real repository', () => {
  it('resolves a repo root that actually contains the categories directory', () => {
    expect(existsSync(path.join(REPO_ROOT, 'categories'))).toBe(true);
  });

  it(`indexes exactly ${EXPECTED_AGENT_COUNT} agents`, async () => {
    const registry = await loadRegistry(REPO_ROOT);

    expect(registry.agents).toHaveLength(EXPECTED_AGENT_COUNT);
    expect(registry.byName.size).toBe(EXPECTED_AGENT_COUNT);
  });

  it('covers all ten categories', async () => {
    const registry = await loadRegistry(REPO_ROOT);

    expect([...registry.byCategory.keys()].sort()).toEqual(EXPECTED_CATEGORIES);
    for (const category of EXPECTED_CATEGORIES) {
      expect(registry.byCategory.get(category)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('accounts for every agent exactly once across categories', async () => {
    const registry = await loadRegistry(REPO_ROOT);

    const total = [...registry.byCategory.values()].reduce(
      (sum, agents) => sum + agents.length,
      0,
    );
    expect(total).toBe(EXPECTED_AGENT_COUNT);
  });

  it.each([
    ['code-reviewer', '04-quality-security'],
    ['legal-advisor', '08-business-product'],
    ['multi-agent-coordinator', '09-meta-orchestration'],
  ])('resolves the known agent %s', async (name, category) => {
    const registry = await loadRegistry(REPO_ROOT);
    const agent = registry.get(name);

    expect(agent).toBeDefined();
    expect(agent?.name).toBe(name);
    expect(agent?.category).toBe(category);
    expect(agent?.tools.length).toBeGreaterThan(0);
    expect(agent?.description.length).toBeGreaterThan(0);
    expect(agent?.systemPrompt.length).toBeGreaterThan(0);
    expect(agent?.filePath).toBe(`categories/${category}/${name}.md`);
  });

  it('returns undefined for an unknown agent name', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    expect(registry.get('no-such-agent')).toBeUndefined();
  });

  it('never indexes a README', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    for (const agent of registry.agents) {
      expect(agent.filePath.toLowerCase()).not.toContain('readme.md');
    }
  });

  it('produces a roster digest with one line per agent', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    const digest = buildRosterDigest(registry);
    const lines = digest.split('\n');

    expect(lines).toHaveLength(EXPECTED_AGENT_COUNT);
    for (const line of lines) {
      expect(line).toMatch(/^- \S+ \[\d{2}-[a-z-]+\]: .+$/);
    }
    expect(digest).toContain('- legal-advisor [08-business-product]: ');
  });
});

describe('loadRegistry against synthetic fixtures', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-registry-'));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeRepo(
    label: string,
    files: Record<string, string>,
  ): Promise<string> {
    const root = path.join(tmpRoot, label);
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents, 'utf8');
    }
    return root;
  }

  it('skips README.md at every level and recurses into nested directories', async () => {
    const root = await makeRepo('skips-readme', {
      'categories/README.md': '# Categories\n',
      'categories/01-core/README.md': '# Core\n',
      'categories/01-core/alpha.md': agentFile('alpha', 'First agent.'),
      'categories/01-core/nested/beta.md': agentFile('beta', 'Second agent.'),
      'categories/01-core/notes.txt': 'ignored',
    });

    const registry = await loadRegistry(root);

    expect(registry.agents.map((agent) => agent.name).sort()).toEqual(['alpha', 'beta']);
    expect(registry.get('beta')?.category).toBe('nested');
  });

  it('collects every parse failure instead of stopping at the first', async () => {
    const root = await makeRepo('aggregate-failures', {
      'categories/01-core/ok.md': agentFile('ok', 'Fine.'),
      'categories/01-core/no-frontmatter.md': 'Just a body, no frontmatter.\n',
      'categories/01-core/no-name.md': ['---', 'description: No name.', 'tools: Read', '---', 'B.'].join(
        '\r\n',
      ),
      'categories/01-core/no-tools.md': ['---', 'name: x', 'description: No tools.', '---', 'B.'].join(
        '\r\n',
      ),
    });

    let caught: unknown;
    try {
      await loadRegistry(root);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RegistryLoadError);
    const error = caught as RegistryLoadError;
    expect(error.failures).toHaveLength(3);
    expect(error.message).toContain('no-frontmatter.md');
    expect(error.message).toContain('no-name.md');
    expect(error.message).toContain('no-tools.md');
    expect(error.message).not.toContain('ok.md');
  });

  it('throws on duplicate agent names, naming every file involved', async () => {
    const root = await makeRepo('duplicates', {
      'categories/01-core/first.md': agentFile('twin', 'First definition.'),
      'categories/02-other/second.md': agentFile('twin', 'Second definition.'),
    });

    let caught: unknown;
    try {
      await loadRegistry(root);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RegistryLoadError);
    const error = caught as RegistryLoadError;
    expect(error.duplicates).toHaveLength(1);
    expect(error.duplicates[0]?.name).toBe('twin');
    expect(error.duplicates[0]?.filePaths.sort()).toEqual([
      'categories/01-core/first.md',
      'categories/02-other/second.md',
    ]);
  });

  it('fails with a readable message when the categories directory is missing', async () => {
    const root = path.join(tmpRoot, 'no-categories');
    await mkdir(root, { recursive: true });

    await expect(loadRegistry(root)).rejects.toThrow(/Cannot read agent categories/);
  });
});

describe('buildRosterDigest', () => {
  it('formats each agent as "- name [category]: description"', () => {
    const registry = buildRegistry([
      {
        name: 'alpha',
        description: 'Does alpha things.',
        tools: ['Read'],
        category: '01-core',
        filePath: 'categories/01-core/alpha.md',
        systemPrompt: 'You are alpha.',
      },
      {
        name: 'beta',
        description: 'Does beta things.',
        tools: ['Read', 'Grep'],
        category: '02-other',
        filePath: 'categories/02-other/beta.md',
        systemPrompt: 'You are beta.',
        model: 'haiku',
      },
    ]);

    expect(buildRosterDigest(registry)).toBe(
      ['- alpha [01-core]: Does alpha things.', '- beta [02-other]: Does beta things.'].join('\n'),
    );
  });

  it('returns an empty string for an empty registry', () => {
    expect(buildRosterDigest(buildRegistry([]))).toBe('');
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('approximates at roughly 3.6 characters per token', () => {
    // Deliberately avoids exact multiples of 3.6, whose float division lands
    // right on an integer boundary and makes Math.ceil sensitive to rounding.
    expect(estimateTokens('a'.repeat(1000))).toBe(278);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('a')).toBe(1);
  });

  it('grows monotonically with input length', () => {
    expect(estimateTokens('a'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(50)));
  });
});
