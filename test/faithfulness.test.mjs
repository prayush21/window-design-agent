import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mockRender } from "../src/mock-provider.js";
import { resolvePath } from "../src/v2/config.js";
import { runSingleStage } from "../src/v2/engine.js";
import { ROOT_DIR, testCatalog, testConfig } from "./helpers.mjs";

// Offline check 3: the faithfulness check flags an off-colour render and passes a correct one.
const config = testConfig();
const catalog = await testCatalog(config);
const variant = catalog.variants.get("CUR26022-P01"); // Silver Grey drapery panel
const region = { x: 0.35, y: 0.37, w: 0.42, h: 0.39 };
const roomBytes = fs.readFileSync(path.join(ROOT_DIR, "evals", "rooms", "living-room-window.jpg"));
const roomPhoto = { path: "evals/rooms/living-room-window.jpg", sha256: "0".repeat(64) };

async function renderWith(colourHex, name) {
  const dir = resolvePath(config, "renders");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), await mockRender({ roomBytes, region, colourHex }));
  return {
    renderId: `test-${name}`,
    proposalId: "test",
    productId: variant.productId,
    variantId: variant.variantId,
    attempt: 1,
    imagePath: name,
    cacheKey: name,
    provider: "mock",
    model: "mock",
    promptHash: "test"
  };
}

test("a render in the swatch colour passes", async () => {
  const { output } = await runSingleStage("faithfulness", { render: await renderWith(variant.hex, "good.jpg"), windowRegion: region, roomPhoto }, { config });
  assert.equal(output.pass, true);
  assert.ok(output.deltaE < 3, `ΔE ${output.deltaE}`);
});

test("an off-colour render fails", async () => {
  const { output } = await runSingleStage("faithfulness", { render: await renderWith("#c2185b", "bad.jpg"), windowRegion: region, roomPhoto }, { config });
  assert.equal(output.pass, false);
  assert.ok(output.deltaE > config.faithfulness.threshold, `ΔE ${output.deltaE}`);
});

test("a subtle shift (lighting, not a different product) still passes", async () => {
  const { output } = await runSingleStage("faithfulness", { render: await renderWith("#85847f", "shifted.jpg"), windowRegion: region, roomPhoto }, { config });
  assert.equal(output.pass, true, `ΔE ${output.deltaE}`);
});

test("curtains hung beside the window are measured where they are, not on the glass", async () => {
  const dir = resolvePath(config, "renders");
  const sharp = (await import("sharp")).default;
  const base = await sharp(roomBytes).rotate().resize({ width: 1024 }).jpeg().toBuffer();
  const { width, height } = await sharp(base).metadata();
  const panel = await sharp({ create: { width: Math.round(width * 0.12), height: Math.round(height * 0.6), channels: 3, background: variant.hex } }).png().toBuffer();
  const top = Math.round(height * 0.3);
  const bytes = await sharp(base)
    .composite([
      { input: panel, left: Math.round((region.x - 0.13) * width), top },
      { input: panel, left: Math.round((region.x + region.w + 0.01) * width), top }
    ])
    .jpeg()
    .toBuffer();
  fs.writeFileSync(path.join(dir, "sides.jpg"), bytes);
  const render = { ...(await renderWith(variant.hex, "unused.jpg")), renderId: "test-sides", imagePath: "sides.jpg" };
  const { output } = await runSingleStage("faithfulness", { render, windowRegion: region, roomPhoto }, { config });
  assert.equal(output.pass, true, `ΔE ${output.deltaE} via ${output.method}`);
  assert.match(output.method, /changed-pixels/);
});
