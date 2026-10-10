import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCostUsd, runTotalUsage, type AgentEvent } from '@agent-office/shared';
import { loadRegistry } from '../registry/index.js';
import { loadDotEnv } from '../env.js';
import { DEFAULT_PROVIDER, makeProvider, type MakeProviderOptions } from '../providers/factory.js';
import { DiagnosticsLog } from '../diagnostics/log.js';
import { FileRunStore, defaultRunsRoot } from '../store/fileStore.js';
import { resolveModelPolicy } from '../providers/modelPolicy.js';
import { executeRun } from '../orchestrator/runner.js';
// `estimateRunCostUsd` is the SAME per-assignment cost estimator the PDF/
// markdown report already uses (`reports/deliverable.ts`) — it resolves each
// assignment's catalog model from the registry and prices the Manager's own
// planning/synthesis usage separately, handling the free-provider and
// unpriced-model cases correctly. Re-deriving that arithmetic here, against
// `estimateCostUsd` directly with a single guessed-at model string, would be
// the exact "inventing arithmetic" this fix was told to avoid, and would
// silently disagree with the report's own figure the day either one changed.
import { estimateRunCostUsd } from '../reports/deliverable.js';

/**
 * Phase 2 exit-criterion CLI: run one task end to end.
 *
 *   npm run run -- "Review the auth module for security issues"
 *   npm run run -- "..." --provider scripted --concurrency 2
 *
 * `scripted` costs nothing and is the default. `claude-code` calls the real CLI
 * and spends real money; it reports itself unavailable, with the reason, if the
 * CLI is missing or not signed in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/scripts` -> src -> server -> packages -> project root, which holds `categories/`. */
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

// Exported for `run.test.ts`, which exercises the argv-parsing fixes above
// directly rather than through a subprocess — see the `isEntryPoint` guard
// at the bottom of this file for why that is now safe to do.
export interface CliOptions {
  task: string;
  /** Absolute path to what the task is about. Validated before anything is spent. */
  subjectPath?: string;
  provider: string;
  repoRoot: string;
  runsRoot: string;
  concurrency?: number;
  timeoutMs?: number;
  tokenBudget?: number;
  maxCostUsd?: number;
  quiet: boolean;
}

const USAGE = `
Usage: npm run run -- "<task>" [options]

Options:
  --provider <id>      Engine to run agents through (default: claude-code,
                       which spends real money). 'scripted' is free.
  --concurrency <n>    Parallel assignments per phase (default 3).
  --timeout <ms>       Per-assignment timeout (default 1200000).
  --budget <tokens>    Total run token budget. Unlimited when omitted.
  --max-cost <usd>     Per-assignment spend cap (FR-M8). Unlimited when omitted.
  --subject <path>     The directory this task is ABOUT — a repo, a project, a
                       folder of documents. Stated in the planner's prompt and in
                       every agent's brief, so nobody has to guess where to look.
                       Without it an agent sees only an empty scratch workspace
                       inside THIS checkout, and whether it finds your subject is
                       down to whether it thinks to search for it.
  --repo-root <path>   Subagent catalog root (default: this repository).
  --runs-root <path>   Where run artifacts are written.
  --quiet              Only print the final summary.
  -h, --help           Show this message.
`.trim();

/**
 * How often a `tool` event is allowed to print a line, per assignment.
 *
 * F6 (P2): before this fix, `onEvent` (below, in `main`) forwarded only
 * `status` and `error` events to the console — `text`, `tool`, `usage` and
 * `artifact` all reached the per-assignment `.jsonl` log and nothing else. On
 * a real assignment (the `--provider claude-code` default, spending real
 * money) that meant exactly one line when an assignment started and one when
 * it finished, with nothing at all in between: a 20-minute assignment doing
 * real, billed work was indistinguishable from a hung process, from the one
 * place an operator is actually watching.
 *
 * `tool` is the event type that fixes this. It says "the agent is doing
 * something" without being: the full token stream (`text` — prose destined
 * for the report, not the operator, and voluminous in a way that would drown
 * everything else); a per-chunk accounting event (`usage` — meaningless line
 * by line, and already summarised as a run-level total at the very end of
 * this file); or a filesystem side effect only the report needs (`artifact`
 * — its path is implied by the `artifacts:` line already printed at the end).
 * `tool`'s `summary` field is already the short, human-readable line built
 * for exactly this ("Read src/app.ts"), so no reformatting is needed beyond
 * this file's own `assignmentId.padEnd(24)` prefix convention.
 *
 * Forwarding every `tool` event unfiltered would just trade a hung process
 * for a firehose: a busy agent can call a tool every few hundred
 * milliseconds, and at that rate `tool` lines bury the far rarer
 * `status`/`error` lines a watcher is actually scanning for — the exact
 * failure mode this fix exists to prevent, reappearing in the opposite
 * direction. So `createToolEventThrottle` below caps `tool` output to one
 * line per assignment per `TOOL_LOG_INTERVAL_MS`, always printing the FIRST
 * call for an assignment immediately (a watcher should see activity right
 * away, not wait out a whole interval to learn the run even started) and
 * folding every suppressed call into a "(+N more)" suffix on the next line
 * that does print — so a burst of tool use is never silently invisible, only
 * batched.
 *
 * REJECTED: print every `tool` event verbatim. Fine for a short scripted
 * demo run; the firehose above for a real one.
 * REJECTED: dedupe by tool name with no timing ("Read, Read, Bash..."). Loses
 * exactly the "is it still alive" signal this fix exists to add, and would
 * need a flush-on-idle timer this file has no event loop hook for.
 * REJECTED: throttle by call COUNT (print every Nth call). A fast agent still
 * floods the console early (N calls can happen in milliseconds), and a slow
 * one — real API latency between tool calls — goes silent for an unbounded
 * stretch waiting for its Nth call, which is the opposite of what "can I tell
 * this is still alive" needs. A time-based interval bounds both the
 * console's throughput and the longest a live assignment can go silent,
 * which is the actual property this is fixing.
 *
 * `--quiet` is unaffected either way: `onEvent` (in `main`) returns before
 * this throttle is ever consulted when `options.quiet` is set, so `--quiet`
 * stays exactly as quiet as it always was.
 */
const TOOL_LOG_INTERVAL_MS = 5_000;

/**
 * Build a per-assignment throttle for `tool` console lines (F6, see
 * `TOOL_LOG_INTERVAL_MS` above for the full reasoning).
 *
 * Exported, and taking an injectable clock, so `run.test.ts` can exercise the
 * throttling/suffix logic with a fake `now` instead of real timers — the same
 * reason `resolveSubjectPath` and `parseArgs` are separated from `main`'s own
 * process IO and exported in their own right.
 *
 * Returns a function that, given one `tool` event, returns the line to print
 * or `undefined` to suppress it. State (last-printed time and suppressed
 * count) is keyed by `assignmentId`, so concurrent assignments each get their
 * own independent budget rather than sharing one global throttle that a
 * single busy assignment could starve the others out of.
 */
export function createToolEventThrottle(
  now: () => number = Date.now,
  intervalMs: number = TOOL_LOG_INTERVAL_MS,
): (event: Extract<AgentEvent, { t: 'tool' }>) => string | undefined {
  const lastPrintedAt = new Map<string, number>();
  const suppressedCount = new Map<string, number>();

  return (event) => {
    const timestamp = now();
    const last = lastPrintedAt.get(event.assignmentId);

    if (last !== undefined && timestamp - last < intervalMs) {
      suppressedCount.set(event.assignmentId, (suppressedCount.get(event.assignmentId) ?? 0) + 1);
      return undefined;
    }

    lastPrintedAt.set(event.assignmentId, timestamp);
    const suppressed = suppressedCount.get(event.assignmentId) ?? 0;
    suppressedCount.set(event.assignmentId, 0);
    const suffix = suppressed > 0 ? ` (+${suppressed} more)` : '';
    return `  ${event.assignmentId.padEnd(24)} tool: ${event.summary}${suffix}`;
  };
}

/**
 * Flags that take no value — recognised by name only, `continue`d past
 * without ever looking at `argv[i + 1]`.
 */
const BOOLEAN_FLAGS = new Set(['quiet']);

/** Every other recognised `--flag`, all of which require a following value. */
const VALUE_FLAGS = new Set([
  'provider',
  'concurrency',
  'timeout',
  'budget',
  'max-cost',
  'subject',
  'repo-root',
  'runs-root',
]);

/**
 * DEFECT FIXED (P1): a boolean flag swallows the next word into the task.
 *
 * `--quiet` used to `continue` after setting its map entry without consuming
 * a value — which is correct for a boolean flag — but the parser had no
 * notion of *which* flags were boolean and which took a value, so a bare
 * word immediately after `--quiet` was never claimed by anything and fell
 * through to `positional.push(arg)` exactly like a genuine task word would.
 * `npm run run -- "audit this" --quiet false` therefore sent the task
 * "audit this false" to a paid model, silently: `false` was never meant as
 * part of the task, it was a stray argument (someone thinking `--quiet`
 * takes a value, the way `--max-cost` does), but nothing here could tell the
 * two apart.
 *
 * The fix is two-part, matching the two ways that word could arrive:
 *
 *   1. `--flag` is now checked against a known set of names (`BOOLEAN_FLAGS`
 *      / `VALUE_FLAGS`). An unrecognised `--flag` is rejected immediately,
 *      naming itself, in the same shape `traceability.ts` already uses
 *      (`unexpected argument "..."`) — rather than being silently treated as
 *      a value-taking flag whose value happens to be the next token.
 *   2. A bare word is only accepted as part of the task while no flag has
 *      been seen yet (`sawFlag`, below). The task itself is positional and
 *      is routinely more than one word — `npm run run -- "audit this"` and
 *      `npm run run -- audit this` must both work — so the rule is
 *      "positionals before flags", not "at most one positional" and not
 *      "one positional, then nothing else". The moment the first `--flag`
 *      is consumed, any further bare word is rejected by name: it is either
 *      a flag's dropped value (this defect's exact shape) or a genuine typo,
 *      and either way silently absorbing it into the task is the wrong
 *      answer for the one input this whole run is built from.
 */
export function parseArgs(argv: string[]): CliOptions | 'help' {
  // DEFECT FIXED (P3): --help precedence.
  //
  // This used to be checked inline, in the same left-to-right pass that also
  // validates every other flag — so a malformed invocation could throw
  // before the loop ever reached a `-h`/`--help` sitting later in argv.
  // `traceability.ts` and `serve.ts` already throw before reaching their own
  // `--help` checks for the same structural reason (one pass, first match
  // wins, whichever comes first in the loop).
  //
  // CHOSEN: a dedicated first pass over the whole of `argv`, before any other
  // validation runs, so `--help` always wins here regardless of what else is
  // on the line. REJECTED: leaving help inline but moving it to the front of
  // the per-token branch (still what run.ts and agent.ts did before this
  // fix) — that only wins against validation errors for flags later in the
  // SAME iteration, not against one that legitimately throws earlier in
  // `argv`, e.g. `--bogus --help` still throws today under that scheme. The
  // reasoning: someone who reaches for `--help` is trying to get unstuck,
  // not asking to be lectured about an unrelated typo elsewhere on the same
  // command line — they should get the usage text, not a validation error,
  // no matter where `--help` sits.
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
        // Same shape as `traceability.ts`'s own check: name the unrecognised
        // flag rather than silently treating it as a value-taking one whose
        // value happens to be the next token (or as a positional).
        throw new Error(`unexpected argument "${arg}".\n\n${USAGE}`);
      }

      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`option ${arg} needs a value`);
      }
      flags.set(name, value);
      i += 1;
      continue;
    }

    if (sawFlag) {
      // See the module-level comment above `parseArgs` for the exact defect
      // this rejects: a bare word here is either a boolean flag's dropped
      // value (this ran with `--quiet false`, `--quiet` took no value, and
      // `false` is what's left over) or a genuine typo. Neither belongs
      // silently joined onto the task, which is why this throws instead of
      // falling through to `positional.push(arg)`.
      throw new Error(
        `unexpected argument "${arg}" — a flag has already been given, so this can't be part ` +
          `of the task.\n\nThe task must come first, before any --flag, e.g.\n` +
          `  npm run run -- "audit this" --quiet\nnot\n  npm run run -- --quiet "audit this" false` +
          `\n\nIf "${arg}" was meant as a value for the flag just before it, note that flag doesn't ` +
          `take one (the only flag(s) here that take no value: ${[...BOOLEAN_FLAGS].map((f) => `--${f}`).join(', ')}; ` +
          `every other flag needs its value directly after it).\n\n${USAGE}`,
      );
    }
    positional.push(arg);
  }

  const task = positional.join(' ').trim();
  if (task === '') {
    throw new Error(`no task given.\n\n${USAGE}`);
  }

  const numeric = (key: string): number | undefined => {
    const raw = flags.get(key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${key} must be a positive number, got "${raw}"`);
    }
    return value;
  };

  const concurrency = numeric('concurrency');
  const timeoutMs = numeric('timeout');
  const tokenBudget = numeric('budget');
  // Same `numeric` helper, same "positive or reject" rule as every other flag
  // here — the CLI path gets the same defence-in-depth `buildArgs` also
  // applies (see `providers/claude-code/provider.ts`), rather than trusting
  // this parser to be the only gate.
  const maxCostUsd = numeric('max-cost');

  const subjectPath = resolveSubjectPath(flags.get('subject'));

  return {
    task,
    ...(subjectPath === undefined ? {} : { subjectPath }),
    provider: flags.get('provider') ?? DEFAULT_PROVIDER,
    repoRoot: path.resolve(flags.get('repo-root') ?? process.env['AGENT_OFFICE_REPO_ROOT'] ?? DEFAULT_REPO_ROOT),
    runsRoot: path.resolve(flags.get('runs-root') ?? defaultRunsRoot()),
    quiet: flags.get('quiet') === 'true',
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
}

/**
 * Resolve and check `--subject`, or `undefined` when it was not given.
 *
 * Checked HERE, at parse time, rather than left for an agent to discover. A
 * mistyped path is otherwise the most expensive kind of typo in this system: the
 * planning turn is spent, every specialist is dispatched and billed, and each
 * one independently reports that it could not find the thing — which is exactly
 * the failure this flag exists to prevent, arriving by a different route. The
 * same reasoning as the provider-name check a few lines below in `main`.
 *
 * Resolved to an absolute path because a relative one means nothing to the agent
 * that receives it: the brief is read in a subprocess whose working directory is
 * an assignment workspace several levels away, so `../dashboard` would point
 * somewhere neither the operator nor the agent intended.
 */
function resolveSubjectPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;

  const resolved = path.resolve(raw);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(
      `--subject "${raw}" does not exist (resolved to ${resolved}).

` +
        'It should name the directory this task is about — the repository or ' +
        'project the agents will read.',
    );
  }
  if (!stats.isDirectory()) {
    // A single file is a plausible thing to want to point at, and refusing it is
    // the honest answer for now rather than a limitation to paper over: the
    // brief tells agents to "read from" the path and to write nothing there,
    // wording that is about a tree. Pointing at a file's directory loses
    // nothing, since an agent that can read the directory can read the file.
    throw new Error(
      `--subject "${raw}" is not a directory (resolved to ${resolved}).

` +
        'Point it at the containing directory instead.',
    );
  }
  return resolved;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parsed;

  // Before any provider resolves its key from the environment.
  loadDotEnv(options.repoRoot);

  // The registry loads first: the scripted provider's canned plan has to name
  // agents that actually exist, and is validated against these names.
  const registry = await loadRegistry(options.repoRoot);
  const knownAgentNames = new Set(registry.agents.map((agent) => agent.name));

  // DEFECT FIXED (FR-M8): this call used to pass no options, so `--max-cost`
  // — the flag `agent.ts` (the single-agent debug probe) has always honoured
  // — was accepted by `parseArgs` here and then dropped on the floor before
  // reaching `makeProvider`. `--budget` and `--timeout` already flowed into
  // `dispatch` below; this gives `--max-cost` the same real path, through the
  // same `MakeProviderOptions` shape `supervisor.ts` uses for the HTTP side.
  const providerOptions: MakeProviderOptions = {
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
  };
  const provider = makeProvider(options.provider, options.task, knownAgentNames, providerOptions);

  const availability = await provider.isAvailable();
  if (!availability.ok) {
    throw new Error(`provider "${options.provider}" unavailable: ${availability.reason ?? 'unknown'}`);
  }

  const store = new FileRunStore(options.runsRoot);

  // Ctrl+C cancels the run rather than killing the process mid-write, so the
  // persisted state stays consistent (FR-M9, NFR-2).
  const controller = new AbortController();
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write('\ncancelling run (Ctrl+C again to force quit)...\n');
    controller.abort();
  });

  const log = (message: string): void => {
    if (!options.quiet) process.stdout.write(`${message}\n`);
  };

  // F6 (P2): per-assignment throttle for the `tool` lines added below. See
  // `TOOL_LOG_INTERVAL_MS`'s comment for why `tool` is the event forwarded
  // and `text`/`usage`/`artifact` deliberately are not.
  const logTool = createToolEventThrottle();

  const onEvent = (event: AgentEvent): void => {
    if (options.quiet) return;
    if (event.t === 'status') {
      log(`  ${event.assignmentId.padEnd(24)} ${event.status}`);
    } else if (event.t === 'error') {
      log(`  ${event.assignmentId.padEnd(24)} ${event.fatal ? 'ERROR' : 'warn'}: ${event.message}`);
    } else if (event.t === 'tool') {
      const line = logTool(event);
      if (line !== undefined) log(line);
    }
  };

  log(`registry: ${registry.agents.length} agents from ${options.repoRoot}`);
  log(`provider: ${options.provider}`);
  log('');

  const result = await executeRun({
    registry,
    provider,
    store,
    task: options.task,
    ...(options.subjectPath === undefined ? {} : { subjectPath: options.subjectPath }),
    // Read from the environment here rather than deep in the dispatcher, so a
    // malformed AGENT_OFFICE_MIN_MODEL fails at startup with the whole run still
    // unspent — the same reasoning as `--subject`'s check above and the provider
    // name check below.
    modelPolicy: resolveModelPolicy(),
    signal: controller.signal,
    onEvent,
    logger: log,
    // Warnings, failures and agent notes, appended to runs/diagnostics.jsonl so
    // they can be read across runs with `npm run diagnostics`. Best-effort by
    // construction — see the log's failure posture.
    diagnostics: new DiagnosticsLog({ runsRoot: options.runsRoot }),
    dispatch: {
      ...(options.concurrency === undefined ? {} : { maxConcurrency: options.concurrency }),
      ...(options.timeoutMs === undefined ? {} : { assignmentTimeoutMs: options.timeoutMs }),
      ...(options.tokenBudget === undefined ? {} : { runTokenBudget: options.tokenBudget }),
    },
  });

  const { run } = result;
  const runDir = store.runDir(run.id);

  process.stdout.write('\n');
  process.stdout.write(`${'='.repeat(60)}\n`);
  process.stdout.write(`run ${run.id} — ${run.status}\n`);
  process.stdout.write(`${'='.repeat(60)}\n`);

  if (run.plan !== undefined) {
    process.stdout.write(`  domain:      ${run.plan.domain}\n`);
    process.stdout.write(`  team:        ${[...new Set(run.assignments.map((a) => a.agentName))].join(', ')}\n`);
  }
  if (result.dispatch !== undefined) {
    const { completed, failed, skipped, declined } = result.dispatch;
    // `declined` is printed only when it happened, so the ordinary line stays the
    // one people already read — but it is never omitted when it did.
    //
    // This line is why: a live run finished "2 done, 0 failed, 0 skipped" for a
    // THREE-assignment plan, because `error-detective` declined and nothing said
    // so. The counter existed and the status was correct on disk; the summary
    // simply never read it. The commit that added `declined` claimed this line
    // printed it — the edit was never applied, and nothing checked. Counting a
    // thing and displaying it are two changes, and only one of them had a test.
    process.stdout.write(
      `  assignments: ${completed} done, ${failed} failed, ${skipped} skipped` +
        `${declined > 0 ? `, ${declined} declined` : ''}\n`,
    );
  }
  // DEFECT FIXED (P2): `--max-cost` is a first-class flag, but nothing a run
  // ever printed said what it actually spent — the summary block below this
  // comment used to end at `assignments:`. `runTotalUsage` (assignment spend
  // plus the Manager's own planning/synthesis turns, `@agent-office/shared`)
  // gives the token figure; `estimateRunCostUsd` (`reports/deliverable.ts`,
  // the same function the PDF/markdown report's cover page calls) gives the
  // dollar one, resolving each assignment's price from its agent's catalog
  // `model:` frontmatter rather than guessing at a single run-wide model.
  // `formatCostUsd` already has the documented answer for "this run's
  // provider or model carries no known price": it renders `—`, never a
  // `$0.00` that would misreport an unpriced run as a free one — a run that
  // genuinely spent nothing (the scripted provider) still prices at a real,
  // computed `0`, and only THAT case reads as `$0.00`.
  const usage = runTotalUsage(run);
  const costUsd = estimateRunCostUsd(run, registry);
  process.stdout.write(
    `  tokens:      in=${usage.inputTokens} out=${usage.outputTokens}\n` +
      `  cost:        ${formatCostUsd(costUsd)} (estimated — NFR-5, not a bill)\n`,
  );
  if (run.error !== undefined) {
    process.stdout.write(`  error:       ${run.error}\n`);
  }
  process.stdout.write(`  artifacts:   ${runDir}\n`);
  if (run.reportPath !== undefined) {
    process.stdout.write(`  report:      ${path.join(runDir, run.reportPath)}\n`);
  }

  if (run.status !== 'done') process.exitCode = 1;
}

/**
 * Only run `main()` when this file is the process entry point.
 *
 * Added alongside `run.test.ts`, which imports `parseArgs` directly to test
 * the P1/P2 argv-parsing fixes above without shelling out to a subprocess —
 * `traceability.ts` and `purge.ts` already use this exact guard for the same
 * reason. Before this change nothing ever imported a CLI entrypoint (see
 * `purge.ts`'s own comment on this), so `run.ts` and `agent.ts` could get
 * away with calling `main().catch(...)` unconditionally; a plain `import`
 * for testing would otherwise execute `main()` against vitest's own argv.
 */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nrun failed.\n\n${message}\n`);
    process.exitCode = 1;
  });
}
