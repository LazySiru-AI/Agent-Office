# stream-json fixtures

Captured from **Claude Code 2.1.222** on Windows, against
`claude -p "<task>" --output-format stream-json --verbose --no-session-persistence`.

Provenance matters more than convenience here, so the filenames say which is
which. PLAN.md §3 requires the parser to be built against real output rather
than assumed shapes; a fixture that quietly invents a shape defeats that.

| File | Provenance |
|---|---|
| `auth-failure.jsonl` | **Real capture, verbatim.** An unauthenticated invocation. Contains genuine `system/init`, `assistant` and `result` frames. |
| `real-success.jsonl` | **Real capture, redacted.** An authenticated three-turn run that read a file and answered. See "What was redacted" below. |
| `synthetic-success.jsonl` | **Derived, not captured.** Retained only for the block types `real-success.jsonl` does not happen to contain — a `Write` tool call and the `artifact` event it produces. |
| `malformed.jsonl` | **Hand-written.** Truncation and garbage cases the parser must survive. |

## What the real capture changed

Until the CLI was signed in, the success path was reconstructed rather than
observed, and the previous version of this file said so and named the risk:
"if 2.1.222 wraps successful frames differently from failing ones, the parser is
tested against the wrong envelope."

It did, and it was. The first authenticated run produced four things the
unauthenticated capture never showed:

- **`rate_limit_event`** — a top-level frame type, emitted right after
  `system/init`. Previously unrecognised, and reported as such by the
  exit-criterion script the moment it ran.
- **`system/thinking_tokens`** — emitted continuously through a turn; 24 of the
  38 frames in this capture are these.
- **`system/post_turn_summary`** — one, immediately before the result frame.
- **`assistant` frames carrying `thinking` blocks**, one per turn.

The costly one was none of those. **The CLI emits one `assistant` frame per
content block, and repeats the whole message's `usage` on each of them.** A turn
with a `thinking` block and a `tool_use` block yields two frames reporting
identical usage. Summing them — which both `dispatcher.ts` and `runner.ts` do —
double-counted input, while `output_tokens` on those frames turned out not to be
the turn's output at all:

| | summed from assistant frames | `result` frame |
|---|---|---|
| input | 135,270 | 67,635 |
| output | 10 | 579 |

So the adapter now takes its usage from the `result` frame only, and
`eventsForAssistant` emits none. `parse.test.ts` asserts both numbers above
against this fixture, so a future CLI that changes the shape fails loudly rather
than quietly mis-billing.

## What was redacted

Identifiers and machine specifics only — every structural shape is as captured,
because the shapes are the entire point of the file.

- `session_id` and every `uuid` replaced with fixed placeholders
- `cwd` and absolute paths rewritten to a neutral workspace path
- `tools` filtered to the granted built-ins; the real list enumerated every
  connected MCP tool on the capturing machine
- `mcp_servers`, `memory_paths`, `skills`, `plugins`, `agents` and
  `slash_commands` emptied

Token counts, costs, timings, content blocks and frame ordering are untouched.

## Refreshing a capture

```bash
claude -p "list the files here" --output-format stream-json --verbose --no-session-persistence > capture.jsonl
```

`--verbose` is not optional. Without it the CLI exits 1 with a usage error and
emits no JSON at all.

Redact before committing. On Windows note that PowerShell 5.1's
`Out-File -Encoding utf8` writes a BOM, which `JSON.parse` rejects on the first
line.
