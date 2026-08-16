// Verification for the CIEDE2000 implementation.
//
// CIEDE2000 has several discontinuities (hue wrap-around, the neutral-axis case)
// that a plausible-looking implementation gets wrong silently. Since the whole
// baseline rests on this number, it is checked against published reference pairs
// from Sharma, Wu & Dalal (2005), which exist specifically to catch those errors.
//
// Run: node src/baseline/color.test.mjs

import { deltaE2000, labToHex, srgbToLab } from "./color.js";

const lab = (L, a, b) => ({ L, a, b });

const REFERENCE = [
  [lab(50, 2.6772, -79.7751), lab(50, 0, -82.7485), 2.0425],
  [lab(50, 3.1571, -77.2803), lab(50, 0, -82.7485), 2.8615],
  [lab(50, 2.8361, -74.02), lab(50, 0, -82.7485), 3.4412],
  [lab(50, -1.3802, -84.2814), lab(50, 0, -82.7485), 1.0],
  [lab(50, -1.1848, -84.8006), lab(50, 0, -82.7485), 1.0],
  [lab(50, -0.9009, -85.5211), lab(50, 0, -82.7485), 1.0],
  [lab(50, 0, 0), lab(50, -1, 2), 2.3669],
  [lab(50, -1, 2), lab(50, 0, 0), 2.3669],
  [lab(50, 2.49, -0.001), lab(50, -2.49, 0.0009), 7.1792],
  [lab(50, 2.5, 0), lab(50, 0, -2.5), 4.3065],
  [lab(50, 2.5, 0), lab(73, 25, -18), 27.1492],
  [lab(50, 2.5, 0), lab(61, -5, 29), 22.8977],
  [lab(50, 2.5, 0), lab(56, -27, -3), 31.903],
  [lab(50, 2.5, 0), lab(58, 24, 15), 19.4535],
  [lab(60.2574, -34.0099, 36.2677), lab(60.4626, -34.1751, 39.4387), 1.2644],
  [lab(2.0776, 0.0795, -1.135), lab(0.9033, -0.0636, -0.5514), 0.9082]
];

let failures = 0;
const check = (name, actual, expected, tolerance) => {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "pass" : "FAIL"}  ${name.padEnd(46)} got ${actual.toFixed(4).padStart(9)}  want ${expected.toFixed(4).padStart(9)}`
  );
};

console.log("\nCIEDE2000 vs Sharma et al. reference pairs");
REFERENCE.forEach(([a, b, expected], i) => {
  check(`pair ${String(i + 1).padStart(2)}`, deltaE2000(a, b), expected, 0.0001);
});

console.log("\nInvariants");
const samples = [lab(50, 2.5, 0), lab(73, 25, -18), lab(20, -30, 40), lab(95, 0, 0)];
for (const [i, s] of samples.entries()) {
  check(`identity  ΔE(x,x)=0  #${i + 1}`, deltaE2000(s, s), 0, 1e-12);
}
for (const [i, s] of samples.entries()) {
  const t = samples[(i + 1) % samples.length];
  check(`symmetry  ΔE(x,y)=ΔE(y,x)  #${i + 1}`, deltaE2000(s, t) - deltaE2000(t, s), 0, 1e-12);
}

console.log("\nsRGB round trip");
for (const [name, rgb] of [
  ["white", [255, 255, 255]],
  ["black", [0, 0, 0]],
  ["mid gray", [128, 128, 128]],
  ["beige", [242, 240, 234]],
  ["charcoal", [74, 74, 77]]
]) {
  const there = srgbToLab(rgb);
  const back = labToHex(there);
  const expected = `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const ok = back === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name.padEnd(46)} ${expected} -> ${back}`);
}

console.log(
  `\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}\n`
);
process.exit(failures === 0 ? 0 : 1);
