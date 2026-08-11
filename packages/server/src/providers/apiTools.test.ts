import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxedTools } from './apiTools.js';

/**
 * `apiTools.ts` is the only thing standing between an LLM-authored path (from
 * a raw Anthropic/OpenAI/DeepSeek chat-completions call, which has no
 * filesystem sandbox of its own) and this machine's real filesystem (NFR-1).
 * The escape-vector tests below matter far more than the happy-path ones —
 * see the module doc comment in `apiTools.ts` for the two-layer defence
 * (lexical containment, then `fs.realpath`-based symlink resolution) they
 * are exercising.
 *
 * Real temporary directories are used throughout, never mocks: a mocked `fs`
 * cannot tell us whether `fs.realpath` genuinely defeats a real symlink on
 * this real OS, which is exactly the question that matters here.
 */

let root: string;

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-apitools-'));
  return dir;
}

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function newWorkspace(): string {
  const dir = makeWorkspace();
  created.push(dir);
  return dir;
}

/**
 * Windows symlink creation normally requires either Developer Mode or an
 * elevated process. Probed once, synchronously, at module load so
 * `it.skipIf` can use it — a dynamic runtime skip would still register the
 * test as "passed" without ever exercising it, which is not the same claim
 * as "this environment can't test it". `console.warn` makes the gap visible
 * in the test run's own output rather than a silently green suite.
 */
function probeSymlinkSupport(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-symlink-probe-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link.txt'), 'file');
    return true;
  } catch (error) {
    console.warn(
      `apiTools.test.ts: skipping symlink-escape tests — this process cannot create symlinks on this machine (${error instanceof Error ? error.message : String(error)}). ` +
        'On Windows this normally means Developer Mode is off and the process is not elevated. Symlink defences are implemented (see verifyRealContainment in apiTools.ts) but are unverified by this test run.',
    );
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINKS_SUPPORTED = probeSymlinkSupport();

beforeAll(() => {
  root = newWorkspace();
});

// ---------------------------------------------------------------------------
// schemas()
// ---------------------------------------------------------------------------

describe('schemas', () => {
  it('returns only the intersection of allowedTools and the implemented tools', () => {
    const tools = createSandboxedTools(root);
    const result = tools.schemas(['Read', 'Grep']);
    expect(result.map((s) => s.name).sort()).toEqual(['Grep', 'Read']);
  });

  it('returns nothing when allowedTools names none of the implemented tools', () => {
    const tools = createSandboxedTools(root);
    expect(tools.schemas(['PowerShell', 'WebFetch'])).toEqual([]);
  });

  it('returns nothing for an empty allowlist', () => {
    const tools = createSandboxedTools(root);
    expect(tools.schemas([])).toEqual([]);
  });

  it('matches tool names case-insensitively, like the CLI adapter does for Bash', () => {
    const tools = createSandboxedTools(root);
    expect(tools.schemas(['read', 'WRITE']).map((s) => s.name).sort()).toEqual(['Read', 'Write']);
  });

  it('never advertises Write to an agent whose frontmatter only grants Read', () => {
    const tools = createSandboxedTools(root);
    const result = tools.schemas(['Read']);
    expect(result.some((s) => s.name === 'Write')).toBe(false);
    expect(result.some((s) => s.name === 'Edit')).toBe(false);
  });

  it('intersects with the constructor allowlist, so schemas() cannot advertise more than execute() will run', () => {
    // Previously `schemas(requested)` filtered only by its own argument and
    // never consulted `permitted` (the constructor's `allowedTools`). Both call
    // sites in this repo happen to pass the same list to both, so the gap
    // never showed up in practice — but advertising and executing are meant to
    // be separate decisions (see the constructor's own doc comment), and this
    // left half of that unenforced: nothing stopped a caller from asking
    // schemas() for more than the agent was permitted to run.
    const tools = createSandboxedTools(root, ['Read']);
    const result = tools.schemas(['Read', 'Write']);
    expect(result.map((s) => s.name)).toEqual(['Read']);
  });

  it('describes every implemented tool with a JSON Schema object', () => {
    const tools = createSandboxedTools(root);
    const all = tools.schemas(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS']);
    expect(all).toHaveLength(6);
    for (const schema of all) {
      expect(schema.inputSchema).toMatchObject({ type: 'object' });
      expect(typeof schema.description).toBe('string');
      expect(schema.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe('Read', () => {
  it('reads a file relative to the workspace root', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'a.txt'), 'hello world');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'a.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello world');
  });

  it('reads a nested file', async () => {
    const dir = newWorkspace();
    await fsp.mkdir(path.join(dir, 'sub', 'deep'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'sub', 'deep', 'b.txt'), 'nested');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'sub/deep/b.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('nested');
  });

  it('reports a clear, non-throwing error for a missing file', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'missing.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/does not exist/i);
  });

  it('errors clearly when asked to read a directory', async () => {
    const dir = newWorkspace();
    await fsp.mkdir(path.join(dir, 'sub'));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'sub' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/directory/i);
  });

  it('applies offset and limit to page through a file', async () => {
    const dir = newWorkspace();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    await fsp.writeFile(path.join(dir, 'c.txt'), lines.join('\n'));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'c.txt', offset: 2, limit: 3 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('line 2\nline 3\nline 4');
    expect(result.content).not.toContain('line 5');
  });

  it('defaults to at most 2000 lines and states that the file continues', async () => {
    const dir = newWorkspace();
    const lines = Array.from({ length: 2500 }, (_, i) => `L${i}`);
    await fsp.writeFile(path.join(dir, 'big.txt'), lines.join('\n'));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'big.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('L0');
    expect(result.content).toContain('L1999');
    expect(result.content).not.toContain('L2000\n');
    expect(result.content).toMatch(/showing lines 1-2000 of 2500/);
  });

  it('refuses a file over the byte cap rather than loading it whole', async () => {
    const dir = newWorkspace();
    // One 11 MiB line: well past the 10 MiB Read cap, and pathological for a
    // naive line-splitting implementation too.
    await fsp.writeFile(path.join(dir, 'huge.txt'), 'x'.repeat(11 * 1024 * 1024));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'huge.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/over the .* cap/i);
  });

  it('refuses to read a file containing a NUL byte as binary', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'bin.dat' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/binary/i);
  });

  it('rejects malformed input via zod rather than throwing', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 42 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid input/i);
  });
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe('Write', () => {
  it('creates a new file', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Write', { path: 'new.txt', content: 'fresh content' });
    expect(result.isError).toBe(false);
    expect(await fsp.readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('fresh content');
  });

  it('overwrites an existing file', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'existing.txt'), 'old');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Write', { path: 'existing.txt', content: 'new' });
    expect(result.isError).toBe(false);
    expect(await fsp.readFile(path.join(dir, 'existing.txt'), 'utf8')).toBe('new');
  });

  it('creates parent directories that do not yet exist', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Write', {
      path: 'a/b/c/deep.txt',
      content: 'deep',
    });
    expect(result.isError).toBe(false);
    expect(await fsp.readFile(path.join(dir, 'a', 'b', 'c', 'deep.txt'), 'utf8')).toBe('deep');
  });

  it('refuses content over the write cap', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Write', {
      path: 'huge.txt',
      content: 'x'.repeat(6 * 1024 * 1024),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/over the .* cap/i);
    expect(fs.existsSync(path.join(dir, 'huge.txt'))).toBe(false);
  });

  it('refuses to overwrite an existing directory as if it were a file', async () => {
    const dir = newWorkspace();
    await fsp.mkdir(path.join(dir, 'adir'));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Write', { path: 'adir', content: 'oops' });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe('Edit', () => {
  it('replaces a unique occurrence of oldText', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'e.txt'), 'the quick brown fox');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Edit', { path: 'e.txt', oldText: 'brown', newText: 'red' });
    expect(result.isError).toBe(false);
    expect(await fsp.readFile(path.join(dir, 'e.txt'), 'utf8')).toBe('the quick red fox');
  });

  it('fails clearly, without modifying the file, when oldText is absent', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'e2.txt'), 'unchanged content');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Edit', {
      path: 'e2.txt',
      oldText: 'not present anywhere',
      newText: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
    expect(await fsp.readFile(path.join(dir, 'e2.txt'), 'utf8')).toBe('unchanged content');
  });

  it('fails clearly, without modifying the file, when oldText is ambiguous', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'e3.txt'), 'foo bar foo baz foo');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Edit', { path: 'e3.txt', oldText: 'foo', newText: 'X' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/appears 3 times/i);
    expect(await fsp.readFile(path.join(dir, 'e3.txt'), 'utf8')).toBe('foo bar foo baz foo');
  });

  it('treats oldText as a literal string, not a regular expression', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'e4.txt'), 'price: $5 (was a.b)');
    const tools = createSandboxedTools(dir);

    // If oldText were compiled as regex, "a.b" would also match "aXb"; it must not.
    const result = await tools.execute('Edit', { path: 'e4.txt', oldText: 'a.b', newText: 'a-b' });
    expect(result.isError).toBe(false);
    expect(await fsp.readFile(path.join(dir, 'e4.txt'), 'utf8')).toBe('price: $5 (was a-b)');
  });

  it('errors when the target file does not exist', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Edit', { path: 'nope.txt', oldText: 'a', newText: 'b' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/does not exist/i);
  });
});

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

describe('Glob', () => {
  async function seedTree(dir: string): Promise<void> {
    await fsp.mkdir(path.join(dir, 'src', 'nested'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'src', 'index.ts'), '');
    await fsp.writeFile(path.join(dir, 'src', 'nested', 'util.ts'), '');
    await fsp.writeFile(path.join(dir, 'src', 'readme.md'), '');
    await fsp.writeFile(path.join(dir, 'top.ts'), '');
  }

  it('matches files with ** across directory depths', async () => {
    const dir = newWorkspace();
    await seedTree(dir);
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Glob', { pattern: 'src/**/*.ts' });
    expect(result.isError).toBe(false);
    expect(result.content.split('\n').sort()).toEqual(['src/index.ts', 'src/nested/util.ts']);
  });

  it('matches only the immediate directory with a single *', async () => {
    const dir = newWorkspace();
    await seedTree(dir);
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Glob', { pattern: 'src/*.ts' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('src/index.ts');
  });

  it('reports no matches without erroring', async () => {
    const dir = newWorkspace();
    await seedTree(dir);
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Glob', { pattern: '**/*.py' });
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no files matched/i);
  });

  it('caps the number of results and says so', async () => {
    const dir = newWorkspace();
    for (let i = 0; i < 520; i += 1) {
      await fsp.writeFile(path.join(dir, `f${i}.txt`), '');
    }
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Glob', { pattern: '*.txt' });
    expect(result.isError).toBe(false);
    const lines = result.content.split('\n').filter((l) => l.endsWith('.txt'));
    expect(lines.length).toBe(500);
    expect(result.content).toMatch(/showing first 500 matches/i);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

describe('Grep', () => {
  it('returns path:line: text for each match', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'g.txt'), 'alpha\nbeta needle here\ngamma');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Grep', { pattern: 'needle' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('g.txt:2: beta needle here');
  });

  it('restricts the search to files matching glob', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'a.ts'), 'TODO: fix this');
    await fsp.writeFile(path.join(dir, 'b.md'), 'TODO: ignore this');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Grep', { pattern: 'TODO', glob: '*.ts' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('a.ts:1: TODO: fix this');
  });

  it('reports an invalid regex as a retryable error rather than throwing', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Grep', { pattern: '(unclosed' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a valid regular expression/i);
  });

  it('caps the number of matches and says so, instead of blowing the context window', async () => {
    const dir = newWorkspace();
    const lines = Array.from({ length: 300 }, () => 'match me').join('\n');
    await fsp.writeFile(path.join(dir, 'many.txt'), lines);
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Grep', { pattern: 'match me' });
    expect(result.isError).toBe(false);
    const matchLines = result.content.split('\n').filter((l) => l.startsWith('many.txt:'));
    expect(matchLines.length).toBe(200);
    expect(result.content).toMatch(/showing first 200 matches/i);
  });

  it('refuses a catastrophic-backtracking pattern instead of hanging the process', async () => {
    // The exact reproduction from the field report: a workspace file
    // containing "a".repeat(40) + "!" and Grep({ pattern: "^(a+)+$" }). Under
    // the old code — a `MAX_GREP_MS` deadline checked only between files and
    // between lines — this call ran past 120 seconds before it had to be
    // killed, because the deadline check never got a turn to run: the single
    // synchronous `regex.test(line)` call it was supposed to interrupt cannot
    // be interrupted by anything in plain JS. This server is one Node process
    // serving every run and every websocket client, so that was not a slow
    // tool call, it was the whole application wedged.
    //
    // The fix rejects the pattern's nested-quantifier shape before a single
    // `.test()` call happens (see `hasCatastrophicNestedQuantifier` in
    // apiTools.ts), so this must return in well under the 5-second
    // MAX_GREP_MS budget — the test's own timeout below is generous
    // precisely so that if this fix ever regressed back to "wait for the
    // deadline check," the test would hang and fail loudly rather than pass
    // by accident.
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'evil.txt'), `${'a'.repeat(40)}!`);
    const tools = createSandboxedTools(dir);

    const start = Date.now();
    const result = await tools.execute('Grep', { pattern: '^(a+)+$' });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(4_000);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/nested|adjacent|repetition|backtrack/i);
  }, 10_000);

  it('refuses a repeated group whose alternatives can start the same way', async () => {
    // The first version of this gate looked only for a repetition INSIDE a
    // repetition, and both patterns below slipped straight through it — proven
    // by running them against the real tool: `(a|a)*` wedged the process past
    // 25 seconds and had to be killed from outside, and `(a|aa)+` took 6.2
    // seconds, over the very budget the gate exists to make real.
    //
    // The lesson is worth keeping next to the test: `(a+)+` and `(a|a)*` are
    // the same defect wearing different spellings — many distinct ways to
    // divide one input among the repetitions — and a check written against one
    // spelling covers neither. Neither pattern has a quantifier inside the
    // group at all.
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'evil.txt'), `${'a'.repeat(40)}!`);
    const tools = createSandboxedTools(dir);

    for (const pattern of ['^(a|a)*$', '^(a|aa)+$']) {
      const start = Date.now();
      const result = await tools.execute('Grep', { pattern });
      expect(Date.now() - start).toBeLessThan(4_000);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/alternatives|repetition|many different ways/i);
    }
  }, 15_000);

  it('still runs a repeated group whose alternatives are genuinely distinct', async () => {
    // The counterweight to the test above. `(foo|bar)+` cannot blow up — no
    // input can be divided between those alternatives more than one way — and
    // refusing it would make this gate a nuisance an agent has to work around
    // rather than a guard it rarely notices.
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'ok.txt'), 'foobarfoo');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Grep', { pattern: '(foo|bar)+' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('ok.txt:1: foobarfoo');
  });

  it('still runs a benign grouped-and-repeated pattern that is not nested', async () => {
    // Pins that the rejection is specific to nested/adjacent unbounded
    // repetition, not "any pattern with a group and a +/*".
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'ok.txt'), 'foofoofoo bar');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Grep', { pattern: '(foo)+' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('ok.txt:1: foofoofoo bar');
  });

  it('skips binary files rather than returning garbage matches', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'data.bin'), Buffer.from([0x00, 0x41, 0x00, 0x42]));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Grep', { pattern: 'A' });
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no matches/i);
    expect(result.content).toMatch(/skipped 1 file/i);
  });
});

// ---------------------------------------------------------------------------
// LS
// ---------------------------------------------------------------------------

describe('LS', () => {
  it('lists the workspace root when path is omitted', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'file.txt'), '');
    await fsp.mkdir(path.join(dir, 'subdir'));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('LS', {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('file.txt');
    expect(result.content).toContain('subdir/');
  });

  it('lists a named subdirectory', async () => {
    const dir = newWorkspace();
    await fsp.mkdir(path.join(dir, 'sub'));
    await fsp.writeFile(path.join(dir, 'sub', 'inner.txt'), '');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('LS', { path: 'sub' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('inner.txt');
  });

  it('reports an empty directory distinctly from an error', async () => {
    const dir = newWorkspace();
    await fsp.mkdir(path.join(dir, 'empty'));
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('LS', { path: 'empty' });
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/empty/i);
  });

  it('errors when asked to list a file', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'f.txt'), '');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('LS', { path: 'f.txt' });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// execute() general behaviour
// ---------------------------------------------------------------------------

describe('execute', () => {
  it('reports an unknown tool name as an error instead of throwing', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('DeleteEverything', { path: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unknown tool/i);
  });

  it('is case-insensitive about the tool name, matching schemas()', async () => {
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'x.txt'), 'hi');
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('read', { path: 'x.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// Sandbox escape vectors — NFR-1. Every attack listed in the brief gets a
// test here, across Read/Write/Edit (the tools that take a direct path).
// ---------------------------------------------------------------------------

describe('sandbox escapes', () => {
  it('rejects ../ traversal, including deep chains back past the workspace root', async () => {
    const dir = newWorkspace();
    const secret = path.join(path.dirname(dir), 'secret-outside.txt');
    await fsp.writeFile(secret, 'top secret');
    const tools = createSandboxedTools(dir);

    for (const attack of [
      '../secret-outside.txt',
      '../../secret-outside.txt',
      'a/../../secret-outside.txt',
      'a/b/c/../../../../../../../../etc/passwd',
    ]) {
      const result = await tools.execute('Read', { path: attack });
      expect(result.isError, `expected rejection for "${attack}"`).toBe(true);
      expect(result.content).not.toContain(secret);
    }
  });

  it('rejects an absolute path even when it happens to point outside the workspace', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' });
    expect(result.isError).toBe(true);
  });

  it('rejects a POSIX-style absolute path', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: '/etc/passwd' });
    expect(result.isError).toBe(true);
  });

  it('rejects a Windows drive-relative path (no separator after the drive letter)', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    // "C:file.txt" means "file.txt relative to whatever the CWD on C: happens
    // to be" — not inside the workspace, and not something this module can
    // safely reason about.
    const result = await tools.execute('Read', { path: 'C:file.txt' });
    expect(result.isError).toBe(true);
  });

  it('rejects a UNC path', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: '\\\\server\\share\\file.txt' });
    expect(result.isError).toBe(true);
  });

  it('rejects Write to an absolute path outside the workspace', async () => {
    const dir = newWorkspace();
    const outside = path.join(os.tmpdir(), `agent-office-escape-${Date.now()}.txt`);
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Write', { path: outside, content: 'pwned' });
    expect(result.isError).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('rejects a path that resolves to exactly the workspace directory itself', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    for (const attack of ['.', '']) {
      const result = await tools.execute('Read', { path: attack });
      expect(result.isError, `expected rejection for path "${attack}"`).toBe(true);
    }
  });

  it('does not treat a sibling directory sharing a name prefix as contained', async () => {
    // The classic startsWith bug: workspaceDir="…/abc" naively "contains"
    // "…/abc-evil" because the STRING abc-evil starts with abc. It must not.
    const base = newWorkspace();
    const workspace = path.join(base, 'abc');
    const evilSibling = path.join(base, 'abc-evil');
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(evilSibling, { recursive: true });
    await fsp.writeFile(path.join(evilSibling, 'secret.txt'), 'sibling secret');

    const tools = createSandboxedTools(workspace);

    // The only way to reach the sibling from a relative path is to climb out
    // via "..", which the traversal check already rejects — this test
    // confirms that rejection, pinned specifically to the prefix-sharing case
    // that a naive `absPath.startsWith(workspaceDir)` check would miss.
    const result = await tools.execute('Read', { path: '../abc-evil/secret.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('sibling secret');
  });

  it('rejects a control character in the path, including the NUL truncation trick', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: `a.txt${String.fromCharCode(0)}.png` });
    expect(result.isError).toBe(true);
  });

  it.skipIf(!SYMLINKS_SUPPORTED)(
    'rejects reading through a symlink inside the workspace that points outside it',
    async () => {
      const dir = newWorkspace();
      const outsideDir = newWorkspace();
      const secretOutside = path.join(outsideDir, 'secret.txt');
      await fsp.writeFile(secretOutside, 'outside secret');
      await fsp.symlink(secretOutside, path.join(dir, 'innocuous-link.txt'), 'file');

      const tools = createSandboxedTools(dir);
      const result = await tools.execute('Read', { path: 'innocuous-link.txt' });

      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('outside secret');
      expect(result.content).not.toContain(secretOutside);
    },
  );

  it.skipIf(!SYMLINKS_SUPPORTED)(
    'rejects writing through a symlinked directory inside the workspace that points outside it',
    async () => {
      const dir = newWorkspace();
      const outsideDir = newWorkspace();
      await fsp.symlink(outsideDir, path.join(dir, 'escape-dir'), 'dir');

      const tools = createSandboxedTools(dir);
      const result = await tools.execute('Write', { path: 'escape-dir/pwned.txt', content: 'pwned' });

      expect(result.isError).toBe(true);
      expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
    },
  );

  it.skipIf(!SYMLINKS_SUPPORTED)(
    'allows a symlink whose target is genuinely inside the workspace',
    async () => {
      const dir = newWorkspace();
      await fsp.writeFile(path.join(dir, 'real.txt'), 'legit content');
      await fsp.symlink(path.join(dir, 'real.txt'), path.join(dir, 'alias.txt'), 'file');

      const tools = createSandboxedTools(dir);
      const result = await tools.execute('Read', { path: 'alias.txt' });

      expect(result.isError).toBe(false);
      expect(result.content).toBe('legit content');
    },
  );

  it.skipIf(!SYMLINKS_SUPPORTED)(
    'Glob and Grep never descend into a symlinked directory, so they cannot leak outside paths',
    async () => {
      const dir = newWorkspace();
      const outsideDir = newWorkspace();
      await fsp.writeFile(path.join(outsideDir, 'leaked.ts'), 'OUTSIDE_SECRET_TOKEN');
      await fsp.symlink(outsideDir, path.join(dir, 'linked'), 'dir');

      const tools = createSandboxedTools(dir);

      const globResult = await tools.execute('Glob', { pattern: '**/*.ts' });
      expect(globResult.content).not.toContain('leaked.ts');

      const grepResult = await tools.execute('Grep', { pattern: 'OUTSIDE_SECRET_TOKEN' });
      expect(grepResult.content).not.toContain('OUTSIDE_SECRET_TOKEN');
    },
  );

  it('accepts a workspace directory argument in different letter-case than the filesystem reports, on Windows', async () => {
    if (process.platform !== 'win32') return;
    const dir = newWorkspace();
    await fsp.writeFile(path.join(dir, 'case.txt'), 'case-insensitive content');

    const upperCased = dir.toUpperCase();
    const tools = createSandboxedTools(upperCased);

    const result = await tools.execute('Read', { path: 'case.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('case-insensitive content');
  });

  it('never reveals the resolved absolute path of a rejected target', async () => {
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);

    const result = await tools.execute('Read', { path: '../../../../etc/passwd' });
    expect(result.isError).toBe(true);
    // The error may safely echo back what the model sent verbatim (that is
    // not a leak — the model already knows what it typed), but must never
    // additionally include the resolved absolute filesystem path, which
    // would hand back real directory names the model has no business seeing.
    expect(result.content).not.toContain(path.resolve(dir));
    expect(result.content).not.toContain(os.tmpdir());
  });

  it('does not leak the resolved absolute path when an unexpected fs failure reaches the execute() catch-all', async () => {
    // A path this long clears every containment check above (it is a plain
    // relative filename, no traversal, no symlink) but blows Windows' MAX_PATH
    // once resolved, so `fsp.writeFile` itself throws ENOENT naming the
    // resolved absolute path. `execute()`'s catch-all used to forward
    // `error.message` verbatim — and unlike a rejected-target message, this one
    // is a genuine TOOL RESULT handed back to the model (and, for the raw-API
    // providers, sent over the network to the model vendor), so the leak here
    // is worse than the one in `server.ts`'s `loadRun`, not merely a duplicate
    // of it.
    const dir = newWorkspace();
    const tools = createSandboxedTools(dir);
    const longName = `${'a'.repeat(300)}.txt`;

    const result = await tools.execute('Write', { path: longName, content: 'pwned?' });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(path.resolve(dir));
    expect(result.content).not.toContain(os.tmpdir());
    // The relative path the caller actually sent, and the error code, are fine
    // to report — the model already knows what it typed.
    expect(result.content).toContain(longName);
    expect(result.content).toMatch(/ENOENT/);
  });
});

describe('the allowlist is enforced at execution, not only at advertisement', () => {
  // The gap this closes: `schemas()` and `execute()` used to make separate
  // decisions, so a model offered only `Read` could still emit a `Write` call
  // and have it carried out. An agent's `tools:` frontmatter is a permission
  // boundary, and one checked only when the menu is printed is not a boundary.
  it('refuses a tool the agent was never offered', async () => {
    const workspace = makeWorkspace();
    const tools = createSandboxedTools(workspace, ['Read']);

    const result = await tools.execute('Write', { path: 'escaped.txt', content: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not available to this agent');
    // And it really did not happen.
    await expect(fsp.readFile(path.join(workspace, 'escaped.txt'), 'utf8')).rejects.toThrow();
  });

  it('still runs a tool that was offered', async () => {
    const workspace = makeWorkspace();
    await fsp.writeFile(path.join(workspace, 'notes.txt'), 'hello', 'utf8');
    const tools = createSandboxedTools(workspace, ['Read']);

    const result = await tools.execute('Read', { path: 'notes.txt' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
  });

  it('names the permitted tools, so the model can stop rather than retry blindly', async () => {
    const workspace = makeWorkspace();
    const tools = createSandboxedTools(workspace, ['Read', 'Grep']);

    const result = await tools.execute('Edit', { path: 'x', oldText: 'a', newText: 'b' });

    expect(result.content).toContain('Read');
    expect(result.content).toContain('Grep');
  });

  it('permits everything it implements when no allowlist is given', async () => {
    // The parameter is optional so the change is additive; this pins that the
    // unrestricted form still behaves as it did.
    const workspace = makeWorkspace();
    const tools = createSandboxedTools(workspace);

    const result = await tools.execute('Write', { path: 'fine.txt', content: 'ok' });

    expect(result.isError).toBe(false);
  });
});
