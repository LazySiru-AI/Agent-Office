/**
 * Maps a catalog agent's `tools:` frontmatter onto the Claude Code CLI's tool
 * flags.
 *
 * This is a real translation, not a pass-through: the catalog's tool
 * vocabulary and the CLI's built-in tool vocabulary were designed by different
 * people for different purposes and only partly overlap (PLAN.md §3, Phase 1).
 *
 * ## The two flags this feeds
 *
 * `--tools <list>` decides which built-in tools *exist* in the session;
 * `--allowedTools <list>` is a permission allowlist of what may run without an
 * interactive prompt. Both are declared variadic in `claude --help`
 * (`<tools...>`), which means each greedily consumes subsequent argv entries
 * until the next flag. Placed before a positional prompt in a spawned argv
 * array, a variadic flag will swallow the prompt as if it were another tool
 * name. {@link toArgvToken} defends against that by joining the resolved list
 * into a single comma-separated argv token — callers must pass the result as
 * ONE array element (e.g. `['--tools', toArgvToken(resolved)]`), never spread
 * across several, and must place the flag+value pair before any positional
 * argument.
 *
 * The adapter (this file's caller) runs headless: nothing is present to answer
 * an interactive permission prompt. Because of that, this module resolves one
 * set and expects the caller to feed the SAME {@link toArgvToken} output to
 * both `--tools` and `--allowedTools`. Granting existence without permission
 * would hang the run waiting for a prompt nobody can answer; granting
 * permission for a tool that does not exist in the session is a no-op. Keeping
 * one list for both keeps that pairing from drifting apart at a call site this
 * file does not control.
 *
 * ## Provenance of the built-in set
 *
 * {@link CLAUDE_CODE_BUILTIN_TOOLS} was copied verbatim from a real
 * `system`/`init` stream-json frame captured on this machine, running Claude
 * Code 2.1.222 on Windows (see `protocol.ts`'s `CAPTURED_FROM_VERSION` for the
 * shared version anchor). It is NOT derived from documentation or source, and
 * it is both platform- and version-dependent:
 *
 * - Different CLI versions add, rename or remove built-ins between releases.
 * - Different OSes expose different tools for the same capability — this
 *   capture's shell tool is `PowerShell`, not `Bash`, because it was taken on
 *   Windows (see the Bash/PowerShell section below).
 * - Session configuration (enabled plugins, MCP servers, feature flags) can
 *   change what appears in `init.tools` independently of CLI version.
 *
 * Treat this list as a snapshot with a shelf life, not a specification. The
 * next person extending this adapter to a new CLI version or a POSIX host
 * should re-capture `system/init` there and update the list (and the
 * `platform` handling below) rather than assume this one still holds.
 *
 * ## The Bash <-> PowerShell problem
 *
 * The catalog is Claude-Code-generic and overwhelmingly asks for `Bash`
 * (114 of 154 agents). The real Windows capture has no `Bash` built-in at
 * all — the CLI's shell tool on this platform is named `PowerShell`. Dropping
 * every `Bash` request as "unknown" would silently strip shell access from the
 * majority of the catalog, which is a correctness bug dressed up as strictness:
 * the agent author's *intent* ("give me a shell") is satisfiable on this host,
 * just under a different name. This module therefore treats `Bash` as a
 * platform alias for whichever name the CLI actually uses for its shell tool
 * on `options.platform` (default: `process.platform`), and reports the
 * substitution back to the caller rather than pretending it did not happen —
 * FR-R2's fail-loudly stance applies to renames as much as to drops. On
 * `win32` that resolves to `PowerShell` (verified). On every other platform it
 * resolves to `Bash` unchanged, which is an ASSUMPTION (Claude Code's own
 * naming on macOS/Linux has not been captured for this project) rather than a
 * second verified fact; it is written down as {@link ASSUMED_POSIX_SHELL_TOOL}
 * so it is easy to find and correct once someone captures a POSIX
 * `system/init` frame.
 *
 * ## What gets excluded regardless of what the frontmatter asks for
 *
 * NFR-1 is supposed to confine a run to `runs/<id>/workspace/`. Be precise
 * about how that confinement actually happens, because it is easy to overstate
 * it: there is no OS-level jail here. The adapter runs the CLI with
 * `cwd: workspaceDir` and this module withholds specific built-ins; that is
 * the entire enforcement mechanism. `cwd` only steers relative-path resolution
 * — it does not stop a process from opening an absolute path, and it does
 * nothing at all once a process can execute arbitrary further commands (see
 * the shell section immediately below, which is the sharpest case of this). A
 * handful of the captured built-ins are session-management,
 * cross-session-communication or scheduling primitives whose entire purpose is
 * to reach OUTSIDE one run: messaging other sessions, scheduling future work,
 * switching the git worktree the CLI is even looking at, or spawning further
 * background tasks. Granting any of those to a delegated catalog subagent
 * would let it escape both the workspace boundary and FR-M5's context
 * isolation (a leaf agent is supposed to talk to the Manager via its report,
 * not sideband). None of the 154 catalog agents currently ask for these by
 * name — the catalog vocabulary predates and is unaware of this CLI's tool
 * names — so this is defence in depth against a future or hand-edited
 * frontmatter, not a change in observed behaviour today. See
 * {@link ALWAYS_EXCLUDED_BUILTINS} for the list and the per-tool reason.
 *
 * ## The shell is not on that list, and that is the actual finding here
 *
 * A live shell subsumes every capability the tools above are withheld for: it
 * can invoke the CLI's own cron/message/worktree commands, reach the network,
 * or read and write anywhere the OS-level user account can reach, `cwd`
 * notwithstanding — a shell's first command can be `cd`. Excluding
 * `SendMessage` and `EnterWorktree` by name while handing out an unrestricted
 * shell is defence in depth against everything except the one tool that makes
 * the defence moot. Earlier versions of this module granted the shell
 * (`PowerShell` on win32, the assumed `Bash` name on POSIX — see below)
 * unconditionally to any agent whose frontmatter asked for `Bash`, which is
 * 114 of the 154 catalog agents, `backend-developer` among them. That is
 * withdrawn: the shell is now withheld by the same default-deny posture as
 * {@link ALWAYS_EXCLUDED_BUILTINS}, unless the caller sets
 * {@link ToolResolutionOptions.allowShell} to `true`.
 *
 * That is a deliberate product trade-off, recorded here so the next reader
 * finds a decision rather than an oversight: the agents this adapter runs
 * produce markdown reports (FR-M5's "report to the Manager" contract), not
 * code changes landed on disk, so a shell is rarely load-bearing for the work
 * this system actually asks agents to do. Denying it by default costs real
 * capability for the minority of agents that do need one — and it is exactly
 * one boolean, `allowShell`, for a caller who has a specific run that needs
 * it back.
 *
 * ## The empty / all-dropped case
 *
 * `--tools ""` explicitly disables every built-in tool; OMITTING `--tools`
 * defaults to `"default"`, i.e. every built-in. Those are opposite outcomes.
 * An agent whose entire requested tool list resolves to nothing (all unknown,
 * all excluded, or a genuinely empty request) must land on the explicit-empty
 * behaviour, never on the omitted-flag behaviour — the fail-safe direction for
 * a sandboxed run is deny-by-default, not implicit grant-everything. This
 * module never omits the flag on the caller's behalf; it always returns a
 * value (possibly the empty string from `toArgvToken([])`) that the caller
 * passes explicitly. Whether a fully-empty resolution should abort the run
 * outright is a policy call for the adapter (FR-R2 vs NFR-8), not for this
 * module — {@link resolveClaudeCodeTools} always returns rather than throws,
 * so that decision stays with the caller, informed by `dropped`.
 */

/**
 * The Claude Code CLI's built-in tool names, as observed in a real
 * `system`/`init` frame on this machine (Claude Code 2.1.222, Windows).
 *
 * Platform- and version-dependent — see the module doc comment above before
 * reusing this list anywhere else.
 */
export const CLAUDE_CODE_BUILTIN_TOOLS = [
  'Task',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'Edit',
  'EnterWorktree',
  'ExitWorktree',
  'Glob',
  'Grep',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReportFindings',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
] as const;

export type ClaudeCodeBuiltinTool = (typeof CLAUDE_CODE_BUILTIN_TOOLS)[number];

const BUILTIN_LOOKUP: ReadonlyMap<string, ClaudeCodeBuiltinTool> = new Map(
  CLAUDE_CODE_BUILTIN_TOOLS.map((name) => [name.toLowerCase(), name]),
);

/**
 * Built-in the CLI uses for shell access on Windows. Directly verified (see
 * module doc).
 */
const WINDOWS_SHELL_TOOL: ClaudeCodeBuiltinTool = 'PowerShell';

/**
 * ASSUMED (not captured) name for the shell tool on POSIX platforms: the
 * catalog's own `Bash` name, unchanged. Every catalog agent that asks for
 * `Bash` is written as though talking to a POSIX shell already, so if this CLI
 * calls its POSIX shell tool `Bash` — plausible, but unverified for this
 * project — passing it through verbatim is the identity mapping and the
 * likeliest-correct default. Replace this constant, not the logic around it,
 * once a real POSIX `system/init` capture exists.
 */
const ASSUMED_POSIX_SHELL_TOOL = 'Bash' as const;

/**
 * A name this module can actually grant: either a verified Windows built-in,
 * or the assumed POSIX shell name above. Deliberately wider than
 * {@link ClaudeCodeBuiltinTool}, which stays scoped to names truly present in
 * the captured session — resolving `Bash` on a POSIX host is a documented
 * assumption, not a verified fact, and the type says so rather than papering
 * over it with a cast.
 */
export type GrantableTool = ClaudeCodeBuiltinTool | typeof ASSUMED_POSIX_SHELL_TOOL;

/**
 * Built-ins that exist in the captured session but must never be handed to a
 * delegated catalog subagent, regardless of what its frontmatter requests.
 * Each reaches outside the single run's boundary (NFR-1) or outside FR-M5's
 * "leaf agents report to the Manager, not sideband" isolation. Keyed by name
 * so {@link resolveClaudeCodeTools} can produce a specific reason per tool
 * rather than a generic "excluded".
 *
 * The shell tool (`PowerShell` / the assumed POSIX `Bash`) is deliberately
 * NOT in this map, even though it is at least as capable of violating NFR-1
 * as anything listed here — see the module doc's "shell is not on that list"
 * section. It is withheld through the separate {@link ToolResolutionOptions.allowShell}
 * opt-in instead of this always-on map, because unlike the tools below it has
 * legitimate uses for some agents and a caller needs a way to ask for it back
 * without hand-editing this file. Do not fold it into this map — that would
 * remove the opt-in.
 */
const ALWAYS_EXCLUDED_BUILTINS: ReadonlyMap<GrantableTool, string> = new Map([
  [
    'SendMessage',
    'cross-session messaging escapes FR-M5 context isolation: a delegated agent reports to the Manager via its deliverable, not sideband to other sessions.',
  ],
  [
    'CronCreate',
    'schedules work that outlives the run; NFR-1 confines a run to its own lifetime inside runs/<id>/workspace/.',
  ],
  [
    'CronDelete',
    'mutates scheduled state outside this run; same NFR-1 concern as CronCreate.',
  ],
  [
    'CronList',
    'reads scheduled state outside this run; excluded alongside the other Cron* tools for consistency even though it is read-only.',
  ],
  [
    'ScheduleWakeup',
    'schedules future execution outside the run; NFR-1 confines a run to its own lifetime.',
  ],
  [
    'PushNotification',
    'reaches the human user directly, bypassing the Manager synthesis step FR-M5 assumes is the only path to the user.',
  ],
  [
    'EnterWorktree',
    'switches the git worktree the CLI operates on to something outside runs/<id>/workspace/, a direct NFR-1 violation.',
  ],
  [
    'ExitWorktree',
    'paired with EnterWorktree; excluded for the same reason.',
  ],
  [
    'Task',
    'spawns further background work; orchestration is the Manager\'s job (FR-M4\'s concurrency cap assumes it owns all spawning), not a leaf agent\'s.',
  ],
  ['TaskCreate', 'spawns/manages background tasks outside the run; see Task.'],
  ['TaskGet', 'reads background task state outside the run; excluded alongside the other Task* tools for consistency.'],
  ['TaskList', 'reads background task state outside the run; excluded alongside the other Task* tools for consistency.'],
  ['TaskOutput', 'reads background task state outside the run; excluded alongside the other Task* tools for consistency.'],
  ['TaskStop', 'controls background task state outside the run; excluded alongside the other Task* tools for consistency.'],
  ['TaskUpdate', 'controls background task state outside the run; excluded alongside the other Task* tools for consistency.'],
  [
    'DesignSync',
    'synchronises with an external design system of unknown scope; no evidence it respects the workspace sandbox, so it is excluded rather than assumed safe.',
  ],
]);

/** Reason a requested tool did not make it into the resolved set. */
export type DropReason =
  /** A genuine Claude Code built-in that NFR-1/FR-M5 forbid granting to a subagent. */
  | 'unsafe-for-sandbox'
  /**
   * The requested name resolved to this session's shell built-in
   * (`PowerShell` on win32, the assumed `Bash` on POSIX) and
   * {@link ToolResolutionOptions.allowShell} was not set. Distinct from
   * `unsafe-for-sandbox` because it is not an unconditional exclusion like
   * {@link ALWAYS_EXCLUDED_BUILTINS} — it is a default the caller can
   * override per resolution, not a standing prohibition.
   */
  | 'shell-not-allowed'
  /** Not a recognised built-in on this platform/version at all. */
  | 'not-a-builtin';

export interface DroppedTool {
  /** The name exactly as it appeared in the agent's frontmatter. */
  readonly requested: string;
  readonly reason: DropReason;
  /** Human-readable explanation, safe to surface in run logs or the UI. */
  readonly detail: string;
}

/** One requested name that WAS granted, and what it resolved to. */
export interface ResolvedTool {
  /** The name exactly as it appeared in the agent's frontmatter. */
  readonly requested: string;
  /** The Claude Code built-in name actually granted (may differ — see Bash). */
  readonly builtin: GrantableTool;
  /** True when `builtin !== requested` (currently only the Bash/PowerShell case). */
  readonly remapped: boolean;
}

export interface ToolResolutionOptions {
  /**
   * Which platform's shell-tool naming to use for the Bash mapping.
   * Defaults to `process.platform`. Exposed for tests so behaviour on both
   * branches can be asserted without spawning a second OS.
   */
  platform?: NodeJS.Platform;
  /**
   * Grants this session's shell built-in (`PowerShell` on win32, the assumed
   * `Bash` on POSIX) when `true`. Defaults to `false`.
   *
   * The default is deny, not because a shell is uniquely dangerous among the
   * captured built-ins — see the module doc's "shell is not on that list"
   * section for why it is in fact the MOST capable of them — but because it
   * is the one exclusion in this module for which some callers have a
   * legitimate need, so it gets a caller-controlled opt-in instead of a
   * standing entry in {@link ALWAYS_EXCLUDED_BUILTINS}. Leave this unset (or
   * `false`) for the common case; set it `true` only for a specific run that
   * a human or the calling code has decided needs shell access, e.g. because
   * the requesting agent's job is not satisfiable by markdown-report output
   * alone. This module does not decide when that is true — it only makes the
   * decision possible and defaults it to the safer answer.
   */
  allowShell?: boolean;
}

export interface ToolResolution {
  /**
   * Deduplicated built-in tool names to grant, in first-requested order.
   * Feed this to {@link toArgvToken} for both `--tools` and `--allowedTools`.
   */
  readonly resolved: readonly GrantableTool[];
  /** Every requested name that resolved to a grant, and what it became. */
  readonly granted: readonly ResolvedTool[];
  /**
   * Every requested name that did NOT resolve to a grant, with why. Never
   * throws on account of these — an unrecognised or MCP-style name is a
   * degradation to report (NFR-8), not a run failure. Silently ignoring a
   * requested tool is exactly what this field exists to prevent (FR-R2): the
   * caller has everything it needs to log or surface each drop.
   */
  readonly dropped: readonly DroppedTool[];
}

/**
 * Resolve one agent's requested tool names against the Claude Code CLI's
 * actual built-in set.
 *
 * Never throws. An agent whose frontmatter names tools this CLI does not have
 * (an MCP server, another catalog agent's name used as a pseudo-tool, a typo)
 * gets those names back in `dropped` rather than a thrown error — that is a
 * graceful-degradation case (NFR-8), and the run should still be able to
 * proceed with whatever it DID resolve. What to do when `resolved` ends up
 * empty is the caller's call; see the module doc's "empty / all-dropped"
 * section.
 */
export function resolveClaudeCodeTools(
  requestedTools: readonly string[],
  options: ToolResolutionOptions = {},
): ToolResolution {
  const platform = options.platform ?? process.platform;
  const shellTool: GrantableTool = platform === 'win32' ? WINDOWS_SHELL_TOOL : ASSUMED_POSIX_SHELL_TOOL;
  // Deny-by-default: an unset `allowShell` must resolve to `false`, never to
  // "grant everything", matching the fail-safe direction the empty/all-dropped
  // case documents above. See ToolResolutionOptions.allowShell for why the
  // shell gets this caller-controlled opt-in instead of a permanent entry in
  // ALWAYS_EXCLUDED_BUILTINS.
  const allowShell = options.allowShell ?? false;

  const grantedOrder: GrantableTool[] = [];
  const grantedSet = new Set<GrantableTool>();
  const granted: ResolvedTool[] = [];
  const dropped: DroppedTool[] = [];

  for (const requested of requestedTools) {
    const builtin = resolveOneName(requested, shellTool);

    if (builtin === undefined) {
      dropped.push({
        requested,
        reason: 'not-a-builtin',
        detail: `"${requested}" is not a Claude Code CLI built-in on this platform/version. Likely an MCP tool, a plugin-supplied tool, or a reference to another catalog agent — none of which this adapter can grant as a CLI --tools entry.`,
      });
      continue;
    }

    // Checked before ALWAYS_EXCLUDED_BUILTINS and independently of it: this
    // covers BOTH the Bash-on-this-platform alias (`requested` was `Bash`,
    // `builtin` became `shellTool` via the mapping above) and an agent naming
    // the platform's real shell tool directly (`requested` was already
    // `PowerShell` on win32). Either spelling reaches the same built-in, so
    // either spelling must be denied the same way when `allowShell` is unset.
    if (builtin === shellTool && !allowShell) {
      dropped.push({
        requested,
        reason: 'shell-not-allowed',
        detail: `"${requested}" resolves to the built-in "${builtin}", this session's shell tool, which is withheld by default: an unrestricted shell subsumes every capability ALWAYS_EXCLUDED_BUILTINS withholds above (it can reach other sessions, schedule work, switch worktrees, or spawn background tasks by invoking the CLI or OS directly) and is not confined by this run's cwd, since a shell's own first command can "cd" anywhere. Pass { allowShell: true } to resolveClaudeCodeTools for a run that genuinely needs one; the default is deny because this adapter's agents are expected to produce markdown reports, not run commands, so a shell is rarely load-bearing here.`,
      });
      continue;
    }

    const excludeReason = ALWAYS_EXCLUDED_BUILTINS.get(builtin);
    if (excludeReason !== undefined) {
      dropped.push({
        requested,
        reason: 'unsafe-for-sandbox',
        detail: `"${requested}" resolves to the built-in "${builtin}", which is withheld from every delegated run regardless of frontmatter: ${excludeReason}`,
      });
      continue;
    }

    granted.push({ requested, builtin, remapped: builtin !== requested });
    if (!grantedSet.has(builtin)) {
      grantedSet.add(builtin);
      grantedOrder.push(builtin);
    }
  }

  return { resolved: grantedOrder, granted, dropped };
}

/**
 * Resolve a single requested name to a built-in, or `undefined` if it is not
 * one. Handles the Bash/PowerShell platform alias and a case-insensitive
 * fallback for the recognised built-ins (the catalog is consistently
 * PascalCase in practice — see tools.test.ts — but nothing about the
 * frontmatter format guarantees that, and a case slip is a much better outcome
 * as a normalised grant than as a silent drop).
 */
function resolveOneName(
  requested: string,
  shellTool: GrantableTool,
): GrantableTool | undefined {
  if (requested.toLowerCase() === 'bash') return shellTool;

  return BUILTIN_LOOKUP.get(requested.toLowerCase());
}

/**
 * Join resolved built-in names into the single argv token both `--tools` and
 * `--allowedTools` expect.
 *
 * Both flags are declared variadic (`<tools...>`) in `claude --help`, so an
 * array like `['--tools', 'Read', 'Write', ...promptArgs]` would have the CLI
 * swallow every following argv entry — including the positional prompt — as
 * more tool names. Comma-joining into ONE string sidesteps that entirely: the
 * flag consumes exactly one argv element, and the CLI does its own
 * comma/space splitting on the string's CONTENTS, which is a wire-format
 * concern for the CLI, not an argv-splitting hazard for us.
 *
 * Returns `''` for an empty list. Per the module doc's empty-case section,
 * the caller must still pass `['--tools', '']` explicitly (never omit the
 * flag) — an empty string here is a deliberate "disable everything", not "no
 * opinion".
 */
export function toArgvToken(names: readonly string[]): string {
  return names.join(',');
}
