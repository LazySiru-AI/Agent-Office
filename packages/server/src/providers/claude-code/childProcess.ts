import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveSpawnTarget } from './windowsSpawn.js';

/**
 * Child-process lifecycle for the Claude Code adapter.
 *
 * Split out from the adapter because killing a process reliably on Windows is a
 * problem in its own right, and because FR-M9 (cancel) and FR-M8 (timeout) both
 * depend on it working. If this is wrong, a cancelled run leaves a model call
 * billing in the background — the failure is invisible and it costs money.
 */

/**
 * `child.kill()` does not kill descendants on Windows.
 *
 * Node's `kill` maps to `TerminateProcess` on the direct child only. The CLI
 * shells out (ripgrep, git, whatever a tool call needs), and those grandchildren
 * survive, holding the pipes open — so the adapter's stdout stream never ends
 * and a cancelled assignment hangs instead of finishing. `taskkill /T` walks the
 * tree, which is the only thing that actually stops it.
 *
 * POSIX gets the same guarantee from a process group: `detached: true` makes the
 * child a group leader, and killing `-pid` signals the whole group.
 */
/*
 * Typed against `ChildProcess` rather than `ChildProcessWithoutNullStreams`
 * because only `pid`/`exitCode`/`signalCode`/`kill` are touched, and the auth
 * preflight in `resolveBinary.ts` needs the same tree kill for a child it
 * spawned without the full pipe triple.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    // Fire-and-forget: taskkill failing means the tree is already gone, which is
    // the outcome we wanted. Surfacing that as an error would turn a successful
    // cancel into a reported failure.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
    } catch {
      /* ignore — see above */
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may already be gone, or we may not have been able to detach.
    // Fall back to the direct child rather than leaving it running.
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

export interface SpawnOptions {
  binary: string;
  args: string[];
  cwd: string;
  /**
   * Written to the child's stdin, which is then closed.
   *
   * The brief goes here rather than into argv deliberately. Windows caps a
   * command line near 32,767 characters, and an FR-M5 brief carries the task,
   * the objective and every upstream report — it grows with the team, so argv
   * would work in testing and fail on the run that matters. stdin has no such
   * limit and needs no shell quoting.
   */
  stdin: string;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedChild {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the exit code once the process and its streams are done. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything the child wrote to stderr, for error reporting. */
  stderr: Promise<string>;
}

export function spawnClaude(options: SpawnOptions): SpawnedChild {
  // A `.cmd`/`.bat` shim cannot be spawned directly on Windows — Node throws
  // synchronously rather than returning a child. `resolveSpawnTarget` reroutes
  // that one case through `cmd.exe` with its own quoting; everything else passes
  // through unchanged. See `windowsSpawn.ts` for why not `shell: true`.
  const target = resolveSpawnTarget(options.binary, options.args);

  const child = spawn(target.command, target.args, {
    cwd: options.cwd,
    ...(target.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: target.windowsVerbatimArguments }),
    // NFR-1: the child inherits our environment but is anchored to the run's
    // workspace as its working directory, so a relative path a tool writes
    // cannot land in the user's own repos.
    ...(options.env === undefined ? {} : { env: options.env }),
    windowsHide: true,
    // Group leadership on POSIX, so `killTree` can signal the whole group.
    // Meaningless on Windows, where `taskkill /T` does the walking instead.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Bounded: a broken CLI can write to stderr indefinitely, and this string is
    // only ever used to explain a failure. Keeping the tail matters more than
    // the head — the last thing written is usually the actual error.
    stderrText = (stderrText + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  const stderr = exit.then(() => stderrText, () => stderrText);

  // Writing the brief and closing stdin is what tells the CLI the turn is
  // complete; without the close it waits for more input and never starts.
  child.stdin.on('error', () => undefined); // EPIPE if the child died early.
  child.stdin.end(options.stdin, 'utf8');

  return { child, exit, stderr };
}

/** Keep the last 16 KB of stderr. Enough for a stack trace, bounded for a loop. */
const STDERR_TAIL_LIMIT = 16 * 1024;
