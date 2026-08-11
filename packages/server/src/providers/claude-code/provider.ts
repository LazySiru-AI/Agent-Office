import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@agent-office/shared';
import { ProviderUnavailableError, type AgentProvider, type AgentRunRequest, type ProviderAvailability } from '../types.js';
import { killTree, spawnClaude } from './childProcess.js';
import { LineSplitter, normaliseFrame, parseFrame } from './parse.js';
import { checkClaudeCodeAvailability, resolveClaudeBinaryCached } from './resolveBinary.js';
import { resolveClaudeCodeTools, toArgvToken } from './tools.js';

/**
 * The Claude Code CLI adapter (PLAN.md Phase 1).
 *
 * One child process per assignment, `--output-format stream-json` parsed as it
 * arrives so the UI sees output within NFR-3's ~500ms rather than at completion.
 * Everything version-specific lives in `protocol.ts` and `resolveBinary.ts`;
 * this file is only the choreography between them.
 */

export interface ClaudeCodeProviderOptions {
  /**
   * Passed to `--model`, overriding the agent's own catalog `model:`.
   *
   * Run-wide, and deliberately the stronger of the two: this is set by someone
   * passing `--model` or choosing one in the settings panel, which is a direct
   * instruction about this run, whereas `AgentRunRequest.model` is the catalog's
   * standing default for that agent. Unset — the usual case — lets each agent's
   * frontmatter through.
   *
   * Never pass the catalog's `inherit` value: it is a catalog convention, not a
   * model alias. The CLI accepts the flag but the API is what ultimately
   * resolves the name, and 25 agents use it. `buildArgs` filters it from both
   * sources rather than trusting the caller.
   */
  model?: string;

  /**
   * Hard spend cap per assignment, via the CLI's own `--max-budget-usd`.
   *
   * FR-M8 requires a per-run token budget, which the dispatcher enforces by
   * summing usage after each assignment. That is necessarily after the fact —
   * an assignment that runs away has already spent the money by the time the
   * total is checked. This cap is enforced inside the CLI, so it is the only
   * mechanism here that can stop spend mid-assignment.
   */
  maxCostUsd?: number;

  /**
   * How the agent's markdown body reaches the model. Defaults to `append`.
   *
   * `replace` (`--system-prompt-file`) is closer to FR-M5's "nothing else", but
   * it discards Claude Code's own operating instructions along with the default
   * prompt. Tool *availability* survives — that comes from the API's tools
   * parameter — but the conventions for using them do not, so an agent keeps
   * `Write` while losing the guidance on how this runtime expects it to be used.
   * Appending is the lower-risk default; the deviation is recorded rather than
   * silently chosen.
   */
  systemPromptMode?: 'append' | 'replace';

  /**
   * Permission posture for the child. Defaults to `acceptEdits`.
   *
   * Not `bypassPermissions`: that is a decision about the user's machine, and it
   * is not this adapter's to make by default. In print mode a tool outside the
   * allowlist is denied and recorded in the result frame's `permission_denials`
   * rather than blocking on a prompt, so the conservative default degrades into
   * a reported denial instead of a hang.
   */
  permissionMode?: string;

  /**
   * Called for anything worth seeing that is not an `AgentEvent` — unrecognised
   * frame types, malformed lines, overflowing lines.
   *
   * These must not become `error` events: they are not the agent's failure, and
   * NFR-8 asks for degradation rather than a failed run. But dropping them
   * silently is how a CLI upgrade that changes the wire format becomes a mystery
   * six months later, so they go somewhere a human can see.
   */
  onDiagnostic?: (message: string) => void;

  /**
   * Seams, injected only by tests.
   *
   * The adapter's whole job is choreography between a spawned process and the
   * parser, and none of that is reachable while the CLI is unauthenticated —
   * which it is on this machine. Injecting the spawn lets the real streaming
   * loop, the real abort path and the real exit handling run against a stand-in
   * process replaying captured fixture bytes. The alternative was leaving the
   * busiest file in Phase 1 untested until someone signs in.
   *
   * Follows the deps-object convention already used by `dispatcher`, `manager`
   * and `runner` rather than inventing a second style.
   */
  deps?: {
    spawn?: typeof spawnClaude;
    checkAvailability?: () => Promise<ProviderAvailability>;
    resolveBinary?: () => Promise<{ path: string } | undefined>;
  };
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = 'claude-code' as const;

  private readonly options: ClaudeCodeProviderOptions;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.options = options;
  }

  async isAvailable(): Promise<ProviderAvailability> {
    const check = this.options.deps?.checkAvailability ?? checkClaudeCodeAvailability;
    return check();
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const availability = await this.isAvailable();
    if (!availability.ok) {
      throw new ProviderUnavailableError(this.id, availability.reason ?? 'unknown reason');
    }

    const resolve = this.options.deps?.resolveBinary ?? resolveClaudeBinaryCached;
    const binary = await resolve();
    if (binary === undefined) {
      // Unreachable in practice — the preflight above resolves the same binary —
      // but the types do not know that, and throwing beats a non-null assertion.
      throw new ProviderUnavailableError(this.id, 'the Claude Code CLI could not be resolved');
    }

    const tools = resolveClaudeCodeTools(request.allowedTools);

    // A dropped tool is a degraded run, not a failed one (NFR-8). The agent was
    // written expecting it, so the user should see that it is missing — but an
    // MCP tool this adapter cannot grant must never fail the assignment.
    for (const dropped of tools.dropped) {
      yield {
        assignmentId: request.assignmentId,
        t: 'error',
        message: `tool "${dropped.requested}" was not granted: ${dropped.detail}`,
        fatal: false,
      };
    }

    // The system prompt goes to a file outside the workspace. Inside it, the
    // agent could read it, edit it, or include it in its own report — and NFR-1
    // scopes the agent to the workspace precisely so that what is in there is
    // its work rather than ours.
    const scratch = await mkdtemp(path.join(tmpdir(), 'agent-office-'));
    const systemPromptPath = path.join(scratch, 'system-prompt.md');

    try {
      await writeFile(systemPromptPath, request.systemPrompt, 'utf8');

      // Same fact the Anthropic and OpenAI adapters already report as a
      // non-fatal `error` event (see `apiConfig.ts`'s `resolveAgentModel`):
      // which model an agent actually ran on changes both its cost and its
      // output, so a run-wide override silently beating the agent's own
      // catalog `model:` must not be visible on two engines and invisible on
      // the third. `buildArgs` stays pure and returns only argv (its own
      // doc comment is explicit about that), so the substitution is decided
      // here, by the caller, before `buildArgs` is asked to act on it.
      const modelOverrideMessage = describeModelOverride(this.options, request.model);
      if (modelOverrideMessage !== undefined) {
        yield {
          assignmentId: request.assignmentId,
          t: 'error',
          fatal: false,
          message: modelOverrideMessage,
        };
      }

      const args = buildArgs({
        systemPromptPath,
        tools,
        options: this.options,
        ...(request.model === undefined ? {} : { requestModel: request.model }),
      });

      const spawnProcess = this.options.deps?.spawn ?? spawnClaude;
      const { child, exit, stderr } = spawnProcess({
        binary: binary.path,
        args,
        cwd: request.workspaceDir,
        stdin: request.task,
      });

      // `exit` rejects if the process could never start. Nothing awaits it until
      // after the stdout loop, and an unobserved rejection in between would be an
      // unhandled rejection, so it is neutralised here and re-read below.
      const settled = exit.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const onAbort = (): void => killTree(child);
      if (request.signal.aborted) {
        killTree(child);
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      let sawFatal = false;

      /**
       * One failure must produce one error.
       *
       * The CLI reports a fatal failure twice: once as the fabricated assistant
       * turn carrying the message, and again in the terminal `result` frame,
       * which restates it verbatim. Both are genuinely fatal and the parser —
       * which sees one frame at a time — cannot tell the second from a new
       * problem. Only this layer holds the whole stream, so the de-duplication
       * belongs here. Matching on the message rather than suppressing all
       * later fatals keeps a genuinely *different* second failure visible.
       */
      const emittedFatals = new Set<string>();
      const admit = (event: AgentEvent): boolean => {
        if (event.t !== 'error' || !event.fatal) return true;
        if (emittedFatals.has(event.message)) return false;
        emittedFatals.add(event.message);
        sawFatal = true;
        return true;
      };

      try {
        const splitter = new LineSplitter();
        child.stdout.setEncoding('utf8');

        for await (const chunk of child.stdout as AsyncIterable<string>) {
          for (const split of splitter.push(chunk)) {
            for (const event of this.consume(split, request.assignmentId)) {
              if (admit(event)) yield event;
            }
          }
        }

        for (const split of splitter.finish()) {
          for (const event of this.consume(split, request.assignmentId)) {
            if (admit(event)) yield event;
          }
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
      }

      const result = await settled;

      if (!result.ok) {
        yield {
          assignmentId: request.assignmentId,
          t: 'error',
          message: `the Claude Code CLI could not be started: ${describe(result.error)}`,
          fatal: true,
        };
        return;
      }

      // An abort is the orchestrator's own doing — cancel (FR-M9) or timeout
      // (FR-M8) — and it already knows. Reporting it as a provider error would
      // turn a deliberate cancellation into a spurious failure in the run log.
      if (request.signal.aborted) return;

      const { code } = result.value;
      if (code !== 0 && !sawFatal) {
        // Only when the stream did not already explain itself. The CLI reports
        // most failures in-band via a `result` frame with `is_error: true`, and
        // emitting a second event for the same failure would double-report it.
        const tail = (await stderr).trim();
        yield {
          assignmentId: request.assignmentId,
          t: 'error',
          message: tail.length > 0 ? `claude exited ${String(code)}: ${tail}` : `claude exited ${String(code)}`,
          fatal: true,
        };
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** One split line → zero or more events, with diagnostics routed aside. */
  private *consume(
    split: ReturnType<LineSplitter['push']>[number],
    assignmentId: string,
  ): Generator<AgentEvent> {
    if (split.kind === 'overflow') {
      this.options.onDiagnostic?.(
        `discarded an oversized stream-json line (${String(split.discardedChars)} chars)`,
      );
      return;
    }

    const parsed = parseFrame(split.text);
    if (parsed.kind === 'parse-error') {
      // A truncated trailing line is the ordinary shape of a killed process,
      // not a defect worth reporting as one.
      if (!split.trailing) this.options.onDiagnostic?.(`unparseable line: ${parsed.message}`);
      return;
    }
    if (parsed.kind === 'ignorable') return;

    const normalised = normaliseFrame(parsed.frame, assignmentId);
    if (!normalised.recognised) {
      this.options.onDiagnostic?.(`unrecognised frame type "${parsed.frame.type}"`);
    }
    yield* normalised.events;
  }
}

interface BuildArgsInput {
  systemPromptPath: string;
  tools: ReturnType<typeof resolveClaudeCodeTools>;
  options: ClaudeCodeProviderOptions;
  /**
   * `AgentRunRequest.model` — the catalog's per-agent frontmatter.
   *
   * This adapter is the one engine that can take the catalog's vocabulary
   * unchanged: `sonnet` and `haiku` are the CLI's own aliases. `inherit` is not,
   * and is dropped rather than forwarded.
   */
  requestModel?: string;
}

/**
 * Whether a run-wide `--model` will silently beat this agent's own catalog
 * `model:`, and if so, the sentence to report it with.
 *
 * Split out of `buildArgs` rather than folded into it because `buildArgs` is
 * a pure function returning argv (see its own doc comment) and reporting a
 * substitution means yielding an `AgentEvent`, which only `run` can do.
 * Mirrors `buildArgs`'s own precedence exactly, so the two never disagree
 * about when a substitution actually happened: an explicit run-wide model
 * always wins, and `inherit` is not a substitution because the agent asked
 * for nothing in particular.
 */
export function describeModelOverride(
  options: ClaudeCodeProviderOptions,
  requestModel: string | undefined,
): string | undefined {
  if (options.model === undefined) return undefined;
  if (requestModel === undefined || requestModel === 'inherit') return undefined;

  return (
    `this agent's catalog model "${requestModel}" was not used: ` +
    `the run explicitly specifies "${options.model}", which takes precedence.`
  );
}

/**
 * Assemble argv.
 *
 * Two hazards drive the shape of this. `--tools` and `--allowedTools` are
 * variadic (`<tools...>`), so they swallow following argv entries unless each is
 * given exactly one comma-joined token — which is why `toArgvToken` exists. And
 * the prompt is never an argument at all: it arrives on stdin, because a brief
 * carrying upstream reports outgrows Windows' ~32k command-line limit.
 */
export function buildArgs(input: BuildArgsInput): string[] {
  const { systemPromptPath, tools, options } = input;
  const token = toArgvToken(tools.resolved);

  const args = [
    '--print',
    '--output-format',
    'stream-json',
    // Not optional: without it the CLI exits 1 with a usage error and emits no
    // JSON whatsoever. Verified against 2.1.222.
    '--verbose',
    // Headless runs are not resumable conversations, and persisting them fills
    // the user's session picker with machine traffic.
    '--no-session-persistence',
    options.systemPromptMode === 'replace' ? '--system-prompt-file' : '--append-system-prompt-file',
    systemPromptPath,
    '--permission-mode',
    options.permissionMode ?? 'acceptEdits',
    // Always passed, even empty. Omitting `--tools` means "default", which is
    // every built-in — the opposite of the deny-by-default posture NFR-1 wants,
    // and precisely the wrong failure mode for an agent that requested nothing
    // grantable.
    '--tools',
    token,
  ];

  if (token.length > 0) {
    // The permission allowlist, distinct from tool availability above: this is
    // what keeps a granted tool from stopping to ask.
    args.push('--allowedTools', token);
  }

  // An explicit provider-level model wins over the catalog's frontmatter: the
  // first is an instruction about this run, the second is the agent's standing
  // default. `inherit` is filtered from both — it is a catalog convention
  // meaning "whatever the run is using", and 25 agents declare it, so forwarding
  // it would send a non-model to `--model` on a sixth of every run.
  const model = [options.model, input.requestModel].find(
    (candidate) => candidate !== undefined && candidate !== 'inherit',
  );
  if (model !== undefined) {
    args.push('--model', model);
  }

  if (options.maxCostUsd !== undefined) {
    args.push('--max-budget-usd', String(options.maxCostUsd));
  }

  return args;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
