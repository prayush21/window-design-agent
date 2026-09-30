import { roomLabel, roomNeedsProfile } from "../guidelines.js";
import { parseUserText } from "../lexicon.js";
import { BRIEF_FIELD_PATHS, LEVELS, NEEDS, nonEmpty } from "../schemas/index.js";

// REACT: code. Applies the person's reaction to the Brief: a pick (no change), an
// edited assumption chip (the field becomes `stated`), or free-text feedback read
// by the lexicon. Returns the new Brief and the list of changed fields, which the
// re-entry policy uses to decide where the workflow resumes.

const inputSchema = {
  type: "object",
  required: ["brief", "reaction"],
  properties: {
    brief: { $ref: "v2.brief" },
    reaction: { $ref: "v2.reaction" },
    proposals: { type: "array", items: { $ref: "v2.proposal" } }
  },
  additionalProperties: false
};

const outputSchema = {
  type: "object",
  required: ["brief", "changes", "targetDirectionId", "unparsed"],
  properties: {
    brief: { $ref: "v2.brief" },
    changes: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "to", "source"],
        properties: { field: nonEmpty, from: {}, to: {}, source: { enum: ["stated", "assumed"] }, note: { type: "string" } }
      }
    },
    targetDirectionId: { type: ["string", "null"] },
    unparsed: { type: ["string", "null"] }
  },
  additionalProperties: false
};

export default {
  name: "react",
  version: 1,
  kind: "code",
  description:
    "Apply the person's reaction to the Brief: a pick of one proposal, an edited assumption (the field becomes stated), " +
    "or free-text feedback such as 'warmer', 'no blue' or 'this is a nursery'. Returns the updated Brief, the fields that " +
    "changed, the direction the reaction was about (if any) and any text it could not turn into a field.",
  inputSchema,
  outputSchema,

  async run(input) {
    return applyReaction(input);
  },

  check(output, input) {
    const errors = [];
    const { reaction, proposals = [] } = input;
    if (reaction.proposalId && !proposals.some((p) => p.proposalId === reaction.proposalId)) {
      errors.push(`reaction names unknown proposal "${reaction.proposalId}"`);
    }
    if (reaction.kind === "pick" && !reaction.proposalId) errors.push("a pick must name a proposal");
    if (reaction.kind === "feedback" && !reaction.text) errors.push("feedback needs text");
    if (reaction.kind === "edit-assumption" && !(reaction.edits || []).length) errors.push("an assumption edit needs at least one field");
    for (const edit of input.reaction.edits || []) {
      if (!BRIEF_FIELD_PATHS.includes(edit.field)) errors.push(`cannot edit unknown Brief field "${edit.field}"`);
    }
    return errors;
  }
};

export function applyReaction({ brief: original, reaction, proposals = [] }) {
  const brief = structuredClone(original);
  const changes = [];
  const set = (field, value, note, source = "stated") => {
    const node = getField(brief, field);
    if (!node) return;
    const from = node.value;
    if (JSON.stringify(from) === JSON.stringify(value) && node.source === source) return;
    Object.assign(node, { value, source, confidence: source === "stated" ? 1 : 0.6, note });
    changes.push({ field, from, to: value, source, note });
  };

  const target = reaction.proposalId ? proposals.find((p) => p.proposalId === reaction.proposalId) : null;
  let unparsed = null;

  if (reaction.kind === "edit-assumption") {
    for (const edit of reaction.edits || []) set(edit.field, edit.value, "corrected by you");
  }

  if (reaction.kind === "feedback" && reaction.text) {
    const parsed = parseUserText(reaction.text);
    const previous = brief.preferences.text.value;
    set("preferences.text", previous ? `${previous}; ${reaction.text}` : reaction.text, "your feedback");
    if (parsed.roomType) set("roomType", parsed.roomType, "from your feedback");
    if (parsed.warmth) set("preferences.warmth", parsed.warmth, "from your feedback");
    if (parsed.lightness) set("preferences.lightness", parsed.lightness, "from your feedback");
    for (const [need, level] of Object.entries(parsed.needs)) set(`needs.${need}`, level, "from your feedback");
    if (parsed.avoidColours.length > 0) {
      set("preferences.avoidColours", [...new Set([...brief.preferences.avoidColours.value, ...parsed.avoidColours])], "from your feedback");
    }
    if (parsed.styleTags.length > 0) {
      set("styleTags", [...new Set([...parsed.styleTags, ...brief.styleTags.value])], "from your feedback");
    }
    if (parsed.matched.length === 0) unparsed = reaction.text;
  }

  // Same rule as BRIEF: a stated room type raises non-stated needs to its guideline level.
  const roomChange = changes.find((c) => c.field === "roomType");
  if (roomChange) {
    const profile = roomNeedsProfile(brief.roomType.value) || {};
    for (const need of NEEDS) {
      const node = brief.needs[need];
      if (node.source !== "stated" && profile[need] && LEVELS.indexOf(profile[need]) > LEVELS.indexOf(node.value)) {
        set(`needs.${need}`, profile[need], `raised to the ${roomLabel(brief.roomType.value)} guideline level`, "assumed");
      }
    }
  }

  return { brief, changes, targetDirectionId: target?.directionId ?? null, unparsed };
}

function getField(brief, path) {
  return path.split(".").reduce((node, key) => node?.[key], brief);
}
