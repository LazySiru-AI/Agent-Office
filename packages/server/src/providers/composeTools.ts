import type { SandboxedTools, ToolResult, ToolSchema } from './apiTools.js';

/**
 * Combine several `SandboxedTools` layers into one (Stage 4 of the toolset
 * integration).
 *
 * Before this module existed, the three raw-API providers (`anthropic`,
 * `openai`, `deepseek`) each had exactly one tool source — the sandboxed
 * filesystem tools from `apiTools.ts` — so the tool-use loop in each
 * `provider.ts` could hold one `SandboxedTools` and call it directly. Stage 4
 * gives those providers a second source, MCP servers (`mcpTools.ts`'s
 * `createMcpTools`), and the loop should not have to know it is now talking
 * to two. `composeTools` is the seam that keeps it from having to: it takes
 * any number of `SandboxedTools` layers and returns something that is itself
 * a `SandboxedTools`, so every call site written against the single-layer
 * interface — `tools.schemas(allowed)`, `tools.execute(name, input)` — keeps
 * working unchanged regardless of how many layers are actually behind it.
 * `claude-code/provider.ts` has no equivalent need: the CLI it spawns speaks
 * MCP natively and does its own multiplexing, so this module exists only for
 * the three adapters that have to do that multiplexing themselves.
 *
 * This file is deliberately a pure combinator with no knowledge of what a
 * layer actually is — no `apiTools.ts` import beyond the shared type, no
 * `mcpTools.ts` import at all. That is what lets it be written, and tested,
 * independently of the MCP client landing (a parallel workstream at the time
 * this was written) — it only needs the `SandboxedTools` contract both sides
 * already agreed on.
 *
 * ## Collision policy: first layer wins, silently
 *
 * Two layers could in principle declare the same tool name — a sandboxed
 * `Read` and an MCP `Read` colliding would be exactly the confusing case the
 * brief calls out; a model that gets a tool description for one and a result
 * from the other would have no way to notice, let alone recover. Something
 * has to win, and it should not be left to fall out of whichever layer
 * happens to iterate first inside some other data structure — that is
 * "defined by accident," which is indistinguishable from undefined until the
 * day the iteration order changes.
 *
 * `composeTools` resolves it explicitly: **the first layer in argument
 * order wins**, for both `schemas()` (its entry is what appears, the later
 * one's matching entry is simply never reached — see the note on
 * `schemas()` below) and `execute()` (routing checks layers in order and
 * stops at the first match). Every call site in this repo composes the
 * sandboxed filesystem tools first and MCP second —
 * `composeTools(sandboxedTools, mcpTools)` — so in practice this means the
 * audited, NFR-1-governed sandbox always wins a collision over a server an
 * operator configured, never the reverse. That is the safer default: the
 * sandbox's containment guarantees (see `apiTools.ts`'s module doc) are
 * something this codebase has verified in depth; an MCP server is a process
 * this deployment chose to trust for *some* capability, not necessarily one
 * this codebase has any reason to let redefine `Read`.
 *
 * In practice this collision is very unlikely to fire at all: MCP tool names
 * are namespaced `mcp__<server>__<tool>` by the convention `claude-code/
 * mcpConfig.ts` documents (see `mcpServerOf`), and every sandboxed tool name
 * (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS`) is a bare PascalCase word
 * with no `mcp__` prefix. But "very unlikely" is a statement about today's
 * naming convention, which lives in a different module and could drift —
 * nothing here enforces the prefix, and nothing should have to for this
 * function's behaviour to be well-defined. Silent, deterministic, and
 * documented beats a runtime error on a collision that will hit approximately
 * nobody: a thrown error here would fail a run over a naming coincidence
 * that a first-layer-wins policy resolves without anyone noticing.
 *
 * ## `schemas()`: concatenate, don't de-duplicate
 *
 * `schemas(allowed)` simply concatenates every layer's `schemas(allowed)` in
 * argument order. It does NOT de-duplicate by name even though `execute()`
 * effectively does (via first-match routing) — doing so here would mean
 * silently dropping one layer's `ToolSchema` from what the model is told
 * about, which could differ from the winning layer's (a different
 * `description` or `inputSchema` for what is, per the collision policy
 * above, "the same tool" only in name). Advertising both and letting
 * `execute()` alone decide who actually runs is the more honest failure mode
 * for the rare collision case: a model that reads two conflicting
 * descriptions for one name has visible evidence something is odd, rather
 * than a schema quietly vanishing with no trace in what was offered.
 *
 * ## Unknown tool name: never throw
 *
 * `SandboxedTools.execute` is documented to never throw — a failing call
 * comes back as `{ isError: true, content: "..." }}` so the model can see
 * what went wrong and retry, rather than crashing the run. `composeTools`
 * preserves that promise for the combined case a single layer cannot see on
 * its own: a name that no layer declares at all. Because `execute()` here
 * has no access to the full set of names any layer *could* ever advertise
 * (`schemas()` is a filter over a requested list, not an enumerator — see
 * the note above `execute()` below), the error message it returns cannot
 * usefully enumerate the caller's options the way `apiTools.ts`'s own
 * "Unknown tool" message does. That is a real, acknowledged gap, not an
 * oversight — see `execute()`'s comment for the shape of the trade this
 * makes.
 */
export function composeTools(...layers: readonly SandboxedTools[]): SandboxedTools {
  return {
    schemas(allowedTools: readonly string[]): ToolSchema[] {
      // Order matters here only for what a reader sees when two layers do
      // collide (both entries appear, first layer's first) — see the module
      // doc's "concatenate, don't de-duplicate" note. It has no bearing on
      // `execute()`'s routing decision, which is made independently below.
      return layers.flatMap((layer) => layer.schemas(allowedTools));
    },

    async execute(name: string, input: unknown): Promise<ToolResult> {
      try {
        for (const layer of layers) {
          // "Does this layer declare `name`?" is answered by asking the
          // layer itself, via the exact same `schemas()` method used to
          // advertise tools — never by pattern-matching `name` (an
          // `mcp__` prefix check, say). Sniffing the prefix would hard-code
          // one layer's own naming convention into this otherwise
          // layer-agnostic combinator, and would silently stop working the
          // moment that convention changed in `mcpConfig.ts` without this
          // file's author ever finding out. Querying with `[name]` as the
          // "requested" list reuses whatever allow/deny logic the layer
          // already applies to its own `schemas()` — including, for
          // `apiTools.ts`, the case-insensitive name matching its own
          // `execute()` does — so routing here agrees with what `schemas()`
          // just advertised for the exact same reason, not a re-derived
          // approximation of it.
          const declared = layer.schemas([name]);
          if (declared.length > 0) {
            return await layer.execute(name, input);
          }
        }

        // No layer declares this name. This is not necessarily a bug: a
        // model can emit a call for a tool it hallucinated, or one from a
        // stale turn, same as any single-layer `SandboxedTools` already has
        // to handle. Unlike `apiTools.ts`'s own "Unknown tool" message,
        // this cannot list what IS available — `schemas()` is a filter over
        // a caller-supplied list of names, not an enumerator of everything
        // a layer could ever advertise, so there is no "ask every layer for
        // everything" query this function could make. The model still gets
        // an actionable, non-throwing result; it just has to look at what
        // was actually offered on this turn (its own tool list) to find a
        // valid name, rather than being told the list a second time here.
        return {
          isError: true,
          content: `Unknown tool "${name}". No configured tool source (sandboxed or MCP) declares it.`,
        };
      } catch (error) {
        // Belt and braces, mirroring `apiTools.ts`'s own top-level
        // `execute()` catch-all: every layer's `execute()` is independently
        // documented to never throw, but `schemas()` carries no such
        // documented guarantee, and this combinator calls it once per layer
        // per routing decision above. A bug in a layer still under active
        // development elsewhere (`mcpTools.ts`, written in parallel with
        // this file) throwing out of `schemas()` must not propagate past
        // this function and crash the caller's tool-use loop — the contract
        // this function itself makes ("never throws") has to hold even when
        // a layer's does not.
        return {
          isError: true,
          content: `"${name}" failed unexpectedly while routing between tool sources: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}
