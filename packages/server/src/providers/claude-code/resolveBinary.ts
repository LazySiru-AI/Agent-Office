import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProviderAvailability } from '../types.js';
import { killTree } from './childProcess.js';
import { resolveSpawnTarget } from './windowsSpawn.js';

/**
 * CLI discovery and the availability preflight for the Claude Code provider.
 *
 * The install directory is versioned
 * (`%APPDATA%\Claude\claude-code\2.1.222\claude.exe`) and there is no shim on
 * `PATH` on this machine. Hardcoding the version means the provider breaks on
 * the next Claude Code update — recorded as a carried-forward risk in
 * PROGRESS.md ("Phase 1 must resolve the `claude` binary at run time") and as
 * the suggested resolution order in SETUP.md. This file is that resolution,
 * generalised beyond Windows so a POSIX install is not a second implementation.
 *
 * Two Windows roots, not one. Claude Desktop is MSIX-packaged, so the
 * `%APPDATA%` path above is virtualised and resolves only inside the package
 * container; the same file is reachable from anywhere under
 * `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\...`. Searching only the
 * first meant the server worked when launched from the desktop app and reported
 * "not installed" when launched from a terminal. See `knownInstallRoots`.
 */

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export type ResolvedBinarySource = 'env-override' | 'path' | 'install-root';

export interface ResolvedBinary {
  /** Absolute (or as-given) path to the resolved `claude` executable. */
  path: string;
  source: ResolvedBinarySource;
  /** Only set for `install-root` hits, where the version lives in the directory name. */
  version?: string;
}

export interface ResolveBinaryOptions {
  /** Defaults to `process.env`. Overridable so tests never touch the real environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. Overridable so both OS branches are testable from one machine. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. Overridable for the same reason. */
  homedir?: string;
}

/** Env var name for the explicit override. Always wins — see {@link resolveClaudeBinary}. */
export const CLAUDE_BIN_ENV_VAR = 'AGENT_OFFICE_CLAUDE_BIN';

/** Directory names that look like a Claude Code version, e.g. `2.1.222`. */
const VERSION_DIR_RE = /^\d+(?:\.\d+)*$/;

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Numeric, dot-separated version compare — NOT a string sort.
 *
 * A plain string sort gets `2.1.222` vs `2.1.99` backwards: `'9' > '2'` at the
 * third character, so `"2.1.99"` sorts after `"2.1.222"` lexicographically even
 * though 222 is the newer release. Missing components compare as 0, so `2.1`
 * and `2.1.0` are equal.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Highest version first. Non-numeric-looking directory names are excluded by the caller. */
function sortVersionsDescending(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}

async function listVersionDirsDescending(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // Root does not exist, or is not a directory we can list — not an install here.
    return [];
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && VERSION_DIR_RE.test(entry.name))
    .map((entry) => entry.name);
  return sortVersionsDescending(versions);
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * `process.env.PATH` is spelled inconsistently by casing depending on where it
 * came from (Windows itself is case-insensitive about it; a plain test fixture
 * object is not). Checked in this order so a test object using any casing works.
 */
function readPathVar(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

async function findOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const raw = readPathVar(env);
  if (raw === '') return undefined;

  // Windows resolves a bare command through PATHEXT; `claude` may be shimmed as
  // any of these. POSIX only ever has the bare name.
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];

  for (const dir of raw.split(pathDelimiter(platform))) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

interface InstallRoot {
  /** Directory to search. */
  dir: string;
  /** Executable file name inside it (or inside a version subdirectory). */
  binaryName: string;
  /** True if `dir` holds version-numbered subdirectories to pick the newest from. */
  versioned: boolean;
}

/**
 * Known install locations, in the order they are tried. Windows and POSIX get
 * different lists because the installer lays them out differently, but the
 * shape of the search (versioned root, then flat fallbacks) is the same so
 * this stays one code path rather than a platform fork.
 */
function knownInstallRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): InstallRoot[] {
  if (platform === 'win32') {
    const roots: InstallRoot[] = [];

    const appData = env.APPDATA;
    if (appData !== undefined && appData !== '') {
      roots.push({ dir: path.join(appData, 'Claude', 'claude-code'), binaryName: 'claude.exe', versioned: true });
    }

    // The same install, reached without the MSIX virtualisation layer.
    //
    // Claude Desktop is a packaged (MSIX) app, so the `%APPDATA%\Claude` path
    // above is virtualised: it resolves for a process running *inside* the
    // package container and does not exist outside it. Observed on this
    // machine — a shell spawned by the desktop app resolves the binary there,
    // while an ordinary PowerShell window reports the identical path as
    // not found. Both are views of one file, whose real location is
    // `%LOCALAPPDATA%\Packages\Claude_<publisher>\LocalCache\Roaming\...`.
    //
    // Without this fallback, running the server from a normal terminal fails
    // discovery entirely and the provider reports "not installed" — a wrong
    // and far more confusing diagnosis than the truth, which may simply be
    // that the CLI is not signed in.
    const localAppData = env.LOCALAPPDATA;
    if (localAppData !== undefined && localAppData !== '') {
      roots.push({
        // The publisher hash varies per install, so it is globbed rather than
        // hardcoded — see `expandPackageFamilyGlob`.
        dir: path.join(localAppData, 'Packages', 'Claude_*', 'LocalCache', 'Roaming', 'Claude', 'claude-code'),
        binaryName: 'claude.exe',
        versioned: true,
      });
    }

    return roots;
  }

  return [
    // The macOS/Linux analogue of the Windows layout above.
    { dir: path.join(homedir, '.claude', 'claude-code'), binaryName: 'claude', versioned: true },
    // Where `npm install -g` and common manual installs put a bare binary.
    { dir: '/usr/local/bin', binaryName: 'claude', versioned: false },
    { dir: path.join(homedir, '.npm-global', 'bin'), binaryName: 'claude', versioned: false },
  ];
}

/**
 * Expand a single `*` path segment against the filesystem.
 *
 * Only needed for the MSIX package root, whose directory name carries a
 * per-install publisher hash (`Claude_pzs8sxrjxfjjc`). A full glob library is
 * not warranted for one wildcard in one segment, so this handles exactly that:
 * one starred segment, matched by prefix and suffix.
 *
 * Returns the input unchanged when there is no wildcard, so every other root
 * takes the same code path. Matches are sorted for determinism — two package
 * versions installed side by side must not resolve differently run to run.
 */
async function expandPackageFamilyGlob(dir: string): Promise<string[]> {
  const segments = dir.split(path.sep);
  const starIndex = segments.findIndex((segment) => segment.includes('*'));
  if (starIndex === -1) return [dir];

  const parent = segments.slice(0, starIndex).join(path.sep);
  const pattern = segments[starIndex] ?? '';
  const rest = segments.slice(starIndex + 1);

  const [prefix = '', suffix = ''] = pattern.split('*');

  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.length >= prefix.length + suffix.length &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith(suffix),
    )
    .map((entry) => entry.name)
    .sort()
    .map((name) => [parent, name, ...rest].join(path.sep));
}

async function findInInstallRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): Promise<ResolvedBinary | undefined> {
  for (const unexpanded of knownInstallRoots(platform, env, homedir)) {
    for (const dir of await expandPackageFamilyGlob(unexpanded.dir)) {
      const root: InstallRoot = { ...unexpanded, dir };

      if (root.versioned) {
        const versions = await listVersionDirsDescending(root.dir);
        for (const version of versions) {
          const candidate = path.join(root.dir, version, root.binaryName);
          // Skip a version directory that exists but does not actually contain the
          // binary (partial install, or a stray directory) rather than stopping —
          // the next-highest version may still be a real install.
          if (await fileExists(candidate)) {
            return { path: candidate, source: 'install-root', version };
          }
        }
      } else {
        const candidate = path.join(root.dir, root.binaryName);
        if (await fileExists(candidate)) {
          return { path: candidate, source: 'install-root' };
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve the `claude` binary, in precedence order:
 *
 * 1. `AGENT_OFFICE_CLAUDE_BIN` — an explicit override always wins. Needed for
 *    testing, and for installs in a location this file does not know about.
 *    If set but the path it names does not exist, resolution falls through to
 *    steps 2–3 rather than silently reporting "not found" for a typo'd override
 *    that a healthy PATH install could still cover — but see `isAvailable`,
 *    which surfaces the broken override in its reason regardless of what
 *    resolves after it, so the typo is not silently masked either.
 * 2. `claude` on `PATH` — the normal case on a healthy install.
 * 3. Known install roots, picking the highest version directory when several
 *    exist (see {@link compareVersions}).
 *
 * Every candidate is checked for existence on disk before being returned, so
 * this function is a pure filesystem query — no process is spawned, and it is
 * fully exercisable against a temp-directory fixture tree in tests.
 */
export async function resolveClaudeBinary(
  options: ResolveBinaryOptions = {},
): Promise<ResolvedBinary | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();

  const override = env[CLAUDE_BIN_ENV_VAR];
  if (override !== undefined && override !== '' && (await fileExists(override))) {
    return { path: override, source: 'env-override' };
  }

  const onPath = await findOnPath(env, platform);
  if (onPath !== undefined) {
    return { path: onPath, source: 'path' };
  }

  return findInInstallRoots(platform, env, homedir);
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * Resolution does real filesystem work — a PATH walk plus, on a miss, a
 * directory listing and multiple `stat` calls per install root. `isAvailable`
 * is preflighted before every run, potentially many runs per process, so
 * re-walking the filesystem each time is pure waste once the answer is known.
 * The result is cached for the process lifetime.
 *
 * Cached by the "no options" call shape only — i.e. this is meant for
 * production use, where `resolveClaudeBinary` is always called with the real
 * environment. Tests that need different `options` per call should call
 * {@link resolveClaudeBinary} directly (uncached) and use
 * {@link resetResolveBinaryCache} if they exercise the cached path itself.
 */
let cached: { value: ResolvedBinary | undefined } | undefined;

export async function resolveClaudeBinaryCached(
  options: ResolveBinaryOptions = {},
): Promise<ResolvedBinary | undefined> {
  if (cached === undefined) {
    cached = { value: await resolveClaudeBinary(options) };
  }
  return cached.value;
}

/** Test-only escape hatch — clears the cache populated by {@link resolveClaudeBinaryCached}. */
export function resetResolveBinaryCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Availability preflight
// ---------------------------------------------------------------------------

/**
 * The timeout for `claude auth status`.
 *
 * This is a preflight, run before every assignment dispatch — NFR-8 requires
 * a missing or broken provider to degrade gracefully rather than hang the
 * server, so it must never wait indefinitely on a wedged or slow-starting
 * child process. 5 seconds is generous enough to absorb a cold Node/CLI start
 * (which can take a second or two) plus, per the CLI's own doc comments in
 * `protocol.ts`, a possible auth-token validation round trip — but short
 * enough that a preflight hang is never mistaken for the server itself being
 * unresponsive.
 */
export const AUTH_STATUS_TIMEOUT_MS = 5_000;

/** What `claude auth status` prints today (see the task's captured ground truth). */
interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

export interface RunAuthStatusResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the child process could not be spawned at all (e.g. `ENOENT`). */
  spawnError?: string;
}

/** Injectable so tests never shell out to a real binary. */
export type AuthStatusRunner = (binaryPath: string, timeoutMs: number) => Promise<RunAuthStatusResult>;

/**
 * The real runner. Spawns `claude auth status` and enforces the timeout itself
 * — `spawn` has no built-in one — by killing the child and resolving (never
 * rejecting) so a slow CLI degrades the preflight instead of hanging it.
 *
 * NFR-4: nothing from `stdout` is logged here or anywhere it is consumed below;
 * it is parsed for the three known fields and otherwise discarded.
 */
async function runAuthStatusViaSpawn(binaryPath: string, timeoutMs: number): Promise<RunAuthStatusResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';

    // A `.cmd`/`.bat` shim needs the `cmd.exe` detour (see `windowsSpawn.ts`);
    // anything else is spawned as-is.
    const target = resolveSpawnTarget(binaryPath, ['auth', 'status']);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(target.command, target.args, {
        windowsHide: true,
        ...(target.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: target.windowsVerbatimArguments }),
      });
    } catch (error) {
      // `spawn` can throw *synchronously* rather than emitting `error` — a
      // Windows batch shim does exactly that, and `resolveSpawnTarget` refuses
      // an unquotable argument the same way. Inside a promise executor an
      // uncaught throw becomes a rejection, which would break the "Never
      // throws" contract `checkClaudeCodeAvailability` documents and surface to
      // the user as an HTTP 500 instead of a 503 naming the real problem.
      resolve({
        stdout: '',
        exitCode: null,
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // `killTree`, not `child.kill()`. On the Windows batch path `child` is the
      // `cmd.exe` wrapper, and killing it would leave the CLI it launched
      // running with our pipes held open — a wedged preflight would then orphan
      // a process on every attempt. `taskkill /T` walks the tree instead.
      killTree(child);
      resolve({ stdout, exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, exitCode: null, timedOut: false, spawnError: error.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, exitCode: code, timedOut: false });
    });
  });
}

/**
 * Parse `claude auth status` output defensively.
 *
 * It is JSON today, but a preflight that throws on a future CLI's changed
 * output is worse than one that returns a degraded "can't tell" reason — a
 * thrown error here would take down the whole `isAvailable` call (NFR-8).
 * Fields are individually type-checked rather than trusted from a blind cast,
 * so a shape change that keeps `loggedIn` a boolean still works even if other
 * fields move or disappear.
 */
function parseAuthStatus(stdout: string): AuthStatus | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  return {
    ...(typeof obj.loggedIn === 'boolean' ? { loggedIn: obj.loggedIn } : {}),
    ...(typeof obj.authMethod === 'string' ? { authMethod: obj.authMethod } : {}),
    ...(typeof obj.apiProvider === 'string' ? { apiProvider: obj.apiProvider } : {}),
  };
}

function notFoundReason(env: NodeJS.ProcessEnv): string {
  const override = env[CLAUDE_BIN_ENV_VAR];
  const overrideNote =
    override !== undefined && override !== ''
      ? ` ${CLAUDE_BIN_ENV_VAR} is set to "${override}", but no executable was found there.`
      : '';
  return (
    `Claude Code CLI was not found on PATH or in any known install location.${overrideNote} ` +
    `Install Claude Code and ensure "claude" is reachable, or set ${CLAUDE_BIN_ENV_VAR} to the ` +
    'full path of the claude executable. See SETUP.md.'
  );
}

function notAuthenticatedReason(binaryPath: string): string {
  return (
    `Claude Code CLI is installed (${binaryPath}) but not authenticated. ` +
    'Run "claude auth login" to sign in, then retry.'
  );
}

function unknownStatusReason(binaryPath: string): string {
  return (
    `Claude Code CLI is installed (${binaryPath}), but its authentication status could not ` +
    'be determined. Run "claude auth status" manually to check, or "claude auth login" to sign in.'
  );
}

function timeoutReason(binaryPath: string, timeoutMs: number): string {
  return (
    `Claude Code CLI at ${binaryPath} did not respond to "claude auth status" within ` +
    `${timeoutMs}ms. It may be wedged; try running "claude auth status" manually.`
  );
}

function spawnErrorReason(binaryPath: string, spawnError: string): string {
  return `Claude Code CLI at ${binaryPath} could not be run (${spawnError}). Check the resolved path is correct.`;
}

export interface CheckAvailabilityOptions extends ResolveBinaryOptions {
  /** Overrides the real spawn-based probe. Tests must always supply this. */
  runAuthStatus?: AuthStatusRunner;
  timeoutMs?: number;
  /**
   * Whether to use {@link resolveClaudeBinaryCached} (the default, for
   * production) or a fresh {@link resolveClaudeBinary} call every time (for
   * tests that vary `env`/`platform`/`homedir` per call).
   */
  useCache?: boolean;
}

/**
 * Availability preflight (NFR-8: a missing or misconfigured provider must
 * surface as a clear message rather than a mid-run failure).
 *
 * Distinguishes three outcomes with different, actionable reasons:
 * - binary not found at all
 * - binary found but `claude auth status` reports `loggedIn: false`
 * - binary found and authenticated (`ok: true`)
 *
 * Never throws: resolution is pure filesystem lookups, the auth probe never
 * rejects (see {@link runAuthStatusViaSpawn}), and output parsing is
 * exception-safe (see {@link parseAuthStatus}).
 */
export async function checkClaudeCodeAvailability(
  options: CheckAvailabilityOptions = {},
): Promise<ProviderAvailability> {
  const env = options.env ?? process.env;
  const useCache = options.useCache ?? true;
  const timeoutMs = options.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS;
  const runAuthStatus = options.runAuthStatus ?? runAuthStatusViaSpawn;

  const resolved = useCache ? await resolveClaudeBinaryCached(options) : await resolveClaudeBinary(options);

  if (resolved === undefined) {
    return { ok: false, reason: notFoundReason(env) };
  }

  const result = await runAuthStatus(resolved.path, timeoutMs);

  if (result.timedOut) {
    return { ok: false, reason: timeoutReason(resolved.path, timeoutMs) };
  }

  if (result.spawnError !== undefined) {
    return { ok: false, reason: spawnErrorReason(resolved.path, result.spawnError) };
  }

  const status = parseAuthStatus(result.stdout);
  if (status === undefined || status.loggedIn === undefined) {
    return { ok: false, reason: unknownStatusReason(resolved.path) };
  }

  if (!status.loggedIn) {
    return { ok: false, reason: notAuthenticatedReason(resolved.path) };
  }

  return { ok: true };
}
