// Decision points after a render and after a critique. Pure functions: facts in,
// { decision, reason } out. The workflow calls them by name; an agent orchestrator
// may later replace any one of them without touching the others.

/**
 * After the faithfulness check: critique the render, re-render it once, or give
 * up on the render (a render problem is never turned into a design verdict).
 *
 * decision: "critique" | "rerender" | "unrendered"
 */
export function decideAfterRender({ faithfulness, renderAttempt, rendersRemaining, maxRenderAttempts = 2 }) {
  if (faithfulness.pass) {
    return {
      decision: "critique",
      reason:
        faithfulness.deltaE === null
          ? "no swatch colour to check against; passed to critique unchecked"
          : `render colour within ΔE ${faithfulness.deltaE} of the swatch (threshold ${faithfulness.threshold})`
    };
  }
  if (renderAttempt < maxRenderAttempts && rendersRemaining > 0) {
    return { decision: "rerender", reason: `render changed the colour (ΔE ${faithfulness.deltaE} > ${faithfulness.threshold}); re-rendering once` };
  }
  return {
    decision: "unrendered",
    reason:
      renderAttempt >= maxRenderAttempts
        ? `render ${renderAttempt} still changed the colour (ΔE ${faithfulness.deltaE}); the proposal is kept but shown without a render`
        : `render changed the colour (ΔE ${faithfulness.deltaE}) and the render budget is spent; shown without a render`
  };
}

/**
 * After a design critique: accept, revise with the next variant, or drop.
 *
 * decision: "accept" | "revise" | "drop" | "stop-unapproved" | "accept-unreviewed"
 */
export function decideAfterCritique({ critique, revisionsUsed, maxRevisions, rendersRemaining, candidatesLeft }) {
  switch (critique.verdict) {
    case "ACCEPT":
      return { decision: "accept", reason: `critique accepted: ${critique.reason}` };
    case "DROP":
      return { decision: "drop", reason: `critique dropped the direction: ${critique.reason}` };
    case "UNREVIEWED":
      return { decision: "accept-unreviewed", reason: "critique gave no usable verdict; shown as unreviewed" };
    case "REVISE": {
      if (revisionsUsed >= maxRevisions) {
        return { decision: "stop-unapproved", reason: `critique asked for a revision but this direction already used ${revisionsUsed} of ${maxRevisions}` };
      }
      if (rendersRemaining <= 0) {
        return { decision: "stop-unapproved", reason: "critique asked for a revision but the render budget is spent" };
      }
      if (candidatesLeft <= 0) {
        return { decision: "stop-unapproved", reason: "critique asked for a revision but the shortlist has no untried variant" };
      }
      return { decision: "revise", reason: `critique asked for a different variant: ${critique.revisionHint || critique.reason}` };
    }
    default:
      throw new Error(`Unknown critique verdict "${critique.verdict}".`);
  }
}
