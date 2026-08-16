import "../env.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, selectCandidates } from "../catalog.js";
import {
  DEFAULT_RECOMMENDATION_PROMPT,
  RERANK_REQUEST_VERSION,
  normalizeProvider,
  rerankProducts
} from "../providers.js";
import { normalizeRecommendation } from "../server.js";
import { evalPaths, listRoomPhotos, reconcileCases } from "./label-api.js";
import { aggregate, computeVariance, scoreRun, withImpliedLabels } from "./metrics.js";
import { printConsoleReport, printDiff, writeHtmlReport } from "./report.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..", "..");
const CATALOG_DIR = path.join(ROOT_DIR, "window-products-v1");

const USAGE = `Usage: npm run eval -- [options]

  --provider <name>     openai | gemini | anthropic   (default: env DESIGN_AGENT_PROVIDER, else gemini)
  --model <id>          model override
  --repeat <n>          runs per case, for variance measurement (default: 1)
  --case <substring>    only cases whose id contains this
  --concurrency <n>     parallel cases (default: 2)
  --fresh               bypass the response cache
  --baseline <runId>    diff this run against a previous run in evals/runs
  --prompt-file <path>  use a system prompt from a file instead of the default
  --help
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const paths = evalPaths(ROOT_DIR);
  const rooms = listRoomPhotos(paths.roomsDir);

  if (rooms.length === 0) {
    process.stderr.write(
      `No room photos found in ${path.relative(ROOT_DIR, paths.roomsDir)}.\n` +
        `Add .jpg/.png/.webp files there, then run the labeling page:\n` +
        `  npm run dev   →   http://localhost:3000/eval-label.html\n`
    );
    return 1;
  }

  const catalog = loadCatalog(CATALOG_DIR);
  const allCases = reconcileCases(paths.casesFile, paths.roomsDir).cases;
  const cases = (args.case ? allCases.filter((c) => c.id.includes(args.case)) : allCases).map(
    withImpliedLabels
  );

  if (cases.length === 0) {
    process.stderr.write(`No cases matched --case "${args.case}".\n`);
    return 1;
  }

  const provider = normalizeProvider(args.provider);
  const systemPrompt = args.promptFile
    ? fs.readFileSync(path.resolve(ROOT_DIR, args.promptFile), "utf8")
    : DEFAULT_RECOMMENDATION_PROMPT;
  const catalogFingerprint = fingerprintCatalog(catalog);
  const labeledCount = cases.filter(
    (c) => c.labels.acceptable.length > 0 || c.labels.unacceptable.length > 0
  ).length;

  process.stdout.write(
    `\nProvider ${provider}${args.model ? ` (${args.model})` : ""} · ${cases.length} cases · ` +
      `${args.repeat} run${args.repeat === 1 ? "" : "s"} each · ${labeledCount}/${cases.length} labeled\n\n`
  );

  const jobs = cases.flatMap((testCase) =>
    Array.from({ length: args.repeat }, (_unused, repeatIndex) => ({ testCase, repeatIndex }))
  );

  const results = await runPool(jobs, args.concurrency, async ({ testCase, repeatIndex }) => {
    const photoPath = path.join(paths.evalsDir, testCase.photo);
    try {
      const outcome = await runOnce({
        testCase,
        photoPath,
        catalog,
        provider,
        model: args.model,
        systemPrompt,
        repeatIndex,
        catalogFingerprint,
        cacheDir: paths.cacheDir,
        fresh: args.fresh
      });
      process.stdout.write(
        `  ${outcome.cached ? "·" : "→"} ${testCase.id}${args.repeat > 1 ? ` #${repeatIndex + 1}` : ""} ` +
          `${outcome.score.chosenName || "?"}\n`
      );
      return outcome;
    } catch (error) {
      process.stdout.write(`  ✗ ${testCase.id} — ${error.message}\n`);
      return { testCase, error: error.message, score: null };
    }
  });

  const scores = results.filter((result) => result.score).map((result) => result.score);
  const errors = results.filter((result) => result.error);

  if (scores.length === 0) {
    process.stderr.write(`\nAll ${errors.length} runs failed. First error: ${errors[0]?.error}\n`);
    return 1;
  }

  const scoresByCase = new Map();
  for (const score of scores) {
    if (!scoresByCase.has(score.caseId)) scoresByCase.set(score.caseId, []);
    scoresByCase.get(score.caseId).push(score);
  }

  const report = {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    startedAt: new Date().toISOString(),
    provider,
    model: args.model || null,
    repeat: args.repeat,
    catalogFingerprint,
    promptHash: hash(systemPrompt).slice(0, 12),
    summary: aggregate(scores),
    variance: computeVariance(scoresByCase),
    scores,
    errors: errors.map((entry) => ({ caseId: entry.testCase.id, error: entry.error }))
  };

  const runDir = path.join(paths.runsDir, report.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeHtmlReport({ report, cases, catalog, evalsDir: paths.evalsDir, outFile: path.join(runDir, "report.html") });

  printConsoleReport(report);

  if (args.baseline) {
    const baselineFile = path.join(paths.runsDir, args.baseline, "report.json");
    if (!fs.existsSync(baselineFile)) {
      process.stderr.write(`\nBaseline run "${args.baseline}" not found at ${baselineFile}\n`);
    } else {
      printDiff(JSON.parse(fs.readFileSync(baselineFile, "utf8")), report);
    }
  }

  process.stdout.write(
    `\nreport  ${path.relative(ROOT_DIR, path.join(runDir, "report.html"))}\n` +
      `baseline for next run:  --baseline ${report.runId}\n\n`
  );

  return errors.length > 0 ? 1 : 0;
}

async function runOnce({
  testCase,
  photoPath,
  catalog,
  provider,
  model,
  systemPrompt,
  repeatIndex,
  catalogFingerprint,
  cacheDir,
  fresh
}) {
  const photoBytes = fs.readFileSync(photoPath);
  // repeatIndex is part of the key so --repeat measures real variance
  // instead of replaying one cached response N times.
  const cacheKey = hash(
    JSON.stringify({
      photo: hash(photoBytes),
      systemPrompt,
      provider,
      model: model || null,
      catalogFingerprint,
      // Without this, changing how the request is built would silently replay
      // responses produced by the old request shape.
      requestVersion: RERANK_REQUEST_VERSION,
      repeatIndex
    })
  );
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

  let payload = null;
  let cached = false;

  if (!fresh && fs.existsSync(cacheFile)) {
    payload = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    cached = true;
  } else {
    const candidates = selectCandidates(catalog, catalog.products.length);
    const reranked = await rerankProducts({
      provider,
      model,
      systemPrompt,
      userImageDataUrl: toDataUrl(photoPath, photoBytes),
      candidates
    });
    payload = {
      result: reranked.result,
      rawText: reranked.rawText,
      provider: reranked.provider,
      model: reranked.model,
      usage: reranked.usage,
      requestStats: reranked.requestStats,
      latencyMs: reranked.latencyMs
    };
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify(payload, null, 2)}\n`);
  }

  const candidates = selectCandidates(catalog, catalog.products.length);
  const normalized = normalizeRecommendation({
    catalog,
    candidates,
    provider: payload.provider,
    model: payload.model,
    result: payload.result,
    rawText: payload.rawText
  });

  return {
    testCase,
    cached,
    score: scoreRun({
      testCase,
      catalog,
      raw: payload.result,
      normalized,
      // A cached latency would describe a disk read, not the provider.
      latencyMs: cached ? null : payload.latencyMs,
      usage: payload.usage,
      requestStats: payload.requestStats
    })
  };
}

async function runPool(jobs, concurrency, worker) {
  const results = new Array(jobs.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(jobs[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

function fingerprintCatalog(catalog) {
  const shape = catalog.products.map((product) => ({
    productId: product.productId,
    variants: product.variants.map((variant) => variant.variantId),
    image: fs.statSync(product.imagePath).size
  }));
  return hash(JSON.stringify(shape)).slice(0, 16);
}

function toDataUrl(filePath, bytes) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType =
    extension === ".png"
      ? "image/png"
      : extension === ".webp"
        ? "image/webp"
        : extension === ".gif"
          ? "image/gif"
          : "image/jpeg";
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = {
    provider: process.env.DESIGN_AGENT_PROVIDER || "gemini",
    model: null,
    repeat: 1,
    case: null,
    concurrency: 2,
    fresh: false,
    baseline: null,
    promptFile: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];

    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--provider") args.provider = next();
    else if (flag === "--model") args.model = next();
    else if (flag === "--repeat") args.repeat = Math.max(1, Number(next()) || 1);
    else if (flag === "--case") args.case = next();
    else if (flag === "--concurrency") args.concurrency = Math.max(1, Number(next()) || 1);
    else if (flag === "--fresh") args.fresh = true;
    else if (flag === "--baseline") args.baseline = next();
    else if (flag === "--prompt-file") args.promptFile = next();
    else process.stderr.write(`Ignoring unknown flag "${flag}"\n`);
  }

  return args;
}

if (process.argv[1] === __filename) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`\n${error.stack || error.message}\n`);
      process.exit(1);
    }
  );
}
