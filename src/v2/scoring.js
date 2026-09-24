import { deltaE2000, srgbToLab } from "../baseline/color.js";

// Deterministic scoring for RETRIEVE. All terms are in [0, 1] and reported
// separately (scoreParts), so a shortlist can be explained without a model.
//
// Colour strategies, each a different hypothesis about "goes with the room":
//   tonal          close to the room's dominant colours (v1's de2000-match)
//   contrast       a clear but not clashing distance (v1's de2000-contrast)
//   neutral-anchor low chroma, lightness near the dominant wall colour
//   complementary  hue opposite the room's main accent, with some chroma

const MATCH_DECAY = 25;
const CONTRAST_TARGET = 35;
const CONTRAST_WIDTH = 18;

export function hexToLab(hex) {
  const value = hex.replace("#", "");
  return srgbToLab([0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)));
}

export function preparePalette(palette) {
  const entries = palette.map((colour) => ({ ...colour, lab: hexToLab(colour.hex) }));
  const total = entries.reduce((sum, c) => sum + (c.weight || 0), 0) || entries.length;
  for (const entry of entries) entry.w = (entry.weight || (total === entries.length ? 1 : 0)) / total;
  const dominant = [...entries].sort((a, b) => b.w - a.w)[0];
  const accent = [...entries]
    .filter((c) => c.w >= 0.05)
    .sort((a, b) => chroma(b.lab) - chroma(a.lab))[0];
  return { entries, dominant, accent };
}

export function colourScore(strategy, variantLab, palette) {
  const { entries, dominant, accent } = palette;
  const weighted = (fn) => entries.reduce((sum, c) => sum + c.w * fn(deltaE2000(c.lab, variantLab)), 0);

  switch (strategy) {
    case "tonal":
      return weighted((dE) => Math.exp(-dE / MATCH_DECAY));
    case "contrast":
      return weighted((dE) => Math.exp(-((dE - CONTRAST_TARGET) ** 2) / (2 * CONTRAST_WIDTH ** 2)));
    case "neutral-anchor": {
      const neutrality = Math.exp(-chroma(variantLab) / 10);
      const closeness = Math.exp(-Math.abs(variantLab.L - dominant.lab.L) / 30);
      return neutrality * (0.4 + 0.6 * closeness);
    }
    case "complementary": {
      // With an all-neutral room, complement the dominant colour's hue instead.
      const anchor = accent && chroma(accent.lab) >= 8 ? accent : dominant;
      const target = (hue(anchor.lab) + 180) % 360;
      const distance = Math.min(Math.abs(hue(variantLab) - target), 360 - Math.abs(hue(variantLab) - target));
      const hueFit = Math.exp(-((distance / 40) ** 2));
      const hasColour = Math.min(1, chroma(variantLab) / 15);
      const lightness = Math.exp(-Math.abs(variantLab.L - dominant.lab.L) / 50);
      return hueFit * hasColour * (0.5 + 0.5 * lightness);
    }
    default:
      throw new Error(`Unknown colour strategy "${strategy}".`);
  }
}

// How well an opacity serves the light the direction (or the need) calls for.
const LIGHT_FIT = {
  bright: { sheer: 1, unknown: 0.6, blackout: 0.1 },
  filtered: { unknown: 1, sheer: 0.6, blackout: 0.4 },
  dark: { blackout: 1, unknown: 0.4, sheer: 0 }
};

export function lightScore(targetLight, opacity) {
  return LIGHT_FIT[targetLight][opacity || "unknown"] ?? 0.5;
}

export function styleScore(briefTags, variantTags) {
  const a = new Set(briefTags.flatMap(tokens));
  const b = new Set((variantTags || []).flatMap(tokens));
  if (a.size === 0 || b.size === 0) return 0.5;
  const overlap = [...a].filter((t) => b.has(t)).length;
  return Math.min(1, overlap / Math.min(a.size, b.size, 3));
}

/** Warmth / lightness / avoid preferences from the Brief. 0.5 = no preference. */
export function preferenceScore(preferences, variant, variantLab, dominantLab) {
  const parts = [];
  const warmth = preferences.warmth.value;
  if (warmth) {
    parts.push(variant.warmth === warmth ? 1 : variant.warmth === "neutral" || !variant.warmth ? 0.5 : 0);
  }
  const lightness = preferences.lightness.value;
  if (lightness) {
    const lighter = variantLab.L >= dominantLab.L - 5;
    parts.push(lightness === "lighter" ? (lighter ? 1 : 0) : lighter ? 0 : 1);
  }
  const avoid = preferences.avoidColours.value;
  if (avoid.length > 0 && avoid.includes(variant.colorFamily)) return 0;
  return parts.length === 0 ? 0.5 : parts.reduce((s, v) => s + v, 0) / parts.length;
}

function chroma(lab) {
  return Math.hypot(lab.a, lab.b);
}

function hue(lab) {
  return ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
}

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 2)
    .map((t) => (t === "minimalist" ? "minimal" : t));
}
