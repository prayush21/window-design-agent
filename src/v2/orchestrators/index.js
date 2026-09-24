import * as workflow from "./workflow.js";

// Orchestrators are swappable: each exports name and run(session, ctx) → async
// iterator of events. The API and CLI choose one by name (?orchestrator=…), so an
// agent orchestrator can later be added here and compared on the same input.

export const ORCHESTRATORS = { [workflow.name]: workflow };

export function getOrchestrator(name = "workflow") {
  const orchestrator = ORCHESTRATORS[name];
  if (!orchestrator) {
    throw new Error(`Unknown orchestrator "${name}". Available: ${Object.keys(ORCHESTRATORS).join(", ")}`);
  }
  return orchestrator;
}
