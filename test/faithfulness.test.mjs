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
  const { output } = await runSingleStage("faithfulness", { render: await renderWith(variant.hex, "good.jpg"), windowRegion: region }, { config });
  assert.equal(output.pass, true);
  assert.ok(output.deltaE < 3, `ΔE ${output.deltaE}`);
});

test("an off-colour render fails", async () => {
  const { output } = await runSingleStage("faithfulness", { render: await renderWith("#c2185b", "bad.jpg"), windowRegion: region }, { config });
  assert.equal(output.pass, false);
  assert.ok(output.deltaE > config.faithfulness.threshold, `ΔE ${output.deltaE}`);
});

test("a subtle shift (lighting, not a different product) still passes", async () => {
  const { output } = await runSingleStage("faithfulness", { render: await renderWith("#85847f", "shifted.jpg"), windowRegion: region }, { config });
  assert.equal(output.pass, true, `ΔE ${output.deltaE}`);
});
