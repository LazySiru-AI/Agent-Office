import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpTools,
  DEFAULT_CALL_TIMEOUT_MS,
  McpToolsConfigError,
  type McpCallResult,
  type McpConnectionFactory,
  type McpServerConnection,
  type McpToolInfo,
} from './mcpTools.js';

/**
 * `mcpTools.ts` is what lets the raw-API providers (Anthropic, OpenAI, DeepSeek) reach an MCP
 * server, which none of them can do on their own — see that module's header for the full
 * architecture. Every test here uses a FAKE `McpConnectionFactory` (the `deps.connect` seam), never a
 * real spawned subprocess: what is under test is this module's own namespacing, filtering, timeout,
 * capping, error-handling and lifecycle logic, none of which has anything to do with what a real MCP
 * server implementation does. A fake factory exercises exactly that logic, deterministically and fast,
 * which a real subprocess round trip cannot offer (its timing is not under this suite's control, and
 * shipping a throwaway MCP server binary just to test "does a long call get cut off" would be testing
 * the wrong thing).
 *
 * Config-file parsing (`readServerConfigs`) IS exercised against a real file on disk, the same way
 * `apiTools.test.ts` uses real temporary directories rather than a mocked `fs` — a config-shape bug is
 * exactly the kind of thing a mock would paper over.
 */

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function newWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-mcptools-'));
  created.push(dir);
  return dir;
}

/** Write `{ "mcpServers": servers }` to a fresh file in a fresh temp dir and return its path. */
function writeConfig(servers: Record<string, unknown>): string {
  const dir = newWorkspace();
  const configPath = path.join(dir, 'mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }), 'utf8');
  return configPath;
}

/** A connection whose `tools`, `callTool` and `close` behaviour is fully controlled by the test. */
function fakeConnection(
  tools: McpToolInfo[],
  overrides?: {
    callTool?: McpServerConnection['callTool'];
  },
): McpServerConnection {
  return {
    tools,
    callTool:
      overrides?.callTool ??
      vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
    close: vi.fn(async () => {}),
  };
}

/** An `McpConnectionFactory` that resolves immediately (or rejects) per server name, from a fixed map. */
function fixedConnect(byServer: Record<string, McpServerConnection | Error>): McpConnectionFactory {
  return async (serverName) => {
    const outcome = byServer[serverName];
    if (outcome === undefined) throw new Error(`fixedConnect: no fixture for server "${serverName}"`);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

// ---------------------------------------------------------------------------
// MCP disabled
// ---------------------------------------------------------------------------

describe('createMcpTools with configPath undefined', () => {
  it('produces an empty, harmless handle rather than treating "MCP disabled" as an error', async () => {
    // This is the case every non-MCP deployment hits on every run. If this path threw, or if
    // schemas()/execute() behaved as though something were misconfigured, every provider using this
    // module would need an `if (mcpConfigured)` guard around every call site just to stay silent when
    // MCP was never turned on — exactly what the module doc promises this handle avoids.
    const tools = await createMcpTools(undefined);
    expect(tools.schemas(['mcp__investing__tax_summary'])).toEqual([]);
    expect(tools.serverDiagnostics.size).toBe(0);

    const result = await tools.execute('mcp__investing__tax_summary', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not available');

    // Must not throw and must not hang even though nothing was ever spawned.
    await expect(tools.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Namespacing
// ---------------------------------------------------------------------------

describe('namespacing', () => {
  it('exposes a server tool as mcp__<server>__<tool>, matching the CLI convention', async () => {
    const connection = fakeConnection([{ name: 'tax_summary', description: 'Summarise tax.', inputSchema: { type: 'object' } }]);
    const configPath = writeConfig({ investing: { command: 'python' } });

    const tools = await createMcpTools(configPath, {
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    const schemas = tools.schemas(['mcp__investing__tax_summary']);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe('mcp__investing__tax_summary');
    expect(schemas[0]?.description).toBe('Summarise tax.');

    await tools.close();
  });

  it('routes execute() for the namespaced name back to the bare tool name on the right server', async () => {
    const callTool = vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'summary' }], isError: false }));
    const connection = fakeConnection([{ name: 'tax_summary', inputSchema: { type: 'object' } }], { callTool });
    const configPath = writeConfig({ investing: { command: 'python' } });

    const tools = await createMcpTools(configPath, {
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    const result = await tools.execute('mcp__investing__tax_summary', { year: 2025 });
    expect(result).toEqual({ content: 'summary', isError: false });
    // The connection only ever sees the BARE tool name — the namespace is this module's concern, not
    // the connection layer's, and a server implementation should never see its own name echoed back.
    expect(callTool).toHaveBeenCalledWith('tax_summary', { year: 2025 }, DEFAULT_CALL_TIMEOUT_MS);

    await tools.close();
  });

  it('rejects a tool name that is not mcp__<server>__<tool> shaped, without throwing', async () => {
    const tools = await createMcpTools(writeConfig({}));
    const result = await tools.execute('Read', { path: 'foo.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not an MCP tool name');
    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// Second root: the subject (S8) — see mcpTools.ts's module doc "Second root"
// section for the design. `mcp__subject__read` and `mcp__subject__ls` are
// in-process, read-only tools this module defines itself; there is no
// subprocess involved, so these tests use real temp directories directly
// rather than a fake `McpConnectionFactory`.
// ---------------------------------------------------------------------------

describe('second root: subject', () => {
  it('reads a file from the subject root even with MCP otherwise fully disabled (no configPath)', async () => {
    const subject = newWorkspace();
    fs.writeFileSync(path.join(subject, 'notes.md'), 'subject material');

    const tools = await createMcpTools(undefined, { subjectDir: subject });
    const result = await tools.execute('mcp__subject__read', { path: 'notes.md' });
    expect(result).toEqual({ content: 'subject material', isError: false });
    await tools.close();
  });

  it('reads a file from the subject root alongside a real configured server', async () => {
    const subject = newWorkspace();
    fs.writeFileSync(path.join(subject, 'notes.md'), 'subject material');
    const connection = fakeConnection([{ name: 'tax_summary', inputSchema: { type: 'object' } }]);
    const configPath = writeConfig({ investing: { command: 'python' } });

    const tools = await createMcpTools(configPath, {
      subjectDir: subject,
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    const schemas = tools.schemas(['mcp__subject__read', 'mcp__investing__tax_summary']);
    expect(schemas.map((s) => s.name).sort()).toEqual(['mcp__investing__tax_summary', 'mcp__subject__read']);

    const result = await tools.execute('mcp__subject__read', { path: 'notes.md' });
    expect(result).toEqual({ content: 'subject material', isError: false });

    await tools.close();
  });

  it('lists a directory under the subject root, including its top level', async () => {
    const subject = newWorkspace();
    fs.mkdirSync(path.join(subject, 'src'));
    fs.writeFileSync(path.join(subject, 'README.md'), 'x');
    fs.writeFileSync(path.join(subject, 'src', 'index.ts'), 'x');

    const tools = await createMcpTools(undefined, { subjectDir: subject });

    const top = await tools.execute('mcp__subject__ls', {});
    expect(top.isError).toBe(false);
    expect(top.content).toContain('README.md');
    expect(top.content).toContain('src/');

    const nested = await tools.execute('mcp__subject__ls', { path: 'src' });
    expect(nested.isError).toBe(false);
    expect(nested.content).toContain('index.ts');

    await tools.close();
  });

  it('refuses a path that escapes the subject root with "..", via the shared resolveWithin containment check', async () => {
    const subjectParent = newWorkspace();
    const subject = path.join(subjectParent, 'subject-dir');
    fs.mkdirSync(subject);
    fs.writeFileSync(path.join(subjectParent, 'secret-outside-subject.txt'), 'nope');

    const tools = await createMcpTools(undefined, { subjectDir: subject });
    const result = await tools.execute('mcp__subject__read', { path: '../secret-outside-subject.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/refusing path/i);

    await tools.close();
  });

  it('never advertises or executes a write tool for the subject root — no such tool is defined, structurally', async () => {
    const subject = newWorkspace();
    const tools = await createMcpTools(undefined, { subjectDir: subject });

    // Asking for a write-shaped subject tool advertises nothing...
    expect(tools.schemas(['mcp__subject__write', 'mcp__subject__edit'])).toEqual([]);
    // ...and calling one directly fails cleanly rather than writing anything.
    const result = await tools.execute('mcp__subject__write', { path: 'x.txt', content: 'nope' });
    expect(result.isError).toBe(true);
    await expect(fsp.access(path.join(subject, 'x.txt'))).rejects.toThrow();

    await tools.close();
  });

  it('reserves the "subject" server name in the operator\'s own config when a subject root is configured', async () => {
    const subject = newWorkspace();
    fs.writeFileSync(path.join(subject, 'notes.md'), 'subject material');
    // An operator's config that happens to ALSO define a server literally named "subject".
    const connection = fakeConnection([{ name: 'read', inputSchema: { type: 'object' } }]);
    const configPath = writeConfig({ subject: { command: 'python' } });

    const tools = await createMcpTools(configPath, {
      subjectDir: subject,
      deps: { connect: fixedConnect({ subject: connection }) },
    });

    // The reservation is recorded as a diagnostic...
    expect(tools.serverDiagnostics.get('subject')).toMatch(/reserved/i);
    // ...and mcp__subject__read is this run's own built-in, not the operator's server's "read" tool.
    const result = await tools.execute('mcp__subject__read', { path: 'notes.md' });
    expect(result).toEqual({ content: 'subject material', isError: false });

    await tools.close();
  });

  it('with no subject root configured, an operator\'s own "subject"-named server behaves exactly as it always did', async () => {
    const connection = fakeConnection([{ name: 'read', inputSchema: { type: 'object' } }]);
    const configPath = writeConfig({ subject: { command: 'python' } });

    const tools = await createMcpTools(configPath, {
      deps: { connect: fixedConnect({ subject: connection }) },
    });

    expect(tools.serverDiagnostics.size).toBe(0);
    const schemas = tools.schemas(['mcp__subject__read']);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe('mcp__subject__read');

    const result = await tools.execute('mcp__subject__read', {});
    expect(result).toEqual({ content: 'ok', isError: false }); // the fakeConnection's default callTool response

    await tools.close();
  });

  it('respects the allowedTools boundary for the subject-root tools, same as for a real server', async () => {
    const subject = newWorkspace();
    fs.writeFileSync(path.join(subject, 'notes.md'), 'x');

    const tools = await createMcpTools(undefined, {
      subjectDir: subject,
      allowedTools: ['mcp__subject__read'], // ls is NOT granted
    });

    expect(tools.schemas(['mcp__subject__read', 'mcp__subject__ls']).map((s) => s.name)).toEqual([
      'mcp__subject__read',
    ]);

    const denied = await tools.execute('mcp__subject__ls', {});
    expect(denied.isError).toBe(true);
    expect(denied.content).toMatch(/not available to this assignment/i);

    const allowed = await tools.execute('mcp__subject__read', { path: 'notes.md' });
    expect(allowed.isError).toBe(false);

    await tools.close();
  });

  it('with no subjectDir option at all, behaviour is byte-for-byte what it always was', async () => {
    // No configPath and no subjectDir: the exact pre-S8 "MCP disabled" handle.
    const disabled = await createMcpTools(undefined);
    expect(disabled.schemas(['mcp__subject__read'])).toEqual([]);
    const disabledResult = await disabled.execute('mcp__subject__read', {});
    expect(disabledResult.isError).toBe(true);
    expect(disabledResult.content).toContain('not available');
    await disabled.close();

    // A real config, no subjectDir: mcp__subject__* is simply not an mcp__ name any real server
    // declares, so it behaves like any other unrecognised tool.
    const connection = fakeConnection([{ name: 'tax_summary', inputSchema: { type: 'object' } }]);
    const configPath = writeConfig({ investing: { command: 'python' } });
    const tools = await createMcpTools(configPath, { deps: { connect: fixedConnect({ investing: connection }) } });
    expect(tools.schemas(['mcp__subject__read'])).toEqual([]);
    const result = await tools.execute('mcp__subject__read', {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not registered/i);
    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// allowedTools filtering
// ---------------------------------------------------------------------------

describe('schemas(allowedTools) filtering', () => {
  it('only returns tools that were actually requested, even when the server offers more', async () => {
    // If an MCP server exposes ten tools and the agent's frontmatter names one, the model must see
    // one — offering the other nine is both a token cost (NFR-5) and an invitation to call something
    // nobody authorised for this run (FR-M5), exactly the reasoning apiTools.ts's createSandboxedTools
    // documents for its own allowlist.
    const connection = fakeConnection([
      { name: 'tax_summary', inputSchema: { type: 'object' } },
      { name: 'decision_table', inputSchema: { type: 'object' } },
      { name: 'macro_forecast', inputSchema: { type: 'object' } },
    ]);
    const tools = await createMcpTools(writeConfig({ investing: { command: 'python' } }), {
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    const schemas = tools.schemas(['mcp__investing__tax_summary']);
    expect(schemas.map((s) => s.name)).toEqual(['mcp__investing__tax_summary']);

    await tools.close();
  });

  it('silently omits a requested tool the server does not actually report', async () => {
    const connection = fakeConnection([{ name: 'tax_summary', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ investing: { command: 'python' } }), {
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    // Asked for a tool that does not exist on this server — schemas() just does not offer it; a
    // model that tries to call it anyway gets a specific reason from execute() instead (see below).
    expect(tools.schemas(['mcp__investing__nonexistent_tool'])).toEqual([]);

    await tools.close();
  });

  it('FR-T4: refuses to EXECUTE a tool outside allowedTools, even though the server reports it', async () => {
    // FR-T4 (Must): "The MCP allowlist is a permission boundary, enforced at
    // execution, and identical across provider families." This is the
    // raw-API half of that proof — enforcement lives in `execute()` itself,
    // not merely in what `schemas()` chooses to advertise, which is what
    // makes it a boundary an assignment cannot route around by naming a tool
    // it was never offered. `provider.test.ts`'s
    // "buildArgs — MCP (Stage 2, FR-T4)" suite proves the matching CLI half
    // (`--allowedTools`/`--strict-mcp-config`); the two together are what
    // "identical across provider families" means for this requirement.
    //
    // THE REGRESSION THIS GUARDS. `schemas()` filtering was, on its own, mistaken for a permission
    // boundary: execute() checked only that the server was connected and reported the tool — a
    // question about the SERVER's capabilities, not about what this assignment was granted. So a
    // model emitting a name it was never offered (a stale turn, a hallucination, a name it read in a
    // brief) reached every tool on every configured server. That is exactly the hole
    // `createSandboxedTools` documents taking its allowlist as a constructor argument to close, and
    // the `claude-code` adapter closes with `--allowedTools`; without this the API providers were
    // strictly more permissive than the CLI provider reading the identical MCP config.
    const callTool = vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'ran' }] }));
    const connection = fakeConnection(
      [
        { name: 'tax_summary', inputSchema: { type: 'object' } },
        { name: 'delete_everything', inputSchema: { type: 'object' } },
      ],
      { callTool },
    );
    const tools = await createMcpTools(writeConfig({ investing: { command: 'python' } }), {
      allowedTools: ['mcp__investing__tax_summary'],
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    // Not advertised even when explicitly asked about...
    expect(tools.schemas(['mcp__investing__delete_everything'])).toEqual([]);

    // ...and, the part that actually matters, not RUN when called anyway.
    const result = await tools.execute('mcp__investing__delete_everything', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not available to this assignment');
    expect(callTool).not.toHaveBeenCalled();

    // The granted tool still works — this is a boundary, not a blanket refusal.
    const allowed = await tools.execute('mcp__investing__tax_summary', {});
    expect(allowed).toEqual({ content: 'ran', isError: false });

    await tools.close();
  });

  it('refuses a disallowed tool without disclosing whether its server exists or why it failed', async () => {
    // Ordering, not wording: the allowlist check runs before the registered/diagnostic lookups, so a
    // refusal for a tool this assignment never had cannot be used to map which servers this
    // deployment configured or which of them are broken.
    const tools = await createMcpTools(
      writeConfig({ good: { command: 'python' }, broken: { command: 'python' } }),
      {
        allowedTools: ['mcp__good__t'],
        deps: {
          connect: fixedConnect({
            good: fakeConnection([{ name: 't', inputSchema: { type: 'object' } }]),
            broken: new Error('spawn ENOENT'),
          }),
        },
      },
    );

    const unregistered = await tools.execute('mcp__nosuchserver__t', {});
    const failed = await tools.execute('mcp__broken__t', {});

    for (const result of [unregistered, failed]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not available to this assignment');
    }
    // The distinction between "never configured" and "configured but failed to spawn" is still
    // available for a tool the assignment WAS granted — it is genuinely useful there.
    expect(failed.content).not.toContain('ENOENT');

    await tools.close();
  });

  it('treats an omitted allowedTools as unconstrained, matching createSandboxedTools', async () => {
    // Every caller in the repo passes one; the default has to mean something coherent regardless,
    // and "unconstrained" is what `createSandboxedTools`'s optional parameter already means. Two
    // layers composed by `composeTools.ts` disagreeing on that would be worse than either choice.
    const connection = fakeConnection([{ name: 'tax_summary', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ investing: { command: 'python' } }), {
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    expect(tools.schemas(['mcp__investing__tax_summary'])).toHaveLength(1);
    expect((await tools.execute('mcp__investing__tax_summary', {})).isError).toBe(false);

    await tools.close();
  });

  it('deduplicates a repeated name in the requested list', async () => {
    const connection = fakeConnection([{ name: 'tax_summary', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ investing: { command: 'python' } }), {
      deps: { connect: fixedConnect({ investing: connection }) },
    });

    const schemas = tools.schemas(['mcp__investing__tax_summary', 'mcp__investing__tax_summary']);
    expect(schemas).toHaveLength(1);

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('call timeout', () => {
  it('degrades one call rather than hanging the assignment when a server never answers', async () => {
    // A server that accepted the call and then never responds is exactly the failure mode this
    // timeout exists for: without it, this `await` — and every await downstream of it in a
    // provider's tool loop — would never resolve, which is indistinguishable from the whole
    // assignment being wedged.
    const hangingCallTool = vi.fn(() => new Promise<McpCallResult>(() => {})); // never settles
    const connection = fakeConnection([{ name: 'slow_tool', inputSchema: { type: 'object' } }], {
      callTool: hangingCallTool,
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      callTimeoutMs: 20,
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__slow_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('mcp__svc__slow_tool');
    expect(result.content.toLowerCase()).toMatch(/failed|timed out/);

    await tools.close();
  });

  it('passes callTimeoutMs through to the connection layer so a well-behaved factory can enforce it itself', async () => {
    const callTool = vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'x' }], isError: false }));
    const connection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }], { callTool });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      callTimeoutMs: 12_345,
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    await tools.execute('mcp__svc__t', undefined);
    expect(callTool).toHaveBeenCalledWith('t', undefined, 12_345);

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

describe('result size cap', () => {
  it('truncates an oversized result with a visible note rather than forwarding it whole', async () => {
    const huge = 'x'.repeat(500);
    const connection = fakeConnection([{ name: 'dump', inputSchema: { type: 'object' } }], {
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: huge }], isError: false })),
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      maxResultChars: 100,
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__dump', {});
    expect(result.isError).toBe(false);
    // 100 chars of payload + the truncation ellipsis + the appended note.
    expect(result.content.startsWith('x'.repeat(100))).toBe(true);
    expect(result.content).toContain('truncated at 100 characters');
    expect(result.content.length).toBeLessThan(huge.length);

    await tools.close();
  });

  it('leaves a result under the cap untouched', async () => {
    const connection = fakeConnection([{ name: 'small', inputSchema: { type: 'object' } }], {
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'tiny result' }], isError: false })),
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      maxResultChars: 100,
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__small', {});
    expect(result).toEqual({ content: 'tiny result', isError: false });

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// execute() never throws
// ---------------------------------------------------------------------------

describe('execute() never throws', () => {
  it('turns a synchronous throw from the connection layer into an isError result', async () => {
    const connection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }], {
      callTool: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    await expect(tools.execute('mcp__svc__t', {})).resolves.toMatchObject({ isError: true });

    await tools.close();
  });

  it('turns a rejected promise, including a non-Error rejection, into an isError result', async () => {
    const connection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }], {
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately testing a non-Error rejection
      callTool: vi.fn(() => Promise.reject('a plain string rejection, not an Error')),
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__t', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('a plain string rejection');

    await tools.close();
  });

  it('rejects non-object input without throwing', async () => {
    const connection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__t', 'not an object');
    expect(result.isError).toBe(true);
    expect(result.content).toContain('JSON object');

    await tools.close();
  });

  it('reports an unknown server without throwing', async () => {
    const tools = await createMcpTools(writeConfig({}));
    const result = await tools.execute('mcp__ghost__thing', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ghost');
    await tools.close();
  });

  it('reports an unknown tool on a known server without throwing', async () => {
    const connection = fakeConnection([{ name: 'real_tool', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__fake_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('fake_tool');

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// isError propagation
// ---------------------------------------------------------------------------

describe('isError propagation', () => {
  it('surfaces the MCP result isError flag even though the transport call itself succeeded', async () => {
    // The tool ran, answered, and reported failure through MCP's own protocol (e.g. "no such
    // ticker") — this is a successful round trip carrying a failed RESULT, distinct from a transport
    // failure, and the model needs to see it as an error either way.
    const connection = fakeConnection([{ name: 'lookup', inputSchema: { type: 'object' } }], {
      callTool: vi.fn(
        async (): Promise<McpCallResult> => ({
          content: [{ type: 'text', text: 'no such ticker: ZZZZ' }],
          isError: true,
        }),
      ),
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__lookup', { ticker: 'ZZZZ' });
    expect(result).toEqual({ content: 'no such ticker: ZZZZ', isError: true });

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// close() idempotency and close-during-startup
// ---------------------------------------------------------------------------

describe('close()', () => {
  it('is idempotent: a second call does not close each connection a second time', async () => {
    const connection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    await tools.close();
    await tools.close();

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('makes the handle refuse further calls after closing, without throwing', async () => {
    const connection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    await tools.close();

    expect(tools.schemas(['mcp__svc__t'])).toEqual([]);
    const result = await tools.execute('mcp__svc__t', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('shut down');
  });

  it('does not throw even when a connection close() rejects', async () => {
    const badConnection: McpServerConnection = {
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [], isError: false })),
      close: vi.fn(async () => {
        throw new Error('process already gone');
      }),
    };
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: badConnection }) },
    });

    // If one server's shutdown throwing propagated out of close(), a caller that awaits close() as
    // part of ordinary cleanup would itself start failing for a reason that has nothing to do with
    // its own work.
    await expect(tools.close()).resolves.toBeUndefined();
  });

  it("closes every server even when one server's close() rejects", async () => {
    const badConnection: McpServerConnection = {
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [], isError: false })),
      close: vi.fn(async () => {
        throw new Error('process already gone');
      }),
    };
    const goodConnection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(writeConfig({ bad: { command: 'python' }, good: { command: 'python' } }), {
      deps: { connect: fixedConnect({ bad: badConnection, good: goodConnection }) },
    });

    await tools.close();

    // Promise.allSettled semantics: the throwing server does not stop the loop before it reaches the
    // healthy one.
    expect(goodConnection.close).toHaveBeenCalledTimes(1);
  });

  it('closes a server connection that finishes connecting after the caller already gave up on it (close during startup)', async () => {
    // A server whose handshake takes longer than callTimeoutMs is marked failed and
    // `createMcpTools` returns without waiting further — but the real connection attempt is still
    // running in the background. If that attempt eventually succeeds, the resulting connection must
    // be closed immediately rather than left running, whether or not the caller ever calls
    // `tools.close()` on the handle in the meantime. This is the scenario the module doc's "close()"
    // section calls "close called during startup": the straggler's own lifecycle finishes DURING
    // what is, from this handle's perspective, still its startup window.
    let resolveStraggler!: (connection: McpServerConnection) => void;
    const strugglerConnection = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }]);
    const stragglerPromise = new Promise<McpServerConnection>((resolve) => {
      resolveStraggler = resolve;
    });

    const connect: McpConnectionFactory = async (serverName) => {
      if (serverName === 'slow') return stragglerPromise;
      throw new Error(`unexpected server ${serverName}`);
    };

    const tools = await createMcpTools(writeConfig({ slow: { command: 'python' } }), {
      callTimeoutMs: 15,
      deps: { connect },
    });

    // The handle is already usable, and it has already given up on "slow" — this is the state a
    // provider's tool loop would see for the whole rest of the assignment if the straggler never
    // landed.
    expect(tools.serverDiagnostics.get('slow')).toContain('did not finish connecting');
    expect(tools.schemas(['mcp__slow__t'])).toEqual([]);

    // Now let the slow handshake finally succeed, well after createMcpTools gave up on it.
    resolveStraggler(strugglerConnection);
    await stragglerPromise;
    // Give the internal `.then()` a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(strugglerConnection.close).toHaveBeenCalledTimes(1);

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// One server failing while others work (NFR-8)
// ---------------------------------------------------------------------------

describe('graceful degradation across servers', () => {
  it('keeps a healthy server usable when a sibling server fails to start', async () => {
    const healthy = fakeConnection([{ name: 'tax_summary', inputSchema: { type: 'object' } }], {
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
    });
    const tools = await createMcpTools(
      writeConfig({ broken: { command: 'this-binary-does-not-exist' }, investing: { command: 'python' } }),
      {
        deps: {
          connect: fixedConnect({
            broken: new Error('spawn ENOENT'),
            investing: healthy,
          }),
        },
      },
    );

    expect(tools.serverDiagnostics.get('broken')).toContain('ENOENT');
    expect(tools.serverDiagnostics.has('investing')).toBe(false);

    // The healthy server's tools are still fully usable.
    expect(tools.schemas(['mcp__investing__tax_summary'])).toHaveLength(1);
    const result = await tools.execute('mcp__investing__tax_summary', {});
    expect(result).toEqual({ content: 'ok', isError: false });

    // A model that still tries the broken server gets a clear, specific reason, not a generic one.
    const brokenResult = await tools.execute('mcp__broken__anything', {});
    expect(brokenResult.isError).toBe(true);
    expect(brokenResult.content).toContain('broken');
    expect(brokenResult.content).toContain('ENOENT');

    await tools.close();
  });

  it('degrades a single malformed config entry without failing the whole config file', async () => {
    const healthy = fakeConnection([{ name: 't', inputSchema: { type: 'object' } }]);
    const tools = await createMcpTools(
      writeConfig({
        // missing "command" entirely
        malformed: { args: ['--foo'] },
        good: { command: 'python' },
      }),
      { deps: { connect: fixedConnect({ good: healthy }) } },
    );

    expect(tools.serverDiagnostics.get('malformed')).toContain('command');
    expect(tools.schemas(['mcp__good__t'])).toHaveLength(1);

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// Non-text content handling
// ---------------------------------------------------------------------------

describe('flattening non-text MCP content', () => {
  it('keeps text blocks verbatim and replaces image/audio/binary-resource blocks with a bracketed note', async () => {
    const connection = fakeConnection([{ name: 'render', inputSchema: { type: 'object' } }], {
      callTool: vi.fn(
        async (): Promise<McpCallResult> => ({
          isError: false,
          content: [
            { type: 'text', text: 'Here is the chart:' },
            { type: 'image', data: 'QUJDREVGRw==', mimeType: 'image/png' },
            { type: 'audio', data: 'QUJDREVGRw==', mimeType: 'audio/wav' },
            { type: 'resource', resource: { uri: 'file:///report.pdf', blob: 'AAAA', mimeType: 'application/pdf' } },
            { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'embedded text resource' } },
            { type: 'resource_link', uri: 'file:///raw.csv', name: 'raw.csv' },
          ],
        }),
      ),
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__render', {});
    expect(result.isError).toBe(false);

    // Text content is preserved exactly.
    expect(result.content).toContain('Here is the chart:');
    expect(result.content).toContain('embedded text resource');
    expect(result.content).toContain('raw.csv');

    // Binary payloads are never forwarded — the raw base64 must not appear anywhere in the output.
    expect(result.content).not.toContain('QUJDREVGRw==');
    expect(result.content).not.toContain('AAAA');

    // But their absence is explained, not silent: a reader can tell content existed and why it isn't here.
    expect(result.content).toContain('image');
    expect(result.content).toContain('image/png');
    expect(result.content).toContain('audio');
    expect(result.content).toContain('application/pdf');

    await tools.close();
  });

  it('produces a clear placeholder rather than an empty string when a result has no content at all', async () => {
    const connection = fakeConnection([{ name: 'noop', inputSchema: { type: 'object' } }], {
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [], isError: false })),
    });
    const tools = await createMcpTools(writeConfig({ svc: { command: 'python' } }), {
      deps: { connect: fixedConnect({ svc: connection }) },
    });

    const result = await tools.execute('mcp__svc__noop', {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('no content');

    await tools.close();
  });
});

// ---------------------------------------------------------------------------
// Config-file-level failures (distinct from a single server entry failing)
// ---------------------------------------------------------------------------

describe('malformed config file', () => {
  it('throws McpToolsConfigError for a file that is not valid JSON, rather than degrading to zero servers', async () => {
    const dir = newWorkspace();
    const configPath = path.join(dir, 'mcp-config.json');
    fs.writeFileSync(configPath, '{ not valid json', 'utf8');

    // Mirrors claude-code/mcpConfig.ts's loadMcpRegistry: a broken config FILE is a one-time setup
    // mistake worth failing loudly and once, unlike one bad server entry within an otherwise-good
    // file (covered above), which degrades instead.
    await expect(createMcpTools(configPath)).rejects.toThrow(McpToolsConfigError);
  });

  it('throws McpToolsConfigError when the file has no mcpServers object', async () => {
    const dir = newWorkspace();
    const configPath = path.join(dir, 'mcp-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ notMcpServers: {} }), 'utf8');

    await expect(createMcpTools(configPath)).rejects.toThrow(McpToolsConfigError);
  });

  it('throws McpToolsConfigError when the file does not exist', async () => {
    const dir = newWorkspace();
    await expect(createMcpTools(path.join(dir, 'does-not-exist.json'))).rejects.toThrow(McpToolsConfigError);
  });
});
