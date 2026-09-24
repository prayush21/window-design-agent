import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSchema } from "../src/v2/schemas/index.js";
import { runSingleStage, runSession } from "../src/v2/engine.js";
import { getOrchestrator } from "../src/v2/orchestrators/index.js";
import { loadSession, saveSession } from "../src/v2/session.js";
import { STAGES, toolDefinitions } from "../src/v2/stages/index.js";
import { evalRooms, newSession, testConfig } from "./helpers.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const config = testConfig();

test("the registry exports tool definitions with self-contained input schemas", () => {
  const tools = toolDefinitions();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(STAGES).sort());
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} description`);
    assert.ok(!JSON.stringify(tool.inputSchema).includes('"$ref"'), `${tool.name} has no dangling $ref`);
    assert.ok(compileSchema(tool.inputSchema), `${tool.name} schema compiles standalone`);
  }
});

test("orchestrators are chosen by name and unknown ones are refused", () => {
  assert.equal(getOrchestrator("workflow").name, "workflow");
  assert.throws(() => getOrchestrator("agent"), /Unknown orchestrator/);
});

test("any single stage runs alone from a saved Session plus its input", async () => {
  const room = evalRooms().find((r) => r.id === "uploaded_room");
  const session = newSession(room);
  await runSession(session, { config });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-session-"));
  const saved = loadSession(saveSession(session, dir));

  const direction = saved.directions[1];
  const alone = await runSingleStage("retrieve", { brief: saved.brief, direction }, { config });
  assert.deepEqual(alone.output, saved.shortlists[direction.id], "RETRIEVE alone reproduces the orchestrated shortlist");

  const brief = await runSingleStage("brief", { environment: saved.environment, userInput: saved.input.userInput }, { config });
  assert.deepEqual(brief.output, saved.brief);

  const plan = await runSingleStage("plan", { brief: saved.brief, previousDirections: [] }, { config });
  assert.deepEqual(plan.output.directions, saved.directions);

  const d1 = saved.directions[0];
  const composeInput = { brief: saved.brief, direction: d1, shortlist: saved.shortlists[d1.id], roomPhoto: saved.input.roomPhoto, round: 1, attempt: 1, exclude: [], feedback: null };
  const compose = await runSingleStage("compose", composeInput, { config, meta: { directionId: d1.id } });
  const { status: _s1, ...composed } = compose.output;
  const { status: _s2, ...original } = saved.proposals.find((p) => p.proposalId === compose.output.proposalId);
  assert.deepEqual(composed, original, "COMPOSE alone reproduces the orchestrated proposal");

  const render = await runSingleStage("render", { roomPhoto: saved.input.roomPhoto, proposal: compose.output, windowRegion: saved.brief.windowRegion.value, attempt: 1 }, { config });
  assert.equal(render.output.cacheKey, saved.renders.find((r) => r.proposalId === compose.output.proposalId && r.attempt === 1).cacheKey);
});

test("a session resumes from its cursor (re-enter at a stage boundary)", async () => {
  const room = evalRooms().find((r) => r.id === "living-room-window");
  const session = newSession(room);
  await runSession(session, { config });
  const directions = structuredClone(session.directions);

  // Rewind to RETRIEVE for one direction; everything upstream is reused, not re-run.
  session.shortlists = {};
  session.cursor = { next: "retrieve", directionIds: [directions[0].id] };
  const { events } = await runSession(session, { config });
  const stagesRun = events.filter((e) => e.type === "stage-start").map((e) => e.stage);
  assert.ok(!stagesRun.includes("perceive") && !stagesRun.includes("plan"), stagesRun.join(","));
  assert.ok(stagesRun.includes("retrieve"));
  assert.deepEqual(session.directions, directions);
});
