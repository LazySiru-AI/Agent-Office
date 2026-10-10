import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnClaude } from './childProcess.js';
import { CLAUDE_BIN_ENV_VAR, checkClaudeCodeAvailability } from './resolveBinary.js';
import { UnsafeWindowsArgumentError, isBatchShim, resolveSpawnTarget } from './windowsSpawn.js';

/**
 * The pure `resolveSpawnTarget` tests pass `platform` explicitly so the Windows
 * branch is exercised on any host. The tests at the bottom actually spawn a real
 * `.cmd` and are skipped off Windows — that pairing is the point of this file.
 * The original defect survived the whole suite precisely because every spawn was
 * either injected or aimed at `node`, so nothing ever executed the shim path.
 */

describe('isBatchShim', () => {
  it('recognises .cmd and .bat regardless of case', () => {
    expect(isBatchShim('C:\\x\\claude.cmd')).toBe(true);
    expect(isBatchShim('C:\\x\\claude.BAT')).toBe(true);
    expect(isBatchShim('C:\\x\\claude.Cmd')).toBe(true);
  });

  it('does not treat a real executable as a shim', () => {
    expect(isBatchShim('C:\\x\\claude.exe')).toBe(false);
    expect(isBatchShim('/usr/local/bin/claude')).toBe(false);
    // The substring must be an extension, not just present in the name.
    expect(isBatchShim('/usr/local/bin/cmd-runner')).toBe(false);
  });
});

describe('resolveSpawnTarget: pass-through cases', () => {
  it('leaves a POSIX binary untouched', () => {
    const target = resolveSpawnTarget('/usr/local/bin/claude', ['auth', 'status'], 'linux');
    expect(target).toEqual({ command: '/usr/local/bin/claude', args: ['auth', 'status'] });
    expect(target.windowsVerbatimArguments).toBeUndefined();
  });

  it('leaves a Windows .exe untouched, so the safer Node path keeps being used', () => {
    const target = resolveSpawnTarget('C:\\Program Files\\claude.exe', ['--print'], 'win32');
    expect(target).toEqual({ command: 'C:\\Program Files\\claude.exe', args: ['--print'] });
  });

  it('does not reroute a .cmd on POSIX, where it is just an ordinary filename', () => {
    const target = resolveSpawnTarget('/home/u/claude.cmd', [], 'linux');
    expect(target.command).toBe('/home/u/claude.cmd');
  });
});

describe('resolveSpawnTarget: the Windows batch detour', () => {
  it('routes a .cmd through ComSpec with /d /s /c and verbatim arguments', () => {
    const target = resolveSpawnTarget('C:\\npm\\claude.cmd', ['auth', 'status'], 'win32', 'C:\\WINDOWS\\system32\\cmd.exe');

    expect(target.command).toBe('C:\\WINDOWS\\system32\\cmd.exe');
    expect(target.windowsVerbatimArguments).toBe(true);
    expect(target.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(target.args[3]).toBe('""C:\\npm\\claude.cmd" "auth" "status""');
  });

  it('falls back to cmd.exe when ComSpec is empty', () => {
    expect(resolveSpawnTarget('a.cmd', [], 'win32', '').command).toBe('cmd.exe');
  });

  it('quotes a path containing spaces rather than splitting it into two tokens', () => {
    const target = resolveSpawnTarget('C:\\Program Files\\claude.cmd', [], 'win32', 'cmd.exe');
    expect(target.args[3]).toBe('""C:\\Program Files\\claude.cmd""');
  });

  it('doubles a trailing backslash so it cannot escape the closing quote', () => {
    // `"C:\dir\"` would escape its own closing quote and swallow the rest of the
    // line; `"C:\dir\\"` is the same path, correctly terminated.
    const target = resolveSpawnTarget('a.cmd', ['C:\\dir\\'], 'win32', 'cmd.exe');
    expect(target.args[3]).toBe('""a.cmd" "C:\\dir\\\\""');
  });

  it('leaves interior backslashes alone, which is what a Windows path needs', () => {
    const target = resolveSpawnTarget('a.cmd', ['C:\\a\\b\\c.md'], 'win32', 'cmd.exe');
    expect(target.args[3]).toBe('""a.cmd" "C:\\a\\b\\c.md""');
  });

  it('allows parentheses, so an install under Program Files (x86) still runs', () => {
    const target = resolveSpawnTarget('C:\\Program Files (x86)\\claude.cmd', [], 'win32', 'cmd.exe');
    expect(target.args[3]).toBe('""C:\\Program Files (x86)\\claude.cmd""');
  });

  it('preserves an empty argument as an empty quoted token', () => {
    const target = resolveSpawnTarget('a.cmd', [''], 'win32', 'cmd.exe');
    expect(target.args[3]).toBe('""a.cmd" """');
  });
});

describe('resolveSpawnTarget: refusing what cannot be quoted', () => {
  // Each of these survives double-quoting on a cmd.exe line, so escaping them
  // correctly is not possible in every context. Refusing is the safe answer.
  const cases: [string, string][] = [
    ['an embedded quote', 'a"b'],
    ['an environment variable reference', '%PATH%'],
    ['a delayed-expansion reference', '!PATH!'],
    ['a command separator', 'sonnet & calc'],
    ['a pipe', 'sonnet | calc'],
    ['a redirect', 'sonnet > out.txt'],
    ['an input redirect', 'sonnet < in.txt'],
    ['the escape character', 'sonnet ^& calc'],
    ['a carriage return', 'a\rb'],
    ['a newline', 'a\nb'],
    ['a NUL', 'a\0b'],
  ];

  for (const [label, value] of cases) {
    it(`refuses ${label}`, () => {
      expect(() => resolveSpawnTarget('a.cmd', [value], 'win32', 'cmd.exe')).toThrow(
        UnsafeWindowsArgumentError,
      );
    });
  }

  it('refuses an unsafe binary path too, not just arguments', () => {
    expect(() => resolveSpawnTarget('%TEMP%\\claude.cmd', [], 'win32', 'cmd.exe')).toThrow(
      UnsafeWindowsArgumentError,
    );
  });

  it('names the offending argument, so the error is actionable', () => {
    try {
      resolveSpawnTarget('a.cmd', ['--model', '%EVIL%'], 'win32', 'cmd.exe');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeWindowsArgumentError);
      expect((error as UnsafeWindowsArgumentError).argument).toBe('%EVIL%');
      expect((error as Error).message).toContain('%EVIL%');
    }
  });

  it('does not refuse these characters on the pass-through path', () => {
    // Nothing is being handed to a shell there, so Node's own argument passing
    // handles them correctly and there is nothing to refuse.
    expect(() => resolveSpawnTarget('/bin/claude', ['%PATH%', 'a"b'], 'linux')).not.toThrow();
  });
});

/**
 * The regression test proper.
 *
 * `spawn` of a `.cmd` throws *synchronously* on Node ≥ 20.12.2 — it does not
 * emit an `error` event — so this asserts against a real batch file rather than
 * a mock. Windows-only by necessity: `.cmd` semantics are the operating
 * system's, and asserting them anywhere else would be asserting a fiction.
 */
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('spawning a real .cmd on Windows', () => {
  /**
   * Builds a shim shaped like the real npm one: a `.cmd` that forwards `%*` to a
   * node script. That is what `%APPDATA%\npm\claude.cmd` actually does, so the
   * argument and stdin handling exercised here is the production path rather
   * than a convenient stand-in.
   */
  async function writeShim(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-office-shim-'));
    const script = path.join(dir, 'echo-args.js');
    await writeFile(
      script,
      [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (c) => { input += c; });',
        'process.stdin.on("end", () => {',
        '  for (const a of process.argv.slice(2)) process.stdout.write("ARG[" + a + "]\\n");',
        '  process.stdout.write("STDIN[" + input.trim() + "]\\n");',
        '});',
      ].join('\n'),
      'utf8',
    );

    const shim = path.join(dir, 'probe.cmd');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return shim;
  }

  async function collect(binary: string, args: string[], stdin = ''): Promise<string> {
    const { exit, child } = spawnClaude({ binary, args, cwd: path.dirname(binary), stdin });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    await exit;
    return stdout;
  }

  it('confirms the defect: a bare spawn of a .cmd still throws synchronously', async () => {
    const shim = await writeShim();
    // Not an `error` event — an actual synchronous throw, which is why the
    // promise-executor try/catch in `resolveBinary.ts` is needed. If a future
    // Node makes this work again this test fails, and the detour can be
    // reconsidered on purpose rather than by accident.
    expect(() => spawn(shim, [])).toThrow();
  });

  it('spawnClaude runs a .cmd, delivers stdin, and collects stdout', async () => {
    const shim = await writeShim();
    const stdout = await collect(shim, [], 'piped-input');
    expect(stdout).toContain('STDIN[piped-input]');
  });

  it('passes an argument containing a space through as exactly one argument', async () => {
    const shim = await writeShim();
    const stdout = await collect(shim, ['two words']);
    expect(stdout).toContain('ARG[two words]');
    expect(stdout).not.toContain('ARG[two]');
  });

  it('runs from a directory whose name contains parentheses', async () => {
    const shim = await writeShim();
    const stdout = await collect(shim, ['--model', 'claude-sonnet-4-5 (preview)']);
    expect(stdout).toContain('ARG[claude-sonnet-4-5 (preview)]');
  });

  it('keeps the availability preflight on its never-throws contract for a .cmd', async () => {
    // The whole point of the try/catch in `runAuthStatusViaSpawn`. Before it, a
    // synchronous spawn throw inside the promise executor became a rejection,
    // `checkClaudeCodeAvailability` broke the contract its doc comment states,
    // and the HTTP layer returned 500 instead of a 503 naming the real problem.
    // Whatever this shim does, the contract says resolve with a reason.
    //
    // The shim waits on a stdin that the auth probe never writes, so this also
    // exercises the timeout branch — and therefore `killTree`, which is what
    // stops the `cmd.exe` wrapper from orphaning the process it launched. The
    // explicit short `timeoutMs` keeps that deliberate rather than colliding
    // with the runner's own default timeout.
    const shim = await writeShim();
    const availability = await checkClaudeCodeAvailability({
      env: { [CLAUDE_BIN_ENV_VAR]: shim },
      platform: 'win32',
      useCache: false,
      timeoutMs: 750,
    });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toBeTruthy();
  });

  it('refuses an injecting argument instead of executing it', async () => {
    // The `shell: true` fix the review proposed would have run `echo INJECTED`
    // here as a separate command. Quoting alone is not enough either — a shim
    // expanding `%~1` re-parses the `&` — so this must be refused before any
    // process is created.
    const shim = await writeShim();
    expect(() => spawnClaude({
      binary: shim,
      args: ['--model', 'x & echo INJECTED'],
      cwd: path.dirname(shim),
      stdin: '',
    })).toThrow(UnsafeWindowsArgumentError);
  });
});
