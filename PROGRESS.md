# Progress

One entry per phase, newest last. Each phase ends in a commit.

Status vocabulary: **done** (built and verified) · **built, unverified** (code
written, not executed) · **blocked** · **not started**.

| Phase | Status | Committed |
|---|---|---|
| 0 — Foundations (registry + contracts) | **done** | yes |
| 1 — Provider layer + Claude Code adapter | not started — no longer blocked | — |
| 2 — Orchestrator core (headless) | **done** | yes |
| 3 — Web shell + live wiring | **done** | yes |
| 4 — Pixel office sim | not started | — |
| 5 — Designer step + PDF export | not started | — |
| 6 — Domain breadth | not started | — |
| 7 — Provider expansion + polish | not started | — |

Each phase commit's subject starts with `Phase N:`, so to find one:

```bash
git log --oneline --grep "^Phase 0:"
```

---

## Phase 0 — Foundations (registry + contracts)

**Status: built, unverified.** Nothing has been executed — Node.js is not
installed on this machine (see `SETUP.md`). The exit criterion is unmet until
`npm run registry:dump` actually prints 154 agents.

### What was built

**Contracts** (`packages/shared`) — the spine from PLAN.md §1.4.

- `status.ts` — run and assignment state machines with explicit transition
  tables, plus `ASSIGNMENT_BEHAVIOUR`: the §1.2 animation binding expressed as
  data, so the office sim owns no status of its own.
- `plan.ts` — `RunPlanSchema`. Rejects duplicate ids, self-dependencies, and
  forward or same-phase dependencies. That last rule makes dispatcher deadlock
  structurally impossible rather than a runtime concern.
  `validatePlanAgainstRegistry` returns structured issues instead of throwing,
  so FR-M3 repair-retries can feed them back to the Manager.
- `events.ts` — the normalised `AgentEvent` union every provider flattens into.
- `agent.ts` — `AgentDef` and the catalog's category list.

**Registry** (`packages/server`) — FR-R1 through FR-R3.

- `registry/parse.ts` — frontmatter parser. CRLF-aware, BOM-stripping, fails
  loudly with file path and line number.
- `registry/index.ts` — `loadRegistry` collects *every* parse failure and
  duplicate name before throwing, rather than dying on the first. Plus
  `buildRosterDigest` and an explicitly-approximate `estimateTokens`.
- `scripts/dump.ts` — the Phase 0 exit-criterion CLI.

66 tests written across 4 files. None have run.

### Findings

**1. Eight agent files are not valid YAML.** They write an unquoted
`description` containing a colon-space, which terminates a plain scalar, so a
conforming parser rejects the file. A naive `yaml.parse` would have thrown on
every one and silently cost us 8 agents — including `gdpr-ccpa-compliance` and
`hipaa-compliance`, the two compliance specialists the legal and tax use cases
route to.

Affected: `gdpr-ccpa-compliance`, `hipaa-compliance`, `assumption-mapping`,
`backlog-grooming`, `growth-loops`, `ab-test-analysis`, `cohort-analysis`,
`first-principles-thinking` — the same 8 that omit `model:`, i.e. one
contributor's house style.

Handled by a narrow normalisation pre-pass. This is a *silent repair*, which
FR-R2 otherwise forbids; the deviation and its reasoning are recorded in
PLAN.md §2.1. The real fix is upstream.

**2. The catalog holds 154 agents, not 164.** The earlier figure counted the 10
category `README.md` files. Corrected throughout PLAN.md.

**3. PLAN.md described `model:` as "often inherit".** Wrong — `sonnet` is the
plurality at 103 of 146. Corrected.

### Known risks carried forward

- `yaml` v2's `YAMLParseError.linePos` shape is assumed. If it differs, line
  numbers degrade to `undefined` at runtime (non-fatal), but `tsc` could fail.
- `@agent-office/shared` exports TypeScript source. Works under `tsx` and
  `vitest`; needs a build step before anything runs under bare Node.
- The 154-agent assertion is a deliberate snapshot. Adding an agent fails it.

### Blockers

- **Node.js not installed.** Blocks verification of everything above.
- **`claude` CLI not on PATH.** Blocks Phase 1 entirely.

### Next

Phase 2 (orchestrator core) is the only remaining phase that depends on neither
missing binary, so it can proceed while those are installed.

---

## Phase 2 — Orchestrator core (headless)

**Status: built, unverified.** Still no Node, so none of the 191 tests have run.
The stated exit criterion — an end-to-end run producing reports and a synthesis,
checked on two domains — is **not met**. What exists is the whole pipeline
written and unit-tested against a deterministic fake provider.

### The unblocking decision

Phase 2 needs something to execute agents, and Phase 1's Claude Code adapter is
blocked on a missing CLI. Rather than wait, the orchestrator was built against
the **provider interface** (§1.6) with a `ScriptedProvider` behind it.

That was going to be necessary regardless. Testing concurrency caps, timeouts,
cancellation and partial failure against a real model would be slow, expensive
and non-deterministic — the scripted provider is the only way those paths get
covered at all. It is registered as a real `ProviderId` rather than hidden in
test files, so `npm run run -- "task" --provider scripted` exercises the entire
pipeline at zero cost.

### What was built

**Provider seam** — `providers/types.ts`, `providers/scripted.ts`.
One deviation from PLAN.md §1.6, recorded in the file: `AgentRunRequest` carries
an `assignmentId`. Every `AgentEvent` is stamped with one, and the alternative —
having the caller rewrite each event — puts provider knowledge back into the
orchestrator, which is precisely what the seam exists to prevent.

**Persistence** — `store/` (`types`, `util`, `memoryStore`, `fileStore`).
Atomic writes are temp-file + `fsync` + `rename` within the same directory, since
`rename` is only atomic inside one filesystem. Applied to reports as well as
`run.json`. Report paths come from the Manager's LLM-generated `deliverable`
field and are treated as untrusted: anything escaping the run directory is
rejected (NFR-1).

**Manager** — `orchestrator/manager.ts`.
Planning and synthesis, both composed from the catalog's own orchestration
agents (FR-M1). `extractPlanJson` handles the four ways a model wraps JSON. The
repair loop feeds specific validation errors back and, for hallucinated agent
names, the valid-name list (FR-M2/FR-M3). Provider failures deliberately do not
consume the repair budget — feeding "CLI exited 1" back as a validation error
cannot help the Manager.

**Dispatcher** — `orchestrator/brief.ts`, `orchestrator/dispatcher.ts`.
Phase sequencing, concurrency cap, per-assignment timeout, cancellation, token
budget.

**Runner and CLI** — `orchestrator/runner.ts`, `scripts/run.ts`.

### Decisions worth remembering

- **A dependent whose dependency failed is skipped, never run.** Briefing it
  without the report it declared a dependency on would silently degrade its
  input instead of failing visibly.
- **Cancellation mid-flight leaves the assignment in `working`.** The persisted
  run then shows where it was interrupted rather than misreporting a failure.
- **Exhausting the token budget skips synthesis.** Synthesis is itself a large
  call; spending more tokens to report running out of tokens is the wrong trade.
  Partial reports are preserved on disk (FR-M8).
- **The brief carries the task, the objective, and declared dependencies only.**
  With a shared context, every agent's prompt grows with every other agent's
  output and run cost becomes quadratic in team size.
- **The run passes through `designing` as a no-op.** Phase 5 fills the step in
  without disturbing the surrounding transitions.

### Known risks carried forward

- **The planning prompt's worked example uses a software trio**
  (`backend-developer`, `security-auditor`, `code-reviewer`). Models anchor hard
  on examples; the first legal or tax run is where this shows. Fix is a
  non-software example or rotation by domain.
- **Synthesis truncates at 24k chars per report.** Twelve agents still overflow.
  Documented as a degradation, not a fix — hierarchical synthesis is the answer.
- **`JSON.parse` is strict**; trailing commas and comments cost a repair attempt.
- **`rename` over an open `run.json` on Windows** can return `EPERM`/`EBUSY` if
  antivirus or a file watcher holds a handle. This is the highest-frequency
  filesystem operation in the app (NFR-2 saves after every transition), so it may
  need a retry loop.
- **`listRuns` reads every `run.json`** — an argument for the Phase 7 SQLite
  move, not a bug.

### Blockers

Unchanged: **Node.js not installed** blocks all verification; **`claude` CLI not
on PATH** blocks Phase 1.

### Next

Phase 3 (web shell) needs Node to be useful, so the honest next step is
installing Node and running `npm test` + `npm run run -- "..." --provider
scripted` to close out Phases 0 and 2 for real.

---

## Verification pass — Phases 0 and 2 closed out

**Status: both phases are now done.** The "Blockers" section directly above is
obsolete and is left in place only as the record of what the previous entry
believed.

### The blockers were not real

Node **v24.19.0** and npm **11.17.0** were already installed at
`C:\Program Files\nodejs`, on the machine `PATH`. The shell that reported them
missing had been open since before the install and was holding a stale
environment. The Claude Code CLI was likewise present, at
`%APPDATA%\Claude\claude-code\2.1.222\claude.exe` — genuinely not on `PATH`, but
installed. Nothing had to be installed to close these phases.

Lesson worth keeping: "not installed" was inferred from a `PATH` lookup in one
long-lived shell. That is not the same check, and it cost the project two phases
of assumed-blocked time.

### Results

- `npm run registry:dump` — **154 agents across 10 categories.** Phase 0 exit
  criterion met.
- `npm test` — **198 passing.** (196 after repairs, plus 2 new regression tests.)
- `npm run typecheck` — clean, both packages. This also retires the carried-forward
  risk that `yaml` v2's `YAMLParseError.linePos` shape might not typecheck. It does.
- `npm run run -- "..." --provider scripted` — end to end on **two domains**,
  legal and software, each producing three agent reports, three event logs, a
  synthesis and a `done` run state. Phase 2 exit criterion met.

### What was broken

**1. The registry test resolved the repo root two levels too high.**
`index.test.ts` walked six directories up from `src/registry`, landing on
`C:\Users\KD-AI` instead of the project. Its own comment gave it away —
`packages -> agent-office -> output -> repo root` describes the old nesting
inside the catalog repo, which the initial commit moved out of. Ten tests were
failing on a path that stopped existing when the project moved. `scripts/dump.ts`
had the correct depth all along, which is why the dump worked and the tests did
not.

**2. `extractPlanJson`'s array test did not test what it claimed.**
`rejects a top-level array` used `[{"a": 1}]`, which contains a salvageable
object, so greedy brace extraction recovered `{"a": 1}` and the call did not
throw. The implementation is right — `tryParseJsonObject` explicitly refuses
arrays, and salvaging an object out of surrounding noise is the documented
behaviour of every neighbouring test. The fixture was wrong. Now `[1, 2, 3]`,
with the array-wrapper salvage documented as its own test.

**3. The scripted provider could never complete a run.** The CLI gave every
provider call the same markdown placeholder — but the Manager's planning turn
goes through the provider too, and it requires JSON. Planning got prose, burned
all three repair attempts, and the run failed. So the "no-cost end-to-end dry
run" had never once run end to end.

This is the interesting one: the orchestrator's 191 unit tests all passed,
because they drive their own fakes. The registered `ScriptedProvider` — the one
the CLI actually uses — was never exercised against the real Manager. A seam
tested only from one side.

Fixed in `scripts/run.ts` by scripting both manager turns via `byAssignment`
(`manager-plan`, `manager-synthesis`) and leaving `fallback` for agents. The
canned plan picks a team by keyword — legal, tax, software, or a general
fallback — and every name in it is validated against the registry before use, so
a renamed agent fails loudly at startup instead of as a mystery repair loop. The
plan is two phases with a real dependency edge, so the dry run covers phase
sequencing, `dependsOn` briefing and intra-phase parallelism.

**4. Concurrent `run.json` writes fail on Windows with `EPERM`.** Predicted in
the Phase 2 risk list as something that "may need a retry loop". It is worse
than that: it was a hard run failure, hit on the first real run, and the cause is
self-inflicted rather than environmental. Assignments in a parallel phase each
save on every transition, so two `rename` calls target one `run.json` at once —
and on Windows the loser gets `EPERM`, not last-writer-wins.

Measured directly: **13 of 40** unserialised concurrent atomic writes to one path
fail on this machine.

Fixed with both halves, because they address different causes:

- `saveRun` and `writeReport` now go through the existing `enqueue` chain, keyed
  by absolute path. That removes the self-inflicted race entirely — this is the
  actual fix, and the reason the risk list's "retry loop" alone would have been
  the wrong answer.
- `renameWithRetry` backs off over ~330ms on `EPERM`/`EBUSY`/`EACCES`, for
  handles this process does not own: antivirus mid-scan, a file watcher, an
  editor with `run.json` open. Serialisation cannot help with those.

Two regression tests cover it.

### Risks retired

- `YAMLParseError.linePos` — typecheck is clean.
- Windows `rename` contention — fixed and tested, no longer a carried risk.
- "154 agents" as an unverified snapshot — the dump confirms 154.

### Risks still carried forward

Unchanged from Phase 2: the planning prompt's software-trio worked example will
bias the first real legal or tax run; synthesis truncates at 24k chars per
report; `JSON.parse` strictness costs a repair attempt on trailing commas;
`listRuns` reads every `run.json`.

New:

- **Phase 1 must resolve the `claude` binary at run time.** The install path
  contains the version (`...\claude-code\2.1.222\...`) and there is no shim on
  `PATH`. Hardcoding it means the provider breaks on the next Claude Code update.
  See `SETUP.md` for the suggested resolution order.
- **The scripted provider's keyword routing is deliberately crude.** It exists so
  the dry run touches more than one domain. It is not a planner and must not grow
  into one.

### Next

Phase 1 is now unblocked and is the natural next step: capture a real
`stream-json` fixture from the installed CLI, then build the parser against it.
Phase 3 (web shell) is equally available and depends on nothing missing.

---

## Phase 3 — Web shell + live wiring

**Status: done.** Every exit criterion was exercised in a real browser against
the real orchestrator, not asserted from tests alone.

### How it was built

Two agents worked in parallel against a contract written first. `shared/wire.ts`
pins the HTTP routes, both WebSocket message unions, the buffer limits and the
cost helpers; it was read-only for both agents, and each was told to report
contract friction rather than edit it. That constraint is what made the split
safe — a silent contract edit from one side would have invalidated the other's
work. Server and client were then integrated in one pass.

### What was built

**Server** (`packages/server/src/http/`) — `RunSupervisor` owns live runs:
`startRun` returns as soon as the store allocates an id and leaves `executeRun`
running detached, so `POST /api/runs` never blocks. Per-run `AbortController`,
per-run ring buffers for events and log lines with a sticky truncation flag,
subscriber fan-out, and in-memory state for live runs falling back to disk for
finished ones. `buildServer` implements every route in the contract plus `/ws`,
deriving Fastify's route patterns from the contract's URL builders rather than
retyping them. Binds `127.0.0.1` with no override flag (NFR-6).

**Client** (`packages/web/`) — Vite + React, deliberately plain. A `RunSocket`
that validates every inbound frame, backs off on reconnect and re-subscribes on
open; a hook that replaces state wholesale on `snapshot`/`state` and appends on
`event`/`log`; task form, run list, assignment table, activity log, report
viewer, cancel, cost counters.

### Verified in the browser

- Typed a task, watched statuses move `pending → briefing → working → done`.
- **Refreshed mid-run**: the run was re-selected from `localStorage`, the
  snapshot restored state *and* pre-refresh history, and the UI kept following
  the run live to completion (NFR-2).
- Cancelled mid-run: reached `cancelled` with the abort reason surfaced.
- Read the synthesis and per-assignment reports in-app.

### Two cost defects found by using it

Unit tests missed both. Only running the thing exposed them.

**1. Scripted runs reported money as spent.** Cost was derived by joining
`agentName` → the agent's catalog `model:` → a price. But the catalog model says
what an agent *would* cost through a real provider, not what the run spent, so a
`scripted` run — which calls no model at all — priced itself off `sonnet` and
displayed **$0.0052**. `RunState` recorded nothing about which provider ran.

Fixed by persisting `RunState.provider`, stamped before the first transition so
even a run that dies in planning carries it. The client had worked around this
with a `localStorage` guess that only covered runs started in that same tab;
that workaround is gone.

**2. The run total excluded the Manager entirely.** `totalUsage` sums
assignments, and the Manager's planning, repair and synthesis turns are not
assignments — so nothing recorded them. A three-agent run displayed
**1500 in / 750 out** when it had actually spent **4700 / 1750**. The Manager
outspent the entire team, and it was invisible.

Fixed with `RunState.managerUsage`, accumulated in `executeRun` — the only layer
that sees both manager calls — plus a `runTotalUsage` helper. Deliberately kept
separate from `totalUsage`, which scopes the dispatcher's token budget (FR-M8):
changing that would have altered budget semantics as a side effect of a display
fix. Four regression tests in `orchestrator/runner.test.ts`.

### Decisions worth remembering

- **`--step-delay` on `serve.ts`.** A scripted run finishes in under a second,
  which makes live status and reattach impossible to observe or test by hand —
  the run is over before a refresh lands. Slowing the fake provider is the only
  way to exercise those paths without spending tokens, the same argument that
  justifies the scripted provider itself. Both defects above were found through it.
- **The client never merges deltas.** `snapshot` and `state` are whole
  replacements. Reattach therefore needs no reconciliation logic in the browser.
- **Buffered log lines are replayed as ordinary `log` messages after
  `snapshot`**, because `snapshot` has no `logs` field. Functionally correct, but
  the contract mandates `LOG_BUFFER_LIMIT` with no way to deliver it — a wart.

### Known gaps carried forward

- **The dispatch token budget still ignores manager usage.** A run can exceed its
  real budget by the Manager's share. Deliberately not changed here; FR-M8 should
  be revisited on its own terms.
- `snapshot` has no `logs` field (above).
- **SIGINT graceful shutdown is unverified.** Windows has no real signal delivery
  to another process, so it could not be exercised end to end. The
  `supervisor.shutdown()` logic beneath it *is* unit-tested.
- Ring-buffer overflow is unit-tested but never hit by a real run: the limit is
  2,000 events and a scripted run emits ~20.
- The server does not serve the built client; `npm run web` is a separate Vite
  process. Fine for development, wrong for a shipped local app.
- The scripted provider's keyword routing sent "audit the payments service" to
  the tax team. It is a demo stub, not a planner, and must not grow into one.

### Next

Phase 4 (pixel office) replaces the assignment table with the sim and changes
nothing about the orchestrator. Phase 1 (real provider) remains unblocked and is
what makes any of the cost display meaningful.
