# Window Product Design Agent

Small prototype for recommending the best window-covering product from `window-products-v1` for an uploaded room/window image.

## Run

```bash
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Provider Configuration

The API is provider-agnostic. Set one of these API keys and select the provider in the UI or request body.

```bash
OPENAI_API_KEY=...
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Optional model overrides:

```bash
OPENAI_MODEL=gpt-4.1
GEMINI_MODEL=gemini-2.5-flash
ANTHROPIC_MODEL=claude-sonnet-4-5
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=low
OPENAI_IMAGE_OUTPUT_FORMAT=jpeg
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
```

Default provider:

```bash
DESIGN_AGENT_PROVIDER=gemini
```

## API

`GET /api/catalog`

Returns the discovered catalog.

`POST /api/recommend`

```json
{
  "provider": "gemini",
  "model": "optional-model-override",
  "systemPrompt": "optional recommendation prompt override",
  "imageDataUrl": "data:image/jpeg;base64,...",
  "topK": 6
}
```

Returns ranked JSON plus readable explanations.

`POST /api/preview-image`

```json
{
  "imageDataUrl": "data:image/jpeg;base64,...",
  "imageProvider": "openai",
  "imageModel": "optional-image-model-override",
  "productId": "RM1311",
  "recommendation": {
    "productId": "RM1311",
    "reason": "Best match for the room."
  }
}
```

Uses OpenAI image edits with `gpt-image-2` by default to create an installed-product preview from the uploaded room image and the selected catalog product image. Set `imageProvider` to `gemini` to use the Gemini image model configured by `GEMINI_IMAGE_MODEL`.

## Eval Harness

Measures whether a change to the prompt, model, or candidate-building actually improved
recommendations, instead of guessing.

### 1. Add room photos

Drop 15–20 photos into `evals/rooms/`. Filenames become case ids. Spread them across warm
palettes, cool palettes, high-contrast rooms, small dim rooms, odd window shapes, rooms that
already have coverings, and 2 adversarial cases (no window visible, very dark or blurry).

### 2. Label them

```bash
npm run dev
```

Open `http://localhost:3000/eval-label.html`. Click a swatch to cycle
unlabeled → acceptable → unacceptable; shift-click marks it ideal. Saves to `evals/cases.json`
automatically.

Labels are **sets, not a single right answer** — two people will disagree on Natural vs. Bleach
White for the same warm room, and scoring against one person's coin flip turns noise into a
regression. The `unacceptable` set carries the most signal and is the easiest to fill in.

### 3. Run

```bash
npm run eval
```

```
--provider <name>     openai | gemini | anthropic
--model <id>          model override
--repeat <n>          runs per case, for variance
--case <substring>    only matching case ids
--concurrency <n>     parallel cases (default 2)
--fresh               bypass the response cache
--baseline <runId>    diff against a previous run
--prompt-file <path>  system prompt from a file
```

Results land in `evals/runs/<runId>/` as `report.json` plus a self-contained `report.html`
showing each room, what won, and why it passed or failed. Responses are cached by photo +
prompt + model + catalog fingerprint, so re-scoring is free; `--repeat` keys on run index so
variance measures the model rather than replaying one cached answer.

### Metrics

**Quality** (needs labels) — `acceptable@1`, `acceptable@3`, `ideal@1`, `category@1`, and
`violation@3`: an explicitly-wrong variant reaching the top 3.

**Health** (needs no labels, works before any labeling) — schema validity, grounded rate
(how many returned ids survived catalog validation, i.e. hallucination), silent-fallback
detection, `recommendation` vs. `rankings[0]` self-consistency, `avoidFor` conflicts against
the model's own detected palette, and graceful failure on adversarial cases.

**Cost** — input/total tokens, images sent, how many of those are duplicates, payload bytes,
latency.

**Variance** — `--repeat 3` reports rank-1 stability and top-5 overlap across identical
inputs. Run this first: it establishes the noise floor, below which a move in any quality
metric means nothing.

### Comparing runs

```bash
npm run eval -- --baseline 2026-08-05T14-13-24-819Z
```

```
Acceptable @1      67%     →  100%    ▲ +33 pts
Violation @3       33%     →  0%      ▲ -33 pts
Input tokens       31,240  →  13,120  ▲ -18,120
```

## Architecture

For v1, the server gives the selected multimodal model the uploaded image and all catalog product images. Internally this is still represented as a retrieval-plus-reranking flow:

1. Load normalized catalog products and variants.
2. Select candidate variants. Today this returns the full catalog because it is tiny.
3. Ask the provider-specific multimodal model to rank the candidates.
4. Normalize and validate the returned recommendation JSON.

Future color/fabric/material support should be added as variants under a product rather than as separate unrelated products.
