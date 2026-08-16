import { RANKING_IMAGE_SIZES, encodeCatalogImage, encodeRoomImage } from "./image-cache.js";

const PROVIDERS = new Set(["openai", "gemini", "anthropic"]);

// Bump whenever buildRerankRequest changes WHAT is sent (ordering, image sizes,
// dedup, interleaving). The eval cache keys on this, so an old cached response is
// never replayed as if it came from the current request shape.
export const RERANK_REQUEST_VERSION = 2;
const RESPONSE_SCHEMA_PROMPT = `Return only valid JSON matching this shape:
{
  "analysis": {
    "window": {
      "shape": "short phrase",
      "frameColor": "short phrase",
      "mountingContext": "short phrase"
    },
    "room": {
      "style": ["style tags"],
      "palette": ["dominant colors"],
      "lighting": "short phrase"
    },
    "needs": {
      "privacy": "low | medium | high | unknown",
      "lightControl": "low | medium | high | unknown"
    }
  },
  "recommendation": {
    "productId": "one of the candidates",
    "variantId": "one of the candidate variants",
    "category": "category",
    "confidence": 0.0,
    "reason": "plain-language reason"
  },
  "rankings": [
    {
      "rank": 1,
      "productId": "one of the candidates",
      "variantId": "one of the candidate variants",
      "category": "category",
      "score": 0.0,
      "reason": "brief reason",
      "tradeoffs": ["brief tradeoff"]
    }
  ]
}`;

export const DEFAULT_RECOMMENDATION_PROMPT = `You are an interior-design product recommendation agent for window coverings.

The product catalog follows below. Each product is introduced by a text block followed immediately by its form/reference image, then one numbered candidate line per variant, each followed immediately by that variant's swatch image. A swatch is the source of truth for that variant's exact color and texture; the product image is the source of truth for shape, mounting style, and proportions.

The user's room and window photo is the very last image in this message.

Rank the candidate variants by which exact product finish would look best in the user's room and window context. Return the top 10 ranked variants, or all variants when fewer than 10 are available. Consider visual harmony, room style, color compatibility, texture, material, window shape, light/privacy needs visible in the photo, and practical fit. Where a variant's opacity is listed as unknown, do not assume a light-control level for it. Do not invent product IDs or variant IDs.`;

export function normalizeProvider(provider) {
  const normalized = (provider || process.env.DESIGN_AGENT_PROVIDER || "openai").toLowerCase();
  if (!PROVIDERS.has(normalized)) {
    throw new Error(`Unsupported provider "${provider}". Use openai, gemini, or anthropic.`);
  }
  return normalized;
}

export async function rerankProducts({ provider, model, systemPrompt, userImageDataUrl, candidates }) {
  const normalizedProvider = normalizeProvider(provider);
  const blocks = await buildRerankRequest({ systemPrompt, userImageDataUrl, candidates });
  const requestStats = describeRequest(blocks);
  const startedAt = Date.now();

  const response =
    normalizedProvider === "openai"
      ? await callOpenAI({ model, blocks })
      : normalizedProvider === "gemini"
        ? await callGemini({ model, blocks })
        : await callAnthropic({ model, blocks });

  return { ...response, requestStats, latencyMs: Date.now() - startedAt };
}

function describeRequest(blocks) {
  const images = blocks.filter((block) => block.type === "image");
  const unique = new Set(images.map((block) => block.image.base64));

  return {
    imageCount: images.length,
    uniqueImageCount: unique.size,
    duplicateImageCount: images.length - unique.size,
    approxImageBytes: images.reduce((total, block) => total + block.image.byteLength, 0),
    promptChars: blocks
      .filter((block) => block.type === "text")
      .reduce((total, block) => total + block.text.length, 0),
    blockCount: blocks.length
  };
}

// Builds an ordered list of content blocks rather than a prompt plus a flat image run.
//
// Three properties matter here:
//   1. Each image sits immediately after the text that names it, so the model never
//      has to count positions to bind a swatch to a candidate.
//   2. A product's form image is sent once per product, not once per variant.
//   3. Everything stable (instructions, catalog, schema) precedes the volatile room
//      photo, so providers can cache the prefix across requests.
async function buildRerankRequest({ systemPrompt, userImageDataUrl, candidates }) {
  const instructionPrompt = String(systemPrompt || "").trim() || DEFAULT_RECOMMENDATION_PROMPT;
  const blocks = [text(instructionPrompt), text("=== CATALOG ===")];

  let candidateNumber = 0;

  for (const product of candidates) {
    blocks.push(
      text(
        [
          `--- ${product.displayName} ---`,
          `productId: ${product.productId}`,
          `category: ${product.category}`,
          product.description ? `description: ${product.description}` : null,
          `The next image is the product form/reference image for ${product.productId}.`
        ]
          .filter(Boolean)
          .join("\n")
      ),
      image(await encodeCatalogImage(product.imagePath, RANKING_IMAGE_SIZES.product))
    );

    for (const variant of product.variants) {
      candidateNumber += 1;
      blocks.push(
        text(
          [
            `Candidate ${candidateNumber}`,
            `productId: ${product.productId}`,
            `variantId: ${variant.variantId}`,
            `variantName: ${variant.name ?? "default"}`,
            `color: ${variant.color ?? "unknown"}`,
            `colorFamily: ${variant.colorFamily ?? "unknown"}`,
            `warmth: ${variant.warmth ?? "unknown"}`,
            `fabric: ${variant.fabric ?? "unknown"}`,
            `material: ${variant.material ?? "unknown"}`,
            `texture: ${variant.texture ?? "unknown"}`,
            `opacity: ${variant.opacity ?? "unknown"}`,
            `styleTags: ${formatList(variant.styleTags)}`,
            `bestFor: ${formatList(variant.bestFor)}`,
            `avoidFor: ${formatList(variant.avoidFor)}`,
            variant.swatchImagePath
              ? `The next image is the swatch for candidate ${candidateNumber} (${variant.variantId}).`
              : `No swatch image is available for candidate ${candidateNumber}; use the product image and the metadata above.`
          ].join("\n")
        )
      );

      if (variant.swatchImagePath) {
        blocks.push(image(await encodeCatalogImage(variant.swatchImagePath, RANKING_IMAGE_SIZES.swatch)));
      }
    }
  }

  blocks.push(text(RESPONSE_SCHEMA_PROMPT));
  // Cache boundary: everything above is identical across requests.
  blocks.push(text("=== END CATALOG ===\n\nThe next and final image is the user's room and window photo."), {
    ...image(await encodeRoomImage(userImageDataUrl)),
    volatile: true
  });

  return blocks;
}

function text(value) {
  return { type: "text", text: value };
}

function image(encodedImage) {
  return { type: "image", image: encodedImage };
}

function formatList(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(", ") : "unknown";
}

async function callOpenAI({ model, blocks }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY.");

  const selectedModel = model || process.env.OPENAI_MODEL || "gpt-4.1";
  // Prefix caching is automatic; it only requires the stable content to come first,
  // which buildRerankRequest guarantees.
  const content = blocks.map((block) =>
    block.type === "text"
      ? { type: "input_text", text: block.text }
      : { type: "input_image", image_url: block.image.dataUrl }
  );

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: selectedModel,
      input: [{ role: "user", content }]
    })
  });

  return parseProviderResponse({
    provider: "openai",
    model: selectedModel,
    response,
    extractText: (json) => json.output_text || extractOpenAIText(json)
  });
}

async function callGemini({ model, blocks }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY.");

  const selectedModel = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  // Implicit caching keys on a stable leading prefix, so no explicit markup needed.
  const parts = blocks.map((block) =>
    block.type === "text" ? { text: block.text } : toGeminiInlineData(block.image)
  );

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    }
  );

  return parseProviderResponse({
    provider: "gemini",
    model: selectedModel,
    response,
    extractText: (json) =>
      json.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("\n") || ""
  });
}

async function callAnthropic({ model, blocks }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY.");

  const selectedModel = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  // Explicit caching: mark the last stable block, so the whole catalog prefix is
  // cached and only the room photo is billed fresh on each request.
  const lastStableIndex = findLastStableIndex(blocks);
  const content = blocks.map((block, index) => {
    const mapped =
      block.type === "text" ? { type: "text", text: block.text } : toAnthropicImage(block.image);
    return index === lastStableIndex ? { ...mapped, cache_control: { type: "ephemeral" } } : mapped;
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: 1800,
      messages: [{ role: "user", content }]
    })
  });

  return parseProviderResponse({
    provider: "anthropic",
    model: selectedModel,
    response,
    extractText: (json) =>
      json.content
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("\n") || ""
  });
}

async function parseProviderResponse({ provider, model, response, extractText }) {
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.error?.message || json?.error?.message || response.statusText;
    throw new Error(`${provider} API error (${response.status}): ${message}`);
  }

  const text = extractText(json);
  const parsed = parseJsonFromText(text);

  return {
    provider,
    model,
    rawText: text,
    result: parsed,
    usage: extractUsage(provider, json)
  };
}

function extractUsage(provider, json) {
  if (!json) return null;

  if (provider === "gemini") {
    const usage = json.usageMetadata;
    if (!usage) return null;
    return {
      inputTokens: usage.promptTokenCount ?? null,
      outputTokens: usage.candidatesTokenCount ?? null,
      totalTokens: usage.totalTokenCount ?? null
    };
  }

  const usage = json.usage;
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? null;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? sumTokens(inputTokens, outputTokens)
  };
}

function sumTokens(inputTokens, outputTokens) {
  if (inputTokens === null && outputTokens === null) return null;
  return (inputTokens || 0) + (outputTokens || 0);
}

function extractOpenAIText(json) {
  return (
    json.output
      ?.flatMap((item) => item.content || [])
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n") || ""
  );
}

function parseJsonFromText(text) {
  if (!text) throw new Error("Provider returned an empty response.");

  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));

    throw new Error("Provider response did not contain valid JSON.");
  }
}

// Index of the last block before the volatile room photo and its label.
function findLastStableIndex(blocks) {
  const volatileIndex = blocks.findIndex((block) => block.volatile);
  // The label immediately preceding the photo is stable text, but keeping the
  // boundary before it costs nothing and keeps the rule obvious.
  return volatileIndex <= 1 ? -1 : volatileIndex - 2;
}

function toGeminiInlineData({ mimeType, base64 }) {
  return {
    inlineData: {
      mimeType,
      data: base64
    }
  };
}

function toAnthropicImage({ mimeType, base64 }) {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mimeType,
      data: base64
    }
  };
}
