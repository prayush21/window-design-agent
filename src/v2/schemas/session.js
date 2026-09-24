import { nonEmpty } from "./common.js";

// Session: the explicit, serializable state an orchestrator reads and extends.
// Trace: the orchestrator-independent record of what happened, for debugging and
// offline evaluation. Both are plain JSON.

const arrayOf = (ref) => ({ type: "array", items: { $ref: ref } });

export const CURSOR_STEPS = ["perceive", "brief", "plan", "retrieve", "compose", "present", "await-reaction", "react", "done"];

export const session = {
  $id: "v2.session",
  type: "object",
  required: [
    "sessionVersion",
    "sessionId",
    "createdAt",
    "input",
    "round",
    "cursor",
    "environment",
    "brief",
    "directions",
    "shortlists",
    "proposals",
    "renders",
    "faithfulness",
    "critiques",
    "presentation",
    "reactions",
    "decisions",
    "history",
    "warnings",
    "budget"
  ],
  properties: {
    sessionVersion: { const: 1 },
    sessionId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,80}$" },
    createdAt: nonEmpty,
    orchestrator: { type: ["string", "null"] },
    input: {
      type: "object",
      required: ["roomPhoto", "userInput"],
      properties: {
        roomPhoto: {
          type: "object",
          required: ["path", "sha256"],
          properties: { path: nonEmpty, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, roomId: { type: ["string", "null"] } }
        },
        userInput: {
          type: "object",
          properties: {
            text: { type: ["string", "null"] },
            roomType: { type: ["string", "null"] },
            references: { type: "array" }
          }
        }
      }
    },
    round: { type: "integer", minimum: 1 },
    cursor: {
      type: "object",
      required: ["next"],
      properties: {
        next: { enum: CURSOR_STEPS },
        directionIds: { type: ["array", "null"], items: { type: "string" } },
        exclude: { type: "object" }
      }
    },
    environment: { type: ["object", "null"] },
    brief: { oneOf: [{ $ref: "v2.brief" }, { type: "null" }] },
    directions: arrayOf("v2.direction"),
    shortlists: { type: "object", additionalProperties: { $ref: "v2.shortlist" } },
    proposals: arrayOf("v2.proposal"),
    renders: arrayOf("v2.render"),
    faithfulness: arrayOf("v2.faithfulness"),
    critiques: arrayOf("v2.critique"),
    presentation: { oneOf: [{ $ref: "v2.presentation" }, { type: "null" }] },
    reactions: arrayOf("v2.reaction"),
    decisions: arrayOf("v2.decision"),
    history: { type: "array" },
    warnings: arrayOf("v2.warning"),
    budget: {
      type: "object",
      required: ["rendersUsed", "revisions"],
      properties: {
        rendersUsed: { type: "integer", minimum: 0 },
        revisions: { type: "object", additionalProperties: { type: "integer" } }
      }
    }
  }
};

const stageAttempt = {
  type: "object",
  required: ["attempt"],
  properties: {
    attempt: { type: "integer", minimum: 1 },
    provider: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    wouldBe: { type: ["object", "null"] },
    usage: { $ref: "v2.usage" },
    costUsd: { type: ["number", "null"] },
    latencyMs: { type: ["number", "null"] },
    valid: { type: "boolean" },
    errors: { type: "array", items: { type: "string" } }
  }
};

export const stageRecord = {
  $id: "v2.stageRecord",
  type: "object",
  required: ["seq", "stage", "kind", "round", "startedAt", "latencyMs", "attempts", "input", "output", "warnings"],
  properties: {
    seq: { type: "integer", minimum: 1 },
    stage: nonEmpty,
    kind: { enum: ["llm", "code", "image"] },
    round: { type: "integer" },
    startedAt: nonEmpty,
    latencyMs: { type: "number" },
    attempts: { type: "array", items: stageAttempt },
    input: {},
    output: {},
    outcome: { enum: ["ok", "repaired", "fallback", "error", "cached", "baseline"] },
    error: { type: ["string", "null"] },
    warnings: { type: "array", items: { $ref: "v2.warning" } },
    cached: { type: "boolean" },
    costUsd: { type: ["number", "null"] },
    tokens: { type: ["number", "null"] }
  }
};

export const trace = {
  $id: "v2.trace",
  type: "object",
  required: [
    "traceVersion",
    "sessionId",
    "orchestrator",
    "mode",
    "startedAt",
    "updatedAt",
    "roomPhoto",
    "stages",
    "brief",
    "directions",
    "shortlists",
    "proposals",
    "renders",
    "faithfulness",
    "critiques",
    "decisions",
    "reactions",
    "presentation",
    "warnings",
    "totals"
  ],
  properties: {
    traceVersion: { const: 1 },
    sessionId: nonEmpty,
    orchestrator: nonEmpty,
    mode: { enum: ["mock", "live", "baseline"] },
    startedAt: nonEmpty,
    updatedAt: nonEmpty,
    roomPhoto: { type: "object" },
    config: { type: "object" },
    stages: arrayOf("v2.stageRecord"),
    brief: { oneOf: [{ $ref: "v2.brief" }, { type: "null" }] },
    directions: arrayOf("v2.direction"),
    shortlists: { type: "object" },
    proposals: arrayOf("v2.proposal"),
    renders: arrayOf("v2.render"),
    faithfulness: arrayOf("v2.faithfulness"),
    critiques: arrayOf("v2.critique"),
    decisions: arrayOf("v2.decision"),
    reactions: arrayOf("v2.reaction"),
    presentation: { oneOf: [{ $ref: "v2.presentation" }, { type: "null" }] },
    history: { type: "array" },
    warnings: arrayOf("v2.warning"),
    totals: {
      type: "object",
      required: ["latencyMs", "costUsd", "tokens", "renders", "llmCalls"],
      properties: {
        latencyMs: { type: "number" },
        costUsd: { type: ["number", "null"] },
        tokens: { type: "number" },
        renders: { type: "integer" },
        llmCalls: { type: "integer" },
        byStage: { type: "object" }
      }
    }
  }
};
