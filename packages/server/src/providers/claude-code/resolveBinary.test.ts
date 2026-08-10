import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_STATUS_TIMEOUT_MS,
  CLAUDE_BIN_ENV_VAR,
  checkClaudeCodeAvailability,
  compareVersions,
  resetResolveBinaryCache,
  resolveClaudeBinary,
  resolveClaudeBinaryCached,
} from './resolveBinary.js';
import type { AuthStatusRunner, ResolveBinaryOptions, RunAuthStatusResult } from './resolveBinary.js';

/**
 * All resolution here runs against a real temp directory, never the machine's
 * actual PATH or `%APPDATA%` — every candidate location is driven through
 * `ResolveBinaryOptions.{env,platform,homedir}` so these tests pass on a clean
 * CI box regardless of whether Claude Code happens to be installed there.
 *
 * The auth-status probe is always an injected fake (`AuthStatusRunner`); no
 * test spawns the real binary.
 */

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-resolve-bin-'));
  resetResolveBinaryCache();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  resetResolveBinaryCache();
});

/** Creates an empty file and, on POSIX, marks it executable — good enough to satisfy `stat().isFile()`. */
async function makeFakeBinary(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '');
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o755);
  }
}

function windowsOptions(overrides: Partial<ResolveBinaryOptions> = {}): ResolveBinaryOptions {
  return {
    platform: 'win32',
    env: { APPDATA: path.join(tmpRoot, 'appdata'), PATH: '' },
    homedir: path.join(tmpRoot, 'home'),
    ...overrides,
  };
}

describe('resolveClaudeBinary', () => {
  it('returns undefined when nothing resolves anywhere', async () => {
    const result = await resolveClaudeBinary(windowsOptions());
    expect(result).toBeUndefined();
  });

  it('env override wins over both PATH and install roots', async () => {
    const overridePath = path.join(tmpRoot, 'override', 'claude.exe');
    await makeFakeBinary(overridePath);

    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));

    const installDir = path.join(tmpRoot, 'appdata', 'Claude', 'claude-code', '9.9.9');
    await makeFakeBinary(path.join(installDir, 'claude.exe'));

    const result = await resolveClaudeBinary(
      windowsOptions({
        env: {
          APPDATA: path.join(tmpRoot, 'appdata'),
          PATH: pathDir,
          [CLAUDE_BIN_ENV_VAR]: overridePath,
        },
      }),
    );

    expect(result).toEqual({ path: overridePath, source: 'env-override' });
  });

  it('falls through to PATH when the override points at nothing, rather than reporting not-found outright', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    const binaryPath = path.join(pathDir, 'claude.exe');
    await makeFakeBinary(binaryPath);

    const result = await resolveClaudeBinary(
      windowsOptions({
        env: {
          APPDATA: path.join(tmpRoot, 'appdata'),
          PATH: pathDir,
          [CLAUDE_BIN_ENV_VAR]: path.join(tmpRoot, 'does-not-exist.exe'),
        },
      }),
    );

    expect(result).toEqual({ path: binaryPath, source: 'path' });
  });

  it('finds claude on PATH when nothing else is set', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    const binaryPath = path.join(pathDir, 'claude.exe');
    await makeFakeBinary(binaryPath);

    const result = await resolveClaudeBinary(windowsOptions({ env: { APPDATA: '', PATH: pathDir } }));

    expect(result).toEqual({ path: binaryPath, source: 'path' });
  });

  it('picks the highest version directory, 2.1.222 beating 2.1.99 (numeric, not string, compare)', async () => {
    const root = path.join(tmpRoot, 'appdata', 'Claude', 'claude-code');
    await makeFakeBinary(path.join(root, '2.1.99', 'claude.exe'));
    await makeFakeBinary(path.join(root, '2.1.222', 'claude.exe'));
    await makeFakeBinary(path.join(root, '2.1.9', 'claude.exe'));

    const result = await resolveClaudeBinary(windowsOptions());

    // A plain string sort would put "2.1.99" ahead of "2.1.222" (lexicographic
    // '9' > '2'), which is exactly the bug this asserts is not present.
    expect(result).toEqual({
      path: path.join(root, '2.1.222', 'claude.exe'),
      source: 'install-root',
      version: '2.1.222',
    });
  });

  it('skips a version directory that exists but has no binary inside it', async () => {
    const root = path.join(tmpRoot, 'appdata', 'Claude', 'claude-code');
    // Higher version, but a broken/partial install with no executable.
    await mkdir(path.join(root, '3.0.0'), { recursive: true });
    await makeFakeBinary(path.join(root, '2.5.0', 'claude.exe'));

    const result = await resolveClaudeBinary(windowsOptions());

    expect(result).toEqual({
      path: path.join(root, '2.5.0', 'claude.exe'),
      source: 'install-root',
      version: '2.5.0',
    });
  });

  it('resolves the POSIX install root under the home directory', async () => {
    const home = path.join(tmpRoot, 'home');
    const binaryPath = path.join(home, '.claude', 'claude-code', '1.2.3', 'claude');
    await makeFakeBinary(binaryPath);

    const result = await resolveClaudeBinary({
      platform: 'linux',
      env: { PATH: '' },
      homedir: home,
    });

    expect(result).toEqual({ path: binaryPath, source: 'install-root', version: '1.2.3' });
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('2.1.222', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2.1.99', '2.1.222')).toBeLessThan(0);
    expect(compareVersions('2.1.222', '2.1.222')).toBe(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
  });
});

describe('resolveClaudeBinaryCached / resetResolveBinaryCache', () => {
  it('caches the result across calls until reset', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    const binaryPath = path.join(pathDir, 'claude.exe');
    await makeFakeBinary(binaryPath);
    const options = windowsOptions({ env: { APPDATA: '', PATH: pathDir } });

    const first = await resolveClaudeBinaryCached(options);
    expect(first).toEqual({ path: binaryPath, source: 'path' });

    // Remove the binary. A live (uncached) resolution would now return
    // undefined; the cached call must still return the stale, cached answer.
    await rm(binaryPath);
    const second = await resolveClaudeBinaryCached(options);
    expect(second).toEqual({ path: binaryPath, source: 'path' });

    resetResolveBinaryCache();
    const third = await resolveClaudeBinaryCached(options);
    expect(third).toBeUndefined();
  });
});

describe('checkClaudeCodeAvailability', () => {
  function fakeRunner(result: RunAuthStatusResult): AuthStatusRunner {
    return vi.fn(async () => result);
  }

  it('reports a not-found reason distinct from the not-authenticated one, and names the fix', async () => {
    const availability = await checkClaudeCodeAvailability({
      ...windowsOptions(),
      useCache: false,
      runAuthStatus: fakeRunner({ stdout: '', exitCode: 0, timedOut: false }),
    });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toMatch(/not found/i);
    expect(availability.reason).toMatch(new RegExp(CLAUDE_BIN_ENV_VAR));
  });

  it('mentions the broken override specifically when one was set', async () => {
    const availability = await checkClaudeCodeAvailability({
      ...windowsOptions({
        env: {
          APPDATA: '',
          PATH: '',
          [CLAUDE_BIN_ENV_VAR]: 'C:\\nonexistent\\claude.exe',
        },
      }),
      useCache: false,
      runAuthStatus: fakeRunner({ stdout: '', exitCode: 0, timedOut: false }),
    });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('C:\\nonexistent\\claude.exe');
  });

  it('reports installed-but-not-authenticated distinctly, naming "claude auth login"', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    const runner = fakeRunner({
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
      exitCode: 0,
      timedOut: false,
    });

    const availability = await checkClaudeCodeAvailability({
      ...windowsOptions({ env: { APPDATA: '', PATH: pathDir } }),
      useCache: false,
      runAuthStatus: runner,
    });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toMatch(/not authenticated/i);
    expect(availability.reason).toContain('claude auth login');
    // And this reason must not collide with the not-found one.
    expect(availability.reason).not.toMatch(/not found/i);
  });

  it('reports ok: true when the binary is found and loggedIn is true', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    const runner = fakeRunner({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'firstParty' }),
      exitCode: 0,
      timedOut: false,
    });

    const availability = await checkClaudeCodeAvailability({
      ...windowsOptions({ env: { APPDATA: '', PATH: pathDir } }),
      useCache: false,
      runAuthStatus: runner,
    });

    expect(availability).toEqual({ ok: true });
  });

  it('does not throw on malformed / non-JSON auth status output, and degrades to a reason', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    const runner = fakeRunner({ stdout: 'not json at all {{{', exitCode: 0, timedOut: false });

    await expect(
      checkClaudeCodeAvailability({
        ...windowsOptions({ env: { APPDATA: '', PATH: pathDir } }),
        useCache: false,
        runAuthStatus: runner,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('could not'),
    });
  });

  it('does not throw when auth status prints valid JSON missing the loggedIn field', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    const runner = fakeRunner({
      stdout: JSON.stringify({ somethingElse: true }),
      exitCode: 0,
      timedOut: false,
    });

    const availability = await checkClaudeCodeAvailability({
      ...windowsOptions({ env: { APPDATA: '', PATH: pathDir } }),
      useCache: false,
      runAuthStatus: runner,
    });

    expect(availability.ok).toBe(false);
  });

  it('surfaces a spawn error (e.g. ENOENT) as its own reason without throwing', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    const runner = fakeRunner({ stdout: '', exitCode: null, timedOut: false, spawnError: 'ENOENT' });

    const availability = await checkClaudeCodeAvailability({
      ...windowsOptions({ env: { APPDATA: '', PATH: pathDir } }),
      useCache: false,
      runAuthStatus: runner,
    });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('ENOENT');
  });

  it('times out rather than hanging, using the injected runner\'s own timeout signal', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    // A well-behaved runner honours the timeoutMs it is given; simulate a CLI
    // that never responds by having the fake itself report timedOut: true
    // rather than actually waiting AUTH_STATUS_TIMEOUT_MS in the test.
    const runner: AuthStatusRunner = vi.fn(async (_binaryPath, timeoutMs) => {
      expect(timeoutMs).toBe(AUTH_STATUS_TIMEOUT_MS);
      return { stdout: '', exitCode: null, timedOut: true };
    });

    const availability = await checkClaudeCodeAvailability({
      ...windowsOptions({ env: { APPDATA: '', PATH: pathDir } }),
      useCache: false,
      runAuthStatus: runner,
    });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toMatch(/did not respond/i);
  });

  it('honours a custom timeoutMs and passes it through to the runner', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    const runner: AuthStatusRunner = vi.fn(async (_binaryPath, timeoutMs) => {
      expect(timeoutMs).toBe(42);
      return { stdout: JSON.stringify({ loggedIn: true }), exitCode: 0, timedOut: false };
    });

    await checkClaudeCodeAvailability({
      ...windowsOptions({ env: { APPDATA: '', PATH: pathDir } }),
      useCache: false,
      timeoutMs: 42,
      runAuthStatus: runner,
    });

    expect(runner).toHaveBeenCalledWith(path.join(pathDir, 'claude.exe'), 42);
  });

  it('uses the cache by default, so a second call does not re-run the probe with different results', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'claude.exe'));
    const options = windowsOptions({ env: { APPDATA: '', PATH: pathDir } });
    const runner = fakeRunner({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0, timedOut: false });

    const first = await checkClaudeCodeAvailability({ ...options, runAuthStatus: runner });
    expect(first).toEqual({ ok: true });

    // Delete the binary; resolution alone would now fail. Because the resolved
    // *binary path* is cached, checkClaudeCodeAvailability must still find it
    // and go on to call the (still-injected) runner rather than reporting not-found.
    await rm(path.join(pathDir, 'claude.exe'));
    const second = await checkClaudeCodeAvailability({ ...options, runAuthStatus: runner });
    expect(second).toEqual({ ok: true });

    resetResolveBinaryCache();
    const third = await checkClaudeCodeAvailability({ ...options, runAuthStatus: runner });
    expect(third.ok).toBe(false);
  });
});
