import fs from "node:fs";
import path from "node:path";

// Human labels for v2 evals, stored as plain JSON under evals/ (committed, like
// evals/cases.json):
//   evals/critique-labels.json  accept/reject per render, keyed by the render's
//                               content-addressed cacheKey, so a label follows the
//                               image across sessions and re-runs
//   evals/pairwise.json         blind v1-vs-v2 preferences per room

export function v2EvalPaths(rootDir, env = process.env) {
  const evalsDir = path.join(rootDir, "evals");
  return {
    critiqueLabels: path.join(evalsDir, "critique-labels.json"),
    pairwise: path.join(evalsDir, "pairwise.json"),
    briefsDir: path.join(evalsDir, "briefs"),
    // v1 eval runs to compare against. Default: this worktree's evals/runs. Point
    // V1_RUNS_DIR at another folder to read existing v1 runs (read-only).
    v1RunsDir: env.V1_RUNS_DIR ? path.resolve(rootDir, env.V1_RUNS_DIR) : path.join(evalsDir, "runs")
  };
}

export function readCritiqueLabels(file) {
  return readJson(file, { version: 1, labels: {} });
}

export function saveCritiqueLabel(file, { cacheKey, verdict, note = "", sessionId = null, renderId = null }) {
  if (!["accept", "reject"].includes(verdict)) throw new Error('verdict must be "accept" or "reject".');
  if (!/^[0-9a-f]{8,64}$/.test(String(cacheKey))) throw new Error("cacheKey must be a render cache key.");
  const store = readCritiqueLabels(file);
  store.labels[cacheKey] = { verdict, note: String(note).slice(0, 500), sessionId, renderId, labeledAt: new Date().toISOString() };
  writeJson(file, store);
  return store.labels[cacheKey];
}

export function readPairwise(file) {
  return readJson(file, { version: 1, judgments: [] });
}

export function savePairwise(file, judgment) {
  const { roomId, winner, leftWas, v1, v2 } = judgment;
  if (!["v1", "v2", "tie"].includes(winner)) throw new Error('winner must be "v1", "v2" or "tie".');
  if (!["v1", "v2"].includes(leftWas)) throw new Error('leftWas must be "v1" or "v2".');
  const store = readPairwise(file);
  const entry = { roomId, winner, leftWas, v1, v2, note: String(judgment.note || "").slice(0, 500), at: new Date().toISOString() };
  store.judgments.push(entry);
  writeJson(file, store);
  return entry;
}

/** Every render in the traces, with what a labeller needs and the model's verdict (revealed after labelling). */
export function listRenders(traces, labels) {
  const rows = [];
  for (const trace of traces) {
    for (const render of trace.renders) {
      const proposal = trace.proposals.find((p) => p.proposalId === render.proposalId);
      const direction = [...trace.directions, ...trace.history.flatMap((h) => h.directions || [])].find((d) => d.id === proposal?.directionId);
      const faith = trace.faithfulness.find((f) => f.renderId === render.renderId);
      const critique = trace.critiques.find((c) => c.renderId === render.renderId);
      rows.push({
        cacheKey: render.cacheKey,
        sessionId: trace.sessionId,
        mode: trace.mode,
        roomId: trace.roomPhoto?.roomId ?? null,
        roomPhoto: trace.roomPhoto?.path,
        renderId: render.renderId,
        imagePath: render.imagePath,
        variantId: render.variantId,
        direction: direction ? { title: direction.title, intent: direction.intent, colourStrategy: direction.colourStrategy } : null,
        faithfulness: faith ? { deltaE: faith.deltaE, pass: faith.pass } : null,
        critique: critique ? { verdict: critique.verdict, reason: critique.reason, source: critique.source } : null,
        label: labels[render.cacheKey] || null
      });
    }
  }
  // One row per image: the same cacheKey across sessions is the same render.
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.cacheKey) ? false : seen.add(r.cacheKey)));
}

/**
 * v1's top pick per room from the latest model (not baseline) eval run whose pick
 * exists in the current catalog. Old-catalog picks are skipped and reported.
 */
export function v1TopPicks(v1RunsDir, catalog) {
  const picks = {};
  const skipped = [];
  if (!fs.existsSync(v1RunsDir)) return { picks, skipped, runsDir: v1RunsDir };
  const runs = fs
    .readdirSync(v1RunsDir)
    .filter((d) => fs.existsSync(path.join(v1RunsDir, d, "report.json")))
    .sort()
    .reverse();
  for (const runId of runs) {
    const report = JSON.parse(fs.readFileSync(path.join(v1RunsDir, runId, "report.json"), "utf8"));
    if (String(report.provider || "").startsWith("baseline:")) continue;
    for (const score of report.scores || []) {
      if (picks[score.caseId] || !score.chosen) continue;
      const variant = catalog.variants.get(score.chosen);
      if (!variant) {
        skipped.push({ runId, caseId: score.caseId, variantId: score.chosen, reason: "not in the current catalog" });
        continue;
      }
      picks[score.caseId] = { runId, provider: report.provider, model: report.model, variantId: variant.variantId, productId: variant.productId };
    }
  }
  return { picks, skipped, runsDir: v1RunsDir };
}

function readJson(file, empty) {
  if (!fs.existsSync(file)) return structuredClone(empty);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
