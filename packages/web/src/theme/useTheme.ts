import { useCallback, useEffect, useState } from 'react';
import { applyTheme, type ThemeMode } from './tokens.js';

/**
 * Display preferences: theme mode (FR-U7) and motion (FR-U5).
 *
 * These are two independent user preferences that happen to live in one
 * hook because they are surfaced together in one control panel
 * (`DisplayControls.tsx`) and share the same persistence shape. Each is
 * otherwise self-contained: changing one never touches the other.
 *
 * ## Testability (a constraint, not an afterthought)
 *
 * Tests run under Node with no DOM and no `matchMedia` (see `useTheme.test.ts`).
 * So the actual decision-making — "given what's stored and what the system
 * prefers, what do we resolve to?" — is pulled out into plain, exported
 * functions (`resolveThemeMode`, `resolveMotion`) that take their inputs as
 * arguments rather than reading `window` themselves. The hook is a thin shell
 * around those functions: it is the only part that touches `localStorage`,
 * `matchMedia` or `document`, and every one of those touches is guarded so
 * merely *importing* this module can never throw outside a browser.
 */

// --------------------------------------------------------------------------
// Theme mode (FR-U7)
// --------------------------------------------------------------------------

/** What the user has picked. `'system'` means "follow the OS", not a fixed mode. */
export type ThemePreference = 'dark' | 'light' | 'system';

const THEME_STORAGE_KEY = 'agent-office.theme';
const MOTION_STORAGE_KEY = 'agent-office.motion';

/**
 * Dark is this app's designed identity (see `tokens.ts`), so it — not the
 * OS's own preference — is what a first-time visitor with nothing stored
 * gets. `'system'` is a mode the user opts into, never the implicit default.
 */
const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

const THEME_PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];

function isThemePreference(value: string): value is ThemePreference {
  return (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Stored preference + system preference → the concrete `ThemeMode` to paint.
 *
 * Pure and side-effect free, so it is exercised directly in tests without a
 * DOM. `stored` is whatever `localStorage` handed back (or `undefined`/some
 * garbage string, both of which fall back to the default rather than being
 * trusted — a corrupted or hand-edited value must not wedge the app in an
 * unreadable state).
 */
export function resolveThemeMode(stored: string | undefined, systemPrefersDark: boolean): ThemeMode {
  const preference = stored !== undefined && isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE;
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

// --------------------------------------------------------------------------
// Motion (FR-U5)
// --------------------------------------------------------------------------

/** What the user has picked: follow the system, or force motion off. There is
 * no "force on" — this is a reduced-motion accommodation, not a novelty toggle. */
export type MotionPreference = 'auto' | 'off';

/** The concrete on/off strings written to `data-ao-motion`, per the contract
 * with the CSS and canvas agents. Not a boolean, because the DOM attribute
 * value itself is the contract — spelling it as a union of these two exact
 * strings keeps that visible in the type. */
export type ResolvedMotion = 'on' | 'off';

const DEFAULT_MOTION_PREFERENCE: MotionPreference = 'auto';

const MOTION_PREFERENCES: readonly MotionPreference[] = ['auto', 'off'];

function isMotionPreference(value: string): value is MotionPreference {
  return (MOTION_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Stored preference + system's reduced-motion preference → 'on' | 'off'.
 *
 * `'off'` always wins, even when the system reports no preference at all —
 * it is an explicit user override, not a second vote alongside the OS.
 */
export function resolveMotion(stored: string | undefined, systemPrefersReducedMotion: boolean): ResolvedMotion {
  const preference = stored !== undefined && isMotionPreference(stored) ? stored : DEFAULT_MOTION_PREFERENCE;
  if (preference === 'off') return 'off';
  return systemPrefersReducedMotion ? 'off' : 'on';
}

// --------------------------------------------------------------------------
// Browser-facing helpers — every one guarded so import-time and call-time
// never throw outside a browser (Node tests, SSR, private-browsing storage).
// --------------------------------------------------------------------------

// Exported (not just internal) so the "localStorage throws" scenario can be
// exercised directly in `useTheme.test.ts`, which runs in Node with no DOM —
// stubbing a global `window` there and calling this is far more direct than
// rendering the hook.
export function readStorage(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined; // localStorage can throw in private-browsing / disabled-storage modes
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // best-effort persistence only
  }
}

/** `false` (rather than throwing) when `matchMedia` isn't available at all. */
function systemPrefersDarkNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function systemPrefersReducedMotionNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Subscribes to a media query's changes; returns a no-op unsubscribe when
 * `matchMedia` isn't available, so callers never need to branch on that. */
function watchMediaQuery(query: string, onChange: (matches: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(query);
  } catch {
    return () => undefined;
  }
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches);
  // addEventListener is the modern API; addListener is the Safari <14 fallback.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }
  mql.addListener(listener);
  return () => mql.removeListener(listener);
}

export interface UseThemeResult {
  /** What the user picked: 'dark' | 'light' | 'system'. */
  themePreference: ThemePreference;
  /** What's actually painted right now — 'system' resolved against the OS. */
  resolvedTheme: ThemeMode;
  setThemePreference: (preference: ThemePreference) => void;

  /** What the user picked: 'auto' | 'off'. */
  motionPreference: MotionPreference;
  /** What's actually in effect right now — 'on' | 'off'. */
  resolvedMotion: ResolvedMotion;
  setMotionPreference: (preference: MotionPreference) => void;
}

/**
 * Owns theme mode (FR-U7) and motion (FR-U5): reads the stored preference,
 * resolves it against the live system preference, applies it to the
 * document, and keeps re-resolving if the OS-level preference changes while
 * the app is open.
 */
export function useTheme(): UseThemeResult {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(() => {
    const stored = readStorage(THEME_STORAGE_KEY);
    return stored !== undefined && isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE;
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(systemPrefersDarkNow);

  const [motionPreference, setMotionPreferenceState] = useState<MotionPreference>(() => {
    const stored = readStorage(MOTION_STORAGE_KEY);
    return stored !== undefined && isMotionPreference(stored) ? stored : DEFAULT_MOTION_PREFERENCE;
  });
  const [systemPrefersReducedMotion, setSystemPrefersReducedMotion] = useState<boolean>(
    systemPrefersReducedMotionNow,
  );

  // React to the OS-level preference changing while the app stays open
  // (e.g. the user flips their system to dark mode, or their laptop's power
  // saver kicks on reduced-motion) — not just at mount.
  useEffect(() => watchMediaQuery('(prefers-color-scheme: dark)', setSystemPrefersDark), []);
  useEffect(
    () => watchMediaQuery('(prefers-reduced-motion: reduce)', setSystemPrefersReducedMotion),
    [],
  );

  const resolvedTheme = resolveThemeMode(themePreference, systemPrefersDark);
  const resolvedMotion = resolveMotion(motionPreference, systemPrefersReducedMotion);

  // Apply as a side effect (rather than inline during render) so the DOM
  // write happens exactly once per resolved value, matching how the rest of
  // this codebase (`useRun.ts`) keeps persistence/DOM effects out of render.
  useEffect(() => {
    applyTheme(resolvedTheme, document.documentElement);
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.dataset['aoMotion'] = resolvedMotion;
  }, [resolvedMotion]);

  const setThemePreference = useCallback((preference: ThemePreference) => {
    setThemePreferenceState(preference);
    writeStorage(THEME_STORAGE_KEY, preference);
  }, []);

  const setMotionPreference = useCallback((preference: MotionPreference) => {
    setMotionPreferenceState(preference);
    writeStorage(MOTION_STORAGE_KEY, preference);
  }, []);

  return {
    themePreference,
    resolvedTheme,
    setThemePreference,
    motionPreference,
    resolvedMotion,
    setMotionPreference,
  };
}
