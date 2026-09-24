import {
  COLOUR_STRATEGIES,
  DIRECTION_LIGHT_LEVELS,
  LEVELS,
  LIGHTNESS,
  NEEDS,
  ROOM_LIGHT_LEVELS,
  ROOM_TYPE_VALUES,
  SOURCES,
  VERDICTS,
  WARMTH,
  confidence,
  hex,
  nonEmpty
} from "./common.js";

// The shared state every stage reads and writes. Stage input/output schemas in
// src/v2/stages/*.js are built from these by $ref.

// ------------------------------------------------------------------ Brief

// Every Brief field is wrapped: the value, where it came from, and how sure we are.
const field = (valueSchema) => ({
  type: "object",
  required: ["value", "source", "confidence"],
  properties: {
    value: valueSchema,
    source: { enum: SOURCES },
    confidence,
    note: { type: "string" }
  },
  additionalProperties: false
});

const level = { enum: LEVELS };

export const brief = {
  $id: "v2.brief",
  type: "object",
  required: [
    "roomType",
    "windowType",
    "windowShape",
    "windowRegion",
    "palette",
    "materials",
    "styleTags",
    "lightLevel",
    "existingCovering",
    "needs",
    "preferences"
  ],
  properties: {
    roomType: field({ enum: ROOM_TYPE_VALUES }),
    windowType: field(nonEmpty),
    windowShape: field(nonEmpty),
    windowRegion: field({ $ref: "v2.region" }),
    palette: field({ type: "array", minItems: 1, maxItems: 8, items: { $ref: "v2.paletteColour" } }),
    materials: field({ type: "array", items: nonEmpty }),
    styleTags: field({ type: "array", items: nonEmpty }),
    lightLevel: field({ enum: ROOM_LIGHT_LEVELS }),
    existingCovering: field({ type: ["string", "null"] }),
    needs: {
      type: "object",
      required: NEEDS,
      properties: Object.fromEntries(NEEDS.map((need) => [need, field(level)])),
      additionalProperties: false
    },
    preferences: {
      type: "object",
      required: ["text", "warmth", "lightness", "avoidColours"],
      properties: {
        text: field({ type: ["string", "null"] }),
        warmth: field({ enum: [...WARMTH, null] }),
        lightness: field({ enum: [...LIGHTNESS, null] }),
        avoidColours: field({ type: "array", items: nonEmpty })
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

// Paths a rationale claim or an assumption chip may point at.
export const BRIEF_FIELD_PATHS = [
  "roomType",
  "windowType",
  "windowShape",
  "windowRegion",
  "palette",
  "materials",
  "styleTags",
  "lightLevel",
  "existingCovering",
  ...NEEDS.map((need) => `needs.${need}`),
  "preferences.text",
  "preferences.warmth",
  "preferences.lightness",
  "preferences.avoidColours"
];

// ------------------------------------------------------------------ Direction

const categoryList = { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: nonEmpty };

export const direction = {
  $id: "v2.direction",
  type: "object",
  required: ["id", "title", "intent", "layers", "colourStrategy", "lightLevel", "textureNote"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9-]{1,32}$" },
    title: nonEmpty,
    intent: nonEmpty,
    layers: {
      type: "object",
      required: ["visual", "functional"],
      properties: {
        visual: categoryList,
        functional: { oneOf: [categoryList, { type: "null" }] }
      },
      additionalProperties: false
    },
    colourStrategy: { enum: COLOUR_STRATEGIES },
    lightLevel: { enum: DIRECTION_LIGHT_LEVELS },
    textureNote: nonEmpty
  },
  additionalProperties: false
};

// ------------------------------------------------------------------ Shortlist

export const candidate = {
  $id: "v2.candidate",
  type: "object",
  required: ["rank", "productId", "variantId", "category", "name", "hex", "score", "scoreParts"],
  properties: {
    rank: { type: "integer", minimum: 1 },
    productId: nonEmpty,
    variantId: nonEmpty,
    category: nonEmpty,
    name: nonEmpty,
    colorFamily: { type: ["string", "null"] },
    opacity: { type: ["string", "null"] },
    styleTags: { type: "array", items: { type: "string" } },
    hex,
    score: { type: "number" },
    scoreParts: {
      type: "object",
      required: ["colour", "style", "light", "preference"],
      properties: {
        colour: { type: "number" },
        style: { type: "number" },
        light: { type: "number" },
        preference: { type: "number" }
      },
      additionalProperties: false
    },
    swatchImageUrl: { type: ["string", "null"] }
  },
  additionalProperties: false
};

const shortlistLayer = {
  type: "object",
  required: ["categories", "candidates", "considered"],
  properties: {
    categories: { type: "array", items: nonEmpty },
    candidates: { type: "array", items: { $ref: "v2.candidate" } },
    considered: { type: "integer", minimum: 0 },
    excludedNoSwatch: { type: "integer", minimum: 0 }
  },
  additionalProperties: false
};

export const shortlist = {
  $id: "v2.shortlist",
  type: "object",
  required: ["directionId", "colourStrategy", "layers"],
  properties: {
    directionId: nonEmpty,
    colourStrategy: { enum: COLOUR_STRATEGIES },
    layers: {
      type: "object",
      required: ["visual", "functional"],
      properties: {
        visual: shortlistLayer,
        functional: { oneOf: [shortlistLayer, { type: "null" }] }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

// ------------------------------------------------------------------ Proposal

export const rationaleClaim = {
  $id: "v2.rationaleClaim",
  type: "object",
  required: ["claim", "briefFields"],
  properties: {
    claim: nonEmpty,
    briefFields: { type: "array", minItems: 1, items: nonEmpty }
  },
  additionalProperties: false
};

export const proposal = {
  $id: "v2.proposal",
  type: "object",
  required: ["proposalId", "directionId", "round", "attempt", "visual", "functional", "rationale", "source", "excluded"],
  properties: {
    proposalId: nonEmpty,
    directionId: nonEmpty,
    round: { type: "integer", minimum: 1 },
    attempt: { type: "integer", minimum: 1 },
    visual: { $ref: "v2.productRef" },
    functional: { oneOf: [{ $ref: "v2.productRef" }, { type: "null" }] },
    rationale: { type: "array", minItems: 1, items: { $ref: "v2.rationaleClaim" } },
    source: { enum: ["model", "fallback", "baseline"] },
    excluded: { type: "array", items: nonEmpty },
    status: { enum: ["proposed", "accepted", "revised", "dropped", "unreviewed"] }
  },
  additionalProperties: false
};

// ------------------------------------------------------------------ Render / critique

export const render = {
  $id: "v2.render",
  type: "object",
  required: ["renderId", "proposalId", "productId", "variantId", "attempt", "imagePath", "cacheKey", "provider", "model", "promptHash"],
  properties: {
    renderId: nonEmpty,
    proposalId: nonEmpty,
    productId: nonEmpty,
    variantId: nonEmpty,
    attempt: { type: "integer", minimum: 1 },
    imagePath: nonEmpty,
    cacheKey: nonEmpty,
    provider: nonEmpty,
    model: nonEmpty,
    promptHash: nonEmpty,
    cached: { type: "boolean" }
  },
  additionalProperties: false
};

export const faithfulness = {
  $id: "v2.faithfulness",
  type: "object",
  required: ["renderId", "proposalId", "pass", "deltaE", "threshold", "measuredHex", "swatchHex", "method"],
  properties: {
    renderId: nonEmpty,
    proposalId: nonEmpty,
    pass: { type: "boolean" },
    deltaE: { type: ["number", "null"] },
    threshold: { type: "number" },
    measuredHex: { oneOf: [hex, { type: "null" }] },
    swatchHex: { oneOf: [hex, { type: "null" }] },
    method: nonEmpty,
    note: { type: "string" }
  },
  additionalProperties: false
};

const score5 = { type: "integer", minimum: 1, maximum: 5 };

export const critique = {
  $id: "v2.critique",
  type: "object",
  required: ["proposalId", "renderId", "verdict", "scores", "reason", "source"],
  properties: {
    proposalId: nonEmpty,
    renderId: nonEmpty,
    verdict: { enum: VERDICTS },
    scores: {
      type: "object",
      required: ["harmony", "intent", "roomFit", "installed"],
      properties: { harmony: score5, intent: score5, roomFit: score5, installed: score5 },
      additionalProperties: false
    },
    reason: nonEmpty,
    revisionHint: { type: ["string", "null"] },
    source: { enum: ["model", "fallback", "baseline"] }
  },
  additionalProperties: false
};

// ------------------------------------------------------------------ Decisions and reactions

export const decision = {
  $id: "v2.decision",
  type: "object",
  required: ["policy", "decision", "reason"],
  properties: {
    policy: nonEmpty,
    decision: nonEmpty,
    reason: nonEmpty,
    round: { type: "integer" },
    directionId: { type: ["string", "null"] },
    proposalId: { type: ["string", "null"] },
    inputs: { type: "object" },
    at: { type: "string" }
  },
  additionalProperties: false
};

export const reaction = {
  $id: "v2.reaction",
  type: "object",
  required: ["kind"],
  properties: {
    reactionId: { type: "string" },
    round: { type: "integer" },
    kind: { enum: ["pick", "feedback", "edit-assumption"] },
    proposalId: { type: ["string", "null"] },
    text: { type: ["string", "null"] },
    edits: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "value"],
        properties: { field: nonEmpty, value: {} },
        additionalProperties: false
      }
    },
    at: { type: "string" }
  },
  additionalProperties: false
};

export const presentation = {
  $id: "v2.presentation",
  type: "object",
  required: ["round", "items", "assumptions"],
  properties: {
    round: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["proposalId", "directionId", "title", "status", "visual", "functional", "rationale"],
        properties: {
          proposalId: nonEmpty,
          directionId: nonEmpty,
          title: nonEmpty,
          intent: { type: "string" },
          status: { enum: ["accepted", "unapproved", "unreviewed"] },
          renderUrl: { type: ["string", "null"] },
          visual: { type: "object" },
          functional: { type: ["object", "null"] },
          rationale: { type: "array" },
          critique: { type: ["object", "null"] },
          faithfulness: { type: ["object", "null"] }
        }
      }
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "value", "source", "confidence"],
        properties: {
          field: nonEmpty,
          label: { type: "string" },
          value: {},
          source: { enum: ["inferred", "assumed"] },
          confidence,
          options: { type: "array" }
        }
      }
    },
    notes: { type: "array", items: { type: "string" } }
  }
};

