# Agent Office — Setup

Prerequisites and getting started. Read this before `PLAN.md`'s Phase 0.

**Current status: Node and the Claude Code CLI are both present. The CLI is not
signed in**, which is the one outstanding prerequisite and the only thing
standing between Phase 1 and its exit criterion. Phases 0, 2 and 3 are verified
on this machine. An earlier revision of this file said Node was missing; that
was wrong by the time it was checked again — see below.

---

## 1. Node.js — installed

Node **v24.19.0** and npm **11.17.0** are installed at `C:\Program Files\nodejs`,
which is on the *machine* `PATH`. Node 20+ is required, so this satisfies it.

```bash
node --version
```

If that prints nothing in an existing terminal, the shell predates the install
and is holding a stale environment. **Open a new terminal** — `PATH` is only
read at shell startup. There is nothing to reinstall.

## 2. Claude Code CLI — installed, but not on `PATH`

The binary exists:

```
%APPDATA%\Claude\claude-code\2.1.222\claude.exe
```

It reports `2.1.222 (Claude Code)`. But it is **not** reachable as `claude` from
a shell: no directory under `%APPDATA%\Claude` is on `PATH`, and there is no
shim anywhere that resolves the bare name.

Note the version number in that path. It changes on every update, so **Phase 1
must not hardcode it.** Resolve the binary at run time instead — read an
override such as `AGENT_OFFICE_CLAUDE_BIN` first, then fall back to `claude` on
`PATH`, then to the newest versioned directory under `%APPDATA%\Claude\claude-code`.
A provider that dies because the user updated Claude Code is not acceptable.

## 3. Claude Code CLI — not authenticated (blocks the Phase 1 exit criterion)

```
claude auth status
{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty" }
```

The binary runs, but every model call fails. A `-p` invocation returns a
fabricated assistant turn reading `Not logged in · Please run /login`, then a
`result` frame with `is_error: true`, and exits **1**.

Fix it by signing in, in a normal interactive terminal:

```bash
claude auth login
```

That is deliberately not something this project does for you — it is an account
credential flow, and it belongs to whoever owns the account. Until it is done,
the `claude-code` provider reports itself unavailable with that reason, and the
Phase 1 exit criterion cannot be closed. Everything else in Phase 1 is built and
tested regardless; see `PROGRESS.md`.

---

## 4. Verified CLI surface (2.1.222)

Checked against the installed binary, not assumed. Re-check after a CLI update.

| Flag | Verified behaviour |
|---|---|
| `-p`, `--print` | Non-interactive. Required for everything below. |
| `--output-format stream-json` | NDJSON frames on stdout. |
| `--verbose` | **Mandatory** with `--print --output-format stream-json`. Without it the CLI exits 1: `--output-format=stream-json requires --verbose`, and emits no JSON at all. |
| `--system-prompt-file <path>` | Accepted. **Not listed in `--help`** — confirmed by elimination, since an unknown flag errors with `unknown option`. |
| `--append-system-prompt-file <path>` | Accepted, same caveat. |
| stdin | With `--print` and no positional prompt, the prompt is read from stdin. With stdin closed and no prompt it exits cleanly with a usage error — it does **not** hang. |
| `--allowedTools`, `--tools`, `--disallowedTools` | Variadic (`<tools...>`), so they greedily consume following argv entries. Comma-join into one token. |
| `--permission-mode` | `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. |
| `--max-budget-usd` | Hard spend cap per invocation. Maps directly onto FR-M8. |
| `--no-session-persistence` | Keeps headless runs out of the session store. |
| exit code | 1 on failure. |

Two traps worth naming, both of which cost real debugging time if hit later:

- **`is_error`, not `subtype`, says whether a run succeeded.** A genuinely failed
  run emits `{"is_error": true, ..., "subtype": "success"}` — both at once.
- **Errors arrive dressed as assistant turns.** The CLI fabricates an assistant
  message (`model: "<synthetic>"`) carrying the error text. An adapter that
  trusts `type: "assistant"` will write the error into the agent's report as if
  it were the agent's work.

The captured bytes behind all of this are in
`packages/server/src/providers/claude-code/fixtures/`, with provenance recorded
per file in that directory's `README.md`.

---

## Workflow

Install dependencies at the workspace root:

```bash
npm install
```

`npm install` prints an `allow-scripts` warning about esbuild's postinstall
under npm 11. It is not fatal — `tsx` and `vitest` both work without approving
it, as the verified runs below show.

Dump the agent registry:

```bash
npm run registry:dump
```

Run the tests:

```bash
npm test
```

Run a task end to end at no cost:

```bash
npm run run -- "Review our vendor NDA for unusual terms" --provider scripted
```

### Phase 0 exit criterion — met

`npm run registry:dump` prints all **154** agents with their category and tool
list, and **fails loudly** — with file path and line — on any malformed
frontmatter, rather than silently dropping the offending agent.

Verified: it prints 154 across 10 categories.

Note the count: `categories/**/*.md` matches 164 files, but 10 of those are
category `README.md` files. The parser skips them. 154 is the number the dump
must print; anything else means the skip rule or the glob is wrong.
