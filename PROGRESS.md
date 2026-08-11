# Progress

One entry per phase, newest last. Each phase ends in a commit.

Status vocabulary: **done** (built and verified) · **built, unverified** (code
written, not executed) · **blocked** · **not started**.

| Phase | Status | Committed |
|---|---|---|
| 0 — Foundations (registry + contracts) | **done** | yes |
| 1 — Provider layer + Claude Code adapter | **built and verified against the real CLI, except the model call** — blocked on `claude auth login` | yes |
| 2 — Orchestrator core (headless) | **done** | yes |
| 3 — Web shell + live wiring | **done** | yes |
| 4 — Pixel office sim | **done** | yes |
| 5 — Designer step + PDF export | **done** | yes |
| 6 — Domain breadth | not started | — |
| 7 — Provider expansion + polish | not started | — |
| 8 — Dark neon terminal interface | not started | — |

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

---

## Phase 1 — Provider layer + Claude Code adapter

**Status: built, and verified against the real CLI up to the model call.** The
exit criterion is *not* closed, for one reason: the installed CLI is not signed
in. Everything either side of the model call has been exercised against the real
binary; nothing has yet received a real model response.

### The CLI was not what the plan assumed

PLAN.md §3 insisted the flags and event shapes be captured rather than assumed,
and that was the right instinct — the assumptions in the plan were wrong in ways
that would each have cost a debugging session:

- **`--verbose` is mandatory** with `--print --output-format stream-json`.
  Without it the CLI exits 1 with a usage error and emits no JSON at all.
- **`--system-prompt-file` and `--append-system-prompt-file` exist** but appear
  nowhere in `--help`. They matter: they avoid Windows' ~32k command-line limit
  and all the quoting that comes with passing a markdown document through argv.
- **`--tools` and `--allowedTools` are variadic** (`<tools...>`), so they consume
  following argv entries. Each must be given exactly one comma-joined token or
  the flag eats whatever comes next.
- **`--max-budget-usd` exists**, which gives FR-M8 something it never had: a
  spend ceiling enforced *during* an assignment rather than checked after it.
- The prompt can arrive on **stdin**, and with stdin closed and no prompt the CLI
  exits cleanly instead of hanging.

Two traps are worth naming because both are silent:

- **`is_error`, not `subtype`, says whether a run succeeded.** A genuinely failed
  run emits `{"is_error": true, "subtype": "success"}` — both, together.
- **Errors arrive dressed as assistant turns.** The CLI fabricates an assistant
  message (`model: "<synthetic>"`) carrying the error text. An adapter that
  trusts `type: "assistant"` writes `Not logged in · Please run /login` into the
  agent's report as though the agent had written it.

### How it was built

Same shape as Phase 3: the contract first, then parallel work against it.
`protocol.ts` (raw frame schemas) and `fixtures/` were written first from a real
capture and made read-only for three agents working simultaneously on the
parser, binary resolution and tool mapping. All three reported zero contract
friction; two independently caught an error in their own brief, which is the
behaviour the read-only rule is meant to produce.

### What was built

- `protocol.ts` — frame schemas, every one `.passthrough()` with only the
  discriminant required. A strict schema would turn each CLI release into an
  outage.
- `parse.ts` — line splitter and normaliser, separable so the adapter can drive
  both. Chunk boundaries have no relationship to line boundaries, so the splitter
  is the load-bearing piece; it is tested by feeding identical fixtures at 1-byte,
  7-byte and whole-file chunk sizes and asserting the event sequences match.
- `resolveBinary.ts` — versioned-install discovery with a numeric version compare
  (a string sort puts `2.1.99` above `2.1.222`), plus a preflight distinguishing
  *not installed* from *not signed in* with different, actionable messages.
- `tools.ts` — catalog `tools:` → CLI flags.
- `childProcess.ts` — spawn, and a tree kill that actually works on Windows.
- `provider.ts` — the adapter.
- `scripts/agent.ts` — the exit-criterion CLI.

### Findings worth keeping

**1. 114 of the 154 agents request `Bash`, which does not exist on Windows.** The
real `system/init` capture lists `PowerShell` and no `Bash` at all. Left alone,
three-quarters of the catalog would have been handed a shell tool the session
does not have. `Bash` is remapped per platform and every remap is reported rather
than silent.

**2. `child.kill()` does not kill descendants on Windows.** The CLI shells out,
and those grandchildren keep the pipes open — so a cancelled assignment hangs
instead of ending, while the model call carries on billing. `taskkill /T` walks
the tree; POSIX gets the same guarantee from a process group.

**3. Omitting `--tools` means "all tools", not "no tools".** For an agent whose
requested tools were all unmappable, the natural implementation — skip the flag
when the list is empty — grants everything. It is now always passed, empty if
need be, so the failure mode is a useless agent rather than an unsandboxed one.

**4. One failure was reported twice.** Found by testing, not by reading: a fatal
error arrives once as the fabricated assistant turn and again in the terminal
`result` frame, restated verbatim. The parser sees one frame at a time and cannot
tell the second from a new problem, so de-duplication lives in the adapter, keyed
on the message — a genuinely *different* second failure still shows.

### Verified against the real binary

With only the preflight bypassed, the adapter drove the installed CLI end to end:
real argv, real spawn, real chunked stdout, real stream-json. It produced exactly
one fatal error carrying the CLI's own message, no leaked error text, no hang,
and a clean stream end. That covers every part of the path except a successful
model response.

`npm run agent -- "..."` today prints:

```
provider unavailable: Claude Code CLI is installed (…\2.1.222\claude.exe)
but not authenticated. Run "claude auth login" to sign in, then retry.
```

368 tests pass; typecheck is clean across all three workspaces.

### Blocker

**`claude auth login` has not been run.** Signing in is an account credential
action and belongs to whoever owns the account, so it is not something this
project does on the user's behalf. Until then the Phase 1 exit criterion — one
agent streaming normalised events from a real model — cannot be closed.

### Known gaps carried forward

- **The successful-path fixture is derived, not captured.** `synthetic-success.jsonl`
  reproduces content-block shapes confirmed from local session transcripts inside
  an envelope the real capture proves, but frames unique to a *successful* run
  have never been observed on this wire format. Capture a real one immediately
  after signing in; the exit-criterion script prints unrecognised frames rather
  than dropping them, so a mismatch surfaces at once.
- **Per-agent model selection does not reach the adapter.** `AgentRunRequest`
  carries no `model`, so the catalog's `model:` frontmatter — which the Phase 3
  cost display already joins on — cannot be honoured. `--model` is provider-wide
  today. Closing this means adding a field to the provider seam and passing it
  through the dispatcher.
- **The system prompt is appended, not replaced,** so the agent also receives
  Claude Code's default prompt. A deviation from FR-M5's "nothing else", taken
  because replacing it discards the runtime's own operating instructions while
  keeping the tools. `--replace-prompt` switches it; which is better is an open
  question that only a real run can answer.
- **Cache tokens are summed into the input count.** Cache reads are cheaper than
  fresh input and cache writes are dearer, so the total is an approximation.
  Dropping them would be worse — a run reading 40k cached tokens would display
  200 — but NFR-5's cost figure is not exact until pricing is per-counter.
- The `permission_denials` array in the result frame is parsed but not surfaced
  as events, so a denied tool is currently invisible to the UI.
- Nothing has measured what a real run costs, so FR-M8's budget defaults remain
  guesses.

---

## Phase 4 — Pixel office sim

**Status: done.** Both exit criteria were exercised in a real browser against the
real orchestrator: a run is watchable as an office scene, and a saved run
replays offline with no provider involved.

### How it was built

Contract first, then four agents in parallel — the same discipline as Phases 3
and 1, but with two contracts rather than one, because Phase 4 had two places
where parallel work would otherwise have deadlocked.

`sim/model.ts` is the spine: desk layout with reflow, deterministic
agent→appearance, and behaviour read straight from `ASSIGNMENT_BEHAVIOUR`. It
imports nothing from Pixi, React or the DOM, so the entire sim is testable
without a canvas — 18 tests before a single pixel existed. `sim/spriteContract.ts`
is the second contract, pinning the seam between sprite *generation* and sprite
*rendering* so those two could be built at the same time instead of in sequence.

Four agents then worked on the events endpoint, the procedural sprites, the Pixi
renderer and replay. All four reported zero friction against the contracts.

### The defect that mattered

**Status transitions were never written to disk.** Checking what the event logs
actually contained, across every run in `runs/`, returned
`{ usage: 38, text: 38 }` — and not one `status` event. The dispatcher emits
them, but through a different path than provider events: provider events called
both `appendEvent` (persist) and `onEvent` (broadcast), while `setStatus` called
`onEvent` alone.

Live viewers therefore saw characters move, while the on-disk log — replay's
only source — recorded nothing about status. Replay would have shipped rendering
every character frozen in `pending`, looking exactly like a renderer bug and
being nothing of the kind.

This is a change to the orchestrator, which the phase brief said not to touch. It
is a persistence bug that made a required feature impossible, not a behaviour
change: nothing about dispatch, ordering or run outcomes moved. Fixed in
`dispatcher.ts`, with a regression test asserting both that transitions reach
disk and that `working` precedes `done`, since the on-disk order is what the fold
consumes. A fresh run now persists 12 transitions where it persisted none.

### Other findings

- **Pixi v8 `Application` is a bare shell until `await app.init()` resolves** —
  `app.ticker` does not exist before then. React StrictMode makes tearing down a
  half-initialised app the *common* path, not an edge case, since it mounts and
  unmounts synchronously in development. The first browser load crashed on
  exactly this. The in-flight init was already guarded; `destroy()` simply
  reached past the guard.
- **The canvas host must have a bounded height.** The renderer sizes its canvas
  from the host's client box, and a host with no upper bound produced a
  118×8918 canvas on first render.
- **Host height decides sprite size**, because scaling is integer-only. A
  three-agent office is 240px tall, so a 420px host allowed only 1× — visibly
  tiny in a wide pane. 520px clears 2× for one- and two-row teams; a three-row
  team falls back to 1× rather than being cropped.
- **The shared barrel did not re-export `RunEventsResponseSchema`**, so the
  client briefly carried a hand-kept copy of a wire shape — the exact drift
  `wire.ts` exists to prevent. The barrel was fixed and the copy deleted.
- **The sprite contract did not name the concrete export.** A mismatched export
  name typechecks fine on both sides in isolation and only fails where they
  meet; the convention is now stated in the contract.

### Verified in the browser

- The office renders: tiled floor, Manager's desk, one desk per agent, distinct
  characters with nameplates.
- **Click-to-inspect (FR-S5)** — clicking a character hit-tests to the right
  assignment and opens its panel with category, description, status, tokens and
  cost. A scripted run still reads **$0.00**, so the Phase 3 cost fix holds
  through the new path.
- **Replay (NFR-7)** — playing a saved run reconstructs
  `briefing → working → done` for the lead, and only then both reviewers moving
  in parallel. That is the real run's dependency shape, rebuilt from the log
  alone.
- **Seeking backwards is exact**: returning to 0 reproduces the same state as
  arriving there the first time, because every position re-folds from scratch.
- Token totals accumulate mid-replay (3200 → 3700 → 4700).
- Toggling views four times leaves zero errors and exactly one canvas — no
  teardown crash, no leaked renderer.

467 tests pass; typecheck is clean; the client builds.

### Deliberate deviations

- **Sprites are generated, not sourced.** PLAN.md §2.3 assumed a CC0 pack. The
  reasoning for generating instead — and its cost — is recorded in `ASSETS.md`.
  FR-S9's manifest abstraction is real, so a pack can still be dropped in by
  implementing one interface.
- **The table stays, behind a toggle.** The plan says replace it. It remains the
  only view showing every assignment's numbers at once, and it is what made
  Phase 3's cost defects visible; deleting a working diagnostic to honour the
  letter of a plan is a bad trade.

### Known gaps carried forward

- **Manager usage does not replay incrementally.** It is a run-level field with
  no event representation, so it is carried from the base run and a replay at
  0% already shows the Manager's full spend. Making this exact means the event
  log carrying manager usage.
- **`reportPath` and `error` are approximated during replay.** The dispatcher
  patches them onto persisted state, but the emitted `status` event carries no
  patch, so the fold infers them.
- **The bundle grew from 64.5 kB to 159.7 kB gzipped**, almost entirely Pixi.
  Fine for a local app; worth code-splitting if it is ever served remotely.
- Walking is a straight-line interpolation, not pathfinding — characters pass
  through desks rather than around them (FR-S6 is satisfied, elegantly it is not).
- Hover nameplates show the name only; category and description are in the
  inspect panel rather than a hover tooltip (FR-S4 partially).
- `permission_denials` from Phase 1 is still not surfaced as events.

---

## Phase 5 — Designer step + PDF export

**Status: done.** Both exit criteria met: a run ends with a downloadable PDF,
and a legal-domain run visibly differs in styling from a software one.

### The decision that shaped the phase

PLAN.md's FR-P3 asks for "headless Chromium, fully offline", which normally
means adding Puppeteer and a ~150MB Chromium download. Before writing anything,
Chrome's own CLI was tested directly:

```
chrome --headless --disable-gpu --no-pdf-header-footer --print-to-pdf=out.pdf file:///in.html
```

That produced a valid 28,662-byte, 2-page PDF (`Skia/PDF m151`) with `@page`
margins and `break-after: page` both honoured. So the whole PDF pipeline needs
**zero new runtime dependencies** and reuses the binary-resolution and Windows
tree-kill work from Phase 1. The only package added is `marked` (zero
dependencies) for markdown.

Two details that cost time and are now recorded: `--print-to-pdf` requires an
absolute path, and a relative one fails with `Access is denied. (0x5)` — a
misleading error for what is a path problem.

### What was built

Contract first (`shared/src/report.ts`), then four agents in parallel:
`reports/markdown.ts` (markdown → HTML), `reports/themes.ts` (four print
stylesheets), `reports/pdf.ts` (Chrome resolution + print), `reports/designer.ts`
(theme choice). Assembly (`document.ts`), the pipeline (`deliverable.ts`) and
the runner wiring were integrated afterwards.

The theme set is closed deliberately. FR-P2 asks a *model* to name a theme, and
a model will eventually invent one — so the choice is validated against the
union and falls back, the same discipline FR-M3 applies to agent names. The
briefs describing each theme are shared between the designer's prompt and the
stylesheets, so a theme cannot be chosen for a reason its styling does not
reflect.

### Findings

**1. A contract gap I left, caught by the design that anticipated it.** The
themes and the markdown renderer were written simultaneously, and the class
names connecting them were never pinned — I fixed the theme *ids* in the
contract but not the *class names*. The theme author guessed `.md-table-wrap`;
the emitter produces `.ao-table-wrapper`. Reconciled at integration, and it cost
nothing because the theme author had hedged correctly: visual styling targets
bare `table`/`pre` selectors, and the wrapper classes carry only overflow rules,
so a mismatch loses the overflow safety net rather than the theme. The lesson is
recorded in the file: styling that only works when two independently written
modules agree on a string is styling that will silently vanish.

**2. Adding a real browser to every run broke a unit test.** Once the designing
step was wired in, a supervisor test about event fan-out timed out — it was
launching Chrome on every run. Raising the timeout would have been the wrong
fix: it would also have made the suite require Chromium wherever it runs.
`produceDeliverable` is now an injectable dep on `ExecuteRunDeps` with the real
implementation as the default, and the shared test fixtures inject a stub. The
deliverable pipeline keeps its own coverage against a real browser.

**3. `--print-to-pdf` does not create its output directory** — Chrome exits 0
and writes nothing. Found by the agent building it, not by reasoning.

**4. Cleanup races the kill.** `killTree` is fire-and-forget, so on the timeout
path the browser's teardown can still hold the temp profile directory when
cleanup runs, producing a transient `EBUSY`. Fixed with `rm`'s retry options.

**5. "reliability" contains "liability".** A refactoring task routed to the
legal team, because the scripted provider's keyword router does substring
matching. It is a demo stub and documented as one, but it is a good illustration
of why it must not grow into a planner.

### Deliberate design choices

- **`store.readBinary` rather than `fs` in the route.** `server.ts` holds an
  invariant that it never touches the filesystem, so containment lives in one
  place (NFR-1). Serving a PDF needed bytes, so the store grew a method instead.
  The `RunStore` adapter in `supervisor.ts` forwards methods explicitly with a
  comment saying a missing key there is a compile error rather than a silent
  gap — and that is exactly what caught the new method.
- **The themed HTML is kept beside the PDF.** It is what the PDF was made from,
  so a styling complaint can be investigated without re-running anything, and it
  is a usable fallback on a machine with no browser.
- **Nothing in the design step can fail the run.** By the time it executes, the
  agents have run and the synthesis is on disk. A missing browser is a missing
  attachment, not a failed run (NFR-8) — the reason is recorded and shown.

### Verified end to end

- Two real runs produced valid PDFs: **76,406 bytes / 5 pages** (legal) and
  **75,581 bytes / 5 pages** (software), both `%PDF-`.
- **The exit criterion**: the legal run renders in Cambria serif, the software
  run in Segoe UI sans — different themes, chosen per domain.
- Document structure in both: 1 cover, 3 roster rows, 1 synthesis, 3 appendices,
  a single inline `<style>` block and **no external references** (FR-P3).
- `GET /api/runs/:id/pdf` returns 200, `application/pdf`,
  `Content-Disposition: attachment` with a run-specific filename, and the exact
  76,406 bytes on disk. A run without a PDF returns 404 rather than an empty file.
- The UI shows the download button, the chosen theme and its rationale.

590 tests pass; typecheck is clean.

### Known gaps carried forward

- **No model has ever chosen a theme.** The scripted provider cannot emit a valid
  `DesignChoice`, so every run so far fell back to the domain mapping — honestly
  labelled in the rationale, but the model path is unexercised until Phase 1's
  CLI is signed in.
- **FR-P6 (markdown/per-agent export) and FR-P7 (user theme override) are not
  built.** Both are `should`/`could`.
- Links render as text plus URL, since a printed page cannot be clicked; images
  become text placeholders rather than being fetched.
- The cover shows estimated cost only when the caller computes one; the CLI path
  does not, so it prints an em dash.

---

## Phase 8 — Dark neon terminal interface

Exit criterion: the whole app — not just the office — reads as one dark neon
terminal, with the palette defined exactly once and status still legible
without colour.

### How it was built

The palette went first, as a plain TypeScript module, before any agent started.
That ordering mattered more here than in earlier phases: four agents were about
to edit the stylesheet, the sprite generator, the scene and a settings panel in
parallel, and a colour is precisely the kind of value each of them would
otherwise have invented locally. `theme/tokens.ts` gave them something to import
instead.

Four sonnet agents then worked disjoint files: the stylesheet (zero colour
literals, all `var(--ao-*)`), the status→token mapping plus a WCAG audit, the
office palette swap, and the theme/motion toggles.

### The count that justified the phase

**99 hex literals** in the client before this: 61 in `styles.css`, 23 in
`sim/model.ts`, 11 in `sim/sprites.ts`, plus five numeric colours in
`sim/scene.ts`. Two renderers, two private copies of "what working looks like".
Afterwards the only colour values in `packages/web/src` are in `tokens.ts`,
which a test now asserts by reading the sim files back off disk.

### Findings

- **The contrast audit was measured against the wrong grounds.** The agent
  checked every colour against `--ao-bg` and found one failure. But
  `styles.css` puts panels on `surfaceRaised` and status chips on `sunken`, and
  in dark `surfaceRaised` is *lighter* than `bg` — so `bg` is the easiest
  ground, not the representative one. Auditing the full 4×13 grid found **eight**
  sub-AA pairs, including `statusStopped` at **2.85:1** on the surface it
  actually renders on. `cancelled` and `skipped` badges were effectively
  unreadable. Six token values were retuned; the test now enumerates every
  (text, ground) pair in both themes rather than sampling one.
- **Three copies of the status vocabulary.** The shared unions, `status.ts`'s
  `Record`, and eighteen `.status-<status>` CSS rules with their own glyph set —
  which had already drifted from the glyphs `status.ts` exported to nobody. A
  CSS selector that matches nothing is not an error, so a nineteenth status
  would have rendered as an unstyled chip silently. The stylesheet now keys on
  the eight *tokens*; `StatusBadge.tsx` resolves status→tone in TypeScript,
  where the mapping is total and a new status is a compile error.
- **The office does not follow the light theme, deliberately.** A CRT is a
  screen, and a screen is dark whatever the room is. Inverting it would also
  mean regenerating every sprite texture on a theme switch.
- Sprite ramps are tuned dimmer than the status hues on purpose: a desk full of
  characters must never out-shout the one badge saying something failed.

### Verified in the browser

- Boots dark with no white flash — `applyBootTheme()` runs before `createRoot`,
  since a stylesheet written entirely against custom properties has no colours
  at all until they are set.
- Switching to light repaints tokens, body and badges (`--ao-bg` `#0b0e12` →
  `#f2f5f8`, badge `rgb(71,224,122)` → `rgb(24,110,55)`); switching back
  restores. Motion Off sets `data-ao-motion="off"`. Both persist to
  `localStorage` and survive reload.
- Badges render glyph-plus-label (`✓done`), so greyscale and colour-blind
  readers get the state from shape and text.
- No console errors, and no font or network request beyond the app itself
  (FR-U6).

**744 tests pass; typecheck is clean.**

### Known gaps carried forward

- **The office's rendered pixels are not verified in-browser.** Pixi does not
  preserve the WebGL drawing buffer, so a canvas readback returns black — that
  is a limitation of the check, not a finding about the office. Its palette is
  covered by unit tests (including one asserting no colour literals survive in
  `sim/`), not by a screenshot.
- Screenshots were unavailable in this environment, so every visual claim above
  rests on computed styles and the DOM rather than on an image.
- FR-U5's scanline and flicker effects were not built. The motion switch and
  `prefers-reduced-motion` gating are in place for the effects that exist (the
  live-dot pulse, the active-status glow, and a static under-desk work glow).
- `accentDim`, `line` and `lineFirm` are exempt from the contrast grid as
  decorative. A test pins that claim so it cannot rot into an excuse.
