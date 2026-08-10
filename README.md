# Agent Office

Give a task to one point of contact — the Manager — and watch a team of
specialists do it.

The Manager reads the task, picks the right agents from a catalog of 154
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

**Phases 0, 2, 3 and 4 are done and verified.** 467 tests pass, typecheck is
clean, the registry indexes 154 agents, and you can drive a run from the browser
— watch the team work in a pixel office, click a character to inspect it,
refresh mid-run without losing it, cancel it, read the reports in-app, and
replay a finished run offline. See `PROGRESS.md` for what had to be repaired to
get there.

| Phase | What | Status |
|---|---|---|
| 0 | Agent registry + shared contracts | done |
| 1 | Provider layer + Claude Code adapter | built; needs `claude auth login` |
| 2 | Orchestrator core (headless) | done |
| 3 | Web shell + live wiring | done |
| 4 | Pixel office sim | done |
| 5–7 | PDF export, domain breadth, more providers | not started |

**Nothing has called a real model yet.** The Claude Code adapter is written and
has been driven against the real CLI — real spawn, real argv, real stream-json —
but the installed CLI is not signed in, so no model has answered. One command
closes that gap:

```bash
claude auth login
```

Then `npm run agent -- "<task>"` runs a single agent for real. That is the first
thing in this project that spends money.

## Layout

```
categories/     154 vendored subagent definitions, indexed at startup
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

Print the agent registry (the Phase 0 exit criterion — it should list 154):

```bash
npm run registry:dump
```

Run a task end to end with the no-cost scripted provider:

```bash
npm run run -- "Review our vendor NDA for unusual terms" --provider scripted
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

## Documents

- `PLAN.md` — architecture, numbered requirements, all eight phases
- `SETUP.md` — prerequisites, including the two that are currently missing
- `PROGRESS.md` — per-phase log of what was built, decided, and left open
