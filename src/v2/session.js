import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.js";
import { assertValid } from "./schemas/index.js";

// A Session is the whole state of one design conversation, as plain JSON. An
// orchestrator reads it, runs stages, and writes their outputs back. Because it is
// serializable and validated, it can be saved at any stage boundary and resumed by
// any orchestrator (or by running a single stage by hand).

export function createSession({ roomPhotoPath, roomId = null, userInput = {}, sessionId = null }) {
  const absolute = path.resolve(ROOT_DIR, roomPhotoPath);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");

  const session = {
    sessionVersion: 1,
    sessionId: sessionId || makeSessionId(roomId || "room"),
    createdAt: new Date().toISOString(),
    orchestrator: null,
    input: {
      roomPhoto: { path: path.relative(ROOT_DIR, absolute), sha256, roomId },
      userInput: {
        text: userInput.text ?? null,
        roomType: userInput.roomType ?? null,
        references: userInput.references ?? []
      }
    },
    round: 1,
    cursor: { next: "perceive", directionIds: null },
    environment: null,
    brief: null,
    directions: [],
    shortlists: {},
    proposals: [],
    renders: [],
    faithfulness: [],
    critiques: [],
    presentation: null,
    reactions: [],
    decisions: [],
    history: [],
    warnings: [],
    budget: { rendersUsed: 0, revisions: {} }
  };
  assertValid("v2.session", session, "new session");
  return session;
}

export function roomPhotoAbsolute(session) {
  return path.resolve(ROOT_DIR, session.input.roomPhoto.path);
}

export function photoKey(session) {
  return session.input.roomPhoto.sha256.slice(0, 16);
}

export function saveSession(session, dir) {
  assertValid("v2.session", session, `session ${session.sessionId}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session.sessionId}.session.json`);
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`);
  return file;
}

export function loadSession(file) {
  const session = JSON.parse(fs.readFileSync(file, "utf8"));
  assertValid("v2.session", session, `session file ${file}`);
  return session;
}

/**
 * Moves the current round's working state into history and starts a new round.
 * Brief and reactions carry over; directions onward are rebuilt as needed.
 */
export function archiveRound(session, { keepDirections = false } = {}) {
  session.history.push({
    round: session.round,
    directions: session.directions,
    presentation: session.presentation,
    proposalIds: session.proposals.map((p) => p.proposalId)
  });
  session.round += 1;
  session.presentation = null;
  session.budget = { rendersUsed: 0, revisions: {} };
  if (!keepDirections) {
    session.directions = [];
    session.shortlists = {};
  }
}

export function addWarning(session, warning) {
  const entry = { at: new Date().toISOString(), stage: null, ...warning };
  session.warnings.push(entry);
  return entry;
}

function makeSessionId(label) {
  const slug = String(label).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "room";
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${slug}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}
