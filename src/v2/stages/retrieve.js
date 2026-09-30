import { roomLayers } from "../guidelines.js";
import { colourScore, lightScore, preferenceScore, preparePalette, styleScore } from "../scoring.js";
import { nonEmpty } from "../schemas/index.js";

// RETRIEVE: code, no model. For one direction, filter the catalog to the
// direction's categories (which must be allowed for the room), score each variant
// against the Brief, and keep a small, diverse shortlist per layer.

const inputSchema = {
  type: "object",
  required: ["brief", "direction"],
  properties: {
    brief: { $ref: "v2.brief" },
    direction: { $ref: "v2.direction" },
    exclude: { type: "array", items: nonEmpty }
  },
  additionalProperties: false
};

export default {
  name: "retrieve",
  version: 1,
  kind: "code",
  description:
    "For one design direction, filter the catalog to the direction's categories for each layer, score every variant " +
    "against the Brief (palette distance under the direction's colour strategy, style-tag overlap, light fit, stated " +
    "preferences) and return a shortlist of 5-8 variants per layer with at most 2 per product. Deterministic; no model.",
  inputSchema,
  outputSchema: { $ref: "v2.shortlist" },

  async run(input, ctx) {
    return retrieve(input, ctx);
  },

  check(output, input) {
    const errors = [];
    const room = input.brief.roomType.value;
    for (const layer of ["visual", "functional"]) {
      const shortlistLayer = output.layers[layer];
      if (!shortlistLayer) continue;
      for (const c of shortlistLayer.candidates) {
        if (!roomLayers(room)?.[layer]?.includes(c.category)) errors.push(`${layer} candidate ${c.variantId} is in disallowed category ${c.category}`);
      }
    }
    return errors;
  }
};

export function retrieve({ brief, direction, exclude = [] }, ctx) {
  const settings = ctx.config.retrieve;
  const room = brief.roomType.value;
  const allowed = roomLayers(room);
  const palette = preparePalette(brief.palette.value);
  const briefTags = [...brief.styleTags.value, ...brief.materials.value];
  const excluded = new Set(exclude);

  const layers = {};
  for (const layer of ["visual", "functional"]) {
    const requested = direction.layers[layer];
    if (!requested) {
      layers[layer] = null;
      continue;
    }

    // Never trust the direction alone: a category outside the room's guideline list
    // is dropped here too, with a warning.
    const categories = requested.filter((category) => allowed?.[layer]?.includes(category));
    for (const category of requested) {
      if (!categories.includes(category)) {
        ctx.warn("disallowed-category", `RETRIEVE ignored ${category}: not allowed for the ${layer} layer in a ${room}.`);
      }
    }

    const targetLight = layer === "visual" ? direction.lightLevel : functionalLight(brief, direction);
    const scored = [];
    let considered = 0;
    let excludedNoSwatch = 0;

    for (const variant of ctx.catalog.variants.values()) {
      if (!categories.includes(variant.category)) continue;
      considered += 1;
      if (excluded.has(variant.variantId)) continue;
      // No swatch → no defensible colour. Excluded and counted, never guessed.
      if (!variant.lab) {
        excludedNoSwatch += 1;
        continue;
      }

      const parts = {
        colour: colourScore(direction.colourStrategy, variant.lab, palette),
        style: styleScore(briefTags, variant.styleTags),
        light: lightScore(targetLight, variant.opacity),
        preference: preferenceScore(brief.preferences, variant, variant.lab, palette.dominant.lab)
      };
      const w = settings.weights;
      const score = w.colour * parts.colour + w.style * parts.style + w.light * parts.light + w.preference * parts.preference;
      scored.push({ variant, parts, score });
    }

    scored.sort((a, b) => b.score - a.score || a.variant.variantId.localeCompare(b.variant.variantId));
    const picked = diversify(scored, categories, settings);

    if (picked.length < settings.minPerLayer) {
      ctx.warn(
        "short-shortlist",
        `RETRIEVE found only ${picked.length} ${layer} variants for direction ${direction.id} (wanted ${settings.minPerLayer}).`
      );
    }

    layers[layer] = {
      categories,
      considered,
      excludedNoSwatch,
      candidates: picked.map((entry, index) => ({
        rank: index + 1,
        productId: entry.variant.productId,
        variantId: entry.variant.variantId,
        category: entry.variant.category,
        name: entry.variant.name,
        colorFamily: entry.variant.colorFamily,
        opacity: entry.variant.opacity,
        styleTags: entry.variant.styleTags,
        hex: entry.variant.hex,
        score: round(entry.score),
        scoreParts: Object.fromEntries(Object.entries(entry.parts).map(([k, v]) => [k, round(v)])),
        swatchImageUrl: entry.variant.swatchImageUrl
      }))
    };
  }

  return { directionId: direction.id, colourStrategy: direction.colourStrategy, layers };
}

// At most maxPerProduct variants per product; and when a layer spans several
// categories, each category's best variant is guaranteed a place.
function diversify(scored, categories, { maxPerLayer, maxPerProduct }) {
  const perProduct = new Map();
  const picked = [];
  const take = (entry) => {
    const count = perProduct.get(entry.variant.productId) || 0;
    if (count >= maxPerProduct || picked.includes(entry)) return false;
    perProduct.set(entry.variant.productId, count + 1);
    picked.push(entry);
    return true;
  };

  for (const category of categories) {
    const best = scored.find((entry) => entry.variant.category === category);
    if (best && picked.length < maxPerLayer) take(best);
  }
  for (const entry of scored) {
    if (picked.length >= maxPerLayer) break;
    take(entry);
  }
  return picked.sort((a, b) => b.score - a.score || a.variant.variantId.localeCompare(b.variant.variantId));
}

// The functional layer serves the room's needs first, the direction's mood second.
function functionalLight(brief, direction) {
  if (brief.needs.blackout.value === "high") return "dark";
  if (brief.needs.glare.value === "high" || brief.needs.privacy.value === "high") return "filtered";
  return direction.lightLevel === "dark" ? "dark" : "filtered";
}

/** How many variants a set of categories can supply under the per-product cap. */
export function layerCapacity(catalog, categories, maxPerProduct) {
  const perProduct = new Map();
  for (const variant of catalog.variants.values()) {
    if (!categories.includes(variant.category) || !variant.lab) continue;
    perProduct.set(variant.productId, Math.min(maxPerProduct, (perProduct.get(variant.productId) || 0) + 1));
  }
  return [...perProduct.values()].reduce((sum, n) => sum + n, 0);
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
