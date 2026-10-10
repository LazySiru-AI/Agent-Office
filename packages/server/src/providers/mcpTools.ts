import fsp from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UnsafePathError } from '../store/types.js';
import { resolveWithin } from '../store/util.js';
import { mcpServerOf } from './claude-code/mcpConfig.js';
import type { SandboxedTools, ToolResult, ToolSchema } from './apiTools.js';

/**
 * MCP bridge for the raw-API providers (Stage 4: Anthropic, OpenAI, DeepSeek).
 *
 * ## Why this exists
 *
 * The `claude-code` provider spawns the Claude Code CLI, which speaks MCP natively — Stages 1-3
 * wired `--mcp-config` straight through to it (see `claude-code/mcpConfig.ts`). The other three
 * providers are not a CLI: they are `apiTools.ts` calling a chat-completions endpoint directly and
 * implementing their own tool loop. Nothing about that loop can reach an MCP server on its own —
 * this module is what makes it possible, by speaking the MCP client protocol itself (over the
 * official `@modelcontextprotocol/sdk`) and presenting the result as one more `SandboxedTools`
 * implementation, indistinguishable in shape from `apiTools.ts`'s filesystem tools.
 *
 * That "indistinguishable in shape" property is deliberate, not incidental: a provider's tool loop
 * (`anthropic/provider.ts` and its siblings) should not need to know or care whether a given tool
 * name resolves to a local filesystem operation or a round trip to a spawned MCP server. It just
 * has a `SandboxedTools`-shaped thing (or several, merged) and calls `schemas()`/`execute()`.
 *
 * ## Namespacing
 *
 * A server's tool `tax_summary` on server `investing` is exposed as `mcp__investing__tax_summary`
 * — the exact convention `claude-code/mcpConfig.ts`'s `mcpServerOf` already parses for the CLI
 * adapter. Reusing it (rather than inventing a second naming scheme for the API providers) means an
 * agent's `tools:` frontmatter names the same tool the same way regardless of which provider family
 * ends up running it; a catalog author never has to know or care which one they got.
 *
 * ## The `allowedTools` boundary
 *
 * `schemas(requested)` returns only tools the caller actually asked for, filtered against what each
 * server actually reports — never "everything every connected server happens to expose". This
 * mirrors `apiTools.ts`'s `createSandboxedTools`, and the reasoning is the same one documented on
 * that function: what is advertised must be a subset of what is permitted, because an unrequested
 * MCP tool sitting in the model's context is both a token cost (NFR-5, extended below) and an
 * invitation for the model to call something nobody in this assignment authorised (FR-M5).
 *
 * That filter alone is NOT the permission boundary, and an earlier version of this module doc
 * claimed it was ("`execute` separately double-checks the same boundary"). It did not: `execute`
 * checked that the named server was connected and reported the named tool, which is a question about
 * the *server's* capabilities, not about what *this assignment* was granted. The two coincide only
 * when the model asks for exactly what it was offered — which is the one case a permission check does
 * not need to exist for. A model can emit a call for a tool it was never offered, from a stale turn
 * or a hallucinated name, and every configured server's full tool list was reachable that way.
 *
 * So the allowlist is held here too, at construction ({@link CreateMcpToolsOptions.allowedTools}),
 * exactly as `createSandboxedTools` takes it as a constructor argument rather than trusting its
 * `schemas()` caller. `schemas()` and `execute()` both consult it. The equivalent boundary on the
 * `claude-code` path is `--allowedTools`, built from the same `request.allowedTools` by
 * `claude-code/tools.ts` — without this, the API providers would have been strictly more permissive
 * than the CLI provider reading the very same MCP config, which is not a difference any operator
 * would expect to follow from their choice of model vendor.
 *
 * ## Timeouts and the result-size cap (NFR-5)
 *
 * Every `tools/call` is bounded by `callTimeoutMs` (default {@link DEFAULT_CALL_TIMEOUT_MS} — see
 * that constant for the reasoning). A hung MCP server — one that accepted the connection, listed its
 * tools, and then simply never answers a particular call — must degrade exactly one tool call for
 * the model to retry or work around, not wedge the whole assignment for however long the provider's
 * own tool-loop bound (`MAX_TOOL_ITERATIONS` in `anthropic/provider.ts`) would otherwise allow it to
 * wait.
 *
 * The same `callTimeoutMs` also bounds *connecting* to a server and listing its tools at startup —
 * see {@link connectAllServers} — because a handshake that never completes is the same failure mode
 * as a call that never completes, just earlier in the lifecycle, and there is no principled reason to
 * give it a more generous allowance.
 *
 * `maxResultChars` (default {@link DEFAULT_MAX_RESULT_CHARS}) caps the flattened text handed back to
 * the model per call. `apiTools.ts`'s header has an extended argument for why an uncapped tool result
 * is a cost and context blowout under NFR-5 — a huge `Read` result silently doubling a request's token
 * count is exactly as bad whether the bytes came from the local filesystem or a spawned MCP server,
 * and the fix is the same shape: truncate with a note, never truncate silently.
 *
 * ## Flattening MCP content to a string
 *
 * `ToolResult.content` is a single string; MCP's `tools/call` result is a list of typed content
 * blocks (`text`, `image`, `audio`, an embedded `resource`, or a `resource_link`). `flattenResult`
 * below joins the text blocks (and any embedded *text* resource) verbatim, and replaces binary
 * blocks (`image`, `audio`, a `resource` whose payload is a `blob`) with a short bracketed note
 * instead of their base64 payload. That is a considered choice, not an oversight: forwarding raw
 * base64 image/audio data into a text-only chat-completions message either does nothing useful (most
 * of these models cannot decode it back out of a text tool result) or, worse, silently spends a large
 * fraction of a context window and this handle's `maxResultChars` budget on bytes the model cannot
 * act on. Dropping the bytes while keeping a note is the honest middle ground: the model learns a
 * non-text result existed (and can be told, in an agent's brief, to avoid tools that return one, or a
 * future stage can add real multimodal support) rather than the tool call silently looking like it
 * returned nothing at all.
 *
 * ## Graceful degradation, one server at a time (NFR-8)
 *
 * A malformed entry in the config file, a command that fails to spawn, a handshake that errors out,
 * or a handshake that never completes within `callTimeoutMs` — none of these fail `createMcpTools`
 * itself. Each is recorded as a diagnostic against that one server name (see
 * {@link McpTools.serverDiagnostics}) and every other configured server still starts and works. This
 * runs through the whole codebase — `claude-code/mcpConfig.ts` fails the whole run for a broken
 * *config file* (a one-time operator mistake, worth surfacing loudly and once) but was never in a
 * position to make one broken *server* take down the others, because the CLI owns that layer itself.
 * This module is the layer for the API providers, so the same posture — one bad entry degrades to
 * "that entry is unavailable", not "nothing works" — lives here instead.
 *
 * That failure is made visible twice, deliberately: `execute()` returns a clear `isError: true`
 * result naming the server and the reason if a model tries to call an unavailable tool anyway (the
 * channel that actually reaches the model, so it can explain the gap rather than silently stalling),
 * and `serverDiagnostics` exposes the same information structurally for a caller that wants to log or
 * surface "MCP partially degraded" without parsing tool-result strings.
 *
 * ## `close()`
 *
 * Every ready connection is a spawned OS process holding open pipes; leaking one per assignment is a
 * real defect, not a cosmetic one, on a server that runs many assignments over its lifetime.
 * `close()` is memoized (a `closePromise` computed once and returned on every subsequent call) so
 * calling it twice — expected, since both a normal completion path and an abort/cleanup path in the
 * caller may each want to guarantee cleanup — is a no-op the second time rather than a double-close
 * race. It uses `Promise.allSettled` internally so one server's shutdown throwing (its process already
 * gone, its pipe already broken) cannot stop the others from being asked to close too, and it never
 * rejects — see the comment on {@link closeAllConnections} for why "reliable" is defined as "does not
 * throw", not "every process definitely exited cleanly".
 *
 * A server whose connection attempt is still outstanding when `callTimeoutMs` elapses is treated as
 * failed for this handle's entire lifetime — `connectAllServers` stops waiting on it and returns —
 * but the underlying attempt is not abandoned in a way that could leak it: a `.then()` is attached
 * that closes whatever connection eventually lands, whenever it lands, whether or not the caller has
 * called `close()` on the handle by then. This is what makes "`close()` called during startup" safe
 * even though, by construction, nobody outside this module can literally call `close()` before
 * `createMcpTools`'s promise resolves — the scenario that actually occurs is a slow server still
 * finishing its handshake in the background *after* `createMcpTools` has already given up on it and
 * returned a working handle for everyone else, and that straggler must never be silently registered
 * (which would make tool availability depend on timing) and must never be left running (which would
 * leak it) regardless of what the caller does with the handle in the meantime.
 *
 * ## Second root: the subject (S8)
 *
 * `apiTools.ts`'s module doc explains the problem this closes: a run can carry `RunState.subjectPath`
 * (what the task is *about*), the brief tells an agent to read from it unconditionally, and until now
 * every tool this codebase built refused any absolute path outright — including this module's, except
 * that this module never had a filesystem tool of its own to refuse with. Its `SandboxedTools` are
 * whatever an operator's *own* configured MCP servers expose — external processes with no inherent
 * relationship to `workspaceDir` or a subject path at all — so there was nothing here to extend the way
 * `apiTools.ts`'s `Read`/`Glob`/`Grep`/`LS` could be extended.
 *
 * `CreateMcpToolsOptions.subjectDir` closes that gap with two small, IN-PROCESS, read-only tools this
 * module defines itself — `mcp__subject__read` and `mcp__subject__ls` — rather than by trying to make
 * arbitrary operator-configured servers respect a root they know nothing about (there is no way to
 * enforce read-only-ness on an opaque external process's own filesystem access; that would be a
 * different trust boundary this bridge cannot see into, let alone police).
 *
 * **Addressing mechanism — a separate tool, not an argument.** `apiTools.ts`'s Anthropic-shaped tools
 * added an explicit `root` argument to four existing tools. MCP's own idiom is namespaced tool names,
 * not argument-variant tools, so the equivalent decision here is a distinct pair of tools under a
 * reserved server name: *`mcp__subject__read` and `mcp__subject__ls` read this run's subject root;
 * they exist only when a subject path is configured, and nothing else in this module's tool surface can
 * address that root.* This is "the same way" `apiTools.ts` and this module satisfy FR-T4's "identical
 * across provider families": not identical mechanics (the two tool shapes are genuinely different, per
 * this module's own header), but the identical CAPABILITY — read-only, optional, containment-checked,
 * attributable — expressed idiomatically for each shape. A model reading `mcp__subject__read` in its
 * tool list already knows which root it is calling, for the same reason `root: "subject"` does on the
 * other shape: the address is part of the call itself, never inferred or merged from two silent
 * sources.
 *
 * **Structurally read-only.** Stronger than `apiTools.ts`'s case, not just differently argued: this
 * module defines exactly two subject-root tools, `read` and `ls`, full stop — there is no
 * `mcp__subject__write` or `mcp__subject__edit` for a flag to gate, because no such tool exists
 * anywhere in this file for `execute()` to route to. A model cannot call a write tool that was never
 * defined; that is not a check that could be bypassed, there is simply nothing on the other end of the
 * call.
 *
 * **Containment: `store/util.ts`'s `resolveWithin`, not `apiTools.ts`'s own pipeline — a real, narrower
 * guarantee, stated rather than hidden.** `resolveSubjectPath` (below) calls `resolveWithin` directly:
 * lexical containment only (traversal, absolute-path and control-character rejection, plus a
 * `path.relative` sanity check), with no `fs.realpath` symlink-following step. `apiTools.ts`'s own
 * module doc spends real length explaining why lexical-only containment is not enough once symlinks
 * are in play, and that reasoning is not wrong here — it is simply not what this module reuses, for a
 * concrete, non-lazy reason: `apiTools.ts`'s realpath + SEC-07 pipeline is a substantial piece of
 * machinery (a second `fs.stat`-derived identity baseline compared via `fstat` on an open handle, to
 * defeat a check-then-open race). Rebuilding that machinery a second time, in a module that has never
 * needed a containment story of its own before this, is exactly the "second, weaker implementation"
 * the requirement behind this fix warns against — a hand-rolled reimplementation drifting from the
 * original is a worse outcome than reusing the shared, tested, lexical primitive `store/util.ts`
 * already exports for exactly this purpose (run/assignment directory containment). The trade this
 * accepts, plainly: a symlink inside a subject repository that points outside it would be followed by
 * `mcp__subject__read`'s `fs.readFile`, where `apiTools.ts`'s equivalent would refuse it. This is a
 * real, narrower guarantee than the Anthropic-shaped side gets, and is recorded here — and in this
 * fix's own report — as something a reviewer may reasonably want closed by giving this module the
 * heavier pipeline later, rather than something quietly accepted.
 *
 * **The reserved name.** `"subject"` is a server name this module refuses to connect to an operator's
 * own config entry for whenever `subjectDir` is configured — see the reservation check in
 * `createMcpTools` — because two different things named `mcp__subject__read` (one this module's own
 * built-in, one an operator's external server) would be exactly the un-attributable collision this
 * whole feature exists to avoid. The reservation is conditional on `subjectDir` being set: with no
 * subject root configured, a server an operator happens to call "subject" behaves exactly as it always
 * has (see "Optional everywhere" below).
 *
 * **Optional everywhere.** `subjectDir` is `undefined` unless a caller sets
 * `CreateMcpToolsOptions.subjectDir`, which no caller in this repo does yet — wiring
 * `RunState.subjectPath` through `dispatcher.ts` into both this option and `createSandboxedTools`'s
 * third parameter is the follow-up this fix deliberately does not make. With it absent: `schemas()`
 * never advertises `mcp__subject__*`, `execute()` never special-cases those names (a call for one falls
 * through to the ordinary "not registered" handling, exactly as it did before this option existed), and
 * a `"subject"` entry in an operator's own config is never reserved or reported as a collision. Every
 * path a caller that never sets `subjectDir` can reach is therefore byte-for-byte what it was before
 * this change.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Default bound, in milliseconds, on a single `tools/call` round trip — and, reused, on connecting to
 * a server and listing its tools at startup (`connectAllServers`).
 *
 * There is no live deployment to calibrate this against yet, so this is a judgement call, recorded so
 * it is easy to revisit once real MCP servers exist to measure. The dashboard's own engines (a tax
 * calculation, a decision-table evaluation, a macro model) are the motivating case, and those are
 * genuine computation, not instant lookups — a timeout tuned for "a network round trip" (a few
 * seconds) would false-positive on legitimate work. 30 seconds is chosen as long enough to absorb that
 * without a second thought, while still being short enough that a truly hung server costs the
 * assignment one bounded stall rather than an unbounded one: `anthropic/provider.ts`'s
 * `MAX_TOOL_ITERATIONS` (30) means a pathological run that hits a hung tool on every iteration is
 * bounded at 30 * 30s = 15 minutes worst case, not "forever" — still bad, but a bound, which unbounded
 * waiting is not.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Default cap, in characters, on the flattened text of one tool result.
 *
 * Deliberately smaller than `apiTools.ts`'s `MAX_READ_OUTPUT_CHARS` (200,000): that cap guards
 * against a model asking to read an entire large file, which is a legitimate (if expensive) thing to
 * want. An MCP tool call in this codebase's motivating case is a structured financial computation —
 * a tax summary, a decision table, a macro projection — whose useful output is a bounded table of
 * numbers, not a file dump. 50,000 characters comfortably covers a large multi-year summary table
 * while still bounding the worst case: a misbehaving or verbose server cannot silently blow out a
 * request's token budget the way an uncapped result could (NFR-5 — see the module doc's extended
 * discussion, which mirrors `apiTools.ts`'s header on the same point).
 */
export const DEFAULT_MAX_RESULT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface McpTools extends SandboxedTools {
  /** Shut down every spawned server. Safe to call twice. */
  close(): Promise<void>;
  /**
   * Server name -> human-readable reason it is unusable for this handle's lifetime: a malformed
   * config entry, a command that failed to spawn, a handshake that errored, or a handshake that
   * never completed within the connect timeout. Servers that connected successfully are absent from
   * this map. See the module doc's "Graceful degradation" section for why this exists alongside (not
   * instead of) the `isError` result a model gets from calling an unavailable tool directly.
   */
  readonly serverDiagnostics: ReadonlyMap<string, string>;
}

export interface CreateMcpToolsOptions {
  /**
   * The assignment's permission boundary: when supplied, both `schemas()` and `execute()` refuse any
   * name outside it. Every caller in this repo passes `request.allowedTools`; see the module doc's
   * "`allowedTools` boundary" section for why holding it here — rather than trusting whatever list
   * `schemas()` happens to be called with — is what makes it a boundary at all.
   *
   * Omitting it means "unconstrained", matching `createSandboxedTools`'s optional second parameter.
   * Matching that convention is deliberate: two tool sources composed into one
   * (`composeTools.ts`) should not disagree about what an absent allowlist means.
   *
   * Compared case-sensitively, unlike `createSandboxedTools`'s. Its tool names are this codebase's
   * own PascalCase words, where a model writing `read` for `Read` is a formatting slip worth
   * tolerating; an MCP tool name is an identifier the *server* defined and matches exactly over the
   * wire, so a case-folded match here could grant `mcp__s__deleteAll` on a request for
   * `mcp__s__deleteall` — and then fail at the server anyway.
   */
  allowedTools?: readonly string[];
  /** Bound on one `tools/call`, and on connecting to a server at startup. Default {@link DEFAULT_CALL_TIMEOUT_MS}. */
  callTimeoutMs?: number;
  /** Cap on one flattened tool result. Default {@link DEFAULT_MAX_RESULT_CHARS}. */
  maxResultChars?: number;
  /**
   * Optional, read-only second root — `RunState.subjectPath` (S8). Absent (every caller in this repo
   * today) reproduces the exact, only behaviour this module had before it existed: no `mcp__subject__*`
   * tools advertised or executable, and any `"subject"`-named server in the operator's own MCP config
   * left completely alone. When present, this module advertises and serves `mcp__subject__read` and
   * `mcp__subject__ls` — read-only, containment-checked against this directory via `store/util.ts`'s
   * `resolveWithin` — and reserves the server name `"subject"` so an operator's own config cannot
   * collide with them. See the module doc's "Second root" section for the full design and the
   * containment trade-off it makes explicit.
   */
  subjectDir?: string;
  /**
   * Seams, injected only by tests. Follows the same `deps.createTools`-style convention
   * `anthropic/provider.ts` already uses rather than inventing a second style.
   */
  deps?: {
    /**
     * Replaces how a server connection is established. Real callers never set this — production
     * uses {@link defaultConnect} (spawn via `StdioClientTransport`, connect an SDK `Client`, list
     * its tools). Tests substitute a fake here instead of spawning a real subprocess: the alternative
     * would be shipping a throwaway MCP server binary just to exercise namespacing, timeout and
     * error-path behaviour that has nothing to do with what any particular server implementation
     * does.
     */
    connect?: McpConnectionFactory;
  };
}

/** Thrown only for a configured-but-unusable *file* — never for one bad server entry within it (see the module doc). */
export class McpToolsConfigError extends Error {}

/**
 * Spawn every server named in the config file at `configPath`, list their tools, and expose them as
 * `SandboxedTools` under the `mcp__<server>__<tool>` namespace.
 *
 * `configPath === undefined` returns a handle whose `schemas()` is always empty and whose `execute()`
 * always fails with a clear "MCP is not configured" result — MCP disabled is a no-op, not an error, so
 * a provider does not need an `if (mcpEnabled)` branch around every call site.
 */
export async function createMcpTools(
  configPath: string | undefined,
  options?: CreateMcpToolsOptions,
): Promise<McpTools> {
  const permitted = options?.allowedTools === undefined ? undefined : new Set(options.allowedTools);
  const maxResultChars = options?.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const subjectDir = options?.subjectDir;

  // MCP itself may be fully disabled (`configPath === undefined`) while a subject root is still
  // configured — the two are independent switches (see the module doc's "Second root" "Optional
  // everywhere" note). With no subject root either, this is the exact handle every caller got before
  // `subjectDir` existed. With one, the subject tools are the ONLY thing this handle can ever offer —
  // there is no config file to spawn anything else from.
  if (configPath === undefined) {
    if (subjectDir === undefined) return emptyMcpTools();
    return {
      serverDiagnostics: new Map(),
      schemas: (requested) => subjectSchemas(requested, permitted),
      execute: (name, input) => subjectExecute(name, input, subjectDir, permitted, maxResultChars),
      close: async () => {},
    };
  }

  const callTimeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const connect = options?.deps?.connect ?? defaultConnect;

  const { configs, diagnostics: configDiagnostics } = await readServerConfigs(configPath);

  // Reserve the "subject" server name — see the module doc's "Second root" section. Conditional on
  // `subjectDir` being set: with none, an operator's own server literally named "subject" is left
  // completely alone (Optional everywhere).
  if (subjectDir !== undefined && SUBJECT_SERVER_NAME in configs) {
    configDiagnostics.set(
      SUBJECT_SERVER_NAME,
      `the name "${SUBJECT_SERVER_NAME}" is reserved for this run's built-in read-only subject-root ` +
        'tools because a subject path is configured for this run; rename this entry in the MCP config',
    );
    delete configs[SUBJECT_SERVER_NAME];
  }

  const { connections, diagnostics: connectDiagnostics } = await connectAllServers(
    configs,
    connect,
    callTimeoutMs,
  );

  const diagnostics = new Map<string, string>([...configDiagnostics, ...connectDiagnostics]);
  const toolIndex = new Map<string, Map<string, McpToolInfo>>();
  for (const [serverName, connection] of connections) {
    toolIndex.set(serverName, new Map(connection.tools.map((tool) => [tool.name, tool])));
  }

  let closed = false;
  let closePromise: Promise<void> | undefined;

  return {
    serverDiagnostics: diagnostics,

    schemas(requested: readonly string[]): ToolSchema[] {
      // A closed handle offers nothing new to advertise. It is not an error to call schemas() after
      // close() — a provider's tool loop may legitimately build a fresh request after cleanup — it
      // just correctly reports that nothing is available anymore.
      if (closed) return [];

      // The subject-root tools first, real servers after — mirroring `apiTools.ts`'s comment on why
      // the audited, in-process layer goes first when two sources are combined. There is no possible
      // collision to order here (the reservation above guarantees it), but the order still documents
      // which layer is "this codebase's own" versus "an operator's own config".
      const out: ToolSchema[] = subjectDir === undefined ? [] : subjectSchemas(requested, permitted);
      const seen = new Set<string>();
      for (const fullName of requested) {
        if (seen.has(fullName)) continue; // a duplicate in `requested` must not produce a duplicate schema
        seen.add(fullName);

        const parsed = parseNamespacedTool(fullName);
        if (parsed === undefined) continue; // not an mcp__ name at all — not this module's tool to advertise

        // Advertised must be a subset of permitted, not merely equal to it because both call sites
        // happen to pass the same list. `requested` is whatever the caller asked about; `permitted`
        // is what this assignment was granted.
        if (permitted !== undefined && !permitted.has(fullName)) continue;

        const info = toolIndex.get(parsed.server)?.get(parsed.tool);
        // Unknown server, a server that failed to start, or a tool that server does not actually
        // report: all three collapse to "not offered". A model that asks for one anyway gets a
        // specific reason back from execute() (see below) rather than a vaguer one here — schemas()
        // only has to answer "is it available", not "why not".
        if (info === undefined) continue;

        out.push({
          name: fullName,
          description: info.description ?? `MCP tool "${parsed.tool}" on server "${parsed.server}".`,
          inputSchema: info.inputSchema,
        });
      }
      return out;
    },

    async execute(name: string, input: unknown): Promise<ToolResult> {
      try {
        if (closed) {
          return {
            isError: true,
            content: `"${name}" is unavailable: MCP tools have been shut down for this assignment.`,
          };
        }

        // Route to the subject-root tools before the general mcp__<server>__<tool> handling below —
        // they are never a registered "server" in `connections`/`toolIndex`, so falling through would
        // otherwise report them as "not registered in this deployment's MCP config", which is
        // technically true but a worse answer than actually running them. With no subjectDir, this
        // branch is never taken (the name-comparison below is `false` for every call), so a
        // `mcp__subject__*` name — including one belonging to an operator's own server before this
        // option existed — falls through to the unchanged general path.
        if (subjectDir !== undefined && (name === SUBJECT_READ_NAME || name === SUBJECT_LS_NAME)) {
          return await subjectExecute(name, input, subjectDir, permitted, maxResultChars);
        }

        const parsed = parseNamespacedTool(name);
        if (parsed === undefined) {
          return {
            isError: true,
            content: `"${name}" is not an MCP tool name (expected "mcp__<server>__<tool>").`,
          };
        }
        const { server, tool } = parsed;

        // Checked BEFORE the connection and diagnostic lookups below, not after. Those branches
        // report whether a server is registered and, if it failed, why — useful to a model working
        // around a degraded tool it was actually granted, and needless detail about this
        // deployment's MCP topology for one it was not. A refusal here answers the only question a
        // disallowed call raises.
        if (permitted !== undefined && !permitted.has(name)) {
          return {
            isError: true,
            content: `"${name}" is not available to this assignment. Use only the tools you were offered.`,
          };
        }

        const diagnostic = diagnostics.get(server);
        if (diagnostic !== undefined) {
          return {
            isError: true,
            content: `MCP server "${server}" is unavailable (${diagnostic}); "${name}" cannot run.`,
          };
        }

        const connection = connections.get(server);
        if (connection === undefined) {
          return {
            isError: true,
            content: `"${name}" refers to MCP server "${server}", which is not registered in this deployment's MCP config.`,
          };
        }

        const toolInfo = toolIndex.get(server)?.get(tool);
        if (toolInfo === undefined) {
          return {
            isError: true,
            content: `MCP server "${server}" has no tool named "${tool}".`,
          };
        }

        const args = normalizeArguments(input);
        if (!args.ok) {
          return { isError: true, content: `"${name}": ${args.message}` };
        }

        // Bounded independently of whatever the connection layer does on its own. `defaultConnect`
        // already threads `callTimeoutMs` into the SDK's own request timeout, so in production this
        // rarely does more than confirm what would have happened anyway — but `callTool` on
        // `McpServerConnection` is part of the injectable seam, and a factory that does not enforce
        // its own timeout (a bug in a future factory, or simply a fake in a test) must not be able to
        // wedge this call forever. Same reasoning as `raceWithTimeout`'s use in `connectAllServers`,
        // applied to the call phase instead of the connect phase.
        const attempt = connection.callTool(tool, args.value, callTimeoutMs);
        const outcome = await raceWithTimeout(attempt, callTimeoutMs);

        if (outcome.tag === 'timeout') {
          // The call itself is not cancelled — MCP's stdio transport gives no way to abort a request
          // already sent — so whatever it eventually resolves or rejects to must not become an
          // unhandled rejection now that nothing is awaiting it.
          attempt.catch(() => {});
          return {
            isError: true,
            content: `"${name}" timed out after ${callTimeoutMs}ms waiting for a response from server "${server}".`,
          };
        }
        if (outcome.tag === 'error') {
          return {
            isError: true,
            content: `"${name}" failed: ${describeError(outcome.error)} (the server process may have crashed).`,
          };
        }

        return flattenResult(name, outcome.value, maxResultChars);
      } catch (error) {
        // Belt and braces, mirroring apiTools.ts's createSandboxedTools: the interface promises
        // execute() never throws, and every path above already has its own catch, but this is the net
        // under that net for anything unanticipated (a bug in flattenResult, say).
        return { isError: true, content: `"${name}" failed unexpectedly: ${describeError(error)}` };
      }
    },

    close(): Promise<void> {
      if (closePromise === undefined) {
        closed = true;
        closePromise = closeAllConnections([...connections.values()]);
      }
      return closePromise;
    },
  };
}

/** The handle `createMcpTools` returns when `configPath` is `undefined` — MCP disabled, not an error. */
function emptyMcpTools(): McpTools {
  return {
    serverDiagnostics: new Map(),
    schemas: () => [],
    execute: async (name: string) => ({
      isError: true,
      content: `"${name}" is not available: MCP is not configured for this deployment.`,
    }),
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Second root: the subject (S8) — see the module doc's "Second root" section
// for the design; this is the implementation.
// ---------------------------------------------------------------------------

/** Reserved MCP server name. See the module doc's "Second root" → "The reserved name". */
const SUBJECT_SERVER_NAME = 'subject';
const SUBJECT_READ_NAME = `mcp__${SUBJECT_SERVER_NAME}__read`;
const SUBJECT_LS_NAME = `mcp__${SUBJECT_SERVER_NAME}__ls`;

/** Mirrors `apiTools.ts`'s `MAX_READ_FILE_BYTES` — same reasoning, same number, different file. */
const MAX_SUBJECT_READ_BYTES = 10 * 1024 * 1024;
/** Mirrors `apiTools.ts`'s `MAX_LS_ENTRIES`. */
const MAX_SUBJECT_LS_ENTRIES = 1000;

const SUBJECT_TOOL_DEFS: readonly ToolSchema[] = [
  {
    name: SUBJECT_READ_NAME,
    description:
      "Read a text file from this run's read-only subject root (the repository or directory the task " +
      'is about, if one is configured). `path` is relative to the subject root; absolute paths are ' +
      'rejected. This tool never writes — there is no corresponding write tool for the subject root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the subject root.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: SUBJECT_LS_NAME,
    description:
      "List the immediate contents of a directory under this run's read-only subject root. `path` " +
      "defaults to the subject root's own top level.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Path, relative to the subject root, of the directory to list. Defaults to the subject root's top level.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/** `schemas()` for the subject-root tools alone — see {@link createMcpTools}'s use of this. */
function subjectSchemas(requested: readonly string[], permitted: ReadonlySet<string> | undefined): ToolSchema[] {
  const wanted = new Set(requested);
  return SUBJECT_TOOL_DEFS.filter(
    (def) => wanted.has(def.name) && (permitted === undefined || permitted.has(def.name)),
  );
}

/**
 * `execute()` for the subject-root tools alone. Callers only reach this for `name ===
 * SUBJECT_READ_NAME || name === SUBJECT_LS_NAME` (see {@link createMcpTools}), but the permission
 * check and the "which tool" dispatch both live here rather than at the call site, so this function is
 * a complete, independently testable answer to "run this subject-root tool call" — the same shape as
 * `apiTools.ts`'s own per-tool handlers.
 */
async function subjectExecute(
  name: string,
  input: unknown,
  subjectDir: string,
  permitted: ReadonlySet<string> | undefined,
  maxResultChars: number,
): Promise<ToolResult> {
  if (permitted !== undefined && !permitted.has(name)) {
    return {
      isError: true,
      content: `"${name}" is not available to this assignment. Use only the tools you were offered.`,
    };
  }
  if (name === SUBJECT_READ_NAME) return subjectReadTool(subjectDir, input, maxResultChars);
  return subjectLsTool(subjectDir, input);
}

/**
 * Resolve `rawPath` against `subjectDir` using `store/util.ts`'s `resolveWithin` — see the module
 * doc's "Second root" section for why THIS primitive, specifically, is what this module reuses rather
 * than `apiTools.ts`'s own stronger, symlink-aware pipeline, and for the resulting narrower guarantee.
 *
 * `resolveWithin` itself rejects an empty relative path (via `assertSafeRelativePath`), which is right
 * for `mcp__subject__read` (a file read always needs a name) but wrong for `mcp__subject__ls` at the
 * subject root's own top level — mirroring `apiTools.ts`'s `resolveSandboxedTarget`'s `allowRoot`
 * parameter, empty/`"."` is special-cased here to mean "the root itself" only when `allowRoot` is true.
 */
function resolveSubjectPath(
  subjectDir: string,
  rawPath: string,
  allowRoot: boolean,
): { ok: true; absPath: string } | { ok: false; message: string } {
  const trimmed = rawPath.trim();
  if (trimmed === '' || trimmed === '.') {
    if (!allowRoot) {
      return { ok: false, message: 'refusing to use the subject root itself as a file target; name a file' };
    }
    return { ok: true, absPath: path.resolve(subjectDir) };
  }
  try {
    return { ok: true, absPath: resolveWithin(subjectDir, trimmed) };
  } catch (error) {
    if (error instanceof UnsafePathError) {
      return {
        ok: false,
        message: `refusing path "${rawPath}": it is absolute, drive-relative, escapes the subject root with "..", or contains a control character`,
      };
    }
    throw error;
  }
}

function parseSubjectPathArg(input: unknown, required: boolean): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (input === undefined || input === null) {
    if (required) return { ok: false, message: '"path" is required and must be a non-empty string.' };
    return { ok: true, value: undefined };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'input must be a JSON object.' };
  }
  const raw = (input as { path?: unknown }).path;
  if (raw === undefined) {
    if (required) return { ok: false, message: '"path" is required and must be a non-empty string.' };
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string' || (required && raw.length === 0)) {
    return { ok: false, message: '"path" must be a non-empty string.' };
  }
  return { ok: true, value: raw };
}

async function subjectReadTool(subjectDir: string, input: unknown, maxResultChars: number): Promise<ToolResult> {
  const parsed = parseSubjectPathArg(input, true);
  if (!parsed.ok) return { isError: true, content: `"${SUBJECT_READ_NAME}": ${parsed.message}` };
  const rawPath = parsed.value as string; // required: true guarantees a defined, non-empty string here

  const resolved = resolveSubjectPath(subjectDir, rawPath, false);
  if (!resolved.ok) return { isError: true, content: `"${SUBJECT_READ_NAME}": ${resolved.message}` };

  let stat;
  try {
    stat = await fsp.stat(resolved.absPath);
  } catch {
    return { isError: true, content: `"${SUBJECT_READ_NAME}": "${rawPath}" does not exist in the subject root.` };
  }
  if (stat.isDirectory()) {
    return {
      isError: true,
      content: `"${SUBJECT_READ_NAME}": "${rawPath}" is a directory, not a file. Use "${SUBJECT_LS_NAME}" instead.`,
    };
  }
  if (stat.size > MAX_SUBJECT_READ_BYTES) {
    return {
      isError: true,
      content: `"${SUBJECT_READ_NAME}": "${rawPath}" is ${stat.size} bytes, over the ${MAX_SUBJECT_READ_BYTES}-byte cap.`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(resolved.absPath);
  } catch (error) {
    return { isError: true, content: `"${SUBJECT_READ_NAME}": could not read "${rawPath}": ${describeError(error)}` };
  }
  if (buffer.includes(0)) {
    return {
      isError: true,
      content: `"${SUBJECT_READ_NAME}": "${rawPath}" looks like a binary file (contains a NUL byte); only text is supported.`,
    };
  }

  let content = buffer.toString('utf8');
  if (content.length > maxResultChars) {
    content = `${content.slice(0, maxResultChars)}…\n\n[${SUBJECT_READ_NAME}: output truncated at ${maxResultChars} characters]`;
  }
  return { content, isError: false };
}

async function subjectLsTool(subjectDir: string, input: unknown): Promise<ToolResult> {
  const parsed = parseSubjectPathArg(input, false);
  if (!parsed.ok) return { isError: true, content: `"${SUBJECT_LS_NAME}": ${parsed.message}` };
  const rawPath = parsed.value ?? '';
  const displayPath = rawPath === '' ? '.' : rawPath;

  const resolved = resolveSubjectPath(subjectDir, rawPath, true);
  if (!resolved.ok) return { isError: true, content: `"${SUBJECT_LS_NAME}": ${resolved.message}` };

  let stat;
  try {
    stat = await fsp.stat(resolved.absPath);
  } catch {
    return { isError: true, content: `"${SUBJECT_LS_NAME}": "${displayPath}" does not exist in the subject root.` };
  }
  if (!stat.isDirectory()) {
    return { isError: true, content: `"${SUBJECT_LS_NAME}": "${displayPath}" is a file, not a directory.` };
  }

  let entries;
  try {
    entries = await fsp.readdir(resolved.absPath, { withFileTypes: true });
  } catch (error) {
    return { isError: true, content: `"${SUBJECT_LS_NAME}": could not list "${displayPath}": ${describeError(error)}` };
  }

  const lines = entries
    .map((entry) => {
      if (entry.isSymbolicLink()) return `${entry.name} (symlink, not followed)`;
      if (entry.isDirectory()) return `${entry.name}/`;
      return entry.name;
    })
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (lines.length === 0) return { content: `${SUBJECT_LS_NAME}: (empty directory)`, isError: false };

  const capped = lines.slice(0, MAX_SUBJECT_LS_ENTRIES);
  const suffix =
    lines.length > MAX_SUBJECT_LS_ENTRIES
      ? `\n\n[${SUBJECT_LS_NAME}: showing first ${MAX_SUBJECT_LS_ENTRIES} of ${lines.length} entries]`
      : '';
  return { content: capped.join('\n') + suffix, isError: false };
}

// ---------------------------------------------------------------------------
// mcp__<server>__<tool> namespacing
// ---------------------------------------------------------------------------

/**
 * Split an `mcp__<server>__<tool>` name into its parts, or `undefined` if it is not one.
 *
 * Delegates server extraction to `claude-code/mcpConfig.ts`'s `mcpServerOf` rather than re-deriving
 * the same first-`__`-after-the-prefix splitting rule — that function's doc comment explains why the
 * split must be on the FIRST `__`, not the last (a tool name may itself contain `__`; a server name
 * may not), and duplicating that logic here would risk the two copies drifting apart. The tool name is
 * then trivially the remainder: `mcpServerOf` already computed exactly how many characters `"mcp__"`
 * plus the server name plus its trailing `"__"` occupy.
 */
function parseNamespacedTool(name: string): { server: string; tool: string } | undefined {
  const server = mcpServerOf(name);
  if (server === undefined) return undefined;
  const tool = name.slice('mcp__'.length + server.length + 2);
  return { server, tool };
}

// ---------------------------------------------------------------------------
// Config file parsing
// ---------------------------------------------------------------------------

interface StdioServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Read and parse the MCP config file, splitting failures into two tiers:
 *
 * - The FILE itself is unreadable, not JSON, or has no `mcpServers` object: this is thrown as
 *   `McpToolsConfigError`, exactly the tier `claude-code/mcpConfig.ts`'s `loadMcpRegistry` throws for
 *   the same reasons and with the same justification — a broken config file is a one-time operator
 *   mistake, and failing loudly once at startup is kinder than every subsequent MCP tool call
 *   failing individually for a reason that traces back to the same typo.
 * - One SERVER ENTRY within an otherwise-valid file is malformed (missing `command`, `args` that is
 *   not a string array, etc.): this is NOT thrown. It is recorded as a diagnostic against that one
 *   server name and excluded from `configs`, so the rest of the file still loads — the same
 *   graceful-degradation posture `connectAllServers` applies to a server that fails to spawn, applied
 *   one step earlier to a server that is malformed before it is ever attempted.
 */
async function readServerConfigs(
  configPath: string,
): Promise<{ configs: Record<string, StdioServerConfig>; diagnostics: Map<string, string> }> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch (error) {
    throw new McpToolsConfigError(`MCP config "${configPath}" could not be read: ${describeError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new McpToolsConfigError(`MCP config "${configPath}" is not valid JSON: ${describeError(error)}`);
  }

  const servers = extractServersObject(parsed);
  if (servers === undefined) {
    throw new McpToolsConfigError(
      `MCP config "${configPath}" has no "mcpServers" object. Expected ` +
        `{ "mcpServers": { "<name>": { "command": ... } } } — the same shape claude-code/mcpConfig.ts reads.`,
    );
  }

  const configs: Record<string, StdioServerConfig> = {};
  const diagnostics = new Map<string, string>();
  for (const [name, value] of Object.entries(servers)) {
    const result = parseServerEntry(value);
    if ('error' in result) {
      diagnostics.set(name, `invalid config entry: ${result.error}`);
    } else {
      configs[name] = result;
    }
  }
  return { configs, diagnostics };
}

/** Mirrors `claude-code/mcpConfig.ts`'s private `extractServers` — that function is not exported, and this is small enough not to be worth changing that module's surface for. */
function extractServersObject(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return undefined;
  return servers as Record<string, unknown>;
}

function parseServerEntry(value: unknown): StdioServerConfig | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'entry is not an object' };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.command !== 'string' || v.command.trim() === '') {
    return { error: '"command" is missing or not a non-empty string' };
  }

  if (v.args !== undefined && !(Array.isArray(v.args) && v.args.every((a) => typeof a === 'string'))) {
    return { error: '"args" must be an array of strings' };
  }
  if (v.cwd !== undefined && typeof v.cwd !== 'string') {
    return { error: '"cwd" must be a string' };
  }
  if (
    v.env !== undefined &&
    (typeof v.env !== 'object' ||
      v.env === null ||
      Array.isArray(v.env) ||
      !Object.values(v.env).every((entry) => typeof entry === 'string'))
  ) {
    return { error: '"env" must be an object with string values' };
  }

  return {
    command: v.command,
    ...(v.args === undefined ? {} : { args: v.args as string[] }),
    ...(v.cwd === undefined ? {} : { cwd: v.cwd as string }),
    ...(v.env === undefined ? {} : { env: v.env as Record<string, string> }),
  };
}

// ---------------------------------------------------------------------------
// Connection layer — the injectable seam
// ---------------------------------------------------------------------------

/** A tool as `tools/list` reports it, before namespacing. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A single MCP content block. `data` (the base64 payload an `image`/`audio` block carries) is
 * declared here so a caller constructing a realistic block compiles, but `flattenResult` never reads
 * it — see the module doc's "Flattening MCP content to a string" section for why forwarding it would
 * be worse than dropping it.
 */
export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

/** The shape `flattenResult` needs from a `tools/call` response — a narrowed view of the SDK's own result type. */
export interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}

/** One live, already-connected MCP server, with its tool list already fetched. */
export interface McpServerConnection {
  readonly tools: readonly McpToolInfo[];
  /** Invoke one tool by its BARE (non-namespaced) name, bounded by `timeoutMs`. */
  callTool(toolName: string, args: Record<string, unknown> | undefined, timeoutMs: number): Promise<McpCallResult>;
  /** Idempotent from the connection's own side is not required — `createMcpTools` never calls this twice on the same connection. */
  close(): Promise<void>;
}

/**
 * Establishes one server connection. Production uses {@link defaultConnect}; tests inject a fake via
 * `CreateMcpToolsOptions.deps.connect` (see that field's doc comment for why).
 */
export type McpConnectionFactory = (
  serverName: string,
  config: StdioServerConfig,
  timeoutMs: number,
) => Promise<McpServerConnection>;

/**
 * The real factory: spawn the server over stdio, connect an SDK `Client`, list its tools.
 *
 * `client.connect(transport, { timeout })` both starts the child process (via
 * `StdioClientTransport.start()`, called internally) and performs the MCP `initialize` handshake,
 * bounded by `timeout` — a command that does not exist rejects immediately (`ENOENT` surfaces through
 * `start()`), and a command that exists but never completes the handshake is cut off at `timeout`
 * rather than hanging forever. If either the connect or the subsequent `listTools()` fails, the
 * client (and therefore the transport and the spawned process) is closed before rethrowing, so a
 * server that connects but then fails to answer `tools/list` does not leave an orphaned process behind
 * for `connectAllServers` to lose track of.
 */
const defaultConnect: McpConnectionFactory = async (_serverName, config, timeoutMs) => {
  const transport = new StdioClientTransport({
    command: config.command,
    ...(config.args === undefined ? {} : { args: config.args }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.env === undefined ? {} : { env: config.env }),
  });
  const client = new Client({ name: 'agent-office-mcp-bridge', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }

  let listed;
  try {
    listed = await client.listTools(undefined, { timeout: timeoutMs });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }

  const tools: McpToolInfo[] = listed.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));

  return {
    tools,
    async callTool(toolName, args, timeout) {
      const result = await client.callTool(
        { name: toolName, ...(args === undefined ? {} : { arguments: args }) },
        undefined,
        { timeout },
      );
      // `result` is a union (a plain call result, or a task-based `{ toolResult }` wrapper the SDK
      // also accepts) whose `isError` field is typed loosely enough that passing it through
      // verbatim does not satisfy `exactOptionalPropertyTypes`. Collapsing it to a definite boolean
      // via `=== true` is exactly what `flattenResult` does with it downstream anyway, so nothing is
      // lost by doing that collapse here instead of threading an ambiguous optional through.
      return {
        content: (result.content ?? []) as McpContentBlock[],
        isError: result.isError === true,
      };
    },
    close: () => client.close(),
  };
};

/**
 * Connect to every configured server concurrently, each bounded by `timeoutMs`, and return whichever
 * ones came up plus a diagnostic for each that did not.
 *
 * Concurrent, not sequential: with `Object.entries(configs).map` racing every attempt in parallel, one
 * slow-to-start server costs at most `timeoutMs` total for the whole batch, not `timeoutMs` times the
 * number of servers. This matters exactly when it matters most — a broken server is often *also* the
 * slow one (retrying a connection that will never succeed), and that server should not make every
 * other, healthy server wait its turn.
 *
 * A server whose attempt does not settle within `timeoutMs` is recorded as failed and NOT waited on
 * further, but the attempt itself is not abandoned in a way that could leak it: see the module doc's
 * "`close()`" section for what happens when (if ever) that straggling attempt eventually resolves.
 */
async function connectAllServers(
  configs: Record<string, StdioServerConfig>,
  connect: McpConnectionFactory,
  timeoutMs: number,
): Promise<{ connections: Map<string, McpServerConnection>; diagnostics: Map<string, string> }> {
  const connections = new Map<string, McpServerConnection>();
  const diagnostics = new Map<string, string>();

  await Promise.all(
    Object.entries(configs).map(async ([serverName, config]) => {
      const attempt = connect(serverName, config, timeoutMs);
      const outcome = await raceWithTimeout(attempt, timeoutMs);

      if (outcome.tag === 'timeout') {
        diagnostics.set(serverName, `did not finish connecting within ${timeoutMs}ms`);
        // We have already told the model this server is unavailable and returned control to the
        // caller — a straggler that connects successfully after that point must never quietly
        // become reachable (tool availability would then depend on timing, which is worse than
        // simply being unavailable) and must never be left running. Close it the moment it lands,
        // whatever `attempt` resolves to and whenever that happens; if it rejects instead, there is
        // nothing to close.
        attempt.then(
          (connection) => {
            connection.close().catch(() => {});
          },
          () => {},
        );
        return;
      }

      if (outcome.tag === 'error') {
        diagnostics.set(serverName, describeError(outcome.error));
        return;
      }

      connections.set(serverName, outcome.value);
    }),
  );

  return { connections, diagnostics };
}

type RaceOutcome<T> = { tag: 'ok'; value: T } | { tag: 'error'; error: unknown } | { tag: 'timeout' };

/**
 * Await `attempt`, but never for longer than `timeoutMs` — resolves with a `'timeout'` outcome
 * instead of leaving the caller waiting if `attempt` has not settled by then.
 *
 * This is a defensive bound applied at the CALL SITE, on top of whatever timeout (if any) the
 * producer of `attempt` implements internally. `defaultConnect` and the SDK's own `callTool` already
 * thread `timeoutMs` into the SDK's own request timeout, so in production this rarely does more than
 * confirm what would have happened anyway — but both `McpConnectionFactory` and
 * `McpServerConnection.callTool` are part of the injectable seam (real servers today, a fake in every
 * test in this suite, conceivably something other than stdio tomorrow), and neither is trusted to
 * enforce its own timeout. Used for both connecting ({@link connectAllServers}) and calling
 * ({@link createMcpTools}'s `execute`) — a hung handshake and a hung tool call are the same failure
 * mode, just at different points in the lifecycle, and there is no principled reason to bound one and
 * not the other. Never rejects, matching the "never throws" discipline this module applies throughout
 * — a timeout is data (an outcome tag), not a control-flow exception.
 */
function raceWithTimeout<T>(attempt: Promise<T>, timeoutMs: number): Promise<RaceOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ tag: 'timeout' });
    }, timeoutMs);

    attempt.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ tag: 'ok', value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ tag: 'error', error });
      },
    );
  });
}

/**
 * Close every live connection, tolerating any individual `close()` throwing.
 *
 * `Promise.allSettled` rather than `Promise.all`: a connection whose process already died (its own
 * `close()` rejecting because the pipe is already gone) must not stop the loop before it reaches the
 * next connection still waiting to be closed. Nothing is done with a settled-but-rejected result
 * beyond letting it be rejected — there is no diagnostic channel for shutdown-time failures in the
 * `McpTools` contract, and by the time `close()` runs the assignment this handle belonged to is
 * already over, so there is no live tool-result channel left to report into either. "Reliable" here
 * means `close()` itself never throws and every connection is at least ASKED to close, not that every
 * process is provably confirmed dead.
 */
async function closeAllConnections(connections: McpServerConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((connection) => connection.close()));
}

// ---------------------------------------------------------------------------
// Argument normalisation and result flattening
// ---------------------------------------------------------------------------

/** MCP tool arguments must be a JSON object (or absent) — never an array, string, number, etc. */
function normalizeArguments(
  input: unknown,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'input must be a JSON object matching the tool\'s input schema.' };
  }
  return { ok: true, value: input as Record<string, unknown> };
}

/**
 * Turn one `tools/call` response into the `ToolResult` string shape, applying the size cap and
 * respecting the result's own `isError` flag (a tool can report failure through MCP's `isError` even
 * when the transport call itself succeeded — e.g. "that ticker does not exist" is the tool doing its
 * job correctly, not a transport problem).
 *
 * See the module doc's "Flattening MCP content to a string" section for why binary blocks (`image`,
 * `audio`, a `resource` carrying a `blob`) become a bracketed note instead of their base64 payload.
 */
function flattenResult(name: string, raw: McpCallResult, maxChars: number): ToolResult {
  const blocks = raw.content ?? [];
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'resource_link') {
      const label = block.name ?? block.uri ?? 'unnamed';
      const uriSuffix = block.uri !== undefined && block.uri !== label ? ` (${block.uri})` : '';
      parts.push(`[resource link: ${label}${uriSuffix}]`);
      continue;
    }
    if (block.type === 'resource' && block.resource !== undefined) {
      if (typeof block.resource.text === 'string') {
        parts.push(block.resource.text);
      } else {
        const mime = block.resource.mimeType !== undefined ? `, ${block.resource.mimeType}` : '';
        parts.push(
          `[embedded resource omitted: ${block.resource.uri ?? 'unknown uri'}${mime} — binary content is not forwarded to the model]`,
        );
      }
      continue;
    }
    // image, audio, or any future block type this module does not specifically understand.
    const mime = block.mimeType !== undefined ? ` (${block.mimeType})` : '';
    parts.push(`[${block.type} content omitted${mime} — binary content is not forwarded to the model]`);
  }

  let content = parts.join('\n\n');
  const notes: string[] = [];
  if (content.length > maxChars) {
    content = `${content.slice(0, maxChars)}…`;
    notes.push(`output truncated at ${maxChars} characters (uncapped MCP output is a cost and context blowout — NFR-5)`);
  }
  if (notes.length > 0) {
    content += `\n\n[${name}: ${notes.join('; ')}]`;
  }
  if (content.trim() === '') {
    content =
      raw.isError === true ? `"${name}" reported an error with no message.` : `"${name}" returned no content.`;
  }

  return { content, isError: raw.isError === true };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** `error.message` for an `Error`, `String(error)` otherwise — never lets a non-`Error` throw crash formatting. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
