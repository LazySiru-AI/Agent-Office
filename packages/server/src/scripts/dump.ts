import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDef } from '@agent-office/shared';
import {
  buildRosterDigest,
  estimateTokens,
  loadRegistry,
  type Registry,
} from '../registry/index.js';

/**
 * Phase 0 exit criterion: print every indexed agent with its category and tool
 * list, plus a sizing footer for the Manager's roster digest (FR-R3).
 *
 * Usage:
 *   npm run registry:dump            # infer the repo root from this file
 *   npm run registry:dump -- <path>  # explicit repo root
 *
 * The repo root may also be set via AGENT_OFFICE_REPO_ROOT.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/scripts` -> src -> server -> packages -> project root, which holds `categories/`. */
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

function resolveRepoRoot(): string {
  const fromArgv = process.argv[2];
  if (fromArgv !== undefined && fromArgv.trim() !== '') return path.resolve(fromArgv);

  const fromEnv = process.env['AGENT_OFFICE_REPO_ROOT'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv);

  return DEFAULT_REPO_ROOT;
}

function formatAgent(agent: AgentDef): string {
  const model = agent.model === undefined ? '' : `  (model: ${agent.model})`;
  return [
    `  ${agent.name}${model}`,
    `    tools: ${agent.tools.join(', ')}`,
    `    file:  ${agent.filePath}`,
  ].join('\n');
}

function report(registry: Registry, repoRoot: string): string {
  const out: string[] = [];

  out.push(`Agent registry: ${repoRoot}`);
  out.push('');

  const categories = [...registry.byCategory.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  for (const category of categories) {
    const agents = registry.byCategory.get(category) ?? [];
    out.push(`${category}  (${agents.length})`);
    out.push('-'.repeat(Math.max(category.length + 6, 40)));
    for (const agent of agents) {
      out.push(formatAgent(agent));
    }
    out.push('');
  }

  const digest = buildRosterDigest(registry);

  out.push('='.repeat(60));
  out.push('Summary');
  out.push('='.repeat(60));
  out.push(`  agents:      ${registry.agents.length}`);
  out.push(`  categories:  ${categories.length}`);
  for (const category of categories) {
    const count = registry.byCategory.get(category)?.length ?? 0;
    out.push(`    ${category.padEnd(26)} ${String(count).padStart(4)}`);
  }
  out.push('');
  out.push('  Roster digest (fed to the Manager for team selection):');
  out.push(`    characters:       ${digest.length}`);
  out.push(`    estimated tokens: ~${estimateTokens(digest)}  (approximate, not a tokenizer)`);

  return out.join('\n');
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const registry = await loadRegistry(repoRoot);
  process.stdout.write(`${report(registry, repoRoot)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nregistry:dump failed.\n\n${message}\n`);
  process.exitCode = 1;
});
