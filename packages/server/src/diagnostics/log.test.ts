import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiagnosticsLog, classifyProviderWarning } from './log.js';
import { parseAgentNotes } from '../orchestrator/notes.js';

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

async function freshLog(now = () => 1_700_000_000_000): Promise<DiagnosticsLog> {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-diagnostics-'));
  return new DiagnosticsLog({ runsRoot: tmpRoot, now });
}

describe('DiagnosticsLog', () => {
  it('appends one JSON object per line and reads them back', async () => {
    const log = await freshLog();

    await log.record({ kind: 'tool-denied', runId: 'r1', message: 'no shell for you' });
    await log.record({ kind: 'enhancement', runId: 'r1', message: 'a shell would help' });

    const { records, skipped } = await log.read();
    expect(skipped).toBe(0);
    expect(records.map((r) => r.kind)).toEqual(['tool-denied', 'enhancement']);
    // Severity comes from the kind, never from the caller, so one kind cannot be
    // logged at two severities by two call sites.
    expect(records.map((r) => r.severity)).toEqual(['warning', 'info']);
  });

  it('writes a record with no run id at all, for a failure that belongs to the process', async () => {
    // `request-failed` on `GET /api/agents` happened in this server, not in any
    // run. The field is absent rather than filled with a placeholder, so
    // `--run` cannot match it and the reader does not count it as a run.
    const log = await freshLog();

    const written = await log.record({ kind: 'request-failed', message: '500 GET /api/agents' });

    expect(written?.runId).toBeUndefined();
    expect(Object.keys(written ?? {})).not.toContain('runId');
    const { records, skipped } = await log.read();
    expect(skipped).toBe(0);
    expect(records[0]?.severity).toBe('error');
  });

  it('is an empty read, not an error, before anything has ever been logged', async () => {
    const log = await freshLog();
    await expect(log.read()).resolves.toEqual({ records: [], skipped: 0 });
  });

  it('survives a truncated last line — the exact thing a crash mid-append leaves', async () => {
    const log = await freshLog();
    await log.record({ kind: 'note', runId: 'r1', message: 'first' });
    await log.record({ kind: 'note', runId: 'r1', message: 'second' });

    const existing = await readFile(log.path, 'utf8');
    await writeFile(log.path, `${existing}{"ts":1700000000000,"kind":"no`, 'utf8');

    const { records, skipped } = await log.read();
    expect(records.map((r) => r.message)).toEqual(['first', 'second']);
    expect(skipped).toBe(1);
  });

  it('collapses newlines in a message, because the message is a grouping key', async () => {
    const log = await freshLog();
    const written = await log.record({
      kind: 'blocker',
      runId: 'r1',
      message: 'first line\nsecond line',
    });

    expect(written?.message).toBe('first line second line');
    // One record, one line — a raw newline would also split the JSONL file.
    expect((await readFile(log.path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('never throws when the log cannot be written, and says so through onWarning', async () => {
    // The log observes a run; it is not part of one. A full disk must not fail
    // an assignment that otherwise succeeded.
    const warnings: string[] = [];
    const log = new DiagnosticsLog({
      // A path whose parent is a FILE, so mkdir and appendFile both fail.
      runsRoot: path.join(await makeFilePath(), 'nested'),
      onWarning: (message) => warnings.push(message),
    });

    await expect(
      log.record({ kind: 'note', runId: 'r1', message: 'still fine' }),
    ).resolves.toBeDefined();
    expect(warnings.join(' ')).toContain('could not append');
  });

  it('refuses to write a record the reader could not parse', async () => {
    const warnings: string[] = [];
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-diagnostics-'));
    const log = new DiagnosticsLog({
      runsRoot: tmpRoot,
      onWarning: (message) => warnings.push(message),
    });

    // Empty message fails the schema's `.min(1)`.
    const written = await log.record({ kind: 'note', runId: 'r1', message: '   ' });

    expect(written).toBeUndefined();
    expect(warnings.join(' ')).toContain('malformed');
    await expect(log.read()).resolves.toEqual({ records: [], skipped: 0 });
  });
});

async function makeFilePath(): Promise<string> {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-diagnostics-'));
  const file = path.join(tmpRoot, 'a-file');
  await writeFile(file, 'not a directory', 'utf8');
  return file;
}

describe('classifyProviderWarning', () => {
  it('recognises the two phrases this codebase actually emits', () => {
    // Pinned so a reword of either message breaks a test rather than silently
    // degrading every future record to the general kind — the mitigation the
    // function's own doc comment promises.
    expect(
      classifyProviderWarning('tool "Bash" was not granted: "Bash" resolves to the built-in...'),
    ).toBe('tool-denied');
    expect(
      classifyProviderWarning('tool "mcp__rogue__place_order" was not granted: mcp-server-not-registered'),
    ).toBe('mcp-unregistered');
  });

  it('files anything else under the general kind rather than guessing', () => {
    expect(classifyProviderWarning('model override: ran on sonnet, not haiku')).toBe(
      'provider-warning',
    );
  });
});

describe('parseAgentNotes', () => {
  it('finds every marker, including the SUGGESTION synonym', () => {
    const report = [
      '# Findings',
      '',
      'The service looks fine.',
      '',
      '[[ENHANCEMENT: a shell would have let me run the test suite]]',
      '[[SUGGESTION: the brief should say which jurisdiction]]',
      '[[BLOCKER: no codebase was supplied]]',
      '[[NOTE: the upstream report was truncated]]',
    ].join('\n');

    expect(parseAgentNotes(report)).toEqual([
      { kind: 'enhancement', text: 'a shell would have let me run the test suite' },
      { kind: 'enhancement', text: 'the brief should say which jurisdiction' },
      { kind: 'blocker', text: 'no codebase was supplied' },
      { kind: 'note', text: 'the upstream report was truncated' },
    ]);
  });

  it('survives the markdown a model wraps its report in', () => {
    // The whole reason `review.ts` chose double square brackets: bold, headings
    // and code fences add characters AROUND the token.
    const report = ['## Notes', '', '- **[[ENHANCEMENT: give me Grep]]**', '', '```', 'x', '```'].join(
      '\n',
    );
    expect(parseAgentNotes(report)).toEqual([{ kind: 'enhancement', text: 'give me Grep' }]);
  });

  it('finds nothing in a report that says nothing, which is most reports', () => {
    expect(parseAgentNotes('# Findings\n\nAll good. No notes.')).toEqual([]);
  });

  it('ignores a marker whose body is empty rather than logging a blank note', () => {
    expect(parseAgentNotes('[[NOTE:   ]]')).toEqual([]);
  });

  it('ignores a marker QUOTED mid-sentence, which is how an audit of this system reads', () => {
    // Verbatim from `error-detective`'s report in run 20260814-212704-3z7s. The
    // old parser matched it, recorded a 10,017-byte audit as `declined`, and
    // logged a blocker whose whole message was `...`.
    const cited =
      '**Scenario:** A run where every assignment legitimately declines (e.g., a task whose ' +
      'prerequisites are missing, or every specialist the Manager picked reports ' +
      '`[[BLOCKER: ...]]` because the request is genuinely out of scope for them).';

    expect(parseAgentNotes(cited)).toEqual([]);
  });

  it('still finds a real declaration on its own line, from the same run', () => {
    // `code-reviewer`'s note from that run began at column 0. Position is what
    // separates the two, and this pins that both halves still work.
    const declared = [
      '## Findings',
      '',
      'All good.',
      '',
      '[[NOTE: The Grep tool returned false negatives on this repository.]]',
    ].join('\n');

    expect(parseAgentNotes(declared)).toEqual([
      { kind: 'note', text: 'The Grep tool returned false negatives on this repository.' },
    ]);
  });

  it('accepts a bullet or bold wrapper, which is how a model formats a line it means', () => {
    expect(parseAgentNotes('- [[NOTE: bulleted]]')).toEqual([{ kind: 'note', text: 'bulleted' }]);
    expect(parseAgentNotes('**[[BLOCKER: emphasised]]**')).toEqual([
      { kind: 'blocker', text: 'emphasised' },
    ]);
  });

  it('ignores markers inside a fenced code block, where documentation examples live', () => {
    const documented = ['Here is the format:', '', '```', '[[BLOCKER: reason]]', '```'].join('\n');
    expect(parseAgentNotes(documented)).toEqual([]);
  });

  it('rejects the literal placeholder, which a model copied verbatim in a real run', () => {
    // `[[BLOCKER: ...]]` is what the brief prints as an example. A record whose
    // entire message is three dots is not a note, and it flipped an assignment's
    // status when it was treated as one.
    expect(parseAgentNotes('[[BLOCKER: ...]]')).toEqual([]);
    expect(parseAgentNotes('[[NOTE: ---]]')).toEqual([]);
  });

  it('does not let an unterminated marker swallow the rest of the report', () => {
    const runaway = `[[ENHANCEMENT: ${'x'.repeat(5_000)}]]`;
    // Over the 2,000-char body cap, so it matches nothing at all rather than
    // pasting a report into the diagnostics log.
    expect(parseAgentNotes(runaway)).toEqual([]);
  });
});
