// Derive the ranker's per-variant metadata (colorFamily, warmth, texture, styleTags,
// bestFor, avoidFor) from swatch images with a vision model, and write product.json
// in the shape catalog.js reads.
//
// Inputs: a catalog folder laid out as <category>/<productId>/{room,swatch}/ plus a
// _colourways.json at its root (the reviewed swatch-file grouping). Facts that only
// exist on the vendor's product page (opacity outside blackout/sheer categories,
// price, sizes, sourceUrl) stay null — the prompt is told not to infer them.
//
//   node src/enrich-catalog.js --catalog "Product Catalog V2-clean" [--provider gemini]
//        [--model id] [--only RLS26014] [--fresh] [--concurrency 3] [--dry-run]

import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { callProvider, image, text } from "./providers.js";
import { encodeCatalogImage, RANKING_IMAGE_SIZES } from "./image-cache.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");

const COLOR_FAMILIES = ["white", "off-white", "beige", "gray", "brown", "black", "blue", "green", "red", "pink", "yellow", "orange", "purple", "multi"];
const WARMTH = ["warm", "cool", "neutral"];
const MATERIAL_BY_CATEGORY = { "Aluminum Blinds": "aluminum", "Wood Blinds": "wood", "Vinyl Blinds": "vinyl" };

function opacityForCategory(category) {
  if (category.startsWith("Blackout")) return "blackout";
  if (category.startsWith("Sheer")) return "sheer";
  return "unknown";
}

// Names that are a site colour name rather than an id, camera number, or vendor code.
function looksLikeColorName(stem) {
  if (/^[A-Z]{3}\d{5}/.test(stem)) return false;
  if (/^(IMG_|ZE-|ZH-|ZF-|ZG-|pid-|FitWindows)/.test(stem)) return false;
  if (/^\d+(\s*\(\d+\))?$/.test(stem)) return false;
  if (/-64-|zoom$/.test(stem)) return false;
  return /^[A-Za-z][A-Za-z \-]*(\s\(alt finish\))?$/.test(stem);
}

// Wood-blind slugs carry the colour: "golden-mahogany-64-fabric-50-3-zoom" -> "Golden Mahogany".
function nameFromSlug(stem) {
  const m = stem.match(/^([a-z]+(?:-[a-z]+)*?)-(?:64|31)-/);
  if (!m) return null;
  return m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

async function averageHex(filePath) {
  const { data, info } = await sharp(filePath).resize(32, 32, { fit: "cover" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return "#" + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("");
}

const INSTRUCTIONS = `You are cataloguing window-covering products for an interior-design recommendation system.
For ONE product you will see: a room photo showing the product installed (use it only for the product's form, material feel and pleat/slat/weave type), then one swatch image per colour option (the swatch is the truth for colour and surface texture).

Return strict JSON:
{
  "description": "one factual sentence describing the product's form as seen, e.g. 'Cordless cellular shade with single-cell honeycomb pleats.' No marketing language.",
  "variants": [
    {
      "id": "<echo the id given>",
      "name": "<if a name was given, echo it exactly; otherwise a plain 2-3 word descriptive colour name like 'Warm Light Grey'>",
      "colorFamily": one of ${JSON.stringify(COLOR_FAMILIES)},
      "warmth": one of ${JSON.stringify(WARMTH)},
      "texture": "<short phrase, 2-4 words, e.g. 'woven linen-like', 'smooth slatted', 'pleated honeycomb cell', 'brushed metallic slat'>",
      "styleTags": ["2-4 short adjectives describing the look, e.g. modern, soft, warm neutral, minimal, earthy, classic, bold, airy"],
      "bestFor": ["2-3 room contexts it suits, e.g. 'warm palettes', 'light walls', 'contemporary rooms', 'wood tones'"],
      "avoidFor": ["1-2 room contexts it clashes with"]
    }
  ]
}
Rules: one entry per swatch, same order, ids echoed exactly. Judge colour from the swatch, not the room photo. Do not mention or infer opacity, light control, price or size. When the swatch is a product photo rather than a flat chip (you will be told), judge colour from the fabric area only.`;

async function buildBlocks({ product, productDir, roomImage, colourways }) {
  const blocks = [text(INSTRUCTIONS), text(`--- product ${product.productId} · category: ${product.category} ---`)];
  if (roomImage) {
    blocks.push(text("Room photo (form reference only):"), image(await encodeCatalogImage(roomImage, RANKING_IMAGE_SIZES.product)));
  } else {
    blocks.push(text("No room photo is available for this product; judge form from the swatches only."));
  }
  for (const cw of colourways) {
    const lines = [`Swatch for id ${cw.colourwayId}`];
    if (cw.siteName) lines.push(`site colour name: "${cw.siteName}" (echo exactly as name)`);
    if (cw.hex) lines.push(`average colour of this swatch: ${cw.hex}`);
    if (cw.swatchIsProductShot) lines.push("this is a product photo, not a flat chip — judge the fabric area only");
    blocks.push(text(lines.join("\n")), image(await encodeCatalogImage(path.join(productDir, "swatch", cw.chip), RANKING_IMAGE_SIZES.swatch)));
  }
  return blocks;
}

function validate(result, colourways) {
  const errors = [];
  if (!result || typeof result !== "object") return ["response is not an object"];
  if (typeof result.description !== "string") errors.push("description missing");
  const byId = new Map((result.variants || []).map((v) => [v.id, v]));
  for (const cw of colourways) {
    const v = byId.get(cw.colourwayId);
    if (!v) { errors.push(`no entry for ${cw.colourwayId}`); continue; }
    if (!COLOR_FAMILIES.includes(v.colorFamily)) errors.push(`${cw.colourwayId}: colorFamily "${v.colorFamily}"`);
    if (!WARMTH.includes(v.warmth)) errors.push(`${cw.colourwayId}: warmth "${v.warmth}"`);
    if (cw.siteName && v.name !== cw.siteName) errors.push(`${cw.colourwayId}: name "${v.name}" != site "${cw.siteName}"`);
    for (const k of ["styleTags", "bestFor", "avoidFor"]) if (!Array.isArray(v[k])) errors.push(`${cw.colourwayId}: ${k} not a list`);
  }
  return errors;
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
}

function writeProductJson({ productDir, product, colourways, enrichment, roomFiles, existing }) {
  const category = product.category;
  const byId = new Map(enrichment.variants.map((v) => [v.id, v]));
  const variants = colourways.map((cw) => {
    const v = byId.get(cw.colourwayId);
    const installed = roomFiles.find((f) => path.parse(f).name === cw.colourwayId) || null;
    return {
      variantId: cw.colourwayId,
      name: v.name,
      color: v.name,
      colorFamily: v.colorFamily,
      warmth: v.warmth,
      hex: cw.hex,
      material: MATERIAL_BY_CATEGORY[category] || "unknown",
      texture: v.texture,
      opacity: opacityForCategory(category),
      styleTags: v.styleTags,
      bestFor: v.bestFor,
      avoidFor: v.avoidFor,
      swatchImage: `swatch/${cw.chip}`,
      installedImage: installed ? `room/${installed}` : null,
      galleryImages: cw.gallery.map((g) => `swatch/${g}`),
      provenance: {
        variantIdIsProvisional: cw.provisional,
        nameFromSite: Boolean(cw.siteName),
        swatchIsProductShot: Boolean(cw.swatchIsProductShot),
        derivedByModel: ["colorFamily", "warmth", "texture", "styleTags", "bestFor", "avoidFor", ...(cw.siteName ? [] : ["name"])]
      },
      sourceUrl: null
    };
  });

  const doc = {
    productId: product.productId,
    category,
    displayName: `${category} ${product.productId}`,
    description: enrichment.description,
    defaultVariantId: variants[0]?.variantId ?? null,
    // Vendor-page facts the collaborator still owes; the ranker does not read these.
    sourceUrl: existing?.sourceUrl ?? null,
    capturedOn: existing?.capturedOn ?? null,
    mountTypes: existing?.mountTypes ?? null,
    operation: existing?.operation ?? null,
    childSafe: existing?.childSafe ?? null,
    sizeRangeMm: existing?.sizeRangeMm ?? { minWidth: null, maxWidth: null, minHeight: null, maxHeight: null },
    price: existing?.price ?? { amount: null, currency: null, note: null },
    variants,
    _generated: { by: "src/enrich-catalog.js", provider: enrichment._provider, model: enrichment._model, at: new Date().toISOString() }
  };
  fs.writeFileSync(path.join(productDir, "product.json"), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    return value;
  };
  const flag = (name) => args.includes(`--${name}`);
  const catalogDir = path.resolve(ROOT_DIR, opt("catalog", "Product Catalog V2-clean"));
  const provider = opt("provider", process.env.DESIGN_AGENT_PROVIDER || "gemini");
  const model = opt("model", undefined);
  const only = opt("only", null);
  const concurrency = Number(opt("concurrency", 3));
  const fresh = flag("fresh"), dryRun = flag("dry-run");

  const grouping = JSON.parse(fs.readFileSync(path.join(catalogDir, "_colourways.json"), "utf8"));
  const products = grouping.products.filter((p) => !only || p.productId === only);
  console.log(`${products.length} products · provider ${provider}${model ? " · " + model : ""}${dryRun ? " · dry run" : ""}`);

  const summary = { done: 0, cached: 0, failed: [], variants: 0, usage: { input: 0, output: 0 } };
  const queue = [...products];
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      try { await processProduct(p); }
      catch (err) { summary.failed.push({ productId: p.productId, error: err.message }); console.log(`  ${p.productId}: ${err.message.slice(0, 160)}`); }
    }
  }
  async function processProduct(p) {
    const productDir = path.join(catalogDir, p.category, p.productId);
    const cachePath = path.join(productDir, "_enrichment.json");
    const roomFiles = listImages(path.join(productDir, "room"));
    const colourways = [];
    for (const cw of p.colourways_detail) {
      if (!cw.chip) continue;                                   // no fabric image at all — not a candidate
      const stem = path.parse(cw.chip).name;
      const siteName = looksLikeColorName(stem) ? stem : nameFromSlug(stem);
      // A product photo's average is mostly background, so no hex hint or stored hex for those.
      const hex = cw.swatchIsProductShot ? null : await averageHex(path.join(productDir, "swatch", cw.chip));
      colourways.push({ ...cw, siteName, hex });
    }
    if (!colourways.length) { console.log(`  ${p.productId}: no swatches, skipped`); return; }
    const existing = fs.existsSync(path.join(productDir, "product.json")) ? JSON.parse(fs.readFileSync(path.join(productDir, "product.json"), "utf8")) : null;

    let enrichment = null;
    if (!fresh && fs.existsSync(cachePath)) {
      // The grouping can change between runs (a composite split, a colourway renamed);
      // a cache that no longer covers every colourway is a miss, not a crash.
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (validate(cached, colourways).length === 0) { enrichment = cached; summary.cached += 1; }
    }
    if (enrichment) { /* from cache */ }
    else if (dryRun) { console.log(`  ${p.productId}: ${colourways.length} colourways, ${colourways.filter((c) => c.siteName).length} named`); return; }
    else {
      const roomImage = roomFiles.length ? path.join(productDir, "room", roomFiles[0]) : null;
      const blocks = await buildBlocks({ product: p, productDir, roomImage, colourways });
      let lastErr = null;
      for (let attempt = 1; attempt <= 3 && !enrichment; attempt += 1) {
        try {
          const res = await callProvider({ provider, model, blocks });
          const errors = validate(res.result, colourways);
          if (errors.length) throw new Error(errors.join("; "));
          enrichment = { ...res.result, _provider: res.provider, _model: res.model, _usage: res.usage };
          summary.usage.input += res.usage?.inputTokens || 0; summary.usage.output += res.usage?.outputTokens || 0;
        } catch (err) {
          lastErr = err; console.log(`  ${p.productId}: attempt ${attempt} failed — ${err.message.slice(0, 160)}`);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      if (!enrichment) { summary.failed.push({ productId: p.productId, error: lastErr?.message }); return; }
      fs.writeFileSync(cachePath, JSON.stringify(enrichment, null, 2) + "\n");
    }
    const doc = writeProductJson({ productDir, product: p, colourways, enrichment, roomFiles, existing });
    summary.done += 1; summary.variants += doc.variants.length;
    console.log(`  ${p.productId}: ${doc.variants.length} variants — ${doc.description}`);
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`\nwrote ${summary.done} product.json (${summary.cached} from cache) · ${summary.variants} variants · tokens in ${summary.usage.input} out ${summary.usage.output}`);
  if (summary.failed.length) { console.log("FAILED:"); for (const f of summary.failed) console.log(`  ${f.productId}: ${f.error}`); process.exitCode = 1; }
}

if (process.argv[1] === __filename) main().catch((err) => { console.error(err); process.exit(1); });
