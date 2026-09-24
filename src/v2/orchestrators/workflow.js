import { runStage, createBudget } from "../runtime.js";
import { getStage } from "../stages/index.js";

// The fixed workflow: perceive → brief → plan → retrieve → (compose → render →
// critique) → present → await a reaction. It reads and extends the Session and
// resumes from session.cursor, so it can start at any stage boundary.
//
// Only this file knows the order. Stages are looked up by name in the registry.

export const name = "workflow";

export async function* run(session, ctx) {
  session.orchestrator = name;
  const budget = createBudget(ctx.config.budget, session.budget);

  // Runs one stage through the runtime and surfaces its warnings in the session
  // and as events. Returns the stage output.
  async function* step(stageName, input, meta = {}) {
    yield { type: "stage-start", stage: stageName, ...meta };
    const result = await runStage(getStage(stageName), input, {
      ...ctx,
      budget,
      round: session.round,
      meta
    });
    for (const warning of result.warnings) {
      session.warnings.push(warning);
      yield { type: "warning", warning };
    }
    yield { type: "stage-end", stage: stageName, outcome: result.outcome, ...meta };
    return result.output;
  }

  while (true) {
    const next = session.cursor.next;

    if (next === "perceive") {
      session.environment = yield* step("perceive", { roomPhoto: session.input.roomPhoto });
      session.cursor = { next: "brief" };
    } else if (next === "brief") {
      session.brief = yield* step("brief", { environment: session.environment, userInput: session.input.userInput });
      yield { type: "brief", brief: session.brief };
      session.cursor = { next: "plan" };
    } else if (next === "plan") {
      const previousDirections = session.history.flatMap((round) => round.directions || []);
      const output = yield* step("plan", { brief: session.brief, previousDirections });
      session.directions = output.directions;
      yield { type: "directions", directions: session.directions };
      session.cursor = { next: "retrieve", directionIds: session.directions.map((d) => d.id) };
    } else if (next === "retrieve") {
      for (const directionId of session.cursor.directionIds) {
        const direction = session.directions.find((d) => d.id === directionId);
        const shortlist = yield* step("retrieve", { brief: session.brief, direction }, { directionId });
        session.shortlists[directionId] = shortlist;
        yield { type: "shortlist", shortlist };
      }
      session.cursor = { next: "await-reaction" };
    } else {
      break;
    }

    await ctx.checkpoint?.(session);
  }

  await ctx.checkpoint?.(session);
  yield { type: "done", cursor: session.cursor, round: session.round };
}
