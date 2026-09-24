import path from "node:path";
import { catalogDir, resolvePath } from "./config.js";
import { loadCatalogIndex } from "./catalog-index.js";
import { getOrchestrator } from "./orchestrators/index.js";
import { createProviders } from "./providers.js";
import { createBudget, runStage } from "./runtime.js";
import { saveSession } from "./session.js";
import { getStage } from "./stages/index.js";
import { TraceRecorder } from "./trace.js";

// Wires a run: catalog, providers (mock or live), trace recorder and session
// checkpoints. Used by the CLI, the API and the tests, so all three run the
// exact same thing.

export async function createContext({ config, session, orchestrator = "workflow" }) {
  const cacheDir = resolvePath(config, "cache");
  const catalog = await loadCatalogIndex({ catalogDir: catalogDir(), cacheDir });
  const providers = createProviders(config, { fixturesDir: resolvePath(config, "fixtures") });
  const trace = session
    ? new TraceRecorder({ session, orchestrator, config, dir: resolvePath(config, "traces") })
    : null;
  const sessionsDir = path.join(resolvePath(config, "traces"), "sessions");

  return {
    config,
    catalog,
    providers,
    trace,
    cacheDir,
    paths: { renders: resolvePath(config, "renders"), uploads: resolvePath(config, "uploads") },
    sessionsDir,
    checkpoint(current) {
      if (trace) {
        trace.sync(current);
        trace.write();
      }
      saveSession(current, sessionsDir);
    }
  };
}

/** Runs an orchestrator over a session to its next stopping point. */
export async function runSession(session, { config, orchestrator = "workflow", onEvent } = {}) {
  const ctx = await createContext({ config, session, orchestrator });
  const events = [];
  try {
    for await (const event of getOrchestrator(orchestrator).run(session, ctx)) {
      events.push(event);
      await onEvent?.(event);
    }
  } catch (error) {
    session.warnings.push({ code: "run-error", message: error.message, stage: null, at: new Date().toISOString() });
    ctx.checkpoint(session);
    const event = { type: "error", message: error.message };
    events.push(event);
    await onEvent?.(event);
    error.traceFile = ctx.trace?.file;
    throw error;
  }
  return { session, events, traceFile: ctx.trace?.file };
}

/**
 * Runs one stage on its own, outside any orchestrator: the modularity check, and
 * what a tool-calling agent will do. Input usually comes from a saved Session.
 */
export async function runSingleStage(stageName, input, { config, meta = {}, budgetCounters } = {}) {
  const ctx = await createContext({ config, session: null });
  const budget = createBudget(config.budget, budgetCounters || { rendersUsed: 0, revisions: {} });
  return runStage(getStage(stageName), input, { ...ctx, budget, meta, round: 1 });
}
