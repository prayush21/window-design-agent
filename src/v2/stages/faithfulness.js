import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { deltaE2000, extractPalette, labToHex } from "../../baseline/color.js";

// FAITHFULNESS: code. Did the render keep the product's colour? Crops the window
// region of the render, takes its dominant colour (k-means in Lab) and measures
// CIEDE2000 against the swatch. A failure is a render problem, not a design
// problem: the policy re-renders rather than asking for a different product.

const inputSchema = {
  type: "object",
  required: ["render", "windowRegion"],
  properties: {
    render: { $ref: "v2.render" },
    windowRegion: { $ref: "v2.region" }
  },
  additionalProperties: false
};

// Shrink the box so the window frame and wall edge do not vote.
const INSET = 0.1;

export default {
  name: "faithfulness",
  version: 1,
  kind: "code",
  description:
    "Check whether a render kept the product's colour: take the dominant colour of the window region in the render and " +
    "compare it with the variant's swatch by CIEDE2000. Returns ΔE and pass/fail against the configured threshold. " +
    "Deterministic; no model.",
  inputSchema,
  outputSchema: { $ref: "v2.faithfulness" },

  async run(input, ctx) {
    const { render, windowRegion } = input;
    const threshold = ctx.config.faithfulness.threshold;
    const swatch = ctx.catalog.variants.get(render.variantId);
    const base = { renderId: render.renderId, proposalId: render.proposalId, threshold, method: "dominant-kmeans-lab-ciede2000" };

    if (!swatch?.lab) {
      ctx.warn("faithfulness-unchecked", `${render.variantId} has no swatch colour; the render's colour cannot be checked.`);
      return { ...base, pass: true, deltaE: null, measuredHex: null, swatchHex: null, note: "no swatch; unchecked" };
    }

    const file = path.join(ctx.paths.renders, render.imagePath);
    const measured = await dominantColour(fs.readFileSync(file), windowRegion);
    const deltaE = deltaE2000(measured, swatch.lab);
    return {
      ...base,
      pass: deltaE <= threshold,
      deltaE: Math.round(deltaE * 100) / 100,
      measuredHex: labToHex(measured),
      swatchHex: swatch.hex
    };
  }
};

export async function dominantColour(imageBytes, region) {
  const image = sharp(imageBytes).rotate();
  const { width, height } = await image.metadata();
  const left = Math.round((region.x + region.w * INSET) * width);
  const top = Math.round((region.y + region.h * INSET) * height);
  const w = Math.max(4, Math.round(region.w * (1 - 2 * INSET) * width));
  const h = Math.max(4, Math.round(region.h * (1 - 2 * INSET) * height));
  const crop = await image
    .extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) })
    .png()
    .toBuffer();
  const clusters = await extractPalette(crop, { clusters: 3, dropBlownOut: false });
  return clusters[0].lab;
}
