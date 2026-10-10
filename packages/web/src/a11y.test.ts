import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A2 and A5's markup is static — there is no conditional decision to pull out
 * into a pure function the way A3's live-region text or A1's URL-building
 * had one (see `theme/status.test.ts`'s `runStatusAnnouncement` tests and
 * `api.test.ts`'s `appendToken` tests for those). A skip link and a table
 * caption are either present in the JSX or they are not, unconditionally, so
 * the only honest thing a no-DOM suite can check is that the source actually
 * contains them — the same approach `styles.test.ts` already takes for
 * FR-U6's "no `@font-face` rule" claim, reading the real file off disk rather
 * than rendering anything.
 *
 * This is a narrower guarantee than a render-based test would give (it
 * cannot prove the skip link is the FIRST focusable element on the page, or
 * that focus actually lands on `<main>` when it's activated — see this
 * file's own tests below for exactly which claims are and are not covered,
 * and the PR report for what remains browser-verified-only) but it is a
 * real one: it fails if the markup or the CSS it depends on is ever deleted,
 * which is the regression most likely to slip through code review unnoticed.
 */

const APP_TSX_PATH = fileURLToPath(new URL('./App.tsx', import.meta.url));
const STYLES_CSS_PATH = fileURLToPath(new URL('./styles.css', import.meta.url));
const ASSIGNMENT_TABLE_PATH = fileURLToPath(new URL('./panels/AssignmentTable.tsx', import.meta.url));

describe('A2 — skip link (WCAG 2.4.1 Bypass Blocks)', () => {
  const appSrc = readFileSync(APP_TSX_PATH, 'utf8');

  it('renders a skip link targeting #main-content before the sidebar in source order', () => {
    const skipLinkIndex = appSrc.indexOf('href="#main-content"');
    const sidebarIndex = appSrc.indexOf('<aside className="sidebar">');
    expect(skipLinkIndex, 'App.tsx has no link to #main-content').toBeGreaterThan(-1);
    expect(sidebarIndex, 'App.tsx has no <aside className="sidebar">').toBeGreaterThan(-1);
    // JSX source order is DOM/tab order for sibling elements with no
    // tabIndex overrides, which is what makes this assertion meaningful: the
    // skip link must be the FIRST focusable thing, not merely present
    // somewhere on the page.
    expect(skipLinkIndex).toBeLessThan(sidebarIndex);
  });

  it('gives <main> the id the skip link targets, and makes it a valid focus destination', () => {
    expect(appSrc).toContain('id="main-content"');
    // `tabIndex={-1}` is what lets a non-interactive landmark actually
    // receive focus on the fragment jump — see App.tsx's own comment on why
    // this is not optional (Safari does not move focus to a plain anchor
    // target without it).
    expect(appSrc).toMatch(/<main className="main" id="main-content" tabIndex=\{-1\}>/);
  });

  it('the skip link starts visually hidden and reveals itself on focus (styles.css)', () => {
    expect(appSrc).toMatch(/className="visually-hidden skip-link"/);
    const css = readFileSync(STYLES_CSS_PATH, 'utf8');
    expect(css, 'styles.css has no .skip-link:focus reveal rule').toContain('.skip-link:focus');
  });
});

describe('A5 — the assignments table has an accessible name (<caption>)', () => {
  it('AssignmentTable.tsx gives its <table> a visually-hidden <caption>', () => {
    const src = readFileSync(ASSIGNMENT_TABLE_PATH, 'utf8');
    expect(src).toMatch(/<caption className="visually-hidden">[^<]+<\/caption>/);
  });
});
