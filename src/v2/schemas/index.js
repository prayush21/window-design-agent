import Ajv from "ajv";
import { paletteColour, productRef, region, usage, warning } from "./common.js";
import {
  brief,
  candidate,
  critique,
  decision,
  direction,
  faithfulness,
  presentation,
  proposal,
  rationaleClaim,
  reaction,
  render,
  shortlist
} from "./domain.js";
import { session, stageRecord, trace } from "./session.js";

export { BRIEF_FIELD_PATHS } from "./domain.js";
export * from "./common.js";

// One Ajv instance for all of v2, so a stage schema can $ref any shared schema by id.
export const ajv = new Ajv({ allErrors: true, strict: false });

export const SHARED_SCHEMAS = {
  region,
  paletteColour,
  productRef,
  warning,
  usage,
  brief,
  direction,
  candidate,
  shortlist,
  rationaleClaim,
  proposal,
  render,
  faithfulness,
  critique,
  decision,
  reaction,
  presentation,
  session,
  stageRecord,
  trace
};

for (const schema of Object.values(SHARED_SCHEMAS)) ajv.addSchema(schema);

const compiled = new Map();

function compile(schema) {
  if (typeof schema === "string") {
    const fn = ajv.getSchema(schema);
    if (!fn) throw new Error(`Unknown schema id "${schema}".`);
    return fn;
  }
  if (!compiled.has(schema)) compiled.set(schema, ajv.compile(schema));
  return compiled.get(schema);
}

/** Validates `value`; returns a list of readable errors (empty when valid). */
export function validate(schema, value) {
  const fn = compile(schema);
  if (fn(value)) return [];
  return (fn.errors || []).map((error) => `${error.instancePath || "(root)"} ${error.message}${formatParams(error)}`);
}

export function assertValid(schema, value, label) {
  const errors = validate(schema, value);
  if (errors.length > 0) {
    const error = new Error(`${label} failed schema validation: ${errors.slice(0, 5).join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }
}

export function compileSchema(schema) {
  return compile(schema);
}

function formatParams(error) {
  if (error.keyword === "enum") return ` (${error.params.allowedValues.join(", ")})`;
  if (error.keyword === "additionalProperties") return ` (${error.params.additionalProperty})`;
  if (error.keyword === "required") return "";
  return "";
}
