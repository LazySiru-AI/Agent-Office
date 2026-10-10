import { afterEach, describe, expect, it } from 'vitest';
import { readStorage, resolveMotion, resolveThemeMode, writeStorage } from './useTheme.js';

/**
 * `resolveThemeMode` (FR-U7) and `resolveMotion` (FR-U5) are the decision
 * logic this hook is built from, and are exercised here as plain functions —
 * no React render, no DOM, per the task constraints. `readStorage`/
 * `writeStorage` are exported for the same reason: they are the only bits
 * that touch `window.localStorage`, and this file's Node environment has no
 * `window` at all, so the "storage throws" case is tested by stubbing one in.
 */

describe('resolveThemeMode (FR-U7)', () => {
  it('defaults to dark when nothing is stored — the app identity, not the OS preference', () => {
    expect(resolveThemeMode(undefined, false)).toBe('dark');
    expect(resolveThemeMode(undefined, true)).toBe('dark');
  });

  it('a stored explicit mode wins over the system preference', () => {
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
  });

  it("'system' resolves via the supplied system preference, both ways", () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
  });

  it('an unrecognised stored value falls back to the default rather than being trusted', () => {
    expect(resolveThemeMode('sepia', true)).toBe('dark');
    expect(resolveThemeMode('', false)).toBe('dark');
  });
});

describe('resolveMotion (FR-U5)', () => {
  it("'auto' follows the system's reduced-motion preference", () => {
    expect(resolveMotion('auto', true)).toBe('off');
    expect(resolveMotion('auto', false)).toBe('on');
  });

  it("'off' overrides the system even when it reports no preference", () => {
    expect(resolveMotion('off', false)).toBe('off');
    expect(resolveMotion('off', true)).toBe('off');
  });

  it('an unrecognised stored value falls back to the default (auto) behaviour', () => {
    expect(resolveMotion('turbo', true)).toBe('off');
    expect(resolveMotion('turbo', false)).toBe('on');
  });

  it('nothing stored defaults to auto', () => {
    expect(resolveMotion(undefined, true)).toBe('off');
    expect(resolveMotion(undefined, false)).toBe('on');
  });

  it('the resolved value is always exactly the string on or off', () => {
    expect(['on', 'off']).toContain(resolveMotion('auto', true));
    expect(['on', 'off']).toContain(resolveMotion('auto', false));
    expect(['on', 'off']).toContain(resolveMotion('off', false));
  });
});

describe('storage helpers guard against a throwing localStorage', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('readStorage returns undefined instead of throwing when localStorage.getItem throws', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('storage disabled (private browsing)');
        },
      },
    };

    expect(() => readStorage('agent-office.theme')).not.toThrow();
    expect(readStorage('agent-office.theme')).toBeUndefined();
  });

  it('writeStorage swallows errors instead of throwing when localStorage.setItem throws', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        setItem: () => {
          throw new Error('storage disabled (private browsing)');
        },
      },
    };

    expect(() => writeStorage('agent-office.theme', 'light')).not.toThrow();
  });

  it('readStorage returns undefined instead of throwing when window is entirely absent', () => {
    delete (globalThis as { window?: unknown }).window;

    expect(() => readStorage('agent-office.theme')).not.toThrow();
    expect(readStorage('agent-office.theme')).toBeUndefined();
  });

  it('resolution still produces the documented default when storage is unusable', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    };

    const stored = readStorage('agent-office.theme');
    expect(resolveThemeMode(stored, true)).toBe('dark');
  });
});
