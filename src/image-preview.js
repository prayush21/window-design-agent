import fs from "node:fs";
import sharp from "sharp";
import { detectMimeTypeFromBytes, getMimeType } from "./catalog.js";

const IMAGE_PROVIDERS = new Set(["openai", "gemini"]);
const DEFAULT_OPENAI_MODEL = "gpt-image-2";
const DEFAULT_OPENAI_SIZE = "1024x1024";
const DEFAULT_OPENAI_QUALITY = "low";
const DEFAULT_OPENAI_OUTPUT_FORMAT = "jpeg";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-image";
const NORMALIZED_INPUT_MIME_TYPE = "image/png";
const NORMALIZED_INPUT_EXTENSION = "png";
const MAX_INPUT_DIMENSION = 2048;

export async function generateProductPreview({
  provider,
  model,
  userImageDataUrl,
  product,
  recommendation
}) {
  const normalizedProvider = normalizeImageProvider(provider);
  const prompt = buildPreviewPrompt({ product, recommendation });
  const inputs = await normalizePreviewInputs({ userImageDataUrl, product });

  if (normalizedProvider === "gemini") {
    return generateGeminiProductPreview({ model, prompt, inputs });
  }

  return generateOpenAIProductPreview({ model, prompt, inputs });
}

function normalizeImageProvider(provider) {
  const normalized = (provider || process.env.IMAGE_PREVIEW_PROVIDER || "openai").toLowerCase();
  if (!IMAGE_PROVIDERS.has(normalized)) {
    throw new Error(`Unsupported image provider "${provider}". Use openai or gemini.`);
  }
  return normalized;
}

async function normalizePreviewInputs({ userImageDataUrl, product }) {
  return {
    userImage: await dataUrlToNormalizedBlob(userImageDataUrl),
    productImage: await fileToNormalizedBlob(product.variants[0].imagePath)
  };
}

async function generateOpenAIProductPreview({ model, prompt, inputs }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY.");

  const selectedModel = model || process.env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_MODEL;
  const size = process.env.OPENAI_IMAGE_SIZE || DEFAULT_OPENAI_SIZE;
  const quality = process.env.OPENAI_IMAGE_QUALITY || DEFAULT_OPENAI_QUALITY;
  const outputFormat = process.env.OPENAI_IMAGE_OUTPUT_FORMAT || DEFAULT_OPENAI_OUTPUT_FORMAT;
  const form = new FormData();

  form.append("model", selectedModel);
  form.append("image[]", inputs.userImage.blob, `room-window.${NORMALIZED_INPUT_EXTENSION}`);
  form.append("image[]", inputs.productImage.blob, `product-reference.${NORMALIZED_INPUT_EXTENSION}`);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", quality);
  form.append("output_format", outputFormat);

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.error?.message || response.statusText;
    const requestId = response.headers.get("x-request-id");
    throw new Error(
      `OpenAI image edit error (${response.status}): ${message}${requestId ? ` Request ID: ${requestId}.` : ""}`
    );
  }

  const base64 = json?.data?.[0]?.b64_json;
  if (!base64) throw new Error("OpenAI image edit response did not include image data.");

  return {
    provider: "openai",
    model: selectedModel,
    size,
    quality,
    outputFormat,
    normalizedInputs: {
      roomImage: inputs.userImage.metadata,
      productImage: inputs.productImage.metadata
    },
    imageDataUrl: `data:image/${outputFormat};base64,${base64}`,
    revisedPrompt: json?.data?.[0]?.revised_prompt || null,
    usage: json?.usage || null
  };
}

async function generateGeminiProductPreview({ model, prompt, inputs }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY.");

  const selectedModel = model || process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_MODEL;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(selectedModel)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              toGeminiInlineData(inputs.userImage),
              toGeminiInlineData(inputs.productImage)
            ]
          }
        ]
      })
    }
  );

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.error?.message || response.statusText;
    throw new Error(`Gemini image generation error (${response.status}): ${message}`);
  }

  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) throw new Error("Gemini image generation response did not include image data.");

  const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
  const outputFormat = mimeType.replace(/^image\//, "");

  return {
    provider: "gemini",
    model: selectedModel,
    size: "auto",
    quality: "auto",
    outputFormat,
    normalizedInputs: {
      roomImage: inputs.userImage.metadata,
      productImage: inputs.productImage.metadata
    },
    imageDataUrl: `data:${mimeType};base64,${inlineData.data}`,
    revisedPrompt:
      parts
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n") || null,
    usage: json?.usageMetadata || null
  };
}

function buildPreviewPrompt({ product, recommendation }) {
  return `Edit the first image, which is the user's room and window photo, by realistically installing the window covering shown in the second image.

If the user's window already has curtains, blinds, shades, rods, valances, tiebacks, or other window coverings, remove or replace those existing coverings cleanly before installing the selected product. Preserve the visible window frame, glass, trim, wall, sill, and surrounding room details as much as possible.

Use the second image only as the product reference for appearance, structure, folds/slats, material impression, and proportions. The selected product is ${product.displayName}. Place it only on the actual window area, scaled and aligned to the window dimensions and perspective.

Preserve the user's original room, camera angle, window size, wall color, furniture, lighting direction, shadows, and overall realism. Do not change the room layout. Do not add labels, watermarks, people, or extra decor. The result should look like a believable product visualization after installation.

Recommendation context: ${recommendation?.reason || "Best-ranked product for this room."}`;
}

async function dataUrlToNormalizedBlob(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Expected a base64 image data URL.");
  const bytes = Buffer.from(match[2], "base64");
  const detectedMimeType = detectMimeTypeFromBytes(bytes);
  const mimeType = normalizeMimeType(detectedMimeType || match[1]);

  return normalizeImageBytes(bytes, {
    source: "room-window",
    sourceMimeType: mimeType
  });
}

async function fileToNormalizedBlob(filePath) {
  const bytes = fs.readFileSync(filePath);
  const mimeType = detectMimeTypeFromBytes(bytes) || getMimeType(filePath);

  return normalizeImageBytes(bytes, {
    source: "product-reference",
    sourceMimeType: mimeType
  });
}

function normalizeMimeType(mimeType) {
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

async function normalizeImageBytes(bytes, { source, sourceMimeType }) {
  const pipeline = sharp(bytes, {
    animated: false,
    limitInputPixels: 64_000_000
  })
    .rotate()
    .resize({
      width: MAX_INPUT_DIMENSION,
      height: MAX_INPUT_DIMENSION,
      fit: "inside",
      withoutEnlargement: true
    })
    .removeAlpha()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .png();

  const normalizedBytes = await pipeline.toBuffer();
  const metadata = await sharp(normalizedBytes).metadata();

  return {
    mimeType: NORMALIZED_INPUT_MIME_TYPE,
    base64: normalizedBytes.toString("base64"),
    blob: new Blob([normalizedBytes], { type: NORMALIZED_INPUT_MIME_TYPE }),
    metadata: {
      source,
      sourceMimeType,
      mimeType: NORMALIZED_INPUT_MIME_TYPE,
      width: metadata.width,
      height: metadata.height,
      channels: metadata.channels,
      sizeBytes: normalizedBytes.length
    }
  };
}

function toGeminiInlineData(image) {
  return {
    inline_data: {
      mime_type: image.mimeType,
      data: image.base64
    }
  };
}
