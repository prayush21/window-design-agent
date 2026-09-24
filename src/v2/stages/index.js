import { SHARED_SCHEMAS } from "../schemas/index.js";
import brief from "./brief.js";
import compose from "./compose.js";
import perceive from "./perceive.js";
import plan from "./plan.js";
import present from "./present.js";
import render from "./render.js";
import retrieve from "./retrieve.js";

// The registry: every stage, by name. An orchestrator looks stages up here and
// never imports them directly, and toolDefinitions() exposes the same stages to a
// future tool-calling agent with no rewrite.

export const STAGES = Object.fromEntries([perceive, brief, plan, retrieve, compose, render, present].map((stage) => [stage.name, stage]));

export function getStage(name) {
  const stage = STAGES[name];
  if (!stage) throw new Error(`Unknown stage "${name}". Registered: ${Object.keys(STAGES).join(", ")}`);
  return stage;
}

/** Stages as tool definitions: name, description and a self-contained input schema. */
export function toolDefinitions() {
  return Object.values(STAGES).map((stage) => ({
    name: stage.name,
    description: stage.description,
    kind: stage.kind,
    inputSchema: inlineRefs(stage.inputSchema)
  }));
}

const BY_ID = Object.fromEntries(Object.values(SHARED_SCHEMAS).map((schema) => [schema.$id, schema]));

// Tool consumers do not share our Ajv registry, so $refs are expanded in place.
export function inlineRefs(schema) {
  if (Array.isArray(schema)) return schema.map(inlineRefs);
  if (!schema || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string" && BY_ID[schema.$ref]) {
    const { $id: _id, ...target } = BY_ID[schema.$ref];
    return inlineRefs(target);
  }
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, inlineRefs(value)]));
}
