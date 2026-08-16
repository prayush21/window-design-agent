import fs from "node:fs";
import path from "node:path";
import { getMimeType } from "../catalog.js";

// Dev-only endpoints backing the labeling page at /eval-label.html.
// Namespaced under /api/eval/ and /eval-rooms/ so they are easy to gate or drop later.

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function evalPaths(rootDir) {
  const evalsDir = path.join(rootDir, "evals");
  return {
    evalsDir,
    roomsDir: path.join(evalsDir, "rooms"),
    casesFile: path.join(evalsDir, "cases.json"),
    runsDir: path.join(evalsDir, "runs"),
    cacheDir: path.join(evalsDir, "cache")
  };
}

export function listRoomPhotos(roomsDir) {
  if (!fs.existsSync(roomsDir)) return [];

  return fs
    .readdirSync(roomsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => ({
      id: path.parse(fileName).name,
      fileName,
      photo: `rooms/${fileName}`,
      url: `/eval-rooms/${encodeURIComponent(fileName)}`
    }));
}

export function emptyCase(room) {
  return {
    id: room.id,
    photo: room.photo,
    notes: "",
    expectFailure: false,
    labels: { acceptable: [], unacceptable: [], ideal: [] }
  };
}

export function readCases(casesFile) {
  if (!fs.existsSync(casesFile)) return { version: 1, cases: [] };

  try {
    const parsed = JSON.parse(fs.readFileSync(casesFile, "utf8"));
    return { version: parsed.version || 1, cases: Array.isArray(parsed.cases) ? parsed.cases : [] };
  } catch (error) {
    throw new Error(`Invalid ${casesFile}: ${error.message}`);
  }
}

// Photos are the source of truth: every photo gets a case, and cases whose
// photo disappeared are dropped so stale labels never score against nothing.
export function reconcileCases(casesFile, roomsDir) {
  const rooms = listRoomPhotos(roomsDir);
  const existing = readCases(casesFile);
  const byId = new Map(existing.cases.map((testCase) => [testCase.id, testCase]));

  return {
    version: existing.version,
    cases: rooms.map((room) => {
      const found = byId.get(room.id);
      if (!found) return emptyCase(room);
      return {
        ...emptyCase(room),
        ...found,
        photo: room.photo,
        labels: { ...emptyCase(room).labels, ...(found.labels || {}) }
      };
    })
  };
}

export async function handleEvalRequest(req, res, { rootDir }) {
  const { roomsDir, casesFile } = evalPaths(rootDir);
  const url = req.url || "";

  if (req.method === "GET" && url === "/api/eval/cases") {
    sendJson(res, reconcileCases(casesFile, roomsDir));
    return true;
  }

  if (req.method === "POST" && url === "/api/eval/cases") {
    const body = await readJson(req);
    if (!Array.isArray(body?.cases)) {
      sendJson(res, { error: "Expected { cases: [...] }." }, 400);
      return true;
    }

    fs.mkdirSync(path.dirname(casesFile), { recursive: true });
    fs.writeFileSync(
      casesFile,
      `${JSON.stringify({ version: 1, cases: body.cases.map(sanitizeCase) }, null, 2)}\n`
    );
    sendJson(res, { saved: true, caseCount: body.cases.length });
    return true;
  }

  if (req.method === "GET" && url.startsWith("/eval-rooms/")) {
    const fileName = path.basename(decodeURIComponent(url.replace(/^\/eval-rooms\//, "")));
    const filePath = path.join(roomsDir, fileName);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(res, { error: "Not found." }, 404);
      return true;
    }

    res.writeHead(200, { "Content-Type": getMimeType(filePath), "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}

function sanitizeCase(testCase) {
  const labels = testCase.labels || {};
  return {
    id: String(testCase.id),
    photo: String(testCase.photo),
    notes: String(testCase.notes || ""),
    expectFailure: Boolean(testCase.expectFailure),
    labels: {
      acceptable: toIdArray(labels.acceptable),
      unacceptable: toIdArray(labels.unacceptable),
      ideal: toIdArray(labels.ideal)
    }
  };
}

function toIdArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(String))] : [];
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
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}
