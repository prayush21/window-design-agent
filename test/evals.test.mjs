import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePath } from "../src/v2/config.js";
import { evaluate } from "../src/eval/v2-run.js";
import { listRenders, readCritiqueLabels, readPairwise, saveCritiqueLabel, savePairwise, v1TopPicks } from "../src/eval/v2-labels.js";
import { createAppServer } from "../src/server.js";
import { runAllRooms, testCatalog, testConfig } from "./helpers.mjs";

const config = testConfig();
const catalog = await testCatalog(config);
const runs = await runAllRooms(config);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v2-evals-"));

test("per-stage metrics compute over mock traces, next to their no-model baselines", async () => {
  const result = await evaluate({ dir: resolvePath(config, "traces"), config });
  assert.equal(result.traces, runs.length);
  assert.equal(result.compliance.rate, 1, "every proposal is in an allowed category");
  assert.ok(result.diversity.model > 0.6 && typeof result.diversity.baseline === "number");
  assert.ok(result.faithfulness.renders >= 15);
  assert.ok(result.faithfulness.passRate < 1, "the off-colour fixture is counted");
  assert.equal(typeof result.perception.baseline, "number", "no-model perception is scored");
});

test("critique labels: stored by render key, joined to model verdicts, baseline is always-accept", () => {
  const file = path.join(tmp, "critique-labels.json");
  const traces = runs.map((r) => r.trace);
  const renders = listRenders(traces, {});
  const critiqued = renders.filter((r) => r.critique?.source === "model");
  assert.ok(critiqued.length >= 10);
  saveCritiqueLabel(file, { cacheKey: critiqued[0].cacheKey, verdict: "reject" });
  saveCritiqueLabel(file, { cacheKey: critiqued[1].cacheKey, verdict: "accept" });
  assert.throws(() => saveCritiqueLabel(file, { cacheKey: "zz", verdict: "maybe" }));
  const labels = readCritiqueLabels(file).labels;
  assert.equal(Object.keys(labels).length, 2);
  assert.ok(listRenders(traces, labels).some((r) => r.label?.verdict === "reject"));
});

test("pairwise judgments are stored with which side was which", () => {
  const file = path.join(tmp, "pairwise.json");
  savePairwise(file, { roomId: "uploaded_room", winner: "v2", leftWas: "v1", v1: { variantId: "a" }, v2: { variantId: "b" } });
  assert.throws(() => savePairwise(file, { roomId: "x", winner: "left", leftWas: "v1" }));
  assert.equal(readPairwise(file).judgments.length, 1);
});

test("v1 top picks skip baseline runs and IDs from the old catalog", () => {
  const dir = path.join(tmp, "runs");
  const write = (runId, report) => {
    fs.mkdirSync(path.join(dir, runId), { recursive: true });
    fs.writeFileSync(path.join(dir, runId, "report.json"), JSON.stringify(report));
  };
  write("2026-01-01", { provider: "gemini", scores: [{ caseId: "IMG_4297", chosen: "ZH-413-beige" }, { caseId: "IMG_4298", chosen: "RMS26003-P03" }] });
  write("2026-01-02", { provider: "baseline:random", scores: [{ caseId: "IMG_4298", chosen: "CES26001-P03" }] });
  const { picks, skipped } = v1TopPicks(dir, catalog);
  assert.equal(picks.IMG_4298.variantId, "RMS26003-P03");
  assert.equal(picks.IMG_4297, undefined);
  assert.equal(skipped[0].variantId, "ZH-413-beige");
});

test("the v2 API streams a mock session, and the eval pages and endpoints are served", async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(`${base}/api/v2/config`)).json();
    assert.equal(config.mode, "mock");
    assert.deepEqual(config.orchestrators, ["workflow"]);

    const response = await fetch(`${base}/api/v2/sessions?orchestrator=workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: "living-room-window" })
    });
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const final = events.at(-1);
    assert.equal(final.type, "final");
    assert.equal(final.session.presentation.items.length, 3);
    assert.ok(events.some((e) => e.type === "decision"));

    const react = await fetch(`${base}/api/v2/sessions/${final.session.sessionId}/react`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reaction: { kind: "pick", proposalId: final.session.presentation.items[0].proposalId } })
    });
    const after = (await react.text()).trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(after.session.cursor.next, "done");

    for (const page of ["/v2/", "/v2/label-critique.html", "/v2/compare.html", "/v2/app.js"]) {
      assert.equal((await fetch(base + page)).status, 200, page);
    }
    assert.ok(Array.isArray((await (await fetch(`${base}/api/v2/eval/renders`)).json()).renders));
    assert.ok(Array.isArray((await (await fetch(`${base}/api/v2/eval/pairs`)).json()).pairs));
    assert.equal((await (await fetch(`${base}/api/v2/tools`)).json()).tools.length, 10);
  } finally {
    server.close();
  }
});
