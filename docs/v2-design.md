# v2 design record

Living record of how v2 is built and why. Update it with the code. The brief is
[`docs/v2-kickoff-prompt.md`](v2-kickoff-prompt.md). The section **Assumptions to review**
lists every decision made in place of asking.

## What v2 is

A design agent: it helps a person get from an existing room to a desired one, combining
their taste and intent with design judgment and products that can actually be bought.
Physical constraints (sizes, mount depth, window measurements) are out of scope for now;
the empty extension point is `src/v2/extensions/physical-constraints.js`.

v1 made one multimodal call with the whole catalog (84 products, 321 variants, ~397 images)
and the room photo, and got back a ranked list with self-reported scores. v2 splits that
into stages, each with a contract, and moves everything deterministic into code:

```
PERCEIVE (VLM) → BRIEF (code) → PLAN (LLM) → RETRIEVE (code) → COMPOSE (VLM)
   → RENDER (image) → FAITHFULNESS (code) → CRITIQUE (VLM) → PRESENT (code) → REACT (code)
```

| v1 problem | v2 answer |
|---|---|
| no intent or room type | PERCEIVE infers room type and needs; BRIEF records stated/inferred/assumed per field |
| no design reasoning | PLAN writes three explicit directions; COMPOSE must cite Brief fields for each claim |
| position bias from alphabetical catalog | no ranker sees the catalog; RETRIEVE scores in code, COMPOSE sees ≤ 16 swatches |
| near-duplicate results | directions must differ on ≥ 2 axes; ≤ 2 variants per product in a shortlist |
| uncalibrated self-reported scores | scores come from code (ΔE, overlaps) with every term exposed; the model gives verdicts, not numbers |
| explanations written after the choice | rationale claims are part of the proposal and must point at Brief fields |
| no iteration | critique loop (bounded), then REACT re-enters at PLAN or COMPOSE |
| cost grows with the catalog | model calls see a shortlist; cost is flat in catalog size |

## Layout

```
data/guidelines.json          room → needs, visual/functional categories; name map; unmapped names
data/category-roles.json      catalog category → visual | functional | both
src/v2/config.js              every tunable; per-stage provider/model; mode (mock/live/baseline)
src/v2/schemas/               JSON Schemas (Brief, Direction, Shortlist, Proposal, Render,
                              Faithfulness, Critique, Decision, Reaction, Presentation, Session,
                              StageRecord, Trace); stage I/O schemas live beside each stage
src/v2/stages/*.js            one module per stage, all the same shape
src/v2/stages/index.js        the registry; toolDefinitions() for a future agent
src/v2/runtime.js             validation, retry, repair/fallback, budget, cache, cost, tracing
src/v2/policies/              decision points as named, replaceable functions
src/v2/orchestrators/         workflow.js (now); agent.js later
src/v2/engine.js              wires config + catalog + providers + trace; used by CLI, API, tests
src/v2/providers.js           the only door to a model; mock vs live; refuses paid calls unless live
src/mock-provider.js          fixture store + mock render (shared plumbing, next to providers.js)
src/v2/routes.js              /api/v2/* and /v2 UI (mounted additively in src/server.js)
public/v2/                    UI, critique labelling view, v1-vs-v2 comparison view
test/                         offline checks (network blocked)
test/fixtures/v2/             hand-written model responses, including broken ones
traces/                       one JSON trace per session (+ traces/sessions/ for resumable sessions)
var/                          renders, caches, uploads (gitignored)
```

## Stage contract

Every stage module exports:

```js
export default {
  name, description,          // description is written to double as an LLM tool description
  inputSchema, outputSchema,  // JSON Schema; the runtime validates both on every call
  kind: "llm" | "code" | "image",
  async run(input, ctx),      // ctx = { config, catalog, providers, budget, attempt, warn, meta }
  // optional:
  check(output, input, ctx),  // semantic errors beyond the schema (IDs, categories, diversity)
  repair(output, input, errors, ctx) → { output, notes } | null
  fallback(input, ctx, errors)          // must be schema-valid; always warned
  baseline(input, ctx)                  // no-model version of an llm stage
  fixtureKey(input)                     // readable projection of the input for mock fixtures
  cacheKey(input)                       // live-mode response cache key
}
```

Stages never import each other's `run`, never read the session and hold no module-level
state (the catalog index and schema compiler are memoised read-only data). They may import
shared helpers (`layerCapacity` from retrieve is used by plan's feasibility check).

### Runtime (`src/v2/runtime.js`)

For each call: validate input → (live only) response cache → reserve a render if `kind: image`
→ run → validate output + `check` → on failure retry once (LLM stages) with a `retry`
warning → still failing: `repair` (warning `repaired`) → else `fallback` (warning
`fallback`) → else the stage fails and the orchestrator decides. Mock fixture misses,
refused live calls and an exhausted budget are fatal: they stop the run rather than being
papered over. Every call becomes a `stageRecord` in the trace with its attempts, provider,
model, the model it *would* have used (in mock mode), usage, estimated cost and latency.

### Modes

- `mock` (default): every model stage answers from `test/fixtures/v2`. The adapter refuses any
  real call; the test setup also blocks `fetch` to non-local hosts.
- `live`: only when the user sets `DESIGN_AGENT_LIVE=1`. Asking for live without it throws.
- `baseline`: every LLM stage runs its no-model `baseline()`. Same traces, same report, so
  "every LLM stage must beat its no-model baseline" is measured the same way as everything else.

## Data

### `data/guidelines.json`

Hand-transcribed from `docs/window-design-guidelines.txt`. Every guideline product name has
an entry in `nameMap` resolving to exact catalog category names. Names with no catalog
category are listed under `unmapped` with the rooms that cite them:

| Guideline name | Why unmapped |
|---|---|
| Stirpe Bamboo Curtain | not in the V2 catalog |
| Blackout Roman Shades | no blackout Roman shades; not substituted |
| Faux Wood Blinds | not in the catalog; Wood Blinds not substituted (faux is chosen for moisture) |
| Blackout Zebra Shades | merged into Zebra Shades by the 2026-09-11 clean-up; no zebra variant is blackout |
| Top-down Bottom-up Shades | an operating system, not a category; `operation` is null in the catalog |
| Cordless Systems | a safety feature, not a category; `childSafe` is null in the catalog |

Aliases from the brief: Blackout Curtain(s) → Blackout Drapery, Curtains → Drapery Panels,
Zebra / Dual Shades → Zebra Shades; plus singular forms (Sheer Curtain → Sheer Curtains).

### Single-layer rooms

Eleven rooms list only one layer (e.g. Nursery: "Functional Layer" only; Basement:
"Main Visual Layer" only). v2 treats the listed layer as the room's primary covering: it
becomes the visual layer (the one that is rendered) and the functional layer is `null`.
`roomLayers()` in `src/v2/guidelines.js` is the only place this rule lives.

### `data/category-roles.json`

Derived from guidelines.json: a category is `visual` if any room lists it in a visual layer,
`functional` if any room lists it in a functional layer, `both` if both. Drapery Panels,
Roman Shades and Vertical Blinds are visual-only; Outdoor & Patio Shades is functional-only;
the rest are both.

## Schemas and the Brief

Every Brief field is `{ value, source: stated | inferred | assumed, confidence, note? }`.
Precedence per field: stated > inferred (if confidence ≥ 0.35) > an explicit assumed default.
Assumed defaults come from the room's guideline `needsProfile` where one applies. A stated
room type raises (never lowers) inferred needs to the room's guideline level.

Free text is read by a small deterministic lexicon (`src/v2/lexicon.js`): room type words,
warmer/cooler, lighter/darker, need words (blackout, privacy, glare, baby, humid) and
"no X" colours. Whatever it does not understand stays in `preferences.text`, which PLAN and
COMPOSE read verbatim.

## PLAN

Exactly three directions. Code checks (not the model): categories allowed for the room and
layer; functional null when the room has no functional layer; each layer can supply at least
5 variants under the per-product cap (catches e.g. Cellular Shades alone = 4); every pair
differs on ≥ 2 of {visual category set, colour strategy, light level}. On failure: retry once,
then repair in code (drop disallowed categories, top up thin layers), then the deterministic
template planner, each with a warning.

Direction light levels are `bright | filtered | dark` (what the covering does), distinct
from the Brief's room light level `bright | medium | dim` (what the room gets).

## RETRIEVE

Code only. Per direction and layer: categories ∩ allowed → every variant with a swatch is
scored; variants without a swatch (9 of 321) are excluded and counted, never guessed.

`score = 0.55·colour + 0.2·style + 0.15·light + 0.1·preference`, each term in [0, 1] and
reported in `scoreParts`:

- **colour** by the direction's strategy, all in CIEDE2000 on the Brief palette (weights normalised):
  tonal = Σ w·exp(−ΔE/25) (v1's de2000-match); contrast = Σ w·gauss(ΔE; 35, 18) (v1's
  de2000-contrast); neutral-anchor = exp(−C*/10)·(0.4 + 0.6·exp(−|ΔL to dominant|/30));
  complementary = hue within ~40° of the opposite of the room's overall hue (circular mean of
  palette hues weighted by share × chroma), with some chroma. An earlier version anchored on
  the single most chromatic accent; in the blue-grey room that was the warm lamp, so
  "complementary" picked blue. The weighted mean fixes that.
- **style**: token overlap of Brief style tags + materials with the variant's styleTags.
- **light**: opacity fit to the direction's light level (visual layer) or to the needs
  (functional layer: blackout high → dark; glare/privacy high → filtered).
- **preference**: warmth, lighter/darker, avoided colour families (avoid → 0).

Then up to 8 per layer, ≤ 2 per product, and each listed category's best variant is
guaranteed a place. Ties break on variantId, so output is deterministic.

## COMPOSE

VLM, one call per direction (and per revision). It sees the Brief, the direction, and only
that direction's shortlist: one text line per candidate followed by its swatch image
(≤ 16 swatches), then the room photo last. It returns
`{directionId, visual, functional, rationale: [{claim, briefFields}]}`; the stage wraps that
into a Proposal (`r<round>-<direction>-a<attempt>`).

Code checks: both IDs are in the right layer of *this* shortlist and not excluded; functional
is present exactly when the direction has a functional layer; every `briefFields` entry is a
real Brief path. Retry once; unknown Brief paths can be repaired (dropped); an invalid ID
cannot, so the fallback is RETRIEVE's top-ranked non-excluded variant per layer, marked
`source: "fallback"` on the proposal, the card ("fallback pick") and the report.

## RENDER

Image model, visual layer only, through v1's `generateProductPreview` (its prompt is now
exported so v2 can hash it). The render file is named by
`sha256(photo, productId, variantId, provider, model, promptHash, attempt)`, and in live mode the
runtime's response cache returns an existing render for the same key without a new call (as
long as the file still exists). A render counts against the round's budget before it runs; a
refused render (budget spent) or a failed one leaves the proposal unrendered with a visible
warning.

The mock render paints the variant's swatch colour over the Brief's `windowRegion`. An
optional `render` fixture overrides the colour (used to test off-colour renders).

## CRITIQUE

Two parts, in this order, and they answer different questions.

**Faithfulness (code, `stages/faithfulness.js`)**: did the render keep the product's colour?
Crop the Brief's window region (inset 10% so the frame does not vote), k-means (3 clusters,
Lab) and take the dominant cluster, then CIEDE2000 against the swatch colour. Pass if
ΔE ≤ 15 (`config.faithfulness.threshold`). A failure is a *render* problem: the
`render-check` policy re-renders once (a `render-off-colour` warning), and if the second render
also fails, or no budget is left, the proposal is kept but shown without a render ("the
render changed the product's colour"), never judged on a wrong image.

**Design critique (VLM, `stages/critique.js`)**: only faithful renders reach it. Separate
prompt, and by default a different provider (OpenAI) from COMPOSE (Gemini). It sees the room
before, the swatch and the render, the Brief, the direction and the proposal's rationale, and
scores harmony, intent, roomFit and installed 1–5 with a verdict. Code rejects an ACCEPT with
any score below 3 (the rubric's own rule): retry once, then fallback. The fallback has no
verdict (`UNREVIEWED`); the proposal is shown as "unreviewed", never as accepted.

**Policies (`src/v2/policies/`)**: `render-check` (critique | rerender | unrendered) and
`critique-verdict` (accept | revise | drop | stop-unapproved | accept-unreviewed). Pure
functions of facts; each call is recorded as a decision with its inputs and reason. REVISE
loops back to COMPOSE with the rejected variant excluded and the critic's hint, while the
direction has revisions left (2), the round has renders left (6) and the shortlist has untried
variants; otherwise the proposal stops as `revised` and may be shown as "unapproved" only if
fewer than 2 were accepted.

## PRESENT

Code. Up to 3 cards: accepted proposals first; if fewer than 2 were accepted, the best
REVISE'd ones are added and marked `unapproved` (with a warning); DROPped ones are never
shown. With critique off (step 2), every direction's latest proposal is shown `unreviewed`.
Each card has the render (the last faithful one), direction title and intent, the visual
product, the functional product ("described, not rendered"), the rationale with its Brief
field chips, and the critique verdict. Below the cards, a "What I assumed" chip for every
inferred or assumed Brief field, least confident first; clicking one edits it (REACT).

## REACT and re-entry

The person can pick a card, type feedback on one card ("Refine this one"), type general
feedback, or click an assumption chip and correct it. REACT (code, `stages/react.js`) applies
it to the Brief: an edited chip becomes `stated` (confidence 1); feedback is appended to
`preferences.text` and read by the lexicon (room type, warmth, lightness, needs, "no X"
colours, style words); a new room type raises non-stated needs to its guideline level, as
BRIEF does. Reactions naming an unknown proposal, or empty ones, are rejected with a
`reaction-rejected` warning and change nothing.

The `reaction-reentry` policy (`policies/reaction-reentry.js`) decides:

| Reaction | Decision |
|---|---|
| a pick, nothing else changed | `done` |
| room re-described: room type, needs, style, palette, light, materials, window | `plan` (new directions, new ids d4…) |
| only preferences changed, about one card | `compose` for that direction |
| only preferences changed, not about one card | `compose` for every direction |
| unparsed text about one card | `compose` for that direction, with the text as feedback |
| unparsed text not about any card | `plan` (PLAN reads `preferences.text`) |

On `compose`, every visual variant already shown for the direction is excluded, and
RETRIEVE runs again for it first, since the Brief (and so the preference score) changed.
Directions not re-composed keep their proposal on the new cards. Every re-entry archives the
round into `session.history` and starts a new round (fresh budget).

## Evals

`src/eval/v2-metrics.js` (per-trace) and `npm run v2:eval` (`src/eval/v2-run.js`, across
traces). No model calls; every LLM stage is compared with its no-model baseline:

| Metric | Source | Baseline |
|---|---|---|
| perception | Brief vs `evals/briefs/<room>.json` (format in its README; one example) | k-means perception (PERCEIVE's `baseline`) |
| guideline compliance | proposals whose categories are allowed (automatic) | — |
| direction diversity | mean pairwise axis difference; ΔE between directions' top picks | template planner (PLAN's `baseline`) |
| render faithfulness | ΔE render vs swatch (automatic) | — |
| critique agreement | model verdict vs your labels, agreement and Cohen's κ | always-accept |
| compose deviation | how often COMPOSE picks something other than RETRIEVE's top | (tells you whether the VLM adds anything) |
| end-to-end | blind pairwise preference, v2's first card vs v1's top pick | — |
| noise floor | repeated sessions per room (`--repeat`): presented-set Jaccard, room-type agreement | — |

`npm run v2:run -- --all --baseline` runs the whole pipeline with every LLM stage replaced by
its baseline, producing ordinary traces for the same report and comparison.

Labelling: `/v2/label-critique.html` shows before/render side by side and hides the critic's
verdict until you label (so it cannot anchor you). Labels go to
`evals/critique-labels.json`, keyed by the render's content hash. Comparison:
`/v2/compare.html` shows each room with v2's first card and v1's top pick in random order,
both as swatch + product photo (no render, so the comparison is about the choice). v1 picks
come from `evals/runs/*/report.json` (v1's eval harness), or `V1_RUNS_DIR`; picks whose IDs
are not in the current catalog are skipped and counted.

## Running it

```bash
npm test                                   # offline checks; network blocked
npm run v2:run -- --all --mock             # every eval room, fixtures only
npm run v2:report                          # traces/report/index.html (also /v2/report)
npm run v2:eval                            # per-stage metrics vs baselines
npm run dev                                # http://localhost:3001/v2/
```

Resume a saved session with a reaction:
`npm run v2:run -- --resume traces/sessions/<id>.session.json --react '{"kind":"feedback","proposalId":"r1-d1-a1","text":"warmer"}'`

## First live run (proposed, not run)

One room, full pipeline, tightly bounded. It needs your go-ahead; nothing in the build made a
paid call.

```bash
DESIGN_AGENT_LIVE=1 npm run v2:run -- --room uploaded_room --live --max-renders 3 --max-revisions 0
```

| Stage | Provider / model | Calls | Images sent | Rough tokens (in / out) |
|---|---|---|---|---|
| PERCEIVE | Gemini `gemini-2.5-flash` | 1 | 1 (room, ≤1536 px) | ~1.5k / ~0.5k |
| PLAN | Gemini `gemini-2.5-flash` | 1 | 0 | ~1.2k / ~0.5k |
| COMPOSE | Gemini `gemini-2.5-flash` | 3 | ~16 each (≤15 swatches at 256 px + room) ≈ 48 | ~6k / ~0.3k each |
| RENDER | OpenAI `gpt-image-2`, 1024², low | 3 image edits | 3 inputs each (room, product, swatch) | priced per image |
| CRITIQUE | OpenAI `gpt-4.1-mini` | 3 | 3 each (room, swatch, render) = 9 | ~2.5k / ~0.2k each |

Total: 8 LLM calls (up to 16 if every one retries once), ~58 images into LLMs, 3 image
generations (the cap; an off-colour render cannot be re-rendered within it and is shown
unrendered). About 30k input and 2.5k output tokens, ≈ $0.02 of LLM cost at the list prices in
`config.prices`, plus 3 `gpt-image-2` edits. What it answers: whether real PERCEIVE output
passes the schema, whether COMPOSE picks IDs from the shortlist, what real faithfulness ΔE
looks like (to calibrate the threshold of 15), and whether the critic's verdicts look sane.
After it: label the three renders in `/v2/label-critique.html` and run `npm run v2:eval`.

## Live runs so far (2026-09-24)

Three bounded runs on `uploaded_room`:

1. The approved first run. PERCEIVE failed twice: Gemini returned `windowRegion` as a bare
   box, which the prompt had shown that way, so the no-model fallback ran. All 3 OpenAI renders
   returned 429 "no credits".
2. After the fixes below: PERCEIVE, PLAN and COMPOSE all valid on Gemini, every COMPOSE ID in
   its shortlist. OpenAI renders still 429.
3. RENDER on Gemini `gemini-3.1-flash-image` (1 render): a realistic off-white drapery, ΔE 6.6
   vs the swatch (passes 15), about 11 s. The model **redrew the triple window as a single
   pane**; the critic's `installed` score exists for this, but CRITIQUE (OpenAI) got 429 and the
   proposal was shown unreviewed.

Fixes from these runs: the PERCEIVE prompt shows the wrapped shape explicitly, and bare values
are wrapped at confidence 0.5 with a note. A retry now tells the model what the last answer got
wrong (`correctionNote`). Traces keep the model's raw text (first 6000 chars). Gemini 2.5
thinking tokens, reported only in the total, are priced as output.

Live is on through `DESIGN_AGENT_LIVE=1` in `.env`, with render routed to Gemini through
`V2_RENDER_PROVIDER` / `V2_RENDER_MODEL` while OpenAI has no credits. CRITIQUE stays on OpenAI
(a different provider from COMPOSE, by design), so until credits are added every proposal is
shown "unreviewed".

## Live quirks fixed (2026-09-24, first sessions through the UI)

- **Faithfulness measured the glass, not the curtains.** Drapery hangs beside the window, so
  the window-box check read the view outside (ΔE 42–46 on correct navy curtains), wasted two
  re-renders and hid a good proposal. It now measures the pixels the render changed relative
  to the room photo, in a wide band around the window (sides, down to the floor), and falls
  back to the window box only when under 4% changed (`method` records which). Lightness
  counts half (CIEDE2000 kL = 2, as in textile matching): fabric in a lit room is darker than
  a flat swatch photo, while a hue change still fails. On the six real renders from that
  session, the worst correct product now measures 14.5 (threshold 15).
- **COMPOSE cited direction fields** (`direction.texture`, `direction.intent`) alongside valid
  Brief fields. Unknown citations are now dropped with a `rationale-fields-dropped` warning
  instead of a paid retry; a claim with no valid citation still fails.
- **CRITIQUE (`gemini-3.1-pro-preview`) wrapped its verdict in a one-element array.** Unwrapped.
- **PLAN put Wood Blinds (4 variants) alone in a layer.** The prompt now states the ≥ 5 rule.

## Tracing

`traces/<sessionId>.json` (schema `v2.trace`): orchestrator name, mode, config summary,
every stage record (input, output, attempts, warnings, latency, tokens, cost), the Brief with
provenance, directions, shortlists with score parts, proposals, renders, faithfulness,
critiques, policy decisions with reasons, reactions, round history, warnings and totals. A
trace that fails its own schema is still written, with `traceSchemaErrors`, since it is the
evidence.

## Assumptions to review

Each of these was my call in place of asking. Change any of them in the file named.

1. **Cellular Shades covers both cellular categories.** The catalog splits Cellular Shades and
   Blackout Cellular Shades; the guideline name maps to both. (`data/guidelines.json` nameMap)
2. **Single-layer rooms** use their one list as the primary (visual, rendered) layer with no
   functional layer. (`roomLayers` in `src/v2/guidelines.js`)
3. **Room needs profiles** (`needsProfile` per room) are my reading of each room's core needs
   onto low/medium/high. Used only as `assumed` defaults. (`data/guidelines.json`)
4. **Three more unmapped names** beyond the three you named: Blackout Zebra Shades,
   Top-down Bottom-up Shades, Cordless Systems (features, not categories). None are substituted.
5. **Unknown room type → Living Room**, marked `assumed` with confidence 0.2 and shown as an
   assumption chip. (`DEFAULT_ROOM_TYPE` in `src/v2/stages/brief.js`)
6. **Inferred fields need confidence ≥ 0.35** to be used; below that the Brief uses an assumed
   default. (`MIN_INFERRED_CONFIDENCE`)
7. **A stated room type raises needs** to the room's guideline level (never lowers them).
8. **Render budget is per round** (6 renders per orchestrator run, 2 revisions per direction).
   A reaction starts a new round with a fresh budget. Per-lifetime would leave a second round
   with nothing to render. (`config.budget`)
9. **Mock fixtures are keyed by a readable projection of the input** (`fixtureKey`), hashed
   with the stage name, rather than a hash of the full input. That makes fixtures writable by
   hand and stable when unrelated input details change. The live response cache uses the full
   input. (`src/mock-provider.js`)
10. **A missing fixture stops the run** with the exact key to add, rather than falling back to a
    baseline, so a gap in fixtures is never hidden.
11. **Direction diversity "category" axis** compares the visual-layer category sets.
12. **PLAN must be feasible**: each layer's categories must supply ≥ 5 variants under the
    2-per-product cap, else the plan is invalid (retry → repair by adding categories).
13. **RETRIEVE weights** 0.55 / 0.2 / 0.15 / 0.1 and the colour-strategy formulas above are
    first guesses, to be tuned against critique agreement and pairwise preference. (`config.retrieve`)
14. **Per-stage models**: PERCEIVE, PLAN, COMPOSE on Gemini `gemini-2.5-flash`; CRITIQUE on
    OpenAI `gpt-4.1-mini` (a different provider from COMPOSE, as asked); RENDER on OpenAI
    `gpt-image-2` (v1's default). Override with `V2_<STAGE>_PROVIDER` / `V2_<STAGE>_MODEL`.
15. **Free text is parsed by a small lexicon**, not an LLM. Unparsed text is kept verbatim.
16. **Prices** in `config.prices` are rough list prices for estimates only; image-model prices
    are unknown and reported as "unpriced".
17. **PERCEIVE's fallback** is a no-model perception (k-means palette, low-confidence
    everything else). It is also PERCEIVE's baseline.
18. **PERCEIVE also returns the window's position** (`windowRegion`, a box in image fractions).
    It is not in your field list; I added it because the mock render and the faithfulness check
    need to know where the covering is. A live render may move the window slightly; the box is
    used as-is.
19. **COMPOSE's fallback is RETRIEVE's top pick**, shown as a "fallback pick", rather than
    dropping the direction. You see three options, and it is clear which one no model chose.
20. **COMPOSE sees ≤ 16 swatches, not product form images.** The category name carries the
    form; adding 8+ product photos per call would double the image count for little gain.
    Easy to add if critique shows form confusion.
21. **"Complementary" means opposite the room's overall hue** (share × chroma weighted), not
    opposite the single most saturated accent.
22. **Faithfulness threshold ΔE2000 ≤ 15.** Mock renders measure ΔE < 1 when correct and ≈ 30
    when off. Real renders add lighting and shading, so 15 is a guess to calibrate on the first
    live renders (the report shows every ΔE).
23. **A render that fails faithfulness twice is not shown**, and the proposal is not critiqued;
    its card says why. Showing a wrong-colour render would misrepresent the product.
24. **Critique fallback is "unreviewed"**, a fourth verdict value that only code produces, so a
    broken critique can never read as an ACCEPT. Critique agreement counts model verdicts only.
25. **A render budget refusal leaves the proposal unrendered** (visible warning), rather than
    dropping it.
26. **The critic's hint is passed to the revision** (`critiqueHint` in COMPOSE's input). It is not
    part of COMPOSE's fixture key; the key uses the exclusion list, which already identifies the
    revision.
27. **Round-2 PLAN uses fresh direction ids** (d4, d5, d6…) so proposals from different rounds
    never collide; PLAN's check rejects a reused id.
28. **REACT uses the same lexicon as BRIEF**; feedback it cannot parse is kept verbatim and
    routes by whether it names a card (see the table above).
29. **The comparison view compares choices, not renders.** v1 has no render for its pick, and
    rendering it would be a paid call per room. Both sides show swatch + product photo.
30. **v1 picks for the comparison come from this worktree's `evals/runs`** (empty now). The v1
    folder has model runs on the V2 catalog (2026-09-12); set `V1_RUNS_DIR=../design-agent/evals/runs`
    to read them in place (read-only), or copy them. I did not copy anything from the v1 folder.
31. **The example hand brief (`evals/briefs/uploaded_room.json`) was written by me** from the
    same view the fixture was written from, so its 100% perception score is circular. Replace it.
32. **The catalog checksum is computed with sorted output.** In this sandbox `find` walks in a
    nondeterministic order, which made the unsorted checksum change between identical runs.
    `find … -exec shasum {} + | LC_ALL=C sort | shasum` is order-independent.
