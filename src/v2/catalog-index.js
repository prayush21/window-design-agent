import fs from "node:fs";
import path from "node:path";
import { loadCatalog } from "../catalog.js";
import { extractSwatchColor, labToHex } from "../baseline/color.js";

// The catalog as v2 sees it: v1's loader plus an ID index and each variant's swatch
// colour in Lab. The catalog directory is read-only; derived data (the swatch Lab
// cache) lives under this repo's var/cache, keyed by file path, mtime and size.

const indexes = new Map();

export async function loadCatalogIndex({ catalogDir, cacheDir }) {
  const catalog = loadCatalog(catalogDir);
  const hit = indexes.get(catalogDir);
  if (hit && hit.catalog === catalog) return hit;

  const index = await buildIndex(catalog, cacheDir);
  indexes.set(catalogDir, index);
  return index;
}

async function buildIndex(catalog, cacheDir) {
  const cacheFile = cacheDir ? path.join(cacheDir, "swatch-lab.json") : null;
  const diskCache = readJson(cacheFile) || {};
  let dirty = false;

  const products = new Map();
  const variants = new Map();
  const categories = new Set();

  for (const product of catalog.products) {
    products.set(product.productId, product);
    categories.add(product.category);

    for (const variant of product.variants) {
      let lab = null;
      if (variant.swatchImagePath && fs.existsSync(variant.swatchImagePath)) {
        const stat = fs.statSync(variant.swatchImagePath);
        const key = `${variant.swatchImagePath}|${stat.mtimeMs}|${stat.size}`;
        if (diskCache[key]) {
          lab = diskCache[key];
        } else {
          lab = await extractSwatchColor(fs.readFileSync(variant.swatchImagePath));
          lab = { L: round(lab.L), a: round(lab.a), b: round(lab.b) };
          diskCache[key] = lab;
          dirty = true;
        }
      }

      variants.set(variant.variantId, {
        ...variant,
        category: product.category,
        productDisplayName: product.displayName,
        lab,
        hex: lab ? labToHex(lab) : null
      });
    }
  }

  if (dirty && cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify(diskCache)}\n`);
  }

  return {
    catalog,
    products,
    variants,
    categories: [...categories].sort(),
    getVariant(productId, variantId) {
      const variant = variants.get(variantId);
      return variant && variant.productId === productId ? variant : null;
    }
  };
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}
