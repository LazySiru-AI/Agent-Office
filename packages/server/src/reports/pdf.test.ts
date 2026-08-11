import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnClaude } from '../providers/claude-code/childProcess.js';
import {
  CHROME_BIN_ENV_VAR,
  DEFAULT_RENDER_TIMEOUT_MS,
  PdfRenderError,
  checkChromiumAvailability,
  renderPdf,
  resetChromiumResolutionCache,
  resolveChromium,
  toFileUrl,
  verifyPdfOutput,
} from './pdf.js';
import type { ResolveBrowserOptions, ResolvedBrowser } from './pdf.js';

/**
 * As with `resolveBinary.test.ts`, all *resolution* here runs against a real
 * temp directory driven entirely through `ResolveBrowserOptions.{env,
 * platform}` — never the machine's actual PATH, `%ProgramFiles%`, etc. — so
 * these pass on a clean CI box regardless of what is actually installed
 * there.
 *
 * `renderPdf` itself is exercised two ways: a fake, injected `spawn` (a
 * stand-in `node` process, same technique `provider.test.ts` uses for the
 * `claude` CLI) covers exit-code handling, timeout/kill and temp-directory
 * cleanup without needing a real browser at all; a single real end-to-end
 * test additionally drives an actual installed Chromium, since one is
 * genuinely present on this machine, but is written to skip — not fail — on
 * a machine where `resolveChromium()` finds nothing.
 */

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-office-pdf-test-'));
  resetChromiumResolutionCache();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  resetChromiumResolutionCache();
});

async function makeFakeBinary(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '');
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o755);
  }
}

function windowsOptions(overrides: Partial<ResolveBrowserOptions> = {}): ResolveBrowserOptions {
  return {
    platform: 'win32',
    env: {
      ProgramFiles: path.join(tmpRoot, 'ProgramFiles'),
      'ProgramFiles(x86)': path.join(tmpRoot, 'ProgramFilesX86'),
      LOCALAPPDATA: path.join(tmpRoot, 'LocalAppData'),
      PATH: '',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveChromium — precedence
// ---------------------------------------------------------------------------

describe('resolveChromium', () => {
  it('returns undefined when nothing resolves anywhere', async () => {
    const result = await resolveChromium(windowsOptions());
    expect(result).toBeUndefined();
  });

  it('env override wins over both PATH and install roots', async () => {
    const overridePath = path.join(tmpRoot, 'override', 'my-chrome.exe');
    await makeFakeBinary(overridePath);

    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'chrome.exe'));

    await makeFakeBinary(path.join(tmpRoot, 'ProgramFiles', 'Google', 'Chrome', 'Application', 'chrome.exe'));

    const result = await resolveChromium(
      windowsOptions({
        env: {
          ProgramFiles: path.join(tmpRoot, 'ProgramFiles'),
          PATH: pathDir,
          [CHROME_BIN_ENV_VAR]: overridePath,
        },
      }),
    );

    expect(result).toEqual({ path: overridePath, source: 'env-override' });
  });

  it('falls through to PATH when the override points at nothing, rather than reporting not-found outright', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    const binaryPath = path.join(pathDir, 'chrome.exe');
    await makeFakeBinary(binaryPath);

    const result = await resolveChromium(
      windowsOptions({
        env: {
          PATH: pathDir,
          [CHROME_BIN_ENV_VAR]: path.join(tmpRoot, 'does-not-exist.exe'),
        },
      }),
    );

    expect(result).toEqual({ path: binaryPath, source: 'path' });
  });

  it('finds chrome.exe on PATH when nothing else is set', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    const binaryPath = path.join(pathDir, 'chrome.exe');
    await makeFakeBinary(binaryPath);

    const result = await resolveChromium(windowsOptions({ env: { PATH: pathDir } }));

    expect(result).toEqual({ path: binaryPath, source: 'path' });
  });

  it('falls back to msedge.exe on PATH when chrome.exe is absent', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    const binaryPath = path.join(pathDir, 'msedge.exe');
    await makeFakeBinary(binaryPath);

    const result = await resolveChromium(windowsOptions({ env: { PATH: pathDir } }));

    expect(result).toEqual({ path: binaryPath, source: 'path' });
  });

  it('finds Chrome under the 64-bit Program Files install root', async () => {
    const binaryPath = path.join(tmpRoot, 'ProgramFiles', 'Google', 'Chrome', 'Application', 'chrome.exe');
    await makeFakeBinary(binaryPath);

    const result = await resolveChromium(windowsOptions());

    expect(result).toEqual({ path: binaryPath, source: 'install-root' });
  });

  it('falls back to Edge when only an Edge install root exists', async () => {
    const binaryPath = path.join(tmpRoot, 'ProgramFilesX86', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    await makeFakeBinary(binaryPath);

    const result = await resolveChromium(windowsOptions());

    expect(result).toEqual({ path: binaryPath, source: 'install-root' });
  });

  it('prefers Chrome over Edge when both are installed', async () => {
    const chromePath = path.join(tmpRoot, 'ProgramFiles', 'Google', 'Chrome', 'Application', 'chrome.exe');
    const edgePath = path.join(tmpRoot, 'ProgramFilesX86', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    await makeFakeBinary(chromePath);
    await makeFakeBinary(edgePath);

    const result = await resolveChromium(windowsOptions());

    expect(result).toEqual({ path: chromePath, source: 'install-root' });
  });

  // A POSIX-PATH-splitting test (`:`-delimited) is deliberately not included
  // here: on this native-Windows test machine, every real path under
  // `tmpRoot` starts `C:\...`, and a colon-delimited split of a Windows path
  // truncates the drive letter — a test artefact of running POSIX-mode
  // resolution against Windows paths, not a bug in `resolveChromium` itself.
  // `resolveBinary.test.ts` has the same gap for the same reason: its POSIX
  // coverage is install-root-based (a real, non-PATH filesystem path), not
  // PATH-splitting-based. `candidateNames('linux')` is exercised indirectly
  // by the Windows-side PATH tests above sharing the same `findOnPath` code
  // path with a different name list.
});

// ---------------------------------------------------------------------------
// checkChromiumAvailability — the not-found reason
// ---------------------------------------------------------------------------

describe('checkChromiumAvailability', () => {
  it('reports a clear, actionable reason naming the env var and how to install a browser', async () => {
    const availability = await checkChromiumAvailability({ ...windowsOptions(), useCache: false });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toMatch(/not found|no chromium/i);
    expect(availability.reason).toContain(CHROME_BIN_ENV_VAR);
    expect(availability.reason).toMatch(/install google chrome or microsoft edge/i);
  });

  it('mentions the broken override specifically when one was set but does not exist', async () => {
    const availability = await checkChromiumAvailability({
      ...windowsOptions({ env: { [CHROME_BIN_ENV_VAR]: 'C:\\nonexistent\\chrome.exe' } }),
      useCache: false,
    });

    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('C:\\nonexistent\\chrome.exe');
  });

  it('reports ok: true once a browser resolves', async () => {
    const pathDir = path.join(tmpRoot, 'onpath');
    await makeFakeBinary(path.join(pathDir, 'chrome.exe'));

    const availability = await checkChromiumAvailability({
      ...windowsOptions({ env: { PATH: pathDir } }),
      useCache: false,
    });

    expect(availability).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// toFileUrl — path -> file:// URL conversion
// ---------------------------------------------------------------------------

describe('toFileUrl', () => {
  it('produces a file:// URL and round-trips back to the same absolute path, for a real path containing a space', () => {
    // process.cwd() during this test run is inside the repo, whose own
    // directory name is "Agent Office" — a space is not a hypothetical here.
    const original = path.join(process.cwd(), 'a report', 'out.pdf');
    expect(original).toContain(' ');

    const url = toFileUrl(original);

    expect(url.protocol).toBe('file:');
    expect(fileURLToPath(url)).toBe(path.resolve(original));
  });

  it('percent-encodes a space rather than leaving it raw', () => {
    const url = toFileUrl(path.join(tmpRoot, 'a report dir', 'out.pdf'));
    expect(url.toString()).toContain('%20');
    expect(url.toString()).not.toMatch(/dir\/.*\s/); // no raw space survives into the URL string
  });

  it.skipIf(process.platform !== 'win32')(
    'handles a Windows drive letter correctly (three slashes, drive letter first)',
    () => {
      const url = toFileUrl('C:\\Users\\Test User\\reports\\out.pdf');
      expect(url.toString()).toMatch(/^file:\/\/\/C:\//);
      expect(fileURLToPath(url)).toBe(path.resolve('C:\\Users\\Test User\\reports\\out.pdf'));
    },
  );

  it('resolves a relative path to an absolute file:// URL', () => {
    const url = toFileUrl('relative.html');
    expect(url.toString().startsWith('file:///') || url.toString().startsWith('file://')).toBe(true);
    expect(fileURLToPath(url)).toBe(path.resolve('relative.html'));
  });
});

// ---------------------------------------------------------------------------
// verifyPdfOutput — output verification, independent of any spawn
// ---------------------------------------------------------------------------

describe('verifyPdfOutput', () => {
  function plausiblePdfBytes(): string {
    // Comfortably clears MIN_PLAUSIBLE_PDF_BYTES while still being trivial.
    return `%PDF-1.7\n${'0'.repeat(200)}\n%%EOF`;
  }

  it('accepts a file with the PDF magic bytes and a plausible size', async () => {
    const filePath = path.join(tmpRoot, 'good.pdf');
    const content = plausiblePdfBytes();
    await writeFile(filePath, content, 'utf8');

    const result = await verifyPdfOutput(filePath);

    expect(result.outputPath).toBe(filePath);
    expect(result.bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('rejects a missing file with a clear message', async () => {
    await expect(verifyPdfOutput(path.join(tmpRoot, 'missing.pdf'))).rejects.toThrow(PdfRenderError);
  });

  it('rejects an empty (0-byte) file', async () => {
    const filePath = path.join(tmpRoot, 'empty.pdf');
    await writeFile(filePath, '', 'utf8');

    await expect(verifyPdfOutput(filePath)).rejects.toThrow(/empty/i);
  });

  it('rejects a file that is non-empty but too small to be a real PDF', async () => {
    const filePath = path.join(tmpRoot, 'truncated.pdf');
    await writeFile(filePath, '%PDF-1.7', 'utf8'); // starts right, but nowhere near a full document

    await expect(verifyPdfOutput(filePath)).rejects.toThrow(/too small|truncated/i);
  });

  it('rejects a plausibly-sized file that is not a PDF at all', async () => {
    const filePath = path.join(tmpRoot, 'not-a-pdf.txt');
    await writeFile(filePath, `This is definitely not a PDF.\n${'x'.repeat(200)}`, 'utf8');

    await expect(verifyPdfOutput(filePath)).rejects.toThrow(/magic bytes/i);
  });
});

// ---------------------------------------------------------------------------
// renderPdf — driven by a fake browser (a stand-in `node` process), so exit
// handling, timeout/kill and cleanup are all exercised without needing a
// real Chromium on the test machine. Same technique as
// `provider.test.ts`'s `replaySpawn` for the `claude` CLI.
// ---------------------------------------------------------------------------

type FakeBehaviour = 'write-pdf' | 'exit-nonzero' | 'hang' | 'exit-clean-no-file';

function fakeBrowserSpawn(behaviour: FakeBehaviour, onSpawn?: (cwd: string) => void): typeof spawnClaude {
  return (options) => {
    onSpawn?.(options.cwd);
    const printArg = options.args.find((arg) => arg.startsWith('--print-to-pdf='));
    const outputPath = printArg !== undefined ? printArg.slice('--print-to-pdf='.length) : '';

    // A tiny stand-in for Chromium: depending on the scenario, it writes a
    // fake-but-plausible PDF and exits cleanly, exits non-zero, exits clean
    // without writing anything, or hangs forever (to exercise the timeout).
    const script = `
      const fs = require('fs');
      const behaviour = process.env.FAKE_BEHAVIOUR;
      const outputPath = process.env.FAKE_OUTPUT_PATH;
      if (behaviour === 'hang') {
        setInterval(() => {}, 1000);
      } else if (behaviour === 'exit-nonzero') {
        process.stderr.write('synthetic browser failure');
        process.exit(1);
      } else if (behaviour === 'exit-clean-no-file') {
        process.exit(0);
      } else {
        fs.writeFileSync(outputPath, '%PDF-1.7\\n' + '0'.repeat(200) + '\\n%%EOF');
        process.exit(0);
      }
    `;

    return spawnClaude({
      binary: process.execPath,
      args: ['-e', script],
      cwd: options.cwd,
      stdin: '',
      env: { ...process.env, FAKE_BEHAVIOUR: behaviour, FAKE_OUTPUT_PATH: outputPath },
    });
  };
}

const fakeBrowser: ResolvedBrowser = { path: 'C:\\fake\\chrome.exe', source: 'install-root' };

describe('renderPdf — fake browser', () => {
  it('writes and verifies a PDF, then removes the temp working directory afterwards', async () => {
    let capturedCwd = '';
    const outputPath = path.join(tmpRoot, 'out', 'report.pdf');

    const result = await renderPdf(
      { kind: 'html', html: '<html><body>hello</body></html>' },
      outputPath,
      {
        deps: {
          spawn: fakeBrowserSpawn('write-pdf', (cwd) => {
            capturedCwd = cwd;
          }),
          resolveBrowser: async () => fakeBrowser,
        },
      },
    );

    expect(result.outputPath).toBe(path.resolve(outputPath));
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(outputPath)).toBe(true);

    // requirement 3/2: the per-invocation temp dir (profile + any written
    // HTML) must not survive the call, success or not.
    expect(capturedCwd).not.toBe('');
    expect(existsSync(capturedCwd)).toBe(false);
  });

  it('surfaces a non-zero exit as a PdfRenderError including stderr, and still cleans up', async () => {
    let capturedCwd = '';
    const outputPath = path.join(tmpRoot, 'never.pdf');

    await expect(
      renderPdf(
        { kind: 'html', html: '<html></html>' },
        outputPath,
        {
          deps: {
            spawn: fakeBrowserSpawn('exit-nonzero', (cwd) => {
              capturedCwd = cwd;
            }),
            resolveBrowser: async () => fakeBrowser,
          },
        },
      ),
    ).rejects.toThrow(/exited with code 1/i);

    expect(existsSync(capturedCwd)).toBe(false);
  });

  it('rejects with a clear error when the browser exits 0 but wrote nothing (output not trusted on exit code alone)', async () => {
    const outputPath = path.join(tmpRoot, 'phantom.pdf');

    await expect(
      renderPdf(
        { kind: 'html', html: '<html></html>' },
        outputPath,
        {
          deps: {
            spawn: fakeBrowserSpawn('exit-clean-no-file'),
            resolveBrowser: async () => fakeBrowser,
          },
        },
      ),
    ).rejects.toThrow(/no file was written/i);
  });

  it('kills a wedged browser and reports a timeout rather than hanging, and still cleans up', async () => {
    let capturedCwd = '';
    const outputPath = path.join(tmpRoot, 'wedged.pdf');

    await expect(
      renderPdf(
        { kind: 'html', html: '<html></html>' },
        outputPath,
        {
          timeoutMs: 200,
          deps: {
            spawn: fakeBrowserSpawn('hang', (cwd) => {
              capturedCwd = cwd;
            }),
            resolveBrowser: async () => fakeBrowser,
          },
        },
      ),
    ).rejects.toThrow(/did not finish|killed/i);

    expect(existsSync(capturedCwd)).toBe(false);
  }, 10_000);

  it('rejects immediately with a clear reason when no browser resolves, without touching the filesystem', async () => {
    const outputPath = path.join(tmpRoot, 'unreachable.pdf');

    await expect(
      renderPdf(
        { kind: 'html', html: '<html></html>' },
        outputPath,
        { deps: { resolveBrowser: async () => undefined } },
      ),
    ).rejects.toThrow(new RegExp(CHROME_BIN_ENV_VAR));
  });

  it('rejects a missing input file before ever spawning a browser', async () => {
    const missingInput = path.join(tmpRoot, 'does-not-exist.html');
    const outputPath = path.join(tmpRoot, 'from-missing.pdf');
    let spawned = false;

    await expect(
      renderPdf(
        { kind: 'file', path: missingInput },
        outputPath,
        {
          deps: {
            spawn: () => {
              spawned = true;
              throw new Error('should not be called');
            },
            resolveBrowser: async () => fakeBrowser,
          },
        },
      ),
    ).rejects.toThrow(/not found/i);

    expect(spawned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderPdf — real end-to-end. Skips (does not fail) on a machine with no
// resolvable Chromium-family browser.
// ---------------------------------------------------------------------------

const realBrowser = await resolveChromium();

describe.runIf(realBrowser !== undefined)('renderPdf — real headless browser', () => {
  it(`produces a genuine, valid PDF via ${realBrowser?.path ?? '(unresolved)'}`, async () => {
    const outputPath = path.join(tmpRoot, 'real', 'report.pdf');
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: sans-serif; }
      .page-two { break-before: page; }
    </style>
  </head>
  <body>
    <h1>Agent Office — test report</h1>
    <p>Rendered by the Phase 5 pdf.ts test suite.</p>
    <div class="page-two"><p>Second page.</p></div>
  </body>
</html>`;

    const result = await renderPdf({ kind: 'html', html }, outputPath, { timeoutMs: DEFAULT_RENDER_TIMEOUT_MS });

    expect(result.outputPath).toBe(path.resolve(outputPath));
    // A plausible lower bound for a real two-"page" HTML->PDF conversion;
    // the verified experiment in the task brief produced 28,662 bytes for
    // a similarly small document.
    expect(result.bytes).toBeGreaterThan(1_000);

    const info = await stat(outputPath);
    expect(info.size).toBe(result.bytes);
    // 60s, not the 30s this carried before. A measurement pass over five
    // full-suite runs observed this at 27.5s — 92% of its own budget, the
    // narrowest margin anywhere in the suite. It launches a real browser and
    // waits for a real render, so the cost is a cold process start competing
    // with everything else the suite is doing; a machine slower than this one,
    // or one whose scanner takes an interest in a new chrome.exe, goes over.
    // Nothing here can hang silently — `renderPdf` carries its own
    // `timeoutMs` — so this budget only has to be generous enough not to lie.
  }, 60_000);
});

if (realBrowser === undefined) {
  it.skip('renderPdf — real headless browser: skipped, no Chromium-family browser resolved on this machine', () => {
    /* intentionally empty — see the `describe.runIf` block above */
  });
}
