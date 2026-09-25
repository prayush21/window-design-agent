import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { deltaE2000, labToHex, srgbToLab } from "../../baseline/color.js";
import { ROOT_DIR } from "../config.js";
import { nonEmpty } from "../schemas/index.js";

// FAITHFULNESS: code. Did the render keep the product's colour? A failure is a
// render problem, not a design problem: the policy re-renders rather than asking
// for a different product.
//
// Where is the covering? Not always over the glass: curtains and drapery hang
// beside the window. So the check looks at what the render CHANGED relative to the
// room photo, inside a generous area around the window, and takes the dominant
// colour of the changed pixels. If almost nothing changed (a covering the same
// colour as the wall), it falls back to the window box and says so in `method`.

const inputSchema = {
  type: "object",
  required: ["render", "windowRegion", "roomPhoto"],
  properties: {
    render: { $ref: "v2.render" },
    windowRegion: { $ref: "v2.region" },
    roomPhoto: {
      type: "object",
      required: ["path", "sha256"],
      properties: { path: nonEmpty, sha256: { type: "string" }, roomId: { type: ["string", "null"] } }
    }
  },
  additionalProperties: false
};

const GRID = 160; // both images are compared at this width
const CHANGE_DELTA = 15; // CIE76 difference that counts a pixel as changed
const MIN_CHANGED_SHARE = 0.04; // below this, "what changed" is too small to trust
const INSET = 0.1; // window-box fallback: shrink so the frame does not vote

export default {
  name: "faithfulness",
  version: 2,
  kind: "code",
  description:
    "Check whether a render kept the product's colour: find the pixels the render changed around the window, take their " +
    "dominant colour and compare it with the variant's swatch by CIEDE2000. Returns ΔE and pass/fail against the " +
    "configured threshold. Deterministic; no model.",
  inputSchema,
  outputSchema: { $ref: "v2.faithfulness" },

  async run(input, ctx) {
    const { render, windowRegion, roomPhoto } = input;
    const threshold = ctx.config.faithfulness.threshold;
    const swatch = ctx.catalog.variants.get(render.variantId);
    const base = { renderId: render.renderId, proposalId: render.proposalId, threshold };

    if (!swatch?.lab) {
      ctx.warn("faithfulness-unchecked", `${render.variantId} has no swatch colour; the render's colour cannot be checked.`);
      return { ...base, method: "unchecked", pass: true, deltaE: null, measuredHex: null, swatchHex: null, note: "no swatch; unchecked" };
    }

    const renderBytes = fs.readFileSync(path.join(ctx.paths.renders, render.imagePath));
    const roomBytes = fs.readFileSync(path.resolve(ROOT_DIR, roomPhoto.path));
    const { lab, method, changedShare } = await coveringColour(roomBytes, renderBytes, windowRegion);
    const deltaE = deltaE2000(lab, swatch.lab, { kL: ctx.config.faithfulness.kL ?? 1 });
    return {
      ...base,
      method: `${method} kL=${ctx.config.faithfulness.kL ?? 1}`,
      pass: deltaE <= threshold,
      deltaE: Math.round(deltaE * 100) / 100,
      measuredHex: labToHex(lab),
      swatchHex: swatch.hex,
      note: `${Math.round(changedShare * 100)}% of the area around the window changed`
    };
  }
};

export async function coveringColour(roomBytes, renderBytes, region) {
  // Compare at the render's size; the room is resized to match it exactly.
  const after = await toGrid(renderBytes);
  const room = await toGrid(roomBytes, after.height);
  const { width, height } = after;

  // Around the window: wide enough for curtains stacked at the sides, down to the
  // floor for full-length drapery, and a little above for rods and valances.
  const x0 = Math.max(0, Math.floor((region.x - region.w * 0.6) * width));
  const x1 = Math.min(width, Math.ceil((region.x + region.w * 1.6) * width));
  const y0 = Math.max(0, Math.floor((region.y - region.h * 0.25) * height));
  const y1 = height;

  const changed = [];
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      total += 1;
      const a = room.labs[y * width + x];
      const b = after.labs[y * width + x];
      if (Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b) > CHANGE_DELTA) changed.push(b);
    }
  }

  const changedShare = total ? changed.length / total : 0;
  if (changedShare >= MIN_CHANGED_SHARE) {
    return { lab: dominant(changed), method: "changed-pixels-dominant-lab-ciede2000", changedShare };

  }

  const box = [];
  for (let y = Math.floor((region.y + region.h * INSET) * height); y < Math.ceil((region.y + region.h * (1 - INSET)) * height); y += 1) {
    for (let x = Math.floor((region.x + region.w * INSET) * width); x < Math.ceil((region.x + region.w * (1 - INSET)) * width); x += 1) {
      const lab = after.labs[y * width + x];
      if (lab) box.push(lab);
    }
  }
  return { lab: dominant(box), method: "window-box-dominant-lab-ciede2000 (render changed too little to locate the covering)", changedShare };
}

async function toGrid(bytes, height = null) {
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize({ width: GRID, height: height ?? undefined, fit: height ? "fill" : "inside" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const labs = [];
  for (let i = 0; i < data.length; i += info.channels) labs.push(srgbToLab([data[i], data[i + 1], data[i + 2]]));
  return { labs, width: info.width, height: info.height };
}

// Dominant colour of a set of Lab pixels: the heaviest of 3 deterministic k-means clusters.
function dominant(labs) {
  const k = Math.min(3, labs.length);
  const sorted = [...labs].sort((p, q) => p.L - q.L);
  let centroids = Array.from({ length: k }, (_u, i) => ({ ...sorted[Math.floor(((i + 0.5) / k) * (sorted.length - 1))] }));
  let assign = new Array(labs.length).fill(0);
  for (let step = 0; step < 12; step += 1) {
    assign = labs.map((p) => {
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, i) => {
        const d = (p.L - c.L) ** 2 + (p.a - c.a) ** 2 + (p.b - c.b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    });
    centroids = centroids.map((c, i) => {
      const members = labs.filter((_p, j) => assign[j] === i);
      if (members.length === 0) return c;
      return {
        L: members.reduce((s, p) => s + p.L, 0) / members.length,
        a: members.reduce((s, p) => s + p.a, 0) / members.length,
        b: members.reduce((s, p) => s + p.b, 0) / members.length
      };
    });
  }
  const counts = centroids.map((_c, i) => assign.filter((a) => a === i).length);
  return centroids[counts.indexOf(Math.max(...counts))];
}
