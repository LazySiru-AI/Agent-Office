# Agent Office

Give a task to one point of contact — the Manager — and watch a team of
specialists do it.

The Manager reads the task, picks the right agents from a catalog of 156
specialists, and distributes the work. Each agent works its part and files a
report. The Manager merges them into one document, a designer agent styles it,
and you download a PDF.

The domain is not fixed. A software task pulls developers, reviewers and a QA
lead. A tax question pulls an advisor and a risk analyst. A contract question
pulls a legal advisor. The Manager decides.

It runs as a local web app, and the team is visible: a pixel-art office where
each assigned agent is a character at a desk — typing while working, walking a
report over to the Manager when done.

## Status

**Phases 0, 2, 3, 4, 5, 6, 7 and 8 are done, and a five-reviewer QA pass has
been through all of them.** That pass found 29 defects, 21 of them reproduced
rather than reasoned — including a review loop that could crash a whole run, a
`Grep` pattern that froze the server, a report path that could overwrite the
run's own state file, and a cost display that had never worked for a real
provider. All are fixed; `PROGRESS.md` has the full account.

1,178 tests pass, typecheck is
clean, the registry indexes 156 agents, and you can drive a run
from the browser — watch the team work in a pixel office, click a character to inspect
it, refresh mid-run without losing it, cancel it, read the reports in-app,
replay a finished run offline, and download a themed PDF. The whole app wears
one dark neon terminal theme, with a light option and a motion switch. See
`PROGRESS.md` for what had to be repaired to get there.

The PDF needs no extra dependency: it is printed by the Chrome or Edge already
installed on the machine, fully offline.

| Phase | What | Status |
|---|---|---|
| 0 | Agent registry + shared contracts | done |
| 1 | Provider layer + Claude Code adapter | built; needs `claude auth login` |
| 2 | Orchestrator core (headless) | done |
| 3 | Web shell + live wiring | done |
| 4 | Pixel office sim | done |
| 5 | Designer step + PDF export | done |
| 6 | Domain breadth + review loop | done (routing untested — no model) |
| 7 | Anthropic / OpenAI / DeepSeek adapters | built (unverified — no key) |
| 8 | Dark neon terminal interface | done |
| — | QA pass: five reviewers, 29 defects, all fixed | done |

**Nothing has called a real model yet.** The Claude Code adapter is written and
has been driven against the real CLI — real spawn, real argv, real stream-json —
but the installed CLI is not signed in, so no model has answered. One command
closes that gap:

```bash
claude auth login
```

Then `npm run agent -- "<task>"` runs a single agent for real. That is the first
thing in this project that spends money.

**The local CLI is the default provider for every agent.** If you would rather
use a raw API, copy `.env.example` to `.env` and add a key:

```bash
cp .env.example .env
```

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY` is enough — the
settings panel picks the provider up on the next server start and says why any
provider it cannot use is unavailable. `.env` is gitignored. Keys are read by
the server only; they are never sent to, stored by, or displayed in the browser.

Use `--provider scripted` (or the Settings panel) for a free dry run that calls
no model at all.

## Layout

```
categories/     156 subagent definitions (154 vendored + 2 authored here)
packages/
  shared/       contracts both sides agree on: run state, plan, events
  server/       registry, providers, orchestrator, persistence
  web/          (Phase 3) React + Vite + PixiJS
runs/<id>/      per-run artifacts — reports, logs, workspace (gitignored)
```

## Getting started

Requires Node.js 20+ (v24.19.0 is installed here — see `SETUP.md`).

```bash
npm install
```

Print the agent registry (the Phase 0 exit criterion — it should list 156):

```bash
npm run registry:dump
```

Run a task end to end with the no-cost scripted provider (no model is called):

```bash
npm run run -- "Review our vendor NDA for unusual terms" --provider scripted
```

Or for real, through whichever provider is configured — the local CLI by
default:

```bash
npm run run -- "Review our vendor NDA for unusual terms"
```

Run a single agent through the real Claude Code CLI (needs `claude auth login`,
and spends real money):

```bash
npm run agent -- "Review the registry parser for edge cases" --max-cost 0.25
```

Run the web app — the API server and the Vite client are two processes:

```bash
npm run serve
```

```bash
npm run web
```

Then open the Vite URL. Add `--step-delay 2000` to `npm run serve` to slow the
scripted provider down enough to watch statuses change and test refresh-mid-run.

The office is the default view. Click a character to inspect that agent; the
`Table` toggle brings back the plain assignment table, and `Replay` re-runs a
finished run from its saved event log — no provider, no tokens, no cost.

The app opens dark. The `Theme` and `Motion` controls at the foot of the sidebar
switch to a light theme or follow the OS, and turn animation off independently
of `prefers-reduced-motion`. The office itself stays dark in either theme — it
is a screen, and a screen does not change colour with the room.

Run the tests:

```bash
npm test
```

## Where the agents come from

The `categories/` tree is vendored from
[awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents).
It is committed here rather than referenced, so the registry always has
something to index and agent definitions can be tuned for this project without
depending on an upstream checkout. `tools/subagent-catalog/` can refresh from
upstream when wanted.

Two of the 156 are written here rather than vendored: `tax-advisor` and
`tax-compliance-specialist`. The upstream catalog has `legal-advisor`,
`risk-manager`, `fintech-engineer` and `quant-analyst` but no tax specialist of
any kind, which left the tax use case being answered by a general business
analyst. They follow the catalog's own file format, so a future upstream refresh
leaves them untouched.

## Documents

- `PLAN.md` — architecture, numbered requirements, all nine phases
- `SETUP.md` — prerequisites, and the verified Claude Code CLI flag surface
- `PROGRESS.md` — per-phase log of what was built, decided, and left open
- `ASSETS.md` — why the office sprites are generated rather than licensed
