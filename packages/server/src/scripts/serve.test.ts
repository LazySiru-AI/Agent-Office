import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addrInUseHint, devTokenFilePath, parseArgs, USAGE, type CliOptions } from './serve.js';

/**
 * Exercises `parseArgs`, `devTokenFilePath`, `addrInUseHint`, and the
 * `Options:` block in `USAGE` directly — `main()`'s network/file IO
 * (`watchRegistry`, `app.listen()`, the dev-token write) is deliberately not
 * under test here, matching `purge.test.ts`'s split between pure logic and
 * the CLI's own IO shell. `main()` binding a real port is exactly the thing
 * this suite must NOT do (see `serve.ts`'s `isEntryPoint` guard, which is
 * what makes importing this module for its exports safe in the first place).
 *
 * Four defects this file pins down:
 *
 *   1. `--port` used to strand the Vite dev client: the proxy's target was
 *      hardcoded, with nothing reading a port override. The fix itself lives
 *      in `vite.config.ts` (an `AGENT_OFFICE_SERVER_PORT` env var), so
 *      nothing on this side to unit-test beyond "the flag round-trips" —
 *      covered below — and "the CLI's own help text says so", covered by the
 *      alignment block's last test.
 *   2. The dev-token file used to be one fixed path for the whole machine, so
 *      two concurrent `npm run serve` instances overwrote each other's
 *      token. Fixed by `devTokenFilePath`, namespacing the file by port.
 *   3. A taken port produced a raw Node error with no remedy. Fixed by
 *      `addrInUseHint`, appended after (not instead of) the raw message.
 *   4. `--max-concurrent-runs <n>` was wider than the fixed padding column in
 *      `USAGE`, throwing its own description and the following `-h, --help`
 *      line out of alignment with the rest.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('parseArgs — help precedence', () => {
  it('returns "help" for -h', () => {
    expect(parseArgs(['-h'])).toBe('help');
  });

  it('returns "help" for --help', () => {
    expect(parseArgs(['--help'])).toBe('help');
  });
});

describe('parseArgs — defaults', () => {
  it('defaults the port to 5179 when neither --port nor $PORT is set', () => {
    const original = process.env['PORT'];
    delete process.env['PORT'];
    try {
      const result = asOptions(parseArgs([]));
      expect(result.port).toBe(5179);
    } finally {
      if (original === undefined) delete process.env['PORT'];
      else process.env['PORT'] = original;
    }
  });

  it('leaves every optional field absent as a key, not present-with-undefined, when no flag sets it', () => {
    // `exactOptionalPropertyTypes: true` distinguishes "key absent" from "key
    // present with value undefined" — `RunSupervisor`'s own options spreading
    // in `main()` (`...(x === undefined ? {} : { x })`) depends on the
    // former, so a `parseArgs` that ever returned `{ concurrency: undefined }`
    // would be a type-checked lie about what's actually on the object.
    const result = asOptions(parseArgs([]));
    expect('concurrency' in result).toBe(false);
    expect('timeoutMs' in result).toBe(false);
    expect('stepDelayMs' in result).toBe(false);
    expect('maxConcurrentRuns' in result).toBe(false);
  });
});

describe('parseArgs — --port (defect 1: the flag itself still has to round-trip cleanly)', () => {
  it('honours an explicit --port', () => {
    const result = asOptions(parseArgs(['--port', '5299']));
    expect(result.port).toBe(5299);
  });

  it('rejects a non-positive --port rather than silently falling back to the default', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(/positive number/);
    expect(() => parseArgs(['--port', '-1'])).toThrow(/positive number/);
  });

  it('rejects a non-numeric --port', () => {
    expect(() => parseArgs(['--port', 'nope'])).toThrow(/positive number/);
  });
});

describe('devTokenFilePath (defect 2: namespaced by port so two servers do not collide)', () => {
  it('uses the original, unsuffixed file name on the default port — the ordinary single-instance workflow is unchanged', () => {
    expect(devTokenFilePath(5179)).toBe(path.join(os.tmpdir(), 'agent-office', 'dev-token'));
  });

  it('suffixes the file name by port for any non-default port', () => {
    expect(devTokenFilePath(5299)).toBe(path.join(os.tmpdir(), 'agent-office', 'dev-token-5299'));
    expect(devTokenFilePath(8080)).toBe(path.join(os.tmpdir(), 'agent-office', 'dev-token-8080'));
  });

  it('two different ports never produce the same path', () => {
    expect(devTokenFilePath(5179)).not.toBe(devTokenFilePath(5299));
  });

  it('is a pure function of the port — calling it twice agrees with itself', () => {
    expect(devTokenFilePath(5299)).toBe(devTokenFilePath(5299));
  });
});

// This does not import `vite.config.ts` (it is not part of this package's
// dependency graph, and importing a Vite config module outside of Vite is
// not a supported thing to do) — instead it reads the source text, the same
// way `purge.test.ts` reads the real README rather than re-deriving its
// claims from a fixture. The point isn't to execute the web package's copy
// of `devTokenFilePath`, only to catch the two hand-duplicated copies
// drifting apart: same default port, same "-<port>" suffix shape.
describe('devTokenFilePath — matches the scheme documented in vite.config.ts', () => {
  // `src/scripts` -> src -> server -> packages -> repo root. Same depth as
  // `serve.ts`'s own `DEFAULT_REPO_ROOT`, resolved from this file's own
  // location rather than `process.cwd()` for the same reason: npm
  // workspaces run tests with the cwd already set to `packages/server`.
  const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
  const viteConfigSource = readFileSync(path.join(REPO_ROOT, 'packages', 'web', 'vite.config.ts'), 'utf8');

  it('vite.config.ts pins the same default port this file does (5179)', () => {
    expect(viteConfigSource).toContain('DEFAULT_SERVER_PORT = 5179');
  });

  it('vite.config.ts suffixes its token path the same way — a literal `-${port}`', () => {
    expect(viteConfigSource).toContain('`-${port}`');
    expect(viteConfigSource).toContain('`dev-token${suffix}`');
  });
});

describe("addrInUseHint (defect 3: EADDRINUSE gets a remedy line, not just Node's raw text)", () => {
  it('returns undefined for a non-Error value', () => {
    expect(addrInUseHint('not an error')).toBeUndefined();
    expect(addrInUseHint(undefined)).toBeUndefined();
    expect(addrInUseHint({ code: 'EADDRINUSE' })).toBeUndefined();
  });

  it('returns undefined for an Error whose code is not EADDRINUSE', () => {
    const error = Object.assign(new Error('registry load failed'), { code: 'ENOENT' });
    expect(addrInUseHint(error)).toBeUndefined();
  });

  it('returns undefined for a plain Error with no .code at all', () => {
    expect(addrInUseHint(new Error('unknown provider "bogus"'))).toBeUndefined();
  });

  it('names --port and the exact port from the error for a real EADDRINUSE', () => {
    // Shaped the way `net.Server`'s real listen-failure errors are: `.code`,
    // `.port`, and `.address` sitting directly on the `Error` (Node's
    // `exceptionWithHostPort` helper), not nested in some `.cause` or a
    // parsed message string.
    const error = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:5299'), {
      code: 'EADDRINUSE',
      port: 5299,
      address: '127.0.0.1',
    });
    const hint = addrInUseHint(error);
    expect(hint).toBeDefined();
    expect(hint).toContain('--port');
    expect(hint).toContain('5299');
    expect(hint).toContain('AGENT_OFFICE_SERVER_PORT');
  });

  it('falls back to the default port (5179) when the error carries the code but no .port', () => {
    const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    expect(addrInUseHint(error)).toContain('5179');
  });
});

describe('USAGE — Options: column alignment (defect 4)', () => {
  // Rather than re-deriving "column 27" as a magic number (brittle against a
  // deliberate future re-indent of the whole block), this reads the column
  // off a line that was correctly aligned even before this fix
  // (`--provider`'s own description) and checks every other description —
  // including the two that were misaligned — starts at that same column.
  function descriptionColumn(needle: string): number {
    const line = USAGE.split('\n').find((l) => l.includes(needle));
    if (line === undefined) {
      throw new Error(`USAGE has no line containing ${JSON.stringify(needle)} — did the wording change?`);
    }
    return line.indexOf(needle);
  }

  it('every flag description, and every continuation line, starts at the reference column', () => {
    const target = descriptionColumn('Default provider for new runs');
    expect(target).toBeGreaterThan(0);

    // Flag lines (description shares the line with "--flag <value>").
    expect(descriptionColumn('Listen port (default')).toBe(target);
    expect(descriptionColumn('Default parallel assignments')).toBe(target);
    expect(descriptionColumn('Default per-assignment timeout')).toBe(target);
    expect(descriptionColumn('Slow the scripted provider')).toBe(target);
    expect(descriptionColumn('Subagent catalog root')).toBe(target);
    expect(descriptionColumn('Where run artifacts are written')).toBe(target);

    // Continuation lines (no flag on the same line at all).
    expect(descriptionColumn("Use 'scripted' for a free")).toBe(target);
    expect(descriptionColumn('How many runs may execute')).toBe(target);
    expect(descriptionColumn('POST /api/runs is refused')).toBe(target);
  });

  it('DEFECT FIXED: -h, --help now lines up with the rest, not with the line that used to overflow above it', () => {
    const target = descriptionColumn('Default provider for new runs');
    expect(descriptionColumn('Show this message.')).toBe(target);
  });

  it('DEFECT FIXED: --max-concurrent-runs <n> no longer overflows the column — its flag sits alone on its own line', () => {
    const flagLine = USAGE.split('\n').find((l) => l.includes('--max-concurrent-runs'));
    expect(flagLine?.trim()).toBe('--max-concurrent-runs <n>');
  });

  it('documents AGENT_OFFICE_SERVER_PORT under --port, tying the client-stranding fix into the CLI\'s own help text', () => {
    expect(USAGE).toContain('AGENT_OFFICE_SERVER_PORT');
  });
});

/** Narrows `CliOptions | 'help'` for tests that know they didn't pass --help. */
function asOptions(result: CliOptions | 'help'): CliOptions {
  if (result === 'help') throw new Error('unreachable: parseArgs returned "help"');
  return result;
}
