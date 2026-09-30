import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT_DIR, catalogDir, resolveConfig, resolvePath } from "../src/v2/config.js";
import { loadCatalogIndex } from "../src/v2/catalog-index.js";
import { evalPaths, listRoomPhotos } from "../src/eval/label-api.js";
import { runSession } from "../src/v2/engine.js";
import { createSession } from "../src/v2/session.js";

// Tests write traces and renders to a temp dir, never to the repo's traces/.
export function testConfig(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v2-test-"));
  return resolveConfig(
    {
      mode: "mock",
      ...overrides,
      paths: { traces: path.join(tmp, "traces"), renders: path.join(tmp, "renders"), uploads: path.join(tmp, "uploads"), ...(overrides.paths || {}) }
    },
    { ...process.env, DESIGN_AGENT_LIVE: "0" }
  );
}

export async function testCatalog(config) {
  return loadCatalogIndex({ catalogDir: catalogDir(), cacheDir: resolvePath(config, "cache") });
}

export function evalRooms() {
  return listRoomPhotos(evalPaths(ROOT_DIR).roomsDir);
}

export function newSession(room, userInput = {}) {
  return createSession({ roomPhotoPath: path.join("evals", room.photo), roomId: room.id, userInput });
}

export async function runAllRooms(config) {
  const results = [];
  for (const room of evalRooms()) {
    const session = newSession(room);
    const { traceFile, events } = await runSession(session, { config });
    results.push({ room, session, events, trace: JSON.parse(fs.readFileSync(traceFile, "utf8")), traceFile });
  }
  return results;
}

export { ROOT_DIR };
