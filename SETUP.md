# Agent Office — Setup

Prerequisites and getting started. Read this before `PLAN.md`'s Phase 0.

**Current status: Node and the Claude Code CLI are both present and signed in.**
Phase 1's exit criterion has since been closed against that signed-in CLI — real
spawn, real argv, real stream-json, a real report — and every phase through 11 is
verified on this machine. The one prerequisite still unmet is an **API key**: no
run has ever gone through the Anthropic, OpenAI or DeepSeek adapters, which is what
leaves Phase 7 built-but-unverified.

Two earlier revisions of this line were wrong in opposite directions — one said Node
was missing after it had been installed, this one said the CLI was unsigned after it
had been signed in. A status line at the top of a setup document is the single most
re-read sentence in it, and the least likely to be re-derived.

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
shim anywhere that resolves the bare name — not in `WindowsApps`, not in the
npm global directory, nowhere.

That path also only exists inside the MSIX package container; see §3 below
before concluding the file is missing.

Note the version number too. It changes on every update, so **Phase 1 must not
hardcode it.** Resolution happens at run time instead, in this order:

1. `AGENT_OFFICE_CLAUDE_BIN`, if set
2. `claude` on `PATH`
3. the newest versioned directory under `%APPDATA%\Claude\claude-code`
4. the newest under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code`

A provider that dies because the user updated Claude Code is not acceptable, and
neither is one that only works when launched from inside the desktop app.

## 3. Claude Code CLI — signing in

```
claude auth status
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty" }
```

That is what you want. Until it says so, the binary runs but every model call
fails: a `-p` invocation returns a fabricated assistant turn reading
`Not logged in · Please run /login`, then a `result` frame with
`is_error: true`, and exits **1**. The `claude-code` provider's preflight
catches this and reports itself unavailable with that reason rather than
spawning a run that cannot work.

**It does not catch an EXPIRED sign-in, and this paragraph used to imply it
did.** A session whose token has expired still reports `loggedIn: true` — the
command prints `loggedIn`, `authMethod`, `apiProvider`, `email`, `orgId`,
`orgName` and `subscriptionType`, and no expiry field of any kind, so there is
nothing for the preflight to test. A run therefore starts normally and dies at
its first model call with `401 OAuth access token has expired`. Observed, not
theorised: it happened between two runs on this machine.

The adapter recognises that failure and appends the remedy to it, so the run's
error, the diagnostics log and the UI all say `run claude auth login`. Sign in
again the same way you did the first time; nothing else is needed.

Sign in from a normal interactive terminal:

```bash
claude auth login
```

That is deliberately not something this project does for you — it is an account
credential flow, and it belongs to whoever owns the account.

### If `claude` is not a recognised command

It very likely is not, and the reason is not obvious.

Claude Desktop on Windows is an **MSIX-packaged app**. Its `%APPDATA%` is
virtualised, so `%APPDATA%\Claude\claude-code\<version>\claude.exe` resolves
only for a process running *inside* the package container. A shell spawned by
the desktop app finds it there; an ordinary PowerShell window reports the exact
same path as `CommandNotFoundException`. Nothing is broken — they are two views
of one file, and the un-virtualised one is what a normal terminal needs:

```powershell
& "$env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\<version>\claude.exe" auth login
```

The `Claude_*` suffix is a per-install publisher hash, and `<version>` changes
on every update — which is why `resolveBinary.ts` globs the first and sorts the
second numerically rather than hardcoding either. It searches the virtualised
path first and the package path second, so the provider resolves the CLI whether
the server was started from inside the container or from your own terminal.

Adding the versioned directory to your `PATH` works for typing convenience but
goes stale on the next CLI update. `AGENT_OFFICE_CLAUDE_BIN` overrides
resolution outright if you need to pin a specific binary.

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
| `--mcp-config <path>` | Registers MCP servers from a file. An MCP tool's *availability* comes from here; only its *permission* comes from `--allowedTools`. |
| `--strict-mcp-config` | Suppresses the ambient configuration. **Always passed with `--mcp-config`** — without it the CLI also loads `~/.claude.json` and any project `.mcp.json`, so a delegated agent would silently inherit every server you happen to have enabled. |
| `--tools` | **Built-ins only** — its own `--help` says "from the built-in set", so an `mcp__*` name here is wrong rather than redundant, and produces a CLI-side failure far from its cause. |
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

Check which of `PLAN.md`'s numbered requirements are mentioned anywhere in the
test tree — a mention is evidence of intent, not proof of coverage:

```bash
npm run traceability
```

Run a task end to end at no cost:

```bash
npm run run -- "Review our vendor NDA for unusual terms" --provider scripted
```

### Running the server, and the token it prints

```bash
npm run serve
```

It binds to `127.0.0.1` only and prints a token with the URL to open:

```
url:      http://127.0.0.1:5179/?token=<48 hex characters>
token:    generated for this process only
```

Every `/api` request and the WebSocket upgrade require it — `x-agent-office-token`
as a header, or `?token=` for the first navigation, which is the only request that
has no JavaScript in the loop yet to set a header. Open the printed URL and the
handshake is done: the client reads the token once and switches to the header.

`npm run web` (the Vite dev server) needs nothing pasted in. `npm run serve` writes
the token to a file under the system temp directory with mode `0600`, and the Vite
proxy attaches it to everything it forwards. That is a development convenience, and
it means **anything that can reach the Vite port has the same access the token
grants** — which is fine on a single-user machine and would not be anywhere else.

If the token file cannot be written, the server says so and `npm run web` needs the
token supplied by hand.

Set `AGENT_OFFICE_TOKEN` to pin a value for CI or a script that cannot read stdout.
Not for daily use: a token chosen once outlives the process it protects, and a fixed
value in a file is exactly as reachable by another local account as no token at all.

### Granting capabilities

Both are environment variables and neither can be set through the API, because
loopback is not a user boundary — see `.env.example` for the full notes:

```bash
AGENT_OFFICE_ALLOW_SHELL=1 npm run serve          # agents may run shell commands
AGENT_OFFICE_MCP_CONFIG=./mcp-servers.json npm run serve   # register MCP servers
```

The MCP file is the Claude Code format exactly, so one file serves both:

```json
{ "mcpServers": { "investing": { "command": "python", "args": ["-m", "app.mcp.server"] } } }
```

### Phase 0 exit criterion — met

`npm run registry:dump` prints all **156** agents with their category and tool
list, and **fails loudly** — with file path and line — on any malformed
frontmatter, rather than silently dropping the offending agent.

Verified: it prints 156 across 10 categories.

Note the count: `categories/**/*.md` matches 166 files, but 10 of those are
category `README.md` files. The parser skips them. 156 is the number the dump
must print; anything else means the skip rule or the glob is wrong.

The catalog was 154 as vendored. Phase 6 authored `tax-advisor` and
`tax-compliance-specialist` into `07-specialized-domains`, because the catalog
had no tax specialist of any kind — see `PROGRESS.md`.
