import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

// The mock provider: hand-written fixture responses instead of paid API calls.
//
// Fixture files are JSON: { "fixtures": [ { stage, key, responses: [...], note } ] }.
// A fixture is found by stage name + a hash of its `key`, where `key` is the
// stage's declared fixture-key projection of its input (readable, so fixtures can
// be written by hand). `responses[n]` answers attempt n+1; the last one repeats.
// A response is { json }, { rawText } (for deliberately broken output) or { error }.
//
// A miss throws. It never falls through to a real provider.

export class MockFixtureMissError extends Error {
  constructor({ stage, key, hash }) {
    super(
      `No mock fixture for stage "${stage}" (key hash ${hash}). Add one to test/fixtures/v2 with ` +
        `"stage": "${stage}" and "key": ${stableStringify(key)}`
    );
    this.name = "MockFixtureMissError";
    this.stage = stage;
    this.key = key;
    this.hash = hash;
  }
}

export function fixtureHash(stage, key) {
  return crypto.createHash("sha256").update(`${stage}\n${stableStringify(key)}`).digest("hex").slice(0, 16);
}

export function loadFixtureStore(dir) {
  const entries = new Map();
  const files = listJsonFiles(dir);

  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const fixture of parsed.fixtures || []) {
      const hash = fixtureHash(fixture.stage, fixture.key);
      if (entries.has(hash)) {
        throw new Error(`Duplicate mock fixture for stage "${fixture.stage}" key ${stableStringify(fixture.key)} in ${file}`);
      }
      entries.set(hash, { ...fixture, file: path.relative(process.cwd(), file) });
    }
  }

  return {
    dir,
    size: entries.size,
    get(stage, key) {
      return entries.get(fixtureHash(stage, key)) || null;
    },
    entries: () => [...entries.values()]
  };
}

export async function callMockProvider({ blocks, mock, parseJson }) {
  const { stage, key, attempt = 1, store } = mock || {};
  if (!store) throw new Error("Mock provider called without a fixture store.");

  const fixture = store.get(stage, key);
  if (!fixture) throw new MockFixtureMissError({ stage, key, hash: fixtureHash(stage, key) });

  const responses = fixture.responses || [];
  const response = responses[Math.min(attempt, responses.length) - 1];
  if (!response) throw new Error(`Mock fixture for "${stage}" has no responses (${fixture.file}).`);
  if (response.error) throw new Error(`mock provider error: ${response.error}`);

  const rawText = response.rawText ?? JSON.stringify(response.json);
  return {
    provider: "mock",
    model: "mock",
    rawText,
    result: parseJson(rawText),
    usage: estimateUsage(blocks, rawText),
    fixture: { file: fixture.file, hash: fixtureHash(stage, key), note: fixture.note || null }
  };
}

// What the call would have cost, so traces and the first live-run estimate have
// numbers before any paid call. Text ≈ 4 chars/token; an image ≈ 258 tokens at
// Gemini's tiled rate. Marked estimated so no one mistakes it for a bill.
export function estimateUsage(blocks = [], outputText = "") {
  const textChars = blocks.filter((b) => b.type === "text").reduce((n, b) => n + b.text.length, 0);
  const images = blocks.filter((b) => b.type === "image").length;
  const inputTokens = Math.round(textChars / 4) + images * 258;
  const outputTokens = Math.round(String(outputText).length / 4);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, images, estimated: true };
}

/**
 * Mock RENDER: the room photo with a flat rectangle over the window region, in the
 * given colour. That is enough to exercise the faithfulness check end to end.
 */
export async function mockRender({ roomBytes, region, colourHex, maxDimension = 1024 }) {
  const base = sharp(roomBytes).rotate().resize({ width: maxDimension, height: maxDimension, fit: "inside" });
  const { data, info } = await base.jpeg().toBuffer({ resolveWithObject: true });
  const left = Math.round(region.x * info.width);
  const top = Math.round(region.y * info.height);
  const width = Math.max(1, Math.min(info.width - left, Math.round(region.w * info.width)));
  const height = Math.max(1, Math.min(info.height - top, Math.round(region.h * info.height)));

  const patch = await sharp({ create: { width, height, channels: 3, background: colourHex } }).png().toBuffer();
  return sharp(data)
    .composite([{ input: patch, left, top }])
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function listJsonFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listJsonFiles(full);
      return entry.isFile() && entry.name.endsWith(".json") ? [full] : [];
    })
    .sort();
}
