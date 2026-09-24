import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { roomLayers } from "../src/v2/guidelines.js";
import { axisDifferences } from "../src/v2/stages/plan.js";
import { validate } from "../src/v2/schemas/index.js";
import { resolvePath } from "../src/v2/config.js";
import { evalRooms, newSession, runAllRooms, testCatalog, testConfig } from "./helpers.mjs";
import { runSession } from "../src/v2/engine.js";

// Offline check 4: the full orchestrator on every fixture room, mock mode.
const config = testConfig();
const catalog = await testCatalog(config);
const runs = await runAllRooms(config);

test("one trace per room, each valid against the trace schema", () => {
  assert.equal(runs.length, 5);
  for (const { trace, room } of runs) {
    assert.deepEqual(validate("v2.trace", trace), [], room.id);
    assert.equal(trace.traceSchemaErrors, undefined);
    assert.equal(trace.orchestrator, "workflow");
    assert.equal(trace.mode, "mock");
  }
});

test("every Brief field has a provenance tag", () => {
  for (const { session } of runs) {
    const walk = (node, at) => {
      if (node && typeof node === "object" && "value" in node) {
        assert.ok(["stated", "inferred", "assumed"].includes(node.source), `${at} source`);
        assert.equal(typeof node.confidence, "number", `${at} confidence`);
        return;
      }
      for (const [key, child] of Object.entries(node)) walk(child, `${at}.${key}`);
    };
    walk(session.brief, "brief");
  }
});

test("3 directions per session, pairwise different on at least 2 axes, all categories allowed", () => {
  for (const { session, room } of runs) {
    assert.equal(session.directions.length, 3, room.id);
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 3; j += 1) {
        assert.ok(axisDifferences(session.directions[i], session.directions[j]).count >= 2, `${room.id} d${i}/d${j}`);
      }
    }
    const allowed = roomLayers(session.brief.roomType.value);
    for (const d of session.directions) {
      for (const c of d.layers.visual) assert.ok(allowed.visual.includes(c), `${room.id} ${d.id} ${c}`);
      for (const c of d.layers.functional || []) assert.ok(allowed.functional.includes(c), `${room.id} ${d.id} ${c}`);
    }
  }
});

test("every returned ID exists in the catalog", () => {
  for (const { session } of runs) {
    for (const shortlist of Object.values(session.shortlists)) {
      for (const layer of Object.values(shortlist.layers)) {
        for (const c of layer?.candidates || []) assert.ok(catalog.getVariant(c.productId, c.variantId), c.variantId);
      }
    }
    for (const proposal of session.proposals) {
      assert.ok(catalog.getVariant(proposal.visual.productId, proposal.visual.variantId), proposal.visual.variantId);
      if (proposal.functional) assert.ok(catalog.getVariant(proposal.functional.productId, proposal.functional.variantId));
    }
  }
});

test("broken fixtures produce visible warnings, never a crash", () => {
  const byRoom = Object.fromEntries(runs.map((r) => [r.room.id, r.session.warnings]));
  const has = (room, stage, code) => byRoom[room].some((w) => w.stage === stage && w.code === code);
  assert.ok(has("IMG_4297", "perceive", "retry"), "invalid JSON → retry warning");
  assert.ok(has("indy-window", "plan", "retry"), "missing field → retry warning");
  assert.ok(has("indy-window", "plan", "repaired"), "disallowed category → repair warning");
  assert.ok(has("IMG_4298", "compose", "fallback"), "unknown variant ID twice → visible fallback");
  assert.ok(byRoom.IMG_4298.filter((w) => w.stage === "compose" && w.code === "retry").length >= 2, "missing rationale → retry");
  for (const { trace } of runs) {
    // Every warning in the session is also in the trace.
    assert.equal(trace.warnings.length, runs.find((r) => r.trace === trace).session.warnings.length);
  }
});

test("every proposal is rendered (visual layer only) and the render budget is respected", () => {
  for (const { session, trace, room } of runs) {
    assert.ok(session.proposals.length >= 3, room.id);
    for (const proposal of session.proposals.filter((p) => p.status !== "dropped")) {
      const renders = session.renders.filter((r) => r.proposalId === proposal.proposalId);
      assert.ok(renders.length >= 1, `${proposal.proposalId} rendered`);
      for (const r of renders) {
        assert.equal(r.variantId, proposal.visual.variantId, "only the visual layer is rendered");
        assert.ok(fs.existsSync(path.join(resolvePath(config, "renders"), r.imagePath)), r.imagePath);
      }
    }
    const perRound = {};
    for (const stage of trace.stages.filter((s) => s.kind === "image")) perRound[stage.round] = (perRound[stage.round] || 0) + 1;
    for (const count of Object.values(perRound)) assert.ok(count <= config.budget.maxRenders, `${room.id}: ${count} renders`);
    assert.ok(session.presentation.items.length >= 2 && session.presentation.items.length <= 3, room.id);
  }
});

test("a fallback proposal is visible as such in the presentation", () => {
  const { session } = runs.find((r) => r.room.id === "IMG_4298");
  const fallback = session.proposals.find((p) => p.source === "fallback");
  assert.ok(fallback, "IMG_4298 has a fallback proposal");
  assert.equal(fallback.visual.variantId, session.shortlists[fallback.directionId].layers.visual.candidates[0].variantId);
});

test("critique loop: off-colour render is re-rendered, REVISE yields a new variant, DROP is never shown", () => {
  const lrw = runs.find((r) => r.room.id === "living-room-window").session;
  const failed = lrw.faithfulness.filter((f) => !f.pass);
  assert.equal(failed.length, 1, "one off-colour render");
  assert.ok(lrw.faithfulness.some((f) => f.proposalId === failed[0].proposalId && f.pass), "re-render passed");
  assert.ok(lrw.warnings.some((w) => w.code === "render-off-colour"), "off-colour render is a visible warning");
  assert.ok(lrw.decisions.some((d) => d.policy === "render-check" && d.decision === "rerender"));
  const revised = lrw.proposals.find((p) => p.status === "revised");
  const next = lrw.proposals.find((p) => p.directionId === revised.directionId && p.attempt === revised.attempt + 1);
  assert.ok(next && next.excluded.includes(revised.visual.variantId), "revision excludes the rejected variant");
  assert.equal(next.status, "accepted");

  const up = runs.find((r) => r.room.id === "uploaded_room").session;
  const dropped = up.proposals.find((p) => p.status === "dropped");
  assert.ok(dropped);
  assert.ok(!up.presentation.items.some((i) => i.proposalId === dropped.proposalId), "dropped proposals are not presented");
  const unreviewed = up.presentation.items.find((i) => i.status === "unreviewed");
  assert.ok(unreviewed, "a failed critique is shown as unreviewed, not as accepted");
  assert.ok(up.warnings.some((w) => w.stage === "critique" && w.code === "fallback"));

  const img = runs.find((r) => r.room.id === "IMG_4297").session;
  assert.ok(img.warnings.some((w) => w.stage === "critique" && w.code === "retry"), "ACCEPT with a low score is retried");
});

test("every presented item is accepted or visibly marked otherwise", () => {
  for (const { session } of runs) {
    for (const item of session.presentation.items) {
      const proposal = session.proposals.find((p) => p.proposalId === item.proposalId);
      if (item.status === "accepted") assert.equal(proposal.status, "accepted");
      else assert.ok(["unreviewed", "unapproved"].includes(item.status));
    }
  }
});

test("a tight render budget is respected and every refusal is a visible warning", async () => {
  const tight = testConfig({ budget: { maxRenders: 3, maxRevisionsPerDirection: 2 } });
  const room = evalRooms().find((r) => r.id === "living-room-window");
  const session = newSession(room);
  await runSession(session, { config: tight });
  assert.ok(session.budget.rendersUsed <= 3, `used ${session.budget.rendersUsed}`);
  const refusals = session.warnings.filter((w) => w.code === "render-budget").length;
  const stopped = session.decisions.filter((d) => /budget/.test(d.reason)).length;
  assert.ok(refusals + stopped > 0, "the budget visibly limited the run");
});

test("mock mode makes no paid calls: every model attempt went to the mock provider", () => {
  for (const { trace } of runs) {
    for (const stage of trace.stages) {
      for (const attempt of stage.attempts) {
        if (attempt.provider) assert.equal(attempt.provider, "mock", `${stage.stage}`);
        if (attempt.costUsd !== null) assert.equal(attempt.costUsd, 0);
      }
    }
  }
});

