import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CATALOG_DIR = path.join(ROOT_DIR, "window-products-v1");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getMimeType(filePath) {
  const detectedMimeType = detectMimeTypeFromFile(filePath);
  if (detectedMimeType) return detectedMimeType;

  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

function detectMimeTypeFromFile(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    return detectMimeTypeFromBytes(bytes);
  } catch {
    return null;
  }
}

export function detectMimeTypeFromBytes(bytes) {
  if (!bytes || bytes.length < 12) return null;

  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }

  return null;
}

function isImageFile(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function listDirectories(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function findPrimaryImage(dirPath) {
  if (!fs.existsSync(dirPath)) return null;

  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isImageFile(entry.name))
    .map((entry) => entry.name);

  const indexImage = files.find((file) => path.parse(file).name.toLowerCase() === "index");
  const selected = indexImage ?? files.sort((a, b) => a.localeCompare(b))[0];
  return selected ? path.join(dirPath, selected) : null;
}

function makeImageUrl(imagePath, catalogDir) {
  const relativeParts = path.relative(catalogDir, imagePath).split(path.sep);
  return `/products/${relativeParts.map(encodeURIComponent).join("/")}`;
}

function makeAssetReference({ assetPath, productDir, catalogDir }) {
  if (!assetPath) return null;
  const resolvedPath = path.isAbsolute(assetPath) ? assetPath : path.join(productDir, assetPath);
  return {
    path: resolvedPath,
    url: makeImageUrl(resolvedPath, catalogDir)
  };
}

function readProductMetadata(productDir) {
  const metadataPath = path.join(productDir, "product.json");
  if (!fs.existsSync(metadataPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid product metadata at ${metadataPath}: ${error.message}`);
  }
}

function normalizeVariant({ variant, productId, imagePath, imageUrl, productDir, catalogDir }) {
  const variantId = variant.variantId || `${productId}-${slugify(variant.name || "default")}`;
  const swatch = makeAssetReference({
    assetPath: variant.swatchImage,
    productDir,
    catalogDir
  });
  const installed = makeAssetReference({
    assetPath: variant.installedImage,
    productDir,
    catalogDir
  });

  return {
    variantId,
    productId,
    name: variant.name || variant.color || "Default",
    color: variant.color ?? null,
    colorFamily: variant.colorFamily ?? null,
    warmth: variant.warmth ?? null,
    fabric: variant.fabric ?? null,
    material: variant.material ?? null,
    texture: variant.texture ?? null,
    opacity: variant.opacity ?? null,
    styleTags: Array.isArray(variant.styleTags) ? variant.styleTags : [],
    bestFor: Array.isArray(variant.bestFor) ? variant.bestFor : [],
    avoidFor: Array.isArray(variant.avoidFor) ? variant.avoidFor : [],
    imagePath: installed?.path || imagePath,
    imageUrl: installed?.url || imageUrl,
    swatchImagePath: swatch?.path || null,
    swatchImageUrl: swatch?.url || null,
    installedImagePath: installed?.path || null,
    installedImageUrl: installed?.url || null
  };
}

function makeProduct({ category, productId, imagePath, variantId, catalogDir, productDir }) {
  const metadata = productDir ? readProductMetadata(productDir) : null;
  const normalizedProductId = productId || slugify(category);
  const metadataProductId = metadata?.productId || normalizedProductId;
  const normalizedVariantId = variantId || `${metadataProductId}-default`;
  const imageUrl = makeImageUrl(imagePath, catalogDir);
  const variants =
    Array.isArray(metadata?.variants) && metadata.variants.length > 0
      ? metadata.variants.map((variant) =>
          normalizeVariant({
            variant,
            productId: metadataProductId,
            imagePath,
            imageUrl,
            productDir,
            catalogDir
          })
        )
      : [
          {
            variantId: normalizedVariantId,
            productId: metadataProductId,
            name: "Default",
            color: null,
            colorFamily: null,
            warmth: null,
            fabric: null,
            material: null,
            texture: null,
            opacity: null,
            styleTags: [],
            bestFor: [],
            avoidFor: [],
            imagePath,
            imageUrl,
            swatchImagePath: null,
            swatchImageUrl: null,
            installedImagePath: null,
            installedImageUrl: null
          }
        ];

  return {
    productId: metadataProductId,
    category: metadata?.category || category,
    displayName:
      metadata?.displayName ||
      (productId && productId !== slugify(category) ? `${category} ${productId}` : category),
    description: metadata?.description || null,
    defaultVariantId: metadata?.defaultVariantId || variants[0].variantId,
    familySlug: slugify(category),
    imagePath,
    imageUrl,
    variants
  };
}

export function loadCatalog(catalogDir = DEFAULT_CATALOG_DIR) {
  const fingerprint = fingerprintCatalogDir(catalogDir);
  const cached = catalogCache.get(catalogDir);
  if (cached && cached.fingerprint === fingerprint) return cached.catalog;

  const catalog = readCatalog(catalogDir);
  catalogCache.set(catalogDir, { fingerprint, catalog });
  return catalog;
}

const catalogCache = new Map();

// Cheap staleness check: directory and metadata mtimes only, no file reads or
// JSON parsing. Enough to notice added, removed, or edited products.
function fingerprintCatalogDir(catalogDir) {
  if (!fs.existsSync(catalogDir)) return "missing";

  const parts = [];
  const visit = (dirPath) => {
    parts.push(`${dirPath}:${fs.statSync(dirPath).mtimeMs}`);
    for (const name of listDirectories(dirPath)) visit(path.join(dirPath, name));
    const metadataPath = path.join(dirPath, "product.json");
    if (fs.existsSync(metadataPath)) parts.push(`${metadataPath}:${fs.statSync(metadataPath).mtimeMs}`);
  };

  visit(catalogDir);
  return parts.join("|");
}

function readCatalog(catalogDir) {
  const products = [];
  const categories = listDirectories(catalogDir);

  for (const category of categories) {
    const categoryDir = path.join(catalogDir, category);
    const directImage = findPrimaryImage(categoryDir);
    const productDirs = listDirectories(categoryDir);

    // A category-level image alongside real SKU folders is a family thumbnail, not
    // a product. Emitting it created a metadata-less duplicate that competed in the
    // ranking with no color, material, or texture at all.
    if (directImage && productDirs.length === 0) {
      products.push(
        makeProduct({
          category,
          productId: slugify(category),
          imagePath: directImage,
          variantId: `${slugify(category)}-default`,
          catalogDir,
          productDir: categoryDir
        })
      );
    }

    for (const productId of productDirs) {
      const productDir = path.join(categoryDir, productId);
      const imagePath = findPrimaryImage(productDir);
      if (!imagePath) continue;

      products.push(
        makeProduct({
          category,
          productId,
          imagePath,
          variantId: `${productId}-default`,
          catalogDir,
          productDir
        })
      );
    }
  }

  return {
    catalogVersion: "window-products-v1",
    catalogDir,
    products
  };
}

export function selectCandidates(catalog, topK = catalog.products.length) {
  return catalog.products.slice(0, Math.max(1, Math.min(topK, catalog.products.length)));
}

if (process.argv[1] === __filename) {
  const catalog = loadCatalog();
  const publicCatalog = {
    ...catalog,
    products: catalog.products.map(({ imagePath, variants, ...product }) => ({
      ...product,
      imagePath: path.relative(ROOT_DIR, imagePath),
      variants: variants.map((variant) => ({
        ...variant,
        imagePath: path.relative(ROOT_DIR, variant.imagePath),
        swatchImagePath: variant.swatchImagePath ? path.relative(ROOT_DIR, variant.swatchImagePath) : null,
        installedImagePath: variant.installedImagePath
          ? path.relative(ROOT_DIR, variant.installedImagePath)
          : null
      }))
    }))
  };
  console.log(JSON.stringify(publicCatalog, null, 2));
}
