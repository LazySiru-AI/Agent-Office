import { describe, expect, it } from 'vitest';
import { resolveBootMode } from './boot.js';
import { THEMES, applyTheme, cssVariableName, toPixiColour } from './tokens.js';

/**
 * The bootstrap path (FR-U1) and the token plumbing (FR-U2).
 *
 * `resolveBootMode` runs before React and decides what the very first paint
 * looks like, so its defaults matter more than their size suggests: get them
 * wrong and every user lands in the wrong theme for one frame, or permanently
 * if the hook later agrees with the same wrong answer.
 */

describe('resolveBootMode', () => {
  it('defaults to dark when nothing is stored, whatever the OS prefers', () => {
    // The dark terminal is this app's identity (PLAN.md §2.6), not a response
    // to the operating system. Only an explicit `system` choice defers.
    expect(resolveBootMode(undefined, true)).toBe('dark');
    expect(resolveBootMode(undefined, false)).toBe('dark');
  });

  it('honours an explicit stored choice over the system preference', () => {
    expect(resolveBootMode('light', false)).toBe('light');
    expect(resolveBootMode('dark', true)).toBe('dark');
  });

  it('follows the system only when the user asked it to', () => {
    expect(resolveBootMode('system', true)).toBe('light');
    expect(resolveBootMode('system', false)).toBe('dark');
  });

  it('falls back to dark on a stored value it does not recognise', () => {
    // localStorage is user-writable and survives across versions, so a value
    // from a future or hand-edited build must not resolve to `undefined` and
    // leave the palette unset.
    expect(resolveBootMode('neon-deluxe', false)).toBe('dark');
    expect(resolveBootMode('', true)).toBe('dark');
  });
});

describe('token plumbing (FR-U2)', () => {
  it('names CSS variables predictably, including camelCase keys', () => {
    // The stylesheet is written against these names by hand, so the transform
    // is a contract: `surfaceRaised` must be `--ao-surface-raised` and nothing
    // else, or the rule silently resolves to nothing.
    expect(cssVariableName('bg')).toBe('--ao-bg');
    expect(cssVariableName('surfaceRaised')).toBe('--ao-surface-raised');
    expect(cssVariableName('statusActive')).toBe('--ao-status-active');
  });

  it('applies every token, so no rule can reference a variable that was never set', () => {
    const set: string[] = [];
    // A minimal stand-in: these tests run in Node, and the only behaviour worth
    // asserting is that every key is written.
    const fake = {
      style: { setProperty: (name: string, value: string) => set.push(`${name}=${value}`) },
      dataset: {} as Record<string, string>,
    } as unknown as HTMLElement;

    applyTheme('dark', fake);

    expect(set).toHaveLength(Object.keys(THEMES.dark).length);
    expect(set).toContain('--ao-bg=#0b0e12');
    expect(fake.dataset['aoTheme']).toBe('dark');
  });

  it('defines exactly the same token keys in both themes', () => {
    // A key present in dark but missing from light would leave a stale value
    // behind on switch, because `applyTheme` only ever sets properties.
    expect(Object.keys(THEMES.dark).sort()).toEqual(Object.keys(THEMES.light).sort());
  });

  it('converts token hex to the numeric form Pixi needs', () => {
    expect(toPixiColour('#2ee6d6')).toBe(0x2ee6d6);
    expect(toPixiColour('2ee6d6')).toBe(0x2ee6d6);
    expect(toPixiColour('#abc')).toBe(0xaabbcc);
  });

  it('returns a loud colour rather than black for a malformed token', () => {
    // Black would blend into the office and ship unnoticed.
    expect(toPixiColour('#zzzzzz')).toBe(0xff00ff);
  });
});
