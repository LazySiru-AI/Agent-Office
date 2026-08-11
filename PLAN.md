# Agent Office — Project Plan

A local web application that turns this repo's 154 subagent definitions into a
visible, working team. You give a task to one point of contact — the **Manager**
— she picks the right specialists, distributes the work, and you watch it happen
in a pixel-art office. Each agent finishes, writes a report, hands it back. The
Manager merges everything, a designer agent styles it, and you download a PDF.

The task domain is not fixed. A software task pulls developers, reviewers and a
QA lead. A tax question pulls an advisor and a risk analyst. A contract question
pulls `legal-advisor`. The Manager decides.

---

## 0. Decisions already made

| Decision | Choice | Consequence |
|---|---|---|
| Execution engine | Local Claude Code CLI now; pluggable providers later (Anthropic API, OpenAI, DeepSeek) | Provider abstraction is a **Phase 1** requirement, not a later refactor |
| Delivery form | Local web app (React + Vite frontend, Node server) | No packaging work; filesystem access via the local server |
| Agent visualisation | Pixel-art office sim | Needs a sprite pipeline and a state→animation binding |
| Agent definition source | Local repo files (`categories/**/*.md`) | Offline, instant, always matches what you edit locally |

### Project location

Its own repository at `C:\Users\KD-AI\repos\Agent Office`.

It began inside the `awesome-claude-code-subagents` catalog repo, under
`output/agent-office/`, and was moved out once it was clearly a project rather
than an experiment. The catalog repo is kept untouched as reference.

The move brought the agent catalog with it: `categories/` is vendored here, so
the registry has something to index without depending on a sibling checkout.
Keeping it vendored also means an agent definition can be edited for this
project's needs without diverging from an upstream repo mid-run. The cost is
that upstream additions have to be pulled in deliberately — FR-R6 exists for
exactly that.

---

## 1. Architecture

### 1.1 Shape

```
Agent Office/
├─ PLAN.md                     ← this file
├─ categories/                 the 154 vendored subagent definitions
├─ tools/subagent-catalog/     optional upstream refresh skill (FR-R6)
├─ packages/
│  ├─ shared/                  TypeScript types + zod schemas shared by both sides
│  ├─ server/                  the orchestrator host (Node + Fastify + ws)
│  │  ├─ registry/             indexes categories/**/*.md → agent roster
│  │  ├─ providers/            claude-code | anthropic | openai | deepseek adapters
│  │  ├─ orchestrator/         manager loop, run state machine, dispatcher
│  │  ├─ reports/              markdown merge → themed HTML → PDF
│  │  └─ store/                run persistence (JSON on disk, SQLite later)
│  └─ web/                     React + Vite + PixiJS
│     ├─ sim/                  pixel office: sprites, desks, animation controller
│     ├─ panels/               inspect panel, log tail, report viewer
│     └─ state/                websocket client, run store
└─ runs/<runId>/               per-run artifacts (gitignored)
   ├─ run.json                 full state, resumable
   ├─ workspace/               sandbox any code-writing agent gets
   ├─ logs/<agentId>.jsonl     raw provider event stream
   ├─ reports/NN-<agent>.md    individual agent reports
   ├─ report.md                Manager's synthesis
   └─ report.pdf               final deliverable
```

### 1.2 The core insight

**The run state machine is the animation controller.** Every visual behaviour in
the office is a pure function of orchestrator state. No separate animation logic,
no drift between "what the UI shows" and "what is actually running". If an agent
is `working`, its character is typing. If it's `blocked`, there's a `!` over its
head. This is what makes the sim honest rather than decorative.

### 1.3 Orchestration mode: in-app manager

Two options existed:

- **A. Orchestrator in our app** — our server runs the manager loop; each team
  member is a separate provider invocation with that agent's `.md` as its system
  prompt.
- **B. Orchestrator inside Claude Code** — one session with `.claude/agents/`
  populated, parsing its stream for `Task` tool calls.

**We take A.** B gives away exactly what this product sells: per-agent status,
controllable concurrency, and the ability to swap in OpenAI or DeepSeek later.
Under B, provider swapping is impossible — the orchestration lives inside the
vendor's runtime.

### 1.4 Data contracts

These three types are the spine. Get them right in Phase 0 and the rest follows.

```ts
// An agent as parsed from categories/**/*.md
interface AgentDef {
  name: string;            // frontmatter `name`         — present in all 154
  description: string;     // frontmatter `description`  — present in all 154; used for selection
  tools: string[];         // frontmatter `tools`        — present in all 154; → provider tool allowlist
  model?: string;          // frontmatter `model` — 146 have it (sonnet 103,
                           // inherit 25, haiku 18); 8 omit it, hence optional
  category: string;        // derived from directory, e.g. "08-business-product"
  filePath: string;
  systemPrompt: string;    // the markdown body below frontmatter
}

// The Manager's structured output. Validated with zod; a parse failure is a
// retry with the validation error appended, not a crash.
interface RunPlan {
  summary: string;               // restatement of the task, for the user
  domain: string;                // "software" | "legal" | "tax" | "research" | ...
  phases: Array<{
    id: string;
    name: string;                // "Research", "Implementation", "Review"
    parallel: boolean;
    assignments: Array<{
      id: string;
      agentName: string;         // MUST exist in the registry
      objective: string;         // what this agent specifically must produce
      deliverable: string;       // e.g. "reports/03-security-auditor.md"
      dependsOn: string[];       // assignment ids from earlier phases
    }>;
  }>;
  reportStyle: string;           // hint for the designer step
}

// Normalised across every provider — this is what the UI consumes.
type AgentEvent =
  | { t: 'status';    assignmentId: string; status: AssignmentStatus }
  | { t: 'text';      assignmentId: string; chunk: string }
  | { t: 'tool';      assignmentId: string; name: string; summary: string }
  | { t: 'artifact';  assignmentId: string; path: string }
  | { t: 'usage';     assignmentId: string; inputTokens: number; outputTokens: number }
  | { t: 'error';     assignmentId: string; message: string; fatal: boolean };
```

### 1.5 State machines

**Run:** `queued → planning → dispatching → running → synthesizing → designing →
report_ready → done` with `failed` and `cancelled` reachable from any state.

**Assignment:** `pending → briefing → working → reporting → done`, plus `blocked`
(waiting on a dependency), `failed`, and `skipped`.

**Animation binding:**

| Assignment status | Character behaviour |
|---|---|
| `pending` | idle at desk, occasional look-around |
| `briefing` | walks to the Manager's desk, speech bubble, walks back |
| `working` | seated, typing loop, screen glow |
| `blocked` | seated, `!` bubble, no typing |
| `reporting` | walks to Manager carrying a paper sprite |
| `done` | back at desk, relaxed idle |
| `failed` | slumped idle, red `×` bubble |

### 1.6 Provider abstraction

```ts
interface AgentProvider {
  id: 'claude-code' | 'anthropic' | 'openai' | 'deepseek';
  isAvailable(): Promise<{ ok: boolean; reason?: string }>;
  run(req: {
    systemPrompt: string;
    task: string;
    allowedTools: string[];
    workspaceDir: string;
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;
}
```

**Claude Code adapter (v1).** Spawns the CLI headlessly, one child process per
assignment, with `--output-format stream-json` so events can be parsed as they
arrive rather than waiting for completion. The agent's `tools:` frontmatter maps
directly onto the CLI's tool-allowlist flag — that field already exists in all
154 agent files and is exactly the permission model we need.

> ⚠️ **Verified prerequisite gap:** `claude` is **not on PATH** on this machine
> (the desktop app is installed, not the CLI). Phase 1 must start by installing
> the CLI and confirming the exact flag names and stream-json event shape against
> the installed version. Do not build the parser from assumed flags — capture a
> real session's output to a fixture file first, and unit-test the parser against
> that fixture.

**Later adapters.** Anthropic/OpenAI/DeepSeek adapters implement the same
interface over their respective chat-completions APIs with a small tool-loop.
They will not have filesystem tools out of the box — the adapter supplies its own
sandboxed `read_file`/`write_file`/`list_dir` tools scoped to `workspaceDir`.
This is why the workspace sandbox is a Phase 2 requirement, not a Phase 7 one.

---

## 2. Requirements

Priority: **M** = must have for v1, **S** = should have, **C** = could have.

### 2.1 Agent registry (FR-R)

| ID | Pri | Requirement |
|---|---|---|
| FR-R1 | M | Recursively index `categories/**/*.md`, parse YAML frontmatter and body into `AgentDef`. Skip `README.md`. |
| FR-R2 | M | Fail loudly with file path and line on malformed frontmatter; do not silently drop an agent. `name`, `description` and `tools` are present in all 154 files today — a file missing any of them is an error, not a shrug. |
| FR-R3 | M | Expose a **roster digest** (name + category + description, one line each) for the Manager's selection prompt. |
| FR-R4 | S | Pre-filter the roster to the top ~40 candidates by keyword/BM25 match against the task before sending to the Manager, to control prompt size. |
| FR-R5 | S | Hot-reload the index on file change, so editing an agent `.md` takes effect without a restart. |
| FR-R6 | C | Optional refresh from upstream GitHub, reusing `tools/subagent-catalog`. |

*Note on FR-R1 parsing (observed across all 154 files):* no `description` wraps
across multiple lines — every one is single-line, though some are quoted and some
are not, and many contain colons. `tools` is always a flat comma-separated
string, never a YAML list. Some tool names themselves contain colons or double
underscores (`subagent-catalog:search`, `mcp__bgpt__search_papers`,
`chrome-mcp`), so the parser must split on commas only and preserve each name
verbatim — no colon-splitting, no normalisation.

*Note on FR-R3 sizing:* 154 descriptions run roughly 8–11k tokens. Still
acceptable for a single planning call, but FR-R4 exists so it stays acceptable as
the catalog grows.

*Decision — frontmatter normalisation (deviates from FR-R2, recorded
deliberately):* 8 of the 154 files are **not valid YAML**. They write an
unquoted `description` containing a colon-space:

```
description: Use when the user needs ... Triggers on: 'GDPR', 'CCPA', ...
```

A colon-space terminates a plain scalar, so a conforming parser reads that as a
nested mapping and rejects the file. The affected files are
`gdpr-ccpa-compliance`, `hipaa-compliance`, `assumption-mapping`,
`backlog-grooming`, `growth-loops`, `ab-test-analysis`, `cohort-analysis` and
`first-principles-thinking` — the same 8 that omit `model:`, i.e. one
contributor's house style.

The parser therefore runs a narrow pre-pass that double-quotes only top-level
`key: value` lines whose value is a plain scalar YAML cannot represent, leaving
everything else untouched. **This is a silent repair, which FR-R2 otherwise
forbids.** It is accepted because the pattern is well-defined and the alternative
is losing 8 agents — including both privacy/compliance specialists, which the
legal and tax use cases depend on.

Two things follow. First, the repair is narrow by design: anything outside that
one pattern must still fail loudly. Second, the real fix is upstream — quoting
those 8 descriptions in the catalog itself would remove the need for the pre-pass
entirely, and is worth a contribution back to the source repo. Until then the
pre-pass stays, because it also protects against the next contributor repeating
the style.

### 2.2 Manager / orchestration (FR-M)

| ID | Pri | Requirement |
|---|---|---|
| FR-M1 | M | The Manager is a first-class agent whose system prompt is composed from `09-meta-orchestration/agent-organizer.md`, `multi-agent-coordinator.md` and `task-distributor.md`, plus a strict output contract. |
| FR-M2 | M | Manager emits a `RunPlan` validated against a zod schema. Invalid output → retry (max 2) with the validation error fed back. |
| FR-M3 | M | Every `agentName` in a plan must exist in the registry; unknown names trigger a repair retry with the valid-name list. |
| FR-M4 | M | Dispatcher executes phases in order, assignments within a phase in parallel up to a configurable concurrency cap (default 3). |
| FR-M5 | M | Each assignment receives: its agent's system prompt, the user's task, its own `objective`, and the reports of its `dependsOn` assignments. Nothing else — no shared unbounded context. |
| FR-M6 | M | Each assignment must produce a markdown report at `reports/NN-<agent>.md`. A missing report is a failed assignment. |
| FR-M7 | M | Manager synthesis step reads all agent reports and produces `report.md` — resolving contradictions explicitly rather than concatenating. |
| FR-M8 | M | Per-assignment timeout (default 10 min) and per-run token budget, both configurable; exceeding either fails cleanly with partial results preserved. |
| FR-M9 | S | User can cancel a run; in-flight child processes are killed and the run persists as `cancelled` with partial reports intact. |
| FR-M10 | S | Review loop: a reviewer assignment may return `revisions_requested`, re-dispatching the original assignment once with the critique attached. |
| FR-M11 | C | User can override the Manager's team before dispatch — add, drop or swap agents in the proposed plan. |

### 2.3 Office simulation (FR-S)

| ID | Pri | Requirement |
|---|---|---|
| FR-S1 | M | Render a top-down pixel office: Manager desk plus one desk per assigned agent, laid out on a grid that reflows for 1–12 agents. |
| FR-S2 | M | Each agent gets a deterministic sprite: `hash(agentName)` → base sprite + palette, so the same agent always looks the same across runs. |
| FR-S3 | M | Character behaviour is derived purely from orchestrator-owned state — assignment status (table §1.5), and from Phase 9 the current tool. No animation state the orchestrator doesn't own. *(Widened by FR-S11: "purely from assignment status" was the original wording, and it ruled out the `tool` events we already emit and never drew. The invariant that matters is the second sentence, not the first.)* |
| FR-S4 | M | A nameplate shows the agent's name; hovering shows its category and one-line description. |
| FR-S5 | M | Clicking a character opens an inspect panel: live log tail, current tool activity, token usage, and its report when ready. |
| FR-S6 | S | Hand-off animation — the character physically carries a paper sprite to the Manager on `reporting`. |
| FR-S7 | S | Runs at 60fps with 12 animated characters on integrated graphics; pauses rendering when the tab is hidden. |
| FR-S8 | C | Ambient detail: coffee machine, plants, day/night tint tracking run duration. |
| FR-S9 | C | Sprite pack is swappable via a manifest, so the art can be replaced without code changes. |
| FR-S10 | M | The office states each agent's **model**, and its live token spend, cost and current tool, without requiring a click. How much of that each desk shows is user-controlled (minimal / normal / verbose), because the office's advantage over the table is that it is scannable. |
| FR-S11 | S | The `working` animation is refined by the current tool — reading tools read, writing tools type — sourced from the `tool` events the adapter already emits. Refines FR-S3; status remains the source of truth for *behaviour*, tool only for which working loop plays. |
| FR-S12 | S | Hover and **keyboard focus** produce the same character highlight as clicking. The office's text alternative is a real focusable control per agent, so a mouse-only highlight would regress the keyboard access it provides. |
| FR-S13 | C | User-controlled zoom, at integer steps only — fractional scaling blurs pixel art, which is why the renderer picks whole numbers today. |
| FR-S14 | M | The office reads as a **room**: a wall it is set against, a floor with a material, and furniture. And the desk at the head of that room is occupied — the **Manager** is a character, drawn at the top-centre desk, animating from the run's own status. The office has drawn that desk empty since Phase 4, which left its central interaction (agents walking up to be briefed, walking back to report) with only one party in it. *(Narrows FR-U3 for the canvas only: the office no longer takes the chrome's near-black palette. See Phase 10.)* |

**Art sourcing.** v1 uses a CC0/permissive pack (Kenney-style) behind the FR-S9
manifest abstraction. Licence terms must be checked and recorded in a
`ASSETS.md` before any asset lands — the repo's own `license-engineer` agent is
the natural first real dogfooding task for this app.

### 2.4 Reports & PDF (FR-P)

| ID | Pri | Requirement |
|---|---|---|
| FR-P1 | M | Individual agent reports stored as markdown, viewable in-app. |
| FR-P2 | M | A **designer agent** step selects and applies a report theme appropriate to the domain (engineering / legal / financial / research), producing themed HTML. |
| FR-P3 | M | Render HTML → PDF via headless Chromium print-to-PDF. Fully offline — inlined CSS and fonts, no CDN requests. |
| FR-P4 | M | PDF includes cover page (task, date, team roster with roles), synthesis, then per-agent appendices. |
| FR-P5 | M | One-click download of `report.pdf` from the UI. |
| FR-P6 | S | Markdown export and per-agent PDF export as alternatives. |
| FR-P7 | C | User-selectable theme override before export. |

### 2.5 Non-functional (NFR)

| ID | Pri | Requirement |
|---|---|---|
| NFR-1 | M | **Sandboxing.** Code-writing agents operate only in `runs/<id>/workspace/`. The user's own repos are never a default working directory. |
| NFR-2 | M | **Resumability.** Run state persists to `run.json` after every transition; a browser refresh or server restart reattaches to a live run rather than losing it. |
| NFR-3 | M | **Streaming.** Agent output reaches the UI within ~500ms of the provider emitting it. WebSocket, not polling. |
| NFR-4 | M | **Secrets.** API keys live in a gitignored `.env` / OS keychain, are never sent to the frontend, and are never written into run artifacts. |
| NFR-5 | M | **Cost visibility.** Live token count and estimated cost per agent and per run, always visible. |
| NFR-6 | M | Single-user, localhost-bound. No auth in v1 — and therefore the server must **not** bind to `0.0.0.0`. |
| NFR-7 | S | Deterministic replay: a run's event log can be re-played into the UI without re-invoking any provider. Invaluable for debugging the sim. |
| NFR-8 | S | Graceful provider degradation — a provider becoming unavailable mid-run fails that assignment, not the whole run. |

### 2.6 Interface & theming (FR-U)

The app's own look, as distinct from the *report* themes in §2.4. Phase 3 was
"deliberately ugly" on purpose and Phase 4 added a pixel office on top of it, so
the interface is currently two visual languages sharing a page: plain browser
defaults around a dark canvas.

**Direction: a dark neon terminal.** Near-black ground, monospace-forward
typography, restrained neon accents, and the office rendered as something closer
to a CRT than a web page. It suits the subject — this is a tool for watching
processes run — and it resolves the mismatch rather than papering over it, since
the office canvas is already dark and everything around it is not.

| ID | Pri | Requirement |
|---|---|---|
| FR-U1 | M | One dark neon visual identity across the whole app: near-black ground, a small neon accent set, monospace-forward type. Applies to chrome, panels, tables and forms — not only the office. |
| FR-U2 | M | The palette lives in **one** place as design tokens (CSS custom properties), consumed by both the DOM and the canvas. Two copies of a colour is how the office and the panels come to disagree. |
| FR-U3 | M | The office sim adopts the palette through the existing FR-S9 sprite manifest and scene colours — a palette swap, not a renderer change. |
| FR-U4 | M | Status colour must stay legible and semantically distinct on the dark ground, and must never be the *only* carrier of meaning (a badge keeps its text). Body and status text meets WCAG AA contrast. |
| FR-U5 | S | Glow, scanline and flicker effects honour `prefers-reduced-motion`, and are switchable off independently of it. |
| FR-U6 | S | No webfont fetched at run time. System monospace stacks, or a font file bundled into the build — the app is local-first and must not degrade with no network (consistent with FR-P3). |
| FR-U7 | C | A light theme retained as an option, selected by `prefers-color-scheme` with a manual override. |

**Constraint — this does not touch the PDF.** The §2.4 report themes stay
light-on-white and are explicitly excluded from FR-U1. Dark neon is wrong for
print in a way that is not a matter of taste: it floods a page with ink, most
printers render large dark fills as muddy banding, and a document that is
downloaded and forwarded should not assume a screen. If a terminal *feel* is
wanted in the deliverable, the honest version is a fifth print theme that is
monospace-forward and still light — FR-P7 already contemplates a user-selected
theme.

*Note on the pixel office:* a CRT direction is a good fit for FR-S2's
deterministic sprites, because the per-agent palette slices can be constrained to
a neon ramp rather than the current naturalistic skin/hair/clothing sets. That is
a change to the *palette tables* in `sim/model.ts`, not to sprite generation.

### 2.7 Explicitly out of scope for v1

Multi-user accounts · hosted deployment · agent-to-agent direct chat (all
communication routes through the Manager, by design) · editing agent `.md` files
from inside the app · mobile layout · voice.

---

## 3. Phases

Each phase ends in something demonstrable. No phase is "infrastructure only".

### Phase 0 — Foundations (registry + contracts)

Scaffold the workspace (`shared`, `server`, `web`), then build the registry
parser and lock the three contracts from §1.4.

- Parse all 154 agent files into `AgentDef[]`; snapshot-test the count and a
  sample. (`categories/**/*.md` is 164 files; 10 are category `README.md`s.)
- Generate the roster digest; measure its token size.
- Zod schemas for `RunPlan` and `AgentEvent`.

**Exit:** `npm run registry:dump` prints all 154 agents with category and tool
list, and fails loudly on any malformed frontmatter.

### Phase 1 — Provider layer + Claude Code adapter

Install the CLI, capture a real `stream-json` session to a fixture, then build
the adapter against that fixture.

- `AgentProvider` interface + `isAvailable()` preflight.
- Claude Code adapter: spawn, stream-parse, normalise to `AgentEvent`, map
  frontmatter `tools` → tool allowlist, enforce timeout and abort.
- Parser unit-tested against the captured fixture, including truncated and
  malformed-line cases.

**Exit:** a CLI script runs *one* agent (`code-reviewer`) against a throwaway
task and streams normalised events to stdout.

**Risk:** flag names and event shapes must be verified against the installed
version, not assumed. This phase is the plan's largest unknown — budget for it.

### Phase 2 — Orchestrator core (headless)

The whole pipeline, no UI.

- Manager planning call → validated `RunPlan`, with repair-retry on invalid
  output or unknown agent names.
- Dispatcher: phase sequencing, intra-phase concurrency cap, dependency
  resolution, context assembly per FR-M5.
- Workspace sandbox, per-agent report writing, run persistence.
- Manager synthesis → `report.md`.

**Exit:** `npm run run -- "task text"` executes end-to-end and produces a
`runs/<id>/` directory with individual reports and a synthesis. Verified on two
different domains — one software, one legal/tax — to prove the routing isn't
software-only.

### Phase 3 — Web shell + live wiring

Deliberately ugly. Proves the data flow before any art exists.

- Fastify + WebSocket event bus; React client; task input; run list.
- Plain table of assignments with status badges and a live log pane.
- Reattach-on-refresh (NFR-2), cancel, cost counters.

**Exit:** you type a task in the browser, watch statuses change live, refresh
mid-run without losing anything, and read the finished reports in-app.

### Phase 4 — Pixel office sim

Replace the table with the office. Nothing about the orchestrator changes.

- PixiJS canvas, tilemap office, desk grid layout with reflow.
- Sprite manifest + deterministic agent→sprite assignment.
- Animation controller as a pure `status → behaviour` map; walk pathfinding
  between desk and Manager.
- Click-to-inspect panel; hover nameplates.
- Replay mode (NFR-7) driven from a saved event log — the only sane way to
  iterate on animation without burning tokens.

**Exit:** a real run is watchable as an office scene, and a saved run can be
replayed frame-for-frame offline.

### Phase 5 — Designer step + PDF export

- Designer agent selects a theme; 3–4 hand-built themes to choose among
  (engineering, legal, financial, research).
- Markdown → themed HTML → PDF via headless Chromium, fully offline.
- Cover page, team roster, synthesis, per-agent appendices.
- Download button.

**Exit:** a run ends with a downloadable PDF that looks deliberately designed,
and a legal-domain run visibly differs in styling from a software one.

### Phase 6 — Domain breadth

Make the non-software claim real.

- Test matrix across software / legal / tax / research / product tasks.
- **Author the missing agents.** The catalog has `legal-advisor`,
  `risk-manager`, `fintech-engineer` and `quant-analyst`, but **no tax
  specialist** — a gap that directly affects the tax use case you described.
  Write new agents in the repo's existing format and follow `CLAUDE.md`'s
  contribution rules (main README, category README, agent file).
- Tune Manager selection prompts where routing picks the wrong team.
- Review loop (FR-M10).

**Exit:** five domain tasks each produce a sensible team and a coherent PDF, with
routing errors documented and addressed.

**Outcome — done, with one exit criterion only half-met.** The five domains each
produce a sensible team and a valid PDF, the two tax agents are written
(catalog: 156), the review loop is built and wired, and three routing defects
were found and fixed. But every team above was chosen by the scripted provider's
*presets*, not by a model — the Claude Code CLI is installed but not signed in —
so the teams are correct by construction and **the Manager's routing judgement
remains untested**. "Tune Manager selection prompts where routing picks the
wrong team" is therefore deferred, not delivered: there is nothing to tune until
a model is doing the picking.

FR-R4's pre-filter is built and measured (11,067 → 2,748 digest tokens) but
deliberately left unwired: a 40-candidate cut loses 6 of 16 agents a human would
pick, and a pre-filter that removes the right agent is worse than no filter. See
`PROGRESS.md` for the recall numbers.

Also corrected here: `ASSIGNMENT_TRANSITIONS` claimed to support FR-M10 via
`reporting -> working`, an edge no reviewer can ever reach. The real one is
`done -> briefing`.

### Phase 7 — Provider expansion + polish

- Anthropic API, OpenAI and DeepSeek adapters behind the same interface, with
  sandboxed filesystem tools supplied by the adapter.
- Provider selection per run, or per agent.
- Settings UI: keys, concurrency, budgets, timeouts.
- Run history browser; SQLite if JSON-on-disk starts to hurt.

**Exit:** the same task runs identically through Claude Code and through a raw
API provider, with only a dropdown changing.

**Outcome — built, and the exit criterion is unprovable here.** All three
adapters exist behind the same seam, the dropdown is real, and provider choice
is per run *or per agent*. What cannot be done on this machine is the comparison
the criterion asks for: there is no API key, and the Claude Code CLI is
installed but not signed in, so no task has run through any of them. The
adapters are verified against local fake servers speaking the documented wire
format — which proves this code's behaviour and proves nothing about whether
that format matches the live API. That distinction is stated in every file
concerned rather than glossed.

The filesystem tools an API provider must supply itself are the part that *is*
fully verified, because escaping a sandbox needs no credentials: traversal,
absolute and UNC paths, prefix-sibling directories and case-insensitive
comparison are all tested against a real filesystem. Symlink escapes are
implemented but unverified — Windows refused to create a symlink without
Developer Mode, and those four tests skip loudly rather than passing quietly.

SQLite was not adopted. The plan made it conditional on JSON-on-disk hurting,
and at thirty runs it does not.

### Phase 8 — Dark neon terminal interface — **done**

The app's own visual identity (§2.6). Independent of everything else: it changes
no orchestrator behaviour, no contract and no provider, which is why it can be
taken whenever wanted rather than in sequence.

- Design tokens first — one palette, as CSS custom properties, consumed by both
  the DOM and the canvas (FR-U2). Doing this second, after styling the panels,
  guarantees two sources of truth.
- Restyle the shell: task form, run list, run header, assignment table, log pane,
  inspect panel, replay controls. The log pane is already dark and monospaced and
  is the closest thing to a reference for the rest.
- Rework the status palette against the dark ground (FR-U4). This is the fiddly
  part: eight assignment statuses and ten run statuses currently rely on
  mid-tone fills that will not survive the change.
- Swap the office's palette through the sprite manifest and scene colours
  (FR-U3): a neon ramp for the deterministic per-agent sprites, a CRT tint on the
  floor, glow on desks that are actively working.
- Motion: scanlines and glow behind a `prefers-reduced-motion` check and an
  explicit toggle (FR-U5).

**Deliberately not in scope:** the PDF. Report themes stay light-on-white — see
the constraint under §2.6.

**Exit:** the whole app reads as one interface rather than a dark canvas dropped
into a default-styled page; a colour-blind user can still tell `failed` from
`done`; text meets WCAG AA on the dark ground; and the office palette comes from
the same tokens as the panels, verified by there being no second copy of a
colour value in the client.

**Risk:** this is the phase most likely to be judged on taste rather than
correctness, and the one where "a bit more polish" has no natural end. The exit
criteria above are deliberately checkable for that reason.

**Outcome:** all four exit criteria met — see `PROGRESS.md`. Two things the plan
did not anticipate. The contrast bar had to be measured against *every* surface
a colour lands on, not the page background: panels sit on `surfaceRaised`, which
in dark is lighter than `bg`, and auditing against `bg` alone passed eight pairs
that fail on the surface they actually render on. And the status vocabulary
turned out to exist in three places, not one — the stylesheet now keys on the
eight colour tokens rather than the eighteen statuses, so the status list lives
only in TypeScript where it is compile-checked. Scanlines and flicker were not
built; the motion switch and reduced-motion gating cover the effects that exist.

### Phase 9 — The office that tells you what it is doing

Prompted by a review of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)
(8.8k stars, actively developed), which solves a near-identical problem — Claude
Code sessions as pixel characters in a shared office — and solves parts of it
better than we do. This phase takes the parts worth taking, credits them, and
deliberately declines the rest.

**The finding that motivates the phase.** `CharacterView` (`sim/model.ts`)
carries `assignmentId`, `agentName`, `status`, `behaviour`, `appearance`, `home`
and `target`. That is all the office knows. It does **not** know the agent's
model, its provider, its token spend, its cost, or which tool it is running —
every one of which we already have, and show, in `AssignmentTable` and
`InspectPanel`. So the app's *default* view is its least informative one: a
character types at a desk and the only way to learn it is `code-reviewer` on
`haiku` having spent $0.004 is to switch to the table or click the sprite. The
office looks like the product and behaves like a decoration.

**What pixel-agents does better, and why.**

| Their technique | Our current state |
|---|---|
| `Character.currentTool` drives a read-vs-type animation | We emit `tool` events with names and the sim ignores them entirely |
| Bubble fade-in, per-pixel spawn/despawn transition | Binary state swaps — a character teleports between animations |
| Hover and selection drawn as a silhouette outline at two alphas | One selection ring; no hover affordance |
| Overlay text labels near a character ("Waiting for input") | A nameplate with a name and nothing else |
| Explicit zoom controls | Automatic integer scale only; no user control |
| Idle wander with rest cycles | Idle is a single static loop |

**What we have that they do not, and should lean into.** A real Manager with a
validated plan, phases and dependencies; per-agent models from catalog
frontmatter; real cost accounting; and replay. Their roadmap lists orchestrator
characters and token-budget health bars as *future* work. We have the data for
both today and simply do not draw it.

#### 9.1 Put the run's own facts on the floor (the core of the phase)

- Extend `CharacterView` with `model`, `provider`, `usage`, `costUsd` and
  `currentTool`. All of it exists already — `agentModelByName` and
  `summariseRunCost` are built in `App.tsx` and never reach `buildScene`.
- **Two-line nameplate**: agent name, then a dim model badge (`haiku`,
  `sonnet`, `—` for the 8 agents that declare none). The model is the single
  most requested missing fact and the cheapest to add.
- **A "now" line** under a working character, from the most recent `tool` event:
  `Read src/auth.ts`, `Grep TODO`. `LogPane` already formats exactly this
  string; the formatter moves somewhere both can call.
- **A spend readout** per character, off by default behind a `DisplayControls`
  toggle. Cost per agent is the thing you want when a run surprises you and
  clutter the rest of the time.
- **Density is a setting, not a guess.** One control — minimal / normal /
  verbose — governs how much of the above each plate shows. A neon office that
  renders five facts per desk at all times is less readable than one that
  renders a name, which is the failure mode this phase must not ship.

#### 9.2 Tool-driven animation

`ASSIGNMENT_BEHAVIOUR` stays the single source of truth for *status* →
behaviour. Tool refines only the `working` case: reading tools (`Read`, `Glob`,
`Grep`) select a read loop, writing tools a type loop, everything else the
current default. This is pixel-agents' `isReadingTool` idea applied to a map we
already own, and it is the highest ratio of visible life to code in the phase.

#### 9.3 Transitions instead of swaps

Bubbles fade rather than appear. A character arriving gets a brief materialise
effect; one reaching a terminal status gets a settle. A status change pulses the
nameplate once. **All of it behind the existing `prefers-reduced-motion` check
and the motion toggle (FR-U5)** — and the *information* must never live in the
motion, since a reduced-motion user sees none of it.

#### 9.4 Hover, selection, and keyboard parity

Adopt the outline-silhouette technique: full alpha for selected, half for hover.
**The keyboard path drives the identical highlight** — the office's text
alternative (`OfficeTextAlternative`, added in the second QA pass) already
exposes one focusable button per agent, and focusing one must light the same
character. Otherwise this phase builds a mouse-only affordance on top of the
keyboard access we just added.

#### 9.5 Draw the thing they do not have: the plan

- Phase banding on the floor, so "phase 2 is running" is visible rather than
  inferred.
- A reviewer that walks to its target's desk rather than to the Manager, since
  FR-M10 means the dependency is the point.
- The Manager's own turn made visible — it outspends the team on a small run and
  is currently the least legible actor in the office.

#### 9.6 Zoom and camera

Explicit zoom in/out at integer steps, with the current auto-fit as the default
and a reset. The integer-scale rule stays: fractional zoom blurs pixel art, and
the 520px host already falls back to 1x on a three-row team.

#### Deliberately not taken from pixel-agents

The office layout editor, the furniture catalog, pets, asset-pack import, and
sound notifications. Each is good work and each belongs to a different product:
theirs is an ambient companion you decorate and leave running, ours is a tool
you point at one task and read the report from. A tile painter would be the
largest feature in this repo and would not make a single run easier to
understand.

**Exit:**

1. Every fact the assignment table shows about a running agent — model, tokens,
   cost, current tool — is legible from the office view without clicking, at the
   default density.
2. A working character animates differently for a read than for a write, driven
   by real `tool` events.
3. Focusing an agent from the keyboard highlights the same character clicking it
   does, and the text alternative states model and current tool alongside status.
4. Motion off and `prefers-reduced-motion` both still yield a fully usable,
   fully informative office — nothing in 9.1 depends on an animation.
5. No new colour literal in the client: everything added here resolves through
   `theme/tokens.ts` (FR-U2), and the contrast grid covers any new text token.

**Risk — clutter, and it is the whole risk.** Every item in 9.1 makes one desk
busier, and the office's advantage over the table is that it is *scannable*. The
density control is the mitigation, but the honest test is criterion 1 read
against a five-agent run at default density: if the plate is unreadable there,
the default is wrong, not the criterion. Second risk: 9.1 duplicates facts the
table already renders, so both must read from one source — `costModel.ts` — or
the office and the table will eventually disagree about what a run cost, which
is precisely the class of defect the last two QA passes kept finding.


### Phase 10 — The office looks like a place

Phase 9 gave the office *information*; this one gives it a *room*. The prompt was
the same [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)
screenshot that motivated Phase 9, read a second time for its art direction
rather than its features — and the honest reading is that our office is not
losing on pixel-art style, it is losing on being a depicted space at all.

**The two findings that motivate the phase.**

*The room is not a room.* `rebuildFloorAndDesks` painted a two-tone checkerboard
across the whole layout and put desks on it. There was no wall, no floor
material, no chair, no screen, no plant — nothing that says "workplace" rather
than "grid". Both floor tones were near-blacks a shade apart, so the one visual
distinction available to the whole scene was spent on a checker pattern nobody
reads as flooring. Phase 8's argument for that palette was "a CRT is a screen,
and a screen is dark whatever the room is", which is sound and produced the wrong
result: the office is not a readout of a machine, it is a depiction of a place,
and a place rendered in four shades of one near-black reads as a wireframe of an
office rather than an office.

*The head desk is empty.* `layoutOffice` has produced a `managerDesk` since Phase
4, `ASSIGNMENT_BEHAVIOUR` sends `briefing` and `reporting` agents to walk to it,
and the renderer has drawn the desk — with nobody behind it. So the sim's central
interaction, the thing that makes it an *office* rather than a row of independent
workstations, has been a character walking up to a piece of furniture and
addressing it. The orchestrator that briefs and receives from every agent is the
one participant in the run that the office never drew.

#### 10.1 Repaint the office as a room (FR-S14, narrowing FR-U3)

- **Measured, not invented.** The floor, wall, wood and carpet values in `OFFICE`
  are literal samples taken off the reference screenshot rather than picked by
  eye, for the same reason the plate geometry was measured rather than eyeballed
  in Phase 9: "warm brown" is a description, `#734728` is a decision.
- Wall band across the top of the layout (`OfficeLayout.wallRows`), floorboards
  in a brick bond below it, and a skirting line where they meet.
- Furniture: a monitor on every desk, a chair behind every seat, and the things
  that make a space identifiable at a glance — plants, a bookshelf, a clock,
  framed art, a couch, a rug under the Manager.
- **The chrome does not follow.** `THEMES` stays the dark neon terminal of FR-U1.
  Only the canvas is repainted, and only because it depicts something. The screens
  on the desks keep the phosphor green — that is the one place the terminal
  identity is literally true.

#### 10.2 Characters that can be told apart (FR-S2, at a size that allows it)

The sprite box grows 12×16 → 16×24. At 12×16 a head is a 4×4 block: no row for a
hairline, no column for a shoulder, one pixel per eye. Every character therefore
came out as the same silhouette in different colours — the art was not crude by
intention, it was crude because the box could not hold anything else. 16×24 is
the smallest box that holds a recognisable hair *shape*, two-tone shading on
every mass, and a seated pose distinguishable from a standing one.

`SPRITE_RAMP` also stops being phosphor hues and becomes people. Cyan hair on a
mint face is *distinguishable*, which is all FR-S2 literally asks, but it is not
*recognisable* — and recognisability is the entire point of deriving appearance
from the agent's name. A reader is meant to learn "the one with the ginger hair
is the reviewer", and that only works if the ramps describe something a person
already has a word for.

#### 10.3 Seat the office

`SpriteKey` gains `seated`, as an axis rather than three more animations — it is
orthogonal to what a character is *doing*, exactly as `facing` is, and folding it
into the animation union would double every future animation and let the halves
drift. The renderer decides it from **geometry, not status**: a character is
seated when it has arrived at its own desk. That keeps `shared/src/status.ts` the
sole owner of behaviour (FR-S3) — sitting down is not a new state, it is what
being at your desk looks like.

#### 10.4 Put the Manager at the head desk (FR-S14)

`OfficeScene.manager`, always present, animating from the run's status
(`planning`/`synthesizing`/`designing` read; `dispatching`/`running` type; `done`
relaxed; `failed` slumped; `cancelled` idle, for the same reason a cancelled
assignment is not drawn as a failed one).

Deliberately **not** a `CharacterView` in `scene.characters`: it has no
`assignmentId`, and every map, hit test and selection path in the renderer is
keyed by one, so a fabricated id would make clicking the Manager open an inspect
panel for an assignment that does not exist. It also never walks, so the walk
interpolation, target resolution and carried-report prop are all inapplicable. A
separate field states both of those in the type rather than leaving them as rules
a future caller has to remember.

Agents already walk to `managerDesk.approach` to be briefed and to report; what
was missing was somebody to arrive at, and a facing on arrival — `resolveFacing`
returns the *previous* heading once movement stops, so an agent that had walked
up to report ended up facing whichever way it happened to come from.

#### 10.5 The walk to the Manager had never actually been visible

Found by reading `dispatcher.ts` while checking what "approach the Manager"
would need to mean, and it is the most surprising thing in the phase.

`briefing` is set at `dispatcher.ts:287` and `working` at `:321`; between them
sit `loadUpstreamReports` and `buildAssignmentBrief` — a few file reads and some
string assembly, single-digit milliseconds. `reporting` is set at `:463` and
`done` at `:474`, with one `writeReport` in between. Both statuses are
transient.

`WALK_SPEED_TILES_PER_SECOND` is 4 and the trip from a desk to the approach tile
is several tiles. So a character gets on the order of **0.08 tiles — about one
pixel** — towards the Manager before the status flips and `stepTowards`,
correctly and by design, re-routes it back to its desk. The office's central
interaction has been running for six phases and rendering as a twitch.

Nothing caught it because every test asserts on target *values* —
`expect(character.target).toEqual(manager.approach)` is true, and stays true,
for the millisecond the status exists. No test asked whether the journey was
ever *observable*, which is a different claim and the one that mattered.

The fix is an **errand**: renderer-owned travel state that survives a target
change. Once a character is sent to the Manager it completes the trip, dwells
facing him, and only then resumes following its current target — which by that
point is its desk, so the walk home needs no special handling.

This is the one place in the phase that comes close to FR-S3, so the argument is
worth stating: FR-S3 says the renderer owns no *status*. An errand is not
status, it is travel state — the same category as `currentPos`, which the
renderer has always owned. The renderer is not deciding that an agent is
briefing; it is finishing the journey the orchestrator's status already sent it
on. It is also skipped entirely under `prefers-reduced-motion` (FR-U5), where
characters snap to their targets and a forced dwell would be reintroducing
exactly the motion the setting asks us not to draw.

#### 10.6 The consequence nobody would have predicted

Plate text used to sit directly on the floor, which was legible only because the
floor was near-black. On wood, `OFFICE.plateDetail` measures **2.18:1** — a real
WCAG AA failure introduced by a palette change, exactly the kind of coupling
`officeText.test.ts` exists to catch. The fixes available without a backing panel
were both bad: lighten the detail lines until they matched the name, destroying
the hierarchy that makes a floor of desks scannable, or abandon the repaint. So
plates now print on an opaque `plateBg` card, and the contrast grid grades
against that instead. The panel's alpha is pinned at exactly 1 by a test, because
a translucent one would make the true ground a blend of the card and whatever
board sat under it — and the contrast test would then be measuring a colour that
never appears on screen.

**Exit criteria.** The office renders a wall, a floor material and furniture;
every desk has a chair and a screen; the Manager is drawn at the head desk and
animates from run status; characters sit down when they arrive, complete the
walk to the Manager even though the status that sent them lasts milliseconds,
and face him while they report; the Manager is not hit-testable and is announced in the
office's text alternative as a non-interactive entry; plate text clears WCAG AA
against the opaque panel it now prints on; and no colour in `sim/` is a hex
literal (FR-U2 still holds — the repaint moved values, it did not scatter them).

---
---

## 4. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Claude Code CLI absent / flags differ from assumption | Blocks Phase 1 entirely | Verified today: not on PATH. Install first, capture a real fixture, build the parser against it. |
| Manager returns unparseable or hallucinated plans | Breaks the whole pipeline | Zod validation + repair-retry + registry name checking (FR-M2/M3). Log every rejected plan. |
| Non-software agents produce thin output | The "lawyer/tax adviser" use case underdelivers | Phase 6 exists specifically for this; expect to author new agents, not just route to existing ones. |
| Cost runaway on parallel agents | Real money | Concurrency cap, per-run token budget, live cost display, hard timeouts (FR-M8, NFR-5). |
| Sim iteration burns tokens | Slow, expensive Phase 4 | Replay mode (NFR-7) is a hard requirement, not a nice-to-have. |
| Sprite asset licensing | Legal exposure if distributed | CC0/permissive only, recorded in `ASSETS.md`, verified before any asset lands. |
| Scope creep in the office sim | Phase 4 never ends | FR-S8/S9 are explicitly `could-have`. Ship the honest version first. |

---

## 5. Suggested sequencing

Phases 0→3 are the critical path and strictly ordered — each genuinely depends on
the last. Phase 4 (sim) and Phase 5 (PDF) are independent of each other and can
be interleaved. Phase 6 should begin as soon as Phase 2 lands, since domain
routing problems are cheapest to find headlessly. Phase 7 is deferrable
indefinitely without blocking anything.

Phase 8 (dark neon interface) is independent of all of them and can be taken at
any point — it touches only the client. The one argument for taking it *before*
Phase 6 is that Phase 6's output is judged by reading reports and watching
routing decisions, and a legible interface makes that work easier. The argument
for taking it after is that Phase 6 is the one remaining phase that changes what
the product can *do*.

The one thing worth resisting: building the office before Phase 3 proves the data
flow. The sim is the fun part and the least informative one — if the orchestrator
is wrong, a beautiful office just animates the wrong thing convincingly.

Phase 9 inverts that warning rather than contradicting it. It is the right thing
to take *now*, and only now, because the condition the warning set has been met:
the orchestrator is proven, Phase 1's exit criterion is closed against a real
signed-in CLI, and the numbers the office would display — model, tokens, cost —
are ones two QA passes have already established are correct. Drawing them in
Phase 4 would have been animating unverified figures convincingly; drawing them
now is showing verified ones. It also touches only the client and no contract, so
like Phase 8 it can be interleaved with anything still open.
