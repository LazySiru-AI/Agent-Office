import { applyTheme, type ThemeMode } from './tokens.js';

/**
 * Paint the palette before React exists (FR-U1, FR-U7).
 *
 * `useTheme` owns the user's preference once the app is running, but a hook
 * cannot run before the first paint, and `styles.css` is written entirely
 * against `--ao-*` custom properties — so between `index.html` and React's first
 * commit there is a window in which every colour rule resolves to nothing. On a
 * near-black app that window is a white flash.
 *
 * This reads the same stored preference `useTheme` uses and applies it
 * synchronously at module scope. It deliberately duplicates no *logic* beyond
 * "read the key, resolve it": the hook remains the owner, and this is the
 * bootstrap that stops the screen flashing on the way to it.
 */

/** Must match the key `useTheme` persists to. */
const THEME_STORAGE_KEY = 'agent-office.theme';

function readStored(): string | undefined {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) ?? undefined;
  } catch {
    // Private browsing and disabled-storage modes throw on access rather than
    // returning null — the same guard `useRun.ts` uses for its own key.
    return undefined;
  }
}

function prefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

/**
 * Dark is the default when nothing is stored.
 *
 * This app's identity is the dark terminal; light is an option a user chooses
 * (FR-U7), not the state they land in because their OS said so. Only the
 * explicit `system` preference defers to `prefers-color-scheme`.
 */
export function resolveBootMode(stored: string | undefined, systemPrefersLight: boolean): ThemeMode {
  if (stored === 'light') return 'light';
  if (stored === 'dark') return 'dark';
  if (stored === 'system') return systemPrefersLight ? 'light' : 'dark';
  return 'dark';
}

export function applyBootTheme(): void {
  if (typeof document === 'undefined') return;
  applyTheme(resolveBootMode(readStored(), prefersLight()), document.documentElement);
}
