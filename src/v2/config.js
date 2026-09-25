import "../env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every tunable of the v2 pipeline in one place. Stages read their slice from
// ctx.config; nothing reads process.env directly except resolveConfig().
//
// Model choice is per stage on purpose: critique must be able to run on a
// different model (and provider) from the compose stage it judges.
export const DEFAULT_CONFIG = {
  stages: {
    perceive: { provider: "gemini", model: "gemini-2.5-flash" },
    plan: { provider: "gemini", model: "gemini-2.5-flash" },
    compose: { provider: "gemini", model: "gemini-2.5-flash" },
    critique: { provider: "openai", model: "gpt-4.1-mini" },
    render: { provider: "openai", model: "gpt-image-2" }
  },
  budget: {
    // Per orchestrator run (one round). A reaction starts a new round with a fresh budget.
    maxRenders: 6,
    maxRevisionsPerDirection: 2
  },
  retrieve: {
    minPerLayer: 5,
    maxPerLayer: 8,
    maxPerProduct: 2,
    weights: { colour: 0.55, style: 0.2, light: 0.15, preference: 0.1 }
  },
  faithfulness: {
    // CIEDE2000 between the render's dominant covering colour and the swatch.
    // Provisional: calibrate on the first live renders (see docs/v2-design.md).
    threshold: 15,
    // Lightness counts half: real fabric in a lit room is darker or lighter than a flat
    // swatch photo, while a hue change means the wrong product (textile practice, CMC 2:1).
    kL: 2
  },
  critique: { enabled: true },
  present: { min: 2, max: 3 },
  paths: {
    traces: "traces",
    renders: "var/renders",
    cache: "var/cache",
    uploads: "var/uploads",
    fixtures: "test/fixtures/v2"
  },
  // USD per million tokens. Rough list prices, used only for trace cost estimates;
  // verify before relying on them. null = unknown, reported as "unpriced".
  prices: {
    "gemini-2.5-flash": { input: 0.3, output: 2.5 },
    "gemini-3.1-pro-preview": null,
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-image-2": null,
    "gemini-3.1-flash-image": null
  }
};

const STAGE_NAMES = Object.keys(DEFAULT_CONFIG.stages);

/**
 * Builds the run config. Mode is "mock" unless DESIGN_AGENT_LIVE=1 is set in the
 * environment by the user; asking for live without it is an error, never a silent
 * downgrade.
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), overrides);

  for (const stage of STAGE_NAMES) {
    const key = stage.toUpperCase();
    if (env[`V2_${key}_PROVIDER`]) config.stages[stage].provider = env[`V2_${key}_PROVIDER`];
    if (env[`V2_${key}_MODEL`]) config.stages[stage].model = env[`V2_${key}_MODEL`];
  }

  const liveAllowed = env.DESIGN_AGENT_LIVE === "1";
  const requested = overrides.mode ?? (liveAllowed ? "live" : "mock");
  if (requested === "live" && !liveAllowed) {
    throw new Error("Live mode needs DESIGN_AGENT_LIVE=1 in the environment. Refusing to make paid calls.");
  }
  if (!["mock", "live", "baseline"].includes(requested)) {
    throw new Error(`Unknown mode "${requested}". Use mock, live or baseline.`);
  }
  config.mode = requested;
  config.liveAllowed = liveAllowed;
  return config;
}

export function resolvePath(config, key) {
  return path.resolve(ROOT_DIR, config.paths[key]);
}

export function catalogDir(env = process.env) {
  return env.DESIGN_AGENT_CATALOG_DIR
    ? path.resolve(ROOT_DIR, env.DESIGN_AGENT_CATALOG_DIR)
    : path.join(ROOT_DIR, "window-products-v1");
}

/** A compact view of the config for traces: what shaped this run. */
export function summarizeConfig(config) {
  return {
    mode: config.mode,
    stages: config.stages,
    budget: config.budget,
    retrieve: config.retrieve,
    faithfulness: config.faithfulness,
    critique: config.critique,
    present: config.present
  };
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
      deepMerge(target[key], value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}
