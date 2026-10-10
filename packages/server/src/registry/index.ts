import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDef } from '@agent-office/shared';
import { AgentParseError, parseAgentFile } from './parse.js';

export { AgentParseError, parseAgentFile } from './parse.js';
export {
  watchRegistry,
  type RegistryWatcher,
  type RegistryWatcherEvent,
  type WatchRegistryOptions,
} from './watch.js';

/** An indexed, queryable view of `categories/**` (FR-R1). */
export interface Registry {
  /** Every agent, ordered by repo-relative file path for determinism. */
  readonly agents: AgentDef[];
  /** Agent name -> definition. Names are unique; see {@link DuplicateAgentName}. */
  readonly byName: ReadonlyMap<string, AgentDef>;
  /** Category directory name -> its agents, in the same order as `agents`. */
  readonly byCategory: ReadonlyMap<string, AgentDef[]>;
  /** Convenience lookup. Returns `undefined` for an unknown name. */
  get(name: string): AgentDef | undefined;
}

export interface DuplicateAgentName {
  readonly name: string;
  /** Repo-relative paths of every file declaring this name. */
  readonly filePaths: string[];
}

/**
 * Aggregate failure for a registry load. Every offending file is reported at
 * once (FR-R2), rather than dying on the first bad one.
 */
export class RegistryLoadError extends Error {
  readonly failures: AgentParseError[];
  readonly duplicates: DuplicateAgentName[];

  constructor(failures: AgentParseError[], duplicates: DuplicateAgentName[]) {
    super(formatRegistryLoadError(failures, duplicates));
    Object.setPrototypeOf(this, RegistryLoadError.prototype);
    this.name = 'RegistryLoadError';
    this.failures = failures;
    this.duplicates = duplicates;
  }
}

/** Directory under the repo root that holds the agent definitions. */
const CATEGORIES_DIR = 'categories';

/** Files that live alongside the agents but are not agents. */
const SKIPPED_FILENAMES = new Set(['readme.md']);

/**
 * Recursively index `<repoRoot>/categories/**\/*.md` into a {@link Registry}.
 *
 * `README.md` files are skipped (FR-R1). Every parse failure is collected and
 * reported together as a {@link RegistryLoadError}, as are duplicate agent
 * names, which would otherwise silently shadow one another in `byName`.
 */
export async function loadRegistry(repoRoot: string): Promise<Registry> {
  const root = path.resolve(repoRoot);
  const categoriesDir = path.join(root, CATEGORIES_DIR);

  let files: string[];
  try {
    files = await collectMarkdownFiles(categoriesDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `{ cause }` to match the `AgentParseError` a few lines below, which has
    // always attached it. One function throwing two errors with two different
    // policies is how a codebase ends up unable to say whether dropping a cause
    // was a decision — and this is the throw that fires when the catalog root is
    // missing entirely, i.e. the first failure a new checkout ever sees.
    throw new Error(`Cannot read agent categories at ${categoriesDir}: ${message}`, {
      cause: error,
    });
  }

  files.sort((a, b) => a.localeCompare(b, 'en'));

  const agents: AgentDef[] = [];
  const failures: AgentParseError[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(new AgentParseError(`cannot read file: ${message}`, file, undefined, {
        cause: error,
      }));
      continue;
    }

    try {
      agents.push(parseAgentFile(raw, file, root));
    } catch (error) {
      failures.push(
        error instanceof AgentParseError
          ? error
          : new AgentParseError(
              `unexpected error while parsing: ${error instanceof Error ? error.message : String(error)}`,
              file,
              undefined,
              { cause: error },
            ),
      );
    }
  }

  const duplicates = findDuplicateNames(agents);
  if (failures.length > 0 || duplicates.length > 0) {
    throw new RegistryLoadError(failures, duplicates);
  }

  return buildRegistry(agents);
}

/** Assemble a {@link Registry} from already-parsed definitions. */
export function buildRegistry(agents: AgentDef[]): Registry {
  const byName = new Map<string, AgentDef>();
  const byCategory = new Map<string, AgentDef[]>();

  for (const agent of agents) {
    byName.set(agent.name, agent);
    const bucket = byCategory.get(agent.category);
    if (bucket === undefined) {
      byCategory.set(agent.category, [agent]);
    } else {
      bucket.push(agent);
    }
  }

  return {
    agents,
    byName,
    byCategory,
    get(name: string): AgentDef | undefined {
      return byName.get(name);
    },
  };
}

/**
 * The roster digest fed to the Manager for team selection (FR-R3): one line per
 * agent, `- <name> [<category>]: <description>`.
 */
export function buildRosterDigest(registry: Registry): string {
  return registry.agents
    .map((agent) => `- ${agent.name} [${agent.category}]: ${agent.description}`)
    .join('\n');
}

/**
 * Rough token count for prompt-budgeting only.
 *
 * This is an APPROXIMATION, not a tokenizer. It assumes ~3.6 characters per
 * token, which is a reasonable average for English prose but will be wrong for
 * code, non-Latin scripts, and long identifiers. Use it to decide whether a
 * prompt is roughly within budget (FR-R3/FR-R4); never use it for billing,
 * hard limits, or anything that must be exact. When a real count is required,
 * ask the provider.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3.6);
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
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

function findDuplicateNames(agents: AgentDef[]): DuplicateAgentName[] {
  const seen = new Map<string, string[]>();
  for (const agent of agents) {
    const bucket = seen.get(agent.name);
    if (bucket === undefined) {
      seen.set(agent.name, [agent.filePath]);
    } else {
      bucket.push(agent.filePath);
    }
  }

  const duplicates: DuplicateAgentName[] = [];
  for (const [name, filePaths] of seen) {
    if (filePaths.length > 1) duplicates.push({ name, filePaths });
  }
  return duplicates.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function formatRegistryLoadError(
  failures: AgentParseError[],
  duplicates: DuplicateAgentName[],
): string {
  const parts: string[] = ['Failed to load the agent registry.'];

  if (failures.length > 0) {
    parts.push('', `${failures.length} file(s) could not be parsed:`);
    for (const failure of failures) {
      parts.push(`  - ${failure.message}`);
    }
  }

  if (duplicates.length > 0) {
    parts.push('', `${duplicates.length} duplicate agent name(s):`);
    for (const duplicate of duplicates) {
      parts.push(`  - "${duplicate.name}" declared in: ${duplicate.filePaths.join(', ')}`);
    }
  }

  return parts.join('\n');
}
