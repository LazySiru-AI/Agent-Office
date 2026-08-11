import { describe, expect, it } from 'vitest';
import type { AgentDef } from '@agent-office/shared';
import { agentMarker, buildAssignmentBrief, DEFAULT_MAX_UPSTREAM_REPORT_CHARS } from './brief.js';
import { REVIEW_VERDICT_INSTRUCTION } from './review.js';

/**
 * `buildAssignmentBrief` (FR-M5): what one agent actually sees.
 *
 * Hermetic fixtures, matching the style of `manager.test.ts` — the real
 * catalog is not needed to exercise brief assembly.
 */

const AGENT: AgentDef = {
  name: 'backend-developer',
  description: 'Builds server-side systems.',
  tools: ['Read', 'Grep'],
  category: '01-core-development',
  filePath: 'categories/01-core-development/backend-developer.md',
  systemPrompt: 'You are backend-developer.',
};

const ASSIGNMENT = {
  id: 'implement',
  objective: 'Design and implement the limiter.',
  deliverable: 'reports/01-backend-developer.md',
};

describe('buildAssignmentBrief', () => {
  it('includes the marker, the task, the objective and the output instructions', () => {
    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting to the public API.',
      assignment: ASSIGNMENT,
      upstreamReports: [],
    });

    expect(brief).toContain(agentMarker('backend-developer'));
    expect(brief).toContain('Add rate limiting to the public API.');
    expect(brief).toContain('Design and implement the limiter.');
    expect(brief).toContain('reports/01-backend-developer.md');
  });

  it('says nothing about earlier work when there are no dependencies', () => {
    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [],
    });

    expect(brief).not.toContain('## Reports from earlier work you depend on');
  });

  it('inlines a short upstream report in full', () => {
    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [
        { assignmentId: 'design', agentName: 'architect', content: 'Use a token bucket.' },
      ],
    });

    expect(brief).toContain('### From architect (design)');
    expect(brief).toContain('Use a token bucket.');
    expect(brief).not.toContain('[TRUNCATED BY AGENT OFFICE:');
  });

  // --- Defect: unlike synthesis's DEFAULT_MAX_REPORT_CHARS discipline, brief
  // assembly used to inline every upstream report in full with no cap at all.
  // A long upstream report — or a chain of them across several `dependsOn`
  // hops — reached every dependent assignment uncapped: a cost and context
  // exposure, since FR-M5 promises each agent sees only its own objective and
  // its dependencies' reports, and an unbounded report crowds that out.

  it('caps an oversized upstream report instead of inlining it in full', () => {
    const long = 'x'.repeat(DEFAULT_MAX_UPSTREAM_REPORT_CHARS + 5_000);

    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [{ assignmentId: 'design', agentName: 'architect', content: long }],
    });

    // Before the fix, `brief.length` would grow linearly with the upstream
    // report with no ceiling at all (it would be within a few bytes of
    // `long.length`, i.e. the cap plus 5,000). This bounds it to the cap plus
    // the fixed brief scaffolding around it (headers, task, objective, output
    // instructions, the truncation marker) — nowhere near that.
    expect(brief.length).toBeLessThan(DEFAULT_MAX_UPSTREAM_REPORT_CHARS + 2_000);
    expect(brief).toContain('[TRUNCATED BY AGENT OFFICE:');
  });

  it('honours a custom cap, so a caller can tighten or loosen the default', () => {
    const long = 'y'.repeat(500);

    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [{ assignmentId: 'design', agentName: 'architect', content: long }],
      maxUpstreamReportChars: 50,
    });

    expect(brief).toContain('y'.repeat(50));
    expect(brief).not.toContain('y'.repeat(51));
    expect(brief).toContain('[TRUNCATED BY AGENT OFFICE:');
  });

  it('caps each upstream report independently', () => {
    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [
        { assignmentId: 'a', agentName: 'architect', content: 'a'.repeat(200) },
        { assignmentId: 'b', agentName: 'auditor', content: 'short' },
      ],
      maxUpstreamReportChars: 20,
    });

    expect(brief).toContain('a'.repeat(20));
    expect(brief).not.toContain('a'.repeat(21));
    expect(brief).toContain('short');
    expect(brief.match(/\[TRUNCATED BY AGENT OFFICE:/g) ?? []).toHaveLength(1);
  });

  it('reuses the surrogate-pair-safe truncation, so a cap cannot corrupt a report mid-character', () => {
    const content = `${'z'.repeat(10)}${'\u{1F600}'}${'z'.repeat(10)}`;

    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [{ assignmentId: 'design', agentName: 'architect', content }],
      maxUpstreamReportChars: 11, // cuts inside the surrogate pair
    });

    const roundTripped = new TextDecoder().decode(new TextEncoder().encode(brief));
    expect(roundTripped).not.toContain('�');
  });

  it('includes the revision note and the review verdict instruction when asked', () => {
    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [],
      revisionNote: 'The limiter is not thread-safe.',
      isReview: true,
    });

    expect(brief).toContain('## Revision requested');
    expect(brief).toContain('The limiter is not thread-safe.');
    expect(brief).toContain(REVIEW_VERDICT_INSTRUCTION);
  });

  it('omits the review verdict instruction when the assignment is not a review', () => {
    const brief = buildAssignmentBrief({
      agent: AGENT,
      task: 'Add rate limiting.',
      assignment: ASSIGNMENT,
      upstreamReports: [],
    });

    expect(brief).not.toContain(REVIEW_VERDICT_INSTRUCTION);
  });
});
