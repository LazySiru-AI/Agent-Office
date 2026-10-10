import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AgentParseError, parseAgentFile } from '../registry/parse.js';

/**
 * AO-10 (security audit, medium): the vendored subagent catalog under
 * `categories/` is loaded by `registry/index.ts` and turned directly into
 * running prompts and tool grants — a file's markdown body becomes a system
 * prompt verbatim, and its `tools:` frontmatter becomes the allowlist the
 * provider layer enforces (see `AgentDefSchema` in `@agent-office/shared`).
 * That file set goes through normal PR review because it is committed rather
 * than fetched at runtime, but review is a weak defence against a `tools:`
 * line quietly gaining `Bash`: inside a 150-line prose diff that reads as
 * "updated agent description", a one-word addition to a YAML key is exactly
 * the kind of change a reviewer's eye slides past. Hashes alone don't fix
 * that — they only prove *something* changed, and everything in this catalog
 * changes application-visible behaviour, so a bare hash mismatch would fire
 * on the most boring typo fix as loudly as on a privilege grant.
 *
 * This script is the other half: it separates "content changed" (`changed`,
 * `added`, `missing` below — an integrity fact, checked by SHA-256) from
 * "the *permission grant* changed" (`toolChanges` — a security fact, checked
 * by diffing the `tools:` list the manifest recorded against the `tools:`
 * list `parseAgentFile` reads from the working tree right now, using the
 * exact same parser the running application uses, so this can never disagree
 * with what the app would actually grant). `verify`'s report prints the
 * privilege delta first and labelled, specifically so it survives being
 * skimmed in a CI log instead of requiring someone to go read a diff.
 *
 * Scope: only the files `registry/index.ts` actually loads — `.md` files
 * under `categories/`, excluding `README.md` (case-insensitive), mirroring
 * `SKIPPED_FILENAMES` there exactly. Per-category `README.md` and
 * `.claude-plugin/plugin.json` files are vendored content too, but they are
 * never turned into a prompt or a tool grant, so they sit outside what this
 * finding is about; hashing them is a reasonable future extension, not done
 * here to keep the manifest's contents legible as "exactly the app's
 * permission surface".
 *
 * Two subcommands, both operating on the same manifest file
 * (`tools/subagent-catalog/catalog-manifest.yaml`):
 *
 *   generate  — walk `categories/`, hash and parse every file, write the
 *               manifest. Run this deliberately, in the same commit as any
 *               intentional catalog change, after reading the `verify`
 *               report's tool-grant delta for that change.
 *   verify    — recompute the same walk and diff it against the committed
 *               manifest. Exits non-zero on any missing/added/changed file or
 *               parse failure, so CI fails loudly rather than silently
 *               shipping a drifted catalog (`.github/workflows/ci.yml` runs
 *               this on every push and PR).
 *
 * Usage:
 *   tsx src/scripts/verifyCatalogManifest.ts generate [repoRoot]
 *   tsx src/scripts/verifyCatalogManifest.ts verify   [repoRoot]
 *
 * `repoRoot` defaults to this file's inferred repo root, or
 * `AGENT_OFFICE_REPO_ROOT` if set — the same convention `scripts/dump.ts`
 * uses. `generate` reads `SUBAGENT_CATALOG_COMMIT` from the environment to
 * stamp the manifest's `sourceCommit` provenance field; if unset it carries
 * the previous manifest's value forward, or `"unrecorded"` if there is none.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/scripts` -> src -> server -> packages -> project root, which holds `categories/`. */
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

const CATEGORIES_DIR_NAME = 'categories';

/** Where the manifest lives, relative to the repo root. Owned by `tools/subagent-catalog/`. */
const MANIFEST_RELATIVE_PATH = path.join('tools', 'subagent-catalog', 'catalog-manifest.yaml');

/** Mirrors `SKIPPED_FILENAMES` in `registry/index.ts` — must stay identical. */
const SKIPPED_FILENAMES = new Set(['readme.md']);

export const UPSTREAM_REPO_URL = 'https://github.com/VoltAgent/awesome-claude-code-subagents';

/** One vendored catalog file's integrity record. */
export interface CatalogFileEntry {
  /** Repo-relative path with forward slashes, e.g. `categories/01-core-development/api-designer.md`. */
  path: string;
  /** SHA-256 of the raw file bytes, hex-encoded. The actual integrity check. */
  sha256: string;
  /**
   * `tools:` frontmatter, parsed exactly as `registry/parse.ts` parses it for
   * the running application. `null` when the file fails to parse — the file
   * is still hashed and tracked, just with no permission grant to compare.
   */
  tools: string[] | null;
  /** `AgentParseError#message` when parsing failed, else `null`. */
  parseError: string | null;
}

export interface CatalogManifest {
  sourceRepo: string;
  /**
   * Best-effort provenance: the upstream commit this file set is understood
   * to correspond to. Informational only, and not itself verified byte-for-
   * byte against every vendored file — the `sha256` entries below are the
   * actual integrity check; this field just answers "where did this come
   * from" for a human bumping the catalog later.
   */
  sourceCommit: string;
  generatedAt: string;
  fileCount: number;
  files: CatalogFileEntry[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Repo-relative with forward slashes. Runs on Windows too — see `registry/index.ts`'s twin. */
function toRepoRelative(filePath: string, repoRoot: string): string {
  return path.relative(path.resolve(repoRoot), path.resolve(filePath)).split(/[\\/]/).join('/');
}

/** Recursively collect `categories/**\/*.md`, skipping `README.md` — identical rule to `registry/index.ts`. */
async function collectCatalogFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectCatalogFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;

    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.md')) continue;
    if (SKIPPED_FILENAMES.has(lower)) continue;

    files.push(full);
  }

  return files;
}

/**
 * Walk `<repoRoot>/categories/`, hashing and parsing every agent file.
 *
 * A file that fails to parse is not skipped: it is hashed and recorded with
 * `tools: null` and a `parseError`, so `verify` still notices it changed
 * (and flags it) rather than silently dropping it from the manifest the way
 * the real registry loader would drop it from the running app.
 */
export async function buildCatalogEntries(repoRoot: string): Promise<CatalogFileEntry[]> {
  const categoriesDir = path.join(repoRoot, CATEGORIES_DIR_NAME);
  const files = await collectCatalogFiles(categoriesDir);
  files.sort((a, b) => a.localeCompare(b, 'en'));

  const entries: CatalogFileEntry[] = [];
  for (const file of files) {
    const raw = await readFile(file);
    const sha256 = sha256Hex(raw);

    let tools: string[] | null = null;
    let parseError: string | null = null;
    try {
      const agent = parseAgentFile(raw.toString('utf8'), file, repoRoot);
      tools = agent.tools;
    } catch (error) {
      parseError = error instanceof AgentParseError ? error.message : String(error);
    }

    entries.push({ path: toRepoRelative(file, repoRoot), sha256, tools, parseError });
  }

  return entries;
}

export function buildManifest(
  entries: CatalogFileEntry[],
  sourceCommit: string,
  generatedAt: string = new Date().toISOString(),
): CatalogManifest {
  return {
    sourceRepo: UPSTREAM_REPO_URL,
    sourceCommit,
    generatedAt,
    fileCount: entries.length,
    files: entries,
  };
}

const MANIFEST_HEADER = `# Per-file SHA-256 manifest for the vendored subagent catalog under \`categories/\`.
#
# Generated by \`packages/server/src/scripts/verifyCatalogManifest.ts generate\`.
# Do not hand-edit: run \`generate\` after an intentional catalog change, and
# read the \`verify\` tool-grant delta report for that change before committing
# this file. See the header comment in \`verifyCatalogManifest.ts\` and
# \`tools/subagent-catalog/README.md\` ("Supply-chain integrity") for why this
# file exists (AO-10).
#
# CI runs \`verify\` on every push and PR and fails the build if any vendored
# file's hash no longer matches an entry below.
`;

export function serializeManifest(manifest: CatalogManifest): string {
  return MANIFEST_HEADER + stringifyYaml(manifest, { sortMapEntries: false });
}

/** Minimal shape check — this file is only ever written by `generate` above, but it is read by `verify`, so a corrupted or hand-edited manifest fails with a clear message instead of a confusing crash deep in `diffCatalog`. */
export function parseManifest(text: string): CatalogManifest {
  const data: unknown = parseYaml(text);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('catalog manifest: expected a YAML mapping at the top level, not a list or scalar');
  }
  const record = data as Record<string, unknown>;

  const sourceRepo = record['sourceRepo'];
  if (typeof sourceRepo !== 'string') {
    throw new Error('catalog manifest: missing or non-string "sourceRepo"');
  }
  const sourceCommit = record['sourceCommit'];
  if (typeof sourceCommit !== 'string') {
    throw new Error('catalog manifest: missing or non-string "sourceCommit"');
  }
  const generatedAt = record['generatedAt'];
  if (typeof generatedAt !== 'string') {
    throw new Error('catalog manifest: missing or non-string "generatedAt"');
  }
  const rawFiles = record['files'];
  if (!Array.isArray(rawFiles)) {
    throw new Error('catalog manifest: missing or non-array "files"');
  }

  const files: CatalogFileEntry[] = rawFiles.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`catalog manifest: files[${index}] is not a mapping`);
    }
    const fileRecord = entry as Record<string, unknown>;
    const filePath = fileRecord['path'];
    const sha256 = fileRecord['sha256'];
    if (typeof filePath !== 'string' || typeof sha256 !== 'string') {
      throw new Error(`catalog manifest: files[${index}] is missing "path" or "sha256"`);
    }
    const tools = fileRecord['tools'];
    if (tools !== null && !Array.isArray(tools)) {
      throw new Error(`catalog manifest: files[${index}].tools must be an array or null`);
    }
    const parseError = fileRecord['parseError'];
    if (parseError !== null && typeof parseError !== 'string') {
      throw new Error(`catalog manifest: files[${index}].parseError must be a string or null`);
    }
    return {
      path: filePath,
      sha256,
      tools: (tools ?? null) as string[] | null,
      parseError: (parseError ?? null) as string | null,
    };
  });

  return {
    sourceRepo,
    sourceCommit,
    generatedAt,
    fileCount: typeof record['fileCount'] === 'number' ? record['fileCount'] : files.length,
    files,
  };
}

/** One file's `tools:` grant before (manifest) and after (working tree). */
export interface ToolGrantChange {
  path: string;
  before: string[] | null;
  after: string[] | null;
  /** Tools present in `after` but not `before` — the privilege-escalation signal. */
  addedTools: string[];
  /** Tools present in `before` but not `after`. */
  removedTools: string[];
}

export interface CatalogDiff {
  /** Recorded in the manifest, no longer present on disk. */
  missing: string[];
  /** On disk, not yet recorded in the manifest. */
  added: string[];
  /** Present in both, but the file's bytes no longer match. */
  changed: Array<{ path: string; manifestSha256: string; actualSha256: string }>;
  /** Subset of `changed` (tools are part of the hashed content) that also changed the `tools:` grant. */
  toolChanges: ToolGrantChange[];
  /** Files that fail to parse right now, whether or not their hash also changed. */
  unparseable: Array<{ path: string; parseError: string }>;
}

/** Compare a manifest against a freshly-walked working tree. Pure — no filesystem access. */
export function diffCatalog(manifest: CatalogManifest, current: CatalogFileEntry[]): CatalogDiff {
  const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));

  const missing = [...manifestByPath.keys()]
    .filter((filePath) => !currentByPath.has(filePath))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const added = [...currentByPath.keys()]
    .filter((filePath) => !manifestByPath.has(filePath))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const changed: CatalogDiff['changed'] = [];
  const toolChanges: ToolGrantChange[] = [];
  const unparseable: CatalogDiff['unparseable'] = [];

  for (const [filePath, currentEntry] of currentByPath) {
    const manifestEntry = manifestByPath.get(filePath);
    if (manifestEntry === undefined) continue; // reported in `added` already

    if (manifestEntry.sha256 !== currentEntry.sha256) {
      changed.push({
        path: filePath,
        manifestSha256: manifestEntry.sha256,
        actualSha256: currentEntry.sha256,
      });
    }

    if (currentEntry.parseError !== null) {
      unparseable.push({ path: filePath, parseError: currentEntry.parseError });
    }

    const before = manifestEntry.tools ?? [];
    const after = currentEntry.tools ?? [];
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const addedTools = after.filter((tool) => !beforeSet.has(tool));
    const removedTools = before.filter((tool) => !afterSet.has(tool));

    if (addedTools.length > 0 || removedTools.length > 0) {
      toolChanges.push({
        path: filePath,
        before: manifestEntry.tools,
        after: currentEntry.tools,
        addedTools,
        removedTools,
      });
    }
  }

  changed.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  toolChanges.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  unparseable.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  return { missing, added, changed, toolChanges, unparseable };
}

export function catalogDiffIsClean(diff: CatalogDiff): boolean {
  return (
    diff.missing.length === 0 &&
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    diff.unparseable.length === 0
  );
}

/**
 * Human- and CI-log-readable report. The tool-grant delta is printed first
 * and labelled `PRIVILEGE ADDED` / `privilege removed` — deliberately louder
 * than the plain integrity sections below it, because that asymmetry (a
 * granted tool is the dangerous direction; a removed one is not) is exactly
 * the thing a generic file-diff view does not surface.
 */
export function formatVerifyReport(diff: CatalogDiff): string {
  const lines: string[] = [];

  lines.push('Catalog manifest verification (AO-10)');
  lines.push('='.repeat(60));

  if (diff.toolChanges.length > 0) {
    lines.push('');
    lines.push(`TOOL-GRANT DELTA — ${diff.toolChanges.length} file(s), review before merging:`);
    lines.push('-'.repeat(60));
    for (const change of diff.toolChanges) {
      lines.push(`  ${change.path}`);
      if (change.addedTools.length > 0) {
        lines.push(`    + PRIVILEGE ADDED:   ${change.addedTools.join(', ')}`);
      }
      if (change.removedTools.length > 0) {
        lines.push(`    - privilege removed: ${change.removedTools.join(', ')}`);
      }
    }
  } else {
    lines.push('');
    lines.push('Tool-grant delta: none. No `tools:` list differs from the manifest.');
  }

  if (diff.changed.length > 0) {
    lines.push('');
    lines.push(`Content changed (hash mismatch) — ${diff.changed.length} file(s):`);
    for (const entry of diff.changed) {
      lines.push(`  ${entry.path}`);
      lines.push(`    manifest: ${entry.manifestSha256}`);
      lines.push(`    actual:   ${entry.actualSha256}`);
    }
  }

  if (diff.added.length > 0) {
    lines.push('');
    lines.push(`On disk but not in the manifest — ${diff.added.length} file(s):`);
    for (const filePath of diff.added) lines.push(`  ${filePath}`);
  }

  if (diff.missing.length > 0) {
    lines.push('');
    lines.push(`In the manifest but missing on disk — ${diff.missing.length} file(s):`);
    for (const filePath of diff.missing) lines.push(`  ${filePath}`);
  }

  if (diff.unparseable.length > 0) {
    lines.push('');
    lines.push(`Fail to parse right now — ${diff.unparseable.length} file(s):`);
    for (const entry of diff.unparseable) lines.push(`  ${entry.path}: ${entry.parseError}`);
  }

  lines.push('');
  if (catalogDiffIsClean(diff)) {
    lines.push('OK: every vendored catalog file matches the manifest.');
  } else {
    lines.push(
      'FAILED. If this catalog change is intentional: read the tool-grant delta above, then run ' +
        '"generate" to refresh the manifest and commit catalog-manifest.yaml in the same change as ' +
        'the catalog files. If it is not intentional, treat it as a supply-chain incident.',
    );
  }

  return lines.join('\n');
}

async function tryReadManifest(manifestPath: string): Promise<CatalogManifest | undefined> {
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch {
    return undefined;
  }
  return parseManifest(text);
}

function resolveRepoRoot(argIndex: number): string {
  const fromArgv = process.argv[argIndex];
  if (fromArgv !== undefined && fromArgv.trim() !== '') return path.resolve(fromArgv);

  const fromEnv = process.env['AGENT_OFFICE_REPO_ROOT'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv);

  return DEFAULT_REPO_ROOT;
}

async function runGenerate(repoRoot: string, manifestPath: string): Promise<void> {
  const previous = await tryReadManifest(manifestPath);
  const sourceCommit =
    process.env['SUBAGENT_CATALOG_COMMIT'] ?? previous?.sourceCommit ?? 'unrecorded';

  const entries = await buildCatalogEntries(repoRoot);
  const manifest = buildManifest(entries, sourceCommit);
  await writeFile(manifestPath, serializeManifest(manifest), 'utf8');

  process.stdout.write(
    `wrote ${manifest.files.length} entries to ${toRepoRelative(manifestPath, repoRoot)} ` +
      `(sourceCommit: ${sourceCommit})\n`,
  );
}

async function runVerify(repoRoot: string, manifestPath: string): Promise<void> {
  const manifest = await tryReadManifest(manifestPath);
  if (manifest === undefined) {
    process.stderr.write(
      `catalog manifest not found at ${toRepoRelative(manifestPath, repoRoot)}. ` +
        'Run "generate" first.\n',
    );
    process.exitCode = 1;
    return;
  }

  const current = await buildCatalogEntries(repoRoot);
  const diff = diffCatalog(manifest, current);
  process.stdout.write(`${formatVerifyReport(diff)}\n`);

  if (!catalogDiffIsClean(diff)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const repoRoot = resolveRepoRoot(3);
  const manifestPath = path.join(repoRoot, MANIFEST_RELATIVE_PATH);

  if (mode === 'generate') {
    await runGenerate(repoRoot, manifestPath);
    return;
  }
  if (mode === 'verify') {
    await runVerify(repoRoot, manifestPath);
    return;
  }

  process.stderr.write(
    'usage: verifyCatalogManifest.ts <generate|verify> [repoRoot]\n' +
      '  generate  regenerate the catalog manifest from the current working tree\n' +
      '  verify    diff the working tree against the committed manifest (used by CI)\n',
  );
  process.exitCode = 2;
}

/**
 * Only run as a CLI when this file is the process entrypoint. The test suite
 * imports the functions above directly; without this guard, that import
 * would also execute `main()` — reading real argv, touching the real
 * filesystem, and setting `process.exitCode` as a side effect of loading the
 * module under test.
 */
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nverifyCatalogManifest failed.\n\n${message}\n`);
    process.exitCode = 1;
  });
}
