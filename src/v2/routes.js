import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMimeType } from "../catalog.js";
import { evalPaths, listRoomPhotos } from "../eval/label-api.js";
import { ROOT_DIR, resolveConfig, resolvePath } from "./config.js";
import { runSession } from "./engine.js";
import { ORCHESTRATORS } from "./orchestrators/index.js";
import { createSession, loadSession } from "./session.js";
import { toolDefinitions } from "./stages/index.js";
import { GUIDELINES } from "./guidelines.js";

// /api/v2/* and the v2 UI. Mounted by src/server.js ahead of v1's static handler;
// v1 routes are untouched. Mode comes from the environment: mock unless the user
// started the server with DESIGN_AGENT_LIVE=1.

const MAX_BODY_BYTES = 24 * 1024 * 1024;

export async function handleV2Request(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  try {
    if (req.method === "GET" && (url.pathname === "/v2" || url.pathname === "/v2/")) {
      return sendFile(res, path.join(ROOT_DIR, "public", "v2", "index.html"));
    }
    if (req.method === "GET" && url.pathname === "/v2/report") {
      const file = path.join(resolvePath(resolveConfig(), "traces"), "report", "index.html");
      if (!fs.existsSync(file)) return sendJson(res, { error: "No report yet. Run: npm run v2:report" }, 404);
      return sendFile(res, file);
    }
    if (req.method === "GET" && url.pathname.startsWith("/v2-renders/")) {
      const config = resolveConfig();
      return serveUnder(res, resolvePath(config, "renders"), url.pathname.replace(/^\/v2-renders\//, ""));
    }
    if (req.method === "GET" && url.pathname.startsWith("/v2-uploads/")) {
      const config = resolveConfig();
      return serveUnder(res, resolvePath(config, "uploads"), url.pathname.replace(/^\/v2-uploads\//, ""));
    }
    if (!url.pathname.startsWith("/api/v2/")) return false;

    if (route === "GET /api/v2/config") {
      const config = resolveConfig();
      return sendJson(res, {
        mode: config.mode,
        liveAllowed: config.liveAllowed,
        stages: config.stages,
        budget: config.budget,
        orchestrators: Object.keys(ORCHESTRATORS),
        roomTypes: Object.entries(GUIDELINES.rooms).map(([id, room]) => ({ id, label: room.label }))
      });
    }
    if (route === "GET /api/v2/rooms") {
      return sendJson(res, { rooms: listRoomPhotos(evalPaths(ROOT_DIR).roomsDir) });
    }
    if (route === "GET /api/v2/tools") {
      return sendJson(res, { tools: toolDefinitions() });
    }
    if (route === "POST /api/v2/sessions") {
      return await startSession(req, res, url);
    }
    const sessionMatch = url.pathname.match(/^\/api\/v2\/sessions\/([A-Za-z0-9_-]+)(\/react)?$/);
    if (sessionMatch && req.method === "GET" && !sessionMatch[2]) {
      return sendJson(res, readSession(sessionMatch[1]));
    }
    if (sessionMatch && req.method === "POST" && sessionMatch[2]) {
      return await reactToSession(req, res, url, sessionMatch[1]);
    }
    if (route === "GET /api/v2/traces") {
      return sendJson(res, { traces: listTraces() });
    }
    const traceMatch = url.pathname.match(/^\/api\/v2\/traces\/([A-Za-z0-9_-]+)$/);
    if (traceMatch && req.method === "GET") {
      const file = path.join(resolvePath(resolveConfig(), "traces"), `${traceMatch[1]}.json`);
      if (!fs.existsSync(file)) return sendJson(res, { error: "Trace not found." }, 404);
      return sendJson(res, JSON.parse(fs.readFileSync(file, "utf8")));
    }
    return sendJson(res, { error: `No v2 route for ${route}.` }, 404);
  } catch (error) {
    if (!res.headersSent) sendJson(res, { error: error.message }, 500);
    else res.end(`${JSON.stringify({ type: "error", message: error.message })}\n`);
    return true;
  }
}

async function startSession(req, res, url) {
  const body = await readJson(req);
  const config = resolveConfig();
  const orchestrator = url.searchParams.get("orchestrator") || body.orchestrator || "workflow";

  let roomPhotoPath;
  let roomId = null;
  if (body.roomId) {
    const room = listRoomPhotos(evalPaths(ROOT_DIR).roomsDir).find((r) => r.id === body.roomId);
    if (!room) return sendJson(res, { error: `Unknown room "${body.roomId}".` }, 400);
    roomPhotoPath = path.join("evals", room.photo);
    roomId = room.id;
  } else if (body.imageDataUrl) {
    roomPhotoPath = saveUpload(body.imageDataUrl, resolvePath(config, "uploads"));
  } else {
    return sendJson(res, { error: "Send roomId (an eval room) or imageDataUrl." }, 400);
  }

  const session = createSession({
    roomPhotoPath,
    roomId,
    userInput: { text: body.text || null, roomType: body.roomType || null }
  });
  return streamRun(res, session, { config, orchestrator });
}

async function reactToSession(req, res, url, sessionId) {
  const body = await readJson(req);
  const config = resolveConfig();
  const session = readSession(sessionId);
  session.pendingReaction = body.reaction;
  const orchestrator = url.searchParams.get("orchestrator") || session.orchestrator || "workflow";
  return streamRun(res, session, { config, orchestrator });
}

// Streams orchestrator events as NDJSON so the UI can show the brief, directions
// and renders as they arrive. The last line carries the whole session.
async function streamRun(res, session, { config, orchestrator }) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const write = (event) => res.write(`${JSON.stringify(event)}\n`);
  write({ type: "session", sessionId: session.sessionId, mode: config.mode, orchestrator, roomPhoto: photoUrl(session) });
  try {
    await runSession(session, { config, orchestrator, onEvent: write });
  } catch {
    // runSession already emitted an error event and saved the session.
  }
  write({ type: "final", session: publicSession(session) });
  res.end();
  return true;
}

function readSession(sessionId) {
  const config = resolveConfig();
  const file = path.join(resolvePath(config, "traces"), "sessions", `${sessionId}.session.json`);
  if (!fs.existsSync(file)) throw new Error(`Session ${sessionId} not found.`);
  return loadSession(file);
}

function publicSession(session) {
  return { ...session, roomPhotoUrl: photoUrl(session) };
}

function photoUrl(session) {
  const photo = session.input.roomPhoto;
  if (photo.roomId) return `/eval-rooms/${encodeURIComponent(path.basename(photo.path))}`;
  return `/v2-uploads/${encodeURIComponent(path.basename(photo.path))}`;
}

function listTraces() {
  const dir = resolvePath(resolveConfig(), "traces");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const trace = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return { sessionId: trace.sessionId, roomId: trace.roomPhoto?.roomId, mode: trace.mode, orchestrator: trace.orchestrator, updatedAt: trace.updatedAt };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function saveUpload(dataUrl, dir) {
  const match = String(dataUrl).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!match) throw new Error("imageDataUrl must be a base64 JPEG, PNG or WebP data URL.");
  const bytes = Buffer.from(match[2], "base64");
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha.slice(0, 24)}.${match[1] === "jpg" ? "jpeg" : match[1]}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return path.relative(ROOT_DIR, file);
}

function serveUnder(res, dir, relative) {
  const file = path.normalize(path.join(dir, decodeURIComponent(relative)));
  if (!file.startsWith(dir)) return sendJson(res, { error: "Forbidden." }, 403);
  return sendFile(res, file);
}

function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, { error: "Not found." }, 404);
  const type = file.endsWith(".html") ? "text/html; charset=utf-8" : getMimeType(file);
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
  return true;
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}
