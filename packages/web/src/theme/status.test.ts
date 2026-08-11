import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_STATUSES,
  RUN_STATUSES,
  type AssignmentStatus,
  type RunStatus,
} from '@agent-office/shared';
import { THEMES, type ThemeMode, type ThemeTokens } from './tokens.js';
import {
  contrastRatio,
  meetsAANormalText,
  parseHexColour,
  relativeLuminance,
  STATUS_GLYPH,
  STATUS_TOKEN,
  statusGlyph,
  statusToken,
  statusToneClass,
  WCAG_AA_NORMAL_TEXT,
  type StatusToken,
} from './status.js';

/**
 * This file is an audit, not a restatement of `status.ts`.
 *
 * Its job is to catch two different failure modes that a "does the map have
 * the keys I expect" test would miss:
 *
 *  1. A future status added to `@agent-office/shared` with no colour at all
 *     (tested by iterating the *real* unions, not a copy of them).
 *  2. A colour that exists but is not actually legible — a badge nobody can
 *     read is exactly as broken as one with no colour (FR-U4). That is what
 *     the WCAG contrast section below is for.
 *
 * Per the brief: if a token fails AA here, the fix is to the palette in
 * `tokens.ts` (owned by another agent, not edited from this file), not to
 * lower the threshold in this test. Failures are reported in the final
 * message with their exact measured ratio.
 */

const THEME_MODES: ThemeMode[] = ['dark', 'light'];
const ALL_STATUS_TOKENS = Object.keys(THEMES.dark).filter((k): k is StatusToken =>
  k.startsWith('status'),
) as StatusToken[];

describe('STATUS_TOKEN totality (FR-U4)', () => {
  // Iterating the real exported unions, not a local copy of the status list,
  // is the entire point: paste a new entry into RUN_STATUSES in
  // packages/shared/src/status.ts and this loop starts exercising it
  // automatically, with no edit needed here.
  it('maps every RunStatus to a real ThemeTokens key', () => {
    for (const status of RUN_STATUSES as readonly RunStatus[]) {
      const token = statusToken(status);
      expect(token, `RunStatus ${status} has no mapping`).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(THEMES.dark, token)).toBe(true);
    }
  });

  it('maps every AssignmentStatus to a real ThemeTokens key', () => {
    for (const status of ASSIGNMENT_STATUSES as readonly AssignmentStatus[]) {
      const token = statusToken(status);
      expect(token, `AssignmentStatus ${status} has no mapping`).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(THEMES.dark, token)).toBe(true);
    }
  });

  it('matches the fixed table in the task brief exactly', () => {
    const expected: Record<string, StatusToken> = {
      queued: 'statusIdle',
      pending: 'statusIdle',
      planning: 'statusPlanning',
      briefing: 'statusPlanning',
      dispatching: 'statusWaiting',
      blocked: 'statusWaiting',
      running: 'statusActive',
      working: 'statusActive',
      synthesizing: 'statusFinishing',
      designing: 'statusFinishing',
      reporting: 'statusFinishing',
      report_ready: 'statusGood',
      done: 'statusGood',
      failed: 'statusBad',
      cancelled: 'statusStopped',
      skipped: 'statusStopped',
    };
    for (const [status, token] of Object.entries(expected)) {
      expect(statusToken(status as RunStatus | AssignmentStatus)).toBe(token);
    }
  });
});

describe('contrastRatio / relativeLuminance implementation (sanity check)', () => {
  // If this section is wrong, every assertion below it is meaningless — a
  // broken contrast function could report a 2:1 pair as AA-compliant and
  // nothing else in this file would catch it. So it is checked against
  // values WCAG itself publishes / that are independently verifiable.
  it('rates pure black on pure white as the maximum, 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is symmetric: argument order does not change the ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#000000'),
      6,
    );
  });

  it('rates identical colours as 1:1 (no contrast)', () => {
    expect(contrastRatio('#2ee6d6', '#2ee6d6')).toBeCloseTo(1, 6);
  });

  it('places WCAG\'s own #767676-on-white example at ~4.5:1', () => {
    // #767676 on white is the textbook "just barely passes AA normal text"
    // grey, used throughout WCAG's own documentation and by contrast
    // checkers as a reference point.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#767676', '#ffffff')).toBeLessThan(4.6);
  });

  it('relativeLuminance(#000000) is 0 and relativeLuminance(#ffffff) is 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
  });

  it('accepts 3-digit hex as shorthand for 6-digit', () => {
    expect(parseHexColour('#fff')).toEqual(parseHexColour('#ffffff'));
    expect(parseHexColour('0b0')).toEqual(parseHexColour('#00bb00'));
  });

  it('rejects malformed hex rather than silently returning a colour', () => {
    expect(() => parseHexColour('not-a-colour')).toThrow();
  });
});

describe('every text colour on every ground, both themes (WCAG AA — 4.5:1)', () => {
  // Badges are small text (a status word + a glyph in a compact pill), which
  // is well under the "large text" cutoff (~18pt, or ~14pt bold) WCAG uses to
  // grant a lower 3:1 bar. Grading badge text against 3:1 would be grading it
  // on the wrong scale, so every check here uses the stricter 4.5:1.
  //
  // The grid is deliberately exhaustive rather than "each colour against the
  // page background". `styles.css` puts panels on `surfaceRaised` and status
  // chips on `sunken`, so `bg` is *not* the hardest ground these colours land
  // on — in dark the worst case is `surfaceRaised` (the lightest ground) and
  // in light it is `sunken` (the darkest). An audit against `bg` alone passes
  // colours that are illegible in the very component they were drawn for,
  // which is how this palette shipped four sub-AA pairs on its first pass.
  // Enumerating the whole product costs nothing and cannot be fooled by a
  // stylesheet moving a badge from one surface to another.
  const GROUND_KEYS: (keyof ThemeTokens)[] = ['bg', 'surface', 'surfaceRaised', 'sunken'];

  // Anything that can carry text. `accent` is here because it is used for
  // links and the live-run label, not only for rules and glows.
  const TEXT_KEYS: (keyof ThemeTokens)[] = [
    'ink',
    'inkSoft',
    'inkMute',
    'accent',
    ...ALL_STATUS_TOKENS,
  ];

  for (const mode of THEME_MODES) {
    for (const textKey of TEXT_KEYS) {
      for (const groundKey of GROUND_KEYS) {
        it(`${mode}.${textKey} on ${mode}.${groundKey} meets ${WCAG_AA_NORMAL_TEXT}:1`, () => {
          const tokens = THEMES[mode];
          const ratio = contrastRatio(tokens[textKey], tokens[groundKey]);
          expect(
            meetsAANormalText(ratio),
            `${mode}.${textKey} (${tokens[textKey]}) on ${mode}.${groundKey} (${tokens[groundKey]}) measured ${ratio.toFixed(2)}:1, needs ${WCAG_AA_NORMAL_TEXT}:1`,
          ).toBe(true);
        });
      }
    }
  }
});

describe('the tokens exempt from the text grid are exempt for a stated reason', () => {
  // `accentDim`, `line` and `lineFirm` are absent from TEXT_KEYS above, and
  // that absence is a claim: they are never load-bearing text. WCAG 1.4.3
  // exempts pure decoration, and these are borders, focus rings and the `// `
  // sigil `styles.css` prefixes onto headings — removing them loses ornament,
  // not information. This test pins the claim so it cannot rot silently: if
  // one of them is ever promoted to real text, the honest fix is to move it
  // into TEXT_KEYS and retune it, not to quietly leave it unaudited.
  const DECORATIVE_KEYS: (keyof ThemeTokens)[] = ['accentDim', 'line', 'lineFirm'];

  for (const mode of THEME_MODES) {
    for (const key of DECORATIVE_KEYS) {
      it(`${mode}.${key} is still a real, distinct colour`, () => {
        const tokens = THEMES[mode];
        expect(() => parseHexColour(tokens[key])).not.toThrow();
        // A decorative token that has drifted to the same value as its ground
        // is invisible — exempt from the contrast bar is not exempt from
        // existing at all.
        expect(contrastRatio(tokens[key], tokens.surface)).toBeGreaterThan(1.1);
      });
    }
  }
});

describe('status colours are mutually distinguishable', () => {
  // Non-colour carriers (glyphs) exist precisely because colour alone must
  // not be the only signal — but colour still has to do *some* work, and two
  // different status groups sharing a literal colour value would mean the
  // office is silently rendering two different meanings identically for
  // anyone who *can* see colour.
  for (const mode of THEME_MODES) {
    it(`no two distinct status tokens share a colour value in ${mode}`, () => {
      const tokens = THEMES[mode];
      const seen = new Map<string, StatusToken>();
      for (const token of ALL_STATUS_TOKENS) {
        const value = tokens[token];
        const clash = seen.get(value);
        expect(clash, `${token} and ${clash} both resolve to ${value} in ${mode}`).toBeUndefined();
        seen.set(value, token);
      }
    });
  }
});

describe('non-colour carriers (glyphs, FR-U4)', () => {
  it('every status token has a non-empty glyph', () => {
    for (const token of ALL_STATUS_TOKENS) {
      const glyph = STATUS_GLYPH[token];
      expect(glyph.length, `${token} has an empty glyph`).toBeGreaterThan(0);
    }
  });

  it('glyphs are unique per status group', () => {
    const seen = new Map<string, StatusToken>();
    for (const token of ALL_STATUS_TOKENS) {
      const glyph = STATUS_GLYPH[token];
      const clash = seen.get(glyph);
      expect(clash, `${token} and ${clash} share glyph ${JSON.stringify(glyph)}`).toBeUndefined();
      seen.set(glyph, token);
    }
  });

  it('statusGlyph() composes the status → token → glyph chain for every real status', () => {
    for (const status of RUN_STATUSES as readonly RunStatus[]) {
      expect(statusGlyph(status)).toBe(STATUS_GLYPH[statusToken(status)]);
    }
    for (const status of ASSIGNMENT_STATUSES as readonly AssignmentStatus[]) {
      expect(statusGlyph(status)).toBe(STATUS_GLYPH[statusToken(status)]);
    }
  });
});

describe('tone classes match the stylesheet (FR-U2)', () => {
  // `statusToneClass` produces a string that only means something if
  // `styles.css` defines a matching rule. That is a contract across two
  // languages, and it is the exact shape of gap that has bitten this project
  // before (a component and a stylesheet each confidently using a slightly
  // different class name). So the stylesheet is read off disk and checked,
  // rather than trusted.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  for (const token of ALL_STATUS_TOKENS) {
    it(`styles.css defines a rule for ${token}'s tone class`, () => {
      const toneClass = `status-tone-${token.replace(/^status/, '').toLowerCase()}`;
      expect(css, `styles.css has no .${toneClass} rule`).toContain(`.${toneClass}`);
    });
  }

  it('every status resolves to one of those eight tone classes', () => {
    const valid = new Set(
      ALL_STATUS_TOKENS.map((t) => `status-tone-${t.replace(/^status/, '').toLowerCase()}`),
    );
    for (const status of [...RUN_STATUSES, ...ASSIGNMENT_STATUSES]) {
      expect(valid.has(statusToneClass(status)), `${status} → ${statusToneClass(status)}`).toBe(
        true,
      );
    }
  });

  it('no per-status rules are left in the stylesheet', () => {
    // The point of the tone indirection is that the stylesheet stops knowing
    // the status vocabulary. If a `.status-<status>` rule creeps back in, the
    // two sources of truth are back and this test is the only thing that
    // would notice.
    for (const status of [...RUN_STATUSES, ...ASSIGNMENT_STATUSES]) {
      expect(css, `styles.css still has a per-status rule for ${status}`).not.toContain(
        `.status-${status}`,
      );
    }
  });
});

describe('STATUS_TOKEN keys cover exactly the two shared unions', () => {
  // Belt-and-braces on top of the per-status compile-time totality: confirms
  // at runtime too that the object literal's key set is exactly
  // RUN_STATUSES ∪ ASSIGNMENT_STATUSES, no more and no fewer.
  it('has no keys outside the shared status unions', () => {
    const validKeys = new Set<string>([...RUN_STATUSES, ...ASSIGNMENT_STATUSES]);
    for (const key of Object.keys(STATUS_TOKEN)) {
      expect(validKeys.has(key), `STATUS_TOKEN has an unexpected key: ${key}`).toBe(true);
    }
  });

  it('has every RunStatus and every AssignmentStatus as a key', () => {
    const actualKeys = new Set(Object.keys(STATUS_TOKEN));
    for (const status of RUN_STATUSES) {
      expect(actualKeys.has(status), `STATUS_TOKEN is missing RunStatus ${status}`).toBe(true);
    }
    for (const status of ASSIGNMENT_STATUSES) {
      expect(actualKeys.has(status), `STATUS_TOKEN is missing AssignmentStatus ${status}`).toBe(
        true,
      );
    }
  });
});
