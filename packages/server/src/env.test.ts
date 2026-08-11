import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDotEnv, resetDotEnvForTests } from './env.js';

/**
 * These tests target `applyManually`, the hand-rolled fallback parser, not
 * `process.loadEnvFile` itself. `loadDotEnv` prefers the real
 * `process.loadEnvFile` whenever it exists, and this test runtime (Node 24)
 * has it — so without deliberately hiding it, every test here would exercise
 * Node's own parser and never touch the code this file is meant to verify.
 *
 * The fallback is not dead code in production: `package.json` declares
 * `"engines": { "node": ">=20.0.0" }` but `process.loadEnvFile` only landed
 * in 20.12, so any explicitly supported 20.x install below that patch runs
 * `applyManually` for real. See the comment in `env.ts` on why the fallback
 * must therefore match the primary path's handling of `export KEY=value`
 * rather than diverge from it.
 */

const TRACKED_KEYS = [
  'ANTHROPIC_API_KEY',
  'FOO',
  'BAR',
  'QUOTED',
  'SINGLE_QUOTED',
  'WITH_EQUALS',
];

let tmpRoot: string;

/** Hides `process.loadEnvFile` for the duration of `run`, forcing `loadDotEnv` onto the fallback path. */
function withoutLoadEnvFile<T>(run: () => T): T {
  const original = process.loadEnvFile;
  Object.defineProperty(process, 'loadEnvFile', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'loadEnvFile', {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

async function makeEnvFile(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-office-env-test-'));
  await writeFile(path.join(dir, '.env'), content, 'utf8');
  return dir;
}

beforeEach(() => {
  resetDotEnvForTests();
  for (const key of TRACKED_KEYS) delete process.env[key];
});

afterEach(async () => {
  for (const key of TRACKED_KEYS) delete process.env[key];
  if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
});

describe('loadDotEnv fallback parser', () => {
  it('sets the variable named after "export", not a variable literally named "export KEY" — the confirmed defect', async () => {
    tmpRoot = await makeEnvFile('export ANTHROPIC_API_KEY=sk-test-123\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-123');
    expect(process.env['export ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('tolerates more than one space, or a tab, between export and the key', async () => {
    tmpRoot = await makeEnvFile('export   FOO=bar\nexport\tBAR=baz\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.FOO).toBe('bar');
    expect(process.env.BAR).toBe('baz');
  });

  it('keeps a value that itself contains an equals sign intact', async () => {
    tmpRoot = await makeEnvFile('WITH_EQUALS=a=b=c\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.WITH_EQUALS).toBe('a=b=c');
  });

  it('strips a matched pair of double quotes from a value', async () => {
    tmpRoot = await makeEnvFile('QUOTED="hello world"\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.QUOTED).toBe('hello world');
  });

  it('strips a matched pair of single quotes from a value', async () => {
    tmpRoot = await makeEnvFile("SINGLE_QUOTED='hello world'\n");
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.SINGLE_QUOTED).toBe('hello world');
  });

  it('does not truncate a value that only starts with a quote, since the pair is unmatched', async () => {
    tmpRoot = await makeEnvFile('FOO="unterminated\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.FOO).toBe('"unterminated');
  });

  it('combines export with a quoted value correctly', async () => {
    tmpRoot = await makeEnvFile('export FOO="quoted and exported"\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.FOO).toBe('quoted and exported');
  });

  it('parses a file with CRLF line endings', async () => {
    tmpRoot = await makeEnvFile('FOO=bar\r\nexport BAR=baz\r\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.FOO).toBe('bar');
    expect(process.env.BAR).toBe('baz');
  });

  it('skips blank lines and comment lines', async () => {
    tmpRoot = await makeEnvFile('\n# a leading comment\n\nFOO=bar\n# a trailing comment\n\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.FOO).toBe('bar');
  });

  it('lets a real environment variable win over the same key in the file', async () => {
    process.env.FOO = 'from-shell';
    tmpRoot = await makeEnvFile('export FOO=from-file\n');
    withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(process.env.FOO).toBe('from-shell');
  });

  it('returns variable names only, never the values, in the applied list', async () => {
    tmpRoot = await makeEnvFile('export ANTHROPIC_API_KEY=sk-should-not-appear\n');
    const result = withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(result.applied).toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(result)).not.toContain('sk-should-not-appear');
  });

  it('does not error and applies nothing when no .env file exists', async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-env-test-'));
    const result = withoutLoadEnvFile(() => loadDotEnv(tmpRoot));

    expect(result.applied).toEqual([]);
  });
});
