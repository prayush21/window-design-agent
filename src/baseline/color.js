import sharp from "sharp";
import { describeDecodeFailure } from "../catalog.js";

// Perceptual colour math for the no-model baseline.
//
// The point of this module is to answer a specific research question: how much of
// the ranking task is explained by colour distance alone? If a 1976 colour space
// plus a 2000 distance formula matches human judgement as well as a VLM does, then
// the "aesthetic sense" claim needs to survive that comparison first.
//
// Everything here is deterministic. Same input, same output, always.

const D65 = { X: 0.95047, Y: 1.0, Z: 1.08883 };
const DELTA = 6 / 29;

// ---------------------------------------------------------------- conversions

export function srgbToLab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(linearize);

  const X = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / D65.X;
  const Y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / D65.Y;
  const Z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / D65.Z;

  const [fx, fy, fz] = [X, Y, Z].map(pivot);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function linearize(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function pivot(t) {
  return t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA ** 2) + 4 / 29;
}

export function labToHex({ L, a, b }) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (f) => (f > DELTA ? f ** 3 : 3 * DELTA ** 2 * (f - 4 / 29));

  const X = inv(fx) * D65.X;
  const Y = inv(fy) * D65.Y;
  const Z = inv(fz) * D65.Z;

  const lr = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const lg = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const lb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;

  const encode = (v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };

  return `#${[lr, lg, lb].map((v) => encode(v).toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- CIEDE2000

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * CIEDE2000 colour difference. Implemented from the CIE definition; verified
 * against the Sharma et al. reference pairs in the accompanying test.
 */
export function deltaE2000(lab1, lab2, { kL = 1, kC = 1, kH = 1 } = {}) {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = hueAngle(a1p, b1);
  const h2p = hueAngle(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;

  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));

  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;

  const termL = dLp / (kL * SL);
  const termC = dCp / (kC * SC);
  const termH = dHp / (kH * SH);

  return Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + RT * termC * termH);
}

function hueAngle(a, b) {
  if (a === 0 && b === 0) return 0;
  const angle = deg(Math.atan2(b, a));
  return angle >= 0 ? angle : angle + 360;
}

// ---------------------------------------------------------------- extraction

const PALETTE_SAMPLE_EDGE = 96;

/**
 * Dominant colours of a room photo, as weighted Lab clusters.
 *
 * `dropBlownOut` removes near-white low-chroma pixels, which in a window photo are
 * overwhelmingly the overexposed glazing rather than any surface in the room. It is
 * a flag rather than a default so the choice is reportable.
 */
export async function extractPalette(imageBytes, { clusters = 5, dropBlownOut = true } = {}) {
  let data;
  let info;
  try {
    ({ data, info } = await sharp(imageBytes)
      .rotate()
      .resize({ width: PALETTE_SAMPLE_EDGE, height: PALETTE_SAMPLE_EDGE, fit: "fill" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch (error) {
    throw new Error(describeDecodeFailure(imageBytes, error));
  }

  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) {
    const lab = srgbToLab([data[i], data[i + 1], data[i + 2]]);
    if (dropBlownOut && lab.L > 95 && Math.hypot(lab.a, lab.b) < 6) continue;
    pixels.push(lab);
  }

  if (pixels.length === 0) return [];
  return kMeansLab(pixels, clusters);
}

/**
 * The representative colour of a flat swatch. Centre-cropped to avoid borders and
 * drop shadows, then averaged — a swatch is near-uniform by construction, so the
 * mean is both stable and honest.
 */
export async function extractSwatchColor(imageBytes) {
  const image = sharp(imageBytes).rotate();
  const meta = await image.metadata();
  const side = Math.max(8, Math.round(Math.min(meta.width, meta.height) * 0.6));

  const { data, info } = await image
    .extract({
      left: Math.round((meta.width - side) / 2),
      top: Math.round((meta.height - side) / 2),
      width: side,
      height: side
    })
    .resize({ width: 32, height: 32, fit: "fill" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  let L = 0;
  let a = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const lab = srgbToLab([data[i], data[i + 1], data[i + 2]]);
    L += lab.L;
    a += lab.a;
    b += lab.b;
    n += 1;
  }

  return { L: L / n, a: a / n, b: b / n };
}

// Deterministic k-means: seeded by evenly spaced lightness quantiles rather than
// random draws, so a baseline run is exactly reproducible.
function kMeansLab(pixels, k, iterations = 12) {
  const sorted = [...pixels].sort((x, y) => x.L - y.L);
  const centroids = Array.from({ length: k }, (_unused, i) =>
    ({ ...sorted[Math.floor(((i + 0.5) / k) * (sorted.length - 1))] })
  );

  let assignment = new Array(pixels.length).fill(0);

  for (let step = 0; step < iterations; step += 1) {
    let moved = false;

    for (let i = 0; i < pixels.length; i += 1) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = squaredLabDistance(pixels[i], centroids[c]);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (assignment[i] !== best) moved = true;
      assignment[i] = best;
    }

    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (let i = 0; i < pixels.length; i += 1) {
      const s = sums[assignment[i]];
      s.L += pixels[i].L;
      s.a += pixels[i].a;
      s.b += pixels[i].b;
      s.n += 1;
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (sums[c].n === 0) continue;
      centroids[c] = { L: sums[c].L / sums[c].n, a: sums[c].a / sums[c].n, b: sums[c].b / sums[c].n };
    }

    if (!moved) break;
  }

  const counts = centroids.map(() => 0);
  for (const index of assignment) counts[index] += 1;

  return centroids
    .map((lab, i) => ({ lab, weight: counts[i] / pixels.length, hex: labToHex(lab) }))
    .filter((entry) => entry.weight > 0)
    .sort((x, y) => y.weight - x.weight);
}

function squaredLabDistance(p, q) {
  return (p.L - q.L) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2;
}
