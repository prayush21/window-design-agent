import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildPreviewPrompt } from "../../image-preview.js";
import { ROOT_DIR } from "../config.js";
import { nonEmpty } from "../schemas/index.js";

// RENDER: image model. Installs ONLY the proposal's visual layer into the room
// photo (v1's preview pipeline). The functional layer is described in text, not
// rendered; two-layer renders are a later experiment.
//
// Renders are files named by the hash of (room photo, product, variant, model,
// prompt, attempt), so an identical request reuses the file instead of paying again.

const inputSchema = {
  type: "object",
  required: ["roomPhoto", "proposal", "windowRegion", "attempt"],
  properties: {
    roomPhoto: {
      type: "object",
      required: ["path", "sha256"],
      properties: { path: nonEmpty, sha256: { type: "string" }, roomId: { type: ["string", "null"] } }
    },
    proposal: { $ref: "v2.proposal" },
    windowRegion: { $ref: "v2.region" },
    attempt: { type: "integer", minimum: 1, maximum: 3 }
  },
  additionalProperties: false
};

export default {
  name: "render",
  version: 1,
  kind: "image",
  description:
    "Render the proposal's visual-layer product into the room photo, replacing any existing covering, preserving the room. " +
    "Only the visual layer is rendered. Use attempt 2 to re-render after a faithfulness failure. Costs one image generation.",
  inputSchema,
  outputSchema: { $ref: "v2.render" },

  cacheKey(input, ctx) {
    return renderKey(input, ctx);
  },

  // A cached render is only reusable while its image file still exists.
  cacheValid(output, ctx) {
    return fs.existsSync(path.join(ctx.paths.renders, output.imagePath));
  },

  async run(input, ctx) {
    const { proposal, roomPhoto, attempt } = input;
    const product = ctx.catalog.products.get(proposal.visual.productId);
    const variant = product?.variants.find((v) => v.variantId === proposal.visual.variantId);
    if (!product || !variant) throw new Error(`Unknown product ${proposal.visual.productId}/${proposal.visual.variantId}.`);

    const indexed = ctx.catalog.variants.get(variant.variantId);
    const recommendation = { reason: proposal.rationale.map((r) => r.claim).join(" ") };
    const key = renderKey(input, ctx);
    const target = ctx.config.stages.render;
    const live = ctx.config.mode === "live";
    const fileName = `${live ? "" : "mock-"}${key}.jpg`;
    const filePath = path.join(ctx.paths.renders, fileName);
    const photoPath = path.resolve(ROOT_DIR, roomPhoto.path);

    const result = await ctx.providers.image({
      roomPhotoPath: photoPath,
      roomDataUrl: live ? `data:image/jpeg;base64,${fs.readFileSync(photoPath).toString("base64")}` : null,
      product,
      variant,
      recommendation,
      mock: {
        region: input.windowRegion,
        colourHex: indexed?.hex || "#808080",
        attempt,
        fixtureKey: { photo: roomPhoto.sha256.slice(0, 16), variantId: variant.variantId, attempt }
      }
    });

    fs.mkdirSync(ctx.paths.renders, { recursive: true });
    fs.writeFileSync(filePath, result.bytes);

    return {
      renderId: `${proposal.proposalId}-render${attempt}`,
      proposalId: proposal.proposalId,
      productId: product.productId,
      variantId: variant.variantId,
      attempt,
      imagePath: fileName,
      cacheKey: key,
      provider: result.provider,
      model: live ? result.model : target.model,
      promptHash: promptHash(product, variant, recommendation),
      cached: false
    };
  }
};

export function renderKey({ roomPhoto, proposal, attempt }, ctx) {
  const product = ctx.catalog.products.get(proposal.visual.productId);
  const variant = product?.variants.find((v) => v.variantId === proposal.visual.variantId);
  const target = ctx.config.stages.render;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        photo: roomPhoto.sha256,
        productId: proposal.visual.productId,
        variantId: proposal.visual.variantId,
        provider: target.provider,
        model: target.model,
        prompt: product && variant ? promptHash(product, variant, { reason: proposal.rationale.map((r) => r.claim).join(" ") }) : null,
        attempt
      })
    )
    .digest("hex")
    .slice(0, 24);
}

function promptHash(product, variant, recommendation) {
  return crypto.createHash("sha256").update(buildPreviewPrompt({ product, variant, recommendation })).digest("hex").slice(0, 16);
}
