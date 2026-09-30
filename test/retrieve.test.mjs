import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOM_TYPES, roomLayers } from "../src/v2/guidelines.js";
import { COLOUR_STRATEGIES, DIRECTION_LIGHT_LEVELS, validate } from "../src/v2/schemas/index.js";
import { buildBrief } from "../src/v2/stages/brief.js";
import { layerCapacity, retrieve } from "../src/v2/stages/retrieve.js";
import { testCatalog, testConfig } from "./helpers.mjs";

const config = testConfig();
const catalog = await testCatalog(config);
const { minPerLayer, maxPerLayer, maxPerProduct } = config.retrieve;

const env = (roomType) => {
  const f = (value, confidence = 0.8) => ({ value, confidence });
  return {
    roomType: f(roomType),
    windowType: f("double-hung"),
    windowShape: f("wide rectangle"),
    windowRegion: f({ x: 0.2, y: 0.2, w: 0.6, h: 0.5 }),
    palette: f([
      { hex: "#d8cfc4", name: "warm white wall", role: "wall", weight: 0.6 },
      { hex: "#2f4a73", name: "navy sofa", role: "furniture", weight: 0.2 },
      { hex: "#c8a77a", name: "oak floor", role: "floor", weight: 0.2 }
    ]),
    materials: f(["oak"]),
    styleTags: f(["modern", "warm"]),
    lightLevel: f("bright"),
    existingCovering: f(null),
    needs: Object.fromEntries(["privacy", "blackout", "glare", "moisture", "safety"].map((n) => [n, f("medium")]))
  };
};

const warnings = [];
const ctx = { config, catalog, warn: (code, message) => warnings.push({ code, message }) };

// Every room type × every strategy × every light level, using each layer's full
// allowed category list and each single category that can supply a shortlist.
function* cases() {
  for (const roomType of ROOM_TYPES) {
    const brief = buildBrief(env(roomType), {});
    const layers = roomLayers(roomType);
    const singles = layers.visual.filter((c) => layerCapacity(catalog, [c], maxPerProduct) >= minPerLayer);
    for (const visual of [layers.visual.slice(0, 4), ...singles.map((c) => [c])]) {
      for (const colourStrategy of COLOUR_STRATEGIES) {
        for (const lightLevel of DIRECTION_LIGHT_LEVELS) {
          const functional = layers.functional ? layers.functional.slice(0, 4) : null;
          if (layerCapacity(catalog, visual, maxPerProduct) < minPerLayer) continue;
          yield { brief, direction: { id: "d1", title: "t", intent: "i", layers: { visual, functional }, colourStrategy, lightLevel, textureNote: "n" } };
        }
      }
    }
  }
}

test("RETRIEVE never returns a disallowed category, returns 5-8 per layer, and caps products at 2", () => {
  let count = 0;
  for (const input of cases()) {
    const output = retrieve(input, ctx);
    assert.deepEqual(validate("v2.shortlist", output), []);
    const allowed = roomLayers(input.brief.roomType.value);
    for (const layer of ["visual", "functional"]) {
      const shortlistLayer = output.layers[layer];
      if (!input.direction.layers[layer]) {
        assert.equal(shortlistLayer, null);
        continue;
      }
      const n = shortlistLayer.candidates.length;
      assert.ok(n >= minPerLayer && n <= maxPerLayer, `${input.brief.roomType.value} ${layer}: ${n} candidates`);
      const perProduct = new Map();
      for (const candidate of shortlistLayer.candidates) {
        assert.ok(allowed[layer].includes(candidate.category), `${candidate.category} not allowed in ${layer}`);
        assert.ok(catalog.getVariant(candidate.productId, candidate.variantId), `${candidate.variantId} exists`);
        perProduct.set(candidate.productId, (perProduct.get(candidate.productId) || 0) + 1);
      }
      assert.ok(Math.max(...perProduct.values()) <= maxPerProduct);
    }
    count += 1;
  }
  assert.ok(count > 200, `exercised ${count} cases`);
  assert.deepEqual(warnings.filter((w) => w.code !== "short-shortlist"), []);
});

test("RETRIEVE is deterministic: same input, same output", () => {
  for (const input of [...cases()].filter((_c, i) => i % 17 === 0)) {
    assert.deepEqual(retrieve(structuredClone(input), ctx), retrieve(structuredClone(input), ctx));
  }
});

test("RETRIEVE drops a disallowed category with a warning instead of returning it", () => {
  const local = [];
  const brief = buildBrief(env("home-office"), {});
  const output = retrieve(
    {
      brief,
      direction: { id: "d9", title: "t", intent: "i", layers: { visual: ["Blackout Drapery", "Sheer Shades", "Zebra Shades"], functional: null }, colourStrategy: "tonal", lightLevel: "filtered", textureNote: "n" }
    },
    { config, catalog, warn: (code, message) => local.push({ code, message }) }
  );
  assert.ok(output.layers.visual.candidates.every((c) => c.category !== "Blackout Drapery"));
  assert.ok(local.some((w) => w.code === "disallowed-category"));
});

test("RETRIEVE honours exclusions (used by revisions)", () => {
  const input = cases().next().value;
  const first = retrieve(input, ctx);
  const top = first.layers.visual.candidates[0].variantId;
  const second = retrieve({ ...input, exclude: [top] }, ctx);
  assert.ok(second.layers.visual.candidates.every((c) => c.variantId !== top));
});
