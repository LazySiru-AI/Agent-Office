# Progress

One entry per phase, newest last. Each phase ends in a commit.

Status vocabulary: **done** (built and verified) · **built, unverified** (code
written, not executed) · **in progress** · **blocked** · **not started**.

| Phase | Status | Committed |
|---|---|---|
| 0 — Foundations (registry + contracts) | **done** | yes |
| 1 — Provider layer + Claude Code adapter | **done** — exit criterion closed against a real signed-in CLI | yes |
| 2 — Orchestrator core (headless) | **done** | yes |
| 3 — Web shell + live wiring | **done** | yes |
| 4 — Pixel office sim | **done** | yes |
| 5 — Designer step + PDF export | **done** — no model has ever chosen a theme | yes |
| 6 — Domain breadth | **done** — routing untested, no model has planned anything | yes |
| 7 — Provider expansion + polish | **built, unverified** — no key has ever been used | yes |
| 8 — Dark neon terminal interface | **done** | yes |
| 9 — The office states what it is doing | **done** | yes |
| 10 — The office becomes a room | **done** | yes |
| 11 — Override the team before dispatch (FR-M11) | **done** | yes |
| QA passes — five reviewers, then the design team, then two in parallel | **done** | yes |
| Security audit — first pass (AO-1/2/5/7/9, SEC-06/08) | **done** | yes |
| Security audit — second pass (AO-6/8/10/11, AO-R07, SEC-07) | **done** | yes |
| AO-3 — dependency majors + the audit as a hard gate | **done** | yes |
| MCP toolset — Stages 1–4 | **done** — never carried a live model's tool call | yes |
| 12 — Documentation truth | **done** | yes |
| — Diagnostics log (warnings, failures, agent notes) | **done** — no live model has written a marker yet | yes |
| 14 — Ask before planning (FR-M12) | **done** — verified in the browser; no live model has run the round | yes |
| 13 — One key, four exit criteria | **done for two of four** — routing and the designer closed against a live model; the adapters and MCP Stage 4 still need a key | yes |

The security passes and the MCP stages are deliberately unnumbered. They were
audit-driven workstreams rather than planned phases, and numbering them after the
fact would imply a plan that did not exist when they were done.

This table went stale for three phases while the per-phase entries below it were
kept current — 6, 7 and 8 were all committed while it still read "not started".
Worth a moment's thought, because it is the same failure the QA pass below found
everywhere else in the project: a summary that nobody re-derives drifts from the
detail it summarises, and the summary is what people read.

**It then happened again, larger.** Between Phase 10 and this line, seven commits
landed — FR-M11, two security passes, a dependency major, four MCP stages and the
office captions — and *none* of them were recorded here. The document that
explains why the code is the way it is stopped at Phase 10 while the code went on
for another seven commits, including the two that changed what an operator has to
do to run the thing at all. The entries below the Phase 10 one are that backfill,
written from the commits and re-verified against the working tree rather than
recalled.

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
`C:\Users\<user>` instead of the project. Its own comment gave it away —
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

### Blocker — since cleared

**`claude auth login` had not been run.** Signing in is an account credential
action and belongs to whoever owns the account, so it was not something this
project could do on the user's behalf. It has since been done; see
"Phase 1, closed" below.

### Known gaps carried forward

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

## Phase 1, closed — what a real model call changed

**Status: done.** `claude auth status` reports `loggedIn: true`, and
`npm run agent -- "..."` ran a `code-reviewer` against a throwaway workspace on
`haiku`: real spawn, real argv, real stream-json, real tool calls (`Glob`,
`Read`), a real review streamed back, clean exit. The exit criterion — one agent
streaming normalised events from a real model — is met.

Three of the gaps listed above are answered below. The rest still stand.

### Reaching the CLI at all was the first defect

`claude auth login` failed from an ordinary PowerShell window with
`CommandNotFoundException`, on the very path §2 of SETUP.md had verified.

Claude Desktop is an **MSIX-packaged app**, so `%APPDATA%\Claude` is
virtualised: it resolves for a process running inside the package container and
does not exist outside it. A shell spawned by the desktop app finds the binary
there; a normal terminal does not. Both are views of one file, whose real home
is `%LOCALAPPDATA%\Packages\Claude_<publisher>\LocalCache\Roaming\...`.

`knownInstallRoots` searched only the virtualised path, so **starting the server
from a normal terminal failed discovery outright and reported "not installed"** —
wrong, and more confusing than the likelier truth, which is "not signed in". The
package root is now a second install root, with the publisher hash globbed
rather than hardcoded (it varies per install) and `%APPDATA%` still tried first,
so in-container behaviour is unchanged.

### The success wire format was not what the fixtures said

The old fixtures README named this risk precisely — "if 2.1.222 wraps successful
frames differently from failing ones, the parser is tested against the wrong
envelope" — and it was right. A real run emits four things the unauthenticated
capture never did: `rate_limit_event` (a top-level frame type, duly reported as
unrecognised the first time the script ran), `system/thinking_tokens`,
`system/post_turn_summary`, and `assistant` frames carrying `thinking` blocks.

**The expensive one was token accounting.** The CLI emits one `assistant` frame
per *content block* and repeats the whole message's `usage` on each. Both
`dispatcher.ts` and `runner.ts` sum usage events, and the token budget halts on
that sum:

| | summed from assistant frames | `result` frame |
|---|---|---|
| input | 135,270 | 67,635 |
| output | 10 | 579 |

Exactly 2x on input, 1.7% on output — wrong in both directions at once, so the
budget would trip early on input and never on output. `message.usage` is not a
per-turn increment, which is what the code assumed, in a comment that reasoned
carefully from a false premise and warned against the fix. Usage now comes from
the `result` frame alone, and is emitted on the failure branch too, so a run
that died partway is not costed at zero.

The tradeoff: usage arrives once per assignment instead of ticking up during
one. The in-run spend guard does not rest on it — `provider.ts` passes
`--max-budget-usd`, so the CLI enforces the cap on its own side mid-turn, and
the dispatcher's budget still halts subsequent assignments on accurate totals.

`real-success.jsonl` is that capture, redacted for identifiers and machine
specifics only. `parse.test.ts` asserts both columns above against it, so a CLI
that changes shape fails loudly rather than quietly mis-billing.

### What one real run cost

**$0.0534808** for three turns on `haiku` against a 12-line file, with 22,731
cache-creation tokens dominating a trivial task. FR-M8's defaults are
better-informed than they were, but one short haiku run says little about a full
multi-agent office on sonnet, so they remain estimates.

Two things this exposes, both still open: `total_cost_usd` sits on the result
frame unused, right next to the usage this adapter now trusts — the CLI has
already done the per-counter arithmetic `pricing.ts` approximates. And of those
67,635 input tokens, 26 were uncached; pricing them all at the fresh-input rate
is not a rounding error.

1301 tests pass; typecheck is clean across all three workspaces.

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

---

## Phase 6 — Domain breadth

Exit criterion: five domain tasks each produce a sensible team and a coherent
PDF, with routing errors documented and addressed.

### The gap the phase was named after

The catalog had `legal-advisor`, `risk-manager`, `fintech-engineer` and
`quant-analyst` — and **no tax specialist of any kind**. The symptom was sitting
in the code: the scripted provider's `tax` preset fielded `business-analyst` as
its lead, because there was nothing better to name.

Two agents were authored into `07-specialized-domains`, in the catalog's own
format, dividing the domain the way `legal-advisor` and `compliance-auditor`
divide legal:

- **`tax-advisor`** — position and structure. What the treatment is and what to
  do about it.
- **`tax-compliance-specialist`** — obligation and defensibility. What must be
  filed, by when, with what evidence, and whether it survives an audit.

Both are jurisdiction-neutral by construction — the single most common failure
mode for a tax agent is quietly assuming US federal rules — and both carry an
explicit professional-responsibility section: state the statute relied on, never
present a fact-dependent position as certain, and say when a licensed local
practitioner is required. One of them declines to bless positions designed
mainly to obscure substance.

The catalog is now **156**. The 154-agent assertion firing was the intended
behaviour, not an obstacle: it is the only thing that forces the README and
SETUP counts to be corrected in the same commit as the files.

### The domain matrix

Five tasks, run end to end through the scripted provider:

| Domain | Team | Theme | PDF |
|---|---|---|---|
| software | backend-developer, security-auditor, code-reviewer | engineering | 76,018 B |
| legal | legal-advisor, compliance-auditor, risk-manager | legal | 76,679 B |
| tax | tax-advisor, tax-compliance-specialist, risk-manager | financial | 69,725 B |
| research | research-analyst, data-researcher, competitive-analyst | research | 113,322 B |
| product | product-manager, ux-researcher, business-analyst | research | 118,311 B |

All five reached `done` and produced a valid `%PDF-`. Product has no theme of its
own — there are four themes and five domains — so it lands on `research`, which
is the closest fit rather than a defect.

### Findings

- **`includes('tax')` is true of "syntax".** The scripted router matched
  keywords as substrings, so a task about a syntax error would have been handed
  to the tax team, and "elevator telemetry" to the same. Now matched on whole
  words, with both traps pinned as tests.
- **A preset naming a missing agent used to fall back silently.** That is the
  one case where degrading quietly hides exactly the routing defect this phase
  exists to find, so it now throws and names the missing agent. Only "no preset
  matched at all" still falls back.
- **FR-M10's transition was unreachable, and had been for three phases.** The
  state machine carried `reporting -> working` with a comment claiming it
  supported the review loop. It cannot: a reviewer necessarily runs in a later
  phase than its target, phases drain before the next begins, and `reporting`
  lasts only the milliseconds between a provider finishing and its report being
  written. No reviewer can ever observe it. The real edge is `done -> briefing`,
  and it is now written down as the single documented exception to "nothing
  leaves a terminal state" — `failed` and `skipped` stay sealed.
- **A 40-candidate pre-filter loses agents the Manager would have picked.** See
  below. This is the phase's most consequential result.

### FR-R4: built, measured, and deliberately not switched on

The BM25 pre-filter works and cuts the roster digest from **11,067 to 2,748
tokens — 75% smaller**. It ranks the tax query beautifully: `tax-advisor` scores
14.07 against 4.13 for the next non-tax agent, because the agent is named after
the domain.

It is still not wired into `planRun`, and the reason is a number:

```
[FR-R4 recall @40] 10/16 wanted agents survive the cut
  software  kept 3/4  lost: security-auditor
  legal     kept 2/3  lost: risk-manager
  tax       kept 2/3  lost: risk-manager
  research  kept 1/3  lost: research-analyst, data-researcher
  product   kept 2/3  lost: ux-researcher
```

Precision is the wrong thing to measure for a pre-filter. Ranking a good agent
fourth instead of first costs nothing; **cutting it means the Manager cannot
choose it however well it reasons.** Most agents score exactly 0.000 for any
given task, so a top-40 is "the handful that matched, plus the alphabetical head
of the zero-scoring tail" — and `security-auditor` surviving the software cut
would be a property of the alphabet, not of the ranker.

Two failure modes drive it, both inherent to literal-token BM25:

- **No stemming.** The task said "payments", the agent is `payment-integration`,
  and one trailing `s` scored the most relevant agent in the catalog at zero.
  This one was measured and then fixed — regular plurals are now folded, which
  lifted `payment-integration` to #2 and brought `fintech-engineer` into the top
  10. Deliberately plurals only: Porter would also fold `-ing` and `-ed`, and in
  a corpus this small that collapses distinctions that carry meaning.
- **Polysemy, which stemming cannot touch.** "State of the art" matches
  `terraform-engineer`, `react-specialist` and `angular-architect` on
  application state. `research-analyst` and `data-researcher` score zero,
  because a task about surveying literature shares no literal token with their
  descriptions.

Two tests originally written to pin known-bad behaviour now fail because the
behaviour improved. They were rewritten to the measured reality rather than
deleted — the software one still asserts that a coincidental
"review"+"authentication" collision wins the top slot, because it does.

### Verified

- 820 tests pass; typecheck clean across all three workspaces.
- `npm run registry:dump` prints 156 across 10 categories.
- Five domains, five teams, five valid PDFs (table above).
- The review loop was tested at the wiring level, not only as pure logic: a
  verdict marker re-dispatches its target exactly once, with the critique in the
  brief and the marker stripped out of it; an approval leaves the target alone;
  and a report that merely *discusses* revisions does not trigger a paid re-run.

### Known gaps carried forward

- **Still no model has planned anything.** The `claude` CLI is not on this
  machine's PATH, so every plan in the matrix above came from the scripted
  provider's canned presets. That means the teams are *correct by construction*
  — a preset chose them — and this phase has therefore not tested the Manager's
  judgement at all. "Tune Manager selection prompts where routing picks the
  wrong team" cannot be done until a model is picking teams. The matrix proves
  the pipeline, the report themes and the PDFs; it does not prove the routing.
- FR-R4 is available but unused, for the recall reason above. Enabling it needs
  either better recall (embeddings, or expanding a query with the roster's own
  vocabulary) or a floor that always keeps a domain's obvious generalists.
- The review loop never re-reviews. That is FR-M10 as written ("once"), but it
  means nobody checks whether the revision actually addressed the critique.

---

## Phase 7 — Provider expansion

Exit criterion: the same task runs identically through Claude Code and through a
raw API provider, with only a dropdown changing.

### What could not be done, first

There is no API key on this machine, and the Claude Code CLI — which *is*
installed, at `…\Claude\claude-code\2.1.222\claude.exe` — is not signed in. So
the exit criterion's comparison was never run. Nothing in this phase has spoken
to a real model.

What that leaves is worth being precise about. The adapters are verified against
**local fake HTTP servers** that speak the documented wire format: SSE framing,
tool-use loops, streamed tool-call fragments, auth failures, rate limits,
stalls, and chunk boundaries falling mid-`data:` line. That proves this code
behaves correctly *given that format*. It proves nothing about whether the
format matches the live API. Every file concerned says so in its own words
rather than leaving the reader to assume.

### Built

- **Anthropic Messages adapter** — SSE, the tool-use loop, cache-counter folding
  into usage, 30-round bound.
- **OpenAI Chat Completions adapter, serving DeepSeek too.** One class, not two
  files: everything that differs between them — key variable, base URL, model —
  is absorbed by `apiConfig.ts`, and nothing forced a provider-specific branch.
- **Sandboxed filesystem tools** (`apiTools.ts`) — `Read`, `Write`, `Edit`,
  `Glob`, `Grep`, `LS`, confined to one run's workspace. A raw API has no
  filesystem tools of its own, so the adapter supplies them, which means NFR-1
  is enforced by this code rather than by someone else's sandbox.
- **`sse.ts`** — one reader for all three adapters.
- **Settings panel** — provider, concurrency, timeout, budgets, persisted.
- **`GET /api/providers`** — each adapter answers for itself.
- **Run history browser** — search, filters, relative ages.
- **Per-agent provider selection** — `providerFor(agentName)` at the dispatcher.
- **`.env` loading**, so keys live in a gitignored file rather than a shell.

### Findings

- **The sandbox's allowlist was enforced at advertisement, not at execution.**
  `schemas(allowedTools)` decided what the model was *told about*; `execute()`
  ran anything it implemented. A model offered only `Read` could emit a `Write`
  call — from a stale context or a hallucination — and it would be carried out.
  An agent's `tools:` frontmatter is a permission boundary (FR-M5 says a
  provider "must not exceed it"), and one checked only when the menu is printed
  is not a boundary. `createSandboxedTools` now takes the allowlist and refuses
  anything outside it, naming the canonical tools the agent does have so the
  model stops rather than retrying a name that is not a tool.
- **An abort raced the SSE reader.** Passing one signal to both `fetch` and the
  stream reader meant `fetch` errored the body reader with `AbortError` before
  the reader's own cancel ran, and that rejection surfaced as a spurious run
  failure. Caught and swallowed only while `signal.aborted` is true.
- **`--max-budget-usd` has no raw-API equivalent.** `makeProvider` accepts
  `maxCostUsd` for every provider and three of them ignore it. Spend on the HTTP
  adapters is bounded only by `maxOutputTokens` per call and the tool-round
  limit. Recorded in `factory.ts` next to the option, because this is exactly
  the sort of thing that reads as working until the bill arrives.
- **The suite outgrew a 5-second timeout.** Three end-to-end tests began failing
  reliably once this phase added ~190 tests. They pass in isolation and each do
  3–5 seconds of real work; the work did not get slower, it just stopped being
  alone on the disk. Those three now carry an explicit 20s timeout with the
  reasoning written down. Raising the default for everything would have hidden
  a real hang somewhere else.
- **Two provider pickers had appeared.** `TaskForm` had its own dropdown and the
  settings panel had another. The form now states what it will do and the
  settings own the choice.

### Default provider changed to the local CLI

At the user's direction, `claude-code` is now the default for every agent,
replacing `scripted`. That default spends money, which is the deliberate trade:
the previous default called no model at all and produced a report of placeholder
text that reads like a finished run. `scripted` is still there and still free.

Keys come from a gitignored `.env` (see `.env.example`), loaded before any
adapter resolves its configuration. A real environment variable still wins over
the file. The settings UI never sees a key — the browser is told only *whether*
a provider is usable and why not, because availability is all it needs and
anything more puts a credential one screenshot from being shared.

### Verified

- **1,006 tests pass, 4 skipped**; typecheck clean across all three workspaces.
- Every escape vector tried against the sandbox was rejected: `../` traversal,
  absolute and UNC paths, drive-relative paths, NUL truncation, the
  `abc`/`abc-evil` prefix-sibling bug, and case-differing Windows paths.
- **Four symlink-escape tests are skipped, not passed.** Windows refused
  `fs.symlink` without Developer Mode; the defence is implemented and the skip
  prints why. Do not read the green suite as covering it.
- The SSE reader survives every chunk split from one byte upward, and a
  multi-byte character split across two chunks.
- In the browser: `/api/providers` reports each adapter's own reason, an
  unavailable provider blocks the Start button and shows that reason, switching
  to `scripted` clears it, and the history browser's search narrows 30 runs to
  one on "tax ireland".

### Known gaps carried forward

- **The exit criterion is unmet and cannot be met here** — it needs a signed-in
  CLI or one API key.
- Default model names for OpenAI and DeepSeek are guesses that have never been
  sent to a live endpoint. `apiConfig.ts` says so; expect them to be the first
  thing to fix when a real call fails.
- No cost ceiling for the HTTP providers.
- SQLite not adopted: the plan made it conditional on JSON-on-disk hurting, and
  at thirty runs it does not.

---

## QA pass — five reviewers against the whole codebase

Not a phase. Every phase had been declared done by the same person who built
it, which is the arrangement most likely to miss things, so five reviewers were
turned loose on a frozen tree with one instruction: find defects, fix nothing,
and mark every finding CONFIRMED (executed and observed) or PLAUSIBLE (reasoned
from reading). That distinction is the reason this entry can be specific.

They found **29 defects, 21 of them executed**. The eight worst had all shipped
in phases marked done.

### What the split found that the builder had not

The five areas were providers, orchestrator, security, web/contracts, and the
test suite itself. The last of those was the most uncomfortable and the most
valuable: a reviewer whose only job is to distrust the tests found that the
green suite had been green for the wrong reasons in several places.

The pattern across all five is worth naming, because it is not "these are hard
problems". Nearly every defect was a **boundary that was checked in one place
and assumed in another**:

- The tool allowlist was enforced when the menu was printed and again — after
  Phase 7's fix — when food was served, but `schemas()` still trusted its own
  argument rather than the constructor's.
- Path containment made the RUN DIRECTORY the boundary, and then `run.json`,
  the replay logs and the untrusted-agent `workspace/` all sat inside it.
- A 404 helper was carefully written not to leak a filesystem path, and its
  sibling twenty lines away leaked one.
- The token budget was called a per-run budget and scoped to dispatch.
- `providerFor` was documented as forwarded and was not forwarded.

### The eight that mattered most

1. **Two reviewers of one target crashed the whole run.** `decideRevision`
   checked `target.status !== 'done'` with nothing serialising the check against
   the mutation, so two reviewers over one lead — the shape of `manager.ts`'s
   own worked example — could both decide to redispatch. The second's
   `briefing -> briefing` is illegal, `setStatus` threw, and the throw escaped
   `runPool`'s `Promise.all` into `executeRun`'s catch, failing the run and
   discarding every completed report. Reproduced 4 times in 8 against the real
   `FileRunStore`; ordinary Windows filesystem latency is enough. Fixed with a
   single-flight claim taken across a synchronous stretch, and the losing
   reviewer refused through the existing non-fatal event path.
2. **One `Grep` call froze the server.** `MAX_GREP_MS` was checked between files
   and lines; a synchronous `regex.test()` cannot be interrupted by anything
   checked around it. `^(a+)+$` against 41 characters ran past 120 seconds. Now
   refused before compilation. The first fix covered only the nested-quantifier
   spelling — `(a|a)*` still hung past 25 seconds and `(a|aa)+` took 6.2 — so
   the gate also compares the first token of each alternative. Its remaining
   holes are enumerated on the function rather than left to be discovered.
3. **A report path could overwrite the run's own state, and be read back over
   HTTP.** `deliverable` was `z.string().min(1)`; the `reports/…` shape lived
   only in the prompt. A plan naming `run.json` overwrote it. The read side
   served `run.json`, `workspace/` and the logs verbatim over an unauthenticated
   loopback route. The schema now constrains the write; the route now serves only
   what the run declares as a report.
4. **The cost display had never worked for a real provider.** `effectiveModelFor`
   substituted the provider id where the pricing table is keyed by catalog
   model, so every real provider failed the lookup and the header said "partial
   — some agents have no priced model" when every model was priced. Invisible
   until now only because no run has ever used a real provider.
5. **`maxCostUsd` was unreachable from any real run.** Both the supervisor and
   the run CLI call `makeProvider` with no options; the wire schema has no cost
   field. FR-M8's spend cap existed, was tested, and could not be switched on.
6. **Manager spend escaped the run token budget** — measured at 645 tokens
   against a 400 budget — and the doc comment defending the split was the root
   cause rather than an aside.
7. **Replay had no record of the Manager at all.** Four events streamed live,
   zero persisted, for the two turns that on a small run outspend the team.
8. **A restart stranded every live run**, which is half of what NFR-2 promises.

### The test suite was measured, not trusted

Phase 7 gave three slow tests an explicit 20s timeout. They kept failing, and
the reason is the sort of thing only a dedicated pass finds: `waitForTerminal`
carried its own hardcoded 10s ceiling and **no call site overrode it**, so the
raised budget changed the error message and nothing else. A fourth test with
identical work never got the marker at all and failed in 5 runs out of 5.

Both are now one exported constant beside the helper it bounds, with the poller
deliberately below the vitest budget so the informative failure wins the race.
Budgets came from five measured full-suite runs rather than from taste.

One test was found that could not fail: the sim's status-coverage check built
its list of statuses from the very map it was checking for completeness.

### Verified

- **1,178 tests pass, 4 skipped, across three consecutive full runs**; typecheck
  clean in all three workspaces. Up from 1,006.
- The 4 skips are unchanged: Windows symlink-escape tests that skip loudly.
- Six new test files for modules that had none, including `costModel.ts` and
  `deliverable.ts` — which is how defect 4 survived this long.

---

## Closing out the QA pass

The five items the audit left open, finished in one more parallel wave. Three of
them turned up something the audit had not.

### The spend cap now exists end to end

`maxCostUsd` reaches a run from the settings panel, through the wire contract
and the supervisor, into every adapter. Two things came with it:

- **`buildArgs` refuses an invalid cap** rather than forwarding it. `0`, a
  negative, `NaN` and `Infinity` were all being passed to `--max-budget-usd`
  verbatim. A cap you believe is set and is not is worse than no cap.
- **The HTTP adapters refuse to start when a cap is set on an unpriced model.**
  Every OpenAI and DeepSeek model is unpriced here, because no price for one has
  ever been verified in this repo. Running uncapped while the user believes
  otherwise is the defect; refusing costs nothing.

The overshoot is stated rather than implied: the check runs between tool rounds,
so it is bounded by one round's `max_tokens`, not by zero.

### Three defects found by the closing work itself

- **A revised assignment undercounted its own tokens.** `executeAssignment`
  started its usage accumulator at zero on each dispatch and then *overwrote*
  the persisted figure, so an FR-M10 revision reported only the second attempt's
  spend. `runTotalUsage` — and therefore NFR-5's entire cost display — is built
  on that number, so every run containing a revision understated its bill. It
  surfaced only because the replay fold sums the `usage` events on disk and
  disagreed with the live state. **Neither side looked wrong alone.** It took
  comparing two independent reconstructions of the same fact.
- **The status event now carries what changed with it.** `reportPath`, `error`
  and `endedAt` were set alongside a transition and never put on the event, so
  replay inferred them. `endedAtCleared` is explicit, because absence already
  means "unchanged" everywhere else. A revised assignment used to replay as
  `briefing` beside a stale `endedAt` — finishing before it restarted.
- **`vi.setConfig({ testTimeout })` does not cover hooks — and setting
  `hookTimeout` there does not fix an already-registered one.** A test that
  asserted in milliseconds failed at exactly 10s in its *teardown*, where a
  still-running supervisor is drained, reported against the test body.
  Adding `hookTimeout` to the `setConfig` call looked like the fix and was not:
  a hook takes its budget when it is REGISTERED, and that registration sits
  above the `setConfig` line. Three green runs seemed to confirm the wrong fix
  before the failure returned at roughly one run in three. Reading the error
  text — "Hook timed out in 10000ms" — settled in seconds what two rounds of
  inference had got wrong. The budget is now an argument to `afterEach`, the
  only form that cannot be outrun by evaluation order.
  Fourth instance of one pattern here: a budget set in one place while a
  tighter, unstated one governed elsewhere. `waitForTerminal`'s ceiling, then
  `waitFor`'s, then the hook default, then the ordering.

### `exactOptionalPropertyTypes` was false the whole time

Comments across the codebase assert it is on and justify the
`...(x === undefined ? {} : { x })` pattern by it. `tsconfig.base.json` has said
`false` since the line was written. The pattern was right and simply unenforced.
Turning it on cost sixteen fixes, and one of them was real: `useSettings` set a
cleared budget to `{ runTokenBudget: undefined }` — present and undefined, not
absent — which is precisely the distinction the flag exists to police.

### Verified

- **1,280 tests pass, 4 skipped, across three consecutive full runs**; all three
  workspaces typecheck with the stricter flag on. Up from 1,006 at the start of
  the audit.
- A replay test now drives a real `dispatchRun` through a plan containing a
  failure, a skip and a revision, folds the persisted log, and compares the
  result to `run.json` field by field. Everything matches except `startedAt`,
  which diverges by two clock reads and is asserted as close rather than equal.
- New test files for `socket.ts`, `useRun.ts`, `api.ts`, `pricing.ts` and
  `TaskForm`'s request builder.

### Known gaps carried forward

- **The ReDoS gate is a static check and cannot be complete.** Alternatives that
  overlap without sharing a first character still get through. The only total
  fix is matching inside something killable.
- **`attempts` cannot survive replay from a bare event log** — no event carries
  a change in attempt count. The field-for-field test asserts it only because
  the fold's base is the post-dispatch run.
- Two reviewers were cut short by a session limit and resumed; the test-suite
  reviewer did not reach requirement-to-test mapping or a shuffled-order run.
- A cancelled assignment is recorded as `failed`, because `status.ts` offers no
  terminal state that means "stopped". An imperfect fit, documented where it is
  made.
- The two HTTP adapters yield `tool` events at different points relative to a
  round completing, so a spend cap tripping on a round with tool calls leaves
  Anthropic's stream showing that round's tool event and OpenAI's not.
  Pre-existing; only visible now that a cap can trip.

---

## Second QA pass — the design team, and the gaps that were still open

The first QA pass audited the code. This one audited the *interface*, and then
went back through every "known gap carried forward" the previous entries had
accumulated to see which were still real. Twenty-one findings, nineteen fixed,
and the two that are not are not fixable here.

The rule for this pass was that a finding had to be **measured**, not read.
Every number below came from the running app or from a script, which is why
several of them contradict what the code confidently says about itself.

### The design pass found that the accessibility work had audited the wrong thing

Phase 8 built a contrast grid and enforced it. It is a good grid. It measures
**tokens**, and three of the four worst findings here are places where the
browser does not paint the token.

- **`.status-tone-stopped { opacity: .85 }`.** The grid reads `statusStopped`
  against `sunken` and gets 5.49:1 in dark, 6.25:1 in light — comfortable. The
  browser composites the whole chip, text and fill together, toward whatever it
  sits on, and paints **4.25–4.41:1** — under AA in both themes, on every
  surface, for `cancelled` and `skipped`. This is Phase 8's own lesson ("audit
  against the surface a colour lands on, not against `bg`") recurring one level
  down: audit the colour the browser paints, not the one the token holds. The
  dimming is gone; the tone was already the least saturated hue in the palette
  and already had its own glyph. `status.test.ts` now fails the build if any
  tone rule sets `opacity` at all, because the grid cannot see through it.
- **Every control border failed WCAG 1.4.11.** `--ao-line-firm` draws the
  outline of every text input, select, textarea and button — measured
  **1.41–1.90:1** against a 3:1 requirement, i.e. a form whose fields have
  effectively no edge. It had been filed as decorative alongside `line`, and for
  a section divider that is true. One token was doing two jobs, one exempt and
  one not. Retuned to `#5b6b80` / `#74828f`, chosen against the *worst* ground
  rather than the easiest, and moved out of the decorative exemption into a
  1.4.11 grid of its own.
- **The office canvas was invisible to assistive technology.** The app's
  DEFAULT view was a bare `div` wrapping a `canvas`: no role, no name, no text
  alternative, and click-to-inspect reachable only by mouse. A screen reader
  found the "Office" heading and then an empty box. The fix is not a caption —
  every fact the office shows is already in `RunState` as text, so it renders as
  a real list of real buttons that do what clicking a character does. One
  structure satisfies 1.1.1, 2.1.1 and 4.1.2, and it cannot drift from the
  canvas because both read the same `assignments`.
- **The layout had no breakpoint at all.** Measured across seven widths: the
  fixed 320px sidebar keeps every pixel and the content column absorbs the loss
  — 1280 to 960, 640 to 320, 400 to 80, and at 320 the main column is **48px,
  which is exactly `.main`'s own padding**. The office, the table, the log and
  the reports were all inside that. WCAG 1.4.10, and equally 1.4.4 at 400% zoom.

Fixing the layout then exposed a second one behind it: at a 320px viewport the
office is a 665px canvas in a 272px frame under `overflow: hidden`, silently
cropping ~60% of the floor with no way to reach the rest. It scrolls
horizontally inside its own frame now, so the page never does.

That fix also produced the most instructive small failure of the pass. The
override was written into the breakpoint at the top of the stylesheet, the
browser reported `overflow-x: hidden` anyway, and it took reading the computed
rules to see why: `.office-canvas`'s base rule sits several hundred lines lower,
both selectors have the same specificity, and **a media query adds none** — so
the later `overflow: hidden` shorthand simply won. Same shape as the four budget
defects the first QA pass ended on: a value set in one place while something
further along quietly governed.

### Six more, smaller

- The page's `h1` was the run id, which put the only top-level heading three
  landmarks down and left the page with **no `h1` at all** until a run was
  selected. The live outline read `H2 Runs` then `H1 <run-id>` then `H2 Office`.
- The selected run was carried by an accent border and a glow and nothing else —
  no `aria-current`, so assistive technology could not tell which row was open.
- The log pane and the report viewer are scroll containers with nothing
  focusable inside them, which means no keyboard can scroll either.
- The log pane auto-scrolled to the bottom on **every** new line regardless of
  where the reader was, so reading back through a live run was undone about once
  a second. It follows the tail only when already at the tail now.
- A run failing announced nothing; it is a `role="alert"` now. Deliberately the
  only thing on the screen that announces — the activity pane emits several
  lines a second, and announcing those would make the page unusable.
- Two style hooks, `.office-empty` and `.replay-partial`, had been in the
  stylesheet for phases and were referenced by nothing. Both are wired rather
  than deleted: the office had no empty state at all, and "what you are watching
  is missing activity" had been rendering in the same grey as "Loading…".

### A cancelled assignment is no longer recorded as `failed`

Carried as a known gap since the first QA pass, and worse than the "imperfect
fit" it was filed as. `working`'s only terminal exit was `failed`, so the
dispatcher took it and wrote the real cause into the error text — and every
reader downstream took the status instead: `ASSIGNMENT_BEHAVIOUR` gave the
character `idle_slumped` under an error bubble, and the run list counted it
under "Failed", for work the user had deliberately stopped. A status vocabulary
that cannot say "stopped" forces everything reading it to say "broken".

`cancelled` is now a terminal `AssignmentStatus`, reachable from any
non-terminal status via the same fallback that grants `failed` and sealed once
reached. It shares `statusStopped` with `skipped` — both are "withdrawn, not a
result" — and stays a distinct status because the office and the log have to be
able to say which one happened. `DispatchResult` gained a `cancelled` counter in
the same change: the tally's buckets are meant to partition the assignment list,
and a status with no bucket is one that quietly stops being counted.

### `attempts` survives replay now

The other carried gap. No `AgentEvent` recorded a dispatch, so the fold left
`attempts` at the base run's value — normally its **final** value — for the
whole of playback, and a run containing an FR-M10 revision replayed as though it
had been on its second attempt from the first frame. The dispatcher was already
handing `setStatus` the number; it was simply never put on the event.

The interesting part was back-compatibility. Resetting `attempts` to zero like
every other event-derived field would make every log recorded before this replay
as `0` throughout — a *regression* in old-log fidelity, which is exactly what
NFR-7 exists to prevent. Never resetting it leaves a new log's real numbers
masked by the base value. `foldEvents` reads the vintage off the log — does any
event carry the field — and gets both. The test folds onto a base where every
assignment claims 99 attempts, so the numbers can only have come from the
`.jsonl`.

### FR-R4: measured to a conclusion, not deferred again

Phase 6 measured the pre-filter at one limit (10/16 recall at 40) and left it
unwired, which invited the obvious question: is 40 simply too small? Swept
across 40/60/80/100/120/140/156, recall goes **10, 11, 11, 11, 11, 15, 16** —
full recall arrives only when the "cut" is all 156 agents and the pre-filter has
by definition filtered nothing.

The totals understate it; the ranks are the finding. Half the wanted agents
score **exactly 0.000** against their own task: `ux-researcher` ranks #150 of
156 on a task about onboarding metrics, `security-auditor` #130 on one about
authentication bugs, `risk-manager` #123 on a liability review. They are not
ranked badly, they are not ranked at all, and their survival is decided by the
alphabetical tie-break among the whole zero-scoring tail. A larger limit just
admits more of that tail in alphabetical order. A hybrid that expands to whole
categories reaches 15/16 and inflates the software shortlist to 132 of 156 — no
saving.

So this is a property of literal-token BM25 over this corpus, not a tuning
problem: no threshold, weight or stopword change moves an agent whose
description shares no token with the task. The decision to leave it unwired
stands, now on six data points instead of one, and the test asserts the
limitation **against the uncut baseline** rather than a hardcoded number — so
the day a better ranker closes the gap, it fails and asks to be rewritten
instead of quietly certifying a limitation that no longer exists.

### Verified

- **1,301 tests pass, 4 skipped**; typecheck clean across all three workspaces.
  Up from 1,280.
- **A shuffled-order run** (`--sequence.shuffle`, seed 20260811) passes
  identically — closing one of the two items the first pass's test-suite
  reviewer never reached. Requirement-to-test mapping is still not done.
- Every design fix confirmed in the running browser rather than by reading:
  heading outline, `aria-hidden` on the canvas with three keyboard-reachable
  agent buttons beside it, `aria-current` on the selected run, `tabindex` on
  both scroll containers, `opacity: 1` on the stopped tone, the retuned border
  token, and the layout holding at both 1280px and 320px with no page-level
  horizontal scrolling at either.
- The 4 skips are unchanged: Windows symlink-escape tests that skip loudly.

### Known gaps carried forward

- **The ReDoS gate is still a static check and still cannot be complete.**
  Unchanged: alternatives overlapping without a shared first character, and
  repetition-free polynomial blowup. The only total fix is matching inside
  something killable — a worker thread — which is a real architectural change
  and not one to make on the way past.
- **The two HTTP adapters still yield `tool` at different points** relative to a
  round completing. Anthropic emits inside the stream at `content_block_stop`;
  OpenAI after `consumeStream` returns, because its wire format has no per-call
  completion signal to hang it on. Aligning them means moving Anthropic's, not
  OpenAI's.
- Requirement-to-test traceability (FR-*/NFR-* to test names) is still unbuilt.
- No retention or pruning for `runs/`.
- **A cancelled or timed-out `claude-code` assignment is now costed at exactly
  zero.** Found reviewing the Phase 1 closure above rather than in the web
  pass, and it follows from that fix rather than undermining it: usage for this
  adapter now comes only from the `result` frame, and an aborted run is killed
  before one arrives, so `executeAssignment`'s accumulator persists `{0, 0}`.
  The write-up covers the `is_error` result frame — a run that *failed* still
  reports its spend — but not the case where no result frame exists at all.
  This is the right trade and not worth reverting: the alternative is the
  assistant-frame sum that was 2x wrong on input and 1.7% of the truth on
  output, and there is no accurate source before the result frame. It is worth
  knowing, because someone who cancels a long run and reads `$0.00` will
  believe it. The honest fix is upstream — `total_cost_usd` and incremental
  accounting the CLI does not currently expose mid-turn.
- **The `claude-code` adapter has no filesystem sandbox, and a real run has now
  demonstrated it.** Found while committing Phase 9's plan: an untracked
  `reports/03-product-manager.md` was sitting in the REPO ROOT, written 04:23
  during run `20260811-042057-37po`. It is not a stray copy of that run's own
  report — different content, different hash — it is a second document the
  agent wrote itself, outside its run directory, into the user's repository.
  That run's `workspace/` is empty, so nothing landed where the sandbox is.

  The mechanism is not a bug in the adapter so much as a boundary that was
  never drawn. `provider.ts` spawns the CLI with `cwd: request.workspaceDir`
  and `--permission-mode acceptEdits`. A cwd is not containment: an absolute or
  `../` path is unaffected by it, and `acceptEdits` means nothing stops to ask.
  The asymmetry is the finding — `apiTools.ts` gives the raw API adapters a
  real sandbox, with traversal, absolute-path, UNC, NUL-truncation and
  prefix-sibling defences, all tested against a live filesystem. The adapter
  most likely to be used by default has none of that, because tool execution
  belongs to the CLI.

  Not fixed here, because the fix is a genuine design decision rather than a
  patch: many useful tasks legitimately need to read the repository, so the
  answer is a deliberate policy (`--add-dir` with an explicit read set, a
  stricter `--permission-mode`, or accepting the CLI's own boundary and saying
  so in NFR-1) and not a quiet tightening. It should be decided before the
  default provider is pointed at anything that matters. The stray file is left
  in place rather than deleted — it is another session's output, and `runs/`
  is gitignored while a repo-root `reports/` is not, which is its own small
  hazard: one `git add -A` from being committed.

---

## Cache-aware pricing

Phase 9 put spend on every desk, which made an existing accuracy problem
prominent enough to matter: a five-agent run displayed **$23.11**, and the
figure was roughly an order of magnitude too high.

`Usage` carried a single `inputTokens` total and every price was computed at
the fresh-input rate. But `totalInputTokens` folds three counters into that
total — fresh input, cache reads and cache writes — and those are not priced
alike. Against this repo's own captured run, **44,878 of 67,635 input tokens
were cache reads**: Anthropic prices a cache read at roughly **0.1x** fresh
input and a cache write at **1.25x** (the 5-minute TTL; a 1-hour TTL is 2x and
nothing here requests one). Charging all of it at 1.0x is not a stale-price
problem, which is what the pricing tables already warn about — it is the wrong
arithmetic.

### The total stays a total

`inputTokens` still means every input token processed, and the two new
counters are a **decomposition** of it rather than additions to it:

```
fresh = inputTokens - cacheReadTokens - cacheWriteTokens
```

That choice is what makes the change back-compatible in one step. Both
counters are optional, so a `run.json` or a `.jsonl` line written before they
existed parses unchanged, reports the same token figure it always did, and —
with both absent — takes a code path that reduces exactly to the flat
arithmetic it replaces. A test asserts that equation directly rather than
trusting it.

The fresh remainder clamps at zero. Counters exceeding the total mean corrupt
or hand-edited state, and the honest response is not to emit a negative charge
that quietly offsets the cache buckets.

### One arithmetic, not two

`wire.ts` and `providers/pricing.ts` each carried their own copy of the
cost calculation. They were identical while both were three lines of
multiplication, and they were exactly the pair that would diverge the moment
one learned about cache rates and the other did not. Both now call a single
`costForUsage`; they differ only in how a model resolves to a price, which is
the one thing they genuinely disagree about.

The same collapse happened on the accumulation side, and for a sharper reason.
**Five** places were summing usage by hand — the dispatcher's per-assignment
accumulator, the runner's Manager accumulator, `totalUsage`, `runTotalUsage`,
and replay's fold — each spelling out two field additions. Adding the counters
to four of the five and missing the sixth would have zeroed them on one path,
and the resulting cost error would have read as a pricing bug rather than a
dropped field. `addUsage` is now the only way usage is combined.

`addUsage` preserves ABSENCE, which is the subtle part: when neither operand
reports a split the result carries neither key, so folding an old log yields a
`Usage` shaped exactly as it was then and therefore priced exactly as it was
then (NFR-7). One reported counter is enough to keep one, because discarding a
number an adapter actually measured is worse than carrying a partial one.

### What this does not do

**It does not re-price existing runs, and cannot.** Verified in the browser
after the change: the same five-agent run still reads $23.11, because its
`.jsonl` never recorded a split and no amount of arithmetic recovers a number
that was never written down. The fix is forward-looking — new runs price
correctly, old ones keep the figure they were given. Re-pricing history would
require re-reading each run's raw provider logs, which are not retained.

### Verified

- **1,388 tests pass, 4 skipped**; typecheck clean across all three
  workspaces. Thirteen new tests, including the real capture's own numbers
  (in=26, cache_read=44,878, cache_write=22,731) asserted end to end.
- The back-compatibility equation is a test, not a claim: a `Usage` with
  neither counter costs exactly what the pre-cache implementation charged.
- Five existing tests asserted the usage event's exact shape and were updated
  rather than loosened — a reported zero and an absent counter are different
  claims, and the tests now say which one each frame makes.

---

## Third QA pass — two reviewers in parallel, and a hole in the loopback model

Two reviewers were run concurrently against a tree that had two authors in it:
one on the web client's Phase 9 work, one on a parallel session's uncommitted
server changes. Both found things, and the server one found the worst defect
this project has had.

### The loopback model was open to any web page

`server.ts` had grown a `Host` header allowlist, with a doc comment stating it
"closes the CSRF hole on `POST /api/runs/:id/cancel`". It does not, and the
reason is the natural mistake to make about these two headers.

**`Host` is the URL a request was sent TO; `Origin` is the page it came FROM.**
A page on `evil.example` fetching `http://127.0.0.1:5179/api/runs` sends
`Host: 127.0.0.1:5179` — a genuinely loopback host, which passes — and names
itself only in `Origin`, which was computed and then used *solely* to decide
whether to echo `access-control-allow-origin`. So the allowlist stopped the DNS
rebinding shape (attacker's name in `Host`) and nothing else.

Reproduced against a running server, twice:

- `GET /api/runs` with `Origin: http://evil.example` returned **200 and the
  full run list**.
- `POST /api/runs/:id/cancel` from the same foreign origin returned **200 and
  actually cancelled a live run**.

A withheld CORS header does not help with either. It is a rule the *browser*
enforces about what script may READ, and both of the things that matter here
sit outside it: a bodyless POST is a CORS "simple request", so the side effect
has already happened by the time any response header is inspected; and `/ws`
is not subject to the same-origin policy at all, so any open tab could connect
and receive the whole event stream — run state, log lines, deliverable content.

Under NFR-6 ("no auth, loopback only") `Host` and `Origin` are the *entire*
defence. A present-but-foreign `Origin` is now refused outright, in the same
`onRequest` hook, ahead of content-type parsing and every route. An **absent**
`Origin` still passes, deliberately: curl, the run CLI and the test harness
send none, and the one browser case that also omits it is DNS rebinding —
which is what the `Host` check is for. Neither half is redundant.

The tests are the more interesting part of the failure. There was a
`describe('Host header allowlist (DNS rebinding)')` block with five cases, and
every one of them varied `Host` while leaving `Origin` alone — so the suite was
green, thoroughly, against the one axis that was already covered. Five new
cases pin the other axis, including the forged cancel asserting on the *side
effect* rather than the status code, and the WebSocket upgrade.

### The design reviewer found geometry nothing was measuring

Phase 9's own `officeText.test.ts` grades what a plate says and whether its
colours are legible. Nothing graded whether a plate **fits**, and it did not:

- At **1x**, `architect-reviewer` renders **99px wide into a 64px column gap**,
  and a four-line verbose plate is **78px tall into a 64px row gap**. Both run
  across a neighbouring desk.
- At **2x** both fit comfortably — which is why every manual look at the office
  missed it. A one- or two-row team gets 2x; three rows falls back to 1x. The
  overlap appears on precisely the runs with the most plates to draw.

The root cause is a deliberate design decision meeting its consequence: plates
render in an **unscaled** overlay so text stays crisp at any zoom, while the
gaps they must fit into are **scaled**. `fitPlateLines` now trims a plate to
the box the current viewport actually gives it — truncating each line to the
available width with an ellipsis, and dropping detail lines that would reach
the next row. Showing fewer facts is the honest response to having no room for
them. The name line is never dropped and never degrades to a bare ellipsis.

`scene.ts` mirrors the two desk-spacing constants to size that box, and a test
measures the real spacing out of `layoutOffice` rather than trusting the copy.

### The focus-reveal was clipped by its own frame

The `visually-hidden-focusable` pattern from the second QA pass revealed the
office's text alternative by switching it to `position: static`, rejoining the
flex flow of `.office-canvas` — a 520px box with `overflow: hidden` and
`align-items: center`. Measured at 12 agents: a **1,206px list inside a 520px
frame**, centred, so roughly 340px of it was clipped off each end. A keyboard
user tabbing to the first agent focused a control scrolled out of sight, which
is the exact failure (WCAG 2.4.7) that class exists to prevent — and Phase 9
made it worse by lengthening every button's label.

It now fills the host and scrolls internally, so the list can never exceed its
own scroll box and the browser scrolls a focused child into view for free.
Verified after the change: 12 agents, 518px, first button fully visible.

A skip link was added ahead of the list for the same reason it was missing —
one focus stop per agent with no cap meant a keyboard user heading for the
activity log tabbed through the entire office first (WCAG 2.4.1).

### Verified

- **1,403 tests pass, 4 skipped**; typecheck clean across all three
  workspaces. Up from 1,388.
- The security fix is confirmed end to end against a running server: a foreign
  origin now gets 403, the dev server's own loopback origin still gets 200, and
  a request with no Origin at all still gets 200.
- Ten new geometry tests, five new same-origin tests.

### Reviewed and found clean

The parallel session's `windowsSpawn.ts` was independently verified rather than
taken on trust, including a real `.cmd` spawn on this machine: it works around
Node ≥20.12.2 throwing on `spawn('claude.cmd')` by routing through `cmd.exe`
with per-token quoting, and **refuses** rather than escapes the characters a
batch shim would re-parse (`" % ! ^ & | < >`). That is the right call —
escaping is unsound in the general case (BatBadBut/CVE-2024-24576) — and the
injection attempt is refused before any process starts.

---

## Phase 10 — the office becomes a room, and the head desk gets someone at it

Prompted by re-reading the pixel-agents screenshot for its **art direction**
rather than its features. The honest finding was that the office was not losing
on pixel-art style; it was losing on being a depicted space at all.

### What was actually wrong

Phase 8 painted the office in the chrome's near-blacks, arguing that a CRT is
dark whatever the room is. Sound, and it produced the wrong result: the office
depicts a *place*, and a place rendered in four shades of one near-black reads
as a wireframe of an office. There was no wall, no floor material, no chair, no
screen — the whole scene's only visual distinction was a checker of two
near-identical greys.

The characters had a separate problem with a single cause. At **12×16** a head
is a 4×4 block: no row for a hairline, no column for a shoulder, one pixel per
eye. Every character therefore came out as the same silhouette in different
colours. The art was not crude by intention — the box could not hold anything
else, and no palette work was going to change that.

The palette here is **measured, not chosen**: floor, wall, wood and carpet are
literal samples taken off the reference. "Warm brown" is a description;
`#734728` is a decision.

### Two things only rendering could catch

Both were found by dumping sprite grids to PNG and *looking* at them, against
suites that were fully green at the time.

The reference's head owns the **top 57%** of the figure and is **wider than the
torso** — ours stopped at 33% and was narrower. That is a realistic adult
against a deliberately chibi one, and the chibi head is not just charm: it is
the part carrying the hair silhouette an agent is identified by at 16px.

Correcting the ratio alone produced a **featureless block**, because the ratio
was never the whole story. The reference's hair is a mass that *frames* a
narrower face, and its eyes are a light sclera with a dark pupil. Two dark dots
read as a smudge; sclera-plus-pupil reads unmistakably as a face. `eyeWhite`
earns a token for four pixels because those four pixels do most of the work.

### The walk to the Manager had never been visible

The office has drawn a Manager's desk since Phase 4 and never put anyone behind
it, so its central interaction had one party in it. Worse, the walk itself was a
twitch: `briefing` is set at `dispatcher.ts:287` and `working` at `:321`, a few
file reads apart, and `reporting → done` is one `writeReport`. At 4 tiles/sec a
character gets **about one pixel** toward the Manager before `stepTowards`
correctly re-routes it home.

Six phases, and nothing caught it, because every test asserts
`target === manager.approach` — which is true, for the millisecond the status
exists. No test asked whether the journey was ever *observable*. That is a
different claim, and it was the one that mattered.

### Consequences that had to be decided, not papered over

- On a wood floor the old plate detail measured **2.18:1**. Plates now print on
  an opaque card, its alpha pinned at exactly 1 by a test — a translucent one
  would make the contrast grid measure a colour that never appears on screen.
- Plates sat two tiles below their seat with rows four tiles apart, i.e. halfway
  between their character and the next row's. They pointed at the wrong desks.
  Proximity assigns a label; the vertical budget gave way instead.
- 13px names mean `architect-reviewer` no longer fits at 2x. The plate is one
  desk spacing wide and cannot grow without crossing its neighbour, so the choice
  was a readable name with an elided tail or a whole name too small to read.
- Seated agents face the **viewer**. Less realistic — and the office is entirely
  agents at desks, so `up` meant every character was a back of a head,
  permanently. A depiction that never shows a face is less informative, not more
  real.

### Sizing, measured on a real 1440×960 window (host 1055×718)

The office filled 48% of its frame's width, because a 256×288 world in a 1055×718
host is a **portrait room in a landscape frame** — the height ratio came out at
2.49 and the width at 4.12, so 2x was chosen and half a step was discarded to
aspect mismatch alone. Drawing the room landscape brings it to 82–97%. The host
height was also fixed at 520px, which the new wall band silently turned into a
downgrade from 2x to 1x.

FR-S13 (zoom) was promoted from *Could* to a **Must**, because no host size
covers every window — measured a narrow pane where **width** binds instead of
height. Zooming past the fit then exposed its own defect: under
`justify-content: center` an oversized child overflows in *both* directions and
overflow left of the scroll origin is unreachable, so ~124px of office sat
permanently off-screen at 3x.

### Verified

- **1,482 tests pass, 4 skipped**, across 55 files; typecheck clean in all three
  workspaces. Up from 1,403.
- Zoom confirmed end to end in the running app: auto → 3x grows the canvas
  1049×718 → 1296×864, persists, and `Fit` reverts; scrollWidth now equals the
  canvas width exactly.
- The office was captured from the running renderer, not mocked — which required
  driving `ticker.update()` and `render()` by hand, since FR-S7 correctly stops
  the ticker when the document is hidden.

---

## Phase 11 — Override the team before dispatch (FR-M11)

The Manager picks the team and the run starts. Correct as a default, wrong as the
only option: the plan is a model's judgement about which of 156 specialists a task
needs, it is visible in the UI a second before dispatch, and until now the only
response available was to cancel the run and re-word the task.

A run created with `reviewTeam` now parks at a new `awaiting_approval` status
after planning, with its proposed team already visible through the state push the
client receives anyway, and waits for a `drop`, `swap` or `add` before anything is
dispatched or spent.

### Why a status, and why an opt-in

Both edges out of `planning` stay legal. A run that did not ask for the review
behaves exactly as before — making the pause mandatory would have turned a
Could-have into a breaking change for the CLI, every fixture and every existing
test.

It is a status rather than a flag hung off `planning` because everything
downstream — the office, the run list, the badge, the cancel path — reads run
status to decide what to show. A run reported as `planning` while actually blocked
on a human would have every one of those claiming it was busy when it is idle and
waiting for you. The badge is amber, the "waiting on something external" colour,
not the violet of thinking.

### Three verbs, not an edited plan

The approval route takes `drop`, `swap` and `add` rather than a submitted
`RunPlan`. A client that PUT a whole plan could rewrite objectives, dependency
edges, phase ordering and deliverable paths in one request, and the server would
have to re-verify everything the planner already guarantees. `deliverable` is a
**filesystem path**, which is exactly the untrusted input NFR-1's containment
check exists to keep out — so `add` has no `deliverable` field at all and the
server derives it as the planner does. Putting a path traversal on the one route a
user reaches while feeling in control would be a poor place to find one.

`swap` keeps the objective, the dependency edges and the deliverable and changes
only who does the work, so nothing downstream needs rewiring. `drop` is **refused**
when another assignment depends on the target, naming the dependents rather than
cascading: quietly deleting work the user did not ask to delete is worse than an
error they can act on.

### Two findings from building it

- **A same-phase dependency is not a deadlock, it is a silent degradation.**
  `dispatcher.ts:221` filters a phase's runnable set on status alone and hands
  them to `runPool` together; nothing waits for a sibling. Such an edge races its
  target, `loadUpstreamReports` quietly finds no report, and the result is a
  plausible answer built from an incomplete brief. `add` refuses those edges.

- **Driving the assembled feature against a live server found what no test did:**
  dropping a depended-on assignment returned **200**, and the run then failed.
  Both halves were defensible alone — the operation was correctly refused, and the
  runner correctly refused to dispatch a plan the user had not approved — but the
  only layer that could still recover had already answered OK and let go. A run
  destroyed by a typo is worse than having no control at all, because the 200
  claims it worked. The route now validates while the run is still parked: 400
  with the reason, run stays waiting for a corrected decision.

### Verified

End to end against a live server: parks, refuses the illegal drop and survives it,
applies a swap and an add, dispatches the edited team, reaches `done`. Cancelling a
parked run leaves nothing dispatched and nothing pending.

---

## Security audit — first pass

Acting on the project's own security audit. Every finding was re-verified against
the working tree before being fixed — the audit warns that some of its claims were
stated against a moving target, and one had indeed changed shape again.

**AO-2 (High) — spawned agents inherited every API key.** `spawnClaude` only set
the child environment when a caller supplied one, and the Claude Code provider
never does, so `ANTHROPIC_API_KEY` and friends sat in the environment of every
agent process. Combined with the shell below, one `echo` of that variable puts a
live billing credential into a report, a log, the socket stream and the PDF. Now a
denylist on credential-shaped names — matched by trailing underscore-delimited
segment, so `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY` and `NPM_TOKEN` all match
— with an explicit `options.env` still an unfiltered override.

A denylist rather than an allowlist, deliberately: this project spawns an evolving
third-party CLI that shells out to more tools, so an allowlist would have to be
exactly right about every variable any of them might read, and being wrong fails
silently and expensively. A denylist only has to be right about what a credential
*looks like*.

**AO-1 (High) — the shell is denied by default.** The adapter granted a catalog
agent's `Bash` request as the CLI's real shell built-in under
`--permission-mode acceptEdits`, so shell commands ran without ever pausing for a
human, with `cwd: workspaceDir` as the only containment — and a shell's first
command can be `cd`. Meanwhile `ALWAYS_EXCLUDED_BUILTINS` withheld `EnterWorktree`
for escaping that same directory, calling it "a direct NFR-1 violation". One
requirement meaning two different things inside one adapter is the actual defect.
114 of the 156 catalog agents request `Bash`; a test now pins that number.

The opt-in is `AGENT_OFFICE_ALLOW_SHELL` and deliberately **not** a run option.
NFR-6 leans on loopback as the trust boundary, and loopback is not a user
boundary — anything local can already `POST /api/runs`. A per-request `allowShell`
would let any local process grant itself an auto-approved shell running as this
account, turning a capability choice into a privilege escalation.

**AO-5 (Medium) — briefs fenced, and the fence made unforgeable.** The brief
interpolated the user's task, the Manager's objective and upstream reports with no
delimiters at all, so any of them could forge a section heading that the receiving
tool-bearing agent reads as its own instructions. The subtler half: the fences that
*did* exist in `manager.ts` and `designer.ts` closed on a bare label, so untrusted
text containing that word alone on a line ended the fence early and everything
after it read as trusted prompt — defeated as completely as having no fence, one
line later. `fenced()` appends a nonce drawn *after* the content is fixed, so there
is no value an attacker can pre-place. All seven sites moved onto it.

**AO-9 (Medium) — the provider base URL is validated:** https anywhere, http only
for loopback so Ollama and LM Studio still work, userinfo rejected because the
visible host is not reliably the destination.

**AO-7 (Medium) — Chromium keeps `--no-sandbox`,** because the record shows removing
it broke PDF generation outright, but gains `host-resolver-rules` mapping every
name to NOTFOUND, `--disable-extensions` and `--disable-remote-fonts`. The comment
justifying the flag claimed the page was server-generated and therefore not
hostile; `document.ts` says plainly that everything reaching it is untrusted. A
false justification is how a flag survives review, so the comment was corrected
too.

**SEC-06 (Low)** — `taskkill` was spawned unqualified, so Windows resolved it
against the launch directory before the system directories; now absolute under
System32.

**SEC-08 (Low)** — duplicate deliverable paths are rejected by the plan schema. Two
assignments could target one file, last writer wins, and one agent's findings
silently vanished attributed to another. Enforced on the schema rather than the
planner, so FR-M11's override path is covered by the same check.

### One correction to the audit

It reported vitest's UI-server file read as its only critical advisory. That
requires `vitest --ui`; this project runs `vitest run` and never starts that
server, so it was not reachable. The Vite `server.fs.deny` bypass on Windows was
genuinely reachable and stayed open until AO-3 below.

---

## Security audit — second pass

**AO-6 — the API had no authentication at all,** and the audit's framing is the
important part: *loopback is not a user boundary*. Any other local account or
process could `POST /api/runs` and start work that spawns billed child processes
as this account, read every run's reports and workspace files, and cancel work in
flight. `Host` and `Origin` checks do not help, because both ask what a request
*looks like*, not who sent it — a raw socket sets neither wrongly.

A startup token now gates every `/api` route and the WebSocket upgrade: 24 random
bytes, generated fresh per process, compared through SHA-256 digests and
`timingSafeEqual` so neither the content nor the *length* of a guess leaks through
timing. This is the pattern Jupyter has shipped for years against the identical
problem. `AGENT_OFFICE_TOKEN` pins it for CI and tests. The supervisor also caps
how many runs execute at once — each spawns real, paid child processes, and
`--max-budget-usd` caps a single invocation rather than the number of them.

The Vite dev proxy injects the token so `npm run web` still just works. That is a
development convenience and is commented as one: anything that can reach the Vite
port gets the same access.

**AO-8 — assignments no longer share a workspace.** `brief.ts` goes to real lengths
to guarantee FR-M5 context isolation, and a shared directory quietly undid it:
agent A could plant a file agent B would read, making the declared dependency graph
one of two channels between agents, the other invisible and unlogged. Each
assignment now gets `runs/<id>/workspace/<assignmentId>/attempt-<n>/`, with each
attempt kept rather than reused — wiping attempt 1 in place would equally prevent
confusion and would destroy the one thing a human investigating a bad first report
wants to open.

**AO-R07 — run directories hold full model transcripts forever.** There is now a
purge command and a retention statement in the README, because a policy nobody has
heard of protects nobody. It defaults to a dry run: `--execute` opts *into*
deletion rather than a flag opting out, so a careless first invocation produces a
report rather than data loss. It refuses to touch a non-terminal run at any age,
since it cannot distinguish a live run from one orphaned by a crashed server —
both read the same status off disk.

**AO-11 — there was no CI at all.** ~1,600 tests, a clean typecheck and several QA
passes, none of it running automatically. The matrix includes Windows deliberately:
the spawn quoting, `taskkill` teardown and platform-gated PDF tests only execute
there, so a Linux-only pipeline would silently stop exercising the defences this
codebase specifically has.

**AO-10 — the catalog fetch is pinned to a commit SHA** instead of `main`, with a
per-file hash manifest. The part that actually addresses the finding is the
**tool-grant delta**: a `tools:` line gaining `Bash` is a privilege escalation that
otherwise lands in review looking like a docs diff, so verification reports it as
PRIVILEGE ADDED and fails the build.

**SEC-07 — the TOCTOU is closed rather than narrowed.** Containment was verified
and then the path *string* was handed to `fs`, leaving a window in which a
concurrent writer could swap a component for a symlink pointing outside. `Read`,
`Write` and `Edit` now open one handle and confirm, by `fstat` on that handle, that
its dev/ino match what was verified; a handle names an inode, not a path, so
nothing that happens to the tree afterwards can redirect it. `Edit` reads and
writes through a single `r+` handle, so the bytes written back are provably a
function of the bytes read from the same object.

That rewrite introduced a bug worth recording, caught by a test written for it:
`FileHandle.writeFile` does **not** truncate, unlike `fs.writeFile` by path. An
edit that shrank a file would have silently kept the tail of the old content, and
every existing `Edit` test happened to replace text with something the same length
or longer.

**Also fixed:** a swapped assignment kept the previous agent's deliverable
filename, so `reports/03-business-analyst.md` held the security auditor's work.
Judged cosmetic when the swap verb was written; seeing it in a real run changed
that assessment, because it lands in the run directory, the report listing and the
PDF, and misattributes findings to an agent who never wrote them.

---

## AO-3 — clear every advisory with one major, not three

`npm audit` reported five vulnerabilities and proposed `npm audit fix --force`,
which installs `vite@8.2.1` — three majors, dragging `@vitejs/plugin-react` to a
version requiring vite ^8. Checking the registry rather than taking the suggestion:
`vite@6.4.3` exists and is exactly one patch above the vulnerable `<=6.4.2` range.
That single move clears all three vite advisories — including the high-severity
`server.fs.deny` bypass on Windows (GHSA-fx2h-pf6j-xcff), which matters most here
because the Vite dev server is the only way to run this product's UI — and pulls
`esbuild ^0.25.0`, clearing that advisory too.

vitest 2 pins `vite ^5`, so it moved as well; `vitest@3.2.7` accepts
`^5 || ^6 || ^7` and lands above the `<=3.2.5` UI-server advisory range.
`@vitejs/plugin-react` stayed at 4.7.0 — it already declares
`vite ^4 || ^5 || ^6 || ^7`, so the version npm wanted was never needed.

One migration came with it: `vitest.workspace.ts` used `defineWorkspace`, which
vitest 3 deprecates and vitest 4 removes. It is now `vitest.config.ts` with
`test.projects`, taking the same glob — a rename of the mechanism, not a change to
which tests run.

**The audit then became a hard gate.** The full-tree tier had been
`continue-on-error` because the lockfile carried five advisories when the workflow
was written, and a check that is red the day it merges is a check people learn to
ignore. With the upgrade landed and `npm audit` reporting 0 vulnerabilities at
every level, the reason was gone. Both tiers stay separate steps: a failure in the
production-only audit says "this is in code that ships" before the full-tree audit
can say "this is somewhere in the tree" — same verdict, more information, one extra
invocation against an already-installed tree.

This commit also wired `npm run runs:purge`. Its author could not: `package.json`
was outside that agent's file list, so AO-R07's retention command existed but was
reachable only as a raw `npx tsx` invocation, which is not a retention policy
anyone would find.

---

## MCP toolset — Stages 1–4

Four stages, spread across two commits, that took MCP from "silently dropped" to a
capability with a permission boundary on both provider families.

### Stage 2 — a delegated agent can reach a registered server

The `claude-code` adapter could not grant an MCP tool at all: `tools.ts` dropped
every `mcp__*` name with "none of which this adapter can grant as a CLI `--tools`
entry", and no `--mcp-config` was ever passed. An agent whose catalog frontmatter
asked for one silently ran without it — including `scientific-literature-researcher`,
whose `mcp__bgpt__search_papers` had been dropped on every run since Phase 0.

An `mcp__<server>__<tool>` request is now granted when `<server>` appears in the
file named by `AGENT_OFFICE_MCP_CONFIG`, and dropped with a reason that names the
fix when it does not. Three decisions, each verified against the real CLI (2.1.222)
rather than recalled:

- **`--tools` is built-ins only.** Its own `--help` says "from the built-in set", so
  an MCP name there is wrong rather than redundant. An MCP tool's *availability*
  comes from `--mcp-config` and only its *permission* from `--allowedTools`.
  `ToolResolution` therefore keeps `mcpTools` separate from `resolved`; folding them
  into one list would have put MCP names into `--tools` and produced a CLI-side
  failure far from its cause.

- **`--strict-mcp-config` always travels with `--mcp-config`.** Without it the CLI
  *also* loads the ambient configuration — the operator's own `~/.claude.json` and
  any project `.mcp.json` — so a delegated agent would silently inherit every server
  the human happens to have enabled, including ones with write or order-placement
  capability. That would make the registry decorative: governing what an agent may
  *ask* for while the CLI quietly supplied the rest.

- **The registry is an environment variable, never a run option.** An MCP server
  entry is a `command` that gets executed, so accepting one over the HTTP API would
  be an arbitrary-code-execution primitive rather than a capability setting. The
  same argument that put `AGENT_OFFICE_ALLOW_SHELL` in the environment applies with
  more force: the shell grant unlocks a binary the CLI already ships, this would let
  a caller name the binary.

A configured-but-unreadable config **throws at load** rather than degrading to "no
servers". Degrading silently presents as "my agent ignores its tools", which sends
whoever debugs it into tool resolution — the layer furthest from the actual
mistake, which is a typo in a path.

`mcpServerOf` splits on the **first** separator after the prefix, not the last: a
tool name may contain `__` while a server name may not, and splitting from the
right would check the allowlist against the wrong string in both directions.

One existing assertion changed rather than being re-pinned: the catalog test for
`mcp__bgpt__search_papers` expected `not-a-builtin`. True but unhelpful — it
lumped "this name can never be granted" together with "this deployment has not
registered that server", which is fixable by the operator. It now drops as
`mcp-server-not-registered`, with a companion test covering the same catalog line
with the server registered.

### Stage 4 — the same capability for the API providers

The CLI implements the MCP client protocol itself, so Stage 2 was a matter of
handing it a config. Anthropic, OpenAI and DeepSeek own their tool loop, so there
was nothing to hand it to: an operator who configured `AGENT_OFFICE_MCP_CONFIG` got
MCP tools or not depending on which model vendor an agent happened to name.

`mcpTools.ts` is an MCP client presented as one more `SandboxedTools` — the same
shape `apiTools.ts` returns, so a provider's loop cannot tell a local file read from
a round trip to a spawned server. `composeTools.ts` merges layers, first-layer-wins
on a name collision, and every call site orders the sandbox first so an
operator-configured server can never redefine `Read`. Both providers load the
registry, compose when one exists, and close the handle in a `finally` around the
loop — an `McpTools` holds a spawned process per server, and `runLoop`'s exits are
mostly early returns (abort, cost cap, stream error) that a cleanup at the bottom
would skip.

The composed path is skipped entirely when no registry is configured, rather than
composing an empty layer "for uniformity": that would change the unknown-tool
wording on the overwhelmingly common path where MCP is simply off.

### The allowlist was advisory, and is now a boundary

Reviewing the finished workstreams found the defect this stage exists to not ship.
`createMcpTools` never received `request.allowedTools`. Its `schemas()` filtered
against whatever list it was called with, and its `execute()` checked that the named
server was connected and reported the named tool — a question about the *server's*
capabilities, not about what *this assignment* was granted. The two coincide only
when the model asks for exactly what it was offered, which is the one case the check
does not need to exist for. A model emitting a name it was never offered — a stale
turn, a hallucination, a name read in a brief — reached every tool on every
configured server, and `composeTools` routed it there because the MCP layer said it
declared it.

The module doc asserted the opposite ("`execute` separately double-checks the same
boundary"), which is how it read as finished. Without the fix, the API providers
were strictly **more permissive** than the CLI provider reading the identical
config — a difference no operator would expect to follow from a choice of model
vendor.

The allowlist is now held at construction and consulted by both methods, checked
*before* the registered/diagnostic lookups so a refusal cannot be used to map which
servers exist or which are broken. It is compared case-sensitively, unlike the
sandbox's: those names are this codebase's own PascalCase words, where `read` for
`Read` is a slip worth tolerating, while an MCP name is an identifier the server
defined and matches exactly over the wire. Both new tests were confirmed to fail
against the unfixed module before being kept.

### Verified

End to end against the Stage 1 dashboard server: with `investing` registered,
`mcp__investing__tax_summary` is granted into `--allowedTools` and absent from
`--tools`, while `mcp__rogue__place_order` from an unregistered server is refused.
`npm audit` stayed at 0 vulnerabilities at both CI tiers with
`@modelcontextprotocol/sdk` added, and the catalog manifest reported no tool-grant
delta.

### Known gaps carried forward

- **No live model has ever called an MCP tool through the API-provider path.** The
  boundary and the composition are unit-tested and the CLI path was driven against
  a real server; Stage 4's loop has not been exercised by a model that chose to
  call one.

---

## The office says what it is doing, in words

The office could show an overhead bubble for three of the nine assignment statuses,
and it said nothing in any of them: `bubble_speech`, `bubble_alert` and
`bubble_error` were pixel icons encoding state as shape and colour. Status was
legible from a pose if you already knew the vocabulary, and otherwise you opened
the table. Every character now carries a caption instead — `thinking...`,
`reading...`, `blocked`, `planning...` — for every status, agent and Manager alike.

`activityFor`/`managerActivityFor` in `model.ts` own the words, deriving them from
the same status and tool the animation is derived from, so a caption can never
disagree with the pose beneath it. The label is carried on the view rather than
recomputed per consumer, which is what keeps the canvas and the screen-reader
alternative describing one character one way.

Three judgement calls worth stating:

- **An ongoing activity ends in an ellipsis; a settled one does not.** Nine
  captioned characters read as noise unless a glance can separate "still going"
  from "finished", and the trailing character does that before any word is read.
- **An unrecognised tool is captioned `working...`, not `writing...`.** The reading
  set already existed for picking animations, and treating its complement as writing
  would have been free — but an MCP tool from a server an operator configured could
  be doing anything, and `writing...` would state something this code cannot know.
- **The Manager's caption reads run status, not its own animation.**
  `managerAnimationFor` collapses eleven statuses onto five poses — planning,
  synthesizing and designing all become `read`. Right for a sprite, wrong for a
  caption: the caption is precisely the channel that can carry what the pose cannot.

### A plate had no room left to give

Reviewing this on the running app at 1x found the lower row's bubbles printed across
the upper row's model line. `PLATE_VERTICAL_MARGIN_PX` had been tuned to clear the
next row's *character* — about a pixel of slack at 1x — and a bubble now sits above
that character's head, needing 17px of space already spent. It appeared at 1x only,
and only ever would have: the world scales with zoom and the unscaled overlay text
does not, so at 2x the gap doubles while the bubble does not. Three-row teams fall
back to 1x, so it hit the runs carrying the most plates.

Plates now reserve that room, which costs a normal-density plate its third line at
1x — the trade `fitPlateLines` already makes everywhere else. `plateGeometry.test.ts`
now **imports** the two margins rather than copying `20` as a literal; that copy was
already a latent instance of the overlap the suite exists to catch, and the reserve
made it live.

The icons were removed rather than kept alongside: words cover all nine states and
put the meaning somewhere colour alone never had it, so keeping both would state one
fact twice.

---

## Documentation pass — what the code did and the documents did not say

Everything above this entry from Phase 11 onward is backfill. This entry is the
pass that wrote it, and the audit that found it was needed.

### What the drift actually cost

Documentation drift is usually a tidiness problem. Here it had reached the point of
changing what a reader could *do*:

- **Four environment variables governed security and capability, and none of them
  appeared in `.env.example`, `SETUP.md` or `README.md`.** `AGENT_OFFICE_TOKEN`
  (AO-6's startup token), `AGENT_OFFICE_ALLOW_SHELL` (AO-1's shell opt-in),
  `AGENT_OFFICE_MCP_CONFIG` (the MCP registry) and `AGENT_OFFICE_REPO_ROOT` were
  reachable only by reading the source. The token one is the sharp edge: every
  `/api` route and the WebSocket upgrade now require it, so an operator following
  the documented instructions gets a `401` the documents do not explain.
- **The string "MCP" did not appear in any of the four project documents.** Four
  stages of work, a new dependency, a permission boundary — invisible to anyone who
  read the docs rather than the log.
- **`README.md` was factually wrong about its own status**: "Phases 0, 2, 3, 4, 5,
  6, 7 and 8 are done" and "1,280 tests pass", against a tree that had reached Phase
  11 with 1,765 tests.
- **`PLAN.md` §2 had no requirement covering any of it.** Tool governance, the MCP
  registry and the auth token were built without an ID to be traced to, and NFR-6
  still read "No auth in v1" after auth had shipped. A requirement set that does not
  describe the system cannot be used to check the system.

### What was written

`PROGRESS.md` gained six entries (Phase 11, both security passes, AO-3, the MCP
stages, the captions) plus this one, and its status table now runs to the end of the
work rather than to Phase 8. `PLAN.md` gained §2.7 (FR-T1–T4, tool and MCP
governance) and NFR-9/NFR-10, with NFR-1 and NFR-6 amended where the shipped system
had overtaken their wording. `README.md`, `SETUP.md` and `.env.example` gained the
operator surface: the token handshake, the shell opt-in, the MCP registry file, and
the resolution overrides.

Each entry was written from the commit body and then **re-verified against the
working tree**, not transcribed. That is what caught the one factual error carried
forward below.

### One code correction

Two comments (`provider.ts`, `childProcess.ts`) claimed "114 of the **166** vendored
agents request `Bash`". 166 is the count of `categories/**/*.md` *including* the ten
category `README.md` files the parser skips; the registry indexes **156**, and the
test pins the Bash-requesting count at 114. `SETUP.md` explains the 166/156
distinction correctly, which is how the wrong number survived — it was a real number
from a neighbouring fact. Corrected to 156 in both.

### Verified

1,765 tests pass, 4 skipped, across 63 files. Typecheck clean in all three
workspaces. `npm audit` reports 0 vulnerabilities. `npm run registry:dump` prints
156 agents across 10 categories. The four skips are the symlink tests, which need
Windows admin rights — a documented platform gate, not a gap.

### Known gaps carried forward — the consolidated list

Every open item found by reading the whole record, each re-checked against the tree
rather than taken from the entry that first reported it. Grouped by what a reader
would need to know before trusting the system with something that matters.

**Nothing here has ever been checked by a live model on an API key.** Four separate
claims rest on it, and one session with one key closes all four:

- Phase 6's routing — every plan in the domain matrix came from the scripted
  provider's canned presets, so the teams are correct *by construction* and the
  Manager's judgement is untested.
- Phase 5's designer step — no model has emitted a valid `DesignChoice`; every PDF
  theme so far came from the fallback domain mapping.
- Phase 7's exit criterion, and with it the OpenAI and DeepSeek default model names,
  which `apiConfig.ts` states plainly are guesses.
- MCP Stage 4's tool loop, above.

**Numbers a user could read and believe, that are not exact:**

- A cancelled or timed-out `claude-code` assignment is costed at exactly **$0.00**.
  Usage comes only from the `result` frame and an aborted run is killed before one
  arrives. The trade is right — the alternative was an assistant-frame sum that was
  2x wrong on input — but someone who cancels a long run and reads `$0.00` will
  believe it.
- Manager usage does not replay incrementally: a replay at 0% already shows the
  Manager's full spend, because it is a run-level field with no event representation.
  `reportPath` and `error` are likewise inferred during replay.

**Boundaries that are narrower than they look:**

- **The `claude-code` adapter still has only `cwd` containment**, and a real run
  demonstrated the consequence: an agent wrote a second document into the *repository
  root* during run `20260811-042057-37po`. AO-1 removing the default shell closed the
  widest escape, and `reports/` being gitignored closed the immediate hazard, but the
  boundary itself was never decided. `apiTools.ts` gives the raw-API providers
  traversal, absolute-path, UNC, NUL-truncation and TOCTOU defences; the provider most
  likely to be used by default has none of them, because tool execution belongs to the
  CLI. The fix is a policy decision — `--add-dir` with an explicit read set, a stricter
  `--permission-mode`, or accepting the CLI's boundary and saying so in NFR-1 — and it
  should be made before the default provider is pointed at anything that matters.
- **The ReDoS gate is a static check and cannot be complete.** Alternatives that
  overlap without sharing a first character still get through. The only total fix is
  matching inside something killable — a worker thread — which is an architectural
  change, not one to make in passing.

**Behaviour that is defensible but incomplete:**

- Synthesis truncates at 24k chars per report; twelve agents still overflow.
  Hierarchical synthesis is the answer, and has been since Phase 2.
- The review loop never re-reviews. That is FR-M10 as written ("once"), but it means
  nobody checks whether the revision addressed the critique.
- ~~A cancelled assignment is recorded as `failed`.~~ **Wrong when written, and
  corrected here rather than silently deleted.** `status.ts` has had a `cancelled`
  assignment status since the second QA pass, which this document records a few
  hundred lines above. The stale item was carried out of the *first* QA pass's
  carried-forward list, which is exactly the failure this consolidated list exists
  to end — the claim that every item was re-checked against the tree was true of
  the rest and not of this one. Found while reading `status.ts` for Phase 14.
- The two HTTP adapters yield `tool` events at different points relative to a round
  completing, visible when a spend cap trips mid-round. Aligning them means moving
  Anthropic's, not OpenAI's.
- The planning prompt's worked example is a software trio, which will anchor the
  first legal or tax run — untestable until a model is planning.

**Requirements not built:** FR-S4 is the only **Must** among them, and only
partially — hover gives a highlight and a name, but the agent's category and
one-line description remain inspect-panel-only. FR-R5 (registry hot-reload) has no
watcher at all; FR-P6 (markdown / per-agent export) and FR-U5's scanline and flicker
effects are unbuilt Shoulds; FR-P7, FR-R6 and FR-S8 are Coulds. FR-R4 is built,
measured and deliberately off, pending either better recall or a generalist floor.
Requirement-to-test traceability is still unbuilt — and it is exactly what would
have caught FR-S4 drifting.

**Operational:** the server still does not serve the built client, so there is no
single command that starts this as the local app it describes itself as. Six
Dependabot branches are open on the remote and none are merged, including a `zod`
major that deserves its own pass.

---

## Phase 13 — the first matrix a model actually planned

Five domains, one run each, through the signed-in Claude Code CLI at
`--max-cost 1.00` per assignment. **21 assignments, 0 failed, 0 skipped, $3.20
total.** Phase 6's matrix shapes, re-run against a real model rather than the
scripted provider's canned presets.

| Domain | Team the model picked | Theme | Cost | PDF |
|---|---|---|---|---|
| software | security-auditor → payment-integration → penetration-tester → backend-developer | engineering | $0.14 | 416 KB |
| legal | legal-advisor + risk-manager → business-analyst | legal | $0.44 | 211 KB |
| tax | tax-advisor → tax-compliance-specialist + legal-advisor → risk-manager | **financial** | $0.90 | 782 KB |
| research | competitive-analyst + market-researcher + ux-researcher + trend-analyst → product-manager | research | $1.36 | 1,077 KB |
| product | ux-researcher + business-analyst + product-manager + data-analyst → assumption-mapping | research | $0.36 | 1,197 KB |

The tasks deliberately named no agent and no discipline. A task reading "review
this contract" would let a keyword do the work the model is supposed to be doing,
and the hypothesis under test was specifically about *non-software* routing.

### Phase 6's exit criterion, closed

**No software anchoring anywhere.** The risk carried since Phase 2 — that the
planning prompt's worked example is a software trio and would bias the first legal
or tax run — did not materialise. The tax run fielded both specialists this project
authored itself, in the division of labour they were written for (treatment first,
then filings and corporate obligations off it, then risk exposure over all three).
The legal run drew legal-advisor and risk-manager. Neither pulled a developer.

The model also beat the presets on their own ground. Phase 6's scripted software
preset was `backend-developer, security-auditor, code-reviewer`; the model picked
**payment-integration** off the word "checkout" and **penetration-tester** to sit
between finding defects and fixing them — neither reachable by keyword routing.
Teams ran 3–5 agents with genuine dependency structure, against the presets' flat
trio, and the objectives asked for stable finding IDs, CVSS-style severity and
named PCI DSS requirements.

Worth recording as the more interesting judgement: the roster of 156 was *not*
mostly ignored in favour of generalists. `business-analyst` appears twice, both
times consolidating rather than analysing.

### Phase 5's exit criterion, closed — and by positive evidence

The theme value alone proves nothing, because `fallbackThemeForDomain` returns
exactly the themes Phase 6's scripted matrix recorded. The first three runs were
argued from an *absence*: every non-model path in `chooseTheme` logs before
returning, and no fallback line appeared.

The tax run settled it properly. Its plan emitted `reportStyle: "legal-memo"`, and
the fallback checks `reportStyle` before `domain` — so
`fallbackThemeForDomain('tax', 'legal-memo')` is **`legal`**. The designer returned
**`financial`**, which the fallback could not have produced. A model emitted a
valid `DesignChoice`, first attempt, no repair.

Two of the five plans emitted style hints that are not themes at all
(`research-brief`, `product-brief`) and the designer resolved both sensibly.

### The defect only a live model could produce

**FR-M6's report was whatever the agent *said*, never what it *wrote*.**
`dispatcher.ts` persisted the accumulated assistant text; nothing looked for a file
at the deliverable path inside the workspace. An agent that satisfied the brief the
most literal way available — using `Write` on exactly the path the brief names —
had its work discarded and a sentence about the work kept.

It hit **three of 21 assignments, across two runs**:

| Run | Agent | Delivered | Actually wrote |
|---|---|---|---|
| tax | tax-advisor | 735 B | 24,566 B |
| legal | risk-manager | 2,597 B | 13,359 B |
| legal | business-analyst | 747 B | 9,708 B |

The legal run is the worse case: **two of its three** deliverables were narration.
That is visible in the matrix table above without knowing the cause — its reports
read 8k/3k/1k and its PDF is 211 KB against research's 1,077 KB.

Three things make this worth more than its size:

- **Downstream agents were briefed on the narration.** `loadUpstreamReports` reads
  the deliverable, and three tax assignments depended on `irish-tax-treatment`.
- **FR-M6's own guard passed.** "A missing report is a failed assignment" tests
  `text.trim() === ''`, and narration is not empty. Every run reported 0 failed.
- **Six phases and 1,765 tests could not have caught it.** The two paths coincide
  for any provider that cannot write files — the scripted provider's canned output
  *is* its text. Whether it fires depends on a live model choosing a tool over an
  answer.

**Fixed** in `readWrittenDeliverable`: a non-empty file at the deliverable path
inside the assignment's own workspace wins; otherwise the reply, exactly as before.
The FR-M6 emptiness guard now tests the resolved report, so an agent that writes
everything and says nothing is a success rather than "produced no report". The
review verdict (FR-M10) is parsed from the persisted report too — a reviewer that
wrote its verdict into the file would have had `parseReviewVerdict` scanning
narration for a marker sitting in the report.

Containment uses `realpath` on both sides before the check, so a symlinked
*component* cannot redirect the read. An escaping path is treated as "no file
written" rather than an error: the agent still produced text, and failing an
assignment over a symlink discards a usable report to punish something its author
may not have done. This matters most for the raw-API providers, whose `apiTools.ts`
sandbox exists to prevent exactly that read — following a link here would walk
around it after the fact.

Both new tests were confirmed to fail against the unfixed dispatcher, reproducing
the defect's signature: `expected 'Report written to reports/01-alpha.m…' to be
'# Real analysis…'`.

### NFR-1, demonstrated again — this time as a read

The Phase 9 note recorded an agent *writing* into the repository root. This run
produced the read half, and more sharply. To establish that no checkout service
existed, `security-auditor` searched the entire enclosing repository — `packages/`,
`categories/`, `.git` — and read **this run's own `run.json`**, quoting it by line
number (`run.json:3`, `run.json:8-70`) to prove the task carried no repository path.

The FR-M5 consequence is the sharp one. That requirement says an assignment
receives its prompt, the task, its objective and its upstream reports, "nothing
else — no shared unbounded context"; `brief.ts` goes to real lengths to guarantee
it and AO-8 gave every assignment its own workspace so agents could not pass notes.
`run.json` sits one directory above that workspace and contains the whole plan:
every sibling assignment, its agent, its objective, its dependency edges. An agent
that reads it has the shared context the requirement exists to deny, needing no
other agent's cooperation.

To be fair to the run: it read for a legitimate reason and said so openly. The
finding is that the boundary is advisory, not that this agent misbehaved. Nothing
wrote outside its workspace — `git status` was clean of stray files afterwards and
the repo-root `reports/` was unchanged from its pre-run baseline.

### A report that refused to fabricate

Worth keeping beside the defects. Asked to audit a service that does not exist,
`security-auditor` led with "There is no checkout service in this repository, and
no external codebase was supplied to this run… **Zero findings below are
fabricated**", then tabulated every glob and grep as evidence of the negative. The
objective's closing instruction — "explicitly list what you could not inspect and
why" — did real work.

One slip in the same report: it describes "~24,500 agent-definition markdown files
under `categories/`". The real number is 166 files, 156 of them agents. Incidental
to the conclusion, and a fabricated-shaped number in the one report whose virtue
was refusing to fabricate.

### Known gaps carried forward

- **Two of Phase 13's four criteria remain open** and cannot be closed here:
  Phase 7's adapters and MCP Stage 4 both need an API key. `/api/providers` reports
  `claude-code` available and all three HTTP providers unavailable for want of one.
- **The fixed capture path has not run against a live model.** Runs 4 and 5 executed
  under the fix but neither wrote a file, so only the fallback branch was exercised
  in production. Re-running the legal task would confirm the written branch end to
  end.
- The matrix is not a perfectly controlled comparison: runs 1–3 ran under the old
  capture and 4–5 under the new. It cannot affect routing or theme choice, which is
  what the matrix measures, but the last two runs' reports are more faithful than
  the first three's.

---

## Phase 14 — the Manager can ask before it plans (FR-M12)

A run created with `clarify` gives the Manager one turn to ask up to five short
questions about the task, parks at `awaiting_clarification` if it asks anything,
and folds the answers — fenced — into the planning prompt.

The motivation came out of Phase 13 rather than from a wish list. Its first live
run planned a checkout-service audit in four assignments, and the audit's headline
finding was that no checkout service existed in scope. Everything downstream was
correct; the plan was built on a reading of the task that one question would have
corrected before any of it was dispatched.

### A self-loop, and why the state machine says so

`planning → awaiting_clarification → planning` is the first self-loop in
`RUN_TRANSITIONS`, and the loop is the honest description. The question turn is
itself a model call against the roster, so the run genuinely *is* planning while
it asks; `queued` would understate that exactly as describing the park as
`planning` would overstate it. Three edges now leave `planning`, which is what
lets all four combinations of the two optional stops be legal without any of them
being mandatory.

Asking for both stops runs them in the order a user would expect: clarify the
task, then review the team that produced.

### One bounded round, not a conversation

The round is structured — a validated list of questions, a validated list of
answers — and it happens once. Three reasons, in the order they mattered:

1. **The answers are untrusted text entering the planning prompt.** AO-5 exists
   because interpolated content could forge a section heading the receiving model
   read as its own instructions, and the fix was `fenced()` with a nonce drawn
   after the content is fixed. A bounded set of answers goes through that
   unchanged. An open thread is a second, larger channel into the same prompt —
   and one where the user has been *invited* to type freely, which is the worst
   place to find out a fence is weak. A test drives an answer containing a bare
   `ANSWERS` line and a forged `# Rules` section and asserts the terminator still
   falls after it.
2. **Unbounded model calls.** One round adds exactly one call, and only for runs
   that ask for it. A thread's cost is a function of how talkative the model is.
3. **Replay.** The questions and answers are persisted on the run, so a replayed
   run reconstructs the inputs its plan was built from rather than showing a plan
   whose reasoning is invisible — the mistake `managerUsage` already made by being
   a run-level field with no event representation.

### Decisions worth keeping

- **Declining is a first-class answer.** "Plan it anyway" is one click and posts
  `{ declined: true }`, which reaches the planner as a sentence saying the user
  chose not to narrow the task. Posting empty answers instead would tell it "the
  jurisdiction is `''`" — an absence presented as a specification. Submitting the
  form with every box empty takes the decline path for the same reason. Making the
  escape prominent is deliberate: a round the user cannot cheaply escape is a round
  they learn not to ask for, and the feature is opt-in.
- **Suggestions are pre-filled, not merely displayed.** When the Manager can guess
  ("which jurisdiction? — Ireland, from the task"), the guess starts in the box as
  editable text. That turns the common case into "read it, press Send" rather than
  "read it, retype it", and a question answerable in one keystroke is one that
  actually gets answered.
- **A malformed question list never fails the run.** `askClarifyingQuestions`
  degrades to "ready, no questions" on a provider error or an exhausted repair
  budget — the posture `chooseTheme` takes, not `planRun`'s throw. A convenience
  feature must not be able to destroy a run the user is paying for. An abort still
  propagates, because a cancelled run must stop (FR-M9).
- **A contradictory response resolves toward the questions.** `ready: true` with a
  non-empty list means the model wrote questions and then mislabelled them;
  trusting the boolean would discard work it meant to do.
- **The question turn is Manager spend.** It is added to `isManagerAssignmentId`,
  so its tokens reach `managerUsage` (NFR-5) and its events reach
  `logs/manager-clarify.jsonl` (NFR-7). Omitting it would have reproduced, for the
  newest turn, precisely the defect that gate was written to fix.
- **The route validates while the run is still parked.** An answer whose
  `questionId` matches nothing asked, or two answers to one question, is a 400 and
  the run stays answerable. This is FR-M11's lesson applied before it could be
  re-learned: there, a refused edit returned 200 and the run then failed, because
  the only layer that could still recover had already said OK.

### The free provider can now reach the new stage

The scripted provider got a canned `ClarificationRequest`, for the same reason it
already scripts the planning and synthesis turns: without one, the clarify turn got
prose where JSON was required, degraded correctly to "ready", and left the entire
round unreachable on the one provider that exists so the pipeline can be exercised
for free. The questions are fixed rather than derived from the task — inferring
what to ask would be the scripted provider growing into a planner, which this
document has twice recorded it must not do.

### Verified in the browser, not only in tests

Driven end to end against the running app on the scripted provider: the run parked
at `AWAITING_CLARIFICATION` with both questions rendered, the first box pre-filled
with the Manager's suggestion and the second empty; the office captioned the
Manager **"has a question"**; the clarify turn's 800/200 tokens appeared in the
run's own token line and its events in the activity log. Typing an answer and
pressing *Send answers* released the run, which planned three assignments and
reached `done` with both answers — the pre-filled one and the typed one — persisted
on `run.clarification.answers`.

One thing that looked like a defect and was not: mid-session the app threw React's
"Should have a queue" error in `<App>`. That is Vite HMR applying a hook change to
a live tree; a full reload cleared it and it has not recurred. Worth recording
because the error names React rather than the tooling, and the natural reading is
that the new panel broke the hook order.

### Known gaps carried forward

- **No live model has run the round.** The questions above came from the scripted
  provider's canned response. Whether a real Manager asks *useful* questions —
  rather than the ones its rules warn against, like asking the user to choose the
  team — is the interesting question and it is untested, exactly as Phase 6's
  routing was before Phase 13.
- The panel is not covered by a rendering test. This package's web tests run under
  plain Node with no DOM, so the convention is to pull logic out of components and
  test that; `ClarifyPanel` is a form shell whose only real logic — empty submit
  takes the decline path — is asserted nowhere but by hand in the browser.
- `clarify` and `reviewTeam` together are legal by construction and covered by the
  transition table, but no test drives a run that asks for both.

---

## The diagnostics log — warnings, failures, and what the agents asked for

Everything this system complains about was already recorded and effectively
unreadable. A refused tool grant is a non-fatal `error` event in
`runs/<id>/logs/<assignmentId>.jsonl`, interleaved with that turn's text and
usage; a failure is a string on `run.json`. Both are the right shape for "what
happened in this run" and useless for the questions actually asked after a week:
*which grants keep being refused, and to whom? which MCP servers do agents keep
asking for that nobody registered? what have agents said would make this work
better?* Answering any of them meant knowing which of forty run directories to
open.

`runs/diagnostics.jsonl` is the append-only place they all land, read with
`npm run diagnostics`.

### Agents got a channel, which is the new part

The first three kinds — `tool-denied`, `mcp-unregistered`, `provider-warning` —
are this codebase observing itself. `enhancement`, `blocker` and `note` are not:
they are written by the agents doing the work, who are the only participants that
see the brief, the tools they were actually granted, and the gap between them.
Before this, an agent that noticed "I could have answered this properly with the
shell" had one place to put it — the body of a report about something else, where
it reads as a caveat and is never seen again.

The marker is `[[ENHANCEMENT: ...]]`, `[[BLOCKER: ...]]`, `[[NOTE: ...]]`, and it
is deliberately the shape `review.ts` already established for
`[[REVIEW_VERDICT: ...]]` rather than a second convention. Its reasoning carries
over exactly: double square brackets are not markdown syntax, so a model that
bolds its report, puts the line under a heading or fences the whole thing as code
cannot destroy the marker. `SUGGESTION` is accepted as a synonym for
`ENHANCEMENT` because it is the word a model reaches for unprompted about half the
time, and the one failure this parser must not have is silently dropping a note
for using the wrong word — nothing downstream can tell that from "the agent had
nothing to say".

`brief.ts` tells every agent the channel exists, and the wording lives in
`notes.ts` beside the parser that has to match it. A brief documenting a marker
the parser did not accept would produce notes that vanish while the agent believed
it had reported something.

### Decisions worth keeping

- **Lossless on write, grouped on read.** Nothing compacts or dedupes. 114 of the
  156 catalog agents request `Bash`, so the refusal appears once per assignment
  that asked — and that count is the most useful thing the log knows. The reader
  groups by kind and message and sorts *severity first, then frequency*, because
  "most common" and "most important" are different questions and the top of the
  list should be what you act on.
- **Best-effort writes that never fail a run.** Every append swallows its error.
  This log observes a run; it is not part of one. That is the opposite of
  `writeReport`, where a failure correctly fails the assignment — the difference
  being that a missing report means the run produced nothing, while a missing
  diagnostic means we know slightly less about a run that worked.
- **Validated on the way in.** A malformed record is refused rather than written,
  because a log that cannot be parsed is worse than one missing an entry. An
  unparseable line on the way *out* is skipped and counted, so the truncated last
  line a crash leaves does not cost a reader the other nine hundred.
- **Beside the run directories, not inside one.** Inside `runs/` so it inherits
  the gitignore that keeps run artifacts out of the repository — a diagnostics
  file at the repo root would be one `git add -A` from being committed, which is
  exactly what the stray `reports/` directory demonstrated. At the *root* of
  `runs/` because `purge.ts` deletes run directories by age, and a log whose
  purpose is to be read months later must not be deleted by the retention policy
  for transcripts. Purge skipping non-directories is what makes that work, and is
  now load-bearing.
- **A cancellation is not logged as a failure.** The Cancel button working is not
  an incident, and filing it beside real failures would make the error count
  meaningless within a week.
- **The markers stay in the report.** Stripping them would mean the persisted
  report differs from what the agent wrote, and a reader comparing the PDF against
  the transcript would find the difference with no way to explain it.

### Classification is a heuristic, and says so

`classifyProviderWarning` reads the message text to tell a refused tool from an
unregistered MCP server. That is a heuristic on a human-readable string, and it
rots when the string is reworded. The alternative was a `kind` field on
`AgentEvent` — a type persisted to every run's event log and re-read by replay
(NFR-7), so widening it for an observability nicety means a contract change, a
migration for existing logs, and a replay path tolerating both shapes. Both
matched phrases have exactly one call site each and both are pinned by tests, so a
reword breaks a test rather than silently degrading every future record; and a
miss is cheap, since the record is still written and still grouped, just under the
general kind.

### Two defects found by using it rather than reviewing it

**The run-level capture was missing while this file's own doc comment claimed it
existed.** A real run found it: `--max-cost 0.30` is below what a planning turn
costs against a 156-agent roster, the CLI returned `budget_exhausted`, the run
failed before any assignment existed — and the log stayed empty, because the
dispatcher records assignment failures and there were no assignments. The capture
now sits in `executeRun`'s own catch. Reproduced afterwards at `--max-cost 0.02`,
and the record is there.

**`npm run diagnostics` read the wrong directory.** It resolved `runs/` from
`process.cwd()`, and npm workspaces run the script with the cwd set to
`packages/server` — so it looked in `packages/server/runs/`, found nothing, and
printed "Nothing has been logged yet" while the real log sat at the repository
root with records in it. A reader that says "nothing is wrong" when it is looking
in the wrong place is worse than one that errors. It uses `defaultRunsRoot()` now,
which is why `purge.ts` already did: the same bug, already solved once here.

### A third defect, found by the suite rather than by a run

The first version awaited `ctx.diagnostics?.record(...)` unconditionally. Optional
chaining on an absent sink still yields a microtask, so every existing caller —
all of which pass no sink — got an extra `await` per non-fatal error event. The
full suite then failed the FR-M8 test that asserts an in-flight lane is cut short
when the token budget trips, while the same file passed 44/44 on its own: a
scheduling change under parallel load, bought for nothing.

Every capture site now checks for the sink before awaiting, so the no-sink path is
byte-for-byte what it was. Two consecutive full runs are green. The lesson is not
"that test is flaky" — it is that an observability hook which changes when other
code runs is not observing.

### Agents used the channel, and said something nobody had asked them

Two real runs answered the question the entry above left open.

**The first run failed, and found a gap in this feature.** An audit of the server
package, at `--max-cost 1.00`, ended with both assignments hitting
`budget_exhausted` — auditing a repository means reading a lot of files, and that
task shape is dearer than the Phase 13 matrix's. The log recorded the failures and
the tool denials and **nothing from the agents**, because `parseAgentNotes` ran
only on the success path, after a report was persisted.

That is the kind defined for failures being unable to survive one.
`[[BLOCKER: ...]]` exists precisely for "something stopped me producing what was
asked for", which is a sentence an agent writes on its way to failing. Fixed:
`failAssignment` now takes the agent's accumulated text and parses markers from
it, at the five failure sites where the provider actually ran. The two sites that
fail before the agent speaks — an unknown agent name, a brief that could not be
assembled — pass nothing, because there is nothing to read. The failure record is
written first, so a reader gets "this failed" and then the agent's account of why.
The test for it was confirmed to fail against the unfixed dispatcher.

**The second run succeeded and produced the first live markers.** Same task at
`--max-cost 3.00`: `error-detective`, `qa-expert` and `code-reviewer`, three done,
zero failed, `attempts=1` each, 4.7M input tokens.

Both notes are the same shape, and it is not the shape this feature was designed
around. Neither agent asked for a tool. Both disclosed **the boundary of what they
had actually examined**:

> Budget ran to roughly 80% of the $3 allocation covering ~35 of the package's 101
> source files in depth … Files not read in depth — registry/, apiConfig.ts,
> composeTools.ts, claude-code/tools.ts and mcpConfig.ts, env.ts, authToken.ts …
> — `error-detective`

> I scoped this report to `dispatcher.ts`/`dispatcher.test.ts` since that's the
> only source pair with pending changes … a full line-by-line trace of error paths
> across all ~39 other `*.test.ts` files was not achievable within a proportionate
> slice of this budget. — `qa-expert`

Both then produced confident reports naming "the three weakest spots". A reader of
the PDF would reasonably assume the whole package had been audited; the note is the
only place that says otherwise, and before this it would have been a caveat inside
a document nobody re-reads. **Coverage disclosure was not one of the three kinds
this was built for, and on the evidence it is the most useful thing the channel
collects.**

Both chose `NOTE` over `ENHANCEMENT` or `BLOCKER` correctly — nothing blocked them
and neither wanted a capability — and both wrote about the system rather than about
the task, which is what the brief warns against. The instruction landed.

### Granting the shell, and what three agents did with it

`AGENT_OFFICE_ALLOW_SHELL=1` for one invocation, same audit task and same
`--max-cost 3.00` as the run above, so the two are comparable.

**The grant took effect, and the log is how you know.** Zero `tool-denied` records
for this run, against 8 across the previous three. `npm run diagnostics --kind
tool-denied --since 30m` matches nothing. That is the diagnostics log confirming a
capability change rather than confirming a flag parsed.

**The agents spent it finding a defect in the briefing.** Three of them, working
separately under FR-M5 isolation, converged on the same thing — and it is a real
design flaw nobody had noticed in eight phases:

> `git ls-tree -r HEAD` is scoped to the current directory prefix, so from an
> attempt workspace nested inside the target repository it returns zero entries and
> **reads exactly like an empty repo**. One specialist on this task hit that and
> filed a BLOCKER instead of a report, producing nothing usable.
> — `architect-reviewer`

The specialist in question was `error-detective`, and its `[[BLOCKER: ...]]` is the
first one a live model has written:

> `git ls-tree -r HEAD` is empty on `test-1`, `main`, `verify-phases-0-and-2` …
> There is no server package (or any code) in this repository to audit.

Wrong conclusion, correct symptom. `code-reviewer` hit the same wall, walked up to
the git root to escape it, and costed the detour: "Seeding the attempt workspace
with the target repo — or naming its path in the brief — would have saved four tool
calls per specialist."

**The cause is AO-8 meeting a brief that never says where the work is.** Each
assignment gets `runs/<id>/workspace/<assignmentId>/attempt-<n>/`, which is empty
by design and — because `runs/` lives inside this application's own checkout — is
a subdirectory of a git repository that has nothing to do with the task. An agent
that reasons from its own working directory therefore learns something false. With
`Bash` withheld this stayed quiet: agents used `Glob` and `Grep`, found files by
searching, and never asked git anything. Grant the shell and the same flaw becomes
a blocker in the first run.

That is the argument for the shell grant and against it in one observation. The
agents got further and were more honest about where they were; the thing they found
first was ours.

### A run can report complete success while a third of it produced nothing

The same run finished `3 done, 0 failed`. `error-detective`'s deliverable is a
3,993-byte explanation of why it could not do the work, against 18,687 and 16,719
from the other two.

FR-M6's guard is `text.trim() === ''`, so *"I could not do this"* is a report. The
requirement says "a missing report is a failed assignment" and means it literally;
the intent — an assignment that did not produce the work is a failed assignment —
is not what the code tests. The synthesis then merged a decline with two real
audits, and the only place the shortfall is visible is the diagnostics log.

Recorded rather than fixed, because the fix is a judgement about what `done` means
and it deserves its own decision: a heuristic on report length would fail a
legitimately short finding, and a marker-based rule ("a report carrying a BLOCKER
is not a success") would make the agent's own honesty the trigger for failing it.

### The shell wrote nothing outside its workspace

`git status` was clean against the `dfb1f6a` baseline afterwards, and the repo-root
`reports/` directory was unchanged. One observation is not a guarantee — a shell is
not confined by `cwd` and this is exactly the boundary Phase 13 recorded as
advisory — but it is the first direct measurement of that boundary with the shell
actually granted, and it came out clean.

### `declined`: a decline is no longer a success

The run above finished `3 done, 0 failed` while one of the three had produced
3,993 bytes explaining why it could not do the work. FR-M6's guard is
`text.trim() === ''`, so *"I could not do this"* is a report. The requirement
means an assignment that did not produce the work is a failure; the code tested
the letter.

**The vocabulary gained a third terminal status**, on the precedent this document
already set when `cancelled` was added: *a status vocabulary that cannot say
"stopped" forces every reader of it to say "broken" instead.* `declined` is the
thing it could not say next — the agent ran, reached a conclusion about its own
ability to proceed, and said so. Not `failed`, because nothing went wrong and a
red cross on that behaviour would punish the one thing this system most wants to
encourage. Not `skipped`, which is the *dispatcher's* decision that an assignment
could not run; this is the *agent's* report that it did.

**The trigger is the agent's own `[[BLOCKER: ...]]`**, whose documented meaning
was already "something stopped me producing what was asked for" — i.e. there is no
work product. The earlier objection to this — that it makes honesty the trigger for
failing an assignment — only holds if the marker is ambiguous, so the brief now
says outright that `BLOCKER` means *you did not produce it*, that it changes the
outcome, and that an agent which did the work and wants to flag a limitation uses
`NOTE`. A test pins that an `ENHANCEMENT` or a `NOTE` leaves the assignment `done`.

Four consequences, each decided rather than inherited:

- **The report is still written, still reaches dependents, still reaches
  synthesis.** It explains why the work is missing, which is the most useful thing
  anyone downstream can be told. Only the status changes.
- **Synthesis is told.** `collectReports` filtered on `status === 'done'`, so the
  new status would have made declines vanish from the synthesis prompt entirely —
  the Manager silently covering two objectives out of three. They are included and
  **labelled**: "This agent DECLINED the assignment: it did not produce the work…
  record the objective as a gap." Passing them unlabelled is what used to happen,
  and it invites the model to merge a decline as though it were a finding.
- **`declined` is sealed**, like `failed` and `skipped`. The tempting edge is
  `declined -> briefing`, since a declined assignment is a better retry candidate
  than a successful one — but nothing re-dispatches one, and a legal edge no code
  takes reads as a retry path that exists.
- **The marker parse no longer depends on observability.** It ran only when a
  diagnostics sink was configured, which was fine while it was purely
  observational and wrong the moment it decided an outcome: a run's result must not
  depend on whether logging is switched on.

The office gets an `alert` bubble and an amber badge, not `failed`'s slumped pose
and red — the same distinction in pixels that the status draws in words. The CLI
summary prints `, N declined` only when it happened, so the common line is
unchanged and the misleading one is impossible.

**Cost, stated rather than absorbed:** the brief's fixed overhead grew by 1,797
characters across this change and the working-directory section — about 450 tokens
on every assignment call. The size test that caught it had its budget widened from
+3,000 to +4,000 with both figures measured, not estimated. The invariant it
guards ("the cap plus a small constant, never proportional to the report") is
unchanged.

### The run that exercised `declined`, and the three defects it found

Same audit task, shell granted, `--max-cost 8.00`. Three assignments, run `done`,
one of them `declined` — the status working end to end on a live model for the
first time. Almost everything else about it was a finding.

#### The decline was a false positive, and the mechanism matters

`error-detective` wrote a 10,017-byte audit naming three real defects. It was
recorded `declined`.

The cause: one of its findings *discusses this very mechanism*, and quotes the
marker while doing so —

> …every specialist the Manager picked reports `[[BLOCKER: ...]]` because the
> request is genuinely out of scope for them…

`parseAgentNotes` matched the quotation. A completed, high-quality assignment was
filed as having produced nothing, and the diagnostics log gained a `blocker` whose
entire message is `...` — the literal placeholder from the brief's own example.

This is the failure mode the design went out of its way to avoid, arriving by a
route nobody considered. The reasoning recorded for making `BLOCKER` load-bearing
was that its meaning is unambiguous; that is true of an agent *declaring* one and
false of an agent *citing* one. The brief asks for the marker in inline code
(`` `[[BLOCKER: ...]]` ``), so formatting cannot distinguish them either — the
quotation and the declaration look identical.

**Not fixed here, because the fix is a decision.** The obvious discriminator is
position: `review.ts` requires its verdict marker on its own line, and the same
rule would separate a declaration from a citation cleanly. But it changes what
counts as a marker for every agent, and this run is one data point. Recorded as
the open question it is.

The irony is worth keeping: an agent auditing this codebase was penalised for
describing it accurately.

#### A run of nothing but declines would have failed with a false message

`error-detective`'s own second finding, reached by reading `runner.ts:423` against
`collectReports`'s doc comment and noticing they disagree:

> `tally.completed` is `0` even though every assignment wrote a real report
> explaining why. The run is marked `failed` with the message *"no assignment
> produced a report; nothing to synthesise"* — which is factually wrong (reports
> exist) — and synthesis … never runs.

Correct, and a regression introduced by adding `declined` two commits earlier.
Those assignments used to count as `completed`; as a separate bucket they made
`completed === 0` true. The condition now tests whether anything *wrote a
document*, which is what it always meant. A test covers it.

An agent found a defect in the change that was being tested by the run it was
doing. That is the diagnostics channel paying for itself.

#### The summary line never printed the decline it was written to print

The run reported `2 done, 0 failed, 0 skipped` for a **three**-assignment plan.

The counter was correct, the status was correct on disk, and the CLI simply never
read it: the edit that was supposed to add `, N declined` was never applied. The
script that made it printed a success message unconditionally and matched nothing,
and nothing checked afterwards. The commit that added `declined` **claims in its
message that this line prints the count.** That claim was false when written.

Two lessons, and the second is the one worth keeping. Counting a thing and
displaying it are two changes, and only one of them had a test. And a scripted
edit that reports its own success without verifying it is worse than no report at
all — the whole point of the summary line was to stop a run claiming a success it
did not have, and it failed at exactly that, in exactly that way.

Fixed, and verified by driving a decline through the real summary path rather than
by reading the diff: `1 done, 0 failed, 0 skipped, 1 declined`.

#### What went right

The softened working-directory wording worked. No agent filed the ambiguity note
that prompted it, and `error-detective` audited `packages/server` on the correct
branch without commentary about where it was standing.

`code-reviewer` used the channel for something genuinely new — a tool defect:

> The Grep tool returned false negatives on this repository. `Grep(pattern="pdfError",
> path=".../packages/server/src")` … reported "No matches found", while `Grep` on the
> single file … found 3 matches and `git grep -n "pdfError"` found the same 3 … I
> caught it only because I was about to assert a negative and re-checked.

That is the first record in the log that is about the *environment* rather than
about this codebase or its briefs, and it is exactly the kind of thing that would
otherwise have been a parenthesis in a report nobody re-reads.

The granted shell again wrote nothing outside its workspace: `git status` clean
against the `1aaeaf5` baseline.

#### Known gaps carried forward

- ~~**The marker false positive is open.**~~ Closed above: markers must open a
  line, fenced blocks are stripped, and the fix is verified against the report that
  caused it. The equivalent hole in `review.ts` is documented and open.
- **A genuine live decline has still not been observed.** The one that occurred was
  a citation. `declined` is proven by test and by this accident, not by an agent
  that meant it.

### The marker false positive, closed against the report that caused it

A marker now counts only when it **opens a line**, and fenced code blocks are
stripped before matching.

Position is the discriminator, and the run's own artifacts chose it rather than
taste. In one run, `code-reviewer`'s genuine note began at column 0 on its own
line; `error-detective`'s citation sat mid-sentence inside inline code. An agent
DECLARING something puts the marker where a reader will see it; an agent
DESCRIBING one writes it into a sentence.

Verified against the real reports before anything else: re-parsing all three from
run `20260814-212704-3z7s` now yields one note (`code-reviewer`'s, intact) and zero
from `error-detective` — so that assignment would be `done`, which is what it always
was. The tests are built from those two strings verbatim rather than from invented
examples.

Two smaller guards came with it. A body containing no letter or digit is rejected,
because `[[BLOCKER: ...]]` — the literal placeholder this file's own brief prints —
was copied verbatim by a model and became a record whose entire message was three
dots. And the brief now states the placement rule, phrased so it also tells an agent
how to write *about* the markers safely: "A marker written inside a sentence is read
as a quotation, not a declaration."

**Five existing tests failed, correctly.** Their fixtures declared markers
mid-line (`'nope [[BLOCKER: ...]]'`) because nothing had required otherwise. They
now declare them the way the brief asks, which is the rule being enforced on its
own test suite.

### The same weakness in `review.ts`, recorded rather than fixed

`VERDICT_MARKER` matches anywhere too, so a reviewer explaining the review loop
could quote a verdict and buy a re-dispatch. Its doc comment asserted this could
not happen — "`[[...]]` is not a phrase anyone writes in ordinary prose" — and that
claim is now corrected in place, because a live agent disproved its twin.

The behaviour is deliberately left alone. The trade differs: that parser *wants*
the marker found even when a model fences its whole report, and a missed verdict
silently disables FR-M10 where a spurious one costs a single re-dispatch. Changing
it is its own decision with its own failure mode.

### The fourth audit run, and the limit that moved

Same task, shell granted, `--max-cost 8.00`, with all four fixes present. Run
`done`: **1 done, 1 failed, 1 skipped**.

**No false decline.** `error-detective` completed as `done` with a 7,897-byte
report. Worth stating precisely, though: that report contains **zero** marker
occurrences, so this run did not re-exercise the citation case. The marker fix is
verified against the report that broke it; a live report *quoting* a marker and
surviving has not recurred, and claiming otherwise would be reading more into a
green run than it says.

**The binding constraint moved from cost to wall-clock.** `code-reviewer` timed out
at exactly 600,000ms — the FR-M8 default — where the two previous runs had died on
`--max-cost`. Raising one limit simply moved the failure to the other, which is the
sign that neither was measuring the task; both were measuring a default chosen
before anyone had run a repository audit through this system.

So the default is now **20 minutes**, and the reasoning matters more than the
number. `--max-cost` is the *spend* bound, enforced per invocation by the CLI
itself. `assignmentTimeoutMs` is a *liveness* bound: it exists so a hung provider
cannot hold a run open forever, not to control money. With spend capped separately,
a longer wall-clock buys a slow-but-honest assignment room to finish and costs only
later detection of a genuine hang — and a hang caught at 20 minutes is still caught.
Not raised further, because the failure at the other end is a run that looks alive
for most of an hour while nothing happens. `--timeout` remains for a task shape
someone has actually measured.

**A second copy of that default had to move with it.** `useSettings.ts` mirrors
`DEFAULT_DISPATCH_OPTIONS` by hand — its own comment says so — and it drifted the
instant the server's changed. It stays a copy, because `packages/web` does not
depend on `@agent-office/server` and adding that dependency to share one number
would be the larger mistake; the drift is now noted where the copy lives.

**One failure still stranded a third of the plan.** `architect-reviewer` was skipped
because it depended on both upstream assignments. That is `dependenciesUnreachable`
working correctly, and it means any per-assignment limit is effectively a run-level
one on a chained plan — the third run in a row where a single assignment's death
cost more than itself.

**A run can be `done` with a third of its team failed and another third skipped.**
This one was: it synthesised from the single surviving report. The summary line says
so plainly; the run *status* does not, and that asymmetry is now visible in the
record even though nothing here changes it.

The granted shell wrote nothing outside its workspace for the third consecutive run.

### Five of five plans ended in the same fragile shape

Measured across every live audit run rather than argued from taste:

| run | assignments | last assignment | depends on | outcome |
|---|---|---|---|---|
| 111652-eelx | 4 | `fix-plan` | 3 of 3 | done |
| 132657-jhcr | 3 | `rank-weakest-three` | 2 of 2 | **skipped** |
| 152212-xa4a | 4 | `name-top-three` | 3 of 3 | **skipped** |
| 212704-3z7s | 3 | `name-the-three` | 2 of 2 | done |
| 221223-ckji | 3 | `rank-weakest` | 2 of 2 | **skipped** |

Every plan ended with an assignment that consolidates the others and therefore
depends on all of them. **Three of the five were skipped** when a single upstream
assignment died — and the two that ran duplicated FR-M7, since the Manager's
synthesis merges every report anyway.

Redundant when it succeeds, and the single point of failure when it does not. That
is the whole finding, and it is why the fix belongs in the planning prompt rather
than in the dispatcher: `dependenciesUnreachable` skipping a dependent whose input
never arrived is correct behaviour. The defect is upstream of it, in a plan shape
that creates the dependency at all.

Two hard rules now say so. The first forbids the terminal consolidator and gives
the reason — "you merge every report yourself after dispatch… a 'pull it all
together' assignment does it twice" — because a rule a model cannot justify is one
it will talk itself out of. The second prices dependency edges generally: "every
edge you add is a way for one failure to cost two assignments; an assignment that
could start immediately should."

The worked example was checked and did not need changing: it already ends with two
parallel reviewers rather than a merger. A test now pins that, because the example
is the strongest instruction in the prompt and a rule arguing with the example
above it would lose.

**Unverified against a live model.** The rules are pinned by prompt tests; whether
a real planner obeys them is one run away, and the same table above is how it will
be judged.

### The dispatcher alternative, considered and refused

The other available fix was to run a dependent on *partial* inputs when some
dependencies survived, rather than skipping it. Refused: this document already
records, in the FR-M11 notes, that a same-phase dependency race is "not a deadlock,
it is a silent degradation" — an assignment briefed on a report that never arrived
"quietly finds no report, producing a plausible answer from an incomplete brief".
Choosing that shape deliberately would be adopting a defect the project has already
named. If it is ever wanted, the honest version tells the agent in its brief which
dependencies are missing and why, as `collectReports` now does for declines.

### Rule 7 was over-broad, and the run that tested it said so

The next audit run produced this plan:

| phase | assignment | agent | depends on |
|---|---|---|---|
| survey | `map-error-paths` | code-reviewer | — |
| survey | `failure-mode-analysis` | error-detective | — |
| assessment | `weakest-spots` | debugger | both |

By the pre-registered test that is a sixth consecutive failure: the last assignment
still depends on every other one. By any sensible reading it is a good plan, and the
rule is what is wrong.

**The task says "name the three weakest spots".** The final assignment is therefore
the *deliverable*, not bookkeeping on top of it. A planner obeying rule 7 as written
would have surveyed the error paths and never answered the question asked. The rule
said "do not end the plan with an assignment that consolidates, ranks or summarises
the others" — and for this task, ranking IS the work.

Two different things had been collapsed into one prohibition:

- a final agent producing **the task's own answer** — legitimate, and what this plan
  does;
- a final agent whose objective is **merging reports** — the FR-M7 duplication the
  rule was actually aimed at.

The discriminator is whether the last assignment *adds judgement* or merely
*collates*, and the first wording could not tell them apart. It now says so
explicitly: "This is about duplication, not about dependencies… if the task itself
asks for a judgement that can only be made once the parts are in — 'name the three
weakest', 'recommend one option', 'decide whether to ship' — then that judgement IS
the work". The cost of the edge is still stated, because a planner should know what
it is buying; it is no longer forbidden from buying it.

A test now pins the *permission* as well as the prohibition, so a future tightening
that re-breaks this task fails here first.

**What the original observation was worth.** Not nothing: three of five earlier
plans were stranded by that final edge. But the fix for that is not "never depend on
everything" — it is either accepting the edge when the task demands a synthesised
answer, or the dispatcher change refused above (brief the dependent on which inputs
are missing). The rule as first written would have made the planner worse at exactly
the task it was written for, which is the kind of correction worth recording at
length rather than quietly editing away.

### The run itself, and the first live `ENHANCEMENT`

`3 done, 0 failed, 0 skipped`; reports of 27,769, 10,246 and 13,584 bytes; synthesis
and PDF produced. Every fix from the preceding commits held at once: no false
decline, no workspace-ambiguity note, and the 20-minute timeout absorbed an audit
that had previously died at 10.

`code-reviewer` filed the first `ENHANCEMENT` a live model has written, and it is
the same defect a different agent reported two runs earlier, now with evidence:

> The Grep tool returned incorrect results twice during this audit and both were
> **silent failures, not errors**. (1) `Grep` for `pdfError|htmlPath` across
> `packages/` returned "No matches found"; a PowerShell `Select-String` over the same
> tree immediately found 8 matches, including three in the very file I had just read
> them in. (2) `Grep` in `count` mode for `\\bcatch\\b` reported 37 files and omitted
> the entire `reports/` directory…

Two independent agents, two runs apart, reporting the same tool returning false
negatives on this repository — and the second only caught it because it cross-checked
against a shell it now has. The earlier note guessed at a cause worth keeping with it:
"the repository path contains a space ('Agent Office'), which may be the trigger".

That is the diagnostics log doing the thing it was built for. A single agent's
parenthesis about a flaky tool is noise; the same complaint from a second agent, with
a reproduction, is a defect report about the environment this system runs in. Not
this repository's bug to fix, and precisely the sort of thing that was previously
lost inside a report nobody re-reads.

**Also observed, and not yet acted on:** the `claude` CLI's OAuth token expired
between runs, and `isAvailable()` did not catch it — the preflight shells out to
`claude auth status`, that reported signed-in, and the run failed at the first model
call with a 401. SETUP.md describes the preflight as catching exactly this and
"reporting itself unavailable with that reason rather than spawning a run that cannot
work". True for *not signed in*; false for *signed in with an expired token*. The
run-level diagnostics capture recorded the failure correctly, which is how it is
visible at all.

### The preflight cannot see an expired sign-in, so the failure now names the fix

`checkClaudeCodeAvailability` shells out to `claude auth status` and trusts
`loggedIn`. Captured from the real CLI (2.1.229), that command prints:

```
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "email": "...", "orgId": "...", "orgName": "...", "subscriptionType": "max" }
```

**No expiry field of any kind.** A session whose token has expired still reports
`loggedIn: true`, so there is nothing for the preflight to test — a run starts
normally, spawns a child, and dies at its first model call with a 401. That is not
theory: it happened between two runs on this machine, and what reached the user was

> Manager turn "manager-plan" failed in the provider: Failed to authenticate. API
> Error: 401 OAuth access token has expired. Re-authenticate to continue.

Accurate, and it never names the command.

`parse.ts` now recognises that shape where the CLI's error is turned into an event,
and appends the remedy — so `run claude auth login` travels with the failure into
`run.json`, the diagnostics log and the UI alike, rather than being something the
reader has to already know. The hint also says *why* nothing caught it earlier,
because the natural next question is "then what is the preflight for".

Two independent phrases must match, not one. This is a heuristic over a vendor's
human-readable string: the cost of a miss is a sentence not appended, while the cost
of a false positive is telling someone to re-authenticate when that is not their
problem. A test drives a 403-about-authentication through the same path and asserts
the hint stays away.

**The alternative was refused.** The preflight could only know for certain by
spending a model call, and a preflight that costs money on every dispatch is a worse
trade than a clear failure. What could be fixed was the claim, not the capability.

SETUP.md said the preflight "catches this and reports itself unavailable rather than
spawning a run that cannot work" — true for *not signed in*, false for *signed in
with an expired token*, and it now says both. `checkClaudeCodeAvailability`'s own doc
comment carries the same correction: `ok: true` means "a session exists", not "the
session works".

### Phase 15 — five shards in parallel, and the rule the split had to obey

Five workers, file-disjoint, one manager. The hard constraint was that no two
workers could touch one file; everything cross-cutting was withheld and done at
integration. What that bought is visible in the outcome: five shards landed with no
merge conflicts, and the two genuine integration problems below were found by the
manager rather than by a worker guessing.

**FR-S4 — the only partial Must, now built.** Recon settled its shape before any
code: `category` and `description` already reach `App.tsx` via `fetchAgents()` and
stop at `InspectPanel`; the office canvas never receives them; and hover and
keyboard focus already share one `indicatedId`. So the fix is a prop and a DOM
reveal, not a new fetch and not Pixi text — the plate is canvas-drawn with fixed
line budgets, and DOM is also readable by assistive tech, which keeps the parity
discipline `OfficeCanvas.tsx` states about itself. `agentIndicatorFor` is a pure
function returning `undefined` for an unknown name, because the roster has not
loaded on first paint.

**FR-R5 — the watcher is built and tested; it is not yet wired, and that is a
finding, not an omission.** 300ms debounce restarted per event; a failed re-index
keeps the last good registry and reports rather than poisoning `current`; the
recursive-watch fallback degrades instead of throwing where the platform lacks it.
But `buildServer({ registry })` and `new RunSupervisor({ registry })` capture the
registry BY VALUE — `deps.registry.agents`, `deps.registry.byName` — and the
watcher yields a NEW `Registry` per reload. Nothing downstream would ever see it.
Making FR-R5 real means changing that seam from a value to an accessor across
`ServerDeps`, `SupervisorDeps` and their call sites, which has its own test surface
and deserves its own pass. Recorded rather than bolted on.

**FR-P6 — markdown and per-agent export exist at the library level.**
`buildMarkdownBundle`, `buildAgentMarkdown`, `buildAgentReportHtml`, and an
`AppendixNotFoundError` matching how `pdf.ts` already signals failure. Two decisions
worth keeping: the markdown bundle DOES include the design rationale, which
`deliverable.ts` sets and `document.ts` has never rendered — re-shipping a known gap
because the PDF has it was rejected as a reason. And escaping was reasoned from the
actual pipeline rather than by reflex: nothing parses this `.md` as HTML, so the
HTML-injection defences do not apply, while the risk that does — an unclosed fence
in one agent's report swallowing every later section — is closed per section. **No
HTTP routes yet**: exposing them means adding `API` entries to `wire.ts` first,
since this codebase refuses locally-invented routes.

**The client is served by one command.** `npm start` builds the web package and
runs the server, which now serves `packages/web/dist`. The token question was the
real design work: the shell is public, `/api` and `/ws` stay gated. A browser's
first top-level navigation cannot attach a header, so gating `index.html` would
401 a bookmarked `http://127.0.0.1:5179/` with no in-browser recovery — while the
bundle itself carries no run data, since everything sensitive comes from the gated
API. Verified against a running server: `/` returns 200 without a token, `/api/agents`
returns 401 without and 200 with.

**Traceability, and what it honestly measures.** 60 requirements parsed from
PLAN.md, 69 test files scanned, **13 with no test naming them — 6 of them Musts**
(FR-R3, FR-P5, NFR-4, NFR-9, FR-T2, FR-T4). Read that list carefully: NFR-9 is the
startup token, which `authToken.ts` and `server.test.ts` cover thoroughly under the
name AO-6, and FR-T2/T4 are tested as AO-1 and the MCP allowlist. The tool finds
requirements nobody has *claimed*, not requirements nobody has tested, and its
`--help` says so.

Its sharpest result is about itself: **FR-S4 was never zero-mention.** It was named
in `sim/model.test.ts` throughout the months it sat half-built. This tool would not
have caught the drift it was proposed to catch, and it states that limit rather than
implying otherwise.

### A source directory was excluded from version control

Found by a worker whose four new files never appeared in `git status`.

`.gitignore` carried a bare `reports/` rule, added for the repo-root audit
write-ups. Bare, it matches a directory of that name at ANY depth — including
`packages/server/src/reports/`, which is the entire markdown/HTML/PDF deliverable
layer. The files already there stayed visible only because they were tracked before
the rule landed, so nothing looked wrong; every NEW file in that directory was
silently untracked and one `git add` away from being lost for good.

Now `/reports/`, anchored to the repository root. Verified both directions: the four
new source files appear in `git status`, and the repo-root write-ups are still
ignored.

This is the second time this session that a rule written for one directory has
quietly applied somewhere else, and both were found by accident rather than by a
check. A gitignore rule for a name as common as `reports` should be anchored on the
day it is written.

### Wiring the two shards that could not wire themselves

The parallel pass deliberately left two integration points to the manager,
because both crossed files a worker owned. Both are now closed, and both needed a
decision the shard could not have made alone.

**FR-R5 now takes effect.** `buildServer({ registry })` and
`new RunSupervisor({ registry })` captured the catalog by value, and the watcher
yields a NEW `Registry` per reload — its maps are readonly, so there is nothing to
mutate in place. Both dep types gained an optional `getRegistry?: () => Registry`,
every read goes through it, and `serve.ts` starts the watcher and hands both an
accessor. Absent means "read the value", so every existing caller and test is
byte-for-byte unchanged: this is a widening, not a breaking change.

One decision worth stating: the supervisor resolves the registry **per
`startRun`**, not once. A run started after an agent file is edited sees the edit;
a run already in flight keeps the catalog it began with. Swapping mid-dispatch
would let an assignment's agent change definition between its brief and its
report, which is a worse failure than a slightly stale run.

Proven against a live server rather than asserted: `/api/agents` returned **156**,
adding a probe agent file took it to **157** with the new agent present in the
response, deleting it returned it to **156**, and the server logged
`registry reloaded` at each step. No restart.

**FR-P6 is reachable over HTTP.** The bundle is written at `designing` time,
beside the HTML and PDF, from the same `ReportDocument` — not assembled per
request. Reconstructing one in a route would duplicate `produceDeliverable`'s
assembly and could disagree with the very PDF it claims to be an alternative to.
`GET /api/runs/:id/report.md` serves it as `text/markdown`, because a caller
saving an export should get a file rather than a quoted JSON string.

Runs that finished before the bundle existed have none, and the route says so in
those words instead of returning an empty body. Verified live: **200** with
`text/markdown; charset=utf-8` for a fresh run, **404** naming the reason for an
older one.

The route entry went into `wire.ts` first. This codebase refuses locally-invented
routes, and that rule is the reason the client and server have never disagreed
about a URL.

**Per-agent PDF is still library-only.** `buildAgentReportHtml` feeds the existing
renderer, but exposing it as a route means rendering a PDF on a GET — a decision
about timeouts, temp files and whether the result is cached, which deserves its own
pass rather than being appended to an integration step. Per-agent *markdown* is
already reachable: `assignmentReport` has served it since Phase 3.

### The narrowed rule, checked against a live planner

Same audit task, shell granted, `--max-cost 8.00`, from the tree with Phase 15 and
its wiring in place. **4 done, 0 failed, 0 skipped.**

| phase | assignment | agent | depends on |
|---|---|---|---|
| evidence-gathering | `catalogue-error-paths` | code-reviewer | — |
| evidence-gathering | `failure-mode-analysis` | error-detective | — |
| evidence-gathering | `server-contract-review` | backend-developer | — |
| ranking | `rank-three-weakest` | architect-reviewer | all three |

This is the result the rewrite was aiming at, and it is worth being precise about
why. Three assignments run in parallel with **no edges between them**, and one
final assignment makes the judgement the task asked for. Both halves matter:

- The planner did **not** avoid a final judgement step. Had it done so, the
  narrowing would have over-corrected — the task says "name the three weakest
  spots", and a plan that surveys without ranking does not answer it.
- It also added **no gratuitous ordering** among the three surveys, which is what
  rule 8 asks for. The single edge that exists is the one the task requires.

It is the widest plan any run has produced — three parallel where earlier ones
managed two — and every assignment finished. The first version of rule 7 would have
forbidden this plan's last assignment outright.

One run is not proof against a six-run prior, and the earlier table stands as the
record of what the shape used to be. But this is the first evidence in the right
direction, and it came from a planner reading the rule cold.

**Phase 15's work held under a real run.** The markdown bundle was written at
`designing` time beside the PDF — 103,439 bytes of bundle, 1,130,339 of PDF, from
the same `ReportDocument`. That is FR-P6 exercised by an actual deliverable rather
than a fixture, and the first bundle a live model has produced.

**Zero diagnostics for the run**: no tool denials (the shell was granted), no
failures, no agent markers. The agents had nothing to say about the system, which is
what the brief asks for — "most reports should carry none of these". Silence here is
the channel working, not the channel broken.

The granted shell again wrote nothing outside its workspace, the fourth consecutive
run to leave `git status` clean.

### Per-agent PDF, the last piece of FR-P6

`GET /api/runs/:id/report-file.pdf?path=reports/NN-agent.md` renders one agent's
report and returns it as a download. It shares the `?path=` identity of
`assignmentReport`, because the two are one document in two formats and giving the
PDF its own way of naming an agent would be a second identity to keep in sync.

**Rendered on demand, not at `designing` time.** Each render launches headless
Chromium, so producing every agent's PDF up front would make a four-agent run pay
five launches instead of one, for files almost nobody opens — the combined PDF is
what people download. The markdown bundle went the other way, and the difference is
not inconsistency: the bundle is a pure transform of a `ReportDocument` that exists
only during the designing step, so building it later would mean reconstructing that
document and risking disagreement with the PDF beside it. A per-agent PDF needs one
appendix plus run-level facts, all of which survive in `run.json` and the report
file.

**Cached as the sibling of its source** — `reports/03-x.md` renders to
`reports/03-x.pdf`. A second request becomes a file read, the artifact stays inside
the run directory where `runs:purge` will collect it with everything else, and it is
discoverable by anyone browsing the run rather than hidden in a temp directory.

**Single-flight per report.** Two clicks a second apart would otherwise launch two
Chromium processes writing one output file, and the bytes that survive would be
whatever interleaving produced — the same discipline `dispatcher.ts` applies to
concurrent reviewers of one target.

**Containment is inherited, not re-implemented.** The markdown is read first, and
that ordering is the security property: `readReport` resolves the client-supplied
path against the run directory and refuses anything escaping it (NFR-1), so by the
time a render is considered the path is proven safe and the file proven to exist.
The PDF path is then derived from that validated string by replacing its extension —
a sibling cannot reach a directory the original could not. `agentPdfPathFor`
deliberately does no normalising of its own, because a second, weaker containment
check is how two checks come to disagree.

Verified against a running server, not asserted:

| check | result |
|---|---|
| first request | **200**, `application/pdf`, 496,574 bytes, `%PDF-1.4` magic |
| filename | `agent-office-<runId>-01-code-reviewer.pdf` |
| cached on disk | `runs/<id>/reports/01-code-reviewer.pdf`, same 496,574 bytes |
| second request | **200** in 60ms — a file read, no second render |
| `?path=../../package.json` | **400** |
| no token | **401** |

FR-P6 is now complete on both halves: markdown for the whole deliverable and for
each agent, PDF for the whole deliverable and for each agent.

### The standing question the log now raises

`tool-denied` is at **8 occurrences across 3 runs and 5 agents**, all of them
code-reviewing specialists asking for `Bash`, and two of those agents separately
reported they could not verify what they were reviewing. That is not a defect to
fix in this file — AO-1's deny-by-default is working exactly as designed and for
good reasons — it is a capability decision now backed by evidence instead of
intuition, which is what the log was built to produce. `AGENT_OFFICE_ALLOW_SHELL`
exists for anyone who reads that and decides the trade is worth it for a given
deployment.

### Corrected while reading the results

An earlier reading of the mid-flight log took the `qa-expert` `budget_exhausted`
record as a failure inside the successful run that a retry had rescued. It was
from the *previous* run: `attempts=1` on all three assignments of the second run
says no re-dispatch happened. Recorded because the mistake is the easy one to make
with a cross-run log — the grouped view deliberately mixes runs, so a record's run
id matters as much as its message.

### Known gaps carried forward

- ~~**No live model has written a marker.**~~ Closed: two agents wrote notes in a
  real run, correctly scoped to the system rather than the task. See above.
- **The failure path has still never fired on a live run.** It is covered by a test
  confirmed to fail without it. The live `[[BLOCKER: ...]]` above arrived through
  the *success* path, because the assignment that wrote it was recorded `done` —
  which is its own finding, above.
- **`ENHANCEMENT` is still unexercised in the wild.** `NOTE` and `BLOCKER` have both
  been written by live models now. Whether an agent reaches for `ENHANCEMENT` when a
  tool it wanted is refused — the case this was designed around, and one that
  occurred eight times across three runs without producing a marker — is still
  unknown, and the shell grant has removed the most common occasion for it.
- **No UI.** The log is reachable by CLI only. A panel would need a route, a
  poller and a place in a layout built entirely around one selected run, and the
  operator reading this is asking about the deployment rather than a run.
- **Nothing prunes it.** `purge.ts` deliberately cannot touch it, and nothing else
  does either, so it grows forever — slowly, since a healthy run logs nothing at
  all, but with no ceiling.

### The HTTP layer had no voice at all

Found by the seventh audit run and verified by hand before believing it:
`serve.ts` never passed a `logger` to `buildServer`, and `buildServer` defaults
it to `false` so that `.inject()`-driven tests are not drowned in JSON. So
`request.log.error({ err: error }, 'request failed')` — the line that has sat in
the 500 handler since Phase 3 — wrote to a logger that discards everything.
`grep -c diagnostics packages/server/src/http/server.ts` returned `0` for the
other half. A route throwing produced a 500 body for the client and nothing
anywhere else: not a terminal line, not a diagnostics record, and nothing in
`run.json`, which records what the orchestrator did and knows nothing about a
request that failed before reaching it or while reading a report off disk
afterwards.

What makes it worth writing down rather than just fixing is that the reasoning
was already in the file. `serve.ts` hands `DiagnosticsLog` an `onWarning` that
writes to stderr, with a comment saying this process "has somewhere to print it,
unlike a CLI run mid-report". Exactly the same sentence applies to the server's
own failures, and was never applied to them. Second time this session that
something was recorded thoroughly in one place and left unwired in another — the
registry accessor was the first.

**`logger: { level: 'warn' }`, not `true`.** Pino's default level prints an
`incoming request` and a `request completed` line for every poll of
`/api/runs`, which on this UI is a couple of lines a second forever, and a log
nobody can stand to leave open is the same as no log. Measured on the live check
below: one pino line for the whole session, and it was the failure.

**A new `request-failed` kind, 5xx only.** A 4xx is the client being told it
asked wrongly, and the token gate turns every stale browser tab into a stream of
them — logging those would bury the handful of records that mean "this
deployment is broken". The severity is `error`, derived from the kind like every
other, so no call site can file the same thing two ways.

**`runId` is now optional on the record.** A failure in `GET /api/agents`
belongs to the process, not to a run, and the honest shape for that is an absent
key. The alternative — a sentinel like `'server'` — was rejected because it is a
fake id that `--run` would match and that the reader would count as a run in
"N run(s)". Every record already written has the field, so old lines still
parse; the reader prints an absent one as `no run (server process)` in both its
views. This is the same precedent `assignmentId` set: some records are scoped
wider than the thing beneath them.

**The message carries the route pattern, not the URL.** `request.routeOptions.url`
gives `/api/runs/:runId/report-file.pdf`, so ten failures across ten runs group
into one line instead of ten. The error's own text is in the grouping key too,
deliberately: "3× 500 POST /api/runs: provider unavailable" tells an operator
something that "3× 500 POST /api/runs" does not. The cost is that an error
message carrying a path splits one problem across several groups — the same
weakness `classifyProviderWarning` documents, accepted here for the same reason,
and visible in the live check below.

**Never awaited.** The reply does not wait on a disk write, and `record` never
throws by contract. A diagnostic that could fail a response would make the
observability layer able to break the thing it observes.

Verified against a real `npm run serve` on a temp runs root — a scripted run to
`done`, then a per-agent PDF request whose output path was blocked by a directory
of the same name, which is a genuine render failure rather than a stubbed one:

| check | result |
|---|---|
| the request | **500**, `{ error: ... }` in the contract shape |
| terminal | one pino line, `"level":50`, `"msg":"request failed"` |
| pino lines for the whole healthy session | **1** — the failure, and nothing else |
| `runs/diagnostics.jsonl` | `request-failed` \| error \| `20260815-152822-n5ob` |
| message | `500 GET /api/runs/:runId/report-file.pdf: could not render ...` |
| the run id | present, and **not** in the message — the pattern is |
| `npm run diagnostics` | `1×  error  request-failed  37s ago  ... 1 run(s)` |
| a hand-written run-less record | printed as `no run (server process)`, both views |

Three route tests cover the same ground with an array-backed sink (which is why
`DiagnosticsSink` is an interface): a failure with no run id records no run id, a
failure on a `:runId` route carries it, and a 401 from the gate plus a 400 from a
bad body record nothing at all.

Full suite: **1908 passed, 4 skipped, 71 files.**

### The traceability report was citing itself

The audit could not run this round: the Claude Code CLI's OAuth token has
expired, and `manager-plan` failed at the first provider call with a 401. The
run's own error message named the remedy and the reason it cannot be detected in
advance — the auth preflight work from earlier this session doing exactly what it
was built to do, on the first occasion that mattered. There is no `.env` and no
API-key provider configured, so there was no second route to a live model. What
follows is the recorded-defect work, done in parallel by five workers with an
integration pass over the top.

**The finding that mattered came from integration, not from any worker.**
`traceability.ts` scans every `*.test.ts` under each package's `src` — including
its own. Requirement ids appear in `traceability.test.ts` as fixture data: a
fictional PLAN.md, a canary asserting an annotation is still in place, a
regression guard naming what it guards. All of it counted as coverage. Five
requirements had no claim anywhere else:

| id | priority | claimed only by |
|---|---|---|
| FR-R1 | Must | the scanner's own test |
| FR-P1 | Must | the scanner's own test |
| FR-T1 | Must | the scanner's own test |
| NFR-10 | Should | the scanner's own test |
| FR-S12 | Should | the scanner's own test |

Three Musts had read as covered for this script's entire life because the tool
was citing itself. The zero-mention list — the one number this script exists to
produce — was wrong in the direction that flatters, which is the direction that
never gets questioned.

Excluded structurally (`isOwnTest`), not by convention. The test file had begun
spelling ids as `['FR', 'S8'].join('-')` to keep literals out of its own source,
and that works exactly as long as every future editor knows about it; the one who
does not gets no error, just a quietly inflated report. The rule that has to hold
is *self-reference is not evidence*, and it now holds whatever anyone types there.

**Annotations, so a deliberate decision stops reading as a hole.** A requirement
row in PLAN.md can now carry `*(not built: <reason>)*` or
`*(outside the test tree: <reason>)*`, and annotated requirements are reported
separately from genuine gaps. The reason is mandatory and a marker without one is
fatal — a mute button with no explanation is how a report becomes furniture. An
annotated requirement that DOES acquire a mention is flagged stale, because the
annotation has then outlived its truth. Four rows carry one: FR-S8 and FR-P7 are
not built (PLAN.md already said so in prose), FR-R6 lives in
`tools/subagent-catalog/` as a Claude Code skill no vitest suite can reach, and
FR-S12 is built in the one shape this harness cannot assert — hover and keyboard
focus both call the same `setIndicatedId` setter, so parity is enforced by shared
React state rather than by any function a test could compare two answers from.

**The rest were claimed by naming them in tests that already proved them**, and
where the existing coverage did not actually reach the requirement, a real test
was written rather than a label applied:

- FR-P5's route had no test at all — only `renderPdf`'s mechanics. It now has
  one that asserts 404 before a PDF exists and byte-for-byte equality of the
  served attachment after.
- FR-T2's env-var opt-in (`shellIsAllowed`) had no direct test; it now has one
  covering unset, empty, the documented truthy values, and a battery of
  near-misses that must all deny.
- NFR-4's third clause — "never sent to the frontend" — held only by omission.
  It is now asserted structurally: a walker over every outbound wire schema,
  checking no field name could carry a key.
- FR-T1's "dropped *with a reason*" was only incidentally covered for one tool;
  every always-excluded built-in's drop reason is now asserted.
- FR-U6 is a file-content test: pasting a Google-Fonts link into `styles.css` or
  `index.html` now fails the suite.

FR-S7 is claimed narrowly and the comment says so — the pause *decision* was
extracted as a pure function and tested; the `visibilitychange` wiring and the
60fps property remain outside what a DOM-less suite can assert.

### The verdict marker could be quoted into a re-dispatch

`parseReviewVerdict` accepted `[[REVIEW_VERDICT: REVISIONS_REQUESTED]]` anywhere
— mid-sentence, inside a fence — while `notes.ts` had been hardened against
exactly that after a live run. The exposure is worse here than there: the verdict
flows through `applyReviewVerdict` into `decideRevision`, and a granted revision
calls `executeAssignment(..., { revision: true })`. A quotation therefore buys a
paid re-dispatch and permanently burns the target's one allowed revision. The
brief (`REVIEW_VERDICT_INSTRUCTION`) had promised the marker must sit on its own
line since it was written; the parser simply never enforced it.

Now line-anchored with the same tolerances `notes.ts` allows, and fenced code no
longer counts. `review.test.ts`'s "parses the marker when it is wrapped in a
fenced code block" was inverted deliberately, with a comment saying so, so nobody
finding it in `git log` reads it as a mistake.

**Masked, not stripped — and that is the part worth recording.** The first
version derived the critique from the fence-*stripped* text, which silently drops
every code block the reviewer wrote before the critique reaches the re-dispatched
agent; for a code reviewer, "replace it with this" is frequently the most
actionable thing in the report. `maskFencedCode` replaces fenced content with
spaces instead, preserving length, so an offset into the scanned copy names the
same span in the original and the marker can be cut from the original by index.
The rejected middle option is the actively dangerous one: match on the stripped
text, then `.replace()` on the original, and a report that both quotes the marker
in a fence and declares it for real loses the *quotation* and keeps the real
marker in the critique. Both parsers share the one helper, so the fence rule
cannot drift between them.

### Corrected in the same pass

I reported the zero-report `done` path as a live defect, having "confirmed" that
nothing between `collectReports` and `setStatus('done')` checks for an empty
report set. The check exists, at the top of the same block, *before*
`collectReports` is called — I read forward from the wrong side of it. It had no
tests, which is what the pass actually delivered: a whole-team failure ends
`failed` with no report written and no synthesis call spent (asserted through the
scripted provider's request log), and a one-of-three-succeeds run still reaches
`done`. That last test is the one worth having: a partial deliverable is still a
deliverable, and the guard must never widen to "any failure at all".

Final state: **typecheck clean, 1958 passed / 4 skipped across 72 files**,
traceability at **0 unannotated zero-mention requirements of 56**, with 4
annotated and every reason written down.

### The eighth audit, and the finding it could not settle

Ran after re-authenticating, same task as the previous seven so the plan stays
comparable. **3 done, 0 failed, 0 skipped**; two parallel surveys
(`map-error-paths`, `runtime-failure-modes`) feeding one `rank-weakest-three`.
Rule 7's narrowed wording has now held for three consecutive runs. No
diagnostics records for the run at all.

It did not re-find anything fixed earlier that day — the diagnostics sink for
5xx, the warn-level logger and the single `setErrorHandler` convergence are all
named in the report as things that are *right*, by agents reading them cold.
That is the useful negative result.

**The best finding was the one the agents refused to guess at.** `code-reviewer`
reported that `withCreateRunHook` (`http/supervisor.ts:977`) returns a
hand-written object literal enumerating the twelve `RunStore` methods, so
`FileRunStore.assignmentWorkspaceDir` — which is not on the interface — is
dropped, `dispatcher.ts`'s duck-type check fails, and every assignment in a
supervisor-started run shares one workspace. `debugger` declined to re-derive it
and left it out of the ranked three rather than confirm or discard it. The
synthesis surfaced the disagreement, ranked it unranked-but-highest-value, and
handed the question up.

It is real. Verified by reading both files: AO-8 per-assignment isolation was
lost on every run started through `POST /api/runs` — the entire web UI — and
intact on the CLI path, which passes `FileRunStore` straight through. That is
why eight audits missed it: every one of them was a CLI run.

Fixed with a `Proxy` that forwards every property and binds `this` to the real
store. `Object.create(store)` was rejected after checking: `FileRunStore` uses
TypeScript `private`, not `#private`, so it would work *today* and break
silently the first time someone added a true private field.

**The three ranked findings, all fixed:**

- **The stray-throw backstop left assignments non-terminal**
  (`dispatcher.ts:420`). An error escaping `executeAssignment` became a
  transient WebSocket event; nothing durable was written, the tally counted the
  assignment in no bucket, and the run still reached `done` with an agent shown
  working forever. The file already documented fixing this exact shape for the
  cancellation path — the backstop reopened it for a different trigger. Now
  forced terminal through the existing `failAssignment`, guarded against a
  second throw. The guard's own degradation was then narrowed once more: the
  diagnostics sink writes to a *different file* from the `run.json` whose write
  just failed and swallows its own errors, so the persistently-broken-store case
  — the one that would otherwise leave no record anywhere — now records both
  halves, "threw" and "and could not be marked failed".
- **Absolute filesystem paths reaching clients**, on the PDF route and the
  WebSocket subscribe path. The sanitising helpers already existed; these two
  sites never used them. A third site turned up during the fix
  (`assignmentPdf`), and it is worth recording that this one had already been
  *observed and not seen*: the live check three commits earlier printed an
  absolute path with the Windows username into a response body while confirming
  something else in the same output.
- **`partial: true` with no reason** (`runEvents.ts`). Three failure modes
  collapsed to one boolean, two catches not even binding the error. Now carries
  a reason that distinguishes the modes, names no absolute path, and lists
  unreadable files in full while summarising invalid lines as a count plus one
  example — a single corrupt writer can produce thousands of those.

**Sanitising that loses the operator's copy is how people stop sanitising.**
Removing the cause from the third leak site's body would have moved it out of
the response and then dropped it entirely, because `recordRequestFailure`
records `error.stack` and a stack does not carry a cause's message. So
`HttpError` now takes an optional `cause`, and the diagnostics detail walks the
chain (depth-limited — it is user-supplied structure, on a request error path).
The client gets the fact; the operator gets the whole story, in
`runs/diagnostics.jsonl`.

**`replay-degraded`, a kind for a successful response that is not the whole
truth.** `GET /api/runs/:id/events` answers 200 with `partial: true`, so the
`status >= 500` gate on `request-failed` can never fire for it. The reason is
recorded under its own kind rather than widened into the wire contract: the UI
does not render it, and a shared schema that accumulates fields nobody displays
is how a contract rots.

**`pdfError` was written and never read**, anywhere in the repository — while
its own comment promised it was "recorded on the run so the UI can say why". The
missing half is now there: carried onto `RunState`, persisted, and rendered, so
a machine without Chromium stops showing "No PDF yet — run is done" forever. The
decision behind that line is a pure exported function, because this package's
suite has no DOM and the decision is the testable part.

Final state: **typecheck clean, 1977 passed / 4 skipped across 73 files**,
traceability at **0 unannotated zero-mention requirements of 56**.

**Left undone, deliberately:** the cause-chain adoption across the package. 173
`throw new Error` sites, 15 attach a cause, and all 15 are in `store/`,
`registry/` or `scripts/` — `http/`, `orchestrator/`, `providers/` and
`reports/` attach it at zero. The audit's own recommendation is to start at the
boundaries that terminate the chain rather than sweep, and `run.error`
(`runner.ts`) is still a bare string. Recorded as the next piece of work, not
attempted here.

### The cause chain, at the boundaries only

The audit's systemic finding, done to its own recommendation rather than swept:
173 `throw new …Error(` sites in the server package, 15 attaching `{ cause }`,
all 15 in `store/`, `registry/` or `scripts/`. The fix is not to touch the other
158. It is to stop the chain dying where it terminates.

**The one-line summaries are deliberately unchanged.** The obvious move — make
`describe` return the whole chain — is wrong in the direction that matters:
those strings are user-facing. `run.error` is rendered in the UI, HTTP bodies
are read by clients, and a CLI line ending in three nested `Caused by:` clauses
is worse than one that names the problem. So the split is by DESTINATION, not by
call site: the summary keeps going where a person reads one line, and
`errors.ts`'s `errorDetail` produces the long form for the two places built to
hold it — `runs/diagnostics.jsonl`'s `detail`, untruncated to 8,000 characters
for exactly this reason.

`errorDetail` walks at most four links. A cause chain is user-supplied structure
by the time it arrives — an adapter can hand back a cycle, or a hundred links
from a retry loop that wrapped its own error each time — and this runs on a
failure path, often inside a request. Four is deeper than anything this codebase
builds and shallow enough to be free. Tested against an actual cycle.

**Three boundaries, each one a place the chain stopped:**

- `registry/index.ts` threw `Cannot read agent categories at …` with no cause,
  eleven lines above an `AgentParseError` that has always attached one. One
  function, two policies, no way to tell which was a decision — and this is the
  throw that fires when the catalog root is missing, the first failure a fresh
  checkout ever sees.
- The sanitising `HttpError` throws (`readViaStore`, `loadRun`). These tell the
  client less on purpose, and until now that meant *destroying* the only copy:
  the 404 body is deliberately vague, and the store's real error — naming the
  errno and the absolute path — was discarded by the bare `catch {}`. That is
  the trade that makes the next person to debug a 404 reach for un-sanitising
  the body. The client's answer is unchanged; the operator now gets the rest.
- `runner.ts`'s run-level record, where `run.error` is the only failure record
  surviving into `run.json`. The message stays one line and identical; the stack
  and chain go to `detail`.

**Two things fell out of doing it.**

The run-level diagnostic was filed under `assignment-failed` — while the comment
directly above it said these failures are defined by having *no assignment to
attach them to*. True in prose, false in the data, and an operator grouping the
log by kind could not separate a planning turn that died from an agent that did.
Now `run-failed`. The test in `clarify.test.ts` that pinned the old kind was
updated rather than deleted, with the reason recorded in place.

And the whole-team-failure guard — the one added earlier this session, which
`return`s before the catch — wrote no run-level diagnostic at all. One of the
two ways a run can end `failed` was invisible to a `run-failed` filter. Found by
a test failing for the right reason: it asserted the record existed, and it did
not. It carries no `detail`, honestly, because there is no thrown error there to
take a stack from and the per-assignment records already carry theirs.

Verified live, not asserted: a scripted run on a real server, a per-agent PDF
render blocked by a directory in the output path.

| where | what it now says |
|---|---|
| response body | `could not render "reports/01-research-analyst.md" as PDF` — 70 bytes, no path |
| `diagnostics.jsonl` message | the same summary, one line |
| `diagnostics.jsonl` detail | `HttpError: …` + `Caused by: PdfRenderError: Expected a PDF file at "C:\Users\…"` |

The client gets the fact. The operator gets the filesystem path, the errno and
both stacks. Before this change the same request put the path in the body and
kept nothing.

Suite: **1989 passed / 4 skipped across 74 files**, typecheck clean.

### Telling agents what the task is about

A UAT run of an Investing Dashboard produced five assignments, and two of them
declined with "the application does not exist in this repository". The
application exists. It is at `C:\Users\<user>\repos\Investing dashboard`, one
directory above this checkout, and three of the five specialists found it by
walking up the tree — the quant-analyst audited real files and even left a note
for the manager saying assignment 02's conclusion was wrong and should be re-run.

Same task text, same brief, opposite answers. Whether an agent found the subject
came down to whether it thought to go looking.

**The cause was a gap the brief itself documented.** `brief.ts` already carried a
paragraph explaining that an agent's working directory is empty scratch space
inside this application's own checkout, that `git ls-tree -r HEAD` there returns
nothing and reads like an empty repository, and — the line that matters —

> The orchestrator does NOT know where the subject of the task lives — that is
> in the task text, if it is anywhere

That was true, and it is what this closes. Four agent-authored notes in
`runs/diagnostics.jsonl` had asked for it in almost those words ("Seeding the
attempt workspace with the target repo — or naming its path in the brief — would
have saved four tool calls per specialist"; "One specialist on this task hit that
and filed a BLOCKER instead of a report, producing nothing usable"). The channel
built for agents to report what would make the system work better reported this
three times before it was acted on.

**`subjectPath`: a path, not a copy.** The agents proposed two fixes and this
takes the cheaper one. Seeding each attempt workspace with the target costs disk
and time proportional to the subject, per assignment per attempt, diverges from
the original the moment anything writes, and answers "where is it" with a
duplicate. Naming the path costs a paragraph. NFR-1 is unaffected either way:
this is a place to READ, and every write still lands in the assignment's own
workspace — the brief says so in as many words.

It reaches three places, because any one of them missing would look exactly like
the defect:

- the **planner's prompt**, fenced like the task (a path is user-supplied, and
  one carrying a forged section header is the same attack), so objectives point
  at the subject rather than at this checkout;
- **every assignment brief**, stated BEFORE the working-directory section — the
  ordering is the fix, since the failure is an agent reasoning from where it is
  standing before anything tells it where to look;
- **`run.json`**, so a run that failed during planning still records what it was
  pointed at.

The brief's go-and-search advice is now conditional. Telling an agent to "search
from the repository root" when the subject is a sibling directory is precisely
how two specialists concluded a dashboard did not exist, so with a path in hand
the brief says the subject "is NOT this directory and may not be inside this
checkout at all" instead. Both versions keep the instruction that turns a wrong
answer into a reported gap: if you cannot find it, say so rather than concluding
it does not exist.

**`--subject` is checked before anything is spent.** A mistyped path is otherwise
the most expensive typo in this system — the planning turn goes out, every
specialist is dispatched and billed, and each independently reports it could not
find the thing, which is the original failure arriving by a different route. The
CLI stats it and refuses. The HTTP path deliberately does NOT: a `statSync` on a
request-supplied path is a filesystem probe, and the server is the wrong place to
offer one.

| check | result |
|---|---|
| `--subject C:/does/not/exist` | refused before the run starts, with the resolved path |
| scripted run with the real dashboard path | `run.json` → `subjectPath: C:\Users\<user>\repos\Investing dashboard` |
| planner prompt, brief, and run state | covered end to end against real code, not a brief fixture |
| no subject given | prompt and brief unchanged; every existing caller unaffected |

Suite: **1998 passed / 4 skipped across 74 files**, typecheck clean.

**Not done:** the two declined assignments have not been re-run. That costs a
live run and is the user's call; the tooling to make it succeed is what this
change is.

### A floor under the model an agent runs on

Default range for assignment work is now **sonnet through opus, inclusive**.
`haiku` is not accepted: an agent whose catalog file declares it runs on
`sonnet` instead.

**Applied as a deployment policy, not as a catalog edit.** The vendored catalog
declares `model:` per agent — 105 `sonnet`, 25 `inherit`, 18 `haiku`, 8 silent —
and those words are the *author's* opinion about how hard each job is, written
against a different cost tolerance and a model line-up that has moved on.
Editing 18 vendored files would be reverted by the next catalog refresh, silently,
and nobody would notice until a report came back thin. A clamp at dispatch
survives a refresh, is stated in one place, and leaves each agent's own
declaration intact for a reader to see what its author intended.

**One choke point.** `dispatcher.ts` is the only place an agent's `model:`
becomes a provider request, so the clamp lives there rather than in each of the
three adapters — three adapters enforcing the same floor separately is three
chances for one to drift. The dispatcher still does not *interpret* the word:
ranking three tier words cheapest-first is a much smaller claim than knowing
what any of them resolves to, which remains each adapter's job.

**What it deliberately leaves alone**, all four for the same reason — the policy
should clamp what it can see and not overreach:

- `inherit` (25 agents) means "use this deployment's default", an explicit
  deference to the operator, and this policy is the operator's own instrument.
  The honest limit is worth stating: if a deployment's default is cheap, those
  25 run cheap and nothing here can tell.
- An unrecognised word passes through. A tier this code cannot rank is one it
  must not rewrite — an author naming a future model would otherwise be
  downgraded by a rule written before it existed.
- An absent `model:` (8 agents) stays absent rather than being pinned to a tier
  no author chose.
- The Manager's own planning and synthesis turns, which never read a catalog
  `model:` at all, and `npm run agent`, where a person names a model on purpose.

**Overrides are recorded, not just applied.** An agent running on a model its
own file does not name is exactly what becomes inexplicable months later, so
each clamp writes a `provider-warning` to `runs/diagnostics.jsonl` naming the
agent and both tiers — the kind whose own definition already says "a model
override" is what it is for — and emits a non-fatal event so it is visible live.
The 130 agents the policy does not touch log nothing, because a line per
assignment would bury the 18 that matter.

`AGENT_OFFICE_MIN_MODEL` / `AGENT_OFFICE_MAX_MODEL` widen or narrow the range.
A typo throws at startup rather than falling back to the default: a floor nobody
can rely on is worse than no floor, and silent fallback would make every later
"why did this run on haiku" unanswerable.

Verified against the real 156-agent catalog, not a fixture:

| declared | dispatched | count |
|---|---|---|
| `haiku` | **`sonnet`** | 18 |
| `sonnet` | `sonnet` | 105 |
| `inherit` | `inherit` | 25 |
| absent | absent | 8 |

`any haiku still dispatched: false` — and with `AGENT_OFFICE_MIN_MODEL=haiku`,
`true` again, so the escape hatch is real rather than decorative.
`AGENT_OFFICE_MIN_MODEL=sonet` fails at startup.

One connection worth noting: `accessibility-tester` is one of the 18. The
assignment that declined in the UAT run was both pointed at the wrong place and
running on the cheapest tier available.

Suite: **2015 passed / 4 skipped across 75 files**, typecheck clean.

### The denial notice named a control nobody could reach

Seen live, mid-run, on a `uat-charter` assignment: the shell drop reason told
its reader to

> Pass { allowShell: true } to resolveClaudeCodeTools for a run that genuinely
> needs one

`resolveClaudeCodeTools` is an internal function. This string has exactly two
audiences and it served neither: it is written into the AGENT's transcript,
where it is the agent's only explanation for a capability it just lost, and it
is printed to the OPERATOR's terminal through the `dropped` channel every
withheld tool uses. Neither can call that function. FR-T2 makes the opt-in
deployment-level *on purpose* — a per-request grant would let anything reaching
the loopback port hand itself a shell as this account — so the environment
variable is the only control either audience has, and the message never named it.

It now names `AGENT_OFFICE_ALLOW_SHELL=1`, says to restart the run, and says why
the switch is not a per-run flag, because an operator told only "set this
variable" will reasonably ask.

The test that covered this asserted `detail` contained `'allowShell'` — which
the old text satisfied while being useless, and which the new text also satisfies
as a substring of the variable name. Both facts are why the assertion was
rewritten to pin the variable and the "deployment-level" explanation rather than
a fragment that cannot tell the two apart. The reason for the change is recorded
at the assertion, so nobody reads it in `git log` as a typo fix.

Worth noting what this is NOT: the denial itself is correct and unchanged, and
AO-1's deny-by-default stands. The defect was in a sentence, and a sentence is
the entire interface between a policy and the person who has to work with it.

Suite: **2015 passed / 4 skipped across 75 files**, typecheck clean.

### UAT cycle 1: thirteen users, and two P1s they found by existing

Ten-plus specialists were asked for and the planner fielded **thirteen** —
dx-optimizer, cli-developer, ui-ux-tester, accessibility-tester, error-detective,
sre-engineer, technical-writer, security-auditor, performance-engineer,
documentation-engineer, data-analyst, chaos-engineer, qa-expert — across twelve
distinct aspects. Rule 5's "two to six is typical" was not relaxed to get there;
the task named twelve genuinely non-overlapping aspects, which is what rule 6
already asks for.

The run itself failed (session limit, mid-synthesis) with 8 of 13 reports
written. Both of the worst findings came from watching the run rather than from
any report.

**P1 — a report was written, captured as narration, and recorded `done`.**
`sre-engineer` measured a live deployment and wrote 15,211 bytes of findings —
ten of them, F1–F10 — to `report.md` in its working directory. Its declared
deliverable was `reports/06-sre-engineer.md`. Nothing looked at `report.md`, so
capture fell back to the reply text: 601 bytes ending "Report complete at
reports/06-sre-engineer.md". The assignment was `done`. The findings never
reached the deliverable, the synthesis or the PDF.

`readWrittenDeliverable` already resolves the declared path against the
workspace, which is why `dx-optimizer` — who wrote exactly that path — was
captured intact (10,731 bytes on disk, 10,730 captured). The gap is only for an
agent that picks its own filename, and the cost of that gap is total.

Fixed at both ends. `recoverWrittenReport` looks for a stray markdown report in
the assignment's workspace when the declared path yields nothing, preferring a
name-match, then `report.md` at the root, then the largest file — and never
silently: the recovery writes a `provider-warning` naming the file it used, so a
wrong guess is discoverable and a right one exposes the filing habit. The brief
now says the reply IS the report, and that a reply which only announces a file is
a lost report. Recovery is a net, not a plan; the instruction had to be
unmistakable first.

**P1 — a second server marked a live run's assignments failed.**
The follow-up run died two minutes in with "the server process restarted while
this run was in progress; it cannot be resumed and was marked failed" — about a
server nobody had restarted. A UAT agent, doing exactly what it was asked,
started its own server against the same `runs/` root (`accessibility-tester`
reported using port 5299 because 5179 was taken). `reconcileCrashedRuns` runs at
every startup and swept four live assignments belonging to a different process.

The agent that caused it saw the shared-store mechanism and called it "expected,
not a defect". It had just killed the run it was working inside.

`RunState.ownerPid` records who is executing, and reconciliation now skips a run
whose owner answers `process.kill(pid, 0)`. Every uncertain case resolves to
"leave it alone": an unknown pid (every run written before the field) reconciles
as before, `EPERM` counts as alive, and pid reuse strands an abandoned run rather
than killing a live one. The asymmetry is the point — untidy beats destroying
paid work mid-flight.

**Also observed, unfixed and recorded:** several specialists reported having no
shell despite `AGENT_OFFICE_ALLOW_SHELL=1`, because a grant is still bounded by
each agent's own catalog `tools:` — technical-writer, security-auditor and
documentation-engineer never requested one, so the task's promise of a shell was
false for them specifically. The model floor fired correctly in the same run
("haiku is below this deployment's floor; running on sonnet instead" for
data-analyst), and `--subject` pointed all thirteen at the right tree.

Suite: **2020 passed / 4 skipped across 76 files**, typecheck clean. The lost
sre-engineer report has been restored into the run directory by hand, so its ten
findings are available to cycle 2 rather than being lost to the incident that
found the bug.

### The streak ended, and I committed the evidence

Four separate entries above record that a granted shell "wrote nothing outside
its workspace", each verified with a clean `git status`. The UAT run broke it.

A specialist ran `npm run serve -- --step-delay 800` from the repository root
and redirected the output to `uat_serve.log` there — 1,619 bytes of server log
sitting in the checkout. Then I committed it, in `eacd16a`, because the commit
was staged with `git add -A` and I read the `git status` output for files I
recognised rather than for files I did not.

Both halves are worth recording. The containment claim was always narrower than
it sounded: `AGENT_OFFICE_ALLOW_SHELL` grants a real shell, and a shell's own
first command can `cd` anywhere — the tools.ts denial notice says exactly that,
and four clean runs in a row had quietly turned "nothing stopped them" into
"they cannot". They can. The workspace is where an agent is *put*, not a fence.

`git add -A` at the end of a run whose agents had a shell is the other half, and
that one is mine.

The file is removed from tracking. **No `*.log` ignore rule was added**, and that
is deliberate: an ignore rule would make the next one invisible, and the whole
value of `git status` here is that debris shows up as debris. The same reasoning
the bare `reports/` rule earned when it turned out to be excluding a source
directory — a gitignore that hides evidence is worse than the mess it hides.

### Working the UAT findings: eight shards, 56 findings, one of them mine

Cycle 1's eight surviving reports were triaged by three read-only recon passes
before any fix worker was spawned, and that ordering earned its keep. Each
finding was re-verified against current source and marked VERIFIED, STALE or
UNCHECKED: **55 of 56 verified**, none stale, and one report's own citation
corrected (the designer's fallback log lines live in `reports/designer.ts`, not
`serve.ts`). Handing an already-fixed finding to a worker costs a worker.

**Two independent specialists found the same P1 from opposite directions.** An
accessibility tester tracing keyboard flow and a security auditor tracing auth
both arrived at `wsUrl()`: the WebSocket upgrade carries no token, so under
`npm run serve` — the documented way to run this — the socket 401s and the UI
never receives a single status update. It worked in development only because
the Vite proxy injects the header. The same defect was then found in the PDF
download anchor, for the same reason: a native `<a href download>` and a native
`WebSocket` are the two callers in this app that physically cannot set a header.
Both now append `?token=` through one shared helper.

**One P1 was mine, and the floor made it.** The model policy shipped hours
earlier raises 18 `haiku` agents to `sonnet` — and nothing persisted what
actually ran, so every cost site kept pricing them from the catalog word. The
recon pass got this exactly right: the finding is *strengthened* by the floor's
existence, not made stale by it. `AssignmentState.model` now records the
resolved tier, and both cost sites prefer it, with absence meaning "use the
catalog word" rather than "free".

The rest, by shard: a boolean CLI flag that swallowed the next word into a paid
task string; a `--port` that moved the server while the dev proxy kept talking
to 5179; a dev-token file shared by every instance on the machine, created
without a mode and never removed; `--json` output that no parser could read; a
CLI that exited 255 when piped into `head`; a typo'd `--drry-run` silently
ignored by the script that DELETES RUN DIRECTORIES; an env denylist that missed
`DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `*_DSN` and `*_PAT`; `AGENT_OFFICE_TOKEN=1`
accepted as a credential with no complaint; token-budget failures writing
nothing to the diagnostics log while claiming "partial reports preserved" over
an empty directory; and 401s invisible in every channel.

### What the workers declined to do, which is the part worth keeping

Three refused the easy wrong thing, and each was right:

- `--provider` was NOT added to `agent.ts`. Routing through `makeProvider`
  would have silently dropped `--replace-prompt`, since `systemPromptMode` is
  not in `MakeProviderOptions` — a silent corruption, introduced by a pass whose
  entire purpose was removing silent corruption.
- `--json` piping is **not fully fixed, and the worker said so plainly.** Any
  `npm run <script>` prints its own banner before it reads the script body, so
  no edit inside `package.json` can suppress the outer one. `--silent` works,
  `npx tsx` works, and the help text now says exactly that. The alternative — a
  repo-wide `.npmrc` with `loglevel=silent` — was left undone deliberately: it
  would silence npm's own error output for everyone, forever, to fix one pipe.
- The `.env`-provenance plumbing for the env denylist was skipped rather than
  bodged across four out-of-scope files, with the reasoning left in a comment
  where the next person will find it.

### The test that failed three times

`cuts an in-flight lane short once the token budget trips` raced a 5ms delay
against a 50ms one. On an idle machine that is comfortable; with eight worker
processes on the box it is not. It failed three times in one session and was
diagnosed from scratch each time — once as an unnamed failure nobody could
reproduce, once by a worker that stashed its own changes to prove the failure
predated them, and once in the integration run — while passing alone every time.

The margin is now 30x. That is the cheap fix, not the right one: the right one
is a gate the test opens explicitly, which needs a new capability in
`ScriptedProvider`, and that is recorded at the test rather than smuggled into a
flake fix.

**A manager lesson, recorded because it cost real time:** eight workers each
running `npm run typecheck` and the full suite on a 16GB machine produced OOM
kills and phantom failures. Two workers independently reported the machine at
~1.3GB free with 28 node processes. Every one of those failures had to be
investigated to know it was noise — and one of them turned out to be real.
Parallelism is not free at the verification step.

Final state: **typecheck clean, 2149 passed / 4 skipped across 80 files**,
traceability at 0 unannotated zero-mention requirements of 56, and the two P1s
verified by hand at the CLI.

### The rest of the planned work, and a lesson about shared trees

Five shards against the cycle-1 findings nobody had been assigned. All five
landed; the interesting part is what happened to the tree while they worked.

**Event provenance.** Logged events carried only `assignmentId`, so answering
"which agent, in which phase" meant hand-joining `run.json`. They now carry
`agentName` and `phaseId`, optional so every line written before today still
replays (NFR-7). Manager turns deliberately carry NEITHER: a synthetic
`agentName: 'manager'` would look like a real agent to every consumer while
resolving to nothing in `registry.byName` — a wrong answer with the same
confidence as a right one. `report.md` also gained a small header, because it
was the one artifact that could not identify itself once it left the run
directory.

**A table of contents that existed and was called by nothing.**
`extractHeadingOutline` was written, tested, and never wired. Reports now carry
one, with per-section id namespacing so two agents' `## Findings` become
`appendix-1-findings` and `appendix-2-findings` — collision-free by
construction, keyed on position rather than agent name, which can repeat.

**The subject root, finished.** `apiTools.ts` and `mcpTools.ts` gained an
optional read-only second root, and writes are impossible *structurally* rather
than by check: the write handlers never receive the subject directory as a
nameable value, and the MCP surface defines no subject-write tool at all.

That worker stopped at its scope fence and reported precisely what was missing,
which was the whole join: `AgentRunRequest.subjectPath`, the dispatcher setting
it, and both API adapters passing it on. Wiring that is manager work and it went
wrong in an instructive way — the first edit anchored on the wrong call site and
added `subjectPath` to the BRIEF a second time, where it already was. It
typechecked. The brief still worked. The capability would have shipped inert,
and the only reason it did not is the test written specifically to prove the
cross-shard join, which failed within a minute of being written. Two shards
building two halves is exactly where a test for the seam pays for itself.

**401 recovery**, the item a previous worker correctly refused to bolt onto an
unrelated shard, now has its own panel; `authToken` became a live binding so the
socket picks up a new token on its next connect with no change to `socket.ts`.

**Developer-facing output**: `tool` events reach the console, throttled per
assignment with a `(+N more)` suffix so a burst is batched rather than lost;
the designer's fallback reads as the normal outcome it is; and the Vite dev
proxy now says out loud that its own port has no Host, Origin or token check.

### Two workers reached for `git stash` on a shared working tree

One used it to isolate a typecheck failure. The `pop` hit a merge conflict
against `apiTools.ts` — which a second worker was editing at that moment — and
the failed pop **wiped every uncommitted file in the tree**, across five
workers. Both recovered their own files and left everyone else's, correctly,
and both reported it.

Two shards' completed work was still missing when I checked: the event
provenance and the developer-facing output, both of which had already reported
success with passing tests. Their changes were sitting in `stash@{0}` while the
tree looked clean. A commit at that moment would have been green, silent, and
short five files.

Recovered by restoring exactly the files whose markers were absent, and
deliberately NOT the ones belonging to workers still running — overwriting live
work with a stale snapshot to fix a different problem is how a recovery becomes
the second incident. The stash is kept rather than dropped.

**This is a manager error, not a worker one.** `git stash` is a reasonable
instinct for an agent wanting a clean baseline, and one worker used it correctly
earlier in the same session to prove a failure predated its changes. The problem
is that file-disjoint shards are only disjoint for FILE operations: git commands
are global, and `stash` respects no scope fence. `isolation: "worktree"` exists
for this. Eight-plus workers on one checkout bought wall-clock and paid for it
in two wipes, three independent corruption reports, and an OOM storm that made
several test results untrustworthy.

Final state: **typecheck clean, 2207 passed / 4 skipped across 81 files.**

## The supervisor constructor was three keys short

A live run emitted this warning, and it was pasted back at me as a question:

> tool "Bash" was not granted: "Bash" resolves to the built-in "PowerShell" …
> To grant it, set AGENT_OFFICE_ALLOW_SHELL=1 in the environment the server or
> CLI runs in, and start the run again (FR-T2 …)

The warning is correct and needs no fix: FR-T2 makes the shell opt-in
deployment-level, the running server was started without the variable, and the
agent that hit it still wrote a 23KB report — the denial cost it nothing,
because the assignment was to read a repository and cite `file:line`, which
`Read`/`Grep`/`Glob` do.

Chasing where that warning was *recorded* is what found the defect.

### What was wrong

The warning was in the assignment's own event log and **absent from
`runs/diagnostics.jsonl`** — zero records for the whole run, and the file
untouched for three days. `RunSupervisor`'s constructor built `this.deps` as an
enumerated object literal:

```ts
this.deps = {
  registry: deps.registry,
  store: deps.store,
  makeProvider: /* … */,
  defaultProviderId: deps.defaultProviderId ?? 'scripted',
  onWarning: /* … */,
  now: deps.now ?? Date.now,
  maxConcurrentRuns: deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
  ...(deps.dispatchDefaults === undefined ? {} : { dispatchDefaults: deps.dispatchDefaults }),
};
```

`getRegistry`, `produceDeliverable` and `diagnostics` are declared on
`SupervisorDeps`, documented there, passed by `serve.ts`, and read later in the
same file. None of the three is in that literal. Every read of them saw
`undefined` for the life of the process.

### Why nothing caught it, and why that decided the fix

All three are optional, so omitting them is a legal value for the declared type
— `Pick<SupervisorDeps, …>` in the field type says "these may be absent", which
is exactly what dropping them produces. Every read site is defensively written
for the absent case (`?.`, `?? this.deps.registry`, a `=== undefined` guard), so
nothing threw. Three features silently did nothing.

`supervisor.test.ts` had no assertion mentioning `diagnostics` at all. A test
that constructs a supervisor and checks the run still works passes either way;
the only assertion that can fail is one watching for the dep's observable
effect. That is what the three new tests do, and each was confirmed to fail with
the fix reverted before being kept.

What it cost, in order of severity:

- **`diagnostics`** — `runs/diagnostics.jsonl` received nothing from any run
  started through `POST /api/runs`, which is every run the web UI starts. The
  CLI (`scripts/run.ts`) reaches `executeRun` directly and never passes through
  the supervisor, so the log looked healthy in exactly the runs an author does
  by hand. The observability work committed earlier in this session was real on
  the path it was tested on and inert on the path users take.
- **`getRegistry`** — FR-R5 hot reload was inert for runs. `buildServer` gets
  its own copy and kept serving a fresh catalog over `/api/agents`, so the UI
  would list a newly-edited agent while a run dispatched against the startup
  snapshot: two halves of one process disagreeing, with the visible half right.
- **`produceDeliverable`** — no production impact (`runner.ts` falls back to the
  real implementation, and `serve.ts` passes no override), but every supervisor
  test injecting `stubDeliverable()` was running the real renderer instead.

### The fix is structural, because this is the second instance

`withCreateRunHook` in this same file was an enumerated literal that dropped
`assignmentWorkspaceDir`, which left AO-8's per-assignment workspace isolation
absent on the server path through eight audits. That was fixed with a `Proxy`
— and the same bug was sitting one layer up, in the constructor, because the
fix was applied to the instance rather than to the pattern.

So `this.deps` now spreads `deps` first and overrides only what needs a default,
with `stepDelayMs` destructured out (it genuinely is consumed here). A key added
to `SupervisorDeps` tomorrow arrives without anyone remembering to copy it. The
`dispatchDefaults` line was deleted rather than kept: leaving a hand-written
line for one of four optionals is how the other three came to look considered.

The pattern worth naming: **an enumerated copy of an options object with
optional keys cannot fail loudly.** Both instances were found by noticing a
feature doing nothing, never by a type error or a test.

Verified: typecheck clean, **2210 passed / 4 skipped across 81 files**, and the
three new tests confirmed failing against the reverted constructor.

## The startup banner now says whether the shell is granted

Handing the dev server over to the preview launcher meant it would be started by
something other than the shell that had `AGENT_OFFICE_ALLOW_SHELL=1` exported —
and there was no way to check whether the grant had survived. `shellIsAllowed()`
reads this process's environment and can only change on restart, so it is a fact
about the deployment exactly like `provider` and `token`, and it was the only one
of the three the banner did not state.

The gap was not cosmetic. The grant was invisible until an agent asked for a tool
and was refused — minutes into a billed run, in that assignment's own event log.
Any launcher that drops the variable (a wrapper script, an IDE run configuration,
a process manager) leaves a server that looks correctly configured and silently
is not. That is the same shape as the supervisor dropping `diagnostics` found
earlier today: a capability inferred from its own absence, discovered late and
expensively.

```
  provider: claude-code
  shell:    GRANTED via AGENT_OFFICE_ALLOW_SHELL — agents on this server may run commands
  token:    generated for this process only
```

The denied line names the variable and says a restart is required, matching the
"say what happened, then what to do" shape the denial message in
`providers/claude-code/tools.ts` already uses.

The launcher carries the grant through `node --env-file=.claude/serve.env` rather
than an exported variable, so it belongs to the configuration rather than to
whichever shell happened to start the server. Both files sit under `.claude/`,
which is gitignored — machine-specific, and the ignore rule's own comment already
warns that a file needing to be shared must be un-ignored explicitly rather than
assumed committed.

Verified by reading the banner out of the launcher's own log after the handover,
rather than assuming the variable was inherited. Typecheck clean, 2210 passed /
4 skipped across 81 files.
