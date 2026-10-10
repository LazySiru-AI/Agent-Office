import { watch as nodeWatch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadRegistry, type Registry } from './index.js';

/**
 * FR-R5: hot-reload the registry when a file under `categories/**` changes, so
 * editing an agent `.md` takes effect without restarting the server.
 *
 * This module is deliberately self-contained (no wiring into the HTTP server
 * lives here — that is the manager's job). It owns exactly one thing: keeping
 * `RegistryWatcher.current` equal to "the last registry that successfully
 * loaded", and telling callers, via events, when that changed or failed to.
 */

/** Directory under the repo root that is indexed and watched. Mirrors `index.ts`. */
const CATEGORIES_DIR = 'categories';

/**
 * Debounce window for coalescing filesystem events into a single re-index.
 *
 * An editor save is never exactly one fs event. Most editors write a
 * temp/swap file and rename it over the target (2+ events per save), and
 * format-on-save or a linter can produce a second write moments later. Without
 * debouncing, one keystroke-adjacent save could re-parse all 156 catalog files
 * two or three times.
 *
 * 300ms, chosen over two rejected alternatives:
 *  - ~50ms ("just long enough to coalesce a rename pair"): too tight. This
 *    package's own tests note that antivirus/indexer contention on this class
 *    of machine routinely adds tens of milliseconds to filesystem operations
 *    (see `index.test.ts`); a short window risks the debounce firing between
 *    the temp-write and the rename, so the reload reads a half-written file
 *    and reports a spurious parse error for a save that was actually fine.
 *  - ~2000ms ("be generous, re-indexing is cheap"): defeats the point of
 *    FR-R5. The whole feature exists so a developer can alt-tab back to a
 *    running server and see their edit already live; a two-second lag reads
 *    as broken and just trains people to restart manually anyway.
 * 300ms sits well above observed multi-event save bursts while still reading
 * as instantaneous to a human driving the loop by hand.
 */
const DEFAULT_DEBOUNCE_MS = 300;

/** Emitted through {@link WatchRegistryOptions.onEvent} and {@link RegistryWatcher.subscribe}. */
export type RegistryWatcherEvent =
  | { readonly type: 'reloaded'; readonly registry: Registry }
  | { readonly type: 'reload-error'; readonly error: unknown }
  | { readonly type: 'degraded'; readonly reason: string }
  | { readonly type: 'watch-error'; readonly error: unknown };

export interface WatchRegistryOptions {
  /** Debounce window in ms. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
  /**
   * Registered before any filesystem watcher is created, so it can never miss
   * an early `degraded` event fired during setup. A listener added later via
   * {@link RegistryWatcher.subscribe} only exists once `watchRegistry`'s
   * returned promise has already resolved — which is too late for that one
   * event, since platform support is detected during setup itself.
   */
  onEvent?: (event: RegistryWatcherEvent) => void;
  /**
   * Testing seam only. Substitutes for `node:fs`'s `watch`, so tests can force
   * the "recursive watch unsupported" branch (real on some Linux kernels)
   * deterministically instead of depending on which OS happens to run the
   * suite. Production callers should never set this.
   */
  watchFn?: typeof nodeWatch;
}

export interface RegistryWatcher {
  /**
   * The most recently *successfully* loaded registry. Never `undefined` and
   * never a partially-built registry: a re-index that throws leaves this
   * pointing at whatever it pointed at before (see module doc).
   */
  readonly current: Registry;
  /** Add a listener; call the returned function to remove it. */
  subscribe(listener: (event: RegistryWatcherEvent) => void): () => void;
  /**
   * Stops the underlying filesystem watch(es) and clears any pending debounce
   * timer. Idempotent-safe to call once; after it resolves, no further
   * reloads happen and `current` is frozen at its last value.
   */
  close(): Promise<void>;
}

/**
 * Start watching `<repoRoot>/categories/**` and keep an in-memory {@link Registry}
 * current as files change.
 *
 * The initial load is NOT protected the way later reloads are: if it throws,
 * this function's promise rejects, because there is no "last good" registry
 * yet to fall back to. Every reload *after* that first success is absorbed —
 * see `reload()` below, which is the one piece of behaviour in this file that
 * actually matters: a re-index failure must never propagate to a caller of
 * `.current`, and must never leave it pointing at nothing.
 */
export async function watchRegistry(
  repoRoot: string,
  options: WatchRegistryOptions = {},
): Promise<RegistryWatcher> {
  const root = path.resolve(repoRoot);
  const categoriesDir = path.join(root, CATEGORIES_DIR);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const watchImpl = options.watchFn ?? nodeWatch;

  const listeners = new Set<(event: RegistryWatcherEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);

  function emit(event: RegistryWatcherEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber's own bug is not this watcher's problem to propagate;
        // doing so could tear down a healthy watch loop over unrelated code.
      }
    }
  }

  const initial = await loadRegistry(root);

  const state: { current: Registry; closed: boolean } = { current: initial, closed: false };
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let primaryWatcher: FSWatcher | undefined;
  let fallbackWatchers: Map<string, FSWatcher> | undefined;

  /**
   * Re-index and, only on success, replace `state.current`.
   *
   * THIS is the load-bearing behaviour of the whole module: someone WILL save
   * a `.md` file mid-edit with broken YAML (that is what saving usually looks
   * like, one keystroke at a time), and `loadRegistry` is intentionally loud
   * about that (FR-R2, `RegistryLoadError`). Loud-at-load-time and
   * loud-at-*live-reload*-time are different requirements: a running server
   * must keep answering with the last catalog that actually parsed, not go
   * dark because someone is mid-sentence in a YAML string. So the failure is
   * caught here, reported through `emit`, and `state.current` is left
   * untouched.
   */
  async function reload(): Promise<void> {
    if (state.closed) return;
    if (fallbackWatchers) await syncFallbackWatchers(fallbackWatchers);
    if (state.closed) return;
    try {
      const next = await loadRegistry(root);
      if (state.closed) return;
      state.current = next;
      emit({ type: 'reloaded', registry: next });
    } catch (error) {
      if (!state.closed) emit({ type: 'reload-error', error });
    }
  }

  function scheduleReload(): void {
    if (state.closed) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      void reload();
    }, debounceMs);
  }

  /**
   * Fallback-mode only: keep one non-recursive watcher per directory under
   * `categoriesDir`, adding/removing watchers as directories are created or
   * removed. Re-walking the tree on every raw fs event would be wasteful, so
   * this only runs once per debounced reload (see `reload()`), which already
   * throttles it to at most once per ~`debounceMs`.
   */
  async function syncFallbackWatchers(current: Map<string, FSWatcher>): Promise<void> {
    let dirs: string[];
    try {
      dirs = await walkDirectories(categoriesDir);
    } catch {
      // Directory is transiently missing/mid-rename; keep existing watchers
      // rather than tearing everything down over what is likely a blip.
      return;
    }
    const wanted = new Set(dirs);

    for (const [dir, watcher] of current) {
      if (!wanted.has(dir)) {
        watcher.close();
        current.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (current.has(dir)) continue;
      try {
        const watcher = watchImpl(dir, { recursive: false }, () => scheduleReload());
        watcher.on('error', (error) => emit({ type: 'watch-error', error }));
        current.set(dir, watcher);
      } catch (error) {
        emit({ type: 'watch-error', error });
      }
    }
  }

  try {
    // Single recursive watcher: supported on Windows and macOS, and the only
    // sane option there (one OS-level handle instead of ~160, one for every
    // category directory and every agent's own directory).
    primaryWatcher = watchImpl(categoriesDir, { recursive: true }, () => scheduleReload());
    primaryWatcher.on('error', (error) => emit({ type: 'watch-error', error }));
  } catch (error) {
    // `{ recursive: true }` throws synchronously with
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM on Linux kernels lacking the
    // recursive-inotify support Node needs for it. Rather than let FR-R5
    // silently not exist there, or throw out of `watchRegistry` entirely
    // (which the spec explicitly rules out), degrade: watch every directory
    // individually and resync that set as directories come and go. Reported
    // via `emit`, never thrown — an unsupported OS feature is a degradation
    // of the live-reload experience, not a reason to refuse to serve.
    const reason = error instanceof Error ? error.message : String(error);
    emit({ type: 'degraded', reason });
    fallbackWatchers = new Map();
    await syncFallbackWatchers(fallbackWatchers);
  }

  return {
    get current() {
      return state.current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      state.closed = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
      }
      if (primaryWatcher) {
        primaryWatcher.close();
        primaryWatcher = undefined;
      }
      if (fallbackWatchers) {
        for (const watcher of fallbackWatchers.values()) watcher.close();
        fallbackWatchers.clear();
      }
    },
  };
}

/** `root` plus every directory beneath it, recursively. Used only by the fallback watcher. */
async function walkDirectories(root: string): Promise<string[]> {
  const dirs = [root];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(...(await walkDirectories(path.join(root, entry.name))));
    }
  }
  return dirs;
}
