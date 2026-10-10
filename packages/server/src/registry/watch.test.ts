import { watch as nodeWatch, type FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../http/fixtures.js';
import { type RegistryWatcher, type RegistryWatcherEvent, watchRegistry } from './watch.js';

/**
 * Real temp directories and a real `fs.watch`, not a mocked filesystem.
 *
 * FR-R5 is entirely about what a real OS-level watch reports, in what order,
 * and with what coalescing — behaviour a mock would just assert we called
 * the functions we already know we call. Same rationale as
 * `store/fileStore.test.ts`.
 */

// This package's own tests observe contention (antivirus/indexer) adding tens
// of milliseconds to real filesystem operations (see `index.test.ts`). A
// short debounce keeps these tests fast without being so short that a save
// gets split across the coalescing window on a busy machine.
const TEST_DEBOUNCE_MS = 30;

let tmpRoot: string;
const openWatchers: RegistryWatcher[] = [];

function agentFile(name: string, description: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, 'tools: Read, Grep', '---', '', `You are ${name}.`, ''].join(
    '\r\n',
  );
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-watch-'));
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }
  return root;
}

/** Tracks every watcher started in a test so `afterEach` never leaks a live fs.watch handle. */
async function startWatcher(
  root: string,
  options: Parameters<typeof watchRegistry>[1] = {},
): Promise<RegistryWatcher> {
  const watcher = await watchRegistry(root, { debounceMs: TEST_DEBOUNCE_MS, ...options });
  openWatchers.push(watcher);
  return watcher;
}

afterEach(async () => {
  await Promise.all(openWatchers.splice(0).map((watcher) => watcher.close()));
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Wraps the real `node:fs` `watch` and throws the same error Node throws on
 * Linux kernels without recursive-inotify support, but only for
 * `{ recursive: true }` calls. Non-recursive calls are forwarded to the real
 * implementation, so the fallback path under test is exercised against a
 * genuine OS watcher rather than a fake one -- only platform *detection* is
 * simulated, not the watching itself.
 */
function unsupportedRecursiveWatchFn(): typeof nodeWatch {
  // `typeof nodeWatch` is a four-overload type; a literal replacement can't be
  // typechecked against all of them at once. The untyped-call escape hatch is
  // deliberate and confined to this test double -- it exists purely to
  // delegate to the real implementation once the (fake) platform check passes.
  const realWatch = nodeWatch as (target: unknown, watchOptions: unknown, listener: unknown) => FSWatcher;
  const impl = (target: unknown, watchOptions: unknown, listener: unknown): FSWatcher => {
    const opts = watchOptions as { recursive?: boolean } | undefined;
    if (opts?.recursive) {
      const error = new Error(
        'The "recursive" option is not supported on this platform (simulated for tests)',
      ) as NodeJS.ErrnoException;
      error.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
      throw error;
    }
    return realWatch(target, watchOptions, listener);
  };
  return impl as unknown as typeof nodeWatch;
}

describe('watchRegistry: live edits (a)', () => {
  it('reflects an edited agent file in `current` without a restart', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Version 1.'),
    });

    const watcher = await startWatcher(tmpRoot);
    expect(watcher.current.get('alpha')?.description).toBe('Version 1.');

    await writeFile(
      path.join(tmpRoot, 'categories/01-core/alpha.md'),
      agentFile('alpha', 'Version 2.'),
      'utf8',
    );

    await waitFor(
      () => watcher.current.get('alpha')?.description === 'Version 2.',
      'the watcher to pick up the edited description',
    );
  });

  it('picks up a brand-new agent file added after the watch starts', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'First.'),
    });

    const watcher = await startWatcher(tmpRoot);
    expect(watcher.current.agents).toHaveLength(1);

    await writeFile(
      path.join(tmpRoot, 'categories/01-core/beta.md'),
      agentFile('beta', 'Second.'),
      'utf8',
    );

    await waitFor(() => watcher.current.get('beta') !== undefined, 'the new agent to appear');
    expect(watcher.current.agents).toHaveLength(2);
  });
});

describe('watchRegistry: a bad reload cannot poison the registry (b)', () => {
  it('keeps serving the last good registry and reports the error when a re-index fails', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Good version.'),
    });

    const events: RegistryWatcherEvent[] = [];
    const watcher = await startWatcher(tmpRoot, { onEvent: (event) => events.push(event) });
    const goodRegistry = watcher.current;
    expect(goodRegistry.get('alpha')?.description).toBe('Good version.');

    // Half-written save: no closing frontmatter delimiter. This is exactly
    // what a file looks like mid-keystroke while someone is editing it.
    await writeFile(
      path.join(tmpRoot, 'categories/01-core/alpha.md'),
      '---\r\nname: alpha\r\ndescription: mid-edit,\r\n',
      'utf8',
    );

    await waitFor(
      () => events.some((event) => event.type === 'reload-error'),
      'a reload-error event to be reported',
    );

    // The registry object itself is unchanged -- not just equal-looking data,
    // the exact same last-good instance -- and still answers queries.
    expect(watcher.current).toBe(goodRegistry);
    expect(watcher.current.get('alpha')?.description).toBe('Good version.');
    expect(events.some((event) => event.type === 'reloaded')).toBe(false);
  });

  it('recovers on the next good save after a failed one', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Good version.'),
    });

    const events: RegistryWatcherEvent[] = [];
    const watcher = await startWatcher(tmpRoot, { onEvent: (event) => events.push(event) });

    await writeFile(
      path.join(tmpRoot, 'categories/01-core/alpha.md'),
      'not frontmatter at all\r\n',
      'utf8',
    );
    // Wait for the failed reload to actually land before fixing the file, so
    // this test exercises "recovers after a real failure" rather than the
    // debounce simply coalescing both writes into one successful reload.
    await waitFor(
      () => events.some((event) => event.type === 'reload-error'),
      'the failed reload to be observed before fixing the file',
    );

    await writeFile(
      path.join(tmpRoot, 'categories/01-core/alpha.md'),
      agentFile('alpha', 'Fixed version.'),
      'utf8',
    );

    await waitFor(
      () => watcher.current.get('alpha')?.description === 'Fixed version.',
      'the watcher to recover once the file is fixed',
    );
  });
});

describe('watchRegistry: close() (c)', () => {
  it('stops further reloads once closed', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Version 1.'),
    });

    const watcher = await watchRegistry(tmpRoot, { debounceMs: TEST_DEBOUNCE_MS });
    const registryAtClose = watcher.current;
    await watcher.close();

    await writeFile(
      path.join(tmpRoot, 'categories/01-core/alpha.md'),
      agentFile('alpha', 'Version 2.'),
      'utf8',
    );

    // No fixed sleep to "prove a negative" quickly here would be racy in the
    // other direction; instead wait long enough that, were the watcher still
    // live, the debounced reload would certainly have landed by now.
    await new Promise((resolve) => setTimeout(resolve, TEST_DEBOUNCE_MS * 5));
    expect(watcher.current).toBe(registryAtClose);
    expect(watcher.current.get('alpha')?.description).toBe('Version 1.');
  });

  it('does not leak a filesystem watcher handle (this test would hang vitest otherwise)', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Version 1.'),
    });

    const watcher = await watchRegistry(tmpRoot, { debounceMs: TEST_DEBOUNCE_MS });
    await watcher.close();
    // Reaching this line at all is the assertion: a real leaked fs.watch
    // handle (or an uncleared timer) keeps the event loop alive and the
    // process/vitest worker would hang past the test's own completion.
    expect(true).toBe(true);
  });
});

describe('watchRegistry: subscribe()', () => {
  it('stops delivering events to an unsubscribed listener', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Version 1.'),
    });

    const watcher = await startWatcher(tmpRoot);
    const events: RegistryWatcherEvent[] = [];
    const unsubscribe = watcher.subscribe((event) => events.push(event));
    unsubscribe();

    await writeFile(
      path.join(tmpRoot, 'categories/01-core/alpha.md'),
      agentFile('alpha', 'Version 2.'),
      'utf8',
    );
    await waitFor(
      () => watcher.current.get('alpha')?.description === 'Version 2.',
      'the reload to happen even though the listener unsubscribed',
    );

    expect(events).toHaveLength(0);
  });
});

describe('watchRegistry: recursive watch unsupported (Windows/macOS vs. Linux)', () => {
  it('degrades to per-directory watching and keeps reloading on edits', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Version 1.'),
    });

    const events: RegistryWatcherEvent[] = [];
    const watcher = await startWatcher(tmpRoot, {
      onEvent: (event) => events.push(event),
      watchFn: unsupportedRecursiveWatchFn(),
    });

    expect(events.some((event) => event.type === 'degraded')).toBe(true);

    await writeFile(
      path.join(tmpRoot, 'categories/01-core/alpha.md'),
      agentFile('alpha', 'Version 2.'),
      'utf8',
    );
    await waitFor(
      () => watcher.current.get('alpha')?.description === 'Version 2.',
      'the fallback per-directory watcher to pick up the edit',
    );
  });

  it('picks up a new subdirectory created after the watch starts (fallback resync)', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/alpha.md': agentFile('alpha', 'Only agent.'),
    });

    const watcher = await startWatcher(tmpRoot, {
      watchFn: unsupportedRecursiveWatchFn(),
    });
    expect(watcher.current.agents).toHaveLength(1);

    await mkdir(path.join(tmpRoot, 'categories/02-new'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'categories/02-new/beta.md'),
      agentFile('beta', 'New category agent.'),
      'utf8',
    );

    // The new directory itself has to be noticed (via a resync triggered by
    // the parent directory's watcher seeing the `mkdir`), then the file
    // inside it. Poll for the end state rather than assuming one resync pass
    // is enough.
    await waitFor(
      () => watcher.current.get('beta') !== undefined,
      'the fallback watcher to notice the new subdirectory and its agent',
      5_000,
    );
  });
});

describe('watchRegistry: initial load failure', () => {
  it('rejects instead of returning a watcher with nothing to serve', async () => {
    tmpRoot = await makeRepo({
      'categories/01-core/broken.md': 'no frontmatter here\r\n',
    });

    await expect(watchRegistry(tmpRoot, { debounceMs: TEST_DEBOUNCE_MS })).rejects.toThrow();
  });
});
