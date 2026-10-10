/**
 * Spawning a Windows batch shim safely.
 *
 * `spawn('claude.cmd', args)` does not work. Node ≥ 20.12.2 refuses to execute a
 * `.cmd`/`.bat` directly and **throws synchronously** — `EFTYPE` on Node 24,
 * reproduced on the maintainer's Windows 10 box. This is not a hypothetical: the
 * npm global install of the Claude Code CLI ships `%APPDATA%\npm\claude.cmd` and
 * no `.exe`, so PATH resolution finds the shim and every run dies before the
 * model is ever called. The native installer's `.exe` is why this went unnoticed
 * — `resolveBinary.ts` prefers `claude.exe` within a PATH directory, but on an
 * npm install there is no `.exe` to prefer.
 *
 * The refusal is itself a security fix (CVE-2024-27980): a batch file is not
 * executed by `CreateProcess` but interpreted by `cmd.exe`, whose parser mangles
 * the argument vector in ways that let an argument become a command. Node
 * declined to paper over that, so the caller has to opt in deliberately — which
 * is what this module does.
 *
 * ## Why not `shell: true`
 *
 * The obvious fix, and wrong. Node does not escape anything under `shell: true`:
 * it joins the command and arguments with spaces into one string and hands it to
 * `cmd.exe`. `buildArgs` puts `--model <model>` on that line, and the model name
 * reaches us from the run request and from the Manager's generated plan — i.e.
 * from a model's output. A value of `x & calc` would execute `calc`. `shell:
 * true` would convert a reliable crash into arbitrary command execution, and
 * would additionally break any install path containing a space.
 *
 * ## What this does instead
 *
 * Invokes `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments`, building
 * `<line>` ourselves so the quoting is ours rather than Node's:
 *
 * - `/d` skips the `AutoRun` registry key, so a value someone left in
 *   `HKCU\Software\Microsoft\Command Processor\AutoRun` does not run first.
 * - `/s` makes `cmd` strip exactly the outer pair of quotes and treat the rest
 *   verbatim, which is the only documented parse that survives a quoted path
 *   containing spaces.
 * - Every token is wrapped in double quotes. Inside quotes `cmd` does not treat
 *   `& | < > ^ ( )` as metacharacters, so quoting alone neutralises them.
 *
 * ## Why rejection rather than escaping
 *
 * Quoting gets an argument safely *into* `cmd.exe`, but it does not survive what
 * the batch file then does with it. A shim that expands `%~1` (the quote-
 * stripping form) has its result re-scanned by the interpreter, so a `&` inside
 * that argument becomes a command separator at the second parse — the
 * BatBadBut class of defect, CVE-2024-24576. This was not theory here: an
 * earlier draft of this module quoted correctly and a test in `windowsSpawn.
 * test.ts` still executed an injected `echo`.
 *
 * There is no escape that is correct for every shim, because the number of
 * re-parses depends on batch source we do not control. So the dangerous
 * characters are refused outright, with a message naming the offender. Nothing
 * this adapter legitimately passes contains one — `buildArgs` emits fixed
 * flags, a comma-joined list of built-in tool names (`tools.ts` resolves
 * against a closed allowlist of bare identifiers), a model name, a number, and
 * a workspace path — so this is a tripwire for a future caller rather than a
 * limitation anyone hits today. A refused spawn is a clear error; a
 * mis-escaped one is a silent command injection.
 */

/**
 * Characters refused outright, because neither quoting nor escaping makes them
 * reliably inert across a batch file's own re-parsing.
 *
 * - `&` `|` `<` `>` chain or redirect commands at any parse.
 * - `^` is the escape character, so it can smuggle any of the above through one.
 * - `%` and `!` expand to environment variables even inside double quotes.
 * - `"` would close our own quoting.
 * - CR/LF terminate the command line; anything after becomes a new command.
 * - NUL truncates it at the Win32 boundary.
 *
 * Parentheses are deliberately **not** here. They group commands but cannot
 * start one on their own, and with the chaining characters above already
 * refused the worst a stray paren causes is a syntax error. Refusing them would
 * break every install under `C:\Program Files (x86)`, which is a real path on
 * real machines — a fix that cannot run on an ordinary Windows box is not a fix.
 */
const CMD_UNSAFE_CHARS = /["%!^&|<>\r\n\0]/;

/** Batch shims that `CreateProcess` will not execute directly. */
const BATCH_EXTENSIONS = ['.cmd', '.bat'];

/** Raised when an argument cannot be represented safely on a `cmd.exe` line. */
export class UnsafeWindowsArgumentError extends Error {
  readonly argument: string;

  constructor(argument: string) {
    super(
      'refusing to build a cmd.exe command line containing an argument with an unescapable ' +
        'character (one of " % ! ^ & | < > CR LF NUL). A batch shim re-parses its own arguments, ' +
        'so this would be a command-injection risk rather than a quoting inconvenience, and the ' +
        `spawn is refused instead. Argument: ${JSON.stringify(argument)}`,
    );
    Object.setPrototypeOf(this, UnsafeWindowsArgumentError.prototype);
    this.name = 'UnsafeWindowsArgumentError';
    this.argument = argument;
  }
}

export function isBatchShim(binary: string): boolean {
  const lowered = binary.toLowerCase();
  return BATCH_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

/**
 * Wrap one token in double quotes for a `cmd.exe` command line.
 *
 * Backslashes are only special to `CommandLineToArgvW` when they immediately
 * precede a quote, where each pair collapses to one and an odd one escapes the
 * quote itself. Since embedded quotes are already rejected above, the single
 * remaining hazard is a token *ending* in backslashes — `"C:\dir\"` would escape
 * the closing quote and swallow the rest of the line — so the trailing run is
 * doubled. Interior backslashes are left exactly as they are, which is what a
 * Windows path needs.
 */
function quoteToken(token: string): string {
  if (CMD_UNSAFE_CHARS.test(token)) {
    throw new UnsafeWindowsArgumentError(token);
  }
  const trailingBackslashesDoubled = token.replace(/(\\+)$/, '$1$1');
  return `"${trailingBackslashesDoubled}"`;
}

export interface SpawnTarget {
  command: string;
  args: string[];
  /** Set only for the `cmd.exe` path, where the command line is pre-quoted. */
  windowsVerbatimArguments?: boolean;
}

/**
 * Decide what to actually hand to `spawn`.
 *
 * Everything that is not a Windows batch shim passes through untouched, so the
 * POSIX path and the native-`.exe` Windows path keep Node's normal, safer
 * argument handling. Only the `.cmd`/`.bat` case is rerouted through `cmd.exe`.
 *
 * `platform` and `comSpec` are injectable so the Windows branch is testable from
 * any host — otherwise this logic would only ever be exercised on a Windows
 * runner, which is exactly how the original defect survived a 1,301-test suite.
 */
export function resolveSpawnTarget(
  binary: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec,
): SpawnTarget {
  if (platform !== 'win32' || !isBatchShim(binary)) {
    return { command: binary, args: [...args] };
  }

  const line = [binary, ...args].map(quoteToken).join(' ');

  return {
    // `ComSpec` rather than a bare `cmd.exe`, so this does not depend on PATH
    // resolution finding the real interpreter.
    command: comSpec === undefined || comSpec === '' ? 'cmd.exe' : comSpec,
    // The outer quote pair is what `/s` strips; `line` is already quoted per
    // token inside it.
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
