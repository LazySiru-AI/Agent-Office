import { Marked, type Token, type Tokens } from 'marked';

/**
 * Agent-authored markdown to HTML, for embedding in a themed printable
 * document (PLAN.md Phase 5, FR-P1, FR-P2).
 *
 * The output of this module is never served as a live web page. It is
 * concatenated into a full HTML document by another module (theming lives in
 * `reports/themes.ts`, page assembly in `reports/designer.ts`) and printed to
 * PDF by headless Chrome (`reports/pdf.ts`). That fact drives every decision
 * below: there is no click-through, no JavaScript runtime the user interacts
 * with, and no second chance if this step throws — the PDF is the last step
 * of a run that may have cost real money, so losing it to a stray backtick
 * in one agent's report is not an acceptable failure mode.
 *
 * ## Security: raw HTML is neutralised, not passed through
 *
 * `marked` passes recognised HTML through to its output unescaped by
 * default — that is normal for markdown meant for a trusted author, but
 * every markdown string here was written by an LLM acting on an
 * attacker-influenced task. An agent (or a report an agent quotes) can
 * contain `<script>`, an unclosed `<div>`, or anything else, and headless
 * Chrome will happily execute or lay out whatever we hand it. So both block
 * HTML and inline tags (the `html` token type covers both — see
 * `Tokens.HTML` and `Tokens.Tag`) are rendered as **visible, escaped text**
 * rather than live markup. This is a deliberate departure from normal
 * markdown semantics: a report that includes a snippet of HTML to describe
 * something will see that snippet printed literally, not interpreted. That
 * trade-off is intentional — there is no trusted-author case here to
 * preserve.
 *
 * ## Theme contract: emitted class names
 *
 * `reports/themes.ts` owns all visual styling; this module only emits the
 * hooks it styles against. The complete set of classes this file can put in
 * its output — themes.ts must account for all of them:
 *
 * - `ao-table-wrapper`   — div around every `<table>`, for horizontal-scroll
 *                          or shrink handling on tables wider than the page.
 * - `ao-table`           — the `<table>` element itself.
 * - `ao-code-wrapper`    — div around every fenced/indented code block, same
 *                          overflow purpose as the table wrapper.
 * - `ao-pre`             — the `<pre>` element inside a code wrapper.
 * - `ao-code`            — the `<code>` element inside `ao-pre`; carries an
 *                          additional `language-<lang>` class when the fence
 *                          declared one.
 * - `ao-raw-html`        — span around escaped raw HTML that appeared in the
 *                          source, so a theme can visually flag it as inert.
 * - `ao-link`            — span around a rendered link (text + URL).
 * - `ao-link-url`        — span around the URL portion of a rendered link.
 * - `ao-image-placeholder` — span standing in for an `![]()` image.
 * - `ao-render-fallback`         — wraps the whole-input fallback when
 *                                  rendering throws (see below).
 * - `ao-render-fallback-notice`  — the notice line inside that fallback.
 *
 * ## Heading levels are shifted, capped at h6
 *
 * Reports are written as if they own the page, starting at `#`. They do
 * not: the surrounding document puts its own `<h1>` on the cover, and each
 * embedded block (the synthesis, or one agent's appendix) sits under a
 * document-level `<h2>` section heading that this module does not control.
 * So every heading is shifted down by {@link HEADING_SHIFT} (2): a report's
 * `#` becomes `<h3>`, its `##` becomes `<h4>`, and so on, capped at `<h6>`
 * (the last level HTML defines) so a report that nests six-deep does not
 * emit an `<h7>` no stylesheet has an opinion about. +2 rather than +1
 * because it is the shift that fits under both the cover `<h1>` *and* a
 * document-level `<h2>` per-section heading — the shallowest structure the
 * surrounding document plausibly has.
 *
 * ## Links render as text plus URL
 *
 * A PDF page cannot be clicked. An `<a href>` that goes nowhere on paper is
 * worse than no link at all — it looks interactive and is not, and the
 * destination is invisible unless the reader happens to hover (impossible)
 * or the URL is printed anyway (in which case the `<a>` was redundant). So
 * links render as their text followed by the literal URL in parentheses,
 * with no `<a>` tag at all: the information survives printing, nothing
 * implies a capability the medium does not have.
 *
 * ## Images become a text placeholder
 *
 * Agents rarely emit images, and when they do we cannot trust the source:
 * an `<img src>` pointing at an attacker- or model-hallucinated URL would
 * have headless Chrome make a network request during PDF conversion — a
 * step that should be able to run offline (FR-P3) and should never be an
 * SSRF vector triggered by report content. Rather than embed, decode, or
 * fetch anything, an image becomes a small `[image: <alt> (<url>)]`
 * placeholder, styled by `ao-image-placeholder`. No network access, no
 * broken-image icon on the printed page, and the reader still learns an
 * image was there and what it was meant to show.
 *
 * ## Determinism
 *
 * Same input, same output, forever — no timestamps, no random ids, nothing
 * time-of-day-dependent. Heading ids are derived from heading text via
 * {@link slugify}, with a stable, order-based counter for collisions (the
 * first `## Summary` gets `summary`, the next gets `summary-1`), so the same
 * report always gets the same ids. This matters because `extractHeadingOutline`
 * and `renderMarkdown` are called separately on the same markdown by the
 * designer step and must agree on ids without talking to each other.
 *
 * ## Never throws
 *
 * `renderMarkdown` and `extractHeadingOutline` both wrap their real work in
 * a try/catch. Agent output is adversarial-by-accident: unbalanced
 * backticks, a fenced block with no closing fence, a table row with the
 * wrong number of cells. `marked` tolerates almost all of this already (it
 * is built for exactly this kind of ragged input), but "almost all" is not
 * "never", and a run's PDF is too expensive to lose to the remainder. On
 * any failure, `renderMarkdown` falls back to the escaped markdown source
 * shown as preformatted text (still safe, per the HTML-escaping rule above)
 * and `extractHeadingOutline` falls back to an empty outline — a report
 * without a table of contents is a minor loss; a run without a PDF is not.
 *
 * ## Pathological emphasis runs are bounded before lexing, not caught after
 *
 * `marked`'s emphasis tokenizer recurses over a run of consecutive `*`/`_`
 * markers trying every split point, and a long enough run (`n` asterisks,
 * one letter, `n` more asterisks) makes that recursion throw `RangeError:
 * Maximum call stack size exceeded`. The try/catch above already stops that
 * from crashing anything, but the time spent *reaching* the throw is not
 * bounded by the catch: measured at 0.5s for 5,000 markers and 12s for
 * 80,000. That is squarely in the range of real LLM output (a model
 * emitting bullet markers with no spacing between them gets there), and
 * every appendix is rendered separately, so a handful of agents each doing
 * this compound directly into a stalled `designing` step. "Never throws"
 * was never the actual requirement; "never blocks the run for seconds" is,
 * and a catch block cannot deliver that no matter how fast it fires.
 *
 * So the shape is made impossible before either lexer ever sees it:
 * {@link boundEmphasisRuns} backslash-escapes any run of
 * {@link PATHOLOGICAL_RUN_THRESHOLD} or more consecutive identical emphasis
 * markers, which `marked` then reads as that many literal characters (same
 * as any other escaped punctuation) instead of a chain of markers to
 * recurse over. No legitimate report needs anywhere near that many
 * consecutive markers (`***bold italic***` needs three), so nothing but the
 * pathological shape is affected, and the underlying regex (a bounded
 * backreference repetition, no nested quantifiers) is itself linear-time.
 */

/** See "Heading levels are shifted, capped at h6" above. */
const HEADING_SHIFT = 2;

/** HTML defines no level past this. */
const MAX_HEADING_LEVEL = 6;

/**
 * More consecutive identical emphasis markers than any legitimate markdown
 * ever nests (`***bold italic***` needs three). See "Pathological emphasis
 * runs are bounded before lexing" above.
 */
const PATHOLOGICAL_RUN_THRESHOLD = 32;

/** Matches a run of `PATHOLOGICAL_RUN_THRESHOLD` or more identical `*`/`_` characters. */
const EMPHASIS_RUN_PATTERN = new RegExp(`([*_])\\1{${PATHOLOGICAL_RUN_THRESHOLD - 1},}`, 'g');

/**
 * Neutralise a pathologically long run of emphasis markers before either
 * lexer sees it, by escaping each marker in the run. See "Pathological
 * emphasis runs are bounded before lexing" above for why this exists and why
 * escaping (rather than truncating or dropping) is the right degradation:
 * the reader still sees every character the report contained, just as
 * literal punctuation instead of triggering emphasis parsing.
 */
function boundEmphasisRuns(md: string): string {
  return md.replace(EMPHASIS_RUN_PATTERN, (run) => run.replace(/[*_]/g, '\\$&'));
}

/** One entry in a report's heading structure, for an optional table of contents. */
export interface HeadingOutlineEntry {
  /** Heading level *after* {@link HEADING_SHIFT} and the h6 cap — i.e. what actually appears in the document. */
  level: number;
  /** Plain text of the heading (markdown formatting stripped, raw HTML dropped). */
  text: string;
  /** Deterministic id, matching the `id` attribute `renderMarkdown` puts on the same heading. */
  id: string;
}

/**
 * Markdown to an HTML fragment (no `<html>`/`<body>` wrapper). Never throws —
 * see the "Never throws" section of the module comment.
 */
export function renderMarkdown(md: string): string {
  try {
    return renderMarkdownOrThrow(md);
  } catch (error) {
    console.warn(
      '[reports/markdown] renderMarkdown failed; falling back to escaped plain text',
      error,
    );
    return renderFallback(md);
  }
}

/**
 * The heading structure of a report, in document order, at the levels and
 * with the ids `renderMarkdown` will actually emit — everything a table of
 * contents needs. Exported separately from `renderMarkdown` (rather than
 * bundling both into one return value) because the designer step needs the
 * outline before it knows whether a TOC earns its place on the page, and a
 * report with no headings should not force callers who only want the HTML
 * to handle a second, unused field. Never throws: a malformed report yields
 * an empty outline rather than blocking the document that contains it.
 */
export function extractHeadingOutline(md: string): HeadingOutlineEntry[] {
  try {
    if (md.trim() === '') return [];
    const bounded = boundEmphasisRuns(md);
    const tokens = new Marked({ gfm: true, breaks: false, pedantic: false }).lexer(bounded);
    return computeHeadingOutline(tokens);
  } catch (error) {
    console.warn(
      '[reports/markdown] extractHeadingOutline failed; returning an empty outline',
      error,
    );
    return [];
  }
}

function renderMarkdownOrThrow(md: string): string {
  if (md.trim() === '') return '';

  // See "Pathological emphasis runs are bounded before lexing" above: this
  // must happen before `marked.lexer` runs, not in the catch below — the
  // whole point is to avoid the slow path, not shorten how it fails.
  const bounded = boundEmphasisRuns(md);

  // Populated once tokens exist, read by the `heading` renderer below. A
  // fresh instance and fresh closure state per call is what keeps this
  // function safe to run concurrently and free of any cross-call state that
  // could threaten determinism.
  let outline: HeadingOutlineEntry[] = [];
  let headingCursor = 0;

  const marked = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
    renderer: {
      heading(token) {
        const fallbackLevel = Math.min(token.depth + HEADING_SHIFT, MAX_HEADING_LEVEL);
        const entry = outline[headingCursor];
        headingCursor += 1;
        const level = entry ? entry.level : fallbackLevel;
        const idAttr = entry ? ` id="${escapeAttribute(entry.id)}"` : '';
        const inner = this.parser.parseInline(token.tokens);
        return `<h${level}${idAttr}>${inner}</h${level}>\n`;
      },

      // Both block-level raw HTML and inline tags arrive as `type: 'html'`
      // tokens (see `Tokens.HTML` / `Tokens.Tag`); this single override
      // covers both. See "Security: raw HTML is neutralised" above.
      html(token) {
        return `<span class="ao-raw-html">${escapeHtml(token.text)}</span>`;
      },

      code(token) {
        const lang = sanitiseLangToken(token.lang);
        const langClass = lang ? ` language-${lang}` : '';
        return (
          `<div class="ao-code-wrapper"><pre class="ao-pre">` +
          `<code class="ao-code${langClass}">${escapeHtml(token.text)}</code></pre></div>\n`
        );
      },

      table(token) {
        const headCells = token.header
          .map((cell) => `<th${alignAttribute(cell.align)}>${this.parser.parseInline(cell.tokens)}</th>`)
          .join('');
        const bodyRows = token.rows
          .map((row) => {
            const cells = row
              .map((cell) => `<td${alignAttribute(cell.align)}>${this.parser.parseInline(cell.tokens)}</td>`)
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('');
        return (
          `<div class="ao-table-wrapper"><table class="ao-table">` +
          `<thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>\n`
        );
      },

      // See "Links render as text plus URL" above: no `<a>`, ever.
      link(token) {
        const inner = this.parser.parseInline(token.tokens);
        return (
          `<span class="ao-link">${inner} ` +
          `<span class="ao-link-url">(${escapeHtml(token.href)})</span></span>`
        );
      },

      // See "Images become a text placeholder" above: never fetched, never embedded.
      image(token) {
        const alt = token.text.trim() !== '' ? token.text : token.href;
        return `<span class="ao-image-placeholder">[image: ${escapeHtml(alt)} (${escapeHtml(token.href)})]</span>`;
      },
    },
  });

  const tokens = marked.lexer(bounded);
  outline = computeHeadingOutline(tokens);
  return marked.parser(tokens);
}

/** The fallback used by `renderMarkdown` when the real render throws. */
function renderFallback(md: string): string {
  const notice =
    '<p class="ao-render-fallback-notice">This section could not be formatted and is shown as plain text.</p>';
  return (
    `<div class="ao-render-fallback">${notice}` +
    `<div class="ao-code-wrapper"><pre class="ao-pre">${escapeHtml(md)}</pre></div></div>`
  );
}

/**
 * Walks a token tree in the same order `marked`'s parser recurses in
 * (top-level tokens, then a container's own `.tokens`/list items' `.tokens`
 * in place), collecting headings depth-first. Matching that recursion order
 * is what lets `renderMarkdown`'s heading renderer consume `outline` as a
 * simple queue and still hand out the right id to the right heading.
 */
function computeHeadingOutline(tokens: Token[]): HeadingOutlineEntry[] {
  const raw: Array<{ depth: number; text: string }> = [];
  const slugCounts = new Map<string, number>();

  const walk = (list: Token[]): void => {
    for (const token of list) {
      if (token.type === 'heading') {
        // `token.tokens` is only optional on the catch-all `Tokens.Generic`
        // member of the `Token` union (extension tokens we never register);
        // every real heading token carries it. `?? []` satisfies the type
        // without a cast and is unreachable in practice.
        raw.push({ depth: token.depth, text: inlineText(token.tokens ?? []) });
      }
      if (token.type === 'list') {
        for (const item of token.items) {
          walk(item.tokens);
        }
      } else if ('tokens' in token && Array.isArray(token.tokens)) {
        walk(token.tokens);
      }
    }
  };
  walk(tokens);

  return raw.map(({ depth, text }) => {
    const level = Math.min(depth + HEADING_SHIFT, MAX_HEADING_LEVEL);
    const base = slugify(text);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
    return { level, text, id };
  });
}

/**
 * Plain text of a run of inline tokens: markdown formatting (`**`, `` ` ``)
 * is stripped rather than shown, and raw HTML tokens contribute nothing —
 * both because this text only ever feeds {@link slugify}, never the page.
 */
function inlineText(tokens: Token[]): string {
  let out = '';
  for (const token of tokens) {
    out += textOfToken(token);
  }
  return out;
}

function textOfToken(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'escape':
    case 'codespan':
      return token.text;
    case 'image':
      return token.text;
    case 'strong':
    case 'em':
    case 'del':
    case 'link':
      // Same `Tokens.Generic` caveat as above.
      return inlineText(token.tokens ?? []);
    case 'br':
      return ' ';
    default:
      return '';
  }
}

/**
 * GitHub-style slug: lowercased, non-alphanumerics collapsed to single
 * hyphens, leading/trailing hyphens trimmed. Collisions are resolved by the
 * caller (a bare heading text always slugifies the same way; only the
 * caller knows how many times it has seen that slug before).
 */
function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base === '' ? 'section' : base;
}

/** Restricts a fence's language tag to what is safe inside a `language-<lang>` class. */
function sanitiseLangToken(lang: string | undefined): string {
  const first = (lang ?? '').trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^A-Za-z0-9_+-]/g, '').toLowerCase();
}

function alignAttribute(align: Tokens.TableCell['align']): string {
  return align ? ` style="text-align:${align}"` : '';
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Same as {@link escapeHtml}; named separately at attribute-value call sites for clarity. */
function escapeAttribute(input: string): string {
  return escapeHtml(input);
}
