import { describe, expect, it } from 'vitest';
import { agentPdfPathFor } from './agentPdf.js';

/**
 * The pure half of the per-agent PDF path (FR-P6).
 *
 * The rendering half is deliberately not unit-tested here: it launches headless
 * Chromium, which `pdf.test.ts` already gates behind a platform check for that
 * exact reason. What matters and is testable without a browser is where the
 * output lands — because that path is derived from a Manager-supplied
 * `deliverable`, and getting it wrong is how a render escapes the run directory.
 */
describe('agentPdfPathFor (FR-P6)', () => {
  it('renders a report to its own sibling, so containment is inherited', () => {
    // The .md path has already passed the store's containment check by the time
    // this is called; a sibling with a different extension cannot reach a
    // directory the original could not.
    expect(agentPdfPathFor('reports/03-architect-reviewer.md')).toBe(
      'reports/03-architect-reviewer.pdf',
    );
  });

  it('replaces only the final extension, never a dot inside the name', () => {
    expect(agentPdfPathFor('reports/01-agent.v2.md')).toBe('reports/01-agent.v2.pdf');
  });

  it('appends rather than mangling when there is no extension at all', () => {
    // A Manager may emit a deliverable with no suffix. Slicing blindly on the
    // last dot would produce an empty name here.
    expect(agentPdfPathFor('reports/plain')).toBe('reports/plain.pdf');
  });

  it('does not resolve or normalise the path it is given', () => {
    // Deliberately NOT sanitising here: this function's contract is "same path,
    // different extension". Containment belongs to the store, which has already
    // applied it — re-implementing a weaker version of that check in a second
    // place is how the two come to disagree.
    expect(agentPdfPathFor('reports/a/b.md')).toBe('reports/a/b.pdf');
  });
});
