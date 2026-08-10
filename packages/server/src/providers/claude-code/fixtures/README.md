# stream-json fixtures

Captured from **Claude Code 2.1.222** on Windows, against
`claude -p "<task>" --output-format stream-json --verbose --no-session-persistence`.

Provenance matters more than convenience here, so the filenames say which is
which. PLAN.md §3 requires the parser to be built against real output rather
than assumed shapes; a fixture that quietly invents a shape defeats that.

| File | Provenance |
|---|---|
| `auth-failure.jsonl` | **Real capture, verbatim.** An unauthenticated invocation. Contains genuine `system/init`, `assistant` and `result` frames. |
| `synthetic-success.jsonl` | **Derived, not captured.** Envelope fields copied from the real capture above; `text` / `tool_use` / `tool_result` blocks reproduce shapes confirmed from Claude Code session transcripts on this machine. |
| `malformed.jsonl` | **Hand-written.** Truncation and garbage cases the parser must survive. |

## Why one of these is not a real capture

Capturing a successful tool-using session needs an authenticated CLI, and
`claude auth status` reports `loggedIn: false` on this machine. Authenticating
is the user's action to take, not something this project can do for them.

The consequence is recorded rather than papered over: the frames unique to a
*successful* run — `assistant` turns carrying `tool_use` blocks, `user` frames
carrying `tool_result`, and a `result` frame with a non-zero `total_cost_usd` —
have not been observed on this wire format. They are reconstructed from the
Anthropic content-block shapes, which are stable and independently confirmed,
wrapped in the envelope fields the real capture proves.

The risk this leaves is narrow and specific: if 2.1.222 wraps successful frames
differently from failing ones, the parser is tested against the wrong envelope.
That is checked the moment someone runs `npm run agent` on an authenticated CLI
— the exit-criterion script prints unrecognised frames rather than dropping
them, so a mismatch shows up immediately instead of silently.

## Refreshing a capture

```bash
claude -p "list the files here" --output-format stream-json --verbose --no-session-persistence > capture.jsonl
```

`--verbose` is not optional. Without it the CLI exits 1 with a usage error and
emits no JSON at all.
