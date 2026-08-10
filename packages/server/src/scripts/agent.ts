import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@agent-office/shared';
import { ClaudeCodeProvider } from '../providers/claude-code/provider.js';
import { resolveClaudeCodeTools } from '../providers/claude-code/tools.js';
import { loadRegistry } from '../registry/index.js';

/**
 * Phase 1 exit-criterion CLI: run **one** agent through the real Claude Code
 * CLI and stream normalised events to stdout.
 *
 *   npm run agent -- "Review this file for security issues"
 *   npm run agent -- "..." --agent security-auditor --max-cost 0.25
 *
 * Deliberately not the orchestrator. PLAN.md asks for one agent against a
 * throwaway task, because the point is to prove the provider seam — spawn,
 * stream, normalise, abort — without the Manager's planning and synthesis calls
 * sitting between the CLI and anything observable.
 *
 * This spends real money. It is the first thing in the project that does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/scripts` -> src -> server -> packages -> project root, which holds `categories/`. */
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

const USAGE = `
Usage: npm run agent -- "<task>" [options]

Options:
  --agent <name>       Agent from the catalog (default: code-reviewer).
  --model <alias>      sonnet | haiku | opus. Omitted means the CLI's default.
  --max-cost <usd>     Hard spend cap for this one invocation (FR-M8).
  --workspace <path>   Sandbox directory (default: a fresh temp directory).
  --replace-prompt     Replace the CLI's system prompt instead of appending.
  -h, --help           Show this message.
`.trim();

interface CliOptions {
  task: string;
  agentName: string;
  model?: string;
  maxCostUsd?: number;
  workspace?: string;
  replacePrompt: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let replacePrompt = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }

    if (arg === '--replace-prompt') {
      replacePrompt = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      flags.set(arg.slice(2), value);
      i += 1;
      continue;
    }

    positional.push(arg);
  }

  const task = positional.join(' ').trim();
  if (task.length === 0) throw new Error('a task is required');

  const maxCost = flags.get('max-cost');
  const parsedCost = maxCost === undefined ? undefined : Number(maxCost);
  if (parsedCost !== undefined && !Number.isFinite(parsedCost)) {
    throw new Error(`--max-cost must be a number, got "${maxCost ?? ''}"`);
  }

  return {
    task,
    agentName: flags.get('agent') ?? 'code-reviewer',
    replacePrompt,
    ...(flags.get('model') === undefined ? {} : { model: flags.get('model') as string }),
    ...(parsedCost === undefined ? {} : { maxCostUsd: parsedCost }),
    ...(flags.get('workspace') === undefined ? {} : { workspace: flags.get('workspace') as string }),
  };
}

/** One line per event, so the stream is readable as it arrives (NFR-3). */
function render(event: AgentEvent): string {
  switch (event.t) {
    case 'text':
      return event.chunk;
    case 'tool':
      return `  · ${event.name}${event.summary.length > 0 ? `: ${event.summary}` : ''}`;
    case 'artifact':
      return `  → wrote ${event.path}`;
    case 'usage':
      return `  [usage] in=${String(event.inputTokens)} out=${String(event.outputTokens)}`;
    case 'status':
      return `  [status] ${event.status}`;
    case 'error':
      return `  ${event.fatal ? '✗ FATAL' : '! warning'}: ${event.message}`;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const registry = await loadRegistry(DEFAULT_REPO_ROOT);
  const agent = registry.byName.get(options.agentName);
  if (agent === undefined) {
    throw new Error(
      `no agent named "${options.agentName}" in the catalog. ` +
        `Try one of: ${[...registry.byName.keys()].slice(0, 5).join(', ')}, ...`,
    );
  }

  const provider = new ClaudeCodeProvider({
    systemPromptMode: options.replacePrompt ? 'replace' : 'append',
    // Diagnostics go to stderr so stdout stays a clean event stream, and so an
    // unrecognised frame after a CLI update is visible rather than dropped.
    onDiagnostic: (message) => process.stderr.write(`  [diagnostic] ${message}\n`),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
  });

  const availability = await provider.isAvailable();
  if (!availability.ok) {
    // The expected failure on a machine that has never signed in. Exiting with
    // the reason beats a stack trace from a spawn that was never going to work.
    process.stderr.write(`provider unavailable: ${availability.reason ?? 'unknown reason'}\n`);
    process.exit(1);
  }

  const workspace = options.workspace ?? (await mkdtemp(path.join(tmpdir(), 'agent-office-run-')));

  const tools = resolveClaudeCodeTools(agent.tools);
  process.stderr.write(
    `agent:     ${agent.name} (${agent.category})\n` +
      `model:     ${options.model ?? agent.model ?? '(cli default)'}\n` +
      `workspace: ${workspace}\n` +
      `tools:     ${tools.resolved.join(', ') || '(none grantable)'}\n` +
      (tools.dropped.length > 0
        ? `dropped:   ${tools.dropped.map((d) => d.requested).join(', ')}\n`
        : '') +
      '\n',
  );

  // Ctrl-C must stop the child, not just this process — otherwise the model
  // call keeps running and keeps billing (FR-M9).
  const controller = new AbortController();
  process.once('SIGINT', () => {
    process.stderr.write('\ncancelling…\n');
    controller.abort();
  });

  let fatal = false;
  for await (const event of provider.run({
    assignmentId: 'probe',
    systemPrompt: agent.systemPrompt,
    task: options.task,
    allowedTools: agent.tools,
    workspaceDir: workspace,
    signal: controller.signal,
  })) {
    if (event.t === 'error' && event.fatal) fatal = true;
    process.stdout.write(`${render(event)}\n`);
  }

  process.stderr.write(fatal ? '\nfinished with a fatal error\n' : '\ndone\n');
  if (fatal) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
