import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './agent.js';

/**
 * Exercises `parseArgs` directly against fixture argv arrays. `main()`
 * spends real money via `ClaudeCodeProvider` and is deliberately not under
 * test here — see `run.test.ts`'s identical split, and its doc comment for
 * the two defects these tests pin down (P1: a boolean flag swallowing the
 * next word into the task; P3: `--help` precedence). This file mirrors that
 * one flag-for-flag, substituting `--replace-prompt` for `--quiet` as the
 * boolean flag that used to have the P1 shape here.
 */

describe('parseArgs — help precedence (P3)', () => {
  it('returns "help" for a bare --help', () => {
    expect(parseArgs(['--help'])).toBe('help');
  });

  it('returns "help" for -h', () => {
    expect(parseArgs(['-h'])).toBe('help');
  });

  it('honours --help even when it trails a completely malformed invocation', () => {
    expect(parseArgs(['--bogus', '--help'])).toBe('help');
  });

  it('honours --help even alongside the P1 defect shape (--replace-prompt followed by a stray word)', () => {
    expect(parseArgs(['do the thing', '--replace-prompt', 'true', '--help'])).toBe('help');
  });
});

describe('parseArgs — positionals-before-flags (P1)', () => {
  it('joins multiple positional words into the task when no flag precedes them', () => {
    const result = parseArgs(['review', 'this', 'file']);
    if (result === 'help') throw new Error('unreachable');
    expect(result.task).toBe('review this file');
  });

  it('accepts --replace-prompt as a bare boolean flag with no following value consumed', () => {
    const result = parseArgs(['a task', '--replace-prompt']);
    if (result === 'help') throw new Error('unreachable');
    expect(result.task).toBe('a task');
    expect(result.replacePrompt).toBe(true);
  });

  it('defaults replacePrompt to false when the flag is absent', () => {
    const result = parseArgs(['a task']);
    if (result === 'help') throw new Error('unreachable');
    expect(result.replacePrompt).toBe(false);
  });

  it('REGRESSION: rejects a bare word left over after --replace-prompt, naming it, instead of joining it onto the task', () => {
    // Same shape as run.ts's `--quiet false` UAT finding, on agent.ts's own
    // boolean flag: `npm run agent -- "a task" --replace-prompt true` used to
    // silently become task "a task true".
    expect(() => parseArgs(['a task', '--replace-prompt', 'true'])).toThrow(/unexpected argument "true"/);
  });

  it('rejects a stray positional after a value-taking flag has already been consumed', () => {
    expect(() => parseArgs(['a task', '--agent', 'code-reviewer', 'extra'])).toThrow(
      /unexpected argument "extra"/,
    );
  });
});

describe('parseArgs — unrecognised flags', () => {
  it('rejects an unknown --flag by name', () => {
    expect(() => parseArgs(['a task', '--bogus', 'x'])).toThrow(/unexpected argument "--bogus"/);
  });

  it('rejects a flag from the OTHER script (run.ts) as unrecognised here', () => {
    expect(() => parseArgs(['a task', '--quiet'])).toThrow(/unexpected argument "--quiet"/);
  });
});

describe('parseArgs — ordinary, well-formed invocations still work', () => {
  it('parses a task with no flags at all, defaulting agentName', () => {
    const result = parseArgs(['just a task']);
    if (result === 'help') throw new Error('unreachable');
    expect(result.task).toBe('just a task');
    expect(result.agentName).toBe('code-reviewer');
    expect(result.maxCostUsd).toBeUndefined();
  });

  it('parses --agent, --model, --max-cost, --workspace together', () => {
    const result = parseArgs([
      'a task',
      '--agent',
      'security-auditor',
      '--model',
      'sonnet',
      '--max-cost',
      '0.25',
      '--workspace',
      '/tmp/sandbox',
    ]);
    if (result === 'help') throw new Error('unreachable');
    expect(result.agentName).toBe('security-auditor');
    expect(result.model).toBe('sonnet');
    expect(result.maxCostUsd).toBe(0.25);
    expect(result.workspace).toBe('/tmp/sandbox');
  });

  it('rejects a non-numeric --max-cost', () => {
    expect(() => parseArgs(['a task', '--max-cost', 'a-lot'])).toThrow(/--max-cost must be a number/);
  });

  it('rejects a value-taking flag given no value at all', () => {
    expect(() => parseArgs(['a task', '--agent'])).toThrow(/--agent needs a value/);
  });

  it('rejects an empty task', () => {
    expect(() => parseArgs([])).toThrow(/a task is required/);
  });

  it('--repo-root defaults to an absolute path, and can be overridden (P3 sibling-flags gap)', () => {
    const withDefault = parseArgs(['a task']);
    if (withDefault === 'help') throw new Error('unreachable');
    expect(path.isAbsolute(withDefault.repoRoot)).toBe(true);

    const withOverride = parseArgs(['a task', '--repo-root', '/some/other/catalog']);
    if (withOverride === 'help') throw new Error('unreachable');
    // Resolved to an absolute path, matching run.ts's --repo-root handling —
    // a relative path here would mean nothing once the registry loader reads
    // it from a different cwd.
    expect(path.isAbsolute(withOverride.repoRoot)).toBe(true);
    expect(withOverride.repoRoot).toBe(path.resolve('/some/other/catalog'));
  });
});
