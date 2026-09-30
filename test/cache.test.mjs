import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/v2/config.js";
import { createBudget, runStage } from "../src/v2/runtime.js";

// The live response cache and the "fresh run" toggle, with a fake model stage (no network).
function fakeStage() {
  let calls = 0;
  return {
    stage: {
      name: "plan",
      kind: "llm",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", required: ["n"] },
      async run() {
        calls += 1;
        return { n: calls };
      }
    },
    calls: () => calls
  };
}

function ctxFor(overrides) {
  const config = resolveConfig({ mode: "live", ...overrides }, { DESIGN_AGENT_LIVE: "1" });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-cache-"));
  return { config, cacheDir, budget: createBudget(config.budget, { rendersUsed: 0, revisions: {} }) };
}

test("live mode reuses a saved answer for identical input", async () => {
  const { stage, calls } = fakeStage();
  const ctx = ctxFor({});
  const first = await runStage(stage, { q: 1 }, ctx);
  const second = await runStage(stage, { q: 1 }, ctx);
  assert.equal(calls(), 1);
  assert.equal(first.outcome, "ok");
  assert.equal(second.outcome, "cached");
  assert.deepEqual(second.output, first.output);
});

test("a fresh run calls the model every time", async () => {
  const { stage, calls } = fakeStage();
  const ctx = ctxFor({ cache: { enabled: false } });
  await runStage(stage, { q: 1 }, ctx);
  const second = await runStage(stage, { q: 1 }, ctx);
  assert.equal(calls(), 2);
  assert.equal(second.outcome, "ok");
  assert.equal(fs.readdirSync(ctx.cacheDir).length, 0, "nothing written to the cache either");
});
