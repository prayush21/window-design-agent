# Build v2 of the window design agent

## Context
This branch (`v2-agent`) starts from tag `v1-prototype`. You are working in the git worktree
`~/Documents/design-agent-v2`. v1 still runs from `~/Documents/design-agent` on port 3000.
Do not touch that folder.

v1 recommended window coverings in a single multimodal LLM call. The call sent the entire
catalog (84 products, 312 swatches, about 397 images) plus the room photo and got back a
ranked list of colourways (`src/server.js`, `src/providers.js`). Its problems:
- no understanding of intent or room type
- no design reasoning
- position bias from the alphabetical catalog order
- near-duplicate results
- scores the model reported about itself, which were not calibrated
- explanations written after the choice was made
- no iteration
- cost that grows with the catalog

We are rebuilding it as a design agent, defined as:
> A design agent helps a person transform an existing environment into a desired one by
> combining their taste and intent with design judgment, physical constraints, and
> products that can actually be acquired.

**Physical constraints (sizes, mount depth, window measurements) are out of scope for now.**
Do not add size or mount checks. Leave a clearly named, empty extension point for them.

## Hard rules
- The catalog at `DESIGN_AGENT_CATALOG_DIR` (in `.env`, an absolute path) is **read-only**
  and shared with v1. Never write, move or rename anything inside it. All derived data
  (guideline rules, layer roles, enriched attributes) lives in `data/` in this repo and is
  matched to the catalog by productId and variantId.
  At the start and end of each work session, record
  `find "$DESIGN_AGENT_CATALOG_DIR" -type f -exec shasum {} + | shasum` and confirm it is unchanged.
- The server runs on PORT=3001. v2 code lives in `src/v2/`, with its own routes (`/api/v2/...`)
  and its own UI page. Reuse v1 modules by importing them. If a v1 module must change, keep the
  change additive and keep v1 routes working.
- Deterministic work (ID validation, guideline filtering, colour distance, scoring) is done in
  code, not by the LLM. The LLM handles perception, planning, composition and critique only.
- Never fall back silently. Every fallback produces a visible warning in the response, the
  trace and the UI.
- Available provider keys: Gemini and OpenAI. There is no Anthropic key. Where a stage should
  use a different model from the stage it judges (critique vs compose), make the model a
  per-stage config value.

## Reuse from v1 (read these first)
- `src/catalog.js`: loader, product/variant normalization, fingerprint cache
- `src/image-cache.js`: sRGB JPEG encoding, per-role image sizes, memoization
- `src/providers.js`: `callProvider`, interleaved text→image blocks, stable-prefix caching
- `src/image-preview.js`: room + product → installed render (becomes the RENDER stage)
- `src/baseline/`: colour rankers that use no model (become the RETRIEVE scorer)
- `src/eval/`: harness runner, response cache, reports (extend, don't replace)

## Modularity: built as a workflow now, swappable for an agent later
We start with a fixed workflow, but we will later experiment with a tool-calling agent, and
possibly a hybrid, over **the same stages**. Build for that from day one:

1. **Stages are pure units with contracts.** Each stage is one module in `src/v2/stages/`
   and exports the same shape:
   ```js
   export default {
     name: "retrieve",
     description: "…one paragraph, written so it could be shown to an LLM as a tool description…",
     inputSchema,   // JSON Schema
     outputSchema,  // JSON Schema
     kind: "llm" | "code" | "image",
     async run(input, ctx) { … }   // ctx = { config, trace, budget, providers, catalog }
   }
   ```
   Every stage validates its input and output against its schemas.
2. **Stages never call other stages or know the order they run in.** Only an orchestrator
   decides what runs next. A stage gets everything it needs through `input` and `ctx`. It
   uses no module-level state and no hidden reads of the session.
3. **A registry** (`src/v2/stages/index.js`) lists every stage. The registry can be exported
   as tool definitions (name, description, inputSchema), so a future agent orchestrator can
   use the same stages as tools with no rewrite.
4. **Orchestrators are swappable.** The orchestrator interface is
   `src/v2/orchestrators/<name>.js` exporting `run(session, ctx) → async iterator of events`.
   Build `workflow.js` now. The UI and API choose the orchestrator by config or query param
   (`?orchestrator=workflow`), so `agent.js` can be added later and compared on the same
   input.
5. **Session state is explicit and serializable.** A `Session` object holds the Brief,
   directions, shortlists, proposals, renders, critiques and reactions. Orchestrators read
   and extend it. It can be saved and resumed at any stage boundary, which enables
   "re-enter at COMPOSE" and later lets an agent pick up from any point.
6. **Cross-cutting concerns are wrappers, not stage code.** Tracing, budget enforcement,
   response caching, retries and schema validation wrap `stage.run` in one place
   (`src/v2/runtime.js`). Every orchestrator gets them for free and they stay comparable.
7. **Decisions are separate functions.** The workflow's decision points (the critique verdict
   → accept/revise/drop, and where to re-enter after a user reaction) are separate named
   policy functions in `src/v2/policies/`. They are the first places an agent may later take
   over, so each must be replaceable on its own.

## Architecture: propose → render → critique → present

One pipeline serves both cases:
- The user **has** preferences: directions stay close to them (exploit).
- The user has **no** preferences: the agent generates deliberately different directions,
  tests them, and shows what survives (explore).

Stages:

1. **PERCEIVE** (VLM, room photo only) → `brief.environment` plus inferred intent: room type,
   window type and shape, palette (hex codes and names), materials, style tags, light level,
   existing covering, and inferred needs (privacy, blackout, glare, moisture, safety).
2. **BRIEF** (code): merge optional user input (free-text preferences now, reference images
   later) over the inferences. **Every field carries `source: stated | inferred | assumed` and
   `confidence`.** The Brief is the shared state all later stages read.
3. **PLAN DIRECTIONS** (LLM, text only) → exactly 3 directions:
   `{ id, title, intent, layers: { visual: [categories], functional: [categories] | null },
   colourStrategy: tonal | complementary | contrast | neutral-anchor, lightLevel, textureNote }`.
   Allowed categories come from `data/guidelines.json` for the Brief's room type. The
   directions must differ on at least two of: category, colourStrategy, lightLevel.
4. **RETRIEVE** (code), per direction and per layer:
   - filter the catalog to the allowed categories;
   - score variants against the Brief's palette using the direction's colour strategy (reuse
     the baselines), plus styleTags overlap;
   - return 5–8 variants per layer, with at most 2 variants per product for diversity.
   No LLM in this stage.
5. **COMPOSE** (VLM; sees only the shortlist, with swatches) → one proposal per direction:
   `{ directionId, visual: {productId, variantId}, functional: {productId, variantId} | null,
   rationale: [{ claim, briefFields: [...] }] }`. Validate every ID against the shortlist.
6. **RENDER** (image model): render **only the visual layer** into the room photo. The
   functional layer is described in text, not rendered. Two-layer renders are a later
   experiment. Cache renders by the hash of (room photo, product, variant, model, prompt).
7. **CRITIQUE**, in two parts:
   a. **Faithfulness** (code): compare the dominant colour of the covering region against the
      swatch using ΔE. On failure, re-render once. A render that changed the colour is a
      render problem, not a design problem.
   b. **Design critique** (VLM, separate prompt, fixed rubric: harmony with the palette,
      matches the direction's intent, fits the room type and needs, looks plausibly
      installed) → verdict ACCEPT | REVISE (with a reason → back to COMPOSE with the next
      variant) | DROP.
   Default budget: at most 2 revisions per direction and 6 renders per session. Configurable.
8. **PRESENT**: 2–3 accepted proposals. Each shows its render, direction title, layers,
   rationale linked to Brief fields, and a "What I assumed" chip for every
   `inferred`/`assumed` Brief field (editable).
9. **REACT**: the user picks one, types feedback ("warmer", "this is a nursery") or edits an
   assumption chip. The Brief is updated, and the reaction policy chooses whether to re-enter
   at PLAN (new directions) or COMPOSE (same direction, different variant). It records why.

The workflow orchestrator streams events to the UI: brief → directions → renders as each one
passes critique.

## Tracing
Every session writes `traces/<sessionId>.json`. A trace contains:
- the orchestrator's name
- the stage sequence, each stage's input and output
- the Brief with provenance
- directions and shortlists with scores
- proposals and render paths
- faithfulness results
- critique verdicts and reasons
- policy decisions and their reasons
- user reactions
- latency, tokens and cost per stage
- warnings

Traces are the unit of debugging and of offline evaluation. Keep the format independent of
the orchestrator, so workflow and agent runs can be compared. Add `traces/` to `.gitignore`.

## Data to create first
- `data/guidelines.json`, from `docs/window-design-guidelines.txt` (source PDF also in `docs/`):
  - map each room type to its core needs, visual-layer categories and functional-layer
    categories;
  - map guideline names onto the **exact** catalog category names;
  - record names that don't map as `unmapped`; never drop them silently. Stirpe Bamboo
    Curtain, Blackout Roman Shades and Faux Wood Blinds are not in the catalog;
  - aliases: Blackout Curtains → Blackout Drapery, Curtains → Drapery Panels,
    Zebra/Dual Shades → Zebra Shades.
- `data/category-roles.json`: whether each catalog category can play the visual role, the
  functional role, or both.
- `src/v2/schemas/`: JSON Schemas for Brief, Direction, Shortlist, Proposal, Render,
  Critique, Session, Trace, and each stage's input and output. Validate every LLM output
  against its schema; on failure, retry once, then warn.
- `docs/v2-design.md`: a living design record. It covers the schemas, every non-obvious
  decision and the reason for it, and every assumption you made in place of asking me.

## Build order
Each step is demo-able on its own. Commit at each green step boundary.
1. Schemas, guidelines.json, runtime, registry, workflow orchestrator, and the stages
   PERCEIVE, BRIEF, PLAN and RETRIEVE, with a text-only output page. At this point it is
   already comparable to v1: it follows the guidelines, gives diverse results, and sends no
   catalog images to a ranker.
2. Add COMPOSE and RENDER, with no critique; show every proposal.
3. Add CRITIQUE with the faithfulness check, the bounded loop and the verdict policy.
4. Add REACT, the assumption chips and the re-entry policy.

## Evals (a parallel track that must not block the build)
Extend `src/eval/` with per-stage metrics computed over traces:
- **perception:** Brief fields vs hand-written briefs for `evals/rooms/` (I will write
  these; create the file format and one example)
- **guideline compliance:** % of proposals whose categories are allowed (automatic)
- **direction diversity:** pairwise difference across the 3 directions (automatic)
- **render faithfulness:** ΔE of the rendered covering vs its swatch (automatic)
- **critique agreement:** critique verdict vs my accept/reject labels on renders (build the
  labelling view)
- **end-to-end:** pairwise human preference, v2 proposal vs v1 top pick on the same room
  (build the comparison view)

Keep the v1 principles:
- labels are sets of acceptable answers, not a single right one;
- use `--repeat` to measure the noise floor;
- every LLM stage must beat its baseline that uses no model.

## Goal for this run: work autonomously until every check below passes
Work through build steps 1–3 without stopping to ask me. When a decision is mine, make the
most reasonable choice, record it in `docs/v2-design.md` under "Assumptions to review", and
keep going. Stop early only for real blockers: a missing API key, a provider outage, or a
budget cap reached.

You are done when **all** of these are true, and you have verified each one by running it,
not by reasoning about it:

1. `npm test` passes. It includes schema tests for every stage, unit tests for the code stages
   (retrieve, faithfulness, policies), and one end-to-end workflow test that uses recorded
   LLM responses (no network).
2. `npm run v2:run -- --all` runs the full workflow on every photo in `evals/rooms/`. It
   completes with no uncaught errors and writes one trace per room. Photos with no window,
   very dark photos or unreadable images end with an explicit warning, not a crash.
3. Automatic quality checks across all traces:
   - guideline compliance is 100%;
   - every session has 3 directions that differ on at least 2 axes;
   - every returned ID exists in the catalog;
   - every Brief field has a provenance tag;
   - no session exceeded its render budget.
4. Render faithfulness (ΔE) is computed and reported for every render. It is not a
   pass/fail gate; just report the distribution.
5. Modularity check: a script lists the registry as tool definitions (name, description,
   inputSchema), and a test runs any single stage alone, using only a saved Session and its
   input.
6. Isolation check: the catalog checksum is unchanged, and v1 still works. In this worktree,
   start the server and confirm `/api/recommend` and `/api/catalog` still respond as in
   `v1-prototype`.
7. **Review packet:** `npm run v2:report` builds one self-contained `reports/v2-review.html`.
   For each room it shows the photo, the Brief with provenance, the 3 directions, the
   shortlists, the proposals with renders, the critique verdicts with reasons, v1's top pick
   for the same room (from the v1 eval cache or a v1 run), plus totals for cost and latency.
   This packet is what I will judge quality from.
8. `docs/v2-design.md` is up to date, including "Assumptions to review" and "Known
   weaknesses I'd fix next".

Spending limit for the whole run: no more than 60 image renders and 300 LLM calls in total.
Cache everything by input hash so re-runs are free. If a limit would be crossed, stop and
report.

When done, give me a summary: what was built, the check results with their numbers, the
assumptions I need to review, and the link to the review packet.
