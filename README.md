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

## Architecture

For v1, the server gives the selected multimodal model the uploaded image and all catalog product images. Internally this is still represented as a retrieval-plus-reranking flow:

1. Load normalized catalog products and variants.
2. Select candidate variants. Today this returns the full catalog because it is tiny.
3. Ask the provider-specific multimodal model to rank the candidates.
4. Normalize and validate the returned recommendation JSON.

Future color/fabric/material support should be added as variants under a product rather than as separate unrelated products.
