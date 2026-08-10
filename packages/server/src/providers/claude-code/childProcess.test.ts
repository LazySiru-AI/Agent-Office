import { describe, expect, it } from 'vitest';
import { killTree, spawnClaude } from './childProcess.js';

/**
 * These tests spawn real processes, using `node` itself as a stand-in for the
 * CLI. Mocking `child_process` here would test the mock: the behaviour under
 * test *is* the operating system's, and the Windows-specific tree kill is
 * precisely the part that a mock would assert into existence without proving.
 */

const NODE = process.execPath;

describe('spawnClaude', () => {
  it('delivers stdin and closes it, so a reader terminates', async () => {
    // Echoes stdin back. If stdin were never closed this would hang and the
    // test would time out — which is the actual assertion.
    const { exit, child } = spawnClaude({
      binary: NODE,
      args: ['-e', 'process.stdin.resume();let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{process.stdout.write(b);process.exit(0)})'],
      cwd: process.cwd(),
      stdin: 'the brief',
    });

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });

    const result = await exit;
    expect(result.code).toBe(0);
    expect(out).toBe('the brief');
  });

  it('captures stderr for error reporting', async () => {
    const { exit, stderr } = spawnClaude({
      binary: NODE,
      args: ['-e', 'process.stderr.write("boom");process.exit(3)'],
      cwd: process.cwd(),
      stdin: '',
    });

    const result = await exit;
    expect(result.code).toBe(3);
    await expect(stderr).resolves.toContain('boom');
  });

  it('rejects `exit` when the binary does not exist', async () => {
    const { exit } = spawnClaude({
      binary: 'definitely-not-a-real-binary-xyz',
      args: [],
      cwd: process.cwd(),
      stdin: '',
    });

    await expect(exit).rejects.toThrow();
  });
});

describe('killTree', () => {
  it('terminates a process that would otherwise run forever', async () => {
    const { child, exit } = spawnClaude({
      binary: NODE,
      // Holds an open handle and ignores SIGTERM-by-default behaviour on POSIX
      // only insofar as the timer keeps the loop alive; the point is that it
      // never exits on its own.
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      stdin: '',
    });

    killTree(child);

    const result = await exit;
    // Windows reports a code (taskkill /F), POSIX reports a signal. Asserting
    // either specifically would make this test platform-locked; that it ended
    // at all is the guarantee FR-M9 actually needs.
    expect(result.code !== null || result.signal !== null).toBe(true);
  });

  it('is safe to call twice, and after the process has already exited', async () => {
    const { child, exit } = spawnClaude({
      binary: NODE,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      stdin: '',
    });

    await exit;

    // A cancelled run can race a naturally-finishing one. Killing a corpse must
    // not throw, or cancel would fail exactly when it collided with completion.
    expect(() => killTree(child)).not.toThrow();
    expect(() => killTree(child)).not.toThrow();
  });
});
