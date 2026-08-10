# Agent Office — Setup

Prerequisites and getting started. Read this before `PLAN.md`'s Phase 0.

**Current status: both prerequisites are present, and Phases 0 and 2 have been
run and verified on this machine.** The earlier revision of this file said Node
was missing; that was wrong by the time it was checked again — see below.

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

Once resolved, the first Phase 1 task is *not* writing the parser. It is
capturing a real session to a fixture file:

```bash
claude -p "say hello" --output-format stream-json --verbose > fixtures/stream-json-sample.jsonl
```

`--verbose` is included because print mode is believed to require it alongside
`stream-json` — **still unverified**; nobody has run this yet. If it errors,
drop it and check `claude -p --help` for the current spelling.

Build the stream parser against that captured fixture. Do not build it against
assumed flag names or an assumed event shape — flags and event schemas vary by
installed version, and this remains the plan's largest single unknown.

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
