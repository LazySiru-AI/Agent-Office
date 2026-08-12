import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_CONFIG_ENV_VAR, McpConfigError, loadMcpRegistry, mcpServerOf } from './mcpConfig.js';

/**
 * The MCP registry (Stage 2 of the toolset plan).
 *
 * The theme is that registering a server is an *operator* decision, because an entry in this file
 * is a command that gets executed. Most of these tests are about that boundary holding rather than
 * about JSON parsing.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function configFile(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-office-mcp-'));
  dirs.push(dir);
  const file = path.join(dir, 'mcp.json');
  await writeFile(file, contents, 'utf8');
  return file;
}

describe('loadMcpRegistry', () => {
  it('returns undefined when the variable is unset, without complaint', async () => {
    // MCP is opt-in. The overwhelmingly common case is a deployment that never enables it, and a
    // warning on every run for a feature nobody asked for is how logs become unreadable.
    expect(loadMcpRegistry({})).toBeUndefined();
    expect(loadMcpRegistry({ [MCP_CONFIG_ENV_VAR]: '   ' })).toBeUndefined();
  });

  it('reads the server names an agent may then request', async () => {
    const file = await configFile(
      JSON.stringify({
        mcpServers: {
          investing: { command: 'python', args: ['-m', 'app.mcp.server'] },
          other: { command: 'node', args: ['server.js'] },
        },
      }),
    );

    const registry = loadMcpRegistry({ [MCP_CONFIG_ENV_VAR]: file });

    expect(registry?.configPath).toBe(file);
    expect([...(registry?.serverNames ?? [])].sort()).toEqual(['investing', 'other']);
  });

  it('throws on a configured-but-unreadable path rather than degrading to "no servers"', async () => {
    // WHAT THIS PREVENTS: the wrong debugging session. Silently resolving to zero servers presents
    // as "my agent ignores its tools", which sends the reader into tool resolution — the layer
    // furthest from the actual mistake, which is a typo in a path.
    expect(() =>
      loadMcpRegistry({ [MCP_CONFIG_ENV_VAR]: path.join(os.tmpdir(), 'does-not-exist-9f3a.json') }),
    ).toThrow(McpConfigError);
  });

  it('throws on malformed JSON and on a file with no mcpServers object', async () => {
    const bad = await configFile('{ not json');
    expect(() => loadMcpRegistry({ [MCP_CONFIG_ENV_VAR]: bad })).toThrow(/not valid JSON/);

    const wrongShape = await configFile(JSON.stringify({ servers: {} }));
    expect(() => loadMcpRegistry({ [MCP_CONFIG_ENV_VAR]: wrongShape })).toThrow(/mcpServers/);

    // An array is JSON, and an object, and still not a server map — the shape check has to reject
    // it or `Object.keys` would yield "0", "1", ... as server names.
    const arrayShape = await configFile(JSON.stringify({ mcpServers: [] }));
    expect(() => loadMcpRegistry({ [MCP_CONFIG_ENV_VAR]: arrayShape })).toThrow(/mcpServers/);
  });

  it('accepts an empty server map, which fails closed anyway', async () => {
    // "Registered, currently zero servers" is a coherent state — a file mid-edit, a compose stack
    // with everything commented out. It needs no error because every request is dropped regardless.
    const file = await configFile(JSON.stringify({ mcpServers: {} }));
    const registry = loadMcpRegistry({ [MCP_CONFIG_ENV_VAR]: file });

    expect(registry?.serverNames.size).toBe(0);
  });
});

describe('mcpServerOf', () => {
  it('extracts the server from an mcp__server__tool name', () => {
    expect(mcpServerOf('mcp__investing__tax_summary')).toBe('investing');
  });

  it('splits on the FIRST separator, so a tool name containing __ is attributed correctly', () => {
    // WHAT THIS PREVENTS: the allowlist checking the wrong string. Splitting from the right would
    // read the server here as "investing__tax", which is not registered — so a legitimate tool
    // would be dropped, and by the same error a tool from an unregistered server could be
    // attributed to a registered one.
    expect(mcpServerOf('mcp__investing__tax__summary')).toBe('investing');
  });

  it('returns undefined for anything that is not an MCP tool name', () => {
    for (const name of ['Read', 'Bash', 'mcp__', 'mcp__only', 'mcp____tool', 'not__mcp__x']) {
      expect(mcpServerOf(name), name).toBeUndefined();
    }
  });
});
