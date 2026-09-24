import fs from "node:fs";
import path from "node:path";
import { extractPalette } from "../../baseline/color.js";
import { encodeRoomImage } from "../../image-cache.js";
import { image, text } from "../../providers.js";
import { ROOT_DIR } from "../config.js";
import { LEVELS, NEEDS, PALETTE_ROLES, ROOM_LIGHT_LEVELS, ROOM_TYPE_VALUES, confidence, nonEmpty } from "../schemas/index.js";
import { colourName } from "./colour-names.js";

const inferred = (value) => ({
  type: "object",
  required: ["value", "confidence"],
  properties: { value, confidence, evidence: { type: "string" } },
  additionalProperties: false
});

export const environmentSchema = {
  type: "object",
  required: ["roomType", "windowType", "windowShape", "windowRegion", "palette", "materials", "styleTags", "lightLevel", "existingCovering", "needs"],
  properties: {
    roomType: inferred({ enum: ROOM_TYPE_VALUES }),
    windowType: inferred(nonEmpty),
    windowShape: inferred(nonEmpty),
    windowRegion: inferred({ $ref: "v2.region" }),
    palette: inferred({ type: "array", minItems: 1, maxItems: 8, items: { $ref: "v2.paletteColour" } }),
    materials: inferred({ type: "array", items: nonEmpty }),
    styleTags: inferred({ type: "array", items: nonEmpty }),
    lightLevel: inferred({ enum: ROOM_LIGHT_LEVELS }),
    existingCovering: inferred({ type: ["string", "null"] }),
    needs: {
      type: "object",
      required: NEEDS,
      properties: Object.fromEntries(NEEDS.map((need) => [need, inferred({ enum: LEVELS })])),
      additionalProperties: false
    },
    notes: { type: "string" }
  },
  additionalProperties: false
};

const inputSchema = {
  type: "object",
  required: ["roomPhoto"],
  properties: {
    roomPhoto: {
      type: "object",
      required: ["path", "sha256"],
      properties: { path: nonEmpty, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, roomId: { type: ["string", "null"] } }
    }
  },
  additionalProperties: false
};

export const PERCEIVE_PROMPT = `You are the perception step of an interior-design agent for window coverings.
Look only at the photo. Describe the existing environment and infer what the person likely needs.
Do not recommend products.

Return only JSON with this shape. Every field is {"value": …, "confidence": 0..1, "evidence": "what in the photo supports it"}:
{
  "roomType": one of ${JSON.stringify(ROOM_TYPE_VALUES)},
  "windowType": e.g. "double-hung", "sliding", "casement", "picture", "bay", "fixed", "unknown",
  "windowShape": e.g. "wide rectangle", "tall rectangle", "triple bank", "arched",
  "windowRegion": {"x","y","w","h"} as fractions of image width/height (0..1) for the window opening including its frame,
  "palette": 3-6 dominant room colours [{"hex": "#rrggbb", "name": "warm off-white", "role": one of ${JSON.stringify(PALETTE_ROLES)}, "weight": share of the image 0..1}],
  "materials": visible materials, e.g. ["painted drywall", "oak veneer", "carpet"],
  "styleTags": 2-5 style words, e.g. ["modern", "minimal", "warm"],
  "lightLevel": one of ${JSON.stringify(ROOM_LIGHT_LEVELS)} (natural light entering the room),
  "existingCovering": short description of any current covering, or null,
  "needs": {"privacy","blackout","glare","moisture","safety"} each one of ${JSON.stringify(LEVELS)}
}
Use low confidence when the photo does not show enough; do not guess confidently.`;

export default {
  name: "perceive",
  version: 1,
  kind: "llm",
  description:
    "Look at the room photo only and describe the existing environment: room type, window type, shape and position, " +
    "dominant palette (hex and names), materials, style tags, natural light level, any existing covering, and inferred " +
    "needs (privacy, blackout, glare, moisture, safety), each with a confidence. Use this first, before any design decision.",
  inputSchema,
  outputSchema: environmentSchema,
  fallbackDescription: "the no-model perception (k-means palette from the photo, everything else low-confidence)",

  fixtureKey: (input) => ({ photo: input.roomPhoto.sha256.slice(0, 16) }),

  async run(input, ctx) {
    const bytes = fs.readFileSync(path.resolve(ROOT_DIR, input.roomPhoto.path));
    const room = await encodeRoomImage(`data:image/jpeg;base64,${bytes.toString("base64")}`);
    const response = await ctx.providers.llm({
      blocks: [text(PERCEIVE_PROMPT), text("The room photo:"), image(room)],
      fixtureKey: this.fixtureKey(input)
    });
    return normalizeHexes(response.result);
  },

  // No-model perception. Also the baseline PERCEIVE must beat on evals/briefs.
  async baseline(input) {
    const bytes = fs.readFileSync(path.resolve(ROOT_DIR, input.roomPhoto.path));
    const clusters = await extractPalette(bytes, { clusters: 5 });
    const meanL = clusters.reduce((sum, c) => sum + c.lab.L * c.weight, 0);
    const palette = clusters.slice(0, 5).map((c) => ({
      hex: c.hex,
      name: colourName(c.lab),
      role: "other",
      weight: Math.round(c.weight * 1000) / 1000
    }));
    const unknown = (value) => ({ value, confidence: 0, evidence: "no-model baseline" });

    return {
      roomType: unknown("unknown"),
      windowType: unknown("unknown"),
      windowShape: unknown("unknown"),
      windowRegion: { value: { x: 0.2, y: 0.2, w: 0.6, h: 0.5 }, confidence: 0.1, evidence: "centre-of-frame default" },
      palette: { value: palette, confidence: 0.5, evidence: "k-means over the whole photo, blown-out glazing dropped" },
      materials: unknown([]),
      styleTags: unknown([]),
      lightLevel: {
        value: meanL > 65 ? "bright" : meanL > 45 ? "medium" : "dim",
        confidence: 0.3,
        evidence: `mean lightness ${meanL.toFixed(0)}`
      },
      existingCovering: unknown(null),
      needs: Object.fromEntries(NEEDS.map((need) => [need, unknown("medium")])),
      notes: "Produced without a model."
    };
  },

  async fallback(input, ctx) {
    return this.baseline(input, ctx);
  }
};

function normalizeHexes(result) {
  if (!Array.isArray(result?.palette?.value)) return result;
  for (const colour of result.palette.value) {
    if (typeof colour?.hex === "string") colour.hex = colour.hex.toLowerCase();
  }
  return result;
}
