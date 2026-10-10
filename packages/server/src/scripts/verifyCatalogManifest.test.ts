import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildCatalogEntries,
  buildManifest,
  catalogDiffIsClean,
  diffCatalog,
  formatVerifyReport,
  parseManifest,
  serializeManifest,
  sha256Hex,
  type CatalogFileEntry,
  type CatalogManifest,
} from './verifyCatalogManifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/scripts` -> src -> server -> packages -> repo root, same depth as `dump.ts`/`registry/index.test.ts`. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/** One well-formed agent markdown file, matching the shape every real catalog file has. */
function agentFile(name: string, tools: string[], extra: string[] = []): string {
  return [
    '---',
    `name: ${name}`,
    `description: "does things related to ${name}"`,
    `tools: ${tools.join(', ')}`,
    ...extra,
    '---',
    '',
    `You are ${name}. Do the thing.`,
    '',
  ].join('\n');
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-catalog-manifest-'));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

let caseCounter = 0;

/** A fresh `<tmp>/case-N/categories/...` tree for each test, so tests never see each other's files. */
async function newCatalogRoot(): Promise<string> {
  caseCounter += 1;
  const root = path.join(tmpRoot, `case-${caseCounter}`);
  await mkdir(path.join(root, 'categories', '01-core-development'), { recursive: true });
  return root;
}

describe('sha256Hex', () => {
  it('is deterministic and matches a known vector', () => {
    // printf '' | sha256sum
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('buildCatalogEntries', () => {
  it('walks nested category directories and reads tools + hash for each agent file', async () => {
    const root = await newCatalogRoot();
    await writeFile(
      path.join(root, 'categories', '01-core-development', 'api-designer.md'),
      agentFile('api-designer', ['Read', 'Write', 'Grep']),
    );
    await mkdir(path.join(root, 'categories', '02-language-specialists'), { recursive: true });
    await writeFile(
      path.join(root, 'categories', '02-language-specialists', 'rust-engineer.md'),
      agentFile('rust-engineer', ['Read', 'Bash']),
    );

    const entries = await buildCatalogEntries(root);

    expect(entries.map((e) => e.path)).toEqual([
      'categories/01-core-development/api-designer.md',
      'categories/02-language-specialists/rust-engineer.md',
    ]);
    const apiDesigner = entries.find((e) => e.path.includes('api-designer'));
    expect(apiDesigner?.tools).toEqual(['Read', 'Write', 'Grep']);
    expect(apiDesigner?.parseError).toBeNull();
    expect(apiDesigner?.sha256).toHaveLength(64);
  });

  it('skips README.md but not other markdown files, case-insensitively', async () => {
    const root = await newCatalogRoot();
    await writeFile(
      path.join(root, 'categories', '01-core-development', 'README.md'),
      '# Core Development\n\nSome category blurb.\n',
    );
    await writeFile(
      path.join(root, 'categories', '01-core-development', 'backend-developer.md'),
      agentFile('backend-developer', ['Read', 'Edit']),
    );

    const entries = await buildCatalogEntries(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('categories/01-core-development/backend-developer.md');
  });

  it('ignores non-markdown files such as .claude-plugin/plugin.json', async () => {
    const root = await newCatalogRoot();
    await mkdir(path.join(root, 'categories', '01-core-development', '.claude-plugin'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'categories', '01-core-development', '.claude-plugin', 'plugin.json'),
      '{"name": "voltagent-core-dev"}',
    );
    await writeFile(
      path.join(root, 'categories', '01-core-development', 'backend-developer.md'),
      agentFile('backend-developer', ['Read']),
    );

    const entries = await buildCatalogEntries(root);

    expect(entries).toHaveLength(1);
  });

  it('records a parse failure instead of throwing or dropping the file', async () => {
    const root = await newCatalogRoot();
    // Missing the required `tools:` key entirely.
    await writeFile(
      path.join(root, 'categories', '01-core-development', 'broken.md'),
      ['---', 'name: broken', 'description: "no tools key"', '---', '', 'body', ''].join('\n'),
    );

    const entries = await buildCatalogEntries(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tools).toBeNull();
    expect(entries[0]?.parseError).toMatch(/tools/i);
    // Still hashed even though it doesn't parse — an unparseable file must still be tracked.
    expect(entries[0]?.sha256).toHaveLength(64);
  });
});

describe('serializeManifest / parseManifest round trip', () => {
  it('round-trips a manifest through YAML, including null tools/parseError', () => {
    const entries: CatalogFileEntry[] = [
      {
        path: 'categories/01-core-development/api-designer.md',
        sha256: sha256Hex('a'),
        tools: ['Read', 'Write'],
        parseError: null,
      },
      {
        path: 'categories/01-core-development/broken.md',
        sha256: sha256Hex('b'),
        tools: null,
        parseError: 'frontmatter is missing required key "tools"',
      },
    ];
    const manifest = buildManifest(entries, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '2026-08-11T00:00:00.000Z');

    const text = serializeManifest(manifest);
    expect(text).toContain('AO-10');
    expect(text.startsWith('#')).toBe(true);

    const parsed = parseManifest(text);
    expect(parsed).toEqual(manifest);
  });

  it('rejects a manifest that is not a YAML mapping', () => {
    expect(() => parseManifest('- just\n- a\n- list\n')).toThrow(/mapping/);
    expect(() => parseManifest('42\n')).toThrow(/mapping/);
  });

  it('rejects a manifest missing required top-level fields', () => {
    expect(() => parseManifest('sourceRepo: x\n')).toThrow(/sourceCommit/);
  });

  it('rejects a file entry missing path or sha256', () => {
    const text = [
      'sourceRepo: x',
      'sourceCommit: y',
      'generatedAt: z',
      'fileCount: 1',
      'files:',
      '  - tools: [Read]',
    ].join('\n');
    expect(() => parseManifest(text)).toThrow(/path.*sha256/);
  });
});

describe('diffCatalog', () => {
  function entry(overrides: Partial<CatalogFileEntry> = {}): CatalogFileEntry {
    return {
      path: 'categories/01-core-development/api-designer.md',
      sha256: sha256Hex('content'),
      tools: ['Read', 'Grep'],
      parseError: null,
      ...overrides,
    };
  }

  function manifestOf(files: CatalogFileEntry[]): CatalogManifest {
    return buildManifest(files, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '2026-08-11T00:00:00.000Z');
  }

  it('is clean when the working tree exactly matches the manifest', () => {
    const files = [entry()];
    const diff = diffCatalog(manifestOf(files), files);

    expect(catalogDiffIsClean(diff)).toBe(true);
    expect(diff.toolChanges).toEqual([]);
  });

  it('reports a file removed from disk as missing', () => {
    const diff = diffCatalog(manifestOf([entry()]), []);

    expect(diff.missing).toEqual(['categories/01-core-development/api-designer.md']);
    expect(catalogDiffIsClean(diff)).toBe(false);
  });

  it('reports a new file not yet in the manifest as added', () => {
    const diff = diffCatalog(manifestOf([]), [entry()]);

    expect(diff.added).toEqual(['categories/01-core-development/api-designer.md']);
    expect(diff.toolChanges).toEqual([]); // no baseline to diff against
    expect(catalogDiffIsClean(diff)).toBe(false);
  });

  it('reports a body-only edit as changed but not as a tool-grant change', () => {
    const before = entry({ sha256: sha256Hex('old body') });
    const after = entry({ sha256: sha256Hex('new body') }); // same tools
    const diff = diffCatalog(manifestOf([before]), [after]);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.path).toBe(before.path);
    expect(diff.toolChanges).toEqual([]);
  });

  it('flags an added tool as a privilege escalation in toolChanges', () => {
    const before = entry({ tools: ['Read', 'Grep'], sha256: sha256Hex('v1') });
    const after = entry({ tools: ['Read', 'Grep', 'Bash'], sha256: sha256Hex('v2') });
    const diff = diffCatalog(manifestOf([before]), [after]);

    expect(diff.changed).toHaveLength(1); // tools are part of the hashed content
    expect(diff.toolChanges).toHaveLength(1);
    expect(diff.toolChanges[0]?.addedTools).toEqual(['Bash']);
    expect(diff.toolChanges[0]?.removedTools).toEqual([]);
  });

  it('reports a removed tool distinctly from an added one', () => {
    const before = entry({ tools: ['Read', 'Grep', 'Bash'], sha256: sha256Hex('v1') });
    const after = entry({ tools: ['Read', 'Grep'], sha256: sha256Hex('v2') });
    const diff = diffCatalog(manifestOf([before]), [after]);

    expect(diff.toolChanges[0]?.addedTools).toEqual([]);
    expect(diff.toolChanges[0]?.removedTools).toEqual(['Bash']);
  });

  it('flags a file that no longer parses even when its hash happens to match', () => {
    // Pathological but should not crash: same hash, but this entry's tools are null
    // (as buildCatalogEntries would produce for a genuinely broken file).
    const sameHash = sha256Hex('same');
    const before = entry({ sha256: sameHash, tools: ['Read'] });
    const after = entry({ sha256: sameHash, tools: null, parseError: 'broken frontmatter' });
    const diff = diffCatalog(manifestOf([before]), [after]);

    expect(diff.unparseable).toEqual([{ path: before.path, parseError: 'broken frontmatter' }]);
  });
});

describe('formatVerifyReport', () => {
  it('reports OK with no sections when the diff is clean', () => {
    const clean = diffCatalog(
      buildManifest([], 'x', '2026-08-11T00:00:00.000Z'),
      [],
    );
    const report = formatVerifyReport(clean);

    expect(report).toContain('OK: every vendored catalog file matches the manifest.');
    expect(report).not.toContain('PRIVILEGE ADDED');
  });

  it('prints an added tool as PRIVILEGE ADDED, ahead of the generic integrity sections', () => {
    const before: CatalogFileEntry = {
      path: 'categories/04-quality-security/security-auditor.md',
      sha256: sha256Hex('v1'),
      tools: ['Read', 'Grep'],
      parseError: null,
    };
    const after: CatalogFileEntry = { ...before, sha256: sha256Hex('v2'), tools: ['Read', 'Grep', 'Bash'] };
    const diff = diffCatalog(buildManifest([before], 'x', '2026-08-11T00:00:00.000Z'), [after]);

    const report = formatVerifyReport(diff);

    expect(report).toContain('TOOL-GRANT DELTA');
    expect(report).toContain('PRIVILEGE ADDED:   Bash');
    expect(report).toContain('FAILED');
    expect(report.indexOf('TOOL-GRANT DELTA')).toBeLessThan(report.indexOf('Content changed'));
  });
});

describe('against the real repo catalog', () => {
  // Real disk, ~156 real files with a real YAML parser — same cost profile as
  // `registry/index.test.ts`'s equivalent test, and for the same reason: a
  // mocked filesystem can't tell us whether the manifest this script commits
  // actually round-trips against the tree it describes.
  vi.setConfig({ testTimeout: 20_000 });

  it('produces a manifest that verifies clean against the committed catalog it was just generated from', async () => {
    const entries = await buildCatalogEntries(REPO_ROOT);
    expect(entries.length).toBeGreaterThan(100); // sanity: we walked the real tree, not an empty one

    const manifest = buildManifest(entries, 'test-run', new Date().toISOString());
    const roundTripped = parseManifest(serializeManifest(manifest));
    const diff = diffCatalog(roundTripped, entries);

    expect(catalogDiffIsClean(diff)).toBe(true);
    expect(diff.toolChanges).toEqual([]);
  });

  it("flags it when the committed manifest doesn't match, given a synthetic drift", async () => {
    const entries = await buildCatalogEntries(REPO_ROOT);
    // Needs a file that does NOT already grant Bash, so appending it is an
    // actual change rather than a no-op duplicate.
    const target = entries.find((e) => e.tools !== null && !e.tools.includes('Bash'));
    if (target === undefined) throw new Error('expected some catalog entry without Bash in its tools');

    const manifest = buildManifest(entries, 'test-run', new Date().toISOString());
    const tampered: CatalogManifest = {
      ...manifest,
      files: manifest.files.map((f) =>
        f.path === target.path ? { ...f, tools: [...(f.tools ?? []), 'Bash'] } : f,
      ),
    };

    // tampered stands in for "the manifest" (what was reviewed); entries is
    // "the working tree" (what's on disk right now, unchanged) — so relative
    // to the manifest, the working tree is missing a tool the manifest claims
    // it has. Read as "the manifest recorded a grant that reality doesn't
    // have (yet)"; the more common real-world direction — tree gained a tool
    // the manifest doesn't know about — is covered by the unit test above
    // ('flags an added tool as a privilege escalation in toolChanges').
    const diff = diffCatalog(tampered, entries);

    expect(diff.toolChanges).toHaveLength(1);
    expect(diff.toolChanges[0]?.path).toBe(target.path);
    expect(diff.toolChanges[0]?.removedTools).toEqual(['Bash']);
  });
});
