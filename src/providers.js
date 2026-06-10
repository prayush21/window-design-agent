import { imageFileToDataUrl } from "./catalog.js";

const PROVIDERS = new Set(["openai", "gemini", "anthropic"]);
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
    "variantId": "one of the candidates",
    "category": "category",
    "confidence": 0.0,
    "reason": "plain-language reason"
  },
  "rankings": [
    {
      "rank": 1,
      "productId": "one of the candidates",
      "variantId": "one of the candidates",
      "category": "category",
      "score": 0.0,
      "reason": "brief reason",
      "tradeoffs": ["brief tradeoff"]
    }
  ]
}`;

export const DEFAULT_RECOMMENDATION_PROMPT = `You are an interior-design product recommendation agent for window coverings.

The first image is the user's room/window photo. The following images are candidate product images in the same order as the candidate list.

Rank the candidates by which product would look best in the user's room and window context. Consider visual harmony, room style, color compatibility, window shape, light/privacy needs visible in the photo, and practical fit. Do not invent product IDs.`;

export function normalizeProvider(provider) {
  const normalized = (provider || process.env.DESIGN_AGENT_PROVIDER || "openai").toLowerCase();
  if (!PROVIDERS.has(normalized)) {
    throw new Error(`Unsupported provider "${provider}". Use openai, gemini, or anthropic.`);
  }
  return normalized;
}

export async function rerankProducts({ provider, model, systemPrompt, userImageDataUrl, candidates }) {
  const normalizedProvider = normalizeProvider(provider);
  const request = buildRerankRequest({ systemPrompt, userImageDataUrl, candidates });

  if (normalizedProvider === "openai") {
    return callOpenAI({ model, ...request });
  }

  if (normalizedProvider === "gemini") {
    return callGemini({ model, ...request });
  }

  return callAnthropic({ model, ...request });
}

function buildRerankRequest({ systemPrompt, userImageDataUrl, candidates }) {
  const productSummaries = candidates
    .map((product, index) => {
      const variant = product.variants[0];
      return [
        `Candidate ${index + 1}`,
        `productId: ${product.productId}`,
        `variantId: ${variant.variantId}`,
        `category: ${product.category}`,
        `displayName: ${product.displayName}`,
        `color: ${variant.color ?? "unknown"}`,
        `fabric: ${variant.fabric ?? "unknown"}`,
        `material: ${variant.material ?? "unknown"}`,
        `opacity: ${variant.opacity ?? "unknown"}`
      ].join("\n");
    })
    .join("\n\n");

  const instructionPrompt = String(systemPrompt || "").trim() || DEFAULT_RECOMMENDATION_PROMPT;
  const prompt = `${instructionPrompt}

Candidates:
${productSummaries}

${RESPONSE_SCHEMA_PROMPT}`;

  return {
    prompt,
    userImageDataUrl,
    productImageDataUrls: candidates.map((product) => imageFileToDataUrl(product.variants[0].imagePath))
  };
}

async function callOpenAI({ model, prompt, userImageDataUrl, productImageDataUrls }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY.");

  const selectedModel = model || process.env.OPENAI_MODEL || "gpt-4.1";
  const content = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: userImageDataUrl },
    ...productImageDataUrls.map((imageUrl) => ({ type: "input_image", image_url: imageUrl }))
  ];

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

async function callGemini({ model, prompt, userImageDataUrl, productImageDataUrls }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY.");

  const selectedModel = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const parts = [
    { text: prompt },
    toGeminiInlineData(userImageDataUrl),
    ...productImageDataUrls.map(toGeminiInlineData)
  ];

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

async function callAnthropic({ model, prompt, userImageDataUrl, productImageDataUrls }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY.");

  const selectedModel = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const content = [
    { type: "text", text: prompt },
    toAnthropicImage(userImageDataUrl),
    ...productImageDataUrls.map(toAnthropicImage)
  ];

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
    result: parsed
  };
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

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Expected a base64 data URL.");
  return {
    mimeType: match[1],
    base64: match[2]
  };
}

function toGeminiInlineData(dataUrl) {
  const { mimeType, base64 } = parseDataUrl(dataUrl);
  return {
    inlineData: {
      mimeType,
      data: base64
    }
  };
}

function toAnthropicImage(dataUrl) {
  const { mimeType, base64 } = parseDataUrl(dataUrl);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mimeType,
      data: base64
    }
  };
}
