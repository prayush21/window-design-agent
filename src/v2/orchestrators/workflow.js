import { MockFixtureMissError } from "../../mock-provider.js";
import { LiveCallRefusedError } from "../providers.js";
import { BudgetExceededError, createBudget, runStage } from "../runtime.js";
import { getPolicy } from "../policies/index.js";
import { archiveRound } from "../session.js";
import { getStage } from "../stages/index.js";

// The fixed workflow: perceive → brief → plan → retrieve → (compose → render →
// critique) → present → await a reaction. It reads and extends the Session and
// resumes from session.cursor, so it can start at any stage boundary.
//
// Only this file knows the order. Stages are looked up by name in the registry.

export const name = "workflow";

// Policy inputs recorded in the trace: the facts, without whole objects.
function summarizeFacts(facts) {
  const out = {};
  for (const [key, value] of Object.entries(facts)) {
    if (key === "critique") out.critique = { verdict: value.verdict, scores: value.scores, source: value.source };
    else if (key === "faithfulness") out.faithfulness = { deltaE: value.deltaE, pass: value.pass, threshold: value.threshold };
    else out[key] = value;
  }
  return out;
}

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

  function decide(policyName, facts, meta) {
    const result = getPolicy(policyName)(facts);
    const entry = {
      policy: policyName,
      decision: result.decision,
      reason: result.reason,
      round: session.round,
      directionId: meta.directionId ?? null,
      proposalId: meta.proposalId ?? null,
      inputs: summarizeFacts(facts),
      at: new Date().toISOString()
    };
    session.decisions.push(entry);
    return { result, event: { type: "decision", decision: entry } };
  }

  // COMPOSE → RENDER → FAITHFULNESS → CRITIQUE for one direction, looping on REVISE
  // within the budget. Every branch taken is a recorded policy decision.
  async function* designDirection(directionId) {
    const direction = session.directions.find((d) => d.id === directionId);
    const shortlist = session.shortlists[directionId];
    const exclude = [...(session.cursor.exclude?.[directionId] || [])];
    const feedback = session.cursor.feedback?.[directionId] || null;
    const critiqueOn = ctx.config.critique.enabled;
    let critiqueHint = null;

    while (true) {
      const attempt = session.proposals.filter((p) => p.round === session.round && p.directionId === directionId).length + 1;
      let proposal;
      try {
        proposal = yield* step(
          "compose",
          { brief: session.brief, direction, shortlist, roomPhoto: session.input.roomPhoto, round: session.round, attempt, exclude: [...exclude], feedback, critiqueHint },
          { directionId }
        );
      } catch (error) {
        if (isFatal(error)) throw error;
        yield warn("compose-failed", `No proposal for ${directionId}: ${error.message}`, { directionId });
        return;
      }
      session.proposals.push(proposal);
      yield { type: "proposal", proposal };
      const meta = { directionId, proposalId: proposal.proposalId };

      const render = yield* renderAndCheck(proposal, critiqueOn);
      if (!critiqueOn || !render) {
        proposal.status = "unreviewed";
        return;
      }

      let critique;
      try {
        critique = yield* step(
          "critique",
          { brief: session.brief, direction, proposal, render, roomPhoto: session.input.roomPhoto },
          meta
        );
      } catch (error) {
        if (isFatal(error)) throw error;
        yield warn("critique-failed", `${proposal.proposalId} not critiqued: ${error.message}`, meta);
        proposal.status = "unreviewed";
        return;
      }
      session.critiques.push(critique);
      yield { type: "critique", critique };

      const tried = new Set([...exclude, proposal.visual.variantId]);
      const { result, event } = decide(
        "critique-verdict",
        {
          critique,
          revisionsUsed: budget.revisionsUsed(directionId),
          maxRevisions: ctx.config.budget.maxRevisionsPerDirection,
          rendersRemaining: budget.rendersRemaining(),
          candidatesLeft: shortlist.layers.visual.candidates.filter((c) => !tried.has(c.variantId)).length
        },
        meta
      );
      yield event;

      if (result.decision === "accept") proposal.status = "accepted";
      else if (result.decision === "accept-unreviewed") proposal.status = "unreviewed";
      else if (result.decision === "drop") proposal.status = "dropped";
      else if (result.decision === "stop-unapproved") proposal.status = "revised";
      else if (result.decision === "revise") {
        proposal.status = "revised";
        budget.recordRevision(directionId);
        exclude.push(proposal.visual.variantId);
        critiqueHint = critique.revisionHint || critique.reason;
        continue;
      }
      return;
    }
  }

  // REACT → re-entry policy → the next cursor. The round's state moves to history.
  async function* handleReaction() {
    const reaction = {
      reactionId: `re${session.reactions.length + 1}`,
      round: session.round,
      proposalId: null,
      text: null,
      at: new Date().toISOString(),
      ...session.pendingReaction
    };
    delete session.pendingReaction;

    let out;
    try {
      out = yield* step("react", { brief: session.brief, reaction, proposals: session.proposals });
    } catch (error) {
      if (isFatal(error)) throw error;
      yield warn("reaction-rejected", `Reaction not applied: ${error.message}`);
      session.cursor = { next: "await-reaction" };
      return;
    }
    session.reactions.push(reaction);
    session.brief = out.brief;
    yield { type: "brief", brief: session.brief };

    const { result, event } = decide(
      "reaction-reentry",
      {
        reaction: { kind: reaction.kind, proposalId: reaction.proposalId, text: reaction.text },
        changes: out.changes,
        targetDirectionId: out.targetDirectionId,
        directionIds: session.directions.map((d) => d.id),
        unparsed: out.unparsed
      },
      { directionId: out.targetDirectionId, proposalId: reaction.proposalId }
    );
    yield event;

    if (result.decision === "done") {
      session.cursor = { next: "done" };
    } else if (result.decision === "plan") {
      archiveRound(session);
      session.cursor = { next: "plan" };
    } else if (result.decision === "compose") {
      // Same directions, different variants: every visual variant already shown for
      // a direction is excluded, and the Brief changed, so shortlists are refreshed.
      const exclude = {};
      const feedback = {};
      for (const directionId of result.directionIds) {
        exclude[directionId] = [...new Set(session.proposals.filter((p) => p.directionId === directionId).map((p) => p.visual.variantId))];
        if (reaction.text && directionId === out.targetDirectionId) feedback[directionId] = reaction.text;
      }
      archiveRound(session, { keepDirections: true });
      session.cursor = { next: "retrieve", directionIds: result.directionIds, exclude, feedback };
    }
  }

  // Render, check the colour, re-render once if the policy says so. Returns the
  // faithful render, or null when there is none to critique.
  async function* renderAndCheck(proposal, checkColour) {
    const meta = { directionId: proposal.directionId, proposalId: proposal.proposalId };
    for (let attempt = 1; ; attempt += 1) {
      const render = yield* renderProposal(proposal, attempt);
      if (!render) return null;
      if (!checkColour) return render;

      const faith = yield* step("faithfulness", { render, windowRegion: session.brief.windowRegion.value }, meta);
      session.faithfulness.push(faith);
      yield { type: "faithfulness", faithfulness: faith };

      const { result, event } = decide(
        "render-check",
        { faithfulness: faith, renderAttempt: attempt, rendersRemaining: budget.rendersRemaining() },
        meta
      );
      yield event;
      if (result.decision === "critique") return render;
      if (result.decision === "rerender") yield warn("render-off-colour", `${proposal.proposalId} render ${attempt}: ${result.reason}`, meta);
      if (result.decision === "unrendered") {
        yield warn("render-unfaithful", `${proposal.proposalId}: ${result.reason}`, meta);
        return null;
      }
    }
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

  // A reaction waiting on a presented session resumes at REACT.
  if (session.pendingReaction && ["await-reaction", "done", "react"].includes(session.cursor.next)) {
    session.cursor = { next: "react" };
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
        const exclude = session.cursor.exclude?.[directionId] || [];
        const shortlist = yield* step("retrieve", { brief: session.brief, direction, exclude }, { directionId });
        session.shortlists[directionId] = shortlist;
        yield { type: "shortlist", shortlist };
      }
      session.cursor = { ...session.cursor, next: "compose" };
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
        critiqueEnabled: ctx.config.critique.enabled
      });
      yield { type: "presentation", presentation: session.presentation };
      session.cursor = { next: "await-reaction" };
    } else if (next === "react") {
      yield* handleReaction();
    } else {
      break;
    }

    await ctx.checkpoint?.(session);
  }

  await ctx.checkpoint?.(session);
  yield { type: "done", cursor: session.cursor, round: session.round };
}
