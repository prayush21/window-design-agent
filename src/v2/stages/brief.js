import { ROOM_TYPES, roomLabel, roomNeedsProfile } from "../guidelines.js";
import { parseUserText } from "../lexicon.js";
import { LEVELS, NEEDS } from "../schemas/index.js";
import { environmentSchema } from "./perceive.js";

// BRIEF: code, no model. Merges what the person said over what PERCEIVE inferred
// and fills the gaps with explicit assumptions. Every field says where it came
// from (stated | inferred | assumed) and how sure we are.
//
// Precedence per field: stated > inferred (if confident enough) > assumed default.

export const MIN_INFERRED_CONFIDENCE = 0.35;
// When nothing identifies the room, assume the most general guideline room.
export const DEFAULT_ROOM_TYPE = "living-room";

const inputSchema = {
  type: "object",
  required: ["environment", "userInput"],
  properties: {
    environment: environmentSchema,
    userInput: {
      type: "object",
      properties: {
        text: { type: ["string", "null"] },
        roomType: { type: ["string", "null"] },
        references: { type: "array" }
      }
    }
  },
  additionalProperties: false
};

export default {
  name: "brief",
  version: 1,
  kind: "code",
  description:
    "Merge the person's stated input (free-text preferences, an explicit room type) over the perceived environment and " +
    "fill any gaps with explicit assumptions. Returns the Brief: the shared state every later stage reads. Every field " +
    "carries source (stated, inferred or assumed) and confidence.",
  inputSchema,
  outputSchema: { $ref: "v2.brief" },

  async run(input) {
    return buildBrief(input.environment, input.userInput || {});
  }
};

export function buildBrief(env, userInput) {
  const parsed = parseUserText(userInput.text);
  const statedRoom = ROOM_TYPES.includes(userInput.roomType) ? userInput.roomType : parsed.roomType;

  const roomType = statedRoom
    ? stated(statedRoom, userInput.roomType ? "chosen by you" : "from your note")
    : env.roomType.value !== "unknown" && env.roomType.confidence >= MIN_INFERRED_CONFIDENCE
      ? inferredField(env.roomType)
      : assumed(DEFAULT_ROOM_TYPE, 0.2, `room type unclear in the photo; assumed ${roomLabel(DEFAULT_ROOM_TYPE)}`);

  const profile = roomNeedsProfile(roomType.value);
  const needs = {};
  for (const need of NEEDS) {
    if (parsed.needs[need]) {
      needs[need] = stated(parsed.needs[need], "from your note");
      continue;
    }
    const perceived = env.needs[need];
    const profileLevel = profile?.[need];
    if (perceived.confidence >= MIN_INFERRED_CONFIDENCE) {
      // A stated room type is stronger evidence than a guess from one photo: raise
      // a need to the room's guideline level, never lower it.
      if (roomType.source === "stated" && profileLevel && rank(profileLevel) > rank(perceived.value)) {
        needs[need] = assumed(profileLevel, 0.6, `raised to the ${roomLabel(roomType.value)} guideline level`);
      } else {
        needs[need] = inferredField(perceived);
      }
    } else {
      needs[need] = assumed(profileLevel || "medium", 0.4, profileLevel ? `${roomLabel(roomType.value)} guideline default` : "no evidence either way");
    }
  }

  const styleTags = unionField(env.styleTags, parsed.styleTags);

  return {
    roomType,
    windowType: fromEnv(env.windowType, "unknown", "window type not visible"),
    windowShape: fromEnv(env.windowShape, "rectangle", "assumed a plain rectangular window"),
    windowRegion: fromEnv(env.windowRegion, { x: 0.2, y: 0.2, w: 0.6, h: 0.5 }, "window position unclear; assumed centre of frame"),
    palette: env.palette.value.length > 0
      ? { value: env.palette.value, source: "inferred", confidence: env.palette.confidence }
      : assumed([{ hex: "#f2efe9", name: "warm off-white", role: "wall", weight: 1 }], 0.2, "no palette found; assumed a warm off-white wall"),
    materials: fromEnv(env.materials, [], "no materials identified"),
    styleTags,
    lightLevel: fromEnv(env.lightLevel, "medium", "light level unclear"),
    existingCovering: fromEnv(env.existingCovering, null, "no covering identified"),
    needs,
    preferences: {
      text: userInput.text ? stated(userInput.text) : assumed(null, 1, "no preferences given"),
      warmth: parsed.warmth ? stated(parsed.warmth, "from your note") : assumed(null, 1, "no warmth preference given"),
      lightness: parsed.lightness ? stated(parsed.lightness, "from your note") : assumed(null, 1, "no lightness preference given"),
      avoidColours: parsed.avoidColours.length > 0 ? stated(parsed.avoidColours, "from your note") : assumed([], 1, "nothing to avoid given")
    }
  };
}

const stated = (value, note) => ({ value, source: "stated", confidence: 1, ...(note ? { note } : {}) });
const assumed = (value, confidence, note) => ({ value, source: "assumed", confidence, note });
const inferredField = (field) => ({
  value: field.value,
  source: "inferred",
  confidence: field.confidence,
  ...(field.evidence ? { note: field.evidence } : {})
});

function fromEnv(field, fallbackValue, note) {
  const unknown = field.value === "unknown" || field.value === null || (Array.isArray(field.value) && field.value.length === 0);
  if (field.confidence >= MIN_INFERRED_CONFIDENCE && !unknown) return inferredField(field);
  // A confident "none" (e.g. no existing covering) is still an inference.
  if (field.confidence >= MIN_INFERRED_CONFIDENCE && field.value === null) return inferredField(field);
  return assumed(fallbackValue, 0.2, note);
}

function unionField(envField, statedTags) {
  if (statedTags.length > 0) {
    const inferredTags = envField.confidence >= MIN_INFERRED_CONFIDENCE ? envField.value : [];
    return { value: [...new Set([...statedTags, ...inferredTags])], source: "stated", confidence: 1, note: "your words first, then what the photo suggests" };
  }
  return fromEnv(envField, [], "no style identified");
}

function rank(level) {
  return LEVELS.indexOf(level);
}
