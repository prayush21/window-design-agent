import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MockFixtureMissError, stableStringify } from "../mock-provider.js";
import { LiveCallRefusedError } from "./providers.js";
import { validate } from "./schemas/index.js";

// Cross-cutting concerns for every stage call, in one place: input/output schema
// validation, semantic checks, retry-once, repair or fallback (always with a visible
// warning), the render budget, the live-mode response cache, cost accounting and
// the trace record. Stages stay pure; every orchestrator gets identical behaviour.

export class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class StageFailedError extends Error {
  constructor(stage, errors) {
    super(`Stage "${stage}" failed: ${errors.slice(0, 3).join("; ")}`);
    this.name = "StageFailedError";
    this.stage = stage;
    this.errors = errors;
  }
}

// Errors that must stop the run rather than be retried or papered over.
const FATAL = [MockFixtureMissError, LiveCallRefusedError, BudgetExceededError];
const isFatal = (error) => FATAL.some((type) => error instanceof type) || error?.fatal === true;

/**
 * The render budget for one round, backed by the session's budget counters so it
 * survives save/resume.
 */
export function createBudget(limits, counters) {
  return {
    limits,
    rendersUsed: () => counters.rendersUsed,
    rendersRemaining: () => Math.max(0, limits.maxRenders - counters.rendersUsed),
    revisionsUsed: (directionId) => counters.revisions[directionId] || 0,
    reserveRender(stage) {
      if (counters.rendersUsed >= limits.maxRenders) {
        throw new BudgetExceededError(`Render budget exhausted (${limits.maxRenders} per round); ${stage} not run.`);
      }
      counters.rendersUsed += 1;
    },
    recordRevision(directionId) {
      counters.revisions[directionId] = (counters.revisions[directionId] || 0) + 1;
    }
  };
}

/**
 * Runs one stage. Returns { output, outcome, warnings }.
 * ctx = { config, catalog, providers, budget, trace, round, meta, cacheDir }
 */
export async function runStage(stage, input, ctx) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const warnings = [];
  const attempts = [];
  const meta = ctx.meta || {};

  const warn = (code, message) =>
    warnings.push({
      code,
      message,
      stage: stage.name,
      directionId: meta.directionId ?? null,
      proposalId: meta.proposalId ?? null,
      at: new Date().toISOString()
    });

  const finish = (record) => {
    const full = {
      stage: stage.name,
      kind: stage.kind,
      round: ctx.round ?? 1,
      startedAt,
      latencyMs: Date.now() - started,
      attempts,
      input,
      warnings,
      ...record
    };
    if (ctx.trace) ctx.trace.recordStage(full);
    return full;
  };

  const inputErrors = validate(stage.inputSchema, input);
  if (inputErrors.length > 0) {
    const error = new StageFailedError(stage.name, inputErrors.map((e) => `input ${e}`));
    finish({ output: null, outcome: "error", error: error.message });
    throw error;
  }

  // Live-mode cache: identical input + stage config → identical output, no second bill.
  const cacheFile = cachePath(stage, input, ctx);
  if (cacheFile && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const usable = validate(stage.outputSchema, cached.output).length === 0 && (!stage.cacheValid || stage.cacheValid(cached.output, ctx));
    if (usable) {
      const output = "cached" in cached.output ? { ...cached.output, cached: true } : cached.output;
      finish({ output, outcome: "cached", cached: true });
      return { output, outcome: "cached", warnings };
    }
  }

  const maxAttempts = stage.kind === "llm" ? 2 : 1;
  let output;
  let outcome = "ok";
  let lastCandidate;
  let lastErrors = [];

  try {
    if (stage.kind === "image") ctx.budget.reserveRender(stage.name);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const calls = [];
      const stageCtx = makeStageContext(ctx, stage, attempt, calls, warn);
      let candidate;
      let errors;

      try {
        const baseline = ctx.config.mode === "baseline" && stage.kind === "llm";
        candidate = baseline ? await stage.baseline(input, stageCtx) : await stage.run(input, stageCtx);
        errors = [...validate(stage.outputSchema, candidate), ...(stage.check ? stage.check(candidate, input, stageCtx) : [])];
        if (baseline && errors.length === 0) outcome = "baseline";
      } catch (error) {
        if (isFatal(error)) throw error;
        candidate = undefined;
        errors = [`${error.name || "Error"}: ${error.message}`];
      }

      attempts.push({ attempt, ...summarizeCalls(calls, ctx.config), valid: errors.length === 0, errors });

      if (errors.length === 0) {
        output = candidate;
        break;
      }
      lastCandidate = candidate;
      lastErrors = errors;
      if (attempt < maxAttempts) {
        warn("retry", `${stage.name} attempt ${attempt} was invalid (${errors[0]}); retried once.`);
      }
    }

    if (output === undefined && stage.repair && lastCandidate !== undefined) {
      const repaired = stage.repair(lastCandidate, input, lastErrors, makeStageContext(ctx, stage, 0, [], warn));
      if (repaired) {
        const errors = [
          ...validate(stage.outputSchema, repaired.output),
          ...(stage.check ? stage.check(repaired.output, input, makeStageContext(ctx, stage, 0, [], warn)) : [])
        ];
        if (errors.length === 0) {
          output = repaired.output;
          outcome = "repaired";
          warn("repaired", `${stage.name} output was still invalid after ${attempts.length} attempts (${lastErrors[0]}); repaired in code: ${repaired.notes.join("; ")}.`);
        }
      }
    }

    if (output === undefined && stage.fallback) {
      const fallbackCtx = makeStageContext(ctx, stage, 0, [], warn);
      const candidate = await stage.fallback(input, fallbackCtx, lastErrors);
      const errors = [...validate(stage.outputSchema, candidate), ...(stage.check ? stage.check(candidate, input, fallbackCtx) : [])];
      if (errors.length > 0) throw new StageFailedError(stage.name, errors.map((e) => `fallback ${e}`));
      output = candidate;
      outcome = "fallback";
      warn("fallback", `${stage.name} failed after ${attempts.length} attempt(s) (${lastErrors[0]}); used ${stage.fallbackDescription || "its no-model fallback"}.`);
    }

    if (output === undefined) throw new StageFailedError(stage.name, lastErrors);
  } catch (error) {
    finish({ output: null, outcome: "error", error: error.message });
    throw error;
  }

  if (cacheFile && outcome === "ok") {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ stage: stage.name, output })}\n`);
  }

  const record = finish({ output, outcome, cached: false });
  return { output, outcome, warnings, record };
}

function makeStageContext(ctx, stage, attempt, calls, warn) {
  return {
    config: ctx.config,
    catalog: ctx.catalog,
    attempt,
    meta: ctx.meta || {},
    warn,
    budget: ctx.budget
      ? { rendersRemaining: ctx.budget.rendersRemaining(), limits: ctx.budget.limits }
      : null,
    paths: ctx.paths,
    providers: {
      llm: async (request) => {
        const began = Date.now();
        const response = await ctx.providers.llm({ ...request, stage: stage.name, attempt: Math.max(1, attempt) });
        calls.push({ ...response, latencyMs: Date.now() - began });
        return response;
      },
      image: async (request) => {
        const began = Date.now();
        const response = await ctx.providers.image({ ...request, stage: stage.name });
        calls.push({ ...response, latencyMs: Date.now() - began });
        return response;
      }
    }
  };
}

function summarizeCalls(calls, config) {
  if (calls.length === 0) return { provider: null, model: null, usage: null, costUsd: null, estimatedCostUsd: null, latencyMs: null };
  const call = calls[calls.length - 1];
  const pricedModel = call.wouldBe?.model || call.model;
  const estimated = priceOf(pricedModel, call.usage, config.prices);
  return {
    provider: call.provider,
    model: call.model,
    wouldBe: call.wouldBe || null,
    usage: call.usage || null,
    // Mock calls cost nothing; estimatedCostUsd is what the configured model would cost.
    costUsd: call.provider === "mock" ? 0 : estimated,
    estimatedCostUsd: estimated,
    latencyMs: call.latencyMs,
    fixture: call.fixture || null
  };
}

export function priceOf(model, usage, prices) {
  const price = prices?.[model];
  if (!price || !usage || usage.inputTokens == null) return null;
  return ((usage.inputTokens || 0) * price.input + (usage.outputTokens || 0) * price.output) / 1e6;
}

function cachePath(stage, input, ctx) {
  if (ctx.config.mode !== "live" || !ctx.cacheDir || stage.kind === "code") return null;
  const key = stage.cacheKey ? stage.cacheKey(input, ctx) : stableStringify({ input, stage: ctx.config.stages[stage.name] });
  const hash = crypto.createHash("sha256").update(`${stage.name}:${stage.version || 1}:${key}`).digest("hex").slice(0, 32);
  return path.join(ctx.cacheDir, "stages", stage.name, `${hash}.json`);
}
