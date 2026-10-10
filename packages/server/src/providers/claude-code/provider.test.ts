import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-office/shared';
import { ProviderUnavailableError } from '../types.js';
import { spawnClaude } from './childProcess.js';
import { ClaudeCodeProvider, buildArgs, describeModelOverride, shellIsAllowed } from './provider.js';
import { resolveClaudeCodeTools } from './tools.js';

/**
 * Adapter-level tests.
 *
 * The CLI on this machine is not authenticated, so a live end-to-end run is
 * impossible (see SETUP.md). Rather than leave the busiest file in Phase 1
 * uncovered, these drive the real streaming loop — real child process, real
 * stdout chunking, real parser, real abort — against `node` replaying the
 * captured fixture bytes. Everything except the model call is genuine.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/**
 * A stand-in CLI: writes the given bytes to stdout, then exits.
 *
 * `slice` makes it emit in deliberately awkward pieces, so the adapter's
 * splitter is exercised across chunk boundaries rather than handed whole lines.
 */
function replaySpawn(text: string, exitCode = 0, chunkSize = 7): typeof spawnClaude {
  const script = `
    const text = Buffer.from(process.env.REPLAY_B64, 'base64').toString('utf8');
    const size = Number(process.env.REPLAY_CHUNK);
    let i = 0;
    (function write() {
      if (i >= text.length) { process.exit(Number(process.env.REPLAY_EXIT)); return; }
      process.stdout.write(text.slice(i, i + size));
      i += size;
      setImmediate(write);
    })();
  `;

  return () =>
    spawnClaude({
      binary: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      stdin: '',
      env: {
        ...process.env,
        REPLAY_B64: Buffer.from(text, 'utf8').toString('base64'),
        REPLAY_CHUNK: String(chunkSize),
        REPLAY_EXIT: String(exitCode),
      },
    });
}

function makeRequest(overrides: Partial<Parameters<ClaudeCodeProvider['run']>[0]> = {}) {
  return {
    assignmentId: 'a1',
    systemPrompt: '# code-reviewer\n\nYou review code.',
    task: 'Review the auth module.',
    allowedTools: ['Read', 'Grep', 'Write'],
    workspaceDir: process.cwd(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function providerWith(spawn: typeof spawnClaude, diagnostics: string[] = []): ClaudeCodeProvider {
  return new ClaudeCodeProvider({
    onDiagnostic: (m) => diagnostics.push(m),
    deps: {
      spawn,
      checkAvailability: async () => ({ ok: true }),
      resolveBinary: async () => ({ path: process.execPath }),
    },
  });
}

async function collect(provider: ClaudeCodeProvider, request = makeRequest()): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of provider.run(request)) events.push(event);
  return events;
}

describe('ClaudeCodeProvider — streaming', () => {
  it('turns a successful session into text, tool and usage events', async () => {
    const events = await collect(providerWith(replaySpawn(fixture('synthetic-success.jsonl'))));

    const text = events.filter((e) => e.t === 'text');
    const tools = events.filter((e) => e.t === 'tool');
    const usage = events.filter((e) => e.t === 'usage');

    expect(text.length).toBeGreaterThan(0);
    expect(tools.map((e) => (e.t === 'tool' ? e.name : ''))).toContain('Read');
    expect(usage.length).toBeGreaterThan(0);
    expect(events.every((e) => e.assignmentId === 'a1')).toBe(true);
    expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
  });

  it('reports the real captured auth failure as fatal, without leaking it as agent text', async () => {
    // The CLI dresses this error as an assistant turn. If the adapter passed it
    // through as text, "Not logged in" would be written into the agent's report
    // as though it were the agent's work.
    const events = await collect(providerWith(replaySpawn(fixture('auth-failure.jsonl'), 1)));

    expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(true);
    const leaked = events.some((e) => e.t === 'text' && e.chunk.includes('Not logged in'));
    expect(leaked).toBe(false);
  });

  it('survives malformed output and still yields the events around it', async () => {
    const diagnostics: string[] = [];
    const events = await collect(providerWith(replaySpawn(fixture('malformed.jsonl'), 1), diagnostics));

    expect(events.some((e) => e.t === 'text' && e.chunk.includes('partial work survives'))).toBe(true);
    expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(true);
    // Garbage must be visible somewhere rather than silently swallowed.
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('does not double-report when the stream already explained the failure', async () => {
    // Exit code 1 AND an in-band fatal result frame. Emitting both would show
    // the user two failures for one cause.
    const events = await collect(providerWith(replaySpawn(fixture('auth-failure.jsonl'), 1)));
    expect(events.filter((e) => e.t === 'error' && e.fatal)).toHaveLength(1);
  });

  it('reports a non-zero exit that the stream did not explain', async () => {
    const events = await collect(providerWith(replaySpawn('', 42)));
    const fatal = events.filter((e) => e.t === 'error' && e.fatal);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.t === 'error' && fatal[0].message).toContain('42');
  });
});

describe('ClaudeCodeProvider — degradation and cancellation', () => {
  it('warns non-fatally about tools it could not grant (NFR-8)', async () => {
    const events = await collect(
      providerWith(replaySpawn(fixture('synthetic-success.jsonl'))),
      makeRequest({ allowedTools: ['Read', 'mcp__bgpt__search_papers', 'subagent-catalog:search'] }),
    );

    const warnings = events.filter((e) => e.t === 'error' && !e.fatal);
    expect(warnings.length).toBe(2);
    // A tool the adapter cannot grant must never fail the assignment.
    expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
  });

  it('stops on abort without reporting a spurious failure (FR-M9)', async () => {
    const controller = new AbortController();
    // A process that would never end on its own.
    const neverEnds: typeof spawnClaude = () =>
      spawnClaude({
        binary: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        stdin: '',
      });

    const provider = providerWith(neverEnds);
    const events: AgentEvent[] = [];

    setTimeout(() => controller.abort(), 150);
    for await (const event of provider.run(makeRequest({ signal: controller.signal }))) {
      events.push(event);
    }

    // Cancellation is the orchestrator's own doing; surfacing it as a provider
    // error would misreport a deliberate cancel as a failure in the run log.
    expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
  });

  it('throws ProviderUnavailableError rather than starting when preflight fails', async () => {
    const provider = new ClaudeCodeProvider({
      deps: {
        checkAvailability: async () => ({ ok: false, reason: 'not authenticated' }),
        spawn: () => {
          throw new Error('must not spawn');
        },
      },
    });

    await expect(collect(provider)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('run() — reporting a run-wide model override (defect 4)', () => {
  function providerWithModel(model: string, spawn: typeof spawnClaude): ClaudeCodeProvider {
    return new ClaudeCodeProvider({
      model,
      deps: {
        spawn,
        checkAvailability: async () => ({ ok: true }),
        resolveBinary: async () => ({ path: process.execPath }),
      },
    });
  }

  it('yields exactly one non-fatal error event when a run-wide model overrides the agent\'s catalog model, and the run still completes normally', async () => {
    const provider = providerWithModel('claude-opus-5', replaySpawn(fixture('synthetic-success.jsonl')));
    const events = await collect(provider, makeRequest({ model: 'sonnet' }));

    const warnings = events.filter((e) => e.t === 'error' && !e.fatal);
    expect(warnings).toHaveLength(1);
    const message = warnings[0]?.t === 'error' ? warnings[0].message : '';
    expect(message).toContain('sonnet');
    expect(message).toContain('claude-opus-5');

    expect(events.some((e) => e.t === 'text')).toBe(true);
    expect(events.some((e) => e.t === 'error' && e.fatal)).toBe(false);
  });

  it('reports nothing when the agent catalog model is "inherit", which is not a substitution', async () => {
    const provider = providerWithModel('claude-opus-5', replaySpawn(fixture('synthetic-success.jsonl')));
    const events = await collect(provider, makeRequest({ model: 'inherit' }));
    expect(events.some((e) => e.t === 'error' && !e.fatal)).toBe(false);
  });

  it('reports nothing when no run-wide model was set, even though the agent has its own catalog model', async () => {
    const events = await collect(
      providerWith(replaySpawn(fixture('synthetic-success.jsonl'))),
      makeRequest({ model: 'sonnet' }),
    );
    expect(events.some((e) => e.t === 'error' && !e.fatal)).toBe(false);
  });
});

describe('describeModelOverride', () => {
  it('reports a substitution only when both a run-wide model and a non-inherit agent model are present', () => {
    expect(describeModelOverride({ model: 'claude-opus-5' }, 'sonnet')).toContain('sonnet');
    expect(describeModelOverride({ model: 'claude-opus-5' }, 'sonnet')).toContain('claude-opus-5');
    expect(describeModelOverride({ model: 'claude-opus-5' }, 'inherit')).toBeUndefined();
    expect(describeModelOverride({ model: 'claude-opus-5' }, undefined)).toBeUndefined();
    expect(describeModelOverride({}, 'sonnet')).toBeUndefined();
  });
});

// FR-T4 (Must), CLI half: "The MCP allowlist is a permission boundary,
// enforced at execution, and identical across provider families." This suite
// proves the CLI-provider half of that agreement — the tool ends up in
// `--allowedTools` (the CLI's own execution-time permission gate) rather than
// merely in `--tools` (availability only), and `--mcp-config` is never passed
// without `--strict-mcp-config`, so the registry in `mcpConfig.ts` is what
// decides which servers exist for this run rather than being decorative next
// to the operator's ambient config. `mcpTools.test.ts`'s
// "refuses to EXECUTE a tool outside allowedTools" suite proves the matching
// half for the raw-API providers, whose enforcement point is `execute()`
// rather than a CLI flag — same boundary, same requirement, two mechanisms
// because the two provider families are shaped differently underneath.
describe('buildArgs — MCP (Stage 2, FR-T4)', () => {
  const withMcp = resolveClaudeCodeTools(['Read', 'mcp__investing__tax_summary'], {
    platform: 'win32',
    mcpServers: new Set(['investing']),
  });

  it('puts MCP tools in --allowedTools and never in --tools', () => {
    // WHAT THIS PREVENTS: a CLI-side failure far from its cause. `--tools` is documented as
    // selecting "from the built-in set" (verified against 2.1.222's --help), so an `mcp__*` name
    // there is wrong rather than merely redundant. Availability comes from --mcp-config;
    // permission comes from --allowedTools.
    const args = buildArgs({
      systemPromptPath: 'sp.md',
      tools: withMcp,
      options: {},
      mcpConfigPath: 'C:/toolset/mcp.json',
    });

    const toolsValue = args[args.indexOf('--tools') + 1] ?? '';
    const allowedValue = args[args.indexOf('--allowedTools') + 1] ?? '';

    expect(toolsValue).toContain('Read');
    expect(toolsValue).not.toContain('mcp__');
    expect(allowedValue).toContain('mcp__investing__tax_summary');
    expect(allowedValue).toContain('Read');
  });

  it('always pairs --mcp-config with --strict-mcp-config', () => {
    // WHAT THIS PREVENTS: the registry becoming decorative. Without --strict-mcp-config the CLI
    // ALSO loads the ambient configuration — the operator's own ~/.claude.json and any project
    // .mcp.json — so a delegated agent would silently inherit every server the human happens to
    // have enabled, including ones with write or order-placement capability. The allowlist would
    // then govern only what an agent may *ask* for while the CLI quietly supplied the rest.
    const args = buildArgs({
      systemPromptPath: 'sp.md',
      tools: withMcp,
      options: {},
      mcpConfigPath: 'C:/toolset/mcp.json',
    });

    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('C:/toolset/mcp.json');
    expect(args).toContain('--strict-mcp-config');
  });

  it('adds no MCP flags at all when the deployment has not enabled MCP', () => {
    // The common path. A deployment that never registered a server must produce byte-for-byte the
    // argv it produced before MCP support existed.
    const args = buildArgs({
      systemPromptPath: 'sp.md',
      tools: resolveClaudeCodeTools(['Read'], { platform: 'win32' }),
      options: {},
    });

    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });
});

describe('buildArgs', () => {
  const tools = resolveClaudeCodeTools(['Read', 'Write'], { platform: 'win32' });

  it('always passes --verbose, which the CLI requires with stream-json', () => {
    const args = buildArgs({ systemPromptPath: 'sp.md', tools, options: {} });
    expect(args).toContain('--verbose');
    expect(args).toContain('--print');
    expect(args.join(' ')).toContain('--output-format stream-json');
  });

  it('appends the system prompt by default and replaces only when asked', () => {
    expect(buildArgs({ systemPromptPath: 'sp.md', tools, options: {} })).toContain(
      '--append-system-prompt-file',
    );
    expect(
      buildArgs({ systemPromptPath: 'sp.md', tools, options: { systemPromptMode: 'replace' } }),
    ).toContain('--system-prompt-file');
  });

  it('passes tools as a single argv token, so the variadic flag cannot swallow anything', () => {
    const args = buildArgs({ systemPromptPath: 'sp.md', tools, options: {} });
    const value = args[args.indexOf('--tools') + 1] ?? '';
    expect(value).not.toContain(' ');
    expect(value.split(',').length).toBeGreaterThan(1);
  });

  it('passes --tools even when nothing was grantable, because omitting it means "all"', () => {
    const none = resolveClaudeCodeTools(['mcp__nope__thing'], { platform: 'win32' });
    const args = buildArgs({ systemPromptPath: 'sp.md', tools: none, options: {} });
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    // No allowlist to grant, so the permission flag is omitted entirely.
    expect(args).not.toContain('--allowedTools');
  });

  it('omits --model for the catalog\'s "inherit", which is not a model alias', () => {
    expect(buildArgs({ systemPromptPath: 'sp.md', tools, options: { model: 'inherit' } })).not.toContain(
      '--model',
    );
    expect(buildArgs({ systemPromptPath: 'sp.md', tools, options: { model: 'sonnet' } })).toContain(
      '--model',
    );
  });

  it('a catalog model reaches --model when there is no run-wide override', () => {
    const args = buildArgs({ systemPromptPath: 'sp.md', tools, options: {}, requestModel: 'sonnet' });
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('the catalog\'s "inherit" never reaches --model either, even with no run-wide override at all', () => {
    const args = buildArgs({ systemPromptPath: 'sp.md', tools, options: {}, requestModel: 'inherit' });
    expect(args).not.toContain('--model');
  });

  it('a run-wide model wins over the agent\'s own catalog model when both are set', () => {
    const args = buildArgs({
      systemPromptPath: 'sp.md',
      tools,
      options: { model: 'opus' },
      requestModel: 'sonnet',
    });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  it('passes the spend cap when set (FR-M8)', () => {
    const args = buildArgs({ systemPromptPath: 'sp.md', tools, options: { maxCostUsd: 0.5 } });
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.5');
  });

  it('omits --max-budget-usd entirely when no cap is set', () => {
    const args = buildArgs({ systemPromptPath: 'sp.md', tools, options: {} });
    expect(args).not.toContain('--max-budget-usd');
  });

  describe('refuses a spend cap that cannot mean "protected" (FR-M8)', () => {
    // DEFECT FIXED: this used to forward whatever it was handed straight to
    // `--max-budget-usd` — `String(-5)`, `String(0)`, `String(Infinity)` — so
    // a caller that got a bad value here (accidentally or otherwise) shipped
    // a run that read as budget-capped and was not. `CreateRunRequestSchema`
    // and `scripts/run.ts` both reject these before `buildArgs` is ever
    // reached in the real app, but `buildArgs` is the one place every caller
    // funnels through, so it is the backstop.
    const invalidCaps = [0, -1, -0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const maxCostUsd of invalidCaps) {
      it(`throws for a maxCostUsd of ${String(maxCostUsd)}`, () => {
        expect(() => buildArgs({ systemPromptPath: 'sp.md', tools, options: { maxCostUsd } })).toThrow(
          /positive.*finite/,
        );
      });
    }
  });
});

/**
 * FR-T2 (Must) / AO-1's opt-in half: "The shell is denied by default, and the
 * opt-in is a deployment-level environment variable (AGENT_OFFICE_ALLOW_SHELL)
 * — never a run option." `tools.test.ts`'s
 * "resolveClaudeCodeTools: the shell ... (FR-T2, AO-1)" suite proves the
 * "denied by default" half by driving `resolveClaudeCodeTools` with an
 * explicit `allowShell` boolean, but nothing in this codebase previously
 * exercised `shellIsAllowed` itself — the one function that turns
 * `process.env.AGENT_OFFICE_ALLOW_SHELL` into that boolean, and therefore the
 * only place FR-T2's "never a run option" constraint is actually enforced:
 * there is no other path in this codebase from a request body to `allowShell`.
 * Written straight from `shellIsAllowed`'s own implementation
 * (`raw === '1' || raw?.toLowerCase() === 'true'`) rather than from what a
 * reader might assume a "truthy env var" check does.
 */
describe('shellIsAllowed (FR-T2, AO-1)', () => {
  // `shellIsAllowed` intentionally reads `process.env` directly rather than
  // taking an injectable env object (see its own doc comment: "a test ... sees
  // the current value rather than whatever was set when the module first
  // happened to be imported"), so these tests manipulate the real
  // `process.env` and restore it afterwards rather than mocking anything.
  const VAR = 'AGENT_OFFICE_ALLOW_SHELL';
  const original = process.env[VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  });

  it('denies the shell when the variable is unset — the deploy-time default', () => {
    delete process.env[VAR];
    expect(shellIsAllowed()).toBe(false);
  });

  it('denies the shell when the variable is set but empty', () => {
    process.env[VAR] = '';
    expect(shellIsAllowed()).toBe(false);
  });

  it('grants the shell for the documented truthy value "1"', () => {
    process.env[VAR] = '1';
    expect(shellIsAllowed()).toBe(true);
  });

  it('grants the shell for "true", case-insensitively', () => {
    process.env[VAR] = 'true';
    expect(shellIsAllowed()).toBe(true);
    process.env[VAR] = 'TRUE';
    expect(shellIsAllowed()).toBe(true);
    process.env[VAR] = 'True';
    expect(shellIsAllowed()).toBe(true);
  });

  it('denies the shell for an arbitrary or near-miss value, rather than treating any non-empty string as truthy', () => {
    // Prevents the highest-risk regression for a deploy-only switch: if this
    // ever loosened to "any non-empty value grants it", an operator setting
    // AGENT_OFFICE_ALLOW_SHELL=false (a reasonable, if wrong, guess at how to
    // spell "off") would actually turn the shell ON.
    for (const value of ['0', 'false', 'FALSE', 'yes', 'on', 'enabled', ' 1', '1 ', 'not-a-boolean']) {
      process.env[VAR] = value;
      expect(shellIsAllowed(), `expected "${value}" to deny the shell`).toBe(false);
    }
  });
});
