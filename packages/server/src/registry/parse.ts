import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { AgentDefSchema, type AgentDef } from '@agent-office/shared';

/**
 * Raised for any agent markdown file we cannot turn into a valid AgentDef.
 *
 * FR-R2: an agent is never silently dropped. Every failure carries the file path
 * and, where the position is determinable, a 1-based line number in that file.
 */
export class AgentParseError extends Error {
  readonly filePath: string;
  readonly line: number | undefined;

  constructor(
    message: string,
    filePath: string,
    line?: number,
    options?: { cause?: unknown },
  ) {
    super(line === undefined ? `${filePath}: ${message}` : `${filePath}:${line}: ${message}`);
    // Keeps `instanceof` working even if the compile target is downlevelled.
    Object.setPrototypeOf(this, AgentParseError.prototype);
    this.name = 'AgentParseError';
    this.filePath = filePath;
    this.line = line;
    if (options && options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** A line consisting only of `---` (plus optional trailing blanks). */
const DELIMITER = /^---[ \t]*$/;

/** A top-level `key: value` line inside the frontmatter block. */
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

/** Any line ending: this repo's agent files are CRLF. */
const LINE_ENDING = /\r\n|\n|\r/;

/** Byte-order mark, stripped before anything else looks at the text. */
const BOM = 0xfeff;

/**
 * First characters that mean "this value is quoted, structured, or otherwise
 * explicitly typed". YAML owns those, so the normalisation pass never rewrites
 * a value that starts with one.
 */
const RESERVED_FIRST_CHARS = new Set([
  '"', "'", '|', '>', '&', '*', '!', '[', ']', '{', '}', '#', '%', '@', '`',
]);

/**
 * Parse one agent markdown file into an AgentDef.
 *
 * @param raw       full file contents
 * @param filePath  path to the file (absolute, or relative to `repoRoot`)
 * @param repoRoot  repository root, used to derive the repo-relative path
 */
export function parseAgentFile(raw: string, filePath: string, repoRoot: string): AgentDef {
  const withoutBom = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  const lines = withoutBom.split(LINE_ENDING);

  if (lines.length === 0 || !DELIMITER.test(lines[0] ?? '')) {
    throw new AgentParseError(
      'missing opening frontmatter delimiter (expected a line containing exactly "---" as line 1)',
      filePath,
      1,
    );
  }

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (DELIMITER.test(lines[i] ?? '')) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    throw new AgentParseError(
      'unterminated frontmatter (no closing "---" line found)',
      filePath,
      lines.length,
    );
  }

  // Frontmatter body lines. fmLines[i] is file line number i + 2 (1-based),
  // because line 1 is the opening delimiter.
  const fmLines = lines.slice(1, closeIndex);
  const lineOf = (key: string): number | undefined => {
    const index = fmLines.findIndex((line) => {
      const match = TOP_LEVEL_KEY.exec(line);
      return match !== null && match[1] === key;
    });
    return index === -1 ? undefined : index + 2;
  };

  const frontmatterText = normaliseFrontmatter(fmLines).join('\n');

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterText);
  } catch (error) {
    // `yaml` reports positions relative to the text it was handed; the opening
    // `---` line accounts for the +1 offset back to real file line numbers.
    const relativeLine =
      error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentParseError(
      `failed to parse YAML frontmatter: ${message}`,
      filePath,
      relativeLine === undefined ? undefined : relativeLine + 1,
      { cause: error },
    );
  }

  if (parsed === null || parsed === undefined) {
    throw new AgentParseError('frontmatter block is empty', filePath, 1);
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentParseError(
      `frontmatter must be a mapping of keys to values (found ${describeType(parsed)})`,
      filePath,
      2,
    );
  }

  const fields = parsed as Record<string, unknown>;

  const name = requireNonEmptyString(fields['name'], 'name', filePath, lineOf('name'));
  const description = requireNonEmptyString(
    fields['description'],
    'description',
    filePath,
    lineOf('description'),
  );
  const tools = parseTools(fields['tools'], filePath, lineOf('tools'));
  const model = parseModel(fields['model'], filePath, lineOf('model'));

  const category = path.basename(path.dirname(path.resolve(filePath)));
  if (category === '' || category === '.') {
    throw new AgentParseError(
      'cannot derive a category: the file has no parent directory',
      filePath,
    );
  }

  const relativePath = toRepoRelative(filePath, repoRoot);
  const systemPrompt = lines.slice(closeIndex + 1).join('\n').trim();
  if (systemPrompt === '') {
    // The body IS the agent's system prompt, so an empty one is a broken agent
    // rather than a minor omission. Caught here so the message names the cause
    // instead of surfacing as a generic schema violation.
    throw new AgentParseError(
      'no body below the frontmatter: the markdown body is the agent system prompt',
      filePath,
      closeIndex + 1,
    );
  }

  const candidate: AgentDef = {
    name,
    description,
    tools,
    category,
    filePath: relativePath,
    systemPrompt,
    ...(model === undefined ? {} : { model }),
  };

  // Final guard against the shared contract, so the registry can never hand the
  // orchestrator a shape the rest of the app does not expect.
  const result = AgentDefSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new AgentParseError(`agent definition failed schema validation: ${issues}`, filePath);
  }

  return result.data;
}

/**
 * Narrow pre-pass that makes this repo's frontmatter parseable as real YAML.
 *
 * Several agent files write an *unquoted* description containing a colon
 * followed by a space, for example:
 *
 *     description: Use when ... Triggers on: 'GDPR', 'CCPA', 'consent'.
 *
 * That is not valid YAML. A colon-space sequence terminates a plain scalar, so
 * the line reads as a nested mapping and the parser rejects it with "Nested
 * mappings are not allowed in compact mappings". Rather than hand-rolling a YAML
 * parser, we re-emit only those top-level `key: value` lines whose value is a
 * plain scalar YAML cannot represent verbatim, double-quoting the value. JSON
 * string syntax is a subset of YAML's double-quoted style, so `JSON.stringify`
 * produces correct escaping.
 *
 * Everything else -- quoted values, block scalars, flow collections, indented
 * continuation lines, list items, comments and blanks -- is handed to the real
 * parser untouched, so normal YAML semantics keep working.
 */
function normaliseFrontmatter(fmLines: string[]): string[] {
  return fmLines.map((line) => {
    const match = TOP_LEVEL_KEY.exec(line);
    if (match === null) return line;

    const key = match[1] as string;
    const rawValue = match[2];
    if (rawValue === undefined) return line;

    const value = rawValue.trim();
    if (value === '' || !needsExplicitQuoting(value)) return line;

    return `${key}: ${JSON.stringify(value)}`;
  });
}

/** True when `value` is a plain scalar that YAML would misread or reject. */
function needsExplicitQuoting(value: string): boolean {
  const first = value[0] as string;
  if (RESERVED_FIRST_CHARS.has(first)) return false;
  // A plain scalar may not contain ": " or " #", nor end with ":".
  return value.includes(': ') || value.endsWith(':') || value.includes(' #');
}

function requireNonEmptyString(
  value: unknown,
  key: string,
  filePath: string,
  line: number | undefined,
): string {
  if (value === undefined || value === null) {
    throw new AgentParseError(`frontmatter is missing required key "${key}"`, filePath, line);
  }
  if (typeof value !== 'string') {
    throw new AgentParseError(
      `frontmatter "${key}" must be a string (found ${describeType(value)})`,
      filePath,
      line,
    );
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new AgentParseError(`frontmatter "${key}" is empty`, filePath, line);
  }
  return trimmed;
}

/**
 * `tools` is a flat comma-separated string in every file in this repo
 * (`tools: Read, Grep, Glob`). Tool names legitimately contain colons,
 * underscores and dashes (`subagent-catalog:search`, `mcp__bgpt__search_papers`,
 * `chrome-mcp`), so we split on commas only and then trim, which preserves them
 * verbatim. A YAML sequence is also accepted, for forward compatibility.
 */
function parseTools(value: unknown, filePath: string, line: number | undefined): string[] {
  if (value === undefined || value === null) {
    throw new AgentParseError('frontmatter is missing required key "tools"', filePath, line);
  }

  let parts: string[];
  if (typeof value === 'string') {
    parts = value.split(',');
  } else if (Array.isArray(value)) {
    parts = value.map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new AgentParseError(
          `frontmatter "tools" entry ${index} must be a string (found ${describeType(entry)})`,
          filePath,
          line,
        );
      }
      return entry;
    });
  } else {
    throw new AgentParseError(
      `frontmatter "tools" must be a comma-separated string (found ${describeType(value)})`,
      filePath,
      line,
    );
  }

  const tools = parts.map((tool) => tool.trim()).filter((tool) => tool.length > 0);
  if (tools.length === 0) {
    throw new AgentParseError('frontmatter "tools" is empty', filePath, line);
  }
  return tools;
}

/** `model` is optional: 8 of the repo's 154 agent files omit it entirely. */
function parseModel(
  value: unknown,
  filePath: string,
  line: number | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new AgentParseError(
      `frontmatter "model" must be a string (found ${describeType(value)})`,
      filePath,
      line,
    );
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new AgentParseError('frontmatter "model" is present but empty', filePath, line);
  }
  return trimmed;
}

/** Repo-relative with forward slashes. This runs on Windows too. */
function toRepoRelative(filePath: string, repoRoot: string): string {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(filePath));
  return relative.split(/[\\/]/).join('/');
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}
