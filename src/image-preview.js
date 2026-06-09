import fs from "node:fs";
import { detectMimeTypeFromBytes, getMimeType } from "./catalog.js";

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "low";
const DEFAULT_OUTPUT_FORMAT = "jpeg";

export async function generateProductPreview({ userImageDataUrl, product, recommendation }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY.");

  const outputFormat = process.env.OPENAI_IMAGE_OUTPUT_FORMAT || DEFAULT_OUTPUT_FORMAT;
  const form = new FormData();
  const userImage = dataUrlToBlob(userImageDataUrl);
  const productImage = fileToBlob(product.variants[0].imagePath);

  form.append("model", process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL);
  form.append("image[]", userImage.blob, `room-window.${extensionForMime(userImage.mimeType)}`);
  form.append("image[]", productImage.blob, `product-reference.${extensionForMime(productImage.mimeType)}`);
  form.append("prompt", buildPreviewPrompt({ product, recommendation }));
  form.append("size", process.env.OPENAI_IMAGE_SIZE || DEFAULT_SIZE);
  form.append("quality", process.env.OPENAI_IMAGE_QUALITY || DEFAULT_QUALITY);
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
    throw new Error(`OpenAI image edit error (${response.status}): ${message}`);
  }

  const base64 = json?.data?.[0]?.b64_json;
  if (!base64) throw new Error("OpenAI image edit response did not include image data.");

  return {
    model: process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL,
    size: process.env.OPENAI_IMAGE_SIZE || DEFAULT_SIZE,
    quality: process.env.OPENAI_IMAGE_QUALITY || DEFAULT_QUALITY,
    outputFormat,
    imageDataUrl: `data:image/${outputFormat};base64,${base64}`,
    revisedPrompt: json?.data?.[0]?.revised_prompt || null,
    usage: json?.usage || null
  };
}

function buildPreviewPrompt({ product, recommendation }) {
  return `Edit the first image, which is the user's room and window photo, by realistically installing the window covering shown in the second image.

Use the second image only as the product reference for appearance, structure, folds/slats, material impression, and proportions. The selected product is ${product.displayName}.

Preserve the user's original room, camera angle, window size, wall color, furniture, lighting direction, shadows, and overall realism. Do not change the room layout. Do not add labels, watermarks, people, or extra decor. The result should look like a believable product visualization after installation.

Recommendation context: ${recommendation?.reason || "Best-ranked product for this room."}`;
}

function dataUrlToBlob(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Expected a base64 image data URL.");
  const bytes = Buffer.from(match[2], "base64");
  const detectedMimeType = detectMimeTypeFromBytes(bytes);
  const mimeType = normalizeMimeType(detectedMimeType || match[1]);

  return {
    mimeType,
    blob: new Blob([bytes], { type: mimeType })
  };
}

function fileToBlob(filePath) {
  const bytes = fs.readFileSync(filePath);
  const mimeType = detectMimeTypeFromBytes(bytes) || getMimeType(filePath);

  return {
    mimeType,
    blob: new Blob([bytes], { type: mimeType })
  };
}

function extensionForMime(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

function normalizeMimeType(mimeType) {
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}
