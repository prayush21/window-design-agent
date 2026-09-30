import { GUIDELINES, ROOM_TYPES } from "./guidelines.js";

// Deterministic reading of short user text ("warmer", "this is a nursery", "no
// blue"). Used by BRIEF for free-text preferences and by REACT for feedback.
//
// It is intentionally small and literal. Anything it does not understand is kept
// verbatim in preferences.text, which the LLM stages read, so nothing is lost; it
// just is not turned into a structured field. An LLM interpreter can replace this
// later behind the same return shape.

const ROOM_WORDS = {
  "living-room": ["living room", "lounge", "family room"],
  bedroom: ["bedroom", "guest room", "master bedroom"],
  "dining-room": ["dining room"],
  "home-office": ["home office", "office", "workspace", "work room"],
  "kids-room": ["kid's room", "kids room", "kids' room", "child's room", "playroom"],
  kitchen: ["kitchen"],
  bathroom: ["bathroom", "washroom", "powder room"],
  "breakfast-nook": ["breakfast nook", "nook"],
  nursery: ["nursery", "baby's room", "baby room"],
  study: ["study", "library"],
  closet: ["closet", "wardrobe"],
  pantry: ["pantry"],
  basement: ["basement"],
  entry: ["entry", "entryway", "foyer"],
  "mud-room": ["mud room", "mudroom"],
  hall: ["hall", "hallway", "corridor"],
  "media-room": ["media room", "home theater", "home theatre", "tv room"],
  "laundry-room": ["laundry room", "laundry"],
  garage: ["garage"],
  sunroom: ["sunroom", "sun room", "conservatory"]
};

const COLOUR_WORDS = ["white", "off-white", "beige", "gray", "grey", "black", "brown", "green", "blue", "pink", "purple", "red", "yellow", "orange"];
const STYLE_WORDS = ["modern", "minimal", "minimalist", "classic", "traditional", "rustic", "coastal", "industrial", "scandinavian", "bohemian", "cozy", "airy", "earthy", "natural", "bold", "calm", "elegant", "playful"];

export function parseUserText(text) {
  const raw = String(text || "").trim();
  const t = ` ${raw.toLowerCase().replace(/[’]/g, "'")} `;
  const result = { roomType: null, warmth: null, lightness: null, needs: {}, avoidColours: [], styleTags: [], matched: [] };
  if (!raw) return result;

  // Room type: longest phrase wins, so "home office" beats "office".
  let best = null;
  for (const roomType of ROOM_TYPES) {
    for (const phrase of ROOM_WORDS[roomType] || [GUIDELINES.rooms[roomType].label.toLowerCase()]) {
      if (t.includes(` ${phrase} `) || t.includes(` ${phrase}.`) || t.includes(` ${phrase},`)) {
        if (!best || phrase.length > best.phrase.length) best = { roomType, phrase };
      }
    }
  }
  if (best) {
    result.roomType = best.roomType;
    result.matched.push(`roomType:${best.phrase}`);
  }

  if (/\b(warmer|warm|cosier|cozier)\b/.test(t)) {
    result.warmth = "warm";
    result.matched.push("warmth:warm");
  } else if (/\b(cooler|cool|crisper)\b/.test(t)) {
    result.warmth = "cool";
    result.matched.push("warmth:cool");
  }

  if (/\b(lighter|brighter|paler)\b/.test(t)) {
    result.lightness = "lighter";
    result.matched.push("lightness:lighter");
  } else if (/\b(darker|deeper|richer)\b/.test(t)) {
    result.lightness = "darker";
    result.matched.push("lightness:darker");
  }

  if (/\b(blackout|pitch dark|room darkening|sleep in|night shift)\b/.test(t)) {
    result.needs.blackout = "high";
    result.matched.push("needs.blackout:high");
  }
  if (/\b(privacy|private|neighbou?rs can see|street facing)\b/.test(t)) {
    result.needs.privacy = "high";
    result.matched.push("needs.privacy:high");
  }
  if (/\b(glare|screen|monitor)\b/.test(t)) {
    result.needs.glare = "high";
    result.matched.push("needs.glare:high");
  }
  if (/\b(baby|toddler|child|kids?|pets?|cordless)\b/.test(t)) {
    result.needs.safety = "high";
    result.matched.push("needs.safety:high");
  }
  if (/\b(humid|steam|moisture|shower|damp)\b/.test(t)) {
    result.needs.moisture = "high";
    result.matched.push("needs.moisture:high");
  }

  for (const colour of COLOUR_WORDS) {
    const re = new RegExp(`\\b(no|not|avoid|hate|without|nothing)\\s+(\\w+\\s+)?${colour}\\b`);
    if (re.test(t)) {
      const normalized = colour === "grey" ? "gray" : colour;
      if (!result.avoidColours.includes(normalized)) result.avoidColours.push(normalized);
      result.matched.push(`avoidColours:${normalized}`);
    }
  }

  for (const style of STYLE_WORDS) {
    if (new RegExp(`\\b${style}\\b`).test(t) && !(style === "cozy" && result.warmth === "warm")) {
      result.styleTags.push(style);
    }
  }

  return result;
}
