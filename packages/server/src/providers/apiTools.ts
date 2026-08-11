import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UnsafePathError } from '../store/types.js';
import { assertSafeRelativePath } from '../store/util.js';

/**
 * Filesystem tools for the raw-API providers (Phase 7: Anthropic, OpenAI,
 * DeepSeek).
 *
 * The Claude Code CLI ships its own `Read`/`Write`/`Edit`/`Glob`/`Grep`
 * built-ins and enforces its own sandbox around them (see
 * `claude-code/tools.ts` for how that adapter maps a catalog agent's
 * `tools:` frontmatter onto those built-ins). A raw chat-completions API has
 * none of that: it can propose a tool call, but something has to actually
 * open the file, and that something is this module.
 *
 * That makes this the module NFR-1 ("a provider must not read or write
 * outside `workspaceDir`") lives or dies on for Phase 7. There is no CLI
 * process, no OS-level jail, no second opinion — every containment check
 * below is the only thing standing between an LLM-authored path and the rest
 * of this machine.
 *
 * ## Naming
 *
 * Tool names (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS`) deliberately
 * match the catalog's own PascalCase vocabulary used throughout
 * `claude-code/tools.ts`, so an agent's `tools: [Read, Grep]` frontmatter
 * means the same thing regardless of which provider ends up running it.
 *
 * ## Path convention
 *
 * Every path a tool accepts is interpreted as relative to `workspaceDir` —
 * never absolute, never drive-relative, never a UNC share. This mirrors
 * `store/util.ts`'s `assertSafeRelativePath`, which this module reuses
 * directly rather than re-deriving the same string-level checks (see that
 * function's own doc comment for the traversal/control-character/absolute-
 * path cases it already rejects). A model that sends an absolute path gets a
 * clear, retryable error, not a silent reinterpretation as "inside the
 * workspace" — accepting `C:\...\workspaceDir\file.txt` as equivalent to
 * `file.txt` would work today but invites the model to start trusting
 * absolute paths it half-remembers from elsewhere, which is exactly the habit
 * that turns into an escape the day it remembers wrong.
 *
 * ## Why `assertSafeRelativePath` is not enough on its own
 *
 * `assertSafeRelativePath` is a purely lexical check: it normalises `.`/`..`
 * segments and rejects anything that string-walks outside the base. That is
 * necessary but not sufficient here, because a workspace can contain a
 * *symlink* whose target lives outside it. A lexical check sees
 * `workspaceDir/link.txt` and calls it safe; the filesystem then happily
 * follows `link.txt` to `C:\Users\...\.ssh\id_rsa`. Defeating that requires
 * asking the OS what a path *actually* resolves to (`fs.realpath`) and
 * comparing THAT against the workspace's real path — see
 * {@link resolveSandboxedTarget} and {@link verifyRealContainment}. Every
 * `Read`/`Write`/`Edit` call pays for that extra `realpath` round trip
 * deliberately; skipping it for "obviously fine" paths is exactly the kind of
 * shortcut that makes a sandbox look correct in every test but the one that
 * matters.
 *
 * `Glob`/`Grep`/`LS` take a different, cheaper route to the same guarantee:
 * they walk the directory tree themselves starting from the workspace root
 * and simply never descend into a symlinked entry ({@link walk}). Since the
 * walk can only ever produce paths it visited, and it never visits through a
 * symlink, nothing it returns can be outside the workspace — no realpath
 * comparison is needed for those three because there is no attacker-supplied
 * path to check in the first place, only an attacker-supplied *pattern* being
 * tested against paths this module already knows are safe.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** A tool as described to a model. `inputSchema` is JSON Schema. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  /** What the model sees. On error, an explanation it can act on. */
  content: string;
  isError: boolean;
}

export interface SandboxedTools {
  /** Schemas for the subset of `allowedTools` this module implements. */
  schemas(allowedTools: readonly string[]): ToolSchema[];
  /** Execute one call. Never throws; failures come back as `isError` results. */
  execute(name: string, input: unknown): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Output caps (NFR-5: an uncapped tool result is a cost and context blowout)
// ---------------------------------------------------------------------------

/** Read: refuse to load a file this large into memory at all. */
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
/** Read: how many lines are returned when the caller does not ask for a range. */
const DEFAULT_READ_LIMIT_LINES = 2000;
/** Read: a single very long line (minified JS, a log blob) is truncated to this. */
const MAX_READ_LINE_CHARS = 2000;
/** Read: final safety net on the whole returned string, independent of the line caps. */
const MAX_READ_OUTPUT_CHARS = 200_000;

/** Write: refuse to accept more content than this in one call. */
const MAX_WRITE_CHARS = 5 * 1024 * 1024; // ~5 MiB of text
/** Edit: refuse to load a file this large for an exact-string replacement. */
const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024;

/** Glob/Grep: stop walking after visiting this many directory entries, matched or not. */
const MAX_WALK_ENTRIES = 50_000;
/** Glob: cap the number of matching paths returned. */
const MAX_GLOB_RESULTS = 500;

/** Grep: skip any individual file bigger than this rather than loading it whole. */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
/** Grep: cap the number of `path:line: text` results returned. */
const MAX_GREP_MATCHES = 200;
/** Grep: cap each matched line's text so one huge line can't dominate the output. */
const MAX_GREP_LINE_CHARS = 300;
/**
 * Grep: wall-clock budget for the whole search, checked between files and
 * between lines in {@link grepWalk}. This bounds an honest search over a lot
 * of legitimate content — it does NOT and cannot bound a single pathological
 * `regex.test()` call, because JS gives no way to interrupt a `RegExp` once
 * `.test()` has started; a check on either side of a call already in progress
 * never gets to run until that call returns on its own. Catastrophic
 * backtracking is refused before compilation instead — see
 * {@link hasCatastrophicBacktrackingShape} — so this budget's job is only ever
 * "a lot of matching to do," never "one match that will not finish." That
 * division of labour holds for every shape the gate recognises; the shapes it
 * does not are enumerated on the gate itself.
 */
const MAX_GREP_MS = 5_000;

/** LS: cap the number of entries listed. */
const MAX_LS_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Sandbox core
// ---------------------------------------------------------------------------

/** Successful resolution: an absolute path confirmed to live inside the workspace. */
interface ResolvedTarget {
  ok: true;
  absPath: string;
}

interface RejectedTarget {
  ok: false;
  /** Safe to show the model verbatim: never includes an out-of-workspace absolute path. */
  message: string;
}

type TargetResolution = ResolvedTarget | RejectedTarget;

/**
 * Resolve a model-supplied path against `workspaceDir`, rejecting anything
 * that is not safely contained.
 *
 * Two layers, both required (see the module doc comment):
 *
 * 1. Lexical: reuses `assertSafeRelativePath` for traversal, absolute-path,
 *    drive-letter/UNC and control-character rejection.
 * 2. Real: resolves symlinks on whatever portion of the path already exists
 *    on disk and re-checks containment, so a symlink planted inside the
 *    workspace cannot point the operation somewhere else.
 *
 * `allowRoot` exists only for `LS`, which is legitimately allowed to list the
 * workspace root itself (`path` omitted). `Read`/`Write`/`Edit` always pass
 * `false`: "operate on the workspace directory itself" is never a sensible
 * request for a file-shaped tool, and treating the root as a valid *file*
 * target is exactly the `startsWith`-style bug (the base directory `foo`
 * satisfying a check meant for paths *under* `foo`) the brief calls out.
 */
async function resolveSandboxedTarget(
  workspaceDir: string,
  rawPath: string,
  allowRoot: boolean,
): Promise<TargetResolution> {
  const base = path.resolve(workspaceDir);
  const trimmed = rawPath.trim();

  let relative: string;
  if (trimmed === '' || trimmed === '.') {
    if (!allowRoot) {
      return {
        ok: false,
        message:
          'refusing to use the workspace root itself as a file target; name a file or subdirectory',
      };
    }
    relative = '';
  } else {
    try {
      relative = assertSafeRelativePath(trimmed);
    } catch (error) {
      if (error instanceof UnsafePathError) {
        return {
          ok: false,
          message: `refusing path "${rawPath}": it is absolute, drive-relative, escapes the workspace with "..", or contains a control character`,
        };
      }
      throw error;
    }
  }

  const absPath = relative === '' ? base : path.resolve(base, relative);

  const containment = await verifyRealContainment(base, absPath);
  if (!containment.ok) return containment;

  return { ok: true, absPath };
}

/**
 * Confirm `target` is really inside `base` once symlinks are followed.
 *
 * `target` may not exist yet (a `Write` to a new file): `fs.realpath` throws
 * `ENOENT` on a path that is not fully on disk, so this walks up to the
 * nearest ancestor that DOES exist, resolves symlinks on that ancestor only,
 * and checks containment there. That is sufficient — a path segment that
 * does not exist cannot be a symlink, so nothing below the nearest existing
 * ancestor can smuggle an escape in. Once a caller does write the file, that
 * segment becomes a plain file the OS just created inside a directory this
 * check already confirmed is inside the workspace.
 *
 * Comparison is done with `path.relative` rather than `String.startsWith`
 * (the classic bug: `/runs/abc` vs `/runs/abc-evil` share a string prefix
 * but are unrelated directories) and, on `win32`, after lowercasing both
 * sides. The lowercasing is defence in depth rather than a fix for an
 * observed hole: `fs.realpath` already returns the filesystem's own
 * canonical casing for anything that exists on disk, so both sides of this
 * comparison are normally case-consistent before the `toLowerCase()` ever
 * runs. It stays in because "normally" is not "always" — a mocked or
 * network filesystem could behave differently — and the cost of the extra
 * lowercasing is nothing next to the cost of getting it wrong.
 */
async function verifyRealContainment(base: string, target: string): Promise<TargetResolution> {
  const ancestor = await nearestExistingAncestor(target);

  const realBase = await realpathOrSelf(base);
  const realAncestor = await realpathOrSelf(ancestor);

  const onWindows = process.platform === 'win32';
  const lhs = onWindows ? realBase.toLowerCase() : realBase;
  const rhs = onWindows ? realAncestor.toLowerCase() : realAncestor;

  const rel = path.relative(lhs, rhs);
  const escapes = rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  if (escapes) {
    return {
      ok: false,
      message:
        'refusing path: it resolves outside the workspace once symlinks are followed (a symlink inside the workspace points elsewhere)',
    };
  }

  return { ok: true, absPath: target };
}

/** `fs.realpath`, falling back to the input unchanged if the path cannot be resolved. */
async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch {
    return target;
  }
}

/** Walk up from `target` until an ancestor that exists on disk is found. */
async function nearestExistingAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await fsp.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current; // reached a filesystem root; give up gracefully
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Zod input schemas (models send malformed input eventually)
// ---------------------------------------------------------------------------

const ReadInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

const WriteInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
});

const EditInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  oldText: z.string().min(1, 'oldText must not be empty'),
  newText: z.string(),
});

const GlobInputSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
});

const GrepInputSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  glob: z.string().optional(),
});

const LsInputSchema = z.object({
  path: z.string().optional(),
});

/** Render a zod failure as a `ToolResult` the model can act on (fix the call, retry). */
function invalidInput(toolName: string, error: z.ZodError): ToolResult {
  const detail = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  return { isError: true, content: `${toolName}: invalid input — ${detail}` };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function handleRead(workspaceDir: string, input: unknown): Promise<ToolResult> {
  const parsed = ReadInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput('Read', parsed.error);
  const { path: rawPath, offset, limit } = parsed.data;

  const target = await resolveSandboxedTarget(workspaceDir, rawPath, false);
  if (!target.ok) return { isError: true, content: `Read: ${target.message}` };

  let stat;
  try {
    stat = await fsp.stat(target.absPath);
  } catch {
    return { isError: true, content: `Read: "${rawPath}" does not exist in the workspace.` };
  }
  if (stat.isDirectory()) {
    return { isError: true, content: `Read: "${rawPath}" is a directory, not a file. Use LS instead.` };
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    return {
      isError: true,
      content: `Read: "${rawPath}" is ${stat.size} bytes, over the ${MAX_READ_FILE_BYTES}-byte cap. Use Grep to search it instead of reading it whole.`,
    };
  }

  const buffer = await fsp.readFile(target.absPath);
  if (buffer.includes(0)) {
    return {
      isError: true,
      content: `Read: "${rawPath}" looks like a binary file (contains a NUL byte); Read only supports text.`,
    };
  }

  const allLines = buffer.toString('utf8').split(/\r\n|\r|\n/);
  const startLine = offset ?? 0;
  const lineLimit = limit ?? DEFAULT_READ_LIMIT_LINES;
  const slice = allLines.slice(startLine, startLine + lineLimit);

  const truncatedLines = slice.map((line) =>
    line.length > MAX_READ_LINE_CHARS
      ? `${line.slice(0, MAX_READ_LINE_CHARS)}… [line truncated, ${line.length} chars total]`
      : line,
  );

  let content = truncatedLines.join('\n');
  const coveredThroughEnd = startLine + slice.length >= allLines.length;
  const notes: string[] = [];
  if (!coveredThroughEnd) {
    notes.push(
      `showing lines ${startLine + 1}-${startLine + slice.length} of ${allLines.length}; pass a larger offset to continue`,
    );
  }
  if (content.length > MAX_READ_OUTPUT_CHARS) {
    content = `${content.slice(0, MAX_READ_OUTPUT_CHARS)}…`;
    notes.push(`output truncated at ${MAX_READ_OUTPUT_CHARS} characters`);
  }
  if (notes.length > 0) {
    content += `\n\n[Read: ${notes.join('; ')}]`;
  }

  return { content, isError: false };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function handleWrite(workspaceDir: string, input: unknown): Promise<ToolResult> {
  const parsed = WriteInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput('Write', parsed.error);
  const { path: rawPath, content } = parsed.data;

  if (content.length > MAX_WRITE_CHARS) {
    return {
      isError: true,
      content: `Write: content is ${content.length} characters, over the ${MAX_WRITE_CHARS}-character cap. Write it in smaller pieces.`,
    };
  }

  const target = await resolveSandboxedTarget(workspaceDir, rawPath, false);
  if (!target.ok) return { isError: true, content: `Write: ${target.message}` };

  const existingStat = await fsp.stat(target.absPath).catch(() => undefined);
  if (existingStat?.isDirectory() === true) {
    return { isError: true, content: `Write: "${rawPath}" is an existing directory; cannot overwrite it as a file.` };
  }

  await fsp.mkdir(path.dirname(target.absPath), { recursive: true });
  await fsp.writeFile(target.absPath, content, 'utf8');

  const verb = existingStat === undefined ? 'created' : 'overwrote';
  return { content: `Write: ${verb} "${rawPath}" (${content.length} characters).`, isError: false };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

async function handleEdit(workspaceDir: string, input: unknown): Promise<ToolResult> {
  const parsed = EditInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput('Edit', parsed.error);
  const { path: rawPath, oldText, newText } = parsed.data;

  const target = await resolveSandboxedTarget(workspaceDir, rawPath, false);
  if (!target.ok) return { isError: true, content: `Edit: ${target.message}` };

  let stat;
  try {
    stat = await fsp.stat(target.absPath);
  } catch {
    return {
      isError: true,
      content: `Edit: "${rawPath}" does not exist. Use Write to create a new file.`,
    };
  }
  if (stat.isDirectory()) {
    return { isError: true, content: `Edit: "${rawPath}" is a directory, not a file.` };
  }
  if (stat.size > MAX_EDIT_FILE_BYTES) {
    return {
      isError: true,
      content: `Edit: "${rawPath}" is ${stat.size} bytes, over the ${MAX_EDIT_FILE_BYTES}-byte cap for exact-string edits.`,
    };
  }

  const original = await fsp.readFile(target.absPath, 'utf8');

  // Ambiguity is worse than an error: silently rewriting the "wrong" one of
  // several identical matches corrupts the file in a way the model has no
  // way to detect from the tool result alone. Fail loudly instead — the
  // model can retry with more surrounding context to make oldText unique.
  const occurrences = countOccurrences(original, oldText);
  if (occurrences === 0) {
    return { isError: true, content: `Edit: oldText was not found in "${rawPath}". No changes were made.` };
  }
  if (occurrences > 1) {
    return {
      isError: true,
      content: `Edit: oldText appears ${occurrences} times in "${rawPath}", which is ambiguous. Include more surrounding context so it matches exactly once. No changes were made.`,
    };
  }

  const updated = original.replace(oldText, () => newText);
  if (updated.length > MAX_WRITE_CHARS) {
    return {
      isError: true,
      content: `Edit: the resulting file would be ${updated.length} characters, over the ${MAX_WRITE_CHARS}-character cap. No changes were made.`,
    };
  }

  await fsp.writeFile(target.absPath, updated, 'utf8');
  return { content: `Edit: replaced 1 occurrence in "${rawPath}".`, isError: false };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Directory walk shared by Glob, Grep and LS
// ---------------------------------------------------------------------------

interface WalkFile {
  /** Forward-slash, workspace-relative path. */
  relPath: string;
  absPath: string;
}

/**
 * Depth-first walk of every regular file under `root`, skipping directory
 * entries that are symlinks entirely — never descended into, never reported.
 *
 * This is the whole containment argument for Glob/Grep/LS: the walk only
 * ever visits paths it reached by reading real (non-symlink) directory
 * entries starting from `root`, so nothing it hands back can be outside the
 * workspace regardless of what pattern the caller searched for.
 */
async function walk(
  root: string,
  onFile: (file: WalkFile) => void,
): Promise<{ truncated: boolean }> {
  let scanned = 0;
  let truncated = false;

  async function recurse(dirAbs: string, dirRel: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race with a delete): skip, don't fail the walk
    }

    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue; // never follow a symlink out of the sandbox

      scanned += 1;
      if (scanned > MAX_WALK_ENTRIES) {
        truncated = true;
        return;
      }

      const relPath = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      const absPath = path.join(dirAbs, entry.name);

      if (entry.isDirectory()) {
        await recurse(absPath, relPath);
      } else if (entry.isFile()) {
        onFile({ relPath, absPath });
      }
    }
  }

  await recurse(root, '');
  return { truncated };
}

// ---------------------------------------------------------------------------
// Glob-to-RegExp (deliberately minimal: `*`, `**`, `?` only)
// ---------------------------------------------------------------------------

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Compile a glob pattern into an anchored `RegExp` tested against
 * forward-slash, workspace-relative paths.
 *
 * Deliberately minimal — `*` (within one path segment), `**` (across any
 * number of segments, including zero) and `?` (one character). No brace
 * expansion, no character classes. This is a search convenience, not a
 * security boundary: the boundary is that {@link walk} only ever visits
 * files inside the workspace in the first place, so an "overly permissive"
 * pattern can at worst return more of the workspace than intended, never
 * anything outside it. Returns `null` if the pattern does not compile to a
 * valid `RegExp` (which, given the escaping below, should only happen for a
 * pattern so pathological it is not worth diagnosing further).
 */
function compileGlob(pattern: string): RegExp | null {
  const normalised = pattern.split('\\').join('/');
  let regexStr = '^';
  let i = 0;

  while (i < normalised.length) {
    const c = normalised[i];
    if (c === '*' && normalised[i + 1] === '*') {
      if (normalised[i + 2] === '/') {
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') {
      regexStr += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      regexStr += '[^/]';
      i += 1;
      continue;
    }
    regexStr += (c ?? '').replace(REGEX_SPECIAL, '\\$&');
    i += 1;
  }
  regexStr += '$';

  try {
    return new RegExp(regexStr);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

async function handleGlob(workspaceDir: string, input: unknown): Promise<ToolResult> {
  const parsed = GlobInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput('Glob', parsed.error);

  const matcher = compileGlob(parsed.data.pattern);
  if (matcher === null) {
    return { isError: true, content: `Glob: "${parsed.data.pattern}" is not a supported pattern.` };
  }

  const base = path.resolve(workspaceDir);
  const matches: string[] = [];
  const { truncated } = await walk(base, (file) => {
    if (matches.length >= MAX_GLOB_RESULTS) return;
    if (matcher.test(file.relPath)) matches.push(file.relPath);
  });

  matches.sort((a, b) => a.localeCompare(b, 'en'));

  const notes: string[] = [];
  if (matches.length >= MAX_GLOB_RESULTS) {
    notes.push(`showing first ${MAX_GLOB_RESULTS} matches; narrow the pattern for more`);
  }
  if (truncated) {
    notes.push(`stopped after scanning ${MAX_WALK_ENTRIES} workspace entries; results may be incomplete`);
  }

  if (matches.length === 0) {
    return { content: `Glob: no files matched "${parsed.data.pattern}".`, isError: false };
  }
  const suffix = notes.length > 0 ? `\n\n[Glob: ${notes.join('; ')}]` : '';
  return { content: matches.join('\n') + suffix, isError: false };
}

// ---------------------------------------------------------------------------
// Grep — catastrophic-backtracking rejection
// ---------------------------------------------------------------------------

/**
 * True if `source` contains a "nested quantifier" — a parenthesised group
 * that is itself repeated (`+`, `*`, or an open-ended `{n,}`) and whose own
 * content also contains an unbounded repetition, e.g. `(a+)+`, `(a*)*`,
 * `(x+y*)+`.
 *
 * This is the textbook engine of catastrophic backtracking, and it is why the
 * `MAX_GREP_MS` deadline below cannot be trusted on its own: `grepWalk` checks
 * `Date.now() > deadline` between files and between lines, but the match
 * itself — `regex.test(line)` — is one synchronous call a JS `RegExp` gives
 * no way to interrupt once started. On `^(a+)+$` against `"a".repeat(40) +
 * "!"`, that single call ran past 120 seconds in testing; the deadline check
 * never got another turn to run because the call it would have interrupted
 * never returned control to it. A budget that can be blown through by one
 * call is not a budget — this function is what makes the budget real, by
 * refusing the pattern before any `.test()` call happens at all.
 *
 * A repeated group is equally lethal when its alternatives OVERLAP, with no
 * inner quantifier anywhere: `(a|a)*` against `"a".repeat(40) + "!"` wedged
 * this process past 25 seconds, and `(a|aa)+` took 6.2 seconds — over the
 * budget this gate exists to make real. The engine is the same in both cases
 * (many distinct ways to divide one input among the repetitions) and only the
 * spelling differs, so the first version of this check — which looked solely
 * for an inner repetition — passed both straight through to `.test()`. Two
 * alternatives can overlap only if they can begin with the same thing, so
 * that is what {@link hasOverlappingAlternation} compares.
 *
 * Deliberately conservative: this is a structural scan of the pattern's
 * *source text*, not an analysis of what it can actually match, so it will
 * refuse some patterns that would in fact run quickly (a literal prefix that
 * narrows the inner repetition, say). That is the right side to err on for a
 * denial-of-service gate — a model that gets a clear "rewrite this pattern"
 * error can retry with something else; a wedged server cannot serve anyone
 * until it is killed.
 *
 * NOT a complete ReDoS detector, and the limits are worth stating rather than
 * leaving a reader to assume the gate is total — no static check over
 * arbitrary regex syntax can be complete, and these are the known holes:
 *
 * - Alternatives that overlap without sharing a first character, e.g.
 *   `(ab|a?b)+`. The first-token comparison cannot see that.
 * - Repetition-free polynomial blowup such as `a*a*a*b`, which has no group at
 *   all. That is quadratic rather than exponential, so `MAX_GREP_MS` — checked
 *   between lines — does still bound it in aggregate.
 *
 * The only complete fix is running the match somewhere it can be killed (a
 * worker thread, whose termination V8 can deliver into a backtracking loop).
 * That is a real architectural change and is recorded in PROGRESS.md rather
 * than pretended away here.
 */
function hasCatastrophicBacktrackingShape(source: string): boolean {
  const masked = maskLiteralRegions(source);
  const groupStarts: number[] = [];

  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(') {
      groupStarts.push(i);
      continue;
    }
    if (c !== ')') continue;
    const start = groupStarts.pop();
    if (start === undefined) continue; // unbalanced — RegExp compilation already rejects this
    if (!isQuantifiedAt(masked, i + 1)) continue;
    if (
      containsUnboundedQuantifier(masked, start + 1, i) ||
      hasOverlappingAlternation(masked, start + 1, i)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Do the top-level alternatives of `masked[from, to)` overlap — can two of them
 * begin with the same thing?
 *
 * Compares first characters of the masked source, which is exactly the right
 * granularity here: `maskLiteralRegions` has already collapsed every escape and
 * character class to `x`, so `\d|\w` compares equal (and they do overlap), while
 * `foo|bar` compares `f` against `b` and is correctly allowed through — a
 * repeated group of genuinely disjoint alternatives is a normal, fast pattern
 * and refusing it would make this gate a nuisance rather than a guard.
 *
 * An empty alternative counts as overlapping too. It makes the group able to
 * match nothing at every position, which is the same "many ways to divide the
 * input" problem wearing a different hat.
 *
 * Only DEPTH-ZERO `|` separates alternatives of this group; a `|` inside a
 * nested group belongs to that group, which the caller's own loop reaches
 * separately on its way out.
 */
function hasOverlappingAlternation(masked: string, from: number, to: number): boolean {
  const firsts: string[] = [];
  let depth = 0;
  let branchStart = from;

  const noteBranch = (end: number): void => {
    const branch = masked.slice(branchStart, end);
    firsts.push(branch.length === 0 ? '' : branch[0] ?? '');
  };

  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === '|' && depth === 0) {
      noteBranch(i);
      branchStart = i + 1;
    }
  }
  noteBranch(to);

  if (firsts.length < 2) return false;
  return new Set(firsts).size < firsts.length;
}

/**
 * Replace escaped pairs (`\+`, `\(`, …) and the bodies of character classes
 * (`[+*()]`, where every one of those is a literal) with neutral `x`
 * characters, length-preserving, so the structural scan above cannot mistake
 * a literal metacharacter for real regex structure.
 */
function maskLiteralRegions(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\' && i + 1 < source.length) {
      out += 'xx';
      i += 2;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j += 1;
      if (source[j] === ']') j += 1; // a leading ] inside a class is literal
      while (j < source.length && source[j] !== ']') {
        j += source[j] === '\\' ? 2 : 1;
      }
      const end = j < source.length ? j + 1 : j;
      out += 'x'.repeat(end - i);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Does an unbounded quantifier (`+`, `*`, or a comma-bearing `{m,}` / `{m,n}`) start at `masked[index]`? */
function isQuantifiedAt(masked: string, index: number): boolean {
  const c = masked[index];
  if (c === '+' || c === '*') return true;
  if (c === '{') {
    const end = masked.indexOf('}', index);
    return end !== -1 && masked.slice(index + 1, end).includes(',');
  }
  return false;
}

/** Does `masked[from, to)` contain an unbounded quantifier anywhere? */
function containsUnboundedQuantifier(masked: string, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (isQuantifiedAt(masked, i)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

async function handleGrep(workspaceDir: string, input: unknown): Promise<ToolResult> {
  const parsed = GrepInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput('Grep', parsed.error);
  const { pattern, glob } = parsed.data;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return {
      isError: true,
      content: `Grep: "${pattern}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Reject before a single `.test()` call happens — see
  // {@link hasCatastrophicBacktrackingShape} for why the deadline below cannot
  // do this job on its own.
  if (hasCatastrophicBacktrackingShape(pattern)) {
    return {
      isError: true,
      content:
        `Grep: "${pattern}" is refused: it repeats a group that can match one input many ` +
        `different ways — either a repetition inside a repetition (e.g. "(a+)+") or ` +
        `alternatives that can start the same way (e.g. "(a|aa)+"). Both can take ` +
        'exponential time on some inputs. Rewrite it so the repeated group has one ' +
        'unambiguous way to match, or search for a literal substring instead.',
    };
  }

  let fileMatcher: RegExp | null = null;
  if (glob !== undefined) {
    fileMatcher = compileGlob(glob);
    if (fileMatcher === null) {
      return { isError: true, content: `Grep: "${glob}" is not a supported glob pattern.` };
    }
  }

  const base = path.resolve(workspaceDir);
  const results: string[] = [];
  let filesSkipped = 0;
  const deadline = Date.now() + MAX_GREP_MS;

  const { truncatedByCap, truncatedByTime, truncatedByMatches } = await grepWalk(
    base,
    regex,
    fileMatcher,
    results,
    deadline,
    () => {
      filesSkipped += 1;
    },
  );

  // `results` never grows past MAX_GREP_MATCHES — grepWalk stops appending
  // once it hits the cap — so there is no further slicing to do here; sorting
  // just gives deterministic, scannable output regardless of directory walk
  // order.
  results.sort();
  const notes: string[] = [];
  if (truncatedByMatches) {
    notes.push(`showing first ${MAX_GREP_MATCHES} matches; narrow the pattern or glob for more`);
  }
  if (truncatedByCap) {
    notes.push(`stopped after scanning ${MAX_WALK_ENTRIES} workspace entries; results may be incomplete`);
  }
  if (truncatedByTime) {
    notes.push(`search stopped after ${MAX_GREP_MS}ms; results may be incomplete — narrow the pattern or glob`);
  }
  if (filesSkipped > 0) {
    notes.push(`skipped ${filesSkipped} file(s) that were binary or over the ${MAX_GREP_FILE_BYTES}-byte cap`);
  }

  if (results.length === 0) {
    const suffix = notes.length > 0 ? ` [Grep: ${notes.join('; ')}]` : '';
    return { content: `Grep: no matches for "${pattern}".${suffix}`, isError: false };
  }
  const suffix = notes.length > 0 ? `\n\n[Grep: ${notes.join('; ')}]` : '';
  return { content: results.join('\n') + suffix, isError: false };
}

/**
 * Walk the workspace searching each visited file for `regex`, respecting the
 * byte, match-count and wall-clock caps.
 *
 * Kept separate from {@link handleGrep} because it needs to interleave the
 * (synchronous) directory walk with (async) file reads — {@link walk}'s
 * callback is synchronous by design so Glob/LS never have to think about
 * ordering, but Grep needs to `await` a file read per visited file, so it
 * re-implements the same walk shape here rather than complicating the shared
 * helper for one caller.
 */
async function grepWalk(
  root: string,
  regex: RegExp,
  fileMatcher: RegExp | null,
  results: string[],
  deadline: number,
  onSkipped: () => void,
): Promise<{ truncatedByCap: boolean; truncatedByTime: boolean; truncatedByMatches: boolean }> {
  let scanned = 0;
  let truncatedByCap = false;
  let truncatedByTime = false;
  // Separate from truncatedByCap (which is about how much of the workspace
  // was scanned): this tracks whether MORE matches existed than the output
  // cap allowed, so the "showing first N of M+" note is only shown when it
  // is actually true, rather than always reading "of N+" once N is reached.
  let truncatedByMatches = false;

  async function recurse(dirAbs: string, dirRel: string): Promise<void> {
    if (truncatedByCap || truncatedByTime) return;
    if (Date.now() > deadline) {
      truncatedByTime = true;
      return;
    }

    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncatedByCap || truncatedByTime) return;
      if (entry.isSymbolicLink()) continue;

      scanned += 1;
      if (scanned > MAX_WALK_ENTRIES) {
        truncatedByCap = true;
        return;
      }
      if (Date.now() > deadline) {
        truncatedByTime = true;
        return;
      }

      const relPath = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      const absPath = path.join(dirAbs, entry.name);

      if (entry.isDirectory()) {
        await recurse(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileMatcher !== null && !fileMatcher.test(relPath)) continue;
      if (results.length >= MAX_GREP_MATCHES) {
        // Already at the output cap. Keep walking (scanned/time caps still
        // apply above) so a search that "would have had more matches" is
        // reported as such, but stop doing the expensive read+line-scan.
        truncatedByMatches = true;
        continue;
      }

      let stat;
      try {
        stat = await fsp.stat(absPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_GREP_FILE_BYTES) {
        onSkipped();
        continue;
      }

      let buffer;
      try {
        buffer = await fsp.readFile(absPath);
      } catch {
        continue;
      }
      if (buffer.includes(0)) {
        onSkipped();
        continue;
      }

      const lines = buffer.toString('utf8').split(/\r\n|\r|\n/);
      for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
        if (results.length >= MAX_GREP_MATCHES) {
          truncatedByMatches = true;
          break;
        }
        const line = lines[lineNo] ?? '';
        // Reset lastIndex defensively: a global-flagged regex is stateful,
        // and reusing one across lines/files without resetting it would skip
        // matches non-deterministically depending on prior calls.
        regex.lastIndex = 0;
        if (regex.test(line)) {
          const text = line.length > MAX_GREP_LINE_CHARS ? `${line.slice(0, MAX_GREP_LINE_CHARS)}…` : line;
          results.push(`${relPath}:${lineNo + 1}: ${text}`);
        }
      }
    }
  }

  await recurse(root, '');
  return { truncatedByCap, truncatedByTime, truncatedByMatches };
}

// ---------------------------------------------------------------------------
// LS
// ---------------------------------------------------------------------------

async function handleLs(workspaceDir: string, input: unknown): Promise<ToolResult> {
  const parsed = LsInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput('LS', parsed.error);

  const target = await resolveSandboxedTarget(workspaceDir, parsed.data.path ?? '', true);
  if (!target.ok) return { isError: true, content: `LS: ${target.message}` };

  let stat;
  try {
    stat = await fsp.stat(target.absPath);
  } catch {
    return { isError: true, content: `LS: "${parsed.data.path ?? '.'}" does not exist in the workspace.` };
  }
  if (!stat.isDirectory()) {
    return { isError: true, content: `LS: "${parsed.data.path ?? '.'}" is a file, not a directory. Use Read instead.` };
  }

  let entries;
  try {
    entries = await fsp.readdir(target.absPath, { withFileTypes: true });
  } catch (error) {
    return {
      isError: true,
      content: `LS: could not list "${parsed.data.path ?? '.'}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const lines = entries
    .map((entry) => {
      if (entry.isSymbolicLink()) return `${entry.name} (symlink, not followed)`;
      if (entry.isDirectory()) return `${entry.name}/`;
      return entry.name;
    })
    .sort((a, b) => a.localeCompare(b, 'en'));

  const capped = lines.slice(0, MAX_LS_ENTRIES);
  const notes: string[] = [];
  if (lines.length > MAX_LS_ENTRIES) {
    notes.push(`showing first ${MAX_LS_ENTRIES} of ${lines.length} entries`);
  }

  if (capped.length === 0) {
    return { content: 'LS: (empty directory)', isError: false };
  }
  const suffix = notes.length > 0 ? `\n\n[LS: ${notes.join('; ')}]` : '';
  return { content: capped.join('\n') + suffix, isError: false };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (workspaceDir: string, input: unknown) => Promise<ToolResult>;
}

const TOOL_DEFS: readonly ToolDefinition[] = [
  {
    name: 'Read',
    description:
      'Read a text file from the workspace. `path` is relative to the workspace root (absolute paths are rejected). Large files are capped; use `offset` (0-based line number) and `limit` (number of lines, default 2000) to page through them.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        offset: { type: 'integer', minimum: 0, description: '0-based line number to start from.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: handleRead,
  },
  {
    name: 'Write',
    description:
      'Create or overwrite a text file in the workspace. `path` is relative to the workspace root. Parent directories are created automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: handleWrite,
  },
  {
    name: 'Edit',
    description:
      'Replace one exact occurrence of `oldText` with `newText` in an existing workspace file. Fails if `oldText` is missing or appears more than once, rather than guessing which occurrence you meant.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        oldText: { type: 'string', description: 'Exact text to find; must match exactly once.' },
        newText: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    handler: handleEdit,
  },
  {
    name: 'Glob',
    description:
      'Find files under the workspace matching a glob pattern (`*`, `**`, `?`). Returns workspace-relative paths, capped and sorted.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts".' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: handleGlob,
  },
  {
    name: 'Grep',
    description:
      'Regex-search text files under the workspace. Returns capped `path:line: text` matches, optionally restricted to files matching `glob`.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        glob: { type: 'string', description: 'Optional glob to restrict which files are searched.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: handleGrep,
  },
  {
    name: 'LS',
    description:
      'List the immediate contents of a workspace directory. `path` defaults to the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path. Defaults to the workspace root.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: handleLs,
  },
];

// ---------------------------------------------------------------------------
// Error-reporting helpers (kept path-blind: see the `execute()` catch-all)
// ---------------------------------------------------------------------------

/** `error.code` for Node's errno exceptions, without an `any` cast. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Best-effort extraction of the caller-supplied `path` from a tool call's raw
 * input, for the `execute()` catch-all to name in its error message. Reads
 * whatever the model sent — unvalidated, unresolved — which is exactly why it
 * is safe to echo: it never became an absolute filesystem path in the first
 * place.
 */
function inputPath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('path' in input)) return undefined;
  const value = (input as { path?: unknown }).path;
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param allowedTools When supplied, `execute` refuses any tool outside it.
 *
 * Optional, but every caller in this repo passes it, and the reason is worth
 * stating. Without it, `schemas()` and `execute()` make *separate* decisions:
 * the allowlist shapes what the model is told about, while execution accepts
 * anything this module implements. A model that has only been offered `Read`
 * can still emit a `Write` call — from a stale context, a hallucination, or a
 * brief that mentioned the word — and it would be carried out. The agent's
 * `tools:` frontmatter is a permission boundary (FR-M5, and `types.ts` says the
 * provider "must not exceed it"), and a boundary enforced only at the point of
 * advertisement is not enforced at all.
 */
export function createSandboxedTools(
  workspaceDir: string,
  allowedTools?: readonly string[],
): SandboxedTools {
  const permitted =
    allowedTools === undefined
      ? undefined
      : new Set(allowedTools.map((name) => name.toLowerCase()));

  return {
    schemas(requested: readonly string[]): ToolSchema[] {
      // `requested` alone used to decide what got advertised, which meant the
      // constructor's `allowedTools` only ever constrained execute() — the two
      // call sites in this repo happen to pass the same list to both, so
      // nothing here ever surfaced, but that was luck, not enforcement. FR-M5
      // says the agent's tools frontmatter is a permission boundary; a model
      // told about a tool it is not permitted to run will still try it, then
      // burn a round trip on the "not available" refusal from execute(). What
      // is advertised must be a subset of what is permitted, not merely equal
      // to it by convention.
      const wanted = new Set(requested.map((name) => name.toLowerCase()));
      return TOOL_DEFS.filter(
        (def) =>
          wanted.has(def.name.toLowerCase()) &&
          (permitted === undefined || permitted.has(def.name.toLowerCase())),
      ).map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      }));
    },

    async execute(name: string, input: unknown): Promise<ToolResult> {
      try {
        const def = TOOL_DEFS.find((d) => d.name.toLowerCase() === name.toLowerCase());
        if (def === undefined) {
          return {
            isError: true,
            content: `Unknown tool "${name}". This executor implements: ${TOOL_DEFS.map((d) => d.name).join(', ')}.`,
          };
        }
        if (permitted !== undefined && !permitted.has(def.name.toLowerCase())) {
          // An error the model can act on, rather than a silent no-op: it
          // should stop trying and say what it could not do, not conclude the
          // write succeeded.
          //
          // The names listed are the canonical ones, not the lowercased set
          // used for matching — telling a model its options are "read, grep"
          // invites it to retry with a name that is not a tool.
          const canonical = TOOL_DEFS.filter((d) => permitted.has(d.name.toLowerCase())).map(
            (d) => d.name,
          );
          return {
            isError: true,
            content:
              `"${def.name}" is not available to this agent. ` +
              `Permitted tools: ${canonical.join(', ') || '(none)'}.`,
          };
        }
        return await def.handler(workspaceDir, input);
      } catch (error) {
        // Belt and braces: the contract promises execute() never throws. Every
        // handler above already catches what it expects to go wrong; this is
        // the net under that net for anything unanticipated.
        //
        // This used to surface `error.message` raw, on the theory that every
        // fs call above only ever targets a path already confirmed to be
        // inside the workspace, so there was nothing to hide. That is true of
        // the check, not the message: an fs error names the path it actually
        // tried, which is the *resolved absolute* one —
        // `ENOENT: ... open 'C:\Users\<name>\...\workspace\<path>'` — not the
        // caller-supplied relative path. And unlike the sibling leak fixed in
        // `server.ts`'s `loadRun` (an HTTP 404 body read by whoever is poking
        // the API), this string is a TOOL RESULT: it goes straight back into
        // the model's context and, for the raw-API providers, over the
        // network to the model vendor. Report the caller-supplied relative
        // path and the error's `code`, never what the path resolved to.
        const rawPath = inputPath(input);
        const code = errorCode(error);
        const where = rawPath === undefined ? '' : ` for "${rawPath}"`;
        const suffix = code === undefined ? '' : ` (${code})`;
        return {
          isError: true,
          content: `"${name}" failed unexpectedly${where}${suffix}.`,
        };
      }
    },
  };
}
