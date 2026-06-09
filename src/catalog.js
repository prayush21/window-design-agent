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

export function imageFileToDataUrl(filePath) {
  const bytes = fs.readFileSync(filePath);
  return `data:${getMimeType(filePath)};base64,${bytes.toString("base64")}`;
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

function makeProduct({ category, productId, imagePath, variantId, catalogDir }) {
  const normalizedProductId = productId || slugify(category);
  const normalizedVariantId = variantId || `${normalizedProductId}-default`;
  const imageUrl = makeImageUrl(imagePath, catalogDir);

  return {
    productId: normalizedProductId,
    category,
    displayName: productId && productId !== slugify(category) ? `${category} ${productId}` : category,
    familySlug: slugify(category),
    imagePath,
    imageUrl,
    variants: [
      {
        variantId: normalizedVariantId,
        productId: normalizedProductId,
        color: null,
        fabric: null,
        material: null,
        opacity: null,
        imagePath,
        imageUrl
      }
    ]
  };
}

export function loadCatalog(catalogDir = DEFAULT_CATALOG_DIR) {
  const products = [];
  const categories = listDirectories(catalogDir);

  for (const category of categories) {
    const categoryDir = path.join(catalogDir, category);
    const directImage = findPrimaryImage(categoryDir);

    if (directImage) {
      products.push(
        makeProduct({
          category,
          productId: slugify(category),
          imagePath: directImage,
          variantId: `${slugify(category)}-default`,
          catalogDir
        })
      );
    }

    for (const productId of listDirectories(categoryDir)) {
      const productDir = path.join(categoryDir, productId);
      const imagePath = findPrimaryImage(productDir);
      if (!imagePath) continue;

      products.push(
        makeProduct({
          category,
          productId,
          imagePath,
          variantId: `${productId}-default`,
          catalogDir
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
        imagePath: path.relative(ROOT_DIR, variant.imagePath)
      }))
    }))
  };
  console.log(JSON.stringify(publicCatalog, null, 2));
}
