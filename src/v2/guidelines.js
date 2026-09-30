import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Read-only access to the derived guideline data in data/. Everything that decides
// which categories a room may use goes through here, so the rule has one home.

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const GUIDELINES = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "data", "guidelines.json"), "utf8"));
export const CATEGORY_ROLES = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "data", "category-roles.json"), "utf8"));
export const ROOM_TYPES = Object.keys(GUIDELINES.rooms);

/**
 * The layers a direction may use for a room type.
 *
 * Single-layer rooms (nursery, closet, basement, …) list one set of categories. That
 * set is the room's primary covering, so it becomes the visual layer and the
 * functional layer is unavailable (null). See docs/v2-design.md, "Single-layer rooms".
 */
export function roomLayers(roomType) {
  const room = GUIDELINES.rooms[roomType];
  if (!room) return null;

  const visual = room.visual.categories;
  const functional = room.functional.categories;

  if (visual.length === 0) {
    return { visual: functional, functional: null, singleLayer: "functional-as-primary" };
  }
  return { visual, functional: functional.length > 0 ? functional : null, singleLayer: functional.length > 0 ? null : "visual-only" };
}

export function roomNeedsProfile(roomType) {
  return GUIDELINES.rooms[roomType]?.needsProfile ?? null;
}

export function roomLabel(roomType) {
  return GUIDELINES.rooms[roomType]?.label ?? roomType;
}

export function unmappedFor(roomType) {
  return GUIDELINES.unmapped.filter((entry) => entry.rooms.includes(roomType)).map((entry) => entry.name);
}

export function isAllowed(roomType, layer, category) {
  const layers = roomLayers(roomType);
  const allowed = layers?.[layer];
  return Array.isArray(allowed) && allowed.includes(category);
}
