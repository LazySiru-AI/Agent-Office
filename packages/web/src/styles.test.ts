import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * FR-U6: "No webfont fetched at runtime; system monospace / bundled font
 * only."
 *
 * There is no DOM in this suite (see `sim/scene.test.ts`'s own header for why
 * — plain Node, no jsdom, no `document`), so this cannot load the app and
 * inspect `document.fonts` or watch the network for a font request the way an
 * end-to-end test could. What it CAN do, honestly, is read the two files that
 * are the only places a remote font could be declared — `styles.css` and
 * `index.html` — straight off disk and assert the declaration is not there.
 * That is a real, narrower guarantee than "no font is ever fetched", but it is
 * the thing that actually breaks: a webfont only ever enters this app through
 * one of `@font-face`'s own `url(...)`, a `<link>` to a font host (Google
 * Fonts, Adobe Fonts, etc.), or an `@import` of a remote stylesheet — there is
 * no fourth way to make a browser fetch one. Catching those three is
 * equivalent to catching "did someone paste a Google Fonts snippet in", which
 * is exactly the regression FR-U6 exists to prevent (see `styles.css`'s own
 * header comment, which already names FR-U6 at the token declaration this
 * test reads).
 *
 * Paths are resolved from this file's own location (`import.meta.url`), never
 * `process.cwd()` — `traceability.ts`'s doc comment records this exact bug
 * having shipped once already in this repo (`diagnostics.ts` read a
 * cwd-relative path and silently reported the wrong directory), so every file
 * read in this suite follows the same rule scene.ts's own "FR-U2" describe
 * block already does for its colour-literal check.
 */

const STYLES_PATH = fileURLToPath(new URL('./styles.css', import.meta.url));
const INDEX_HTML_PATH = fileURLToPath(new URL('../index.html', import.meta.url));

describe('FR-U6 — no webfont fetched at runtime', () => {
  it('declares no @font-face rule in styles.css', () => {
    // `@font-face { ... src: url(...) }` is the only CSS construct that can
    // ask the browser to fetch a font file, remote or local. This app ships
    // none at all — both font stacks (`--ao-font-sans`, `--ao-font-mono`) are
    // pure `font-family` lists of names the OS already has — so the correct
    // count is zero, not "zero remote ones": a LOCAL @font-face would still
    // mean this file stopped being system-fonts-only, which is the actual
    // claim FR-U6 makes, not just "not remote".
    const css = readFileSync(STYLES_PATH, 'utf8');
    expect(css).not.toMatch(/@font-face/i);
  });

  it('imports no remote stylesheet from styles.css', () => {
    // `@import url("https://fonts.googleapis.com/...")` is the classic way a
    // webfont sneaks in without ever writing `@font-face` locally — the host
    // stylesheet supplies that rule instead. A same-origin `@import` of a
    // local file is not what FR-U6 is about and would not match this pattern
    // (it has no `://`), but nothing in this file uses `@import` for any
    // reason today, local or remote.
    const css = readFileSync(STYLES_PATH, 'utf8');
    expect(css).not.toMatch(/@import\s+(url\()?["']?[a-z]+:\/\//i);
  });

  it('references no remote URL anywhere in styles.css', () => {
    // Belt-and-suspenders beyond the two rule-shaped checks above: a
    // `url(https://...)` could in principle appear as a `background-image` or
    // similar without being a font at all, but a font is exactly the kind of
    // asset most likely to get pasted in as a quick `url(...)` snippet copied
    // from a font host's own "embed" instructions, so ruling out every remote
    // `url()` — not just the ones already inside `@font-face` — is the
    // stronger and still-true guarantee to hold this file to.
    const css = readFileSync(STYLES_PATH, 'utf8');
    expect(css).not.toMatch(/url\(\s*["']?[a-z]+:\/\//i);
  });

  it('links no external font stylesheet from index.html', () => {
    // The other classic entry point: `<link rel="stylesheet" href="https://
    // fonts.googleapis.com/...">` in the document head, with the actual
    // `@font-face` living entirely on the far end and never touching this
    // repo's own CSS at all. `index.html` today has exactly one `<link>-free`
    // head (see the file itself) — this pins that it stays that way rather
    // than trusting it will.
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
    const fontLinks = linkTags.filter((tag) => /href\s*=\s*["'][a-z]+:\/\//i.test(tag));
    expect(fontLinks, `found external <link> tag(s) in index.html: ${fontLinks.join(', ')}`).toEqual([]);
  });

  it('preconnects to no font host from index.html', () => {
    // `<link rel="preconnect" href="https://fonts.gstatic.com">` is the
    // half-step version of the mistake: it does not fetch a font by itself,
    // but it only exists to make a LATER font fetch faster, so its presence
    // alone is evidence someone was about to add one. This repeats the
    // previous check's `<link>` scan deliberately rather than merging the two
    // — "an external link tag of any kind" and "a preconnect hint" are two
    // different smells worth naming separately in a failure message.
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(html).not.toMatch(/rel\s*=\s*["'](preconnect|dns-prefetch)["']/i);
  });
});
