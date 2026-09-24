import { GUIDELINES } from "../guidelines.js";
import { LEVELS, LIGHTNESS, ROOM_LIGHT_LEVELS, WARMTH } from "../schemas/index.js";

// PRESENT: code. Chooses what to show (2-3 proposals) and builds the cards: render,
// direction, layers, rationale linked to Brief fields, and a "What I assumed" chip
// for every Brief field that was inferred or assumed, so the person can correct it.

const listOf = (ref) => ({ type: "array", items: { $ref: ref } });

const inputSchema = {
  type: "object",
  required: ["brief", "directions", "proposals", "renders", "faithfulness", "critiques", "round", "critiqueEnabled"],
  properties: {
    brief: { $ref: "v2.brief" },
    directions: listOf("v2.direction"),
    proposals: listOf("v2.proposal"),
    renders: listOf("v2.render"),
    faithfulness: listOf("v2.faithfulness"),
    critiques: listOf("v2.critique"),
    round: { type: "integer", minimum: 1 },
    critiqueEnabled: { type: "boolean" }
  },
  additionalProperties: false
};

const LABELS = {
  roomType: "Room",
  windowType: "Window type",
  windowShape: "Window shape",
  windowRegion: "Window position",
  palette: "Room colours",
  materials: "Materials",
  styleTags: "Style",
  lightLevel: "Natural light",
  existingCovering: "Current covering",
  "needs.privacy": "Privacy need",
  "needs.blackout": "Blackout need",
  "needs.glare": "Glare need",
  "needs.moisture": "Moisture need",
  "needs.safety": "Safety need",
  "preferences.text": "Your notes",
  "preferences.warmth": "Warmth preference",
  "preferences.lightness": "Lightness preference",
  "preferences.avoidColours": "Colours to avoid"
};

const OPTIONS = {
  roomType: Object.keys(GUIDELINES.rooms),
  lightLevel: ROOM_LIGHT_LEVELS,
  "needs.privacy": LEVELS,
  "needs.blackout": LEVELS,
  "needs.glare": LEVELS,
  "needs.moisture": LEVELS,
  "needs.safety": LEVELS,
  "preferences.warmth": WARMTH,
  "preferences.lightness": LIGHTNESS
};

export default {
  name: "present",
  version: 1,
  kind: "code",
  description:
    "Assemble what to show the person: 2-3 proposals (accepted by critique first; others only if needed, clearly marked), " +
    "each with its render, direction title, products per layer and rationale linked to Brief fields, plus a correctable " +
    "'What I assumed' chip for every inferred or assumed Brief field.",
  inputSchema,
  outputSchema: { $ref: "v2.presentation" },

  async run(input, ctx) {
    return present(input, ctx);
  }
};

export function present(input, ctx) {
  const { min, max } = ctx.config.present;
  const current = input.proposals.filter((p) => p.round === input.round);
  const latestPerDirection = input.directions
    .map((d) => current.filter((p) => p.directionId === d.id).at(-1))
    .filter(Boolean);

  let chosen;
  const notes = [];
  if (!input.critiqueEnabled) {
    chosen = latestPerDirection.map((p) => ({ proposal: p, status: "unreviewed" }));
    notes.push("Critique is off: every proposal is shown unreviewed.");
  } else {
    const accepted = current.filter((p) => p.status === "accepted");
    const unreviewed = current.filter((p) => p.status === "unreviewed");
    chosen = [...accepted.map((p) => ({ proposal: p, status: "accepted" })), ...unreviewed.map((p) => ({ proposal: p, status: "unreviewed" }))];
    if (chosen.length < min) {
      // Not enough approved: show the best of the rest, clearly marked, never silently.
      const rest = latestPerDirection
        .filter((p) => p.status === "revised" && !chosen.some((c) => c.proposal.directionId === p.directionId))
        .sort((a, b) => critiqueTotal(b, input) - critiqueTotal(a, input));
      for (const p of rest) {
        if (chosen.length >= min) break;
        chosen.push({ proposal: p, status: "unapproved" });
        ctx.warn("present-unapproved", `Showing ${p.proposalId} although critique did not accept it: fewer than ${min} proposals were accepted.`);
      }
    }
    if (chosen.length < min) {
      ctx.warn("present-short", `Only ${chosen.length} proposal(s) to show this round (wanted ${min}).`);
    }
  }
  chosen = chosen.slice(0, max);

  return {
    round: input.round,
    items: chosen.map(({ proposal, status }) => card(proposal, status, input, ctx)),
    assumptions: assumptionChips(input.brief),
    notes
  };
}

function card(proposal, status, input, ctx) {
  const direction = input.directions.find((d) => d.id === proposal.directionId);
  const renders = input.renders.filter((r) => r.proposalId === proposal.proposalId);
  const faithfulRender =
    renders.filter((r) => input.faithfulness.find((f) => f.renderId === r.renderId)?.pass).at(-1) || renders.at(-1) || null;
  const critique = input.critiques.filter((c) => c.proposalId === proposal.proposalId).at(-1) || null;
  const faithfulness = faithfulRender ? input.faithfulness.find((f) => f.renderId === faithfulRender.renderId) || null : null;

  return {
    proposalId: proposal.proposalId,
    directionId: proposal.directionId,
    title: direction?.title || proposal.directionId,
    intent: direction?.intent || "",
    status,
    source: proposal.source,
    renderUrl: faithfulRender ? `/v2-renders/${encodeURIComponent(faithfulRender.imagePath)}` : null,
    visual: productCard(proposal.visual, ctx),
    functional: proposal.functional ? productCard(proposal.functional, ctx) : null,
    rationale: proposal.rationale,
    critique: critique ? { verdict: critique.verdict, reason: critique.reason, scores: critique.scores, source: critique.source } : null,
    faithfulness: faithfulness ? { deltaE: faithfulness.deltaE, pass: faithfulness.pass } : null
  };
}

function productCard(ref, ctx) {
  const v = ctx.catalog.variants.get(ref.variantId);
  return {
    productId: ref.productId,
    variantId: ref.variantId,
    name: v?.name || ref.variantId,
    category: v?.category || "unknown",
    hex: v?.hex || null,
    swatchImageUrl: v?.swatchImageUrl || null,
    productName: v?.productDisplayName || ref.productId
  };
}

function critiqueTotal(proposal, input) {
  const c = input.critiques.filter((x) => x.proposalId === proposal.proposalId).at(-1);
  return c ? Object.values(c.scores).reduce((s, v) => s + v, 0) : 0;
}

export function assumptionChips(brief) {
  const chips = [];
  const walk = (node, prefix) => {
    for (const [key, field] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (field && "source" in field) {
        if (field.source === "stated") continue;
        chips.push({
          field: path,
          label: LABELS[path] || path,
          value: field.value,
          source: field.source,
          confidence: field.confidence,
          ...(OPTIONS[path] ? { options: OPTIONS[path] } : {})
        });
      } else walk(field, path);
    }
  };
  walk(brief, "");
  // Least certain first: those are the ones most worth correcting.
  return chips.sort((a, b) => a.confidence - b.confidence || a.field.localeCompare(b.field));
}
