import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, selectCandidates } from "./catalog.js";
import { generateProductPreview } from "./image-preview.js";
import { normalizeProvider, rerankProducts } from "./providers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CATALOG_DIR = path.join(ROOT_DIR, "window-products-v1");
const PORT = Number(process.env.PORT || 3000);
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

export function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/api/catalog") {
        return sendJson(res, publicCatalog());
      }

      if (req.method === "POST" && req.url === "/api/recommend") {
        return await handleRecommend(req, res);
      }

      if (req.method === "POST" && req.url === "/api/preview-image") {
        return await handlePreviewImage(req, res);
      }

      if (req.method === "GET" && req.url?.startsWith("/products/")) {
        return serveProductImage(req, res);
      }

      if (req.method === "GET") {
        return serveStatic(req, res);
      }

      sendJson(res, { error: "Method not allowed." }, 405);
    } catch (error) {
      sendJson(res, { error: error.message || "Unexpected server error." }, 500);
    }
  });
}

if (process.argv[1] === __filename) {
  const server = createAppServer();
  server.listen(PORT, () => {
    console.log(`Window design agent running at http://localhost:${PORT}`);
  });
}

async function handleRecommend(req, res) {
  const body = await readJson(req);
  const imageDataUrl = body.imageDataUrl;

  if (!imageDataUrl || !/^data:image\/(jpeg|jpg|png|webp|gif);base64,/.test(imageDataUrl)) {
    return sendJson(res, { error: "imageDataUrl must be a base64 image data URL." }, 400);
  }

  const provider = normalizeProvider(body.provider);
  const catalog = loadCatalog(CATALOG_DIR);
  const candidates = selectCandidates(catalog, Number(body.topK || catalog.products.length));
  const reranked = await rerankProducts({
    provider,
    model: body.model,
    userImageDataUrl: imageDataUrl,
    candidates
  });

  const response = normalizeRecommendation({
    catalog,
    candidates,
    provider: reranked.provider,
    model: reranked.model,
    result: reranked.result,
    rawText: reranked.rawText
  });

  sendJson(res, response);
}

async function handlePreviewImage(req, res) {
  const body = await readJson(req);
  const imageDataUrl = body.imageDataUrl;
  const productId = body.productId || body.recommendation?.productId;

  if (!imageDataUrl || !/^data:image\/(jpeg|jpg|png|webp|gif);base64,/.test(imageDataUrl)) {
    return sendJson(res, { error: "imageDataUrl must be a base64 image data URL." }, 400);
  }

  if (!productId) {
    return sendJson(res, { error: "productId is required." }, 400);
  }

  const catalog = loadCatalog(CATALOG_DIR);
  const product = catalog.products.find((candidate) => candidate.productId === productId);
  if (!product) {
    return sendJson(res, { error: `Unknown productId "${productId}".` }, 400);
  }

  const preview = await generateProductPreview({
    userImageDataUrl: imageDataUrl,
    product,
    recommendation: body.recommendation
  });

  sendJson(res, {
    productId: product.productId,
    category: product.category,
    displayName: product.displayName,
    productImageUrl: product.imageUrl,
    ...preview
  });
}

function normalizeRecommendation({ catalog, candidates, provider, model, result, rawText }) {
  const productsById = new Map(catalog.products.map((product) => [product.productId, product]));
  const candidateIds = new Set(candidates.map((product) => product.productId));
  const rankings = Array.isArray(result.rankings) ? result.rankings : [];

  const enrichedRankings = rankings
    .filter((ranking) => candidateIds.has(ranking.productId))
    .map((ranking, index) => {
      const product = productsById.get(ranking.productId);
      return {
        rank: Number(ranking.rank || index + 1),
        productId: product.productId,
        variantId: ranking.variantId || product.variants[0].variantId,
        category: product.category,
        displayName: product.displayName,
        imageUrl: product.imageUrl,
        score: clampScore(ranking.score),
        reason: ranking.reason || "",
        tradeoffs: Array.isArray(ranking.tradeoffs) ? ranking.tradeoffs : []
      };
    })
    .sort((a, b) => a.rank - b.rank);

  const fallbackBest = enrichedRankings[0] || catalog.products[0];
  const recommendationProduct =
    productsById.get(result.recommendation?.productId) ||
    productsById.get(fallbackBest.productId) ||
    catalog.products[0];

  return {
    provider,
    model,
    analysis: result.analysis || null,
    recommendation: {
      productId: recommendationProduct.productId,
      variantId: result.recommendation?.variantId || recommendationProduct.variants[0].variantId,
      category: recommendationProduct.category,
      displayName: recommendationProduct.displayName,
      imageUrl: recommendationProduct.imageUrl,
      confidence: clampScore(result.recommendation?.confidence),
      reason: result.recommendation?.reason || enrichedRankings[0]?.reason || ""
    },
    rankings: enrichedRankings,
    debug: {
      candidateCount: candidates.length,
      rawText
    }
  };
}

function publicCatalog() {
  const catalog = loadCatalog(CATALOG_DIR);
  return {
    catalogVersion: catalog.catalogVersion,
    products: catalog.products.map(({ imagePath, variants, ...product }) => ({
      ...product,
      variants: variants.map(({ imagePath: _imagePath, ...variant }) => variant)
    }))
  };
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url || "/index.html");
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, { error: "Forbidden." }, 403);
  }

  sendFile(res, filePath);
}

function serveProductImage(req, res) {
  const relativePath = decodeURIComponent((req.url || "").replace(/^\/products\//, ""));
  const filePath = path.normalize(path.join(CATALOG_DIR, relativePath));

  if (!filePath.startsWith(CATALOG_DIR)) {
    return sendJson(res, { error: "Forbidden." }, 403);
  }

  sendFile(res, filePath);
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, { error: "Not found." }, 404);
  }

  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": extension.match(/\.(jpg|jpeg|png|webp|gif)$/) ? "public, max-age=300" : "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}
