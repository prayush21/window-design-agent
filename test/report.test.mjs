import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePath } from "../src/v2/config.js";
import { buildReport } from "../src/v2/report/build.js";
import { runAllRooms, testConfig } from "./helpers.mjs";

// Offline check 7: the review report builds from mock traces.
test("the review report builds from mock traces and shows every session", async () => {
  const config = testConfig();
  const runs = await runAllRooms(config);
  const { html, count } = await buildReport({ dir: resolvePath(config, "traces"), config });
  assert.equal(count, runs.length);
  assert.match(html, /Mock data/);
  for (const { session } of runs) {
    assert.ok(html.includes(session.sessionId), session.sessionId);
    for (const d of session.directions) assert.ok(html.includes(d.title.replace(/&/g, "&amp;")), d.title);
  }
  // Warnings from the broken fixtures are visible in the report, not just the trace.
  assert.match(html, /retry/);
  assert.match(html, /repaired/);
});
