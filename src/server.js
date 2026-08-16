import "./env.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMimeType, loadCatalog, selectCandidates } from "./catalog.js";
import { handleEvalRequest } from "./eval/label-api.js";
import { generateProductPreview } from "./image-preview.js";
import { DEFAULT_RECOMMENDATION_PROMPT, normalizeProvider, rerankProducts } from "./providers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CATALOG_DIR = path.join(ROOT_DIR, "window-products-v1");
const PORT = Number(process.env.PORT || 3000);
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_RANKED_OPTIONS = 10;

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

      if (req.method === "GET" && req.url === "/api/default-prompt") {
        return sendJson(res, { systemPrompt: DEFAULT_RECOMMENDATION_PROMPT });
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

      if (await handleEvalRequest(req, res, { rootDir: ROOT_DIR })) {
        return;
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
    systemPrompt: body.systemPrompt,
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
  const variantId = body.variantId || body.recommendation?.variantId;

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

  const variant = findVariant(product, variantId) || findVariant(product, product.defaultVariantId) || product.variants[0];
  if (variantId && variant.variantId !== variantId) {
    return sendJson(res, { error: `Unknown variantId "${variantId}" for productId "${productId}".` }, 400);
  }

  const preview = await generateProductPreview({
    provider: body.imageProvider,
    model: body.imageModel,
    userImageDataUrl: imageDataUrl,
    product,
    variant,
    recommendation: body.recommendation
  });

  sendJson(res, {
    productId: product.productId,
    variantId: variant.variantId,
    category: product.category,
    displayName: product.displayName,
    variantName: variant.name,
    swatchImageUrl: variant.swatchImageUrl,
    productImageUrl: product.imageUrl,
    ...preview
  });
}

export function normalizeRecommendation({ catalog, candidates, provider, model, result, rawText }) {
  const productsById = new Map(catalog.products.map((product) => [product.productId, product]));
  const candidateVariantIds = new Set(
    candidates.flatMap((product) => product.variants.map((variant) => variant.variantId))
  );
  const rankings = Array.isArray(result.rankings) ? result.rankings : [];

  const enrichedRankings = rankings
    .filter((ranking) => {
      const product = productsById.get(ranking.productId);
      const variant = product && findVariant(product, ranking.variantId);
      return Boolean(product && variant && candidateVariantIds.has(variant.variantId));
    })
    .map((ranking, index) => {
      const product = productsById.get(ranking.productId);
      const variant = findVariant(product, ranking.variantId) || product.variants[0];
      return {
        rank: Number(ranking.rank || index + 1),
        productId: product.productId,
        variantId: variant.variantId,
        category: product.category,
        displayName: product.displayName,
        variantName: variant.name,
        color: variant.color,
        colorFamily: variant.colorFamily,
        material: variant.material,
        texture: variant.texture,
        opacity: variant.opacity,
        imageUrl: product.imageUrl,
        swatchImageUrl: variant.swatchImageUrl,
        score: clampScore(ranking.score),
        reason: ranking.reason || "",
        tradeoffs: Array.isArray(ranking.tradeoffs) ? ranking.tradeoffs : []
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_RANKED_OPTIONS);

  // Every fallback below is a case where the model did not give us a usable answer.
  // Without these warnings a total failure is indistinguishable from a real
  // recommendation: the client just sees catalog.products[0] at 0% confidence.
  const warnings = [];
  if (rankings.length === 0) warnings.push("model-returned-no-rankings");
  if (rankings.length > 0 && enrichedRankings.length === 0) warnings.push("all-rankings-invalid");
  if (enrichedRankings.length < rankings.length) {
    warnings.push(`dropped-${rankings.length - enrichedRankings.length}-invalid-rankings`);
  }
  if (result.recommendation?.productId && !productsById.get(result.recommendation.productId)) {
    warnings.push("recommended-product-not-in-catalog");
  }

  const fallbackBest = enrichedRankings[0] || null;
  const recommendationProduct =
    productsById.get(result.recommendation?.productId) ||
    (fallbackBest && productsById.get(fallbackBest.productId)) ||
    catalog.products[0];
  const recommendationVariant =
    findVariant(recommendationProduct, result.recommendation?.variantId) ||
    (fallbackBest && findVariant(recommendationProduct, fallbackBest.variantId)) ||
    findVariant(recommendationProduct, recommendationProduct.defaultVariantId) ||
    recommendationProduct.variants[0];

  // Nothing the model said survived — the answer below is a default, not a choice.
  const defaulted = !fallbackBest && !productsById.get(result.recommendation?.productId);
  if (defaulted) warnings.push("recommendation-defaulted-to-first-catalog-product");

  return {
    provider,
    model,
    analysis: result.analysis || null,
    recommendation: {
      productId: recommendationProduct.productId,
      variantId: recommendationVariant.variantId,
      category: recommendationProduct.category,
      displayName: recommendationProduct.displayName,
      variantName: recommendationVariant.name,
      color: recommendationVariant.color,
      colorFamily: recommendationVariant.colorFamily,
      material: recommendationVariant.material,
      texture: recommendationVariant.texture,
      opacity: recommendationVariant.opacity,
      imageUrl: recommendationProduct.imageUrl,
      swatchImageUrl: recommendationVariant.swatchImageUrl,
      confidence: clampScore(result.recommendation?.confidence),
      reason: result.recommendation?.reason || enrichedRankings[0]?.reason || ""
    },
    rankings: enrichedRankings,
    warnings,
    debug: {
      candidateCount: candidates.reduce((count, product) => count + product.variants.length, 0),
      returnedRankingCount: rankings.length,
      keptRankingCount: enrichedRankings.length,
      defaulted,
      rawText
    }
  };
}

function findVariant(product, variantId) {
  if (!product) return null;
  return product.variants.find((variant) => variant.variantId === variantId) || null;
}

function publicCatalog() {
  const catalog = loadCatalog(CATALOG_DIR);
  return {
    catalogVersion: catalog.catalogVersion,
    products: catalog.products.map(({ imagePath, variants, ...product }) => ({
      ...product,
      variants: variants.map(
        ({
          imagePath: _imagePath,
          swatchImagePath: _swatchImagePath,
          installedImagePath: _installedImagePath,
          ...variant
        }) => variant
      )
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
  const contentType = MIME_TYPES[extension]?.startsWith("image/")
    ? getMimeType(filePath)
    : MIME_TYPES[extension];
  res.writeHead(200, {
    "Content-Type": contentType || "application/octet-stream",
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
