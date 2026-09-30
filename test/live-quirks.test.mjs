import assert from "node:assert/strict";
import { test } from "node:test";
import compose from "../src/v2/stages/compose.js";
import critique from "../src/v2/stages/critique.js";
import { evalRooms, newSession, testCatalog, testConfig } from "./helpers.mjs";
import { runSession } from "../src/v2/engine.js";

// Output shapes seen from real models on 2026-09-24, replayed without a network.
const config = testConfig();
const catalog = await testCatalog(config);
const session = newSession(evalRooms().find((r) => r.id === "uploaded_room"));
await runSession(session, { config });

function fakeCtx(result) {
  const warnings = [];
  return {
    warnings,
    ctx: {
      config,
      catalog,
      paths: { renders: `${config.paths.renders}` },
      previousErrors: [],
      warn: (code, message) => warnings.push({ code, message }),
      providers: { llm: async () => ({ result }) }
    }
  };
}

test("COMPOSE: citations of direction fields are dropped with a warning, not retried", async () => {
  const d = session.directions[0];
  const shortlist = session.shortlists[d.id];
  const pick = (layer) => ({ productId: shortlist.layers[layer].candidates[0].productId, variantId: shortlist.layers[layer].candidates[0].variantId });
  const { ctx, warnings } = fakeCtx({
    directionId: d.id,
    visual: pick("visual"),
    functional: shortlist.layers.functional ? pick("functional") : null,
    rationale: [{ claim: "Soft texture as the direction asks.", briefFields: ["styleTags", "direction.texture", "direction.intent"] }]
  });
  const input = { brief: session.brief, direction: d, shortlist, roomPhoto: session.input.roomPhoto, round: 1, attempt: 1, exclude: [], feedback: null, critiqueHint: null };
  const proposal = await compose.run(input, ctx);
  assert.deepEqual(proposal.rationale[0].briefFields, ["styleTags"]);
  assert.deepEqual(compose.check(proposal, input), []);
  assert.equal(warnings[0].code, "rationale-fields-dropped");
});

test("CRITIQUE: a verdict wrapped in a one-element array is unwrapped", async () => {
  const render = session.renders[0];
  const proposal = session.proposals.find((p) => p.proposalId === render.proposalId);
  const direction = session.directions.find((d) => d.id === proposal.directionId);
  const verdict = { verdict: "ACCEPT", scores: { harmony: 5, intent: 5, roomFit: 4, installed: 4 }, reason: "Fits.", revisionHint: null };
  const { ctx } = fakeCtx([verdict]);
  const out = await critique.run({ brief: session.brief, direction, proposal, render, roomPhoto: session.input.roomPhoto }, ctx);
  assert.equal(out.verdict, "ACCEPT");
  assert.deepEqual(out.scores, verdict.scores);
});
