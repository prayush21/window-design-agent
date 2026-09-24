import { deltaE2000 } from "../baseline/color.js";
import { roomLayers } from "../v2/guidelines.js";
import { axisDifferences } from "../v2/stages/plan.js";
import { hexToLab } from "../v2/scoring.js";

// Per-stage metrics computed over v2 traces. Every metric returns null when it
// cannot be computed (e.g. no proposals yet), and aggregation ignores nulls, the
// same rule as v1's metrics.js.

/** Guideline compliance: share of proposals whose categories are allowed for the room. */
export function guidelineCompliance(trace, catalog) {
  const room = trace.brief?.roomType?.value;
  const layers = room ? roomLayers(room) : null;
  if (!layers || trace.proposals.length === 0) return null;

  let ok = 0;
  for (const proposal of trace.proposals) {
    const visual = catalog.variants.get(proposal.visual.variantId);
    const functional = proposal.functional ? catalog.variants.get(proposal.functional.variantId) : null;
    const visualOk = Boolean(visual && layers.visual.includes(visual.category));
    const functionalOk = !proposal.functional || Boolean(functional && layers.functional?.includes(functional.category));
    if (visualOk && functionalOk) ok += 1;
  }
  return { rate: ok / trace.proposals.length, n: trace.proposals.length };
}

/**
 * Direction diversity: mean pairwise axis difference (0..3 axes, reported /3), the
 * weakest pair, and the mean ΔE between the directions' top visual picks, which
 * says whether different directions produced visibly different products.
 */
export function directionDiversity(trace) {
  const directions = trace.directions;
  if (directions.length < 2) return null;

  const pairs = [];
  const colourGaps = [];
  for (let i = 0; i < directions.length; i += 1) {
    for (let j = i + 1; j < directions.length; j += 1) {
      pairs.push(axisDifferences(directions[i], directions[j]).count);
      const a = topVisual(trace, directions[i].id);
      const b = topVisual(trace, directions[j].id);
      if (a && b) colourGaps.push(deltaE2000(hexToLab(a.hex), hexToLab(b.hex)));
    }
  }
  return {
    meanAxes: mean(pairs) / 3,
    minAxes: Math.min(...pairs),
    topPickDeltaE: colourGaps.length ? mean(colourGaps) : null
  };
}

function topVisual(trace, directionId) {
  const accepted = trace.proposals.filter((p) => p.directionId === directionId && p.status === "accepted").at(-1);
  if (accepted) {
    const candidates = trace.shortlists[directionId]?.layers.visual.candidates || [];
    const hit = candidates.find((c) => c.variantId === accepted.visual.variantId);
    if (hit) return hit;
  }
  return trace.shortlists[directionId]?.layers.visual.candidates[0] || null;
}

/** Render faithfulness: ΔE of the rendered covering vs its swatch. */
export function renderFaithfulness(trace) {
  const results = trace.faithfulness.filter((f) => typeof f.deltaE === "number");
  if (results.length === 0) return null;
  return {
    meanDeltaE: mean(results.map((f) => f.deltaE)),
    passRate: mean(results.map((f) => (f.pass ? 1 : 0))),
    n: results.length
  };
}

/** Perception: Brief fields vs a hand-written brief (see evals/briefs/README.md). */
export function perceptionAgreement(trace, handBrief) {
  if (!handBrief || !trace.brief) return null;
  const fields = {};
  for (const [path, label] of Object.entries(handBrief.fields || {})) {
    const value = getPath(trace.brief, path)?.value;
    if (label.acceptable) {
      fields[path] = label.acceptable.includes(value);
    } else if (label.anyOf) {
      const values = (Array.isArray(value) ? value : [value]).map((v) => String(v).toLowerCase());
      fields[path] = label.anyOf.some((v) => values.includes(v.toLowerCase()));
    } else if (label.hexes) {
      const palette = (value || []).map((c) => hexToLab(c.hex));
      const max = label.maxDeltaE ?? 15;
      const matched = label.hexes.filter((hex) => palette.some((lab) => deltaE2000(lab, hexToLab(hex)) <= max));
      fields[path] = matched.length / label.hexes.length;
    } else if (label.region) {
      fields[path] = value ? iou(value, label.region) >= (label.minIoU ?? 0.5) : false;
    }
  }
  const scores = Object.values(fields).map(Number);
  return { accuracy: scores.length ? mean(scores) : null, fields };
}

/** Critique agreement: model verdict vs human accept/reject labels on renders. */
export function critiqueAgreement(traces, labels) {
  const rows = [];
  for (const trace of traces) {
    for (const critique of trace.critiques) {
      const render = trace.renders.find((r) => r.renderId === critique.renderId);
      const label = render && labels[render.cacheKey];
      if (!label) continue;
      rows.push({ model: critique.verdict === "ACCEPT", human: label.verdict === "accept" });
    }
  }
  if (rows.length === 0) return null;
  const agree = rows.filter((r) => r.model === r.human).length / rows.length;
  // Cohen's kappa: agreement beyond what the two marginal rates predict by chance.
  const pm = mean(rows.map((r) => Number(r.model)));
  const ph = mean(rows.map((r) => Number(r.human)));
  const chance = pm * ph + (1 - pm) * (1 - ph);
  return { agreement: agree, kappa: chance === 1 ? null : (agree - chance) / (1 - chance), n: rows.length };
}

export function budgetRespected(trace, maxRenders) {
  const perRound = new Map();
  for (const stage of trace.stages) {
    if (stage.kind !== "image") continue;
    perRound.set(stage.round, (perRound.get(stage.round) || 0) + (stage.outcome === "cached" ? 0 : 1));
  }
  const worst = Math.max(0, ...perRound.values());
  return { maxRendersInARound: worst, respected: worst <= maxRenders };
}

export function summarizeTrace(trace, { catalog, maxRenders, handBrief = null }) {
  return {
    sessionId: trace.sessionId,
    roomId: trace.roomPhoto?.roomId ?? null,
    mode: trace.mode,
    orchestrator: trace.orchestrator,
    compliance: guidelineCompliance(trace, catalog),
    diversity: directionDiversity(trace),
    faithfulness: renderFaithfulness(trace),
    perception: perceptionAgreement(trace, handBrief),
    budget: budgetRespected(trace, maxRenders),
    warnings: trace.warnings.length,
    fallbacks: trace.stages.filter((s) => s.outcome === "fallback").length,
    presented: trace.presentation?.items.length ?? 0,
    tokens: trace.totals.tokens,
    costUsd: trace.totals.costUsd,
    estimatedCostUsd: trace.totals.estimatedCostUsd ?? null,
    llmCalls: trace.totals.llmCalls,
    renders: trace.totals.renders
  };
}

export function mean(values) {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

function getPath(object, path) {
  return path.split(".").reduce((node, key) => node?.[key], object);
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}
