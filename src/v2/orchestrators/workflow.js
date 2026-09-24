import { MockFixtureMissError } from "../../mock-provider.js";
import { LiveCallRefusedError } from "../providers.js";
import { BudgetExceededError, createBudget, runStage } from "../runtime.js";
import { getStage } from "../stages/index.js";

// The fixed workflow: perceive → brief → plan → retrieve → (compose → render →
// critique) → present → await a reaction. It reads and extends the Session and
// resumes from session.cursor, so it can start at any stage boundary.
//
// Only this file knows the order. Stages are looked up by name in the registry.

export const name = "workflow";

const isFatal = (error) => error instanceof MockFixtureMissError || error instanceof LiveCallRefusedError;

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

  function warn(code, message, meta = {}) {
    const warning = { code, message, stage: null, directionId: meta.directionId ?? null, proposalId: meta.proposalId ?? null, at: new Date().toISOString() };
    session.warnings.push(warning);
    return { type: "warning", warning };
  }

  // COMPOSE → RENDER for one direction.
  async function* designDirection(directionId) {
    const direction = session.directions.find((d) => d.id === directionId);
    const shortlist = session.shortlists[directionId];
    const exclude = [...(session.cursor.exclude?.[directionId] || [])];
    const feedback = session.cursor.feedback?.[directionId] || null;
    const attempt = session.proposals.filter((p) => p.round === session.round && p.directionId === directionId).length + 1;

    let proposal;
    try {
      proposal = yield* step(
        "compose",
        { brief: session.brief, direction, shortlist, roomPhoto: session.input.roomPhoto, round: session.round, attempt, exclude, feedback },
        { directionId }
      );
    } catch (error) {
      if (isFatal(error)) throw error;
      yield warn("compose-failed", `No proposal for ${directionId}: ${error.message}`, { directionId });
      return;
    }
    session.proposals.push(proposal);
    yield { type: "proposal", proposal };

    yield* renderProposal(proposal, 1);
    proposal.status = "unreviewed";
  }

  // Returns the render, or null (with a visible warning) when the budget is spent
  // or the image stage failed.
  async function* renderProposal(proposal, attempt) {
    const meta = { directionId: proposal.directionId, proposalId: proposal.proposalId };
    try {
      const render = yield* step(
        "render",
        { roomPhoto: session.input.roomPhoto, proposal, windowRegion: session.brief.windowRegion.value, attempt },
        meta
      );
      session.renders.push(render);
      yield { type: "render", render };
      return render;
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        yield warn("render-budget", `${proposal.proposalId} not rendered: ${error.message}`, meta);
        return null;
      }
      if (isFatal(error)) throw error;
      yield warn("render-failed", `${proposal.proposalId} render ${attempt} failed: ${error.message}`, meta);
      return null;
    }
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
      session.cursor = { next: "compose", directionIds: session.cursor.directionIds };
    } else if (next === "compose") {
      for (const directionId of session.cursor.directionIds) {
        yield* designDirection(directionId);
      }
      session.cursor = { next: "present" };
    } else if (next === "present") {
      session.presentation = yield* step("present", {
        brief: session.brief,
        directions: session.directions,
        proposals: session.proposals,
        renders: session.renders,
        faithfulness: session.faithfulness,
        critiques: session.critiques,
        round: session.round,
        critiqueEnabled: false
      });
      yield { type: "presentation", presentation: session.presentation };
      session.cursor = { next: "await-reaction" };
    } else {
      break;
    }

    await ctx.checkpoint?.(session);
  }

  await ctx.checkpoint?.(session);
  yield { type: "done", cursor: session.cursor, round: session.round };
}
