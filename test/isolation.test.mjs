import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { catalogDir, resolveConfig } from "../src/v2/config.js";
import { createProviders } from "../src/v2/providers.js";
import { createAppServer } from "../src/server.js";
import { runAllRooms, testConfig } from "./helpers.mjs";

// Offline check 6: the shared catalog is untouched by a full v2 run, v1's catalog
// route still answers on this server, and nothing can make a live call.

function catalogChecksum() {
  const dir = catalogDir();
  return execFileSync("/bin/sh", ["-c", '/usr/bin/find "$0" -type f -exec shasum {} + | LC_ALL=C sort | shasum', dir], { encoding: "utf8" }).trim();
}

test("a full mock run leaves the catalog byte-for-byte unchanged", async () => {
  const before = catalogChecksum();
  await runAllRooms(testConfig());
  assert.equal(catalogChecksum(), before);
});

test("v1 /api/catalog still responds on this worktree's server", async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.products.length >= 80);
  } finally {
    server.close();
  }
});

test("live mode is refused without DESIGN_AGENT_LIVE=1, and the provider refuses real calls in mock mode", async () => {
  assert.throws(() => resolveConfig({ mode: "live" }, { DESIGN_AGENT_LIVE: "0" }), /DESIGN_AGENT_LIVE=1/);
  const providers = createProviders({ ...testConfig(), mode: "live" }, { fixturesDir: "/nonexistent", env: { DESIGN_AGENT_LIVE: "0" } });
  await assert.rejects(() => providers.llm({ stage: "plan", blocks: [], fixtureKey: {} }), /Refused a real provider call/);
});

test("the network is blocked for external hosts", async () => {
  await assert.rejects(() => fetch("https://generativelanguage.googleapis.com/"), /Network blocked/);
  await assert.rejects(() => fetch("https://api.openai.com/v1/responses"), /Network blocked/);
});
