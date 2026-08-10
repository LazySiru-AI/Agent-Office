# Agent Office — Setup

Prerequisites and getting started. Read this before `PLAN.md`'s Phase 0.

**Current status: nothing in this project has been run.** Two prerequisites are
missing on this machine, both verified today.

---

## 1. Node.js — not installed

Node is **not** present. It is not on `PATH`, and there is no install under
`%ProgramFiles%\nodejs`, `%LOCALAPPDATA%\Programs\nodejs`, or any nvm directory.
The only runtime on this machine is Python.

Node 20+ is required. Everything depends on it — the Fastify server, the Vite
frontend, the registry parser, the test runner, the whole toolchain. There is no
partial path forward without it.

Install the current LTS from <https://nodejs.org>, or:

```bash
winget install OpenJS.NodeJS.LTS
```

Then **restart your terminal** — `PATH` is only picked up by new shells.

Verify:

```bash
node --version
```

## 2. Claude Code CLI — not on PATH

The Claude Code desktop app is installed, but the headless `claude` binary is not
reachable from a shell. `PLAN.md`'s Phase 1 provider adapter shells out to that
binary, so **Phase 1 is blocked until this is fixed.**

Verify whether it is reachable:

```bash
claude --version
```

Once it is available, the first Phase 1 task is *not* writing the parser. It is
capturing a real session to a fixture file:

```bash
claude -p "say hello" --output-format stream-json --verbose > fixtures/stream-json-sample.jsonl
```

`--verbose` is included because print mode is believed to require it alongside
`stream-json` — unverified, since the CLI is not installed. If it errors, drop it
and check `claude -p --help` for the current spelling.

Build the stream parser against that captured fixture. Do not build it against
assumed flag names or an assumed event shape — flags and event schemas vary by
installed version, and this is the plan's largest single unknown.

---

## Consequence

Phase 0 code can be written, but it **cannot be executed or verified** until Node
is installed. Treat any Phase 0 work completed before then as unreviewed — the
tests have not run, the registry dump has not run, and nothing has been proven
against the real files.

---

## Intended workflow (once Node exists)

Install dependencies at the workspace root:

```bash
npm install
```

Dump the agent registry:

```bash
npm run registry:dump
```

Run the tests:

```bash
npm test
```

### Phase 0 exit criterion

`npm run registry:dump` prints all **154** agents with their category and tool
list, and **fails loudly** — with file path and line — on any malformed
frontmatter, rather than silently dropping the offending agent.

Note the count: `categories/**/*.md` matches 164 files, but 10 of those are
category `README.md` files. The parser skips them. 154 is the number the dump
must print; anything else means the skip rule or the glob is wrong.
