import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addUsage,
  EMPTY_USAGE,
  estimateCostUsd,
  formatCostUsd,
  type AgentEvent,
  type Usage,
} from '@agent-office/shared';
import { ClaudeCodeProvider } from '../providers/claude-code/provider.js';
import { resolveClaudeCodeTools } from '../providers/claude-code/tools.js';
import { loadDotEnv } from '../env.js';
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
 *
 * ## Why there is a `--repo-root` but no `--provider`
 *
 * This CLI's whole reason to exist is to exercise `ClaudeCodeProvider`
 * directly — the doc comment above already says so ("prove the provider
 * seam"), and it always has been the one engine this script drives. Adding
 * `--repo-root` (mirroring `run.ts`'s flag of the same name) was a plain
 * wire-through: the catalog root was hard-coded to `DEFAULT_REPO_ROOT` below
 * with no way to point it elsewhere, exactly the same gap `run.ts` closed.
 *
 * `--provider`, to swap in `../providers/factory.js`'s `makeProvider` the way
 * `run.ts` does, was investigated and DELIBERATELY NOT ADDED. `run.ts` makes
 * one unconditional `makeProvider(id, task, knownAgentNames, options)` call
 * and gets every provider for free — but that only works because `run.ts`
 * never needed `systemPromptMode`. This script's `--replace-prompt` flag
 * *is* `systemPromptMode`, and it is constructed straight into
 * `ClaudeCodeProvider` below — a `ClaudeCodeProvider`-only option that
 * `MakeProviderOptions` (`providers/factory.ts`) has no field for and that
 * no other adapter even has a concept of (the OpenAI/Anthropic adapters just
 * send `request.systemPrompt` as the one system message; there is no CLI
 * default prompt to append to or replace). Routing through `makeProvider`
 * as-is would silently drop `--replace-prompt` for the default provider —
 * exactly the kind of silent corruption this whole pass exists to remove,
 * not introduce. Making it work for real needs `MakeProviderOptions`
 * extended with a `systemPromptMode` field that only the `claude-code`
 * branch consumes — a `providers/factory.ts` change, which is out of scope
 * here (see the task's file allowlist). Left out rather than forced; the
 * fix is one line in `factory.ts` for someone who owns that file.
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
  --repo-root <path>   Catalog root to load the --agent from (default: this
                       repository).
  -h, --help           Show this message.

Note: no --provider here. This probe always runs through the real Claude
Code CLI (ClaudeCodeProvider) — see the module doc comment above for why
--provider was left out rather than force-fitted.
`.trim();

// Exported for `agent.test.ts`, which exercises the argv-parsing fixes below
// directly rather than through a subprocess — see the `isEntryPoint` guard
// at the bottom of this file for why that is now safe to do.
export interface CliOptions {
  task: string;
  agentName: string;
  model?: string;
  maxCostUsd?: number;
  workspace?: string;
  replacePrompt: boolean;
  repoRoot: string;
}

/**
 * Flags that take no value — recognised by name only, `continue`d past
 * without ever looking at `argv[i + 1]`.
 */
const BOOLEAN_FLAGS = new Set(['replace-prompt']);

/** Every other recognised `--flag`, all of which require a following value. */
const VALUE_FLAGS = new Set(['agent', 'model', 'max-cost', 'workspace', 'repo-root']);

/**
 * DEFECT FIXED (P1): a boolean flag swallows the next word into the task.
 *
 * `--replace-prompt` had the identical shape to `run.ts`'s `--quiet` defect —
 * see the long comment above `parseArgs` in `run.ts` for the full story. In
 * short: `continue`ing after setting a boolean flag is correct, but without a
 * known set of flag names to check `--flag` against, a stray word right
 * after it (e.g. someone writing `--replace-prompt true`, thinking it takes
 * a value the way `--max-cost` does) was never claimed by anything and fell
 * straight into `positional.push(arg)` — silently corrupting the one input
 * this whole invocation is built from. Same two-part fix as `run.ts`:
 * `BOOLEAN_FLAGS`/`VALUE_FLAGS` name every recognised flag so an unknown one
 * is rejected outright, and `sawFlag` rejects any bare word arriving after
 * the first flag rather than joining it onto the task.
 */
export function parseArgs(argv: string[]): CliOptions | 'help' {
  // DEFECT FIXED (P3): --help precedence — dedicated first pass over the
  // whole of argv, before any other validation. Same reasoning as `run.ts`'s
  // `parseArgs`: someone reaching for `--help` should get the usage text no
  // matter what else is wrong on the same command line, not a validation
  // error for an unrelated typo that happens to come first in the loop.
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return 'help';
  }

  const positional: string[] = [];
  const flags = new Map<string, string>();
  let sawFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg.startsWith('--')) {
      sawFlag = true;
      const name = arg.slice(2);

      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, 'true');
        continue;
      }

      if (!VALUE_FLAGS.has(name)) {
        throw new Error(`unexpected argument "${arg}".\n\n${USAGE}`);
      }

      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      flags.set(name, value);
      i += 1;
      continue;
    }

    if (sawFlag) {
      // See the module-level comment above `parseArgs` for the defect this
      // rejects. A bare word here is either a boolean flag's dropped value
      // (`--replace-prompt true`, which takes none — `true` is left over) or
      // a genuine typo; neither belongs silently joined onto the task.
      throw new Error(
        `unexpected argument "${arg}" — a flag has already been given, so this can't be part ` +
          `of the task.\n\nThe task must come first, before any --flag, e.g.\n` +
          `  npm run agent -- "review this file" --agent security-auditor\nnot\n` +
          `  npm run agent -- --agent security-auditor "review this file"` +
          `\n\nIf "${arg}" was meant as a value for the flag just before it, note that flag doesn't ` +
          `take one (the only flag(s) here that take no value: ${[...BOOLEAN_FLAGS].map((f) => `--${f}`).join(', ')}; ` +
          `every other flag needs its value directly after it).\n\n${USAGE}`,
      );
    }

    positional.push(arg);
  }

  const task = positional.join(' ').trim();
  if (task.length === 0) throw new Error(`a task is required.\n\n${USAGE}`);

  const maxCost = flags.get('max-cost');
  const parsedCost = maxCost === undefined ? undefined : Number(maxCost);
  if (parsedCost !== undefined && !Number.isFinite(parsedCost)) {
    throw new Error(`--max-cost must be a number, got "${maxCost ?? ''}"`);
  }

  return {
    task,
    agentName: flags.get('agent') ?? 'code-reviewer',
    replacePrompt: flags.get('replace-prompt') === 'true',
    repoRoot: path.resolve(flags.get('repo-root') ?? process.env['AGENT_OFFICE_REPO_ROOT'] ?? DEFAULT_REPO_ROOT),
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
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parsed;

  // Before the provider resolves its key from the environment.
  loadDotEnv(options.repoRoot);

  const registry = await loadRegistry(options.repoRoot);
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
  // DEFECT FIXED (P2): this probe streamed `[usage] in=X out=Y` live per
  // event but never totalled them — the run just ended with "done", with no
  // answer to "so what did that cost". Accumulated with `addUsage`
  // (`@agent-office/shared`) rather than hand-summed `inputTokens +=`/
  // `outputTokens +=`, for the same reason `run.ts` uses `runTotalUsage`
  // instead of its own loop: `addUsage` also folds the cache-read/cache-write
  // split when the adapter reports one, which `costForUsage` needs to price a
  // cached run correctly, and hand-summing only the two obvious fields would
  // silently drop that split, quietly overstating this probe's own cost.
  let usage: Usage = EMPTY_USAGE;
  for await (const event of provider.run({
    assignmentId: 'probe',
    systemPrompt: agent.systemPrompt,
    task: options.task,
    allowedTools: agent.tools,
    workspaceDir: workspace,
    signal: controller.signal,
  })) {
    if (event.t === 'error' && event.fatal) fatal = true;
    if (event.t === 'usage') {
      usage = addUsage(usage, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.cacheReadTokens }),
        ...(event.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.cacheWriteTokens }),
      });
    }
    process.stdout.write(`${render(event)}\n`);
  }

  // Priced against the SAME model the banner above already resolved and
  // printed (`options.model ?? agent.model`) — an explicit `--model` outranks
  // the catalog's standing default, matching `AgentRunRequest.model`'s own
  // doc comment (`providers/types.ts`) on which one wins. `estimateCostUsd`
  // (`@agent-office/shared`) already has the documented answer for an
  // unpriced or absent model: it returns `undefined`, and `formatCostUsd`
  // renders that as `—` rather than a misleading `$0.00` — this probe always
  // runs through the real, paid `ClaudeCodeProvider`, so a silent `$0.00`
  // here would be actively wrong, not just imprecise.
  const model = options.model ?? agent.model;
  const costUsd = estimateCostUsd(usage, model);
  process.stderr.write(
    `\ntokens:    in=${usage.inputTokens} out=${usage.outputTokens}\n` +
      `cost:      ${formatCostUsd(costUsd)} (estimated — NFR-5, not a bill)\n`,
  );
  process.stderr.write(fatal ? 'finished with a fatal error\n' : 'done\n');
  if (fatal) process.exitCode = 1;
}

/**
 * Only run `main()` when this file is the process entry point.
 *
 * Added alongside `agent.test.ts`, which imports `parseArgs` directly —
 * mirrors the identical guard added to `run.ts`, for the identical reason
 * (see that file's comment on this).
 */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    // DEFECT FIXED (P3): error framing differed from every sibling script.
    // `run.ts`, `serve.ts` and `traceability.ts` all print `\n<subject>
    // failed.\n\n<message>\n`; this printed the bare message with no
    // separating blank line and no "what failed" label, which reads
    // differently enough — mid-scrollback, after a wall of streamed events —
    // that a failure here is easy to mistake for one more `[diagnostic]`
    // line rather than the fatal thing it is.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nagent failed.\n\n${message}\n`);
    process.exitCode = 1;
  });
}
