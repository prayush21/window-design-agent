import fs from "node:fs";
import path from "node:path";
import { RANKING_IMAGE_SIZES, encodeCatalogImage, encodeRoomImage } from "../../image-cache.js";
import { image, text } from "../../providers.js";
import { ROOT_DIR } from "../config.js";
import { BRIEF_FIELD_PATHS, nonEmpty } from "../schemas/index.js";
import { briefValues } from "./plan.js";

// COMPOSE: VLM. Sees only this direction's shortlist (with swatches) and the room,
// and picks one visual variant and, if the direction has one, one functional
// variant, with a rationale whose claims point at Brief fields. Every ID is checked
// against the shortlist in code.

const inputSchema = {
  type: "object",
  required: ["brief", "direction", "shortlist", "roomPhoto", "round", "attempt"],
  properties: {
    brief: { $ref: "v2.brief" },
    direction: { $ref: "v2.direction" },
    shortlist: { $ref: "v2.shortlist" },
    roomPhoto: {
      type: "object",
      required: ["path", "sha256"],
      properties: { path: nonEmpty, sha256: { type: "string" }, roomId: { type: ["string", "null"] } }
    },
    round: { type: "integer", minimum: 1 },
    attempt: { type: "integer", minimum: 1 },
    exclude: { type: "array", items: nonEmpty },
    feedback: { type: ["string", "null"] },
    critiqueHint: { type: ["string", "null"] }
  },
  additionalProperties: false
};

// What the model returns; the stage wraps it into a full Proposal.
export const composeResponseSchema = {
  type: "object",
  required: ["directionId", "visual", "functional", "rationale"],
  properties: {
    directionId: nonEmpty,
    visual: { $ref: "v2.productRef" },
    functional: { oneOf: [{ $ref: "v2.productRef" }, { type: "null" }] },
    rationale: { type: "array", minItems: 1, maxItems: 6, items: { $ref: "v2.rationaleClaim" } }
  },
  additionalProperties: false
};

export default {
  name: "compose",
  version: 1,
  kind: "llm",
  description:
    "For one design direction, choose one visual-layer variant (and one functional-layer variant if the direction has a " +
    "functional layer) from that direction's shortlist only, looking at the swatches and the room photo. Returns a " +
    "proposal with a rationale: each claim cites the Brief fields it rests on. Variants in `exclude` must not be chosen.",
  inputSchema,
  outputSchema: { $ref: "v2.proposal" },
  fixtureSchema: composeResponseSchema,
  fallbackDescription: "RETRIEVE's top-ranked allowed variant for each layer",

  fixtureKey: (input) => ({
    photo: input.roomPhoto.sha256.slice(0, 16),
    roomType: input.brief.roomType.value,
    directionId: input.direction.id,
    exclude: [...(input.exclude || [])].sort(),
    preferences: input.brief.preferences.text.value,
    feedback: input.feedback || null
  }),

  async run(input, ctx) {
    const blocks = await buildBlocks(input, ctx);
    const response = await ctx.providers.llm({ blocks, fixtureKey: this.fixtureKey(input) });
    return toProposal(response.result, input, "model");
  },

  check(output, input) {
    return checkProposal(output, input);
  },

  // Unknown Brief field paths in a rationale are dropped; a wrong product ID is not
  // repairable here (that is what retry and fallback are for).
  repair(output, input) {
    if (!output?.visual || !Array.isArray(output.rationale)) return null;
    if (idErrors(output, input).length > 0) return null;
    const notes = [];
    const rationale = output.rationale
      .map((claim) => {
        const fields = (claim.briefFields || []).filter((f) => BRIEF_FIELD_PATHS.includes(f));
        if (fields.length !== (claim.briefFields || []).length) notes.push(`dropped unknown Brief fields from "${claim.claim}"`);
        return { ...claim, briefFields: fields };
      })
      .filter((claim) => claim.briefFields.length > 0);
    if (rationale.length === 0) return null;
    return notes.length ? { output: { ...output, rationale }, notes } : null;
  },

  async baseline(input) {
    return retrievalPick(input, "baseline");
  },

  async fallback(input) {
    return retrievalPick(input, "fallback");
  }
};

export function toProposal(result, input, source) {
  return {
    proposalId: `r${input.round}-${input.direction.id}-a${input.attempt}`,
    directionId: result?.directionId,
    round: input.round,
    attempt: input.attempt,
    visual: result?.visual,
    functional: result?.functional ?? null,
    rationale: result?.rationale,
    source,
    excluded: [...(input.exclude || [])],
    status: "proposed"
  };
}

function checkProposal(output, input) {
  const errors = idErrors(output, input);
  if (output.directionId !== input.direction.id) errors.push(`directionId ${output.directionId} is not ${input.direction.id}`);
  for (const claim of output.rationale || []) {
    for (const field of claim.briefFields) {
      if (!BRIEF_FIELD_PATHS.includes(field)) errors.push(`rationale cites unknown Brief field "${field}"`);
    }
  }
  return errors;
}

function idErrors(output, input) {
  const errors = [];
  const excluded = new Set(input.exclude || []);
  const inLayer = (layer, ref) =>
    input.shortlist.layers[layer]?.candidates.some((c) => c.productId === ref?.productId && c.variantId === ref?.variantId);

  if (!inLayer("visual", output.visual)) errors.push(`visual ${output.visual?.productId}/${output.visual?.variantId} is not in the visual shortlist`);
  else if (excluded.has(output.visual.variantId)) errors.push(`visual ${output.visual.variantId} was excluded`);

  const wantsFunctional = Boolean(input.shortlist.layers.functional);
  if (wantsFunctional && !output.functional) errors.push("the direction has a functional layer but no functional variant was chosen");
  if (!wantsFunctional && output.functional) errors.push("the direction has no functional layer");
  if (wantsFunctional && output.functional && !inLayer("functional", output.functional)) {
    errors.push(`functional ${output.functional.productId}/${output.functional.variantId} is not in the functional shortlist`);
  }
  return errors;
}

function retrievalPick(input, source) {
  const excluded = new Set(input.exclude || []);
  const top = (layer) => input.shortlist.layers[layer]?.candidates.find((c) => !excluded.has(c.variantId)) || null;
  const visual = top("visual");
  const functional = top("functional");
  if (!visual) throw Object.assign(new Error("No visual candidate left in the shortlist."), { fatal: false });

  const rationale = [
    {
      claim: `Highest RETRIEVE score for the ${input.direction.colourStrategy} colour strategy (colour ${visual.scoreParts.colour.toFixed(2)}).`,
      briefFields: ["palette"]
    },
    { claim: `Opacity fits the direction's ${input.direction.lightLevel} light level.`, briefFields: ["lightLevel"] }
  ];
  if (visual.scoreParts.style > 0.5) rationale.push({ claim: "Style tags overlap the room's.", briefFields: ["styleTags"] });

  return toProposal(
    {
      directionId: input.direction.id,
      visual: { productId: visual.productId, variantId: visual.variantId },
      functional: functional ? { productId: functional.productId, variantId: functional.variantId } : null,
      rationale
    },
    input,
    source
  );
}

async function buildBlocks({ brief, direction, shortlist, roomPhoto, exclude = [], feedback, critiqueHint }, ctx) {
  const excluded = new Set(exclude);
  const blocks = [
    text(`You are the composition step of an interior-design agent for window coverings.
Choose products for ONE design direction, only from the candidates listed below.

DIRECTION ${direction.id}: ${direction.title}
Intent: ${direction.intent}
Colour strategy: ${direction.colourStrategy} · light level: ${direction.lightLevel} · texture: ${direction.textureNote}

THE BRIEF (value, source, confidence):
${JSON.stringify(briefValues(brief), null, 2)}
${feedback ? `\nThe person said about an earlier proposal for this direction: "${feedback}". Respond to it.` : ""}
${excluded.size ? `\nAlready tried and rejected, do not choose: ${[...excluded].join(", ")}.` : ""}
${critiqueHint ? `\nThe design critic said about the last pick: "${critiqueHint}"` : ""}

Each candidate below is a text line followed by its swatch image. The swatch is the source of truth for colour and texture.`)
  ];

  for (const layer of ["visual", "functional"]) {
    const l = shortlist.layers[layer];
    if (!l) continue;
    blocks.push(text(`=== ${layer.toUpperCase()} LAYER CANDIDATES (${l.categories.join(", ")}) ===`));
    for (const c of l.candidates) {
      if (excluded.has(c.variantId)) continue;
      blocks.push(
        text(`${layer} candidate: productId ${c.productId}, variantId ${c.variantId}, "${c.name}", ${c.category}, colour family ${c.colorFamily ?? "unknown"}, opacity ${c.opacity ?? "unknown"}, style ${c.styleTags?.join("/") || "unknown"}`)
      );
      const swatch = ctx.catalog.variants.get(c.variantId)?.swatchImagePath;
      if (swatch) blocks.push(image(await encodeCatalogImage(swatch, RANKING_IMAGE_SIZES.swatch)));
    }
  }

  const bytes = fs.readFileSync(path.resolve(ROOT_DIR, roomPhoto.path));
  blocks.push(
    text(`Return only JSON:
{"directionId": "${direction.id}",
 "visual": {"productId": "...", "variantId": "..."},
 "functional": ${shortlist.layers.functional ? '{"productId": "...", "variantId": "..."}' : "null"},
 "rationale": [{"claim": "one sentence", "briefFields": ["palette", "needs.privacy", ...]}]}
briefFields must be from: ${BRIEF_FIELD_PATHS.join(", ")}.
The last image is the room.`),
    image(await encodeRoomImage(`data:image/jpeg;base64,${bytes.toString("base64")}`))
  );
  return blocks;
}
