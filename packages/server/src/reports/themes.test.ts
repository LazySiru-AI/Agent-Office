import { describe, expect, it } from 'vitest';
import { REPORT_THEME_IDS, type ReportThemeId } from '@agent-office/shared';
import { REPORT_THEMES, getReportTheme, getReportThemeCss } from './themes.js';

/**
 * What is worth testing about a CSS string. We do not assert on exact colour
 * values or pixel measurements — that would just re-type the stylesheet in
 * the test file and break on every legitimate tweak. Instead we test the
 * things that are actually load-bearing for the requirements this module
 * exists to satisfy: FR-P3's offline guarantee, print correctness, the
 * markdown-module class contract, and "the four themes are genuinely
 * different" rather than one stylesheet recoloured four times.
 */

/** Counts unmatched `{`/`}` — catches template-string typos that would
 *  silently truncate or corrupt everything after them in the `<style>` tag. */
function hasBalancedBraces(css: string): boolean {
  let depth = 0;
  for (const char of css) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('REPORT_THEMES', () => {
  it('has a non-empty stylesheet for every REPORT_THEME_ID, with no gaps', () => {
    expect(Object.keys(REPORT_THEMES).sort()).toEqual([...REPORT_THEME_IDS].sort());
    for (const id of REPORT_THEME_IDS) {
      const theme = REPORT_THEMES[id];
      expect(theme).toBeDefined();
      expect(theme.css.trim().length).toBeGreaterThan(0);
    }
  });

  it('getReportTheme and getReportThemeCss agree with the REPORT_THEMES record', () => {
    for (const id of REPORT_THEME_IDS) {
      expect(getReportTheme(id)).toBe(REPORT_THEMES[id]);
      expect(getReportThemeCss(id)).toBe(REPORT_THEMES[id].css);
    }
  });

  describe.each(REPORT_THEME_IDS)('%s theme', (id: ReportThemeId) => {
    const theme = REPORT_THEMES[id];

    it('contains no external URL — the FR-P3 offline guarantee', () => {
      // Covers bare scheme references and any url(...) whose target is a
      // scheme rather than a local/data reference. A url(data:...) would be
      // fine (self-contained) but nothing in these stylesheets uses one, so
      // we simply forbid http(s) anywhere and forbid url(http...) directly.
      expect(theme.css).not.toMatch(/https?:\/\//i);
      expect(theme.css).not.toMatch(/url\(\s*['"]?https?:/i);
      expect(theme.css).not.toMatch(/@font-face/i);
    });

    it('declares @page (A4, with margins)', () => {
      expect(theme.css).toMatch(/@page\s*\{[^}]*size:\s*A4/i);
      expect(theme.css).toMatch(/@page\s*\{[^}]*margin:/i);
    });

    it('has balanced braces (a parse sanity check)', () => {
      expect(hasBalancedBraces(theme.css)).toBe(true);
    });

    it('styles the documented wrapper classes and the fallback elements', () => {
      // Wrapper classes (overflow safety net) — see the class-contract
      // comment at the top of themes.ts.
      expect(theme.css).toMatch(/\.ao-table-wrapper/);
      expect(theme.css).toMatch(/\.ao-code-wrapper/);
      // Fallback bare-element styling, so the theme still applies even if
      // the markdown module's wrapper names differ from what we assumed.
      expect(theme.css).toMatch(/(^|\s|,)table\s*\{/);
      expect(theme.css).toMatch(/(^|\s|,)pre[,\s{]/);
    });

    it('provides the FR-P4 cover/roster/appendix classes', () => {
      for (const selector of [
        '.cover',
        '.cover-title',
        '.cover-meta',
        '.roster-table',
        '.synthesis',
        '.appendix',
        '.appendix-header',
      ]) {
        expect(theme.css.includes(selector)).toBe(true);
      }
    });

    it('provides the .page-break utility', () => {
      expect(theme.css).toMatch(/\.page-break\s*\{/);
      expect(theme.css).toMatch(/\.page-break[^}]*break-after:\s*page/);
    });

    it('avoids stranding headings and honours orphans/widows', () => {
      expect(theme.css).toMatch(/h1,\s*h2,\s*h3[^{]*\{[^}]*break-after:\s*avoid/);
      expect(theme.css).toMatch(/orphans:\s*\d/);
      expect(theme.css).toMatch(/widows:\s*\d/);
    });

    it('exposes metadata consistent with the theme id', () => {
      expect(theme.id).toBe(id);
      expect(theme.displayName.length).toBeGreaterThan(0);
      expect(theme.accentColour).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      expect(theme.bodyFontStack.length).toBeGreaterThan(0);
    });
  });
});

describe('theme distinctness', () => {
  it('does not use the same body font stack for all four themes', () => {
    const stacks = new Set(REPORT_THEME_IDS.map((id) => REPORT_THEMES[id].bodyFontStack));
    // Four themes must not collapse to a single typeface choice. (They also
    // happen to be pairwise distinct here, but the requirement is just that
    // they are not all identical — a "four copies of one theme" smell test.)
    expect(stacks.size).toBeGreaterThan(1);
  });

  it('differs on more than one structural property between every pair of themes', () => {
    // A cheap structural fingerprint: for each theme, which of these
    // print-relevant properties/values show up in its stylesheet at all.
    // "Four copies of one theme with different accent colours" would fail
    // this because every fingerprint would be identical apart from colour,
    // which is not one of the probes below.
    const probes: Array<[string, RegExp]> = [
      ['sans body', /font-family:\s*'Segoe UI'|font-family:\s*Calibri/],
      ['serif body', /font-family:\s*Cambria|font-family:\s*'Palatino/],
      ['justified body text', /text-align:\s*justify/],
      ['paragraph indent', /text-indent:/],
      ['full table grid', /th,\s*td\s*\{\s*border:\s*1px solid/],
      ['table outer rule only', /border-top:\s*1\.5px solid[^;]*;\s*\n\s*border-bottom:\s*1\.5px solid/],
      ['no table border (rule-under-header only)', /th,\s*td\s*\{\s*padding:[^}]*border:\s*none/],
      ['numbered clauses', /counter-increment:\s*clause/],
      ['tabular numerals', /font-variant-numeric:\s*tabular-nums/],
      ['pull-quote blockquote', /blockquote\s*\{[^}]*font-style:\s*italic/],
      ['dense zebra table', /nth-child\(even\)/],
      ['uppercase heading', /text-transform:\s*uppercase/],
    ];

    const fingerprint = (id: ReportThemeId): boolean[] =>
      probes.map(([, re]) => re.test(REPORT_THEMES[id].css));

    const fingerprints = REPORT_THEME_IDS.map((id) => fingerprint(id));

    for (let i = 0; i < fingerprints.length; i += 1) {
      for (let j = i + 1; j < fingerprints.length; j += 1) {
        const a = fingerprints[i] as boolean[];
        const b = fingerprints[j] as boolean[];
        const differences = a.filter((value, index) => value !== b[index]).length;
        expect(differences).toBeGreaterThan(1);
      }
    }
  });

  it('uses a different accent colour per theme', () => {
    const colours = new Set(REPORT_THEME_IDS.map((id) => REPORT_THEMES[id].accentColour));
    expect(colours.size).toBe(REPORT_THEME_IDS.length);
  });
});
