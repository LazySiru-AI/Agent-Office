import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which requirements (PLAN.md's `FR-*`/`NFR-*` IDs) does any test even claim
 * to be about?
 *
 *   npm run traceability --
 *   npm run traceability -- --strict
 *   npm run traceability -- --json
 *
 * ## What this measures, and what it does not
 *
 * This tool parses every `FR-*`/`NFR-*` ID and its priority letter (M/S/C) out
 * of PLAN.md's requirement tables, then greps `packages/*\/src/**\/*.test.ts`
 * for each ID and counts how many files, and how many total occurrences,
 * mention it — in `describe`/`it` titles and in comments alike.
 *
 * **A mention is evidence of intent, not proof of coverage.** A test can name
 * `FR-M6` in its title and assert nothing that would actually catch a
 * regression in FR-M6's behaviour; conversely a requirement can be
 * thoroughly, correctly tested by a suite that never once spells out its ID.
 * This script cannot tell either of those apart from the real thing — it
 * counts string occurrences, not test quality or assertion strength. What it
 * *can* tell you, honestly, is narrower and still useful: which requirements
 * nobody has ever claimed by name anywhere in the test suite. That is a
 * real gap — a requirement no one is even pretending to test — and it is
 * exactly the kind of gap that let FR-S4 drift silently from Must to
 * "partially built" with nothing in the suite pointing at it (see
 * PROGRESS.md, "Requirement-to-test traceability ... is still unbuilt").
 * Read every count below as "claimed", never as "covered".
 *
 * ## Annotations: a decision looks identical to a gap unless PLAN.md says so
 *
 * A zero-mention requirement can mean three very different things: (1) it is
 * built and tested but nobody happened to name it in a test — a real gap;
 * (2) it was deliberately never built — a decision already written down
 * elsewhere in PLAN.md; or (3) its subject lives entirely outside
 * `packages/*\/src` (a shell script, a Claude Code skill, docs) where no
 * `*.test.ts` file could ever mention it even if someone wanted to. Lumping
 * all three under "zero-mention" makes the report cry wolf: an operator
 * scanning it cannot tell a genuine hole from a decision that was made on
 * purpose and recorded — and a report nobody trusts is worth exactly as much
 * as no report.
 *
 * The fix is a **deliberate annotation on the requirement's own PLAN.md row**
 * — `*(not built: <reason>)*` or `*(outside the test tree: <reason>)*` — and
 * deliberately *not* a second list of exempt IDs hard-coded in this script.
 * A list here would be a second source of truth for a fact PLAN.md already
 * states: the two would agree on the day this feature ships and silently
 * diverge the first time someone edits one without the other — annotate a
 * newly could-have'd requirement in PLAN.md, forget this file exists, and the
 * report goes back to lying. Reading the annotation off the row itself makes
 * that drift structurally impossible: there is exactly one place to update,
 * and it is the same place a human already reads. See `parseAnnotation` below
 * for the exact grammar.
 *
 * Annotated requirements are reported in their own section, with their
 * reason, and excluded from the zero-mention count — which now means
 * "unexplained gap", not "unexplained-or-explained gap, lumped together". An
 * annotated requirement that *does* have mentions is flagged **stale**:
 * either the deferred work got built, or a test now claims it by name, and
 * the annotation is out of date and should be removed.
 *
 * ## Path resolution
 *
 * Resolved from this module's own location (`import.meta.url`), never from
 * `process.cwd()`. npm workspaces run `npm run <script>` with the cwd set to
 * `packages/server`, and a previous script in this repo shipped with exactly
 * the `process.cwd()` version of this bug: `diagnostics.ts`'s own doc comment
 * records that it silently read `packages/server/runs/` and reported "nothing
 * has been logged yet" while the real log sat at the repo root. `purge.ts`
 * fixed it the same way `diagnostics.ts` later did — via `defaultRunsRoot()`
 * in `store/fileStore.ts`. `defaultRepoRoot()` below is that same pattern
 * applied a third time, from the start, rather than as a fix after the fact.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The repository root: `<agent-office>`.
 *
 * Four levels up from `packages/server/src/scripts`, whether run via `tsx`
 * (this file) or a future built `dist/scripts` (the depth is the same either
 * way): scripts -> src -> server -> packages -> repo root.
 */
export function defaultRepoRoot(): string {
  return path.resolve(HERE, '..', '..', '..', '..');
}

export type Priority = 'M' | 'S' | 'C';

/**
 * The two — and only two — reasons a requirement is allowed to have zero
 * test mentions on purpose:
 *
 *   - `not-built`: consciously deferred. The requirement is real, but no one
 *     has written the code yet, so no test could possibly claim it.
 *   - `outside-test-tree`: implemented, but its subject is not TypeScript
 *     under `packages/*\/src` — a shell script, a Claude Code skill, docs —
 *     so no `*.test.ts` file this scan visits could ever mention it, no
 *     matter how thoroughly the thing itself is exercised elsewhere.
 *
 * Deliberately a closed union rather than a free-text "excuse" string: a
 * report that let anyone write any reason for suppressing a gap would stop
 * meaning anything. Two fixed, load-bearing kinds keep the annotation
 * auditable — every one of them can be sanity-checked against PLAN.md's own
 * prose (see `parseAnnotation`), which a free-form excuse could not be.
 */
export type AnnotationKind = 'not-built' | 'outside-test-tree';

/**
 * A deliberate, human-written explanation for why a requirement is expected
 * to have zero test mentions — parsed off the requirement's own PLAN.md row,
 * never hard-coded here. See the module doc comment ("Annotations") for why.
 */
export interface RequirementAnnotation {
  readonly kind: AnnotationKind;
  /**
   * Mandatory and non-empty by construction: `parseAnnotation` throws rather
   * than producing a `RequirementAnnotation` with an empty reason. An
   * annotation's entire job is to explain itself to a human reading the
   * report; a reason-less annotation would just be a mute button on the
   * zero-mention count, indistinguishable from a gap someone silenced to
   * make the report look cleaner rather than one they actually explained.
   */
  readonly reason: string;
}

export interface Requirement {
  readonly id: string;
  readonly priority: Priority;
  /** Absent for an ordinary requirement — present only when PLAN.md's own
   * row carries a `*(not built: ...)*` / `*(outside the test tree: ...)*`
   * marker. See `RequirementAnnotation`. */
  readonly annotation?: RequirementAnnotation;
}

export interface RequirementMentions {
  readonly requirement: Requirement;
  /** How many distinct test files mention this ID at least once. */
  readonly fileCount: number;
  /** Total mentions across all files, including repeats within one file. */
  readonly occurrenceCount: number;
  /** Repo-relative, forward-slashed paths of files that mention it, sorted. */
  readonly files: readonly string[];
}

export interface TraceabilityReport {
  readonly repoRoot: string;
  readonly planPath: string;
  readonly testFilesScanned: number;
  readonly requirements: readonly Requirement[];
  readonly mentions: readonly RequirementMentions[];
}

/**
 * Matches a PLAN.md requirement-table row: `| FR-M12 | S | ... |` or
 * `| NFR-9 | M | ... |`. The first two columns are captured precisely (group
 * 1 = id, group 2 = priority); group 3 captures the *rest of the line* —
 * requirement prose, any further `|`-delimited columns, and a possible
 * trailing annotation, all as one opaque string — so that a requirement's own
 * prose text (which routinely contains more `|`) never confuses which id/
 * priority it belongs to. `parseAnnotation` re-scans group 3 on its own.
 *
 * Deliberately does NOT match the header row (`| ID | Pri | ... |`): "ID" and
 * "Pri" are not `FR-*`/`NFR-*` tokens, so it is excluded structurally rather
 * than by special-casing the literal header text.
 */
const REQUIREMENT_ROW_PATTERN =
  /^\s*\|\s*((?:FR-[A-Z]+\d+)|(?:NFR-\d+))\s*\|\s*([MSC])\s*\|(.*)$/gm;

/**
 * Matches the optional deliberate annotation trailing a requirement row's own
 * prose, e.g.:
 *
 *   | FR-S8 | C | Ambient detail ... run duration. *(not built: FR-S8/S9 are
 *   explicitly could-have. Ship the honest version first.)* |
 *
 * ## Syntax: `*(<kind>: <reason>)*`
 *
 * - The `*( ... )*` wrapper renders as **visible italic prose** in Markdown,
 *   not an invisible marker. An HTML comment (`<!-- not built -->`) would
 *   also be unmistakable to a parser, but it disappears from rendered
 *   output — exactly the failure mode this exists to avoid, since an
 *   annotation nobody can see go stale is an annotation nobody will notice
 *   *has* gone stale. A bracketed footnote (`[^not-built]`) has the same
 *   problem and additionally implies a footnote definition elsewhere, which
 *   this deliberately does not need.
 * - `<kind>` is one of the two fixed phrases in `AnnotationKind` — "not
 *   built" or "outside the test tree" — not free text, so it can't collide
 *   with ordinary requirement prose (no other row in PLAN.md opens a
 *   parenthetical with either exact phrase followed by a colon) and can't
 *   silently grow a third, unvetted kind.
 * - `<reason>` is mandatory: everything after the colon up to the closing
 *   `)*`, trimmed. `parseAnnotation` throws if it is empty after trimming,
 *   rather than treating a reason-less marker as "no annotation" or as a
 *   valid-but-empty one. Silently ignoring it was the other option
 *   considered: it would make a typo (`*(not built)*`, colon forgotten) fail
 *   *open* — the row goes back to being counted as an unexplained gap, which
 *   is at least safe, but the human who wrote the marker gets no signal that
 *   it did nothing. Throwing fails loud instead, the same choice FR-R2 makes
 *   for a missing frontmatter field: a malformed annotation is a document
 *   defect, and a script that quietly shrugged past it here would print a
 *   confidently blank annotations section while the actual PLAN.md defect
 *   sat there unfixed indefinitely. `<reason>` cannot itself contain `)` —
 *   the capture stops at the first one — which every reason below respects.
 */
const ANNOTATION_PATTERN = /\*\(\s*(not built|outside the test tree)\s*(?::\s*([^)]*))?\)\*/;

/**
 * Parse (at most) one `RequirementAnnotation` out of a requirement row's
 * trailing text (`REQUIREMENT_ROW_PATTERN`'s group 3). Returns `undefined`
 * when the row carries no annotation at all — the overwhelming majority of
 * rows. Throws when the row has an annotation marker but no usable reason;
 * see `ANNOTATION_PATTERN`'s doc comment for why that is fatal rather than
 * silently ignored.
 */
function parseAnnotation(id: string, rowText: string): RequirementAnnotation | undefined {
  const match = ANNOTATION_PATTERN.exec(rowText);
  if (match === null) return undefined;

  const label = match[1];
  const reason = match[2]?.trim();

  if (label === undefined || reason === undefined || reason === '') {
    throw new Error(
      `${id}'s PLAN.md row has an annotation marker with no reason ` +
        `("*(${label ?? '...'}: ...)*"). The reason is mandatory — either write one ` +
        `or remove the marker entirely.`,
    );
  }

  const kind: AnnotationKind = label === 'not built' ? 'not-built' : 'outside-test-tree';
  return { kind, reason };
}

/**
 * Parse every requirement ID, priority, and optional annotation out of
 * PLAN.md's markdown tables.
 *
 * **First occurrence wins on a duplicate ID.** PLAN.md numbers each
 * requirement once, so a duplicate is either a document typo or the same ID
 * legitimately reappearing in an unrelated pipe-table row (neither of which
 * this parser can distinguish from the text alone) — throwing on it would
 * make a harmless duplicate line fatal to every other requirement's report,
 * which is a worse failure mode than silently keeping the first reading.
 * (An invalid *annotation*, by contrast, is allowed to be fatal — see
 * `ANNOTATION_PATTERN`'s doc comment for why the two cases are not treated
 * the same way.)
 *
 * Order is PLAN.md's own table order (i.e. the document's section order),
 * which is why callers that print "every requirement" get them grouped by
 * category for free without re-sorting.
 */
export function parseRequirements(planText: string): Requirement[] {
  const seen = new Map<string, Requirement>();
  const pattern = new RegExp(REQUIREMENT_ROW_PATTERN.source, REQUIREMENT_ROW_PATTERN.flags);

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(planText)) !== null) {
    const id = match[1];
    const priority = match[2];
    const rest = match[3] ?? '';
    if (id === undefined || priority === undefined) continue;
    if (seen.has(id)) continue;

    const annotation = parseAnnotation(id, rest);
    seen.set(id, {
      id,
      priority: priority as Priority,
      ...(annotation === undefined ? {} : { annotation }),
    });
  }

  return [...seen.values()];
}

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count mentions of each requirement ID across a set of file contents.
 *
 * Pure by design — takes file contents as a `Map` rather than reading disk
 * itself — so this, the actual counting logic, is testable against fixture
 * strings without touching the real filesystem or the real PLAN.md.
 *
 * Matching uses `\bID\b`, not a plain substring search. `FR-M1` is a prefix of
 * `FR-M10`, `FR-M11` and `FR-M12`; a substring match would count every
 * mention of any of those as also a mention of `FR-M1`. Since every character
 * in an ID after the hyphen is a word character (`\w`), `\b` correctly
 * requires a non-word (or string-boundary) character on both sides of the
 * whole ID, which rejects `FR-M10` as a match for `FR-M1` while still
 * matching `FR-M1` wrapped in parentheses, punctuation, or plain whitespace.
 */
export function countMentions(
  requirements: readonly Requirement[],
  files: ReadonlyMap<string, string>,
): RequirementMentions[] {
  return requirements.map((requirement) => {
    const pattern = new RegExp(`\\b${escapeRegExp(requirement.id)}\\b`, 'g');
    let occurrenceCount = 0;
    const matchedFiles: string[] = [];

    for (const [file, content] of files) {
      const matches = content.match(pattern);
      if (matches === null || matches.length === 0) continue;
      occurrenceCount += matches.length;
      matchedFiles.push(file);
    }

    matchedFiles.sort((a, b) => a.localeCompare(b, 'en'));
    return { requirement, fileCount: matchedFiles.length, occurrenceCount, files: matchedFiles };
  });
}

/**
 * Untested requirement IDs, grouped by priority.
 *
 * A `Record` with fixed `M`/`S`/`C` keys rather than a sorted array, so that
 * "Musts first" is a property of the return type's field order and every
 * caller gets it for free instead of re-implementing the sort.
 *
 * **Annotated requirements are excluded here on purpose.** A requirement
 * marked `*(not built: ...)*` or `*(outside the test tree: ...)*` on its own
 * PLAN.md row already has a documented, human-legible reason for having zero
 * mentions — see `annotatedRequirementMentions` for where those are reported
 * instead. Counting them here too would put the same requirement in two
 * places under two different meanings ("unexplained gap" and "explained on
 * purpose"), and would make this function's count — the number `--strict`
 * gates on for Musts — mean "everything with zero mentions" instead of what
 * it is supposed to mean: "everything with zero mentions *and no one has said
 * why*". Since only Could-priority requirements are annotated today, this
 * exclusion doesn't currently change the Must-priority strict-mode count —
 * but it is the correct behaviour regardless of which priority ends up
 * annotated in the future.
 */
export function zeroMentionIds(mentions: readonly RequirementMentions[]): Record<Priority, string[]> {
  const result: Record<Priority, string[]> = { M: [], S: [], C: [] };
  for (const entry of mentions) {
    if (entry.requirement.annotation !== undefined) continue;
    if (entry.occurrenceCount === 0) result[entry.requirement.priority].push(entry.requirement.id);
  }
  return result;
}

/**
 * The subset of `mentions` whose requirement carries a deliberate annotation
 * — reported separately from `zeroMentionIds`'s genuine gaps, per the module
 * doc comment ("Annotations").
 *
 * Deliberately returns full `RequirementMentions` entries rather than a new,
 * narrower shape: a caller needs both the annotation itself (to print the
 * reason) *and* the mention counts (to detect staleness — see below), and
 * `RequirementMentions` already carries both without inventing a type whose
 * only job is to glue two things back together that were never actually
 * separate.
 *
 * **An annotated requirement with `occurrenceCount > 0` is stale.** The
 * annotation asserted "no test could claim this" (`outside-test-tree`) or
 * "this isn't built yet" (`not-built`); a nonzero mention count means a test
 * now names the ID anyway — either the deferred work got built and tested,
 * or someone started referencing the ID in prose/tests without removing the
 * marker. Either way the annotation no longer matches reality and PLAN.md's
 * row should be revisited. Callers detect this themselves via
 * `entry.occurrenceCount > 0` rather than this function returning a second,
 * pre-filtered "stale" list — one list, checked at the point of use, is
 * simpler than two lists that must stay consistent with each other.
 */
export function annotatedRequirementMentions(
  mentions: readonly RequirementMentions[],
): RequirementMentions[] {
  return mentions.filter((entry) => entry.requirement.annotation !== undefined);
}

/** `error.code` for Node's errno exceptions, without an `any` cast. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `<repoRoot>/packages/*\/src/**\/*.test.ts`, repo-relative and forward-slashed.
 *
 * A package with no `src/` directory (or none yet) contributes nothing rather
 * than failing the whole scan — same tolerance `registry/index.ts`'s
 * `collectMarkdownFiles` extends to a missing directory, for the same reason:
 * one absent package must not make the report about every other one unusable.
 * `node_modules` and `dist` are skipped so a package that has been built, or
 * that vendors a dependency under `src/`, does not get its own compiled or
 * vendored test files double-counted.
 */
async function collectTestFiles(repoRoot: string): Promise<string[]> {
  const packagesDir = path.join(repoRoot, 'packages');

  let packageEntries;
  try {
    packageEntries = await readdir(packagesDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot list packages at ${packagesDir}: ${describeError(error)}`, { cause: error });
  }

  const files: string[] = [];
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    files.push(...(await collectTestFilesUnder(path.join(packagesDir, entry.name, 'src'))));
  }

  files.sort((a, b) => a.localeCompare(b, 'en'));
  return files;
}

/**
 * This script's OWN test file, which is never scanned.
 *
 * A requirement id written in `traceability.test.ts` is fixture data for
 * testing the scanner — a fictional PLAN.md, an assertion that an annotated row
 * stayed untouched, a regression guard naming the id it guards. None of it is
 * evidence that anything is tested, yet the scanner counted all of it, because
 * its own test lives under a scanned package's `src` directory and ends in
 * `.test.ts` like every other file it reads. A tool whose test file can satisfy
 * the tool is measuring itself.
 *
 * That was not hypothetical. When this exclusion was added, FIVE requirements —
 * FR-R1, FR-P1, FR-T1 (all Musts), NFR-10 and FR-S12 — had no claim anywhere
 * except this one file, and had therefore never appeared in the zero-mention
 * list. Three Musts read as covered because the scanner was citing itself.
 *
 * Excluded structurally rather than by asking the test's author to spell ids as
 * `['FR', 'S8'].join('-')`, which is what the file had started doing: that
 * convention works only as long as every future editor knows about it, and the
 * one who does not gets no error — just a quietly inflated report. The rule that
 * needs to hold is "self-reference is not evidence", and it holds here whatever
 * anyone types in that file.
 */
export function isOwnTest(file: string): boolean {
  return path.basename(file) === 'traceability.test.ts';
}

async function collectTestFilesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new Error(`cannot read ${dir}: ${describeError(error)}`, { cause: error });
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...(await collectTestFilesUnder(full)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts') && !isOwnTest(full)) files.push(full);
  }
  return files;
}

export interface TraceabilityOptions {
  repoRoot: string;
}

/**
 * Read PLAN.md and every test file, and build the full report.
 *
 * Separated from `main()` so the file-reading orchestration can be exercised
 * on its own if ever needed, matching `purgeRuns` in `purge.ts` — though this
 * script's own tests exercise `parseRequirements` and `countMentions`
 * directly against fixtures, per the instruction to test the pure functions
 * rather than shell out to the CLI.
 */
export async function buildTraceabilityReport(options: TraceabilityOptions): Promise<TraceabilityReport> {
  const repoRoot = path.resolve(options.repoRoot);
  const planPath = path.join(repoRoot, 'PLAN.md');

  let planText: string;
  try {
    planText = await readFile(planPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${planPath}: ${describeError(error)}`, { cause: error });
  }

  const requirements = parseRequirements(planText);
  const testFiles = await collectTestFiles(repoRoot);

  const contents = new Map<string, string>();
  for (const file of testFiles) {
    const raw = await readFile(file, 'utf8');
    contents.set(path.relative(repoRoot, file).split(path.sep).join('/'), raw);
  }

  const mentions = countMentions(requirements, contents);

  return { repoRoot, planPath, testFilesScanned: testFiles.length, requirements, mentions };
}

const USAGE = `
Usage: npm run traceability -- [options]

Reads PLAN.md for every FR-*/NFR-* requirement ID and its priority (M/S/C),
then scans packages/*/src/**/*.test.ts for mentions of each ID — in
describe/it titles and in comments — and reports which requirements no test
names at all.

Options:
  --json              Emit the full report as JSON, for piping. Note: the
                      plain "npm run traceability -- --json" form still has
                      npm's own "> pkg script" banner ahead of the object on
                      stdout — that line comes from npm itself, not this
                      script, and package.json cannot suppress it. For output
                      you can pipe straight into JSON.parse, add --silent to
                      the npm invocation ("npm run traceability --silent --
                      --json") or call this file directly ("npx tsx
                      src/scripts/traceability.ts --json").
  --strict            Exit non-zero if any MUST-priority requirement has zero
                      test mentions.
  --repo-root <path>  Repo root to read PLAN.md and packages/ from
                      (default: ${defaultRepoRoot()}).
  -h, --help          Show this message.

ANNOTATIONS. A requirement's own PLAN.md row may carry a trailing marker of
the form "*(<kind>: <reason>)*", where <kind> is one of:

  not built             Consciously deferred — the requirement is real, but
                         nothing has been built for it yet, so no test could
                         claim it.
  outside the test tree Implemented, but its subject is not TypeScript under
                         packages/*/src (a shell script, a Claude Code skill,
                         docs, ...), so no *.test.ts file this scan visits
                         could ever mention it.

<reason> is mandatory — a marker with no reason (or only whitespace after the
colon) is a document defect, and this script throws rather than silently
ignoring it. An annotated requirement is reported in its own section with its
reason, and does NOT count toward "zero-mention requirements" below: that
count means "unexplained gap", not "unexplained-or-explained gap, lumped
together". If an annotated requirement turns out to have mentions after all,
it is flagged STALE — the annotation no longer matches reality (the work got
built, or a test now claims it by name) and should be removed from PLAN.md.

WHAT THIS DOES NOT PROVE. A requirement ID appearing in a test title or
comment is evidence someone intended to test it — not proof the test asserts
anything meaningful, and its absence does not prove the requirement is
untested: solid coverage can exist without ever spelling out an ID. What this
finds is narrower and still real: a requirement nobody has claimed by name
anywhere in the suite. That gap is exactly what let FR-S4 drift from Must to
partially-built with nothing in the tests pointing at it (see PROGRESS.md).
`.trim();

interface CliOptions {
  repoRoot: string;
  json: boolean;
  strict: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  let json = false;
  let strict = false;
  let repoRootFlag: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') return 'help';
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--repo-root') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--repo-root needs a value.\n\n${USAGE}`);
      }
      repoRootFlag = value;
      i += 1;
      continue;
    }
    throw new Error(`unexpected argument "${arg}".\n\n${USAGE}`);
  }

  return {
    repoRoot: path.resolve(repoRootFlag ?? defaultRepoRoot()),
    json,
    strict,
  };
}

function priorityLabel(priority: Priority): string {
  return priority === 'M' ? 'Must' : priority === 'S' ? 'Should' : 'Could';
}

function annotationKindLabel(kind: AnnotationKind): string {
  return kind === 'not-built' ? 'not built' : 'outside the test tree';
}

/**
 * The per-requirement line marker in the "per requirement" listing.
 *
 * Four states, not two, now that annotations exist:
 *   ' ' — mentioned, unannotated: the ordinary, unremarkable case.
 *   '!' — zero mentions, unannotated: a genuine, unexplained gap.
 *   '*' — zero mentions, annotated: expected — see the annotated section.
 *   '?' — mentioned *despite* being annotated: stale, see the annotated
 *         section's STALE note. Distinct from '!' because this is not a
 *         missing-mentions problem, it's a mentions-that-shouldn't-exist-
 *         yet-do problem — the opposite direction of surprise.
 */
function markerFor(entry: RequirementMentions): string {
  const annotated = entry.requirement.annotation !== undefined;
  if (annotated) return entry.occurrenceCount > 0 ? '?' : '*';
  return entry.occurrenceCount === 0 ? '!' : ' ';
}

function printReport(report: TraceabilityReport): void {
  const zero = zeroMentionIds(report.mentions);
  const zeroTotal = zero.M.length + zero.S.length + zero.C.length;
  const annotated = annotatedRequirementMentions(report.mentions);
  const staleAnnotations = annotated.filter((entry) => entry.occurrenceCount > 0);
  const unannotatedTotal = report.requirements.length - annotated.length;

  process.stdout.write(`plan:              ${report.planPath}\n`);
  process.stdout.write(`requirements:      ${report.requirements.length}\n`);
  process.stdout.write(`test files scanned: ${report.testFilesScanned} (packages/*/src/**/*.test.ts)\n\n`);

  process.stdout.write('per requirement (files mentioning it / total occurrences):\n');
  for (const entry of report.mentions) {
    const marker = markerFor(entry);
    process.stdout.write(
      `  ${marker} ${entry.requirement.id.padEnd(8)} [${entry.requirement.priority}]  ` +
        `${String(entry.fileCount).padStart(2)} file(s), ${String(entry.occurrenceCount).padStart(3)} occurrence(s)\n`,
    );
  }

  process.stdout.write(
    `\nannotated requirements (${annotated.length}) — deliberately excluded from the ` +
      'zero-mention count below; see --help:\n',
  );
  if (annotated.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const entry of annotated) {
      // Non-null: every entry in `annotated` came from
      // `annotatedRequirementMentions`, which filters on this being defined.
      const annotation = entry.requirement.annotation;
      if (annotation === undefined) continue;
      const stale =
        entry.occurrenceCount > 0
          ? ` — STALE: ${entry.fileCount} file(s), ${entry.occurrenceCount} occurrence(s); ` +
            'the annotation looks out of date and should be reconsidered'
          : '';
      process.stdout.write(
        `  ${entry.requirement.id.padEnd(8)} [${annotationKindLabel(annotation.kind)}] ` +
          `${annotation.reason}${stale}\n`,
      );
    }
  }

  process.stdout.write(`\nzero-mention requirements (${zeroTotal} of ${unannotatedTotal} unannotated):\n`);
  if (zeroTotal === 0) {
    process.stdout.write('  (none — every unannotated requirement is named by at least one test)\n');
  } else {
    for (const priority of ['M', 'S', 'C'] as const) {
      const ids = zero[priority];
      if (ids.length === 0) continue;
      process.stdout.write(`  ${priorityLabel(priority)} (${ids.length}): ${ids.join(', ')}\n`);
    }
  }

  if (staleAnnotations.length > 0) {
    process.stdout.write(
      `\n${staleAnnotations.length} annotation(s) look stale — see the annotated section above.\n`,
    );
  }

  process.stdout.write(
    '\nA mention is evidence of intent, not proof of coverage — see --help.\n',
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const report = await buildTraceabilityReport({ repoRoot: parsed.repoRoot });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }

  const untestedMusts = zeroMentionIds(report.mentions).M;
  if (parsed.strict && untestedMusts.length > 0) {
    if (!parsed.json) {
      process.stdout.write(
        `\nstrict mode: ${untestedMusts.length} MUST requirement(s) have no test mention: ${untestedMusts.join(', ')}\n`,
      );
    }
    process.exitCode = 1;
  }
}

/**
 * Make a closed downstream pipe silent instead of fatal.
 *
 * Same fix as `diagnostics.ts`'s `tolerateEpipe` and `purge.ts`'s copy, and
 * for the same reason: the per-requirement listing (`printReport`) writes one
 * line per requirement id (FR-* or NFR-*) — easily a hundred-plus lines —
 * which is exactly the kind of report someone pipes into `head` or `grep`.
 * Only `EPIPE` is swallowed; any other stdout write error still propagates.
 */
function tolerateEpipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

/**
 * Only run `main()` when this file is the process entry point.
 *
 * Same guard as `purge.ts`, for the same reason: `buildTraceabilityReport`,
 * `parseRequirements`, `countMentions` and `zeroMentionIds` are exported so
 * `traceability.test.ts` can import them directly, and without this guard
 * that import would also execute `main()` against vitest's own `argv`.
 */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  tolerateEpipe(process.stdout);
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\ntraceability failed.\n\n${message}\n`);
    process.exitCode = 1;
  });
}
