# Assets

PLAN.md §2.3 requires that licence terms be checked and recorded here **before
any asset lands**. This file exists to satisfy that, and to record a deliberate
departure from what the plan assumed.

## There are no third-party assets

The office sprites are **generated procedurally at run time** from each agent's
name. Nothing is downloaded, nothing is vendored, and there is no art file in
this repository.

| Asset | Source | Licence |
|---|---|---|
| Character sprites | Generated at run time (`packages/web/src/sim/sprites.ts`) | None required — produced by this repository's own code |
| Desks, paper, bubbles | Generated at run time (same module) | None required |
| Floor and walls | Drawn from tile primitives (`packages/web/src/sim/scene.ts`) | None required |
| Fonts | System font stack only; no webfont is loaded | None required |

## Why this departs from the plan

PLAN.md proposed a CC0/permissive pack in the Kenney style, behind the FR-S9
manifest abstraction. Generating instead was chosen for three reasons, in order
of weight:

**1. A licence that does not exist cannot be got wrong.** The plan's own risk
table lists "sprite asset licensing — legal exposure if distributed" as a risk.
Vendoring art means someone must verify the terms, record them, and keep that
record true as the pack is updated. Generating removes the risk rather than
managing it.

**2. FR-S2 wants determinism from the agent's name.** With a fixed pack, the
best available is `hash(name) → pick a sprite from a finite set`, which collides
as the catalog grows past the pack's variety. Generating parameterises the
character on the hash directly — skin, hair, hair style, shirt, trousers and
build are independent slices — so 154 agents can look meaningfully distinct
without needing 154 hand-drawn sprites.

**3. The project is offline by design.** NFR-3 and FR-P3 both push towards no
network at run time. An art pack is a build-time download and a bundle-size
cost; generation is neither.

## What this costs

Being honest about the trade: hand-drawn pixel art by a person who can draw will
look better than anything derived from a hash. The characters here are readable
and consistent, not beautiful. If the office should look genuinely nice, a real
art pack is the answer.

**That path is still open, and cheaply.** FR-S9 asks for a swappable sprite pack
behind a manifest, and that abstraction is real rather than notional:
`packages/web/src/sim/spriteContract.ts` defines a `SpriteManifest` — sprite
dimensions, a frame generator and a prop generator. The procedural implementation
is one implementation of it. Dropping in a CC0 pack means writing a second
implementation that loads images and returns the same pixel data, and changing
which manifest the scene is handed. No renderer code changes.

If that happens, this file must be updated first, with the pack's name, version,
source URL and licence text — which is what PLAN.md asked for in the first place.

## Note on the plan's dogfooding suggestion

PLAN.md suggests using this repo's own `license-engineer` agent to verify pack
terms as the first real dogfooding task. That remains a good idea and is now
untaken rather than done — there are no terms to verify. It is worth revisiting
if a real pack is ever adopted.
