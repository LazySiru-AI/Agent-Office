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

**Phases 0 and 2 are built but unverified.** Node.js is not yet installed on
this machine, so nothing in the repository has been compiled, tested, or run.
See `SETUP.md` for what is missing and `PROGRESS.md` for where each phase stands.

| Phase | What | Status |
|---|---|---|
| 0 | Agent registry + shared contracts | built, unverified |
| 1 | Provider layer + Claude Code adapter | blocked — needs the `claude` CLI |
| 2 | Orchestrator core (headless) | built, unverified |
| 3–7 | Web shell, pixel office, PDF export, domain breadth, more providers | not started |

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

Requires Node.js 20+, which is **not currently installed** — see `SETUP.md`.

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
