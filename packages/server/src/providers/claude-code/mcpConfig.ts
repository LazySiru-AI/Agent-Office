import { readFileSync } from 'node:fs';

/**
 * Which MCP servers this deployment lets delegated agents reach.
 *
 * ## Why this is an environment variable and not a run option
 *
 * An MCP server entry is a `command` plus `args` that gets **executed**. Accepting one over the
 * HTTP API would therefore be an arbitrary-code-execution primitive, not a capability setting —
 * and NFR-6's trust boundary is loopback, which is not a user boundary: any other local account or
 * process can already `POST /api/runs`. The same argument that put `AGENT_OFFICE_ALLOW_SHELL` in
 * the environment rather than in `CreateRunRequest` applies here with more force, because the shell
 * grant at least only unlocks a binary the CLI already ships, while this would let a caller name
 * the binary.
 *
 * So: the operator decides, once, at startup. A request can only ask for tools from servers the
 * operator already registered.
 *
 * ## Why the file is a path rather than inline JSON
 *
 * The CLI's `--mcp-config` takes files, so a path is what it ultimately needs. Passing a path also
 * keeps server definitions — which may carry local absolute paths and, for some servers, secrets in
 * `env` — out of this process's own environment and out of any log line that dumps it.
 *
 * ## The file format
 *
 * Exactly the CLI's own, so one file works for both Claude Code and this adapter and there is no
 * second dialect to keep in sync:
 *
 * ```json
 * { "mcpServers": { "investing": { "command": "python", "args": ["-m", "app.mcp.server"] } } }
 * ```
 */

export const MCP_CONFIG_ENV_VAR = 'AGENT_OFFICE_MCP_CONFIG';

export interface McpRegistry {
  /** Absolute or relative path, passed straight to the CLI's `--mcp-config`. */
  readonly configPath: string;
  /**
   * Server names declared in the file.
   *
   * This is the allowlist `tools.ts` checks an `mcp__<server>__<tool>` request against. Holding the
   * names here rather than re-reading the file per resolution keeps the check a set lookup, and
   * means a config edited mid-run cannot change what an in-flight assignment is allowed to use.
   */
  readonly serverNames: ReadonlySet<string>;
}

/** Thrown for a configured-but-unusable file. Never thrown when the variable is simply unset. */
export class McpConfigError extends Error {}

/**
 * Read the registry, or `undefined` when this deployment has not enabled MCP at all.
 *
 * Unset is the normal case and is silent: MCP is opt-in, and a server that never configured it
 * should not log a warning on every run.
 *
 * A variable that IS set but points at something unusable **throws**, rather than degrading to "no
 * servers". That direction is deliberate. Degrading silently would present as "my agent ignores its
 * tools", sending whoever debugs it into the tool-resolution code — the layer furthest from the
 * actual mistake, which is a typo in a path. Failing at startup names the real problem once.
 */
export function loadMcpRegistry(env: NodeJS.ProcessEnv = process.env): McpRegistry | undefined {
  const configPath = env[MCP_CONFIG_ENV_VAR];
  if (configPath === undefined || configPath.trim() === '') return undefined;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new McpConfigError(
      `${MCP_CONFIG_ENV_VAR} points at "${configPath}", which could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new McpConfigError(
      `${MCP_CONFIG_ENV_VAR} file "${configPath}" is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const servers = extractServers(parsed);
  if (servers === undefined) {
    throw new McpConfigError(
      `${MCP_CONFIG_ENV_VAR} file "${configPath}" has no "mcpServers" object. Expected ` +
        `{ "mcpServers": { "<name>": { "command": ... } } } — the same shape the Claude Code CLI reads.`,
    );
  }

  // An empty object is accepted rather than rejected: "registered, currently zero servers" is a
  // coherent state (a file being edited, a compose stack with everything commented out), and it
  // fails closed anyway — every `mcp__*` request is dropped for an unregistered server.
  return { configPath, serverNames: new Set(Object.keys(servers)) };
}

function extractServers(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return undefined;
  return servers as Record<string, unknown>;
}

/**
 * The `<server>` part of an `mcp__<server>__<tool>` name, or `undefined` if the name is not one.
 *
 * The CLI's convention is a `mcp__` prefix, then the server name, then `__`, then the tool name.
 * Split on the FIRST `__` after the prefix, not the last: tool names may themselves contain `__`
 * (the dashboard's own `tax_summary` does not, but nothing stops a server exporting one), whereas
 * a server name may not. Splitting from the right would attribute such a tool to the wrong server —
 * and, since the server name is what the allowlist checks, would either grant a tool from an
 * unregistered server or drop one from a registered one.
 */
export function mcpServerOf(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return undefined;
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (server === '' || tool === '') return undefined;
  return server;
}
