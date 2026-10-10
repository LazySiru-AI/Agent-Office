import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  annotatedRequirementMentions,
  countMentions,
  defaultRepoRoot,
  isOwnTest,
  parseRequirements,
  zeroMentionIds,
  type Requirement,
  type RequirementMentions,
} from './traceability.js';

/**
 * Exercises the pure parsing and counting logic directly against fixture
 * strings, not the CLI — `buildTraceabilityReport`/`main` do file IO and
 * argv parsing that these tests deliberately don't need to touch, the same
 * split `purge.test.ts` makes between `purgeRuns` and `main()`.
 *
 * One test below (`the real PLAN.md`) is the exception: it runs the real
 * parser over the real PLAN.md, on purpose, as a canary for a format change —
 * see its own comment.
 */

describe('parseRequirements', () => {
  // Deliberately fictional ids ("FR-Z*", "NFR-77"/"NFR-90"): every real
  // PLAN.md category uses R/M/S/P/T/U, and NFR only reaches 10, so nothing
  // here collides with a real requirement. That matters because this file is
  // itself a *.test.ts under packages/server/src — the real CLI run below
  // sweeps it too, and a fixture that happened to spell out a real id like
  // "FR-M6" would inflate that requirement's real mention count with a match
  // that has nothing to do with FR-M6 actually being tested.
  const FIXTURE_PLAN = `
### 2.1 Something (FR-Z)

| ID | Pri | Requirement |
|---|---|---|
| FR-Z1 | M | Recursively index things. |
| FR-Z2 | S | Second thing. |
| FR-Z2 | C | Same id again, different priority — must not override the first. |
| FR-Z3 | C | Third thing. |

### 2.9 Non-functional, fictional (NFR)

| ID | Pri | Requirement |
|---|---|---|
| NFR-77 | M | Sandboxing. |
| NFR-90 | M | Token gate. A row with | an extra pipe | in the requirement text. |

FR-Z1 mentioned again here in prose, outside any table — must not appear twice.
`;

  it('parses id and priority from table rows, skips the header row, and ignores prose mentions', () => {
    const requirements = parseRequirements(FIXTURE_PLAN);
    expect(requirements).toEqual<Requirement[]>([
      { id: 'FR-Z1', priority: 'M' },
      { id: 'FR-Z2', priority: 'S' },
      { id: 'FR-Z3', priority: 'C' },
      { id: 'NFR-77', priority: 'M' },
      { id: 'NFR-90', priority: 'M' },
    ]);
  });

  it('keeps the first occurrence of a duplicate id rather than throwing or overwriting', () => {
    const requirements = parseRequirements(FIXTURE_PLAN);
    const dup = requirements.find((r) => r.id === 'FR-Z2');
    expect(dup?.priority).toBe('S');
  });

  it('tolerates an extra "|" inside the requirement text without corrupting later columns', () => {
    const requirements = parseRequirements(FIXTURE_PLAN);
    expect(requirements.find((r) => r.id === 'NFR-90')?.priority).toBe('M');
  });

  // Fictional ids again ("FR-Y*"), same reasoning as FIXTURE_PLAN above: this
  // file is itself swept by the real CLI run's test-file scan, so a fixture
  // id must never collide with a real PLAN.md id or it would inflate that
  // requirement's real mention count.
  const ANNOTATED_FIXTURE_PLAN = `
### 2.2 Something annotated, fictional (FR-Y)

| ID | Pri | Requirement |
|---|---|---|
| FR-Y1 | C | An ordinary row with no annotation at all. |
| FR-Y2 | C | A deferred feature. *(not built: deliberately deferred, per the fictional roadmap.)* |
| FR-Y3 | C | Lives outside the scanned tree. *(outside the test tree: implemented in tools/fictional-thing, not TypeScript.)* |
`;

  it('leaves an unannotated row with no "annotation" property at all', () => {
    const requirements = parseRequirements(ANNOTATED_FIXTURE_PLAN);
    const y1 = requirements.find((r) => r.id === 'FR-Y1');
    // Not just "annotation is undefined" — with exactOptionalPropertyTypes,
    // the key itself must be absent, matching how parseRequirements builds
    // the object (`...(annotation === undefined ? {} : { annotation })`).
    expect(y1).toBeDefined();
    expect(y1).not.toHaveProperty('annotation');
  });

  it('parses a "not built" annotation into kind + reason', () => {
    const requirements = parseRequirements(ANNOTATED_FIXTURE_PLAN);
    const y2 = requirements.find((r) => r.id === 'FR-Y2');
    expect(y2?.annotation).toEqual({
      kind: 'not-built',
      reason: 'deliberately deferred, per the fictional roadmap.',
    });
  });

  it('parses an "outside the test tree" annotation into kind + reason', () => {
    const requirements = parseRequirements(ANNOTATED_FIXTURE_PLAN);
    const y3 = requirements.find((r) => r.id === 'FR-Y3');
    expect(y3?.annotation).toEqual({
      kind: 'outside-test-tree',
      reason: 'implemented in tools/fictional-thing, not TypeScript.',
    });
  });

  it('throws rather than silently accepting an annotation marker with no reason', () => {
    // Colon present but nothing after it before the closing "*)" — the
    // reason trims to empty. Chosen over silently treating this as "no
    // annotation" so a typo (forgotten reason) surfaces immediately instead
    // of quietly reporting the requirement as an ordinary, unexplained gap;
    // see ANNOTATION_PATTERN's doc comment in traceability.ts for the full
    // reasoning.
    const reasonlessPlan = `
| ID | Pri | Requirement |
|---|---|---|
| FR-Y4 | C | Deferred, but the marker forgot its reason. *(not built: )* |
`;
    expect(() => parseRequirements(reasonlessPlan)).toThrow(/FR-Y4/);
    expect(() => parseRequirements(reasonlessPlan)).toThrow(/reason/i);
  });

  it('throws on an annotation marker missing the colon and reason entirely', () => {
    const reasonlessPlan = `
| ID | Pri | Requirement |
|---|---|---|
| FR-Y5 | C | Deferred, marker has no colon at all. *(not built)* |
`;
    expect(() => parseRequirements(reasonlessPlan)).toThrow(/FR-Y5/);
  });

  it('finds a plausible number of requirements in the real PLAN.md (format-change canary)', async () => {
    // Not asserting an exact count — PLAN.md's requirement count changes as
    // the project grows (PLAN.md §2 currently runs FR-R1..R6, FR-M1..M12,
    // FR-S1..S14, FR-P1..P7, FR-T1..T4, FR-U1..U7 and NFR-1..NFR-10, which
    // alone is 60). A generous floor of 30 is enough to catch the failure
    // mode this test exists for: PLAN.md's table syntax changing in a way
    // that silently stops matching, which would otherwise show up only as a
    // quiet drop in every requirement's mention count, never as a red test.
    const planPath = path.join(defaultRepoRoot(), 'PLAN.md');
    const planText = await readFile(planPath, 'utf8');
    const requirements = parseRequirements(planText);
    expect(requirements.length).toBeGreaterThan(30);
  });

  it('reads every real, deliberately annotated requirement off the real PLAN.md', async () => {
    // The other half of the canary above: not just "the table syntax still
    // matches", but "the *annotation* syntax still matches" for the rows this
    // feature exists to explain — two deferred could-haves, one built outside
    // the scanned packages as a Claude Code skill, and one built in a shape no
    // test in this repository can assert.
    //
    // The ids are still assembled from parts rather than spelled out, and that
    // is now belt-and-braces rather than load-bearing: `collectTestFilesUnder`
    // skips this file entirely (see `isOwnTest`), because a scanner that reads
    // its own test is measuring itself — which had quietly credited five
    // requirements, three of them Musts, with coverage that existed nowhere but
    // here. The assembly stays because it costs nothing and keeps this file
    // honest even if it is ever read by some other tool.
    const idsExpectedNotBuilt = [['FR', 'S8'].join('-'), ['FR', 'P7'].join('-')];
    const idsExpectedOutsideTestTree = [['FR', 'R6'].join('-'), ['FR', 'S12'].join('-')];

    const planPath = path.join(defaultRepoRoot(), 'PLAN.md');
    const planText = await readFile(planPath, 'utf8');
    const requirements = parseRequirements(planText);
    const byId = new Map(requirements.map((r) => [r.id, r]));

    for (const id of idsExpectedNotBuilt) {
      expect(byId.get(id)?.annotation?.kind).toBe('not-built');
      // Every real annotation has a non-empty reason — parseAnnotation would
      // have thrown already if not, but this pins the actual PLAN.md content
      // rather than only trusting that the parser didn't throw.
      expect(byId.get(id)?.annotation?.reason.length).toBeGreaterThan(0);
    }
    for (const id of idsExpectedOutsideTestTree) {
      expect(byId.get(id)?.annotation?.kind).toBe('outside-test-tree');
      expect(byId.get(id)?.annotation?.reason.length).toBeGreaterThan(0);
    }

    // Exactly these four requirements are annotated in the real document —
    // nothing else picked up a marker by accident.
    const annotatedIds = requirements.filter((r) => r.annotation !== undefined).map((r) => r.id).sort();
    expect(annotatedIds).toEqual([...idsExpectedNotBuilt, ...idsExpectedOutsideTestTree].sort());

    // FR-S7 and FR-U6 are the neighbouring web requirements that DID get real
    // tests rather than an annotation, and must stay unannotated — an
    // annotation on either would mean someone had explained away coverage that
    // actually exists.
    expect(byId.get('FR-S7')).not.toHaveProperty('annotation');
    expect(byId.get('FR-U6')).not.toHaveProperty('annotation');
  });
});

describe('countMentions', () => {
  // Same reason as the fictional ids above: real-looking "FR-Z*" ids that
  // don't collide with anything in PLAN.md, so this file's own fixtures never
  // masquerade as evidence for a real requirement in the CLI's real report.
  const requirements: Requirement[] = [
    { id: 'FR-Z6', priority: 'M' },
    { id: 'FR-Z10', priority: 'S' },
    { id: 'FR-Z9', priority: 'M' },
  ];

  it('counts files and total occurrences separately, across multiple files', () => {
    const files = new Map<string, string>([
      [
        'orchestrator/example.test.ts',
        "describe('dispatchRun — a decline is not a success (FR-Z6)', () => {\n" +
          "  // FR-Z6's guard is `text.trim() === ''`\n" +
          '});',
      ],
      ['panels/Example.test.ts', "it('handles the FR-Z10 revision', () => {});"],
    ]);

    const byId = new Map(countMentions(requirements, files).map((r) => [r.requirement.id, r]));

    expect(byId.get('FR-Z6')).toMatchObject({ fileCount: 1, occurrenceCount: 2 });
    expect(byId.get('FR-Z6')?.files).toEqual(['orchestrator/example.test.ts']);

    expect(byId.get('FR-Z10')).toMatchObject({ fileCount: 1, occurrenceCount: 1 });

    // Never mentioned anywhere in the fixture — the zero case this whole
    // script exists to surface.
    expect(byId.get('FR-Z9')).toMatchObject({ fileCount: 0, occurrenceCount: 0, files: [] });
  });

  it('does not let FR-Z1 match inside FR-Z10, FR-Z11 or FR-Z12 (prefix collision)', () => {
    // Deliberately no bare "FR-Z1" anywhere in this fixture — only ids that
    // share its prefix. If the word-boundary check ever regressed to a plain
    // substring search, this would be the case that goes from 0 to 3.
    const files = new Map([['a.test.ts', 'describe("FR-Z10, FR-Z11 and FR-Z12 all mentioned", () => {})']]);
    const [result] = countMentions([{ id: 'FR-Z1', priority: 'M' }], files);
    expect(result?.occurrenceCount).toBe(0);
  });

  it('does not let a short id match inside a longer numeral (FR-Z6 vs FR-Z60/FR-Z6X)', () => {
    // Deliberately no bare "FR-Z6" anywhere in this fixture.
    const files = new Map([['a.test.ts', 'references only FR-Z60 and FR-Z6X, nothing shorter']]);
    const [result] = countMentions([{ id: 'FR-Z6', priority: 'M' }], files);
    expect(result?.occurrenceCount).toBe(0);
  });

  it('still matches an id immediately followed by punctuation, since punctuation is a word boundary', () => {
    const files = new Map([['a.test.ts', 'covers (FR-Z6), FR-Z6. and FR-Z6, in one line']]);
    const [result] = countMentions([{ id: 'FR-Z6', priority: 'M' }], files);
    expect(result?.occurrenceCount).toBe(3);
  });

  it('sorts the matched file list deterministically', () => {
    const files = new Map([
      ['z.test.ts', 'FR-Z6'],
      ['a.test.ts', 'FR-Z6'],
    ]);
    const [result] = countMentions([{ id: 'FR-Z6', priority: 'M' }], files);
    expect(result?.files).toEqual(['a.test.ts', 'z.test.ts']);
  });
});

describe('zeroMentionIds', () => {
  it('groups only the zero-occurrence requirements, keyed by priority', () => {
    const mentions: RequirementMentions[] = [
      { requirement: { id: 'FR-Z6', priority: 'M' }, fileCount: 0, occurrenceCount: 0, files: [] },
      { requirement: { id: 'FR-Z9', priority: 'C' }, fileCount: 0, occurrenceCount: 0, files: [] },
      {
        requirement: { id: 'FR-Z1', priority: 'M' },
        fileCount: 2,
        occurrenceCount: 3,
        files: ['a.test.ts', 'b.test.ts'],
      },
      { requirement: { id: 'FR-Z12', priority: 'S' }, fileCount: 0, occurrenceCount: 0, files: [] },
    ];

    expect(zeroMentionIds(mentions)).toEqual({
      M: ['FR-Z6'],
      S: ['FR-Z12'],
      C: ['FR-Z9'],
    });
  });

  it('returns empty arrays for every priority when nothing is untested', () => {
    const mentions: RequirementMentions[] = [
      { requirement: { id: 'FR-Z6', priority: 'M' }, fileCount: 1, occurrenceCount: 1, files: ['a.test.ts'] },
    ];
    expect(zeroMentionIds(mentions)).toEqual({ M: [], S: [], C: [] });
  });

  it('excludes an annotated requirement from the zero-mention count even though it has zero mentions', () => {
    // This is the core behaviour change: an annotated zero-mention
    // requirement is an explained decision, not the "unexplained gap" this
    // count is supposed to mean — see zeroMentionIds's own doc comment.
    const mentions: RequirementMentions[] = [
      {
        requirement: { id: 'FR-Z6', priority: 'C', annotation: { kind: 'not-built', reason: 'deferred' } },
        fileCount: 0,
        occurrenceCount: 0,
        files: [],
      },
      { requirement: { id: 'FR-Z9', priority: 'C' }, fileCount: 0, occurrenceCount: 0, files: [] },
    ];

    // Only the unannotated FR-Z9 counts as a genuine gap; the annotated
    // FR-Z6 does not appear under any priority.
    expect(zeroMentionIds(mentions)).toEqual({ M: [], S: [], C: ['FR-Z9'] });
  });
});

describe('annotatedRequirementMentions', () => {
  it('returns only the entries whose requirement carries an annotation', () => {
    const mentions: RequirementMentions[] = [
      { requirement: { id: 'FR-Z1', priority: 'M' }, fileCount: 1, occurrenceCount: 1, files: ['a.test.ts'] },
      {
        requirement: { id: 'FR-Z2', priority: 'C', annotation: { kind: 'not-built', reason: 'deferred' } },
        fileCount: 0,
        occurrenceCount: 0,
        files: [],
      },
    ];

    const result = annotatedRequirementMentions(mentions);
    expect(result.map((r) => r.requirement.id)).toEqual(['FR-Z2']);
  });

  it('includes an annotated requirement that DOES have mentions, so callers can detect it as stale', () => {
    // The annotation said "expect zero mentions"; a nonzero occurrenceCount
    // here means reality moved on (built, or now named by a test) and the
    // PLAN.md annotation should be revisited. annotatedRequirementMentions
    // doesn't hide this case — it's still returned, just with a nonzero
    // count, and it's the caller's job (printReport, or a test like this
    // one) to notice occurrenceCount > 0 and treat it as stale.
    const mentions: RequirementMentions[] = [
      {
        requirement: {
          id: 'FR-Z3',
          priority: 'C',
          annotation: { kind: 'outside-test-tree', reason: 'implemented as a shell script' },
        },
        fileCount: 1,
        occurrenceCount: 2,
        files: ['example.test.ts'],
      },
    ];

    const [result] = annotatedRequirementMentions(mentions);
    expect(result).toBeDefined();
    expect(result?.occurrenceCount).toBeGreaterThan(0);
  });
});

describe('isOwnTest', () => {
  it('excludes this file, so the scanner cannot count itself as coverage', () => {
    // Not a stylistic rule. Every requirement id in THIS file is fixture data —
    // a fictional PLAN.md, a canary asserting an annotation is still in place,
    // a regression guard naming what it guards — and none of it means anything
    // is tested. The scanner counted all of it anyway, because this file sits
    // under a scanned package and ends in `.test.ts` like every other file it
    // reads.
    //
    // The damage was measured, not imagined: with this exclusion in place, five
    // requirements dropped out of the "mentioned" column and into the
    // zero-mention list — FR-R1, FR-P1 and FR-T1 (Musts), plus NFR-10 and
    // FR-S12. Every one of them had read as covered for this script's entire
    // life on the strength of appearing here.
    expect(isOwnTest(path.join('packages', 'server', 'src', 'scripts', 'traceability.test.ts'))).toBe(
      true,
    );
  });

  it('excludes nothing else, including its own neighbours', () => {
    // The exclusion must be exactly one file wide. A rule that skipped, say,
    // everything under `scripts/` would silently stop counting `purge.test.ts`,
    // which is the only place NFR-10's retention behaviour is claimed.
    expect(isOwnTest(path.join('packages', 'server', 'src', 'scripts', 'purge.test.ts'))).toBe(false);
    expect(isOwnTest(path.join('packages', 'server', 'src', 'http', 'server.test.ts'))).toBe(false);
    expect(isOwnTest(path.join('packages', 'web', 'src', 'styles.test.ts'))).toBe(false);
  });
});

describe('defaultRepoRoot', () => {
  it('resolves to the repo root, not packages/server, regardless of cwd', async () => {
    // The bug this guards against (documented in the module doc comment and
    // in diagnostics.ts): resolving from process.cwd() instead of
    // import.meta.url reports "nothing found" under npm workspaces, which run
    // scripts with cwd set to packages/server. PLAN.md and packages/ existing
    // at the resolved root is the actual proof; a plain string assertion on
    // the path would not catch a resolver that is merely a coincidentally
    // plausible-looking wrong answer.
    const root = defaultRepoRoot();
    await expect(readFile(path.join(root, 'PLAN.md'), 'utf8')).resolves.toContain('Agent Office');
  });
});
