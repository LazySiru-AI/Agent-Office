import { describe, expect, it } from 'vitest';
import type { SandboxedTools, ToolResult, ToolSchema } from './apiTools.js';
import { composeTools } from './composeTools.js';

/**
 * Unit tests for the Stage 4 combinator (`composeTools.ts`).
 *
 * Every layer here is a hand-written stub rather than the real
 * `createSandboxedTools` or `mcpTools.ts`'s `createMcpTools` — this module's
 * whole point is to be correct given nothing but the `SandboxedTools`
 * contract, and `mcpTools.ts` does not exist on disk yet (a parallel Stage 4
 * workstream), so these tests must not depend on it either.
 */

/** A minimal, inspectable `SandboxedTools` stand-in. */
function layer(
  defs: readonly ToolSchema[],
  options: {
    /** Overrides the default `{ content: <name>, isError: false }` result. */
    resultFor?: (name: string, input: unknown) => ToolResult;
    /** Records every `execute()` call, in order. */
    calls?: Array<{ name: string; input: unknown }>;
    /** Throws instead of returning, from `schemas()` — for the defensive-catch test. */
    schemasThrow?: Error;
  } = {},
): SandboxedTools {
  return {
    schemas(allowedTools: readonly string[]): ToolSchema[] {
      if (options.schemasThrow !== undefined) throw options.schemasThrow;
      const wanted = new Set(allowedTools);
      return defs.filter((def) => wanted.has(def.name));
    },
    async execute(name: string, input: unknown): Promise<ToolResult> {
      options.calls?.push({ name, input });
      return options.resultFor?.(name, input) ?? { content: name, isError: false };
    },
  };
}

function schema(name: string): ToolSchema {
  return { name, description: `stub ${name}`, inputSchema: { type: 'object' } };
}

describe('composeTools — schemas()', () => {
  it('concatenates every layer\'s schemas, in layer order, for a name each layer independently declares', () => {
    const a = layer([schema('Read'), schema('Write')]);
    const b = layer([schema('mcp__fs__list')]);
    const combined = composeTools(a, b);

    const names = combined.schemas(['Read', 'Write', 'mcp__fs__list']).map((s) => s.name);
    expect(names).toEqual(['Read', 'Write', 'mcp__fs__list']);
  });

  it('returns an empty array, not a throw or a placeholder, for an empty layer list', () => {
    // A provider with no MCP registry configured composes a single layer, but
    // this proves the combinator itself degrades gracefully to zero layers
    // too, rather than assuming at least one always exists.
    const combined = composeTools();
    expect(combined.schemas(['Read'])).toEqual([]);
  });

  it('advertises both entries on a name collision rather than silently dropping one', () => {
    // Prevents a regression where "de-duplicate by name" quietly drops one
    // layer's ToolSchema (possibly a different description/inputSchema) from
    // what the model is told, with no trace that it ever existed.
    const a = layer([{ name: 'Read', description: 'sandboxed read', inputSchema: { type: 'object' } }]);
    const b = layer([{ name: 'Read', description: 'mcp read', inputSchema: { type: 'object' } }]);
    const combined = composeTools(a, b);

    const descriptions = combined.schemas(['Read']).map((s) => s.description);
    expect(descriptions).toEqual(['sandboxed read', 'mcp read']);
  });

  it('only returns schemas for names actually requested, per layer, matching a single-layer caller', () => {
    const a = layer([schema('Read'), schema('Write')]);
    const combined = composeTools(a);
    expect(combined.schemas(['Read']).map((s) => s.name)).toEqual(['Read']);
  });
});

describe('composeTools — execute() routing', () => {
  it('routes a call to whichever single layer declares the name', async () => {
    const sandboxCalls: Array<{ name: string; input: unknown }> = [];
    const mcpCalls: Array<{ name: string; input: unknown }> = [];
    const sandbox = layer([schema('Read')], { calls: sandboxCalls, resultFor: () => ({ content: 'file contents', isError: false }) });
    const mcp = layer([schema('mcp__fs__list')], { calls: mcpCalls, resultFor: () => ({ content: 'dir listing', isError: false }) });
    const combined = composeTools(sandbox, mcp);

    const readResult = await combined.execute('Read', { path: 'a.txt' });
    const mcpResult = await combined.execute('mcp__fs__list', { path: '.' });

    expect(readResult).toEqual({ content: 'file contents', isError: false });
    expect(mcpResult).toEqual({ content: 'dir listing', isError: false });
    // Each call reached exactly the layer that declared it, not both and not
    // the wrong one — the routing decision this combinator exists to make.
    expect(sandboxCalls).toEqual([{ name: 'Read', input: { path: 'a.txt' } }]);
    expect(mcpCalls).toEqual([{ name: 'mcp__fs__list', input: { path: '.' } }]);
  });

  it('routes a colliding name to the first layer in argument order, never the second', async () => {
    // The documented collision policy: first layer wins, silently. Every real
    // call site composes the sandboxed tools first and MCP second, so this
    // also proves the sandbox always wins over an MCP server that happened to
    // export a tool with the same name.
    const firstCalls: Array<{ name: string; input: unknown }> = [];
    const secondCalls: Array<{ name: string; input: unknown }> = [];
    const first = layer([schema('Read')], { calls: firstCalls, resultFor: () => ({ content: 'from first', isError: false }) });
    const second = layer([schema('Read')], { calls: secondCalls, resultFor: () => ({ content: 'from second', isError: false }) });
    const combined = composeTools(first, second);

    const result = await combined.execute('Read', {});

    expect(result).toEqual({ content: 'from first', isError: false });
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(0);
  });

  it('returns an isError result, never a throw, for a name no layer declares', async () => {
    const combined = composeTools(layer([schema('Read')]), layer([schema('mcp__fs__list')]));
    const result = await combined.execute('DeleteEverything', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('DeleteEverything');
  });

  it('returns an isError result, never a throw, when composed with zero layers', async () => {
    const combined = composeTools();
    const result = await combined.execute('Anything', {});
    expect(result).toEqual({ isError: true, content: expect.stringContaining('Anything') });
  });

  it('never throws even when a layer\'s schemas() throws while this function is deciding routing', async () => {
    // `execute()` is documented (apiTools.ts's SandboxedTools contract) to
    // never throw. Every layer's own execute() independently upholds that,
    // but schemas() carries no such guarantee, and composeTools calls it once
    // per layer while routing — this is the belt-and-braces net for that gap,
    // proven here rather than merely asserted in a comment.
    const broken = layer([schema('Read')], { schemasThrow: new Error('mcp server not connected') });
    const combined = composeTools(broken);
    await expect(combined.execute('Read', {})).resolves.toEqual({
      isError: true,
      content: expect.stringContaining('mcp server not connected'),
    });
  });

  it('never throws even when a layer\'s execute() itself throws (not merely rejects with isError)', async () => {
    const throwing: SandboxedTools = {
      schemas: (allowed) => (allowed.includes('Boom') ? [schema('Boom')] : []),
      execute: () => {
        throw new Error('unexpected synchronous throw');
      },
    };
    const combined = composeTools(throwing);
    await expect(combined.execute('Boom', {})).resolves.toEqual({
      isError: true,
      content: expect.stringContaining('unexpected synchronous throw'),
    });
  });

  it('passes the model-supplied input through to the routed layer unchanged', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const a = layer([schema('Edit')], { calls });
    const combined = composeTools(a);
    const input = { path: 'x.ts', oldText: 'foo', newText: 'bar' };

    await combined.execute('Edit', input);

    expect(calls).toEqual([{ name: 'Edit', input }]);
  });
});
