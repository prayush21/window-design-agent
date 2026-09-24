import "../env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, catalogDir, resolveConfig, resolvePath } from "../v2/config.js";
import { loadCatalogIndex } from "../v2/catalog-index.js";
import perceive from "../v2/stages/perceive.js";
import plan from "../v2/stages/plan.js";
import { buildBrief } from "../v2/stages/brief.js";
import { readCritiqueLabels, readPairwise, v2EvalPaths } from "./v2-labels.js";
import {
  critiqueAgreement,
  directionDiversity,
  guidelineCompliance,
  mean,
  perceptionAgreement,
  renderFaithfulness
} from "./v2-metrics.js";

// npm run v2:eval — per-stage metrics over v2 traces, each next to the no-model
// baseline that stage has to beat. Makes no model calls: baselines are code.
//
//   perception      Brief vs evals/briefs/<room>.json      baseline: k-means perception
//   compliance      proposals in allowed categories         (automatic)
//   diversity       pairwise axis difference, top-pick ΔE   baseline: template planner
//   faithfulness    render ΔE vs swatch                     (automatic)
//   critique        verdict vs evals/critique-labels.json   baseline: always accept
//   end-to-end      v2 vs v1 in evals/pairwise.json         (win rate)
//   noise floor     agreement across repeated sessions of one room (--repeat)

const USAGE = `Usage: npm run v2:eval -- [--dir traces] [--mode mock|live|baseline] [--json out.json]`;

export async function main(argv = process.argv.slice(2)) {
  const args = { dir: null, mode: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") args.dir = argv[(i += 1)];
    else if (argv[i] === "--mode") args.mode = argv[(i += 1)];
    else if (argv[i] === "--json") args.json = argv[(i += 1)];
    else if (argv[i] === "--help") return process.stdout.write(`${USAGE}\n`), 0;
  }
  const config = resolveConfig({ mode: "mock" });
  const dir = args.dir ? path.resolve(ROOT_DIR, args.dir) : resolvePath(config, "traces");
  const result = await evaluate({ dir, config, mode: args.mode });
  printResult(result);
  if (args.json) fs.writeFileSync(path.resolve(ROOT_DIR, args.json), `${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

export async function evaluate({ dir, config, mode = null }) {
  const catalog = await loadCatalogIndex({ catalogDir: catalogDir(), cacheDir: resolvePath(config, "cache") });
  const paths = v2EvalPaths(ROOT_DIR);
  // Baseline-mode traces are the baseline, not a model: they are only compared against.
  const traces = readTraces(dir).filter((t) => (mode ? t.mode === mode : t.mode !== "baseline"));
  const ctx = { config, catalog, warn: () => {} };

  // Perception, model vs the no-model baseline, on rooms with a hand-written brief.
  const perception = [];
  for (const trace of traces) {
    const roomId = trace.roomPhoto?.roomId;
    const briefFile = path.join(paths.briefsDir, `${roomId}.json`);
    if (!roomId || !fs.existsSync(briefFile) || !trace.brief) continue;
    const hand = JSON.parse(fs.readFileSync(briefFile, "utf8"));
    const baselineEnv = await perceive.baseline({ roomPhoto: trace.roomPhoto }, ctx);
    const baselineBrief = buildBrief(baselineEnv, {});
    perception.push({
      roomId,
      sessionId: trace.sessionId,
      model: perceptionAgreement(trace, hand)?.accuracy ?? null,
      baseline: perceptionAgreement({ brief: baselineBrief }, hand)?.accuracy ?? null
    });
  }

  // Diversity, model directions vs the template planner on the same Brief.
  const diversity = [];
  for (const trace of traces) {
    if (!trace.brief || trace.directions.length < 3) continue;
    const templated = await plan.baseline({ brief: trace.brief }, ctx);
    diversity.push({
      roomId: trace.roomPhoto?.roomId,
      model: directionDiversity(trace)?.meanAxes ?? null,
      baseline: directionDiversity({ ...trace, directions: templated.directions, proposals: [], shortlists: {} })?.meanAxes ?? null
    });
  }

  const compliance = traces.map((t) => guidelineCompliance(t, catalog)).filter(Boolean);
  const faithfulness = traces.map((t) => renderFaithfulness(t)).filter(Boolean);

  const labels = readCritiqueLabels(paths.critiqueLabels).labels;
  const critique = critiqueAgreement(traces, labels);
  const alwaysAccept = critiqueAgreement(
    traces.map((t) => ({ ...t, critiques: t.critiques.map((c) => ({ ...c, verdict: "ACCEPT" })) })),
    labels
  );

  // COMPOSE vs RETRIEVE's top pick: how often does the model deviate from code?
  const composeDeviation = [];
  for (const trace of traces) {
    for (const p of trace.proposals.filter((x) => x.source === "model" && x.excluded.length === 0)) {
      const top = trace.shortlists[p.directionId]?.layers.visual.candidates[0];
      if (top) composeDeviation.push(p.visual.variantId === top.variantId ? 0 : 1);
    }
  }

  const judgments = readPairwise(paths.pairwise).judgments;
  const decisive = judgments.filter((j) => j.winner !== "tie");

  return {
    traces: traces.length,
    modes: [...new Set(traces.map((t) => t.mode))],
    perception: summarizePair(perception),
    compliance: compliance.length ? { rate: mean(compliance.map((c) => c.rate)), proposals: compliance.reduce((n, c) => n + c.n, 0) } : null,
    diversity: summarizePair(diversity),
    faithfulness: faithfulness.length
      ? { meanDeltaE: mean(faithfulness.map((f) => f.meanDeltaE)), passRate: mean(faithfulness.map((f) => f.passRate)), renders: faithfulness.reduce((n, f) => n + f.n, 0) }
      : null,
    critique: { model: critique, alwaysAccept },
    composeDeviationFromRetrieveTop: composeDeviation.length ? mean(composeDeviation) : null,
    endToEnd: judgments.length
      ? { judgments: judgments.length, v2WinRate: decisive.length ? decisive.filter((j) => j.winner === "v2").length / decisive.length : null, ties: judgments.length - decisive.length }
      : null,
    noiseFloor: noiseFloor(traces)
  };
}

function summarizePair(rows) {
  const model = rows.map((r) => r.model).filter((v) => typeof v === "number");
  const baseline = rows.map((r) => r.baseline).filter((v) => typeof v === "number");
  if (rows.length === 0) return null;
  return { model: mean(model), baseline: mean(baseline), rooms: rows.length, rows };
}

// Repeated sessions of the same room and mode: does v2 give the same answer?
function noiseFloor(traces) {
  const groups = new Map();
  for (const t of traces) {
    const key = `${t.roomPhoto?.roomId}|${t.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const rows = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const roomTypes = group.map((t) => t.brief?.roomType?.value);
    const presented = group.map((t) => new Set((t.presentation?.items || []).map((i) => i.visual.variantId)));
    const strategies = group.map((t) => new Set(t.directions.map((d) => d.colourStrategy)));
    rows.push({
      group: key,
      runs: group.length,
      roomTypeAgreement: Math.max(...Object.values(countBy(roomTypes))) / group.length,
      presentedJaccard: meanPairwise(presented),
      strategyJaccard: meanPairwise(strategies)
    });
  }
  return rows.length ? rows : null;
}

function meanPairwise(sets) {
  const values = [];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const inter = [...sets[i]].filter((x) => sets[j].has(x)).length;
      const union = new Set([...sets[i], ...sets[j]]).size;
      values.push(union === 0 ? 1 : inter / union);
    }
  }
  return mean(values);
}

function countBy(values) {
  return values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {});
}

function readTraces(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter((t) => t.traceVersion === 1);
}

function printResult(r) {
  const pct = (v) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
  const num = (v) => (typeof v === "number" ? v.toFixed(2) : "—");
  const lines = [
    "",
    `v2 eval · ${r.traces} traces · modes: ${r.modes.join(", ") || "none"}`,
    r.modes.includes("mock") ? "  (mock traces: fixtures, not model quality — these numbers only prove the plumbing)" : "",
    "",
    `  perception    model ${pct(r.perception?.model)}   baseline ${pct(r.perception?.baseline)}   (${r.perception?.rooms ?? 0} rooms with a hand brief)`,
    `  compliance    ${pct(r.compliance?.rate)} of ${r.compliance?.proposals ?? 0} proposals in allowed categories`,
    `  diversity     model ${pct(r.diversity?.model)}   template planner ${pct(r.diversity?.baseline)}   (mean pairwise axes / 3)`,
    `  faithfulness  mean ΔE ${num(r.faithfulness?.meanDeltaE)}   pass ${pct(r.faithfulness?.passRate)}   (${r.faithfulness?.renders ?? 0} renders)`,
    `  critique      agreement ${pct(r.critique.model?.agreement)} κ ${num(r.critique.model?.kappa)}   always-accept ${pct(r.critique.alwaysAccept?.agreement)}   (${r.critique.model?.n ?? 0} labelled renders)`,
    `  compose       differs from RETRIEVE's top pick ${pct(r.composeDeviationFromRetrieveTop)} of the time`,
    `  end-to-end    ${r.endToEnd ? `v2 wins ${pct(r.endToEnd.v2WinRate)} of ${r.endToEnd.judgments - r.endToEnd.ties} decisive judgments (${r.endToEnd.ties} ties)` : "no judgments yet (/v2/compare.html)"}`,
    `  noise floor   ${r.noiseFloor ? r.noiseFloor.map((n) => `${n.group}: presented Jaccard ${num(n.presentedJaccard)} over ${n.runs} runs`).join("; ") : "no repeated sessions (npm run v2:run -- --all --repeat 3)"}`,
    ""
  ];
  process.stdout.write(lines.filter((l) => l !== null).join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code || 0),
    (error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exit(1);
    }
  );
}
