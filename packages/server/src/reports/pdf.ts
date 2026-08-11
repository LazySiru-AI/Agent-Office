import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { killTree, spawnClaude } from '../providers/claude-code/childProcess.js';
import type { SpawnedChild } from '../providers/claude-code/childProcess.js';

/**
 * HTML → PDF rendering for Phase 5 (FR-P3: "Render HTML → PDF via headless
 * Chromium print-to-PDF. Fully offline — inlined CSS and fonts, no CDN
 * requests.").
 *
 * There is no PDF library in this repo, by decision — see PLAN.md and
 * ASSETS.md's "the project is offline by design" note. Instead this shells
 * out to a Chromium-family browser the user already has installed, the same
 * way `--print-to-pdf` is documented to work from the command line. That
 * command was captured directly on this machine before this file was
 * written:
 *
 *   chrome.exe --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
 *     --print-to-pdf="C:/abs/path/out.pdf" "file:///C:/abs/path/in.html"
 *
 * — exit 0, a 28,662-byte PDF with 2 page objects from a `break-after: page`,
 * producer `Skia/PDF m151`. Two details from that experiment shape the code
 * below: `--print-to-pdf` needs an *absolute* path (a relative one fails with
 * a misleading `Access is denied. (0x5)`, which is a path problem, not a
 * permissions one), and the input must be an absolute `file:///` URL.
 *
 * This module mirrors the shape of
 * `../providers/claude-code/resolveBinary.ts` (env override, then PATH, then
 * known install roots; a cached-but-resettable resolution; a preflight with
 * an actionable reason) because Phase 1 already solved "find an external
 * binary reliably across machines" and there is no reason to solve it a
 * second way for a different binary. `killTree` and `spawnClaude` from
 * `../providers/claude-code/childProcess.ts` are reused outright rather than
 * duplicated: their `SpawnOptions` shape (binary, args, cwd, stdin, env) fits
 * launching a browser exactly as well as it fits launching the `claude` CLI,
 * and the Windows process-tree kill problem `killTree` solves is identical
 * for a wedged Chromium subprocess as for a wedged CLI. No contract friction
 * was found: the only import is `stdin`, which a browser does not read, so
 * it is always passed as `''`.
 */

// ---------------------------------------------------------------------------
// Browser resolution
// ---------------------------------------------------------------------------

export type ResolvedBrowserSource = 'env-override' | 'path' | 'install-root';

export interface ResolvedBrowser {
  /** Absolute (or as-given) path to the resolved Chromium-family executable. */
  path: string;
  source: ResolvedBrowserSource;
}

export interface ResolveBrowserOptions {
  /** Defaults to `process.env`. Overridable so tests never touch the real environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. Overridable so all OS branches are testable from one machine. */
  platform?: NodeJS.Platform;
}

/** Env var name for the explicit override. Always wins — see {@link resolveChromium}. */
export const CHROME_BIN_ENV_VAR = 'AGENT_OFFICE_CHROME_BIN';

async function fileExists(candidate: string): Promise<boolean> {
  if (candidate === '') return false;
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/** Same casing defensiveness as `resolveBinary.ts`'s `readPathVar` — see its comment. */
function readPathVar(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

/**
 * Executable names to try, per platform. Chrome is tried before Edge on every
 * platform (the task's own experiment verified Chrome's output byte-for-byte;
 * Edge is an equally-real Chromium and is only the fallback because it was
 * not the one exercised).
 */
function candidateNames(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['chrome.exe', 'msedge.exe'];
  // POSIX has no PATHEXT shimming, and the common package names differ from
  // the app-bundle names used below in `posixInstallRoots` — `chromium`
  // (Debian/Fedora package) is not the same binary name as `Chromium` (the
  // macOS app bundle), so both are listed explicitly rather than derived.
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
  ];
}

async function findOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  const raw = readPathVar(env);
  if (raw === '') return undefined;

  const names = candidateNames(platform);
  for (const dir of raw.split(pathDelimiter(platform))) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Known install locations, in the order they are tried. Chrome before Edge,
 * and (on Windows) the 64-bit `Program Files` before the 32-bit
 * `Program Files (x86)` — matching where the verified install on this
 * machine actually lives (`C:\Program Files\Google\Chrome\Application\`).
 *
 * Windows roots are built from `env['ProgramFiles']` /
 * `env['ProgramFiles(x86)']` / `env.LOCALAPPDATA` rather than hardcoded
 * `C:\...` strings, for the same reason `resolveBinary.ts` builds its roots
 * from `env.APPDATA`: it is the only way to point resolution at a fixture
 * tree in a test. A root whose base env var is unset or empty is simply
 * skipped, not treated as an error.
 */
function windowsInstallRoots(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env['ProgramFiles'];
  const programFilesX86 = env['ProgramFiles(x86)'];
  const localAppData = env.LOCALAPPDATA;

  const roots: string[] = [];
  if (programFiles !== undefined && programFiles !== '') {
    roots.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (programFilesX86 !== undefined && programFilesX86 !== '') {
    roots.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (localAppData !== undefined && localAppData !== '') {
    // A per-user install (no admin rights) lands here instead of Program Files.
    roots.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (programFilesX86 !== undefined && programFilesX86 !== '') {
    // Verified present on this machine: version 151.0.4129.72.
    roots.push(path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (programFiles !== undefined && programFiles !== '') {
    roots.push(path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return roots;
}

/**
 * Fixed absolute paths for macOS and Linux. Unlike the Windows roots above
 * these are not derived from env vars (there is no per-user equivalent worth
 * chasing), so — like `resolveBinary.ts`'s POSIX `/usr/local/bin` fallback —
 * they are exercised in production but not directly fixture-tested; PATH
 * resolution (fully mockable) is what POSIX behaviour is tested through
 * instead.
 */
function posixInstallRoots(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/snap/bin/chromium',
  ];
}

function knownInstallRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  return platform === 'win32' ? windowsInstallRoots(env) : posixInstallRoots(platform);
}

async function findInInstallRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedBrowser | undefined> {
  for (const candidate of knownInstallRoots(platform, env)) {
    if (await fileExists(candidate)) {
      return { path: candidate, source: 'install-root' };
    }
  }
  return undefined;
}

/**
 * Resolve a Chromium-family browser, in precedence order:
 *
 * 1. `AGENT_OFFICE_CHROME_BIN` — an explicit override always wins. If set but
 *    the path it names does not exist, resolution falls through to steps 2–3
 *    rather than failing outright, but {@link checkChromiumAvailability}
 *    still names the broken override in its reason so a typo is never
 *    silently masked by a healthy PATH install underneath it — same
 *    trade-off `resolveBinary.ts` makes for `AGENT_OFFICE_CLAUDE_BIN`.
 * 2. A Chromium-family browser on `PATH`.
 * 3. Known install roots (Chrome, then Edge; 64-bit before 32-bit on
 *    Windows).
 *
 * Every candidate is checked for existence on disk before being returned, so
 * this function is a pure filesystem query — no process is spawned.
 */
export async function resolveChromium(options: ResolveBrowserOptions = {}): Promise<ResolvedBrowser | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const override = env[CHROME_BIN_ENV_VAR];
  if (override !== undefined && override !== '' && (await fileExists(override))) {
    return { path: override, source: 'env-override' };
  }

  const onPath = await findOnPath(env, platform);
  if (onPath !== undefined) {
    return { path: onPath, source: 'path' };
  }

  return findInInstallRoots(platform, env);
}

/**
 * Cached for the process lifetime, exactly as `resolveClaudeBinaryCached`
 * caches CLI resolution — a PDF export can be requested many times in a
 * server's lifetime, and a browser install does not move between requests.
 * Cached by the "no options" call shape only; see the equivalent note on
 * `resolveClaudeBinaryCached`.
 */
let cached: { value: ResolvedBrowser | undefined } | undefined;

export async function resolveChromiumCached(options: ResolveBrowserOptions = {}): Promise<ResolvedBrowser | undefined> {
  if (cached === undefined) {
    cached = { value: await resolveChromium(options) };
  }
  return cached.value;
}

/** Test-only escape hatch — clears the cache populated by {@link resolveChromiumCached}. */
export function resetChromiumResolutionCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Availability preflight
// ---------------------------------------------------------------------------

/**
 * Deliberately shaped like `../providers/types.ts`'s `ProviderAvailability`
 * (`{ ok, reason? }`) but kept as an independent local type: this module is
 * not an `AgentProvider` and has no business depending on that interface just
 * to borrow its shape.
 */
export interface ChromiumAvailability {
  ok: boolean;
  /** Human-readable, actionable explanation when `ok` is false. */
  reason?: string;
}

function notFoundReason(env: NodeJS.ProcessEnv): string {
  const override = env[CHROME_BIN_ENV_VAR];
  const overrideNote =
    override !== undefined && override !== ''
      ? ` ${CHROME_BIN_ENV_VAR} is set to "${override}", but no executable was found there.`
      : '';
  return (
    `No Chromium-family browser (Google Chrome or Microsoft Edge) was found on PATH or in any known ` +
    `install location.${overrideNote} Install Google Chrome or Microsoft Edge, or set ${CHROME_BIN_ENV_VAR} ` +
    'to the full path of a Chromium-based browser executable (chrome.exe / msedge.exe on Windows; ' +
    'google-chrome or chromium on Linux; the "Google Chrome.app" bundle on macOS). This only blocks PDF ' +
    'export (FR-P3) — per NFR-8, the run itself is unaffected, and per FR-P5/FR-P6 the report remains ' +
    'downloadable as HTML/markdown without a PDF.'
  );
}

export interface CheckChromiumAvailabilityOptions extends ResolveBrowserOptions {
  /** Whether to use {@link resolveChromiumCached} (the default) or a fresh {@link resolveChromium} call each time (for tests). */
  useCache?: boolean;
}

/**
 * Availability preflight (NFR-8: a missing browser must surface as a clear,
 * actionable reason rather than a mid-export failure with no explanation).
 *
 * Unlike `checkClaudeCodeAvailability`, this does not spawn the browser to
 * verify it actually runs — a Chromium cold start is comparatively expensive
 * (hundreds of ms to seconds) and this preflight is meant to be cheap enough
 * to call before every export offer in the UI. A browser that resolves on
 * disk but fails to run will still surface a clear error from
 * {@link renderPdf} itself, just one export later than it could have.
 */
export async function checkChromiumAvailability(
  options: CheckChromiumAvailabilityOptions = {},
): Promise<ChromiumAvailability> {
  const env = options.env ?? process.env;
  const useCache = options.useCache ?? true;

  const resolved = useCache ? await resolveChromiumCached(options) : await resolveChromium(options);
  if (resolved === undefined) {
    return { ok: false, reason: notFoundReason(env) };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Path → file:// URL conversion
// ---------------------------------------------------------------------------

/**
 * Convert a filesystem path to an absolute `file://` URL, the form
 * `--print-to-pdf`'s navigation target must be in.
 *
 * `node:url`'s `pathToFileURL` is used rather than hand-rolled string
 * concatenation because it already handles the two things that are easy to
 * get wrong and hard to notice broken: a Windows drive letter becomes
 * `file:///C:/...` (three slashes, drive letter after them, backslashes
 * flipped to forward slashes), and a space in the path is percent-encoded
 * (`%20`) rather than left raw, which a raw space would break navigation on.
 * This repository's own working directory (`...\Agent Office\...`) contains
 * a space, so this is exercised by the test suite against a real path, not a
 * synthetic one.
 */
export function toFileUrl(inputPath: string): URL {
  return pathToFileURL(path.resolve(inputPath));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * What to render. A discriminated union rather than a single "string that
 * might be a path or might be markup" parameter — the caller states which it
 * means, so there is no need to sniff the string (fragile: real HTML can
 * start with a BOM, a doctype, a comment, or nothing at all) or cast away a
 * guess with `as`.
 */
export type PdfSource = { kind: 'html'; html: string } | { kind: 'file'; path: string };

export interface RenderPdfOptions {
  /** Milliseconds before a render is treated as wedged. Defaults to {@link DEFAULT_RENDER_TIMEOUT_MS}. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Injectable for tests, mirroring `ClaudeCodeProvider`'s `deps` convention.
   * `spawn` defaults to the real `spawnClaude`; `resolveBrowser` defaults to
   * {@link resolveChromiumCached} scoped to `env`/`platform` above.
   */
  deps?: {
    spawn?: typeof spawnClaude;
    resolveBrowser?: () => Promise<ResolvedBrowser | undefined>;
  };
}

export interface RenderPdfResult {
  /** Absolute path the PDF was written to. */
  outputPath: string;
  /** Verified size in bytes. */
  bytes: number;
}

/** Thrown for every failure this module produces — browser not found, timeout, non-zero exit, bad output. */
export class PdfRenderError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, PdfRenderError.prototype);
    this.name = 'PdfRenderError';
  }
}

/**
 * The render timeout.
 *
 * A single-document report's print-to-PDF is genuinely fast — the verified
 * experiment on this machine produced a 28KB two-page PDF in well under a
 * second of wall time once Chrome was launched. 30s is not "how long this
 * normally takes"; it is "generous enough to absorb a cold Chromium launch
 * (which, unlike a small CLI, can itself take a few seconds the first time)
 * plus the virtual-time budget below, while still failing fast enough that a
 * wedged browser (NFR-8) does not hang a report export indefinitely." It is
 * deliberately larger than `AUTH_STATUS_TIMEOUT_MS` (5s) in
 * `resolveBinary.ts`: that is a lightweight status query, this is a full
 * browser launch, layout and PDF encode.
 */
export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

/**
 * `--virtual-time-budget` in milliseconds.
 *
 * Reports here are server-rendered, self-contained HTML with inlined CSS
 * (FR-P3: "fully offline... no CDN requests") — there is no client-side JS
 * expected to run before the document is "done". The budget is still passed,
 * not omitted, as a safety margin: it forces Chromium to let queued layout,
 * paint and font work settle for up to this long before the compositor
 * stages `--run-all-compositor-stages-before-draw` waits on are considered
 * finished, so a themed stylesheet with `@font-face` or a slow first layout
 * is not caught mid-application. 5s comfortably covers that without being a
 * large fraction of the overall 30s render timeout above.
 */
const VIRTUAL_TIME_BUDGET_MS = 5_000;

/**
 * Below this many bytes, a file claiming to be a PDF is almost certainly a
 * truncated write (browser killed mid-write, disk full, etc.) rather than a
 * real one — even a minimal single-page PDF's cross-reference table and
 * trailer alone run well past this. Catching that here, rather than trusting
 * "the process exited 0", is what requirement 4 in the task brief calls out
 * by name.
 */
const MIN_PLAUSIBLE_PDF_BYTES = 100;

async function readMagicBytes(filePath: string, length: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.toString('latin1', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Verify a file at `filePath` is a plausible, non-truncated PDF: it exists,
 * is non-empty, clears a minimum plausible size, and starts with the `%PDF-`
 * magic bytes. Exported so the checks themselves are unit-testable without
 * spawning anything — see the task brief's requirement to reject an empty
 * file and a non-PDF file specifically.
 *
 * A process exiting 0 is not proof of a good PDF: `--print-to-pdf` can, in
 * principle, exit cleanly having written nothing (disk full, permission
 * denied after the fact, a killed compositor) — this is the check that
 * catches that rather than reporting success on trust.
 */
export async function verifyPdfOutput(filePath: string): Promise<RenderPdfResult> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new PdfRenderError(`Expected a PDF at "${filePath}", but no file was written.`);
  }

  if (!info.isFile()) {
    throw new PdfRenderError(`Expected a PDF file at "${filePath}", but found something else there.`);
  }
  if (info.size === 0) {
    throw new PdfRenderError(`PDF output at "${filePath}" is empty (0 bytes) — the render likely failed silently.`);
  }
  if (info.size < MIN_PLAUSIBLE_PDF_BYTES) {
    throw new PdfRenderError(
      `PDF output at "${filePath}" is only ${info.size} bytes — too small to be a real PDF, and likely truncated.`,
    );
  }

  const magic = await readMagicBytes(filePath, 5);
  if (magic !== '%PDF-') {
    throw new PdfRenderError(
      `File at "${filePath}" does not start with the PDF magic bytes ("%PDF-"); got ${JSON.stringify(magic)}. ` +
        'It is not a valid PDF.',
    );
  }

  return { outputPath: filePath, bytes: info.size };
}

async function resolveInputPath(source: PdfSource, workDir: string): Promise<string> {
  if (source.kind === 'file') {
    const absPath = path.resolve(source.path);
    if (!(await fileExists(absPath))) {
      throw new PdfRenderError(`HTML input file not found: "${absPath}".`);
    }
    return absPath;
  }

  // In-memory HTML has nowhere to be navigated to until it is a file — Chrome
  // cannot print a string. Written inside `workDir` so it is removed by the
  // same cleanup as the browser profile, below.
  const htmlPath = path.join(workDir, 'input.html');
  await writeFile(htmlPath, source.html, 'utf8');
  return htmlPath;
}

type ExitOutcome =
  | { kind: 'timeout' }
  | { kind: 'exit'; code: number | null }
  | { kind: 'spawn-error'; message: string };

/**
 * Race the child's exit against `timeoutMs`, killing the whole process tree
 * on expiry via `killTree` (requirement 2: a wedged browser must not hang a
 * run forever). `exit`'s rejection branch (spawn failure, e.g. the resolved
 * path existing but not being executable) is folded into the same union
 * rather than left to reject the outer call, so `renderPdf` has one place —
 * this function's return value — to decide what happened, and no branch of
 * this races an unhandled rejection.
 */
async function raceExit(
  child: Parameters<typeof killTree>[0],
  exit: SpawnedChild['exit'],
  timeoutMs: number,
): Promise<ExitOutcome> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<ExitOutcome>((resolve) => {
    timer = setTimeout(() => {
      killTree(child);
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });

  const settled: Promise<ExitOutcome> = exit.then(
    ({ code }) => ({ kind: 'exit', code }),
    (error: unknown) => ({ kind: 'spawn-error', message: error instanceof Error ? error.message : String(error) }),
  );

  try {
    return await Promise.race([timeout, settled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render `source` to a PDF at `outputPath` using headless Chromium
 * (FR-P3/FR-P4).
 *
 * Flags, and why each one is here:
 * - `--headless`, `--disable-gpu` — no window, no GPU process; this runs on a
 *   server host that may have neither a display nor a usable GPU driver.
 * - `--no-sandbox` — required to get a working `--print-to-pdf` on this
 *   machine (see the module doc comment's captured command); without it the
 *   run failed outright in the verifying experiment, so this flag cannot
 *   simply be dropped without breaking PDF export for everyone (AO-7).
 *
 *   The justification that used to live here — that the only page this
 *   process navigates to is "server-generated and therefore not hostile" —
 *   was wrong, and AO-7 is that finding. `document.ts`'s own doc comment
 *   states the opposite plainly: "everything that reaches this file is
 *   untrusted. The task is user input; agent names, objectives and report
 *   bodies are model output." The escaping layer in `document.ts`
 *   (`escapeHtml`, applied to every interpolated value; `renderMarkdown`
 *   escaping raw HTML in report bodies) is real and was verified — no `<a>`,
 *   no `<img>`, no way for a report to inject markup into the document's own
 *   structure — but that is a defense in the *content*, not a property of
 *   *how it got here*. It defends against the page containing attacker HTML;
 *   it says nothing about a bug in Chromium's own HTML/CSS/font parser being
 *   tripped by adversarial-but-still-just-text model output before escaping
 *   even matters, which is exactly the class of exploit the OS sandbox
 *   exists to contain. So `--no-sandbox` does trade away a real defense
 *   against a real, present threat model, not a hypothetical one.
 *
 *   Given that removing the flag outright is not available (it breaks
 *   rendering) and rebuilding sandbox support was out of scope for this fix,
 *   the mitigation applied instead is to remove everywhere a compromised,
 *   sandbox-less renderer could usefully go: `--host-resolver-rules`,
 *   `--disable-extensions` and `--disable-remote-fonts` below. None of these
 *   restore the process-level sandbox; they shrink what a renderer that
 *   somehow got arbitrary behaviour out of a parser bug could do with it, on
 *   a page that never legitimately needs the network at all (FR-P3: "fully
 *   offline — inlined CSS and fonts, no CDN requests").
 * - `--host-resolver-rules="MAP * ~NOTFOUND"` — forces every DNS lookup this
 *   Chromium process makes to fail, unconditionally. A `file://` report has
 *   no legitimate reason to resolve any hostname; this removes the network
 *   as a destination for exfiltration or callback even if page content were
 *   able to trigger a request some other way (a bug in the renderer, a
 *   future regression in the escaping layer, a resource reference the
 *   escaping did not anticipate). It does not need a matching allow-rule for
 *   anything, because the input is `file:///...`, not a URL that itself
 *   needs resolving.
 * - `--disable-extensions` — a fresh `--user-data-dir` (below) has no
 *   extensions installed regardless, so this is not covering a gap the
 *   profile isolation leaves open; it is here because "no extension APIs are
 *   reachable" should not depend on "no extension happens to be present in
 *   this profile" remaining true forever as this code or its defaults
 *   change.
 * - `--disable-remote-fonts` — FR-P3 requires the report to be fully offline
 *   with inlined fonts already, so a remote `@font-face` should never appear;
 *   this makes that a hard rule Chromium enforces rather than an assumption
 *   about what `document.ts` currently emits, closing off `@font-face` as
 *   another network-request avenue on top of the DNS block above.
 *
 *   Follow-up, deliberately not done here: re-testing whether Chromium's
 *   sandbox can run at all under `--headless=new` on a current Chrome build
 *   (the captured experiment predates that mode, and headless-mode sandbox
 *   support has shifted across Chrome versions) is separate work from this
 *   fix. It needs its own experiment on this machine — the same way the
 *   original `--no-sandbox` requirement was established by running the
 *   command directly rather than by reasoning about it — and mixing that
 *   experiment into a security patch would risk shipping an unverified
 *   rendering regression alongside the isolation flags above, which are
 *   low-risk (network denial cannot itself break a `file://`, offline,
 *   font-inlined render) and independently justified regardless of what that
 *   follow-up finds.
 * - `--no-pdf-header-footer` — Chromium's default print header/footer stamps
 *   the page URL and a timestamp into the margins; for a `file:///...` input
 *   that URL is a local temp path, which has no business appearing in a
 *   deliverable document.
 * - `--run-all-compositor-stages-before-draw` — makes the print wait for
 *   layout/paint to actually finish rather than racing the compositor, so a
 *   themed stylesheet is fully applied before the page is captured.
 * - `--virtual-time-budget` — see {@link VIRTUAL_TIME_BUDGET_MS}.
 * - `--user-data-dir` — requirement 3: a fresh temp profile per invocation.
 *   Headless Chrome sharing a profile with the user's own running Chrome
 *   (very likely open, on this machine or any real user's) can fail to start
 *   at all (profile lock) or silently pick up the running instance's
 *   extensions/settings; a unique directory avoids both.
 *
 * Cleanup and verification (requirements 2 and 4): the temp working
 * directory (profile + any written HTML) is always removed in a `finally`,
 * whether the render succeeded, failed, or timed out; and the output file is
 * never trusted merely because the process exited 0 — see
 * {@link verifyPdfOutput}.
 */
export async function renderPdf(
  source: PdfSource,
  outputPath: string,
  options: RenderPdfOptions = {},
): Promise<RenderPdfResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const resolveBrowser = options.deps?.resolveBrowser ?? (() => resolveChromiumCached({ env, platform }));
  const spawnProcess = options.deps?.spawn ?? spawnClaude;

  const browser = await resolveBrowser();
  if (browser === undefined) {
    throw new PdfRenderError(notFoundReason(env));
  }

  // Requirement 1: `--print-to-pdf` needs an absolute path or it fails with a
  // misleading "Access is denied." `path.resolve` is relative to `cwd()`,
  // which is why the browser's own `cwd` below is pinned to `workDir` rather
  // than left ambient — the resolved output path must not depend on where
  // the calling process happened to be started from.
  const absOutputPath = path.resolve(outputPath);

  const workDir = await mkdtemp(path.join(tmpdir(), 'agent-office-pdf-'));
  const profileDir = path.join(workDir, 'profile');
  await mkdir(profileDir, { recursive: true });

  // `--print-to-pdf` does not create its target directory — Chromium (and
  // the fake stand-in browser the test suite drives it with) both fail
  // silently, writing nothing, if it does not already exist. Callers should
  // not have to pre-create the output directory themselves.
  await mkdir(path.dirname(absOutputPath), { recursive: true });

  try {
    const inputPath = await resolveInputPath(source, workDir);
    const inputUrl = toFileUrl(inputPath);

    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      // AO-7 network isolation — see the doc comment above for the full
      // justification. These do not restore the OS sandbox `--no-sandbox`
      // trades away; they remove the network as a destination reachable
      // from the page these flags render, which never legitimately needs it.
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--disable-extensions',
      '--disable-remote-fonts',
      '--no-pdf-header-footer',
      '--run-all-compositor-stages-before-draw',
      `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
      `--user-data-dir=${profileDir}`,
      `--print-to-pdf=${absOutputPath}`,
      inputUrl.toString(),
    ];

    const { child, exit, stderr } = spawnProcess({
      binary: browser.path,
      args,
      cwd: workDir,
      stdin: '',
    });

    const outcome = await raceExit(child, exit, timeoutMs);

    if (outcome.kind === 'timeout') {
      throw new PdfRenderError(
        `Headless ${path.basename(browser.path)} did not finish printing "${absOutputPath}" within ` +
          `${timeoutMs}ms and was killed. It may be wedged; try running the same print-to-pdf command manually.`,
      );
    }
    if (outcome.kind === 'spawn-error') {
      throw new PdfRenderError(`Could not start ${browser.path}: ${outcome.message}.`);
    }
    if (outcome.code !== 0) {
      const stderrText = await stderr;
      throw new PdfRenderError(
        `Headless ${path.basename(browser.path)} exited with code ${outcome.code ?? 'null'} while printing ` +
          `"${absOutputPath}".${stderrText.trim() !== '' ? ` stderr: ${stderrText.trim()}` : ''}`,
      );
    }

    return await verifyPdfOutput(absOutputPath);
  } finally {
    // Requirement 2/3: always remove the temp profile (and any in-memory HTML
    // this call wrote), success or failure — a hostile or crashed render must
    // not leave a growing pile of Chrome profiles behind.
    //
    // `killTree` (used on the timeout path above) is deliberately
    // fire-and-forget — see its own doc comment — so a killed browser's
    // process teardown can still be in flight, briefly holding `workDir` (its
    // own cwd, or the profile directory inside it) busy on Windows. `rm`'s
    // built-in retry turns that transient `EBUSY`/`EPERM` into a short wait
    // instead of a spurious failure, rather than trying to synchronise with
    // an intentionally-not-awaited kill.
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
