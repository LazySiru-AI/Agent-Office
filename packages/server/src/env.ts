import fs from 'node:fs';
import path from 'node:path';

/**
 * Load `.env` from the repository root, once, at process start.
 *
 * Keys have to come from somewhere, and the alternatives are worse: setting
 * them in a shell means they vanish with the terminal, and putting them in the
 * settings UI would mean shipping a credential to the browser and storing it
 * there (see the note in `SettingsPanel.tsx` on why that was refused). A
 * gitignored file next to the code is the ordinary answer, and `.gitignore`
 * already excludes `.env` and `.env.*` while permitting `.env.example`.
 *
 * Two rules this deliberately follows:
 *
 * - **A real environment variable always wins.** Someone who exported a key for
 *   one command should not be silently overridden by a stale file. This mirrors
 *   how every other dotenv loader behaves, and getting it backwards produces
 *   the worst kind of bug — the one where the value you can see is not the
 *   value being used.
 * - **A missing file is not an error.** Most runs use the scripted provider or
 *   the signed-in CLI and need no keys at all.
 *
 * No dependency: Node has had `process.loadEnvFile` since 20.12, and this
 * project is on 24. The hand-rolled fallback exists only for the case where
 * that is unavailable, and covers the subset of the format worth supporting —
 * `KEY=value`, comments, blank lines, optional quotes. Anything more elaborate
 * belongs in a real parser, and needing one would be a sign this file is doing
 * too much.
 */

/** Set once loaded, so repeated entrypoint calls in one process are cheap. */
let loaded = false;

export interface LoadEnvResult {
  /** Absolute path that was read, or `undefined` when no file was found. */
  path?: string;
  /** Names of variables the file set. Never their values. */
  applied: string[];
}

export function loadDotEnv(repoRoot: string): LoadEnvResult {
  if (loaded) return { applied: [] };
  loaded = true;

  const file = path.join(repoRoot, '.env');
  if (!fs.existsSync(file)) return { applied: [] };

  const before = new Set(Object.keys(process.env));

  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (typeof process.loadEnvFile !== 'function') {
      applyManually(file);
    } else {
      // A malformed file is worth complaining about rather than ignoring: the
      // symptom otherwise is "my key is not being read" with nothing to go on.
      throw new Error(
        `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Names only. A log line listing values would put the key in the terminal
  // scrollback, which is the one place people paste from without thinking.
  const applied = Object.keys(process.env).filter((key) => !before.has(key));
  return { path: file, applied };
}

function applyManually(file: string): void {
  const text = fs.readFileSync(file, 'utf8');

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    // `export KEY=value` is common in `.env` files copied from a shell
    // profile, and `process.loadEnvFile` (the primary path above, live on
    // Node 20.12+) handles it correctly. This fallback only runs on Node
    // versions between the package's declared minimum (20.0.0) and 20.12, so
    // without stripping `export ` here the fallback silently diverges from
    // the primary path: it would set a variable literally named
    // `export ANTHROPIC_API_KEY` instead of `ANTHROPIC_API_KEY`, and the key
    // the user can plainly see in the file reads as "not set".
    const rawKey = line.slice(0, eq).trim();
    const key = rawKey.replace(/^export\s+/, '');
    if (key === '') continue;
    let value = line.slice(eq + 1).trim();

    // Quotes are stripped only as a matched pair, so a value that genuinely
    // starts with a quote is not silently truncated.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    // The real environment wins. See the note above.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Reset for tests, which need to load more than one fixture per process. */
export function resetDotEnvForTests(): void {
  loaded = false;
}
