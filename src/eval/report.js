import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOM_THUMB = 380;
const SWATCH_THUMB = 72;

// Metrics where a higher number is worse, so the diff arrow points the right way.
const LOWER_IS_BETTER = new Set([
  "violationAt3",
  "silentFallback",
  "avoidForViolation",
  "latencyMs",
  "inputTokens",
  "totalTokens",
  "imageCount",
  "duplicateImageCount",
  "approxImageBytes"
]);

// Rates render as percentages; everything else is a raw count. Inferring this from
// magnitude breaks whenever a count legitimately reaches 0 or 1.
const RATE_KEYS = new Set([
  "acceptableAt1",
  "acceptableAt3",
  "idealAt1",
  "idealAt3",
  "violationAt3",
  "categoryAt1",
  "schemaValid",
  "silentFallback",
  "recommendationMatchesRank1",
  "avoidForViolation",
  "gracefulFailure",
  "groundedRate"
]);

const QUALITY_ROWS = [
  ["acceptableAt1", "Acceptable @1"],
  ["acceptableAt3", "Acceptable @3"],
  ["idealAt1", "Ideal @1"],
  ["categoryAt1", "Category @1"],
  ["violationAt3", "Violation @3"]
];

const HEALTH_ROWS = [
  ["schemaValid", "Schema valid"],
  ["silentFallback", "Silent fallback"],
  ["recommendationMatchesRank1", "Rec == rank 1"],
  ["avoidForViolation", "avoidFor conflict"],
  ["gracefulFailure", "Graceful failure"]
];

export function printConsoleReport(report) {
  const { summary, variance } = report;
  const lines = [];

  lines.push("", bold("Quality (labeled)"));
  const quality = QUALITY_ROWS.map(([key, label]) => [label, formatRate(summary[key])]);
  lines.push(...table(quality));

  lines.push("", bold("Health (no labels needed)"));
  const health = HEALTH_ROWS.map(([key, label]) => [label, formatRate(summary[key])]);
  health.push(["Grounded rate", formatPercent(summary.groundedRate)]);
  lines.push(...table(health));

  lines.push("", bold("Cost"));
  lines.push(
    ...table([
      ["Input tokens", formatNumber(summary.inputTokens)],
      ["Total tokens", formatNumber(summary.totalTokens)],
      ["Images sent", formatNumber(summary.imageCount)],
      ["  of which duplicate", formatNumber(summary.duplicateImageCount)],
      ["Image payload", summary.approxImageBytes ? `${(summary.approxImageBytes / 1e6).toFixed(2)} MB` : "—"],
      ["Latency", summary.latencyMs ? `${Math.round(summary.latencyMs)} ms` : "— (cached)"]
    ])
  );

  if (variance) {
    lines.push("", bold("Variance (identical inputs)"));
    lines.push(
      ...table([
        ["Rank-1 stability", formatPercent(variance.rank1Stability)],
        ["Top-5 overlap", formatPercent(variance.top5Jaccard)]
      ])
    );
    const unstable = variance.perCase.filter((entry) => entry.rank1Stability < 1);
    if (unstable.length > 0) {
      lines.push(
        `  unstable: ${unstable
          .map((entry) => `${entry.caseId} (${entry.distinctRank1} distinct)`)
          .join(", ")}`
      );
      lines.push(
        dim(
          `  → a labeled-metric move smaller than ~${Math.round((1 - variance.rank1Stability) * 100)} pts is noise.`
        )
      );
    }
  }

  if (report.errors.length > 0) {
    lines.push("", bold(`Errors (${report.errors.length})`));
    for (const entry of report.errors) lines.push(`  ${entry.caseId}: ${entry.error}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printDiff(baseline, current) {
  const rows = [];
  const keys = [
    ...QUALITY_ROWS,
    ...HEALTH_ROWS,
    ["groundedRate", "Grounded rate"],
    ["inputTokens", "Input tokens"],
    ["totalTokens", "Total tokens"],
    ["imageCount", "Images sent"],
    ["duplicateImageCount", "Duplicate images"],
    ["latencyMs", "Latency (ms)"]
  ];

  for (const [key, label] of keys) {
    const before = rateValue(baseline.summary[key]);
    const after = rateValue(current.summary[key]);
    if (before === null && after === null) continue;
    rows.push([label, formatDiffValue(key, before), "→", formatDiffValue(key, after), arrow(key, before, after)]);
  }

  process.stdout.write(`\n${bold(`Diff vs ${baseline.runId}`)}\n${table(rows).join("\n")}\n`);
}

function arrow(key, before, after) {
  if (before === null || after === null) return "";
  const delta = after - before;
  if (Math.abs(delta) < 1e-9) return dim("=");
  const better = LOWER_IS_BETTER.has(key) ? delta < 0 : delta > 0;
  const sign = delta > 0 ? "+" : "";
  const magnitude = RATE_KEYS.has(key)
    ? `${sign}${(delta * 100).toFixed(0)} pts`
    : `${sign}${Math.round(delta).toLocaleString("en-US")}`;
  return better ? green(`▲ ${magnitude}`) : red(`▼ ${magnitude}`);
}

function formatDiffValue(key, value) {
  if (value === null) return "—";
  return RATE_KEYS.has(key) ? `${(value * 100).toFixed(0)}%` : formatNumber(value);
}

function rateValue(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "number") return entry;
  return typeof entry.rate === "number" ? entry.rate : null;
}

function formatRate(entry) {
  if (!entry) return dim("— no labels");
  return `${(entry.rate * 100).toFixed(0)}%  ${dim(`(n=${entry.n})`)}`;
}

function formatPercent(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(0)}%` : dim("—");
}

function formatNumber(value) {
  return typeof value === "number" ? Math.round(value).toLocaleString("en-US") : dim("—");
}

function table(rows) {
  if (rows.length === 0) return [];
  const widths = rows[0].map((_unused, column) =>
    Math.max(...rows.map((row) => visibleLength(String(row[column] ?? ""))))
  );
  return rows.map(
    (row) =>
      `  ${row
        .map((cell, column) => padVisible(String(cell ?? ""), widths[column]))
        .join("  ")
        .trimEnd()}`
  );
}

const ANSI = /\[[0-9;]*m/g;
const visibleLength = (value) => value.replace(ANSI, "").length;
const padVisible = (value, width) => value + " ".repeat(Math.max(0, width - visibleLength(value)));

const useColor = process.stdout.isTTY;
const wrap = (code, value) => (useColor ? `[${code}m${value}[0m` : value);
const bold = (value) => wrap("1", value);
const dim = (value) => wrap("2", value);
const green = (value) => wrap("32", value);
const red = (value) => wrap("31", value);

export async function writeHtmlReport({ report, cases, catalog, evalsDir, outFile }) {
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const variantsById = new Map();
  for (const product of catalog.products) {
    for (const variant of product.variants) {
      variantsById.set(variant.variantId, { ...variant, category: product.category, product });
    }
  }

  const swatchCache = new Map();
  const thumb = async (filePath, width) => {
    const key = `${filePath}:${width}`;
    if (swatchCache.has(key)) return swatchCache.get(key);
    try {
      const buffer = await sharp(fs.readFileSync(filePath))
        .rotate()
        .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toBuffer();
      const dataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
      swatchCache.set(key, dataUrl);
      return dataUrl;
    } catch {
      return null;
    }
  };

  // One block per case: the room, what won, and why it passed or failed.
  const firstRunByCase = new Map();
  for (const score of report.scores) {
    if (!firstRunByCase.has(score.caseId)) firstRunByCase.set(score.caseId, score);
  }

  const blocks = [];
  for (const [caseId, score] of firstRunByCase) {
    const testCase = casesById.get(caseId);
    const roomThumb = testCase ? await thumb(path.join(evalsDir, testCase.photo), ROOM_THUMB) : null;

    const rankedHtml = [];
    for (const variantId of score.ranked.slice(0, 5)) {
      const variant = variantsById.get(variantId);
      const swatch = variant?.swatchImagePath ? await thumb(variant.swatchImagePath, SWATCH_THUMB) : null;
      const status = testCase?.labels.unacceptable.includes(variantId)
        ? "bad"
        : testCase?.labels.acceptable.includes(variantId)
          ? "good"
          : "neutral";
      rankedHtml.push(`
        <li class="rank ${status}">
          ${swatch ? `<img src="${swatch}" alt="" />` : `<span class="noswatch"></span>`}
          <span class="rank-name">${escapeHtml(variant?.product?.displayName || variantId)}</span>
          <span class="rank-variant">${escapeHtml(variant?.name || "")}</span>
        </li>`);
    }

    const verdicts = [
      badge("acceptable@1", score.labeled.acceptableAt1),
      badge("acceptable@3", score.labeled.acceptableAt3),
      badge("category@1", score.labeled.categoryAt1),
      badge("violation@3", score.labeled.violationAt3, true),
      badge("silent fallback", score.unlabeled.silentFallback, true),
      badge("rec==rank1", score.unlabeled.recommendationMatchesRank1)
    ].join("");

    blocks.push(`
      <section class="case">
        <div class="case-photo">
          ${roomThumb ? `<img src="${roomThumb}" alt="${escapeHtml(caseId)}" />` : `<div class="missing">photo missing</div>`}
          <h3>${escapeHtml(caseId)}</h3>
          ${testCase?.notes ? `<p class="notes">${escapeHtml(testCase.notes)}</p>` : ""}
        </div>
        <div class="case-body">
          <div class="badges">${verdicts}</div>
          <ol class="ranks">${rankedHtml.join("")}</ol>
        </div>
      </section>`);
  }

  const summaryRows = [...QUALITY_ROWS, ...HEALTH_ROWS]
    .map(([key, label]) => {
      const entry = report.summary[key];
      return `<tr><td>${escapeHtml(label)}</td><td>${
        entry ? `${(entry.rate * 100).toFixed(0)}% <span class="n">n=${entry.n}</span>` : "—"
      }</td></tr>`;
    })
    .join("");

  fs.writeFileSync(outFile, htmlShell({ report, summaryRows, blocks: blocks.join("") }));
}

function badge(label, value, lowerIsBetter = false) {
  if (value === null || value === undefined) return "";
  const good = lowerIsBetter ? !value : value;
  return `<span class="badge ${good ? "ok" : "fail"}">${escapeHtml(label)}</span>`;
}

function htmlShell({ report, summaryRows, blocks }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Eval ${escapeHtml(report.runId)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#131313; --fg:#eee; --muted:#999; --line:#2c2c2c; --card:#1b1b1b; } }
  body { margin:0; padding:32px; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,-apple-system,Segoe UI,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } h3 { font-size:13px; margin:8px 0 2px; }
  .meta { color:var(--muted); font-size:12px; margin-bottom:24px; }
  table { border-collapse:collapse; margin-bottom:32px; min-width:320px; }
  td { padding:5px 16px 5px 0; border-bottom:1px solid var(--line); }
  .n { color:var(--muted); font-size:11px; }
  .case { display:grid; grid-template-columns:minmax(0,240px) minmax(0,1fr); gap:20px;
          padding:18px 0; border-top:1px solid var(--line); align-items:start; }
  .case-photo img { width:100%; border-radius:8px; display:block; }
  .missing { padding:40px 0; text-align:center; color:var(--muted); background:var(--card); border-radius:8px; }
  .notes { color:var(--muted); font-size:12px; margin:2px 0 0; }
  .badges { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:99px; }
  .badge.ok { background:#d8f0dc; color:#14532d; } .badge.fail { background:#fadcdc; color:#7f1d1d; }
  @media (prefers-color-scheme: dark) {
    .badge.ok { background:#14361f; color:#8ee2a4; } .badge.fail { background:#3d1717; color:#f2a0a0; }
  }
  .ranks { list-style:none; display:flex; gap:10px; padding:0; margin:0; overflow-x:auto; }
  .rank { width:96px; flex:0 0 auto; font-size:11px; padding:6px; border-radius:8px;
          background:var(--card); border:2px solid transparent; }
  .rank.good { border-color:#5bbb72; } .rank.bad { border-color:#d96363; }
  .rank img, .noswatch { width:100%; aspect-ratio:1; border-radius:5px; display:block; background:var(--line); }
  .rank-name { display:block; margin-top:5px; font-weight:600; }
  .rank-variant { color:var(--muted); }
</style></head><body>
<h1>Eval run ${escapeHtml(report.runId)}</h1>
<div class="meta">${escapeHtml(report.provider)}${report.model ? ` · ${escapeHtml(report.model)}` : ""}
 · ${report.summary.caseCount} cases · ${report.repeat} run(s) each · prompt ${escapeHtml(report.promptHash)}
 · catalog ${escapeHtml(report.catalogFingerprint)}</div>
<table>${summaryRows}</table>
${blocks}
</body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
