import path from 'node:path';
import { UnsafePathError } from './types.js';

/** A Windows drive-letter prefix, e.g. `C:`. */
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * True if `value` contains a C0 control character or DEL.
 *
 * Written as a numeric scan rather than a regex character class on purpose: the
 * equivalent class requires either literal control bytes in the source (which
 * makes this file binary to git and grep) or escape sequences that are easy to
 * mangle. Comparing char codes avoids both.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Reject any run-relative path that would escape its run directory.
 *
 * The paths this guards originate in the Manager's `deliverable` field, which is
 * LLM-generated and therefore untrusted. A plan asking to write
 * `../../../.ssh/authorized_keys` must fail loudly rather than land (NFR-1).
 *
 * @returns the normalised relative path, using forward slashes.
 */
export function assertSafeRelativePath(relativePath: string): string {
  if (relativePath.trim() === '') {
    throw new UnsafePathError(relativePath);
  }
  if (path.isAbsolute(relativePath) || DRIVE_LETTER.test(relativePath)) {
    throw new UnsafePathError(relativePath);
  }
  // A NUL byte is a classic path-truncation trick; the rest are never valid here.
  if (hasControlChars(relativePath)) {
    throw new UnsafePathError(relativePath);
  }

  const normalised = path.normalize(relativePath).split(path.sep).join('/');
  if (normalised === '..' || normalised.startsWith('../') || normalised.includes('/../')) {
    throw new UnsafePathError(relativePath);
  }
  if (normalised.startsWith('/')) {
    throw new UnsafePathError(relativePath);
  }

  return normalised;
}

/** Resolve a run-relative path to an absolute one, verifying containment. */
export function resolveWithin(baseDir: string, relativePath: string): string {
  const safe = assertSafeRelativePath(relativePath);
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, safe);

  // Belt and braces: even after normalisation, confirm the result really is
  // inside the base directory rather than trusting the string checks alone.
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafePathError(relativePath);
  }

  return resolved;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Sortable, human-scannable run id: `YYYYMMDD-HHMMSS-xxxx`.
 *
 * Lexical order matches chronological order, which makes `listRuns` a directory
 * sort rather than a read-every-file-and-compare.
 */
export function newRunId(now: Date = new Date(), random: () => number = Math.random): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    const index = Math.floor(random() * ID_ALPHABET.length) % ID_ALPHABET.length;
    suffix += ID_ALPHABET[index] ?? '0';
  }

  return `${stamp}-${suffix}`;
}

/** A run id we are willing to turn into a directory name. */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertValidRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new UnsafePathError(runId);
  }
  return runId;
}
