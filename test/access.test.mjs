import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { createAccessGate } from "../src/access.js";

// The gate in front of a stub app, so nothing paid can run. Requests carrying a
// Cf-Connecting-Ip header stand in for traffic arriving through the tunnel.

async function withGate(env, fn) {
  const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "access-")), "usage.json");
  const gate = createAccessGate({ env, usageFile });
  const server = http.createServer(async (req, res) => {
    if (await gate(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("app");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const remote = (ip = "203.0.113.5", extra = {}) => ({ "cf-connecting-ip": ip, ...extra });

async function login(base, passcode, ip) {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { ...remote(ip), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ passcode, next: "/v2/" })
  });
  return { response, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}

test("gate is off without ACCESS_PASSCODE", async () => {
  await withGate({}, async (base) => {
    assert.equal((await fetch(`${base}/x`, { headers: remote() })).status, 200);
  });
});

test("remote requests need the passcode; the owner on loopback does not", async () => {
  await withGate({ ACCESS_PASSCODE: "s3cret" }, async (base) => {
    assert.equal((await fetch(`${base}/x`)).status, 200);
    assert.equal((await fetch(`${base}/healthz`, { headers: remote() })).status, 200);
    assert.equal((await fetch(`${base}/api/v2/config`, { headers: remote() })).status, 401);
    const page = await fetch(`${base}/v2/`, { headers: remote("203.0.113.5", { accept: "text/html" }), redirect: "manual" });
    assert.equal(page.status, 302);
    assert.match(page.headers.get("location"), /^\/login\?next=/);

    assert.equal((await login(base, "wrong")).response.status, 401);
    const { response, cookie } = await login(base, "s3cret");
    assert.equal(response.status, 303);
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await fetch(`${base}/api/v2/config`, { headers: remote("203.0.113.5", { cookie }) })).status, 200);
    assert.equal((await fetch(`${base}/api/v2/config`, { headers: remote("203.0.113.5", { cookie: "da_access=forged" }) })).status, 401);
  });
});

test("five wrong passcodes lock that address out, even for the right one", async () => {
  await withGate({ ACCESS_PASSCODE: "s3cret" }, async (base) => {
    for (let i = 0; i < 5; i++) await login(base, "nope", "198.51.100.9");
    assert.equal((await login(base, "s3cret", "198.51.100.9")).response.status, 429);
    assert.equal((await login(base, "s3cret", "198.51.100.10")).response.status, 303);
  });
});

test("labelling routes are owner-only", async () => {
  await withGate({ ACCESS_PASSCODE: "s3cret" }, async (base) => {
    const { cookie } = await login(base, "s3cret");
    const headers = remote("203.0.113.5", { cookie });
    assert.equal((await fetch(`${base}/api/eval/cases`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/v2/eval/renders`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/eval/cases`)).status, 200);
  });
});

test("paid routes are capped per address and per day when live; mock is uncounted", async () => {
  const env = { ACCESS_PASSCODE: "s3cret", DESIGN_AGENT_LIVE: "1", PER_IP_DAILY_LIMIT: "2", DAILY_RUN_LIMIT: "3" };
  await withGate(env, async (base) => {
    const post = (ip, cookie) => fetch(`${base}/api/v2/sessions`, { method: "POST", headers: remote(ip, { cookie }) });
    const a = (await login(base, "s3cret", "192.0.2.1")).cookie;
    assert.equal((await post("192.0.2.1", a)).status, 200);
    assert.equal((await post("192.0.2.1", a)).status, 200);
    assert.equal((await post("192.0.2.1", a)).status, 429);
    assert.equal((await post("192.0.2.2", a)).status, 200);
    assert.equal((await post("192.0.2.3", a)).status, 429, "global cap of 3 reached");
    assert.equal((await fetch(`${base}/api/v2/sessions`, { method: "POST" })).status, 200, "owner is never capped");
  });
  await withGate({ ...env, DESIGN_AGENT_LIVE: "0", PER_IP_DAILY_LIMIT: "1" }, async (base) => {
    const { cookie } = await login(base, "s3cret", "192.0.2.1");
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(`${base}/api/v2/sessions`, { method: "POST", headers: remote("192.0.2.1", { cookie }) })).status, 200);
    }
  });
});
