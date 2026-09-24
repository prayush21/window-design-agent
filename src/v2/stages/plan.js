import { text } from "../../providers.js";
import { GUIDELINES, roomLabel, roomLayers, unmappedFor } from "../guidelines.js";
import { layerCapacity } from "./retrieve.js";

// PLAN: text-only LLM. Three deliberately different design directions for the
// Brief, each naming which categories play the visual and functional layers.
// Code enforces what the model is asked to respect: allowed categories, exactly
// three directions, pairwise difference on at least two axes, and that the catalog
// can actually supply a shortlist for every layer.

const inputSchema = {
  type: "object",
  required: ["brief"],
  properties: {
    brief: { $ref: "v2.brief" },
    previousDirections: { type: "array", items: { $ref: "v2.direction" } }
  },
  additionalProperties: false
};

const outputSchema = {
  type: "object",
  required: ["directions"],
  properties: { directions: { type: "array", minItems: 3, maxItems: 3, items: { $ref: "v2.direction" } } },
  additionalProperties: false
};

export const MIN_AXIS_DIFFERENCES = 2;

export default {
  name: "plan",
  version: 1,
  kind: "llm",
  description:
    "Given the Brief, propose exactly 3 design directions. Each has a title, an intent, a visual layer and an optional " +
    "functional layer (lists of catalog categories allowed for the room type), a colour strategy (tonal, complementary, " +
    "contrast, neutral-anchor), a light level (bright, filtered, dark) and a texture note. Directions must differ on at " +
    "least two of: visual category, colour strategy, light level.",
  inputSchema,
  outputSchema,
  fallbackDescription: "the deterministic planner (three templates over the allowed categories)",

  fixtureKey: (input) => planFixtureKey(input),

  async run(input, ctx) {
    const response = await ctx.providers.llm({ blocks: [text(buildPrompt(input, ctx))], fixtureKey: this.fixtureKey(input) });
    return response.result;
  },

  check(output, input, ctx) {
    const errors = checkDirections(output.directions, input.brief, ctx);
    const used = new Set((input.previousDirections || []).map((d) => d.id));
    for (const d of output.directions) if (used.has(d.id)) errors.push(`direction id ${d.id} was already used in an earlier round`);
    return errors;
  },

  repair(output, input, errors, ctx) {
    if (!Array.isArray(output?.directions) || output.directions.length !== 3) return null;
    const notes = [];
    const room = input.brief.roomType.value;
    const layers = roomLayers(room);
    const settings = ctx.config.retrieve;
    const directions = structuredClone(output.directions);

    for (const direction of directions) {
      if (!direction?.layers) return null;
      const visual = (direction.layers.visual || []).filter((c) => layers.visual.includes(c));
      if (visual.length !== (direction.layers.visual || []).length) {
        notes.push(`removed disallowed visual categories from ${direction.id}: ${(direction.layers.visual || []).filter((c) => !layers.visual.includes(c)).join(", ")}`);
      }
      direction.layers.visual = topUp(visual, layers.visual, ctx.catalog, settings, notes, direction.id, "visual");

      if (direction.layers.functional) {
        if (!layers.functional) {
          notes.push(`${direction.id}: a ${roomLabel(room)} has no functional layer; set it to null`);
          direction.layers.functional = null;
        } else {
          const functional = direction.layers.functional.filter((c) => layers.functional.includes(c));
          if (functional.length !== direction.layers.functional.length) {
            notes.push(`removed disallowed functional categories from ${direction.id}: ${direction.layers.functional.filter((c) => !layers.functional.includes(c)).join(", ")}`);
          }
          direction.layers.functional = functional.length === 0 ? null : topUp(functional, layers.functional, ctx.catalog, settings, notes, direction.id, "functional");
        }
      }
    }
    return notes.length > 0 ? { output: { directions }, notes } : null;
  },

  // The no-model planner: also the baseline PLAN must beat on diversity and on
  // downstream critique/preference.
  async baseline(input, ctx) {
    return { directions: templateDirections(input.brief, ctx) };
  },

  async fallback(input, ctx) {
    return this.baseline(input, ctx);
  }
};

export function planFixtureKey({ brief, previousDirections = [] }) {
  return {
    roomType: brief.roomType.value,
    palette: brief.palette.value.map((c) => c.hex),
    needs: Object.fromEntries(Object.entries(brief.needs).map(([k, v]) => [k, v.value])),
    preferences: brief.preferences.text.value,
    previous: previousDirections.map((d) => d.id)
  };
}

export function checkDirections(directions, brief, ctx) {
  const errors = [];
  const room = brief.roomType.value;
  const layers = roomLayers(room);
  if (!layers) return [`no guideline entry for room type ${room}`];
  const { minPerLayer, maxPerProduct } = ctx.config.retrieve;

  const ids = new Set();
  for (const d of directions) {
    if (ids.has(d.id)) errors.push(`duplicate direction id ${d.id}`);
    ids.add(d.id);

    for (const c of d.layers.visual) {
      if (!layers.visual.includes(c)) errors.push(`${d.id}: visual category "${c}" is not allowed for a ${roomLabel(room)}`);
    }
    if (d.layers.functional) {
      if (!layers.functional) errors.push(`${d.id}: a ${roomLabel(room)} has no functional layer`);
      else {
        for (const c of d.layers.functional) {
          if (!layers.functional.includes(c)) errors.push(`${d.id}: functional category "${c}" is not allowed for a ${roomLabel(room)}`);
        }
      }
    }

    for (const layer of ["visual", "functional"]) {
      const categories = d.layers[layer];
      if (!categories) continue;
      const capacity = layerCapacity(ctx.catalog, categories, maxPerProduct);
      if (capacity < minPerLayer) {
        errors.push(`${d.id}: ${layer} categories ${categories.join(", ")} can supply only ${capacity} variants (need ${minPerLayer})`);
      }
    }
  }

  for (let i = 0; i < directions.length; i += 1) {
    for (let j = i + 1; j < directions.length; j += 1) {
      const diff = axisDifferences(directions[i], directions[j]);
      if (diff.count < MIN_AXIS_DIFFERENCES) {
        errors.push(`${directions[i].id} and ${directions[j].id} differ on ${diff.count} axis (${diff.axes.join(", ") || "none"}); need ${MIN_AXIS_DIFFERENCES}`);
      }
    }
  }
  return errors;
}

export function axisDifferences(a, b) {
  const axes = [];
  const sameCategories = [...a.layers.visual].sort().join("|") === [...b.layers.visual].sort().join("|");
  if (!sameCategories) axes.push("category");
  if (a.colourStrategy !== b.colourStrategy) axes.push("colourStrategy");
  if (a.lightLevel !== b.lightLevel) axes.push("lightLevel");
  return { count: axes.length, axes };
}

function topUp(categories, allowed, catalog, settings, notes, id, layer) {
  const result = [...categories];
  const byCapacity = [...allowed].sort((a, b) => layerCapacity(catalog, [b], settings.maxPerProduct) - layerCapacity(catalog, [a], settings.maxPerProduct));
  for (const extra of byCapacity) {
    if (result.length > 0 && layerCapacity(catalog, result, settings.maxPerProduct) >= settings.minPerLayer) break;
    if (result.length >= 4) break;
    if (!result.includes(extra)) {
      result.push(extra);
      notes.push(`${id}: added ${extra} to the ${layer} layer so the catalog can supply a shortlist`);
    }
  }
  return result;
}

function templateDirections(brief, ctx) {
  const room = brief.roomType.value;
  const layers = roomLayers(room);
  const { maxPerProduct, minPerLayer } = ctx.config.retrieve;
  const capacity = (cats) => layerCapacity(ctx.catalog, cats, maxPerProduct);

  const visualOrder = [...layers.visual].sort((a, b) => capacity([b]) - capacity([a]) || a.localeCompare(b));
  const needsDark = brief.needs.blackout.value === "high";
  const lights = needsDark ? ["dark", "filtered", "bright"] : brief.needs.glare.value === "high" ? ["filtered", "dark", "bright"] : ["filtered", "bright", "dark"];
  const strategies = ["tonal", "neutral-anchor", "contrast"];
  const titles = {
    tonal: "Tonal and quiet",
    "neutral-anchor": "Neutral anchor",
    contrast: "Considered contrast"
  };
  const intents = {
    tonal: "Blend the covering into the room's existing colours so the window reads as part of the wall.",
    "neutral-anchor": "Ground the room with a low-chroma covering close to the wall's lightness.",
    contrast: "Frame the window with a covering that stands apart from the walls without clashing."
  };

  const pickVisual = (index) => {
    const start = visualOrder[index % visualOrder.length];
    const cats = [start];
    for (const extra of visualOrder) {
      if (capacity(cats) >= minPerLayer) break;
      if (!cats.includes(extra)) cats.push(extra);
    }
    return cats;
  };

  const pickFunctional = () => {
    if (!layers.functional) return null;
    const preferred = needsDark ? layers.functional.filter((c) => /Blackout/.test(c)) : [];
    const order = [...preferred, ...layers.functional.filter((c) => !preferred.includes(c))];
    const cats = [order[0]];
    for (const extra of order) {
      if (capacity(cats) >= minPerLayer) break;
      if (!cats.includes(extra)) cats.push(extra);
    }
    return cats;
  };

  return strategies.map((strategy, index) => ({
    id: `d${index + 1}`,
    title: titles[strategy],
    intent: intents[strategy],
    layers: { visual: pickVisual(index), functional: pickFunctional() },
    colourStrategy: strategy,
    lightLevel: lights[index],
    textureNote: "Texture not chosen by the no-model planner; defer to the swatch."
  }));
}

function buildPrompt({ brief, previousDirections = [] }, ctx) {
  const room = brief.roomType.value;
  const layers = roomLayers(room);
  const { maxPerProduct } = ctx.config.retrieve;
  const describe = (cats) =>
    cats.map((c) => `  - ${c} (${layerCapacity(ctx.catalog, [c], maxPerProduct)} variants available)`).join("\n");
  const core = GUIDELINES.rooms[room]?.coreNeeds || [];
  const unavailable = unmappedFor(room);

  return `You are the planning step of an interior-design agent for window coverings.
Propose exactly 3 design directions for this room. Do not pick products; later steps do that.

THE BRIEF (each field has a value, a source — stated by the person, inferred from the photo, or assumed — and a confidence):
${JSON.stringify(briefValues(brief), null, 2)}

Room type: ${roomLabel(room)}. Guideline core needs: ${core.join("; ") || "none listed"}.

Allowed VISUAL-layer categories (the covering that defines the look):
${describe(layers.visual)}
${layers.functional ? `Allowed FUNCTIONAL-layer categories (a second covering for light or privacy control; may be null):\n${describe(layers.functional)}` : "This room type has a single layer: set layers.functional to null."}
${unavailable.length > 0 ? `The guidelines also name ${unavailable.join(", ")}, which the catalog does not carry. Do not use them.` : ""}

Colour strategies: tonal (blend with the room's dominant colours), complementary (opposite hue to the room's accent),
contrast (clearly distinct but not clashing), neutral-anchor (low chroma near the wall's lightness).
Light levels: bright (let light through), filtered (soften), dark (block).

Rules:
- Use only the allowed categories, spelled exactly. Each layer lists 1-4 categories.
- Every pair of directions must differ on at least two of: visual categories, colourStrategy, lightLevel.
- Respect stated fields over inferred ones and inferred over assumed ones.
${previousDirections.length > 0 ? `- The person has seen these directions already; propose new ones that respond to their feedback:\n${previousDirections.map((d) => `  ${d.id}: ${d.title} (${d.colourStrategy}, ${d.lightLevel}, ${d.layers.visual.join("/")})`).join("\n")}` : ""}

Return only JSON: {"directions": [{"id": "d1", "title": "...", "intent": "one sentence", "layers": {"visual": ["..."], "functional": ["..."] or null}, "colourStrategy": "...", "lightLevel": "...", "textureNote": "..."}, ...]}
Use ids ${previousDirections.length > 0 ? `that were not used before (e.g. ${nextIds(previousDirections).join(", ")})` : "d1, d2, d3"}.`;
}

function nextIds(previous) {
  const max = Math.max(0, ...previous.map((d) => Number(/^d(\d+)$/.exec(d.id)?.[1] || 0)));
  return [1, 2, 3].map((n) => `d${max + n}`);
}

export function briefValues(brief) {
  const out = {};
  for (const [key, field] of Object.entries(brief)) {
    if (field && "value" in field) out[key] = { value: field.value, source: field.source, confidence: field.confidence };
    else out[key] = briefValues(field);
  }
  return out;
}

