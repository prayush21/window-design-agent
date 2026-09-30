import { ROOM_TYPES } from "../guidelines.js";

// Shared vocabulary for every v2 schema. Enums live here so a stage, a fixture and
// the UI can never disagree on what "filtered" or "neutral-anchor" means.

export const SOURCES = ["stated", "inferred", "assumed"];
export const LEVELS = ["low", "medium", "high"];
export const ROOM_LIGHT_LEVELS = ["bright", "medium", "dim"];
export const DIRECTION_LIGHT_LEVELS = ["bright", "filtered", "dark"];
export const COLOUR_STRATEGIES = ["tonal", "complementary", "contrast", "neutral-anchor"];
export const VERDICTS = ["ACCEPT", "REVISE", "DROP"];
export const NEEDS = ["privacy", "blackout", "glare", "moisture", "safety"];
export const PALETTE_ROLES = ["wall", "floor", "ceiling", "trim", "furniture", "textile", "accent", "other"];
export const WARMTH = ["warm", "cool", "neutral"];
export const LIGHTNESS = ["lighter", "darker"];
export const ROOM_TYPE_VALUES = [...ROOM_TYPES, "unknown"];

export const hex = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
export const confidence = { type: "number", minimum: 0, maximum: 1 };
export const unit = { type: "number", minimum: 0, maximum: 1 };
export const nonEmpty = { type: "string", minLength: 1 };

export const region = {
  $id: "v2.region",
  type: "object",
  required: ["x", "y", "w", "h"],
  properties: { x: unit, y: unit, w: { type: "number", exclusiveMinimum: 0, maximum: 1 }, h: { type: "number", exclusiveMinimum: 0, maximum: 1 } },
  additionalProperties: false
};

export const paletteColour = {
  $id: "v2.paletteColour",
  type: "object",
  required: ["hex", "name", "role", "weight"],
  properties: {
    hex,
    name: nonEmpty,
    role: { enum: PALETTE_ROLES },
    weight: unit
  },
  additionalProperties: false
};

export const productRef = {
  $id: "v2.productRef",
  type: "object",
  required: ["productId", "variantId"],
  properties: { productId: nonEmpty, variantId: nonEmpty },
  additionalProperties: false
};

export const warning = {
  $id: "v2.warning",
  type: "object",
  required: ["code", "message"],
  properties: {
    code: nonEmpty,
    message: nonEmpty,
    stage: { type: ["string", "null"] },
    directionId: { type: ["string", "null"] },
    proposalId: { type: ["string", "null"] },
    at: { type: "string" }
  },
  additionalProperties: false
};

export const usage = {
  $id: "v2.usage",
  type: ["object", "null"],
  properties: {
    inputTokens: { type: ["number", "null"] },
    outputTokens: { type: ["number", "null"] },
    totalTokens: { type: ["number", "null"] },
    images: { type: ["number", "null"] },
    estimated: { type: "boolean" }
  }
};
