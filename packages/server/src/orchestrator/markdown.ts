/**
 * Markdown helpers shared by this directory's marker parsers.
 *
 * `notes.ts` (`parseAgentNotes`) and `review.ts` (`parseReviewVerdict`) each
 * scan an agent's report for a `[[TOKEN: ...]]`-shaped marker, and each has to
 * solve the identical problem: a report that *explains* the marker mechanism —
 * because an agent is auditing this very system — will quote the marker
 * inside a fenced code block as documentation, not as a declaration. Both
 * parsers need that fenced text removed before they go looking for a real
 * marker, or the quotation gets read as the thing itself.
 *
 * That rule belongs in exactly one place. Two independent copies of this
 * regex is precisely how two parsers drift apart — one gets tightened after an
 * incident, the other doesn't, and the next reader has no way to know that was
 * a decision rather than an oversight. `notes.ts` carried the only copy first;
 * this module exists so `review.ts` shares it instead of pasting a second one.
 */

/**
 * Blank out fenced code blocks (``` ... ```) in a markdown document.
 *
 * A fence must open at the start of a line (ignoring leading whitespace) and
 * close the same way; everything between — including any `[[...]]`-shaped text
 * used as a documentation example — is replaced so no marker parser can find a
 * declaration there.
 *
 * ## Masked, not deleted, and that difference is load-bearing
 *
 * Every character inside a fence becomes a space, and newlines are kept, so the
 * result has the SAME LENGTH and the same line structure as the input. Deleting
 * the fences instead — which is what this did at first — is fine for a parser
 * that only reads its match groups (`notes.ts`), and quietly wrong for one that
 * needs to edit the original document afterwards (`review.ts`, which removes the
 * verdict marker to leave the critique behind).
 *
 * With a deleted fence, an offset into the scanned string means nothing in the
 * original, so `review.ts` had to build its critique out of the stripped text —
 * silently dropping every fenced code block the reviewer wrote, which for a code
 * reviewer is frequently the most useful part of the critique. Matching on the
 * masked copy and cutting from the original by index gets both properties at
 * once: the quoted marker cannot be mistaken for a declaration, and nothing the
 * reviewer wrote is lost. The rejected middle option — match on the stripped
 * text, then `replace` on the original — is the actually dangerous one: with the
 * marker quoted in a fence AND declared for real, `replace` removes the first
 * occurrence, which is the quotation, leaving the real marker in the critique.
 */
export function maskFencedCode(markdown: string): string {
  return markdown.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
}
