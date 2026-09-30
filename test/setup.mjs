// Loaded before every test file (npm test uses --import). Blocks the network: any
// fetch to a host other than localhost throws, so a test can never make a paid call
// even by accident. Also pins mock mode regardless of the developer's shell.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`Network blocked in tests: attempted fetch to ${url.origin}`);
  }
  return realFetch(input, init);
};

process.env.DESIGN_AGENT_LIVE = "0";

// Anything that uses the default config (e.g. the API smoke test) writes here, not
// into the repo's traces/ folder.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "v2-test-out-"));
process.env.V2_TRACES_DIR = path.join(scratch, "traces");
process.env.V2_RENDERS_DIR = path.join(scratch, "renders");
process.env.V2_UPLOADS_DIR = path.join(scratch, "uploads");
