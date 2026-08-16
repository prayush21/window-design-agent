import fs from "node:fs";
import { deltaE2000, extractPalette, extractSwatchColor, labToHex } from "./color.js";

// No-model rankers, used as controls for the VLM.
//
// Each returns the same result shape a provider returns, so it flows through
// normalizeRecommendation and the scoring path unchanged and its numbers are
// directly comparable to a model run.
//
// Why these three:
//   de2000    — how much of the task is explained by colour distance alone
//   popular   — how much is explained by "always suggest the common neutral"
//   random    — the floor
//
// A VLM that does not clearly beat all three is not demonstrating aesthetic
// judgement, whatever its absolute score looks like.

const MAX_RANKED = 10;

// Only palette clusters holding at least this share of the photo count as
// "present in the room" — otherwise a stray cushion outranks the wall.
const MIN_PALETTE_WEIGHT = 0.05;

// Blend hypothesis: closer is better, decaying smoothly with distance.
const MATCH_DECAY = 25;

// Contrast hypothesis: neither invisible nor clashing. Peak and width are
// arbitrary but fixed — the point is to test a different notion of "goes with",
// not to tune a winner.
const CONTRAST_TARGET = 35;
const CONTRAST_WIDTH = 18;

export const BASELINE_RANKERS = ["de2000-match", "de2000-contrast", "popular", "random"];

export async function runBaselineRanker({ ranker, catalog, candidates, roomImagePath, caseId, seed = 1 }) {
  // Seed from the case as well as the repeat index. Seeding on the repeat index
  // alone made the "random" control pick the same variant for every photo, which
  // is a constant baseline, not a random one.
  if (ranker === "random") return rankRandom({ candidates, seed: hashSeed(`${caseId}:${seed}`) });
  if (ranker === "popular") return rankPopular({ candidates });
  if (ranker === "de2000-match" || ranker === "de2000-contrast") {
    return rankByColorDistance({
      candidates,
      roomImagePath,
      mode: ranker === "de2000-match" ? "match" : "contrast"
    });
  }
  throw new Error(`Unknown baseline ranker "${ranker}". Use one of: ${BASELINE_RANKERS.join(", ")}`);
}

async function rankByColorDistance({ candidates, roomImagePath, mode }) {
  const palette = await extractPalette(fs.readFileSync(roomImagePath));
  const prominent = palette.filter((entry) => entry.weight >= MIN_PALETTE_WEIGHT);
  const usable = prominent.length > 0 ? prominent : palette.slice(0, 1);

  const scored = [];
  let missingColorSource = 0;

  for (const product of candidates) {
    for (const variant of product.variants) {
      // No swatch means no defensible colour for this variant. Excluding it is
      // honest; guessing from a lifestyle photo would import the staged room's
      // lighting and quietly corrupt the control.
      if (!variant.swatchImagePath) {
        missingColorSource += 1;
        continue;
      }

      const variantLab = await extractSwatchColor(fs.readFileSync(variant.swatchImagePath));
      const distances = usable.map((entry) => deltaE2000(entry.lab, variantLab));
      const nearest = Math.min(...distances);

      scored.push({
        product,
        variant,
        nearest,
        hex: labToHex(variantLab),
        score:
          mode === "match"
            ? Math.exp(-nearest / MATCH_DECAY)
            : Math.exp(-((nearest - CONTRAST_TARGET) ** 2) / (2 * CONTRAST_WIDTH ** 2))
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.variant.variantId.localeCompare(b.variant.variantId));

  const rankings = scored.slice(0, MAX_RANKED).map((entry, index) => ({
    rank: index + 1,
    productId: entry.product.productId,
    variantId: entry.variant.variantId,
    category: entry.product.category,
    score: Number(entry.score.toFixed(4)),
    reason: `ΔE2000 ${entry.nearest.toFixed(1)} from the nearest dominant room colour (${entry.hex})`,
    tradeoffs: []
  }));

  return {
    result: {
      // The baseline is deliberately blind to everything except colour. Leaving
      // these null keeps that visible in the reports rather than implying the
      // control understood the room.
      analysis: {
        window: { shape: null, frameColor: null, mountingContext: null },
        room: {
          style: [],
          palette: usable.map((entry) => entry.hex),
          lighting: null
        },
        needs: { privacy: "unknown", lightControl: "unknown" }
      },
      recommendation: rankings[0]
        ? {
            productId: rankings[0].productId,
            variantId: rankings[0].variantId,
            category: rankings[0].category,
            // A colour-distance rank is an ordering, not a calibrated belief.
            // Reporting a confidence here would be inventing one.
            confidence: 0,
            reason: rankings[0].reason
          }
        : {},
      rankings
    },
    diagnostics: {
      ranker: `de2000-${mode}`,
      paletteHex: usable.map((entry) => entry.hex),
      paletteWeights: usable.map((entry) => Number(entry.weight.toFixed(3))),
      variantsScored: scored.length,
      variantsMissingColorSource: missingColorSource,
      colorCoverage: scored.length / (scored.length + missingColorSource)
    }
  };
}

// "Always recommend the commonest neutral." Ranks by how frequently a colour
// family appears in the catalog, which is the null model a recommender has to
// beat before any claim about taste is meaningful.
function rankPopular({ candidates }) {
  const variants = candidates.flatMap((product) =>
    product.variants.map((variant) => ({ product, variant }))
  );

  const familyCounts = new Map();
  for (const { variant } of variants) {
    const family = variant.colorFamily ?? "unknown";
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
  }

  const sorted = [...variants].sort((a, b) => {
    const byFamily =
      (familyCounts.get(b.variant.colorFamily ?? "unknown") || 0) -
      (familyCounts.get(a.variant.colorFamily ?? "unknown") || 0);
    return byFamily || a.variant.variantId.localeCompare(b.variant.variantId);
  });

  const rankings = sorted.slice(0, MAX_RANKED).map((entry, index) => ({
    rank: index + 1,
    productId: entry.product.productId,
    variantId: entry.variant.variantId,
    category: entry.product.category,
    score: Number((1 - index / MAX_RANKED).toFixed(4)),
    reason: `${entry.variant.colorFamily ?? "unknown"} is the most common colour family in the catalog`,
    tradeoffs: []
  }));

  return {
    result: { analysis: null, recommendation: toRecommendation(rankings[0]), rankings },
    diagnostics: {
      ranker: "popular",
      familyCounts: Object.fromEntries(familyCounts)
    }
  };
}

function rankRandom({ candidates, seed }) {
  const random = mulberry32(seed);
  const variants = candidates.flatMap((product) =>
    product.variants.map((variant) => ({ product, variant, key: random() }))
  );

  variants.sort((a, b) => a.key - b.key);

  const rankings = variants.slice(0, MAX_RANKED).map((entry, index) => ({
    rank: index + 1,
    productId: entry.product.productId,
    variantId: entry.variant.variantId,
    category: entry.product.category,
    score: Number((1 - index / MAX_RANKED).toFixed(4)),
    reason: "random control",
    tradeoffs: []
  }));

  return {
    result: { analysis: null, recommendation: toRecommendation(rankings[0]), rankings },
    diagnostics: { ranker: "random", seed }
  };
}

function toRecommendation(top) {
  if (!top) return {};
  return {
    productId: top.productId,
    variantId: top.variantId,
    category: top.category,
    confidence: 0,
    reason: top.reason
  };
}

// Stable 32-bit hash, so a given (case, repeat) pair always yields the same draw.
function hashSeed(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Seeded PRNG so the random control is reproducible across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
