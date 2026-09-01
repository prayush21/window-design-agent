// Scoring for one recommendation run.
//
// Two families of metrics:
//   - labeled   : need evals/cases.json labels, skipped per-case when absent
//   - unlabeled : derived from the response alone, so they work before any labeling
//
// Every metric is null when it cannot be computed, and aggregation ignores nulls.
// That keeps a half-labeled case set honest instead of silently scoring 0.

const TOP_N = 3;

export function scoreRun({ testCase, catalog, raw, normalized, latencyMs, usage, requestStats }) {
  const labels = normalizeLabels(testCase.labels);
  const ranked = (normalized.rankings || []).map((ranking) => ranking.variantId);
  const topN = ranked.slice(0, TOP_N);
  const chosen = normalized.recommendation?.variantId ?? null;
  const variantsById = indexVariants(catalog);
  const hasLabels = labels.acceptable.length > 0 || labels.unacceptable.length > 0;

  const rawRankingCount = Array.isArray(raw?.rankings) ? raw.rankings.length : 0;
  const grounded = rawRankingCount > 0 ? ranked.length / rawRankingCount : null;

  // Prefer the server's own signal; fall back to inference so runs cached before
  // warnings existed still score.
  const silentFallback = Array.isArray(normalized.warnings)
    ? normalized.debug?.defaulted === true
    : ranked.length === 0 || !variantsById.has(String(raw?.recommendation?.variantId ?? ""));

  const acceptableCategories = new Set(
    labels.acceptable.map((variantId) => variantsById.get(variantId)?.category).filter(Boolean)
  );

  return {
    caseId: testCase.id,
    chosen,
    chosenName: normalized.recommendation?.displayName ?? null,
    ranked,
    hasLabels,

    labeled: {
      acceptableAt1: hasLabels && labels.acceptable.length > 0 ? labels.acceptable.includes(chosen) : null,
      acceptableAt3:
        hasLabels && labels.acceptable.length > 0 ? topN.some((id) => labels.acceptable.includes(id)) : null,
      idealAt1: labels.ideal.length > 0 ? labels.ideal.includes(chosen) : null,
      idealAt3: labels.ideal.length > 0 ? topN.some((id) => labels.ideal.includes(id)) : null,
      // Lower is better: an explicitly-wrong variant reaching the top 3.
      violationAt3:
        labels.unacceptable.length > 0 ? topN.some((id) => labels.unacceptable.includes(id)) : null,
      categoryAt1:
        acceptableCategories.size > 0
          ? acceptableCategories.has(normalized.recommendation?.category ?? null)
          : null
    },

    unlabeled: {
      schemaValid: Boolean(raw && typeof raw === "object" && Array.isArray(raw.rankings)),
      groundedRate: grounded,
      droppedRankings: rawRankingCount - ranked.length,
      silentFallback,
      // The model returning a `recommendation` that disagrees with its own rankings[0]
      // is a self-consistency defect worth seeing separately.
      recommendationMatchesRank1: ranked.length > 0 ? chosen === ranked[0] : null,
      rankingCount: ranked.length,
      avoidForViolation: scoreAvoidFor({ chosen, variantsById, analysis: normalized.analysis }),
      // Adversarial cases: we expect no confident answer. Passes when the system
      // either declines or reports low confidence.
      gracefulFailure: testCase.expectFailure
        ? (normalized.recommendation?.confidence ?? 0) < 0.5
        : null,
      confidence: normalized.recommendation?.confidence ?? null
    },

    cost: {
      latencyMs: latencyMs ?? null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      imageCount: requestStats?.imageCount ?? null,
      uniqueImageCount: requestStats?.uniqueImageCount ?? null,
      duplicateImageCount: requestStats?.duplicateImageCount ?? null,
      approxImageBytes: requestStats?.approxImageBytes ?? null
    }
  };
}

// Advisory heuristic, not pass/fail: does the winning variant's own `avoidFor`
// overlap the palette/style the model itself just reported for the room?
function scoreAvoidFor({ chosen, variantsById, analysis }) {
  const variant = chosen ? variantsById.get(chosen) : null;
  if (!variant || !Array.isArray(variant.avoidFor) || variant.avoidFor.length === 0) return null;

  const roomTerms = new Set(
    [...(analysis?.room?.style || []), ...(analysis?.room?.palette || []), analysis?.room?.lighting || ""]
      .flatMap((value) => tokenize(value))
  );
  if (roomTerms.size === 0) return null;

  return variant.avoidFor.some((phrase) => {
    const phraseTerms = tokenize(phrase).filter((term) => !STOP_WORDS.has(term));
    if (phraseTerms.length === 0) return false;
    const overlap = phraseTerms.filter((term) => roomTerms.has(term)).length;
    return overlap / phraseTerms.length >= 0.5;
  });
}

const STOP_WORDS = new Set(["rooms", "room", "with", "and", "needing", "very", "for", "the"]);

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function normalizeLabels(labels) {
  return {
    acceptable: toArray(labels?.acceptable),
    unacceptable: toArray(labels?.unacceptable),
    // An ideal pick is acceptable by definition, so it never has to be tagged twice.
    ideal: toArray(labels?.ideal)
  };
}

function toArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function indexVariants(catalog) {
  const index = new Map();
  for (const product of catalog.products) {
    for (const variant of product.variants) {
      index.set(variant.variantId, { ...variant, category: product.category });
    }
  }
  return index;
}

// `ideal` implies `acceptable`; fold it in so labelers only tag the best pick once.
export function withImpliedLabels(testCase) {
  const labels = normalizeLabels(testCase.labels);
  return {
    ...testCase,
    labels: {
      ...labels,
      acceptable: [...new Set([...labels.acceptable, ...labels.ideal])]
    }
  };
}

export function aggregate(scores) {
  const rateKeys = [
    ["labeled", "acceptableAt1"],
    ["labeled", "acceptableAt3"],
    ["labeled", "idealAt1"],
    ["labeled", "idealAt3"],
    ["labeled", "violationAt3"],
    ["labeled", "categoryAt1"],
    ["unlabeled", "schemaValid"],
    ["unlabeled", "silentFallback"],
    ["unlabeled", "recommendationMatchesRank1"],
    ["unlabeled", "avoidForViolation"],
    ["unlabeled", "gracefulFailure"]
  ];

  const summary = {};
  for (const [group, key] of rateKeys) {
    const values = scores.map((score) => score[group][key]).filter((value) => value !== null);
    summary[key] = values.length === 0 ? null : { rate: mean(values.map(Number)), n: values.length };
  }

  summary.groundedRate = averageOf(scores, (score) => score.unlabeled.groundedRate);
  summary.latencyMs = averageOf(scores, (score) => score.cost.latencyMs);
  summary.inputTokens = averageOf(scores, (score) => score.cost.inputTokens);
  summary.totalTokens = averageOf(scores, (score) => score.cost.totalTokens);
  summary.imageCount = averageOf(scores, (score) => score.cost.imageCount);
  summary.duplicateImageCount = averageOf(scores, (score) => score.cost.duplicateImageCount);
  summary.approxImageBytes = averageOf(scores, (score) => score.cost.approxImageBytes);
  summary.caseCount = new Set(scores.map((score) => score.caseId)).size;
  summary.runCount = scores.length;

  return summary;
}

// Run-to-run stability on identical input. If rank 1 is unstable, a small move in
// any labeled metric is noise rather than signal.
export function computeVariance(scoresByCase) {
  const perCase = [];

  for (const [caseId, scores] of scoresByCase) {
    if (scores.length < 2) continue;

    const counts = new Map();
    for (const score of scores) counts.set(score.chosen, (counts.get(score.chosen) || 0) + 1);
    const rank1Stability = Math.max(...counts.values()) / scores.length;

    const topSets = scores.map((score) => new Set(score.ranked.slice(0, 5)));
    const overlaps = [];
    for (let i = 0; i < topSets.length; i += 1) {
      for (let j = i + 1; j < topSets.length; j += 1) {
        overlaps.push(jaccard(topSets[i], topSets[j]));
      }
    }

    perCase.push({
      caseId,
      runs: scores.length,
      rank1Stability,
      distinctRank1: counts.size,
      top5Jaccard: overlaps.length > 0 ? mean(overlaps) : null
    });
  }

  if (perCase.length === 0) return null;

  return {
    perCase,
    rank1Stability: mean(perCase.map((entry) => entry.rank1Stability)),
    top5Jaccard: averageOf(perCase, (entry) => entry.top5Jaccard)
  };
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / (a.size + b.size - intersection);
}

function averageOf(items, pick) {
  const values = items.map(pick).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length === 0 ? null : mean(values);
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
