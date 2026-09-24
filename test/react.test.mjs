import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { runSession } from "../src/v2/engine.js";
import { validate } from "../src/v2/schemas/index.js";
import { applyReaction } from "../src/v2/stages/react.js";
import { assumptionChips } from "../src/v2/stages/present.js";
import { evalRooms, newSession, testConfig } from "./helpers.mjs";

// Step 4: REACT, assumption chips and the re-entry policy, end to end in mock mode.
const config = testConfig();
const room = (id) => evalRooms().find((r) => r.id === id);

async function presented(id) {
  const session = newSession(room(id));
  await runSession(session, { config });
  return session;
}

async function reactTo(session, reaction) {
  session.pendingReaction = reaction;
  const { traceFile } = await runSession(session, { config });
  return JSON.parse(fs.readFileSync(traceFile, "utf8"));
}

test("every inferred or assumed Brief field gets an editable chip; stated ones do not", async () => {
  const session = await presented("uploaded_room");
  const chips = assumptionChips(session.brief);
  const fields = new Set(chips.map((c) => c.field));
  const walk = (node, prefix) => {
    for (const [key, field] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (field && "source" in field) assert.equal(fields.has(path), field.source !== "stated", path);
      else walk(field, path);
    }
  };
  walk(session.brief, "");
  assert.deepEqual(session.presentation.assumptions, chips);
});

test("REACT: an edited chip becomes stated; a room type raises needs; the lexicon reads feedback", async () => {
  const session = await presented("IMG_4298");
  const edited = applyReaction({ brief: session.brief, reaction: { kind: "edit-assumption", edits: [{ field: "needs.privacy", value: "high" }] } });
  assert.equal(edited.brief.needs.privacy.source, "stated");
  assert.equal(edited.brief.needs.privacy.value, "high");

  const nursery = applyReaction({ brief: session.brief, reaction: { kind: "feedback", text: "Actually this is a nursery, no grey please" } });
  assert.equal(nursery.brief.roomType.value, "nursery");
  assert.equal(nursery.brief.needs.safety.value, "high");
  assert.equal(nursery.brief.needs.safety.source, "assumed");
  assert.deepEqual(nursery.brief.preferences.avoidColours.value, ["gray"]);
  assert.deepEqual(validate("v2.brief", nursery.brief), []);
});

test("feedback about one proposal re-enters at COMPOSE for that direction only, with a new variant", async () => {
  const session = await presented("uploaded_room");
  const before = session.proposals.find((p) => p.proposalId === "r1-d1-a1");
  const trace = await reactTo(session, { kind: "feedback", proposalId: "r1-d1-a1", text: "warmer" });
  const decision = trace.decisions.find((d) => d.policy === "reaction-reentry");
  assert.equal(decision.decision, "compose");
  assert.equal(session.round, 2);
  const round2 = session.proposals.filter((p) => p.round === 2);
  assert.deepEqual(round2.map((p) => p.directionId), ["d1"]);
  assert.notEqual(round2[0].visual.variantId, before.visual.variantId);
  assert.equal(session.brief.preferences.warmth.value, "warm");
  // The other directions' proposals carry over into the new presentation.
  assert.ok(session.presentation.items.some((i) => i.directionId === "d2"));
  assert.ok(!trace.stages.some((s) => s.round === 2 && ["perceive", "plan"].includes(s.stage)), "no re-plan");
  assert.equal(trace.history.length, 1);
});

test("re-describing the room re-enters at PLAN with new directions", async () => {
  const session = await presented("IMG_4297");
  const oldIds = session.directions.map((d) => d.id);
  const trace = await reactTo(session, { kind: "feedback", text: "this is a nursery" });
  assert.equal(trace.decisions.find((d) => d.policy === "reaction-reentry").decision, "plan");
  assert.equal(session.brief.roomType.value, "nursery");
  assert.equal(session.brief.roomType.source, "stated");
  assert.ok(session.directions.every((d) => !oldIds.includes(d.id)), "new direction ids");
  assert.ok(session.directions.every((d) => d.layers.functional === null), "nursery is single-layer");
  assert.equal(session.presentation.items.length, 3);
  assert.deepEqual(validate("v2.trace", trace), []);
});

test("a pick ends the session; an invalid reaction is rejected visibly and changes nothing", async () => {
  const session = await presented("IMG_4298");
  const brief = structuredClone(session.brief);
  await reactTo(session, { kind: "pick", proposalId: "does-not-exist" });
  assert.equal(session.cursor.next, "await-reaction");
  assert.ok(session.warnings.some((w) => w.code === "reaction-rejected"));
  assert.deepEqual(session.brief, brief);

  const trace = await reactTo(session, { kind: "pick", proposalId: "r1-d1-a1" });
  assert.equal(session.cursor.next, "done");
  assert.equal(trace.reactions.at(-1).kind, "pick");
  assert.equal(trace.decisions.at(-1).decision, "done");
});
