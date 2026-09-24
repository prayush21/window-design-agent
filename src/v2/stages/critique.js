import fs from "node:fs";
import path from "node:path";
import { RANKING_IMAGE_SIZES, encodeCatalogImage, encodeRoomImage } from "../../image-cache.js";
import { withCorrection } from "../correction.js";
import { image, text } from "../../providers.js";
import { ROOT_DIR } from "../config.js";
import { nonEmpty } from "../schemas/index.js";
import { briefValues } from "./plan.js";

// CRITIQUE: VLM, a separate prompt (and by default a different provider) from the
// COMPOSE step it judges. Fixed rubric, four 1-5 scores and a verdict:
// ACCEPT, REVISE (with a hint for the next variant) or DROP. It judges design,
// not colour fidelity: renders reach it only after the faithfulness check passed.

const inputSchema = {
  type: "object",
  required: ["brief", "direction", "proposal", "render", "roomPhoto"],
  properties: {
    brief: { $ref: "v2.brief" },
    direction: { $ref: "v2.direction" },
    proposal: { $ref: "v2.proposal" },
    render: { $ref: "v2.render" },
    roomPhoto: {
      type: "object",
      required: ["path", "sha256"],
      properties: { path: nonEmpty, sha256: { type: "string" }, roomId: { type: ["string", "null"] } }
    }
  },
  additionalProperties: false
};

const score = { type: "integer", minimum: 1, maximum: 5 };
export const critiqueResponseSchema = {
  type: "object",
  required: ["verdict", "scores", "reason"],
  properties: {
    verdict: { enum: ["ACCEPT", "REVISE", "DROP"] },
    scores: {
      type: "object",
      required: ["harmony", "intent", "roomFit", "installed"],
      properties: { harmony: score, intent: score, roomFit: score, installed: score },
      additionalProperties: false
    },
    reason: nonEmpty,
    revisionHint: { type: ["string", "null"] }
  },
  additionalProperties: false
};

export const RUBRIC = `Score each criterion 1-5 (5 = excellent):
- harmony: the covering's colour and texture sit well with the room's palette and materials.
- intent: the result delivers the direction's stated intent and colour strategy.
- roomFit: suits the room type and the needs in the Brief (privacy, blackout, glare, moisture, safety).
- installed: looks plausibly installed in this window (scale, placement, perspective).
Verdict:
- ACCEPT if every score is 3 or more and the proposal is worth showing the person.
- REVISE if the direction is right but this variant is not (give a one-sentence revisionHint for a better variant).
- DROP if the direction itself does not work for this room, or the result adds nothing over what the room already has.`;

export default {
  name: "critique",
  version: 1,
  kind: "llm",
  description:
    "Judge one rendered proposal against a fixed rubric (harmony with the palette, delivers the direction's intent, fits " +
    "the room type and needs, looks plausibly installed) and return ACCEPT, REVISE (with a hint for a better variant) or " +
    "DROP, with four 1-5 scores and a reason. Only for renders that passed the faithfulness check.",
  inputSchema,
  outputSchema: { $ref: "v2.critique" },
  fixtureSchema: critiqueResponseSchema,
  fallbackDescription: "no verdict (the proposal is marked unreviewed)",

  fixtureKey: (input) => ({
    photo: input.roomPhoto.sha256.slice(0, 16),
    directionId: input.direction.id,
    variantId: input.proposal.visual.variantId,
    renderAttempt: input.render.attempt
  }),

  async run(input, ctx) {
    const blocks = withCorrection(await buildBlocks(input, ctx), ctx);
    const response = await ctx.providers.llm({ blocks, fixtureKey: this.fixtureKey(input) });
    const r = response.result || {};
    return {
      proposalId: input.proposal.proposalId,
      renderId: input.render.renderId,
      verdict: r.verdict,
      scores: r.scores,
      reason: r.reason,
      revisionHint: r.revisionHint ?? null,
      source: "model"
    };
  },

  // A verdict that contradicts the rubric's own rule is not trusted.
  check(output) {
    if (output.verdict === "ACCEPT" && Object.values(output.scores).some((s) => s < 3)) {
      return [`ACCEPT with a score below 3 (${JSON.stringify(output.scores)}) contradicts the rubric`];
    }
    return [];
  },

  // No-model critic: accepts everything. The floor critique agreement must beat.
  async baseline(input) {
    return {
      proposalId: input.proposal.proposalId,
      renderId: input.render.renderId,
      verdict: "ACCEPT",
      scores: { harmony: 3, intent: 3, roomFit: 3, installed: 3 },
      reason: "No-model baseline critic: accepts every faithful render.",
      revisionHint: null,
      source: "baseline"
    };
  },

  async fallback(input) {
    return {
      proposalId: input.proposal.proposalId,
      renderId: input.render.renderId,
      verdict: "UNREVIEWED",
      scores: { harmony: 3, intent: 3, roomFit: 3, installed: 3 },
      reason: "Critique did not return a usable verdict; this proposal was not reviewed.",
      revisionHint: null,
      source: "fallback"
    };
  }
};

async function buildBlocks({ brief, direction, proposal, render, roomPhoto }, ctx) {
  const visual = ctx.catalog.variants.get(proposal.visual.variantId);
  const functional = proposal.functional ? ctx.catalog.variants.get(proposal.functional.variantId) : null;
  const roomBytes = fs.readFileSync(path.resolve(ROOT_DIR, roomPhoto.path));
  const renderBytes = fs.readFileSync(path.join(ctx.paths.renders, render.imagePath));
  const blocks = [
    text(`You are the design critic of an interior-design agent for window coverings. You did not choose this proposal; judge it.

THE BRIEF:
${JSON.stringify(briefValues(brief), null, 2)}

DIRECTION ${direction.id}: ${direction.title} — ${direction.intent}
Colour strategy ${direction.colourStrategy}, light ${direction.lightLevel}, texture: ${direction.textureNote}

PROPOSAL: visual layer ${visual?.name} (${visual?.category}); functional layer ${functional ? `${functional.name} (${functional.category}), described only, not in the render` : "none"}.
Rationale given: ${proposal.rationale.map((r) => r.claim).join(" ")}

${RUBRIC}

The first image is the room before; the second is the visual layer's swatch; the third is the render.`),
    image(await encodeRoomImage(`data:image/jpeg;base64,${roomBytes.toString("base64")}`, 1024))
  ];
  if (visual?.swatchImagePath) blocks.push(image(await encodeCatalogImage(visual.swatchImagePath, RANKING_IMAGE_SIZES.swatch)));
  blocks.push(
    image(await encodeRoomImage(`data:image/jpeg;base64,${renderBytes.toString("base64")}`, 1024)),
    text('Return only JSON: {"verdict": "ACCEPT|REVISE|DROP", "scores": {"harmony": n, "intent": n, "roomFit": n, "installed": n}, "reason": "one or two sentences", "revisionHint": "for REVISE, else null"}')
  );
  return blocks;
}
