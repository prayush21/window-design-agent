import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ROOT_DIR, catalogDir, resolveConfig, resolvePath } from "../config.js";
import { loadCatalogIndex } from "../catalog-index.js";
import { summarizeTrace } from "../../eval/v2-metrics.js";

// npm run v2:report — one static HTML page over the traces in traces/ (or --dir).
// It is the review surface for a run: what the agent understood, what it proposed,
// what it rendered and why it kept or dropped each option, with cost and warnings.
// Built from mock traces first, so the layout is settled before any live run.

const USAGE = `Usage: npm run v2:report -- [--dir traces] [--out traces/report/index.html] [--all]
  --all   include every trace (default: the latest trace per room and mode)`;

export async function main(argv = process.argv.slice(2)) {
  const args = { dir: null, out: null, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") args.dir = argv[(i += 1)];
    else if (argv[i] === "--out") args.out = argv[(i += 1)];
    else if (argv[i] === "--all") args.all = true;
    else if (argv[i] === "--help") return process.stdout.write(`${USAGE}\n`), 0;
  }

  const config = resolveConfig({ mode: "mock" });
  const dir = args.dir ? path.resolve(ROOT_DIR, args.dir) : resolvePath(config, "traces");
  const out = args.out ? path.resolve(ROOT_DIR, args.out) : path.join(dir, "report", "index.html");
  const { html, count } = await buildReport({ dir, config, all: args.all });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  process.stdout.write(`report  ${path.relative(ROOT_DIR, out)}  (${count} sessions)\n`);
  return 0;
}

export async function buildReport({ dir, config, all = false }) {
  const traces = readTraces(dir, all);
  const catalog = await loadCatalogIndex({ catalogDir: catalogDir(), cacheDir: resolvePath(config, "cache") });
  const briefsDir = path.join(ROOT_DIR, "evals", "briefs");
  const rendersDir = resolvePath(config, "renders");

  const summaries = traces.map((trace) => {
    const briefFile = path.join(briefsDir, `${trace.roomPhoto?.roomId}.json`);
    const handBrief = fs.existsSync(briefFile) ? JSON.parse(fs.readFileSync(briefFile, "utf8")) : null;
    return summarizeTrace(trace, { catalog, maxRenders: trace.config?.budget?.maxRenders ?? config.budget.maxRenders, handBrief });
  });

  const sections = [];
  for (const [index, trace] of traces.entries()) {
    sections.push(await sessionSection(trace, summaries[index], { catalog, rendersDir }));
  }

  const modes = [...new Set(traces.map((t) => t.mode))];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>v2 review report</title><style>${CSS}</style></head><body>
<header><p class="eyebrow">Window design agent · v2 review report</p>
<h1>${traces.length} session${traces.length === 1 ? "" : "s"}</h1>
<p class="muted">Built ${new Date().toISOString()} from <code>${esc(path.relative(ROOT_DIR, dir) || dir)}</code>.</p>
${modes.includes("mock") ? `<p class="banner">Mock data: model outputs are hand-written fixtures and renders are flat swatch patches. Layout only; no quality claims.</p>` : ""}
</header>
<main>
<section><h2>Summary</h2>${summaryTable(summaries, traces)}</section>
${sections.join("\n")}
</main></body></html>`;
  return { html, count: traces.length };
}

function readTraces(dir, all) {
  if (!fs.existsSync(dir)) return [];
  const traces = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter((t) => t.traceVersion === 1)
    .sort((a, b) => (a.roomPhoto?.roomId || "").localeCompare(b.roomPhoto?.roomId || "") || b.updatedAt.localeCompare(a.updatedAt));
  if (all) return traces;
  const seen = new Set();
  return traces.filter((t) => {
    const key = `${t.roomPhoto?.roomId || t.sessionId}|${t.mode}|${t.orchestrator}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summaryTable(summaries, traces) {
  const pct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
  const num = (v, d = 1) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
  const rows = summaries.map((s, i) => {
    const t = traces[i];
    return `<tr><td><a href="#${esc(s.sessionId)}">${esc(s.roomId || s.sessionId)}</a></td><td>${esc(s.mode)}</td>
      <td>${esc(t.brief?.roomType?.value || "—")} <span class="src ${esc(t.brief?.roomType?.source || "")}">${esc(t.brief?.roomType?.source || "")}</span></td>
      <td>${pct(s.diversity?.meanAxes)} <span class="muted">min ${s.diversity?.minAxes ?? "—"}</span></td>
      <td>${num(s.diversity?.topPickDeltaE)}</td>
      <td>${s.compliance ? pct(s.compliance.rate) : "—"}</td>
      <td>${s.faithfulness ? `${num(s.faithfulness.meanDeltaE)} · ${pct(s.faithfulness.passRate)}` : "—"}</td>
      <td>${s.perception ? pct(s.perception.accuracy) : "—"}</td>
      <td>${s.presented}</td>
      <td>${s.budget.maxRendersInARound}${s.budget.respected ? "" : ' <span class="bad">over</span>'}</td>
      <td class="${s.warnings ? "warn" : ""}">${s.warnings}</td><td>${s.fallbacks}</td>
      <td>${s.llmCalls}</td><td>${s.estimatedCostUsd ? `$${s.estimatedCostUsd.toFixed(4)}` : "—"}</td></tr>`;
  });
  return `<div class="scroll"><table><thead><tr><th>Room</th><th>Mode</th><th>Room type</th><th title="mean pairwise axis difference across the 3 directions">Direction diversity</th>
    <th title="mean ΔE2000 between directions' top visual picks">Top-pick ΔE</th><th title="proposals whose categories are allowed">Compliance</th>
    <th title="mean ΔE render vs swatch · pass rate">Faithfulness</th><th title="vs evals/briefs">Perception</th><th>Presented</th><th title="renders in the busiest round">Renders</th>
    <th>Warnings</th><th>Fallbacks</th><th>Model calls</th><th title="what the configured models would cost; mock calls cost nothing">Est. cost</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table></div>`;
}

async function sessionSection(trace, summary, { catalog, rendersDir }) {
  const room = await thumb(path.resolve(ROOT_DIR, trace.roomPhoto.path), 360);
  const brief = trace.brief;
  return `<section id="${esc(trace.sessionId)}">
  <h2>${esc(trace.roomPhoto.roomId || trace.sessionId)} <span class="muted small">${esc(trace.sessionId)} · ${esc(trace.orchestrator)} · ${esc(trace.mode)} · round ${trace.history.length + 1}</span></h2>
  <div class="two">
    <div>${room ? `<img class="room" src="${room}" alt="room photo" />` : ""}</div>
    <div>${brief ? briefTable(brief) : "<p class='muted'>No brief.</p>"}</div>
  </div>
  ${trace.warnings.length ? `<div class="warnings"><strong>${trace.warnings.length} warning(s)</strong><ul>${trace.warnings.map((w) => `<li><code>${esc(w.stage || "run")}</code> <b>${esc(w.code)}</b> ${esc(w.message)}</li>`).join("")}</ul></div>` : ""}
  ${trace.presentation ? await presentationBlock(trace, catalog, rendersDir) : ""}
  <h3>Directions</h3>
  <div class="directions">${(await Promise.all(trace.directions.map((d) => directionBlock(d, trace, catalog, rendersDir)))).join("")}</div>
  ${trace.decisions.length ? `<h3>Policy decisions</h3><ol class="small">${trace.decisions.map((d) => `<li><code>${esc(d.policy)}</code> → <b>${esc(d.decision)}</b>${d.directionId ? ` (${esc(d.directionId)})` : ""}: ${esc(d.reason)}</li>`).join("")}</ol>` : ""}
  ${trace.reactions.length ? `<h3>Reactions</h3><ol class="small">${trace.reactions.map((r) => `<li>${esc(r.kind)}${r.proposalId ? ` on ${esc(r.proposalId)}` : ""}${r.text ? `: “${esc(r.text)}”` : ""}${r.edits ? ` ${esc(JSON.stringify(r.edits))}` : ""}</li>`).join("")}</ol>` : ""}
  <details><summary>Stage log (${trace.stages.length} calls · ${trace.totals.tokens} tokens${trace.mode === "mock" ? " estimated" : ""})</summary>${stageTable(trace)}</details>
  ${summary.perception ? `<p class="small">Perception vs hand brief: ${Math.round(summary.perception.accuracy * 100)}% (${Object.entries(summary.perception.fields).map(([k, v]) => `${esc(k)} ${typeof v === "number" ? Math.round(v * 100) + "%" : v ? "✓" : "✗"}`).join(" · ")})</p>` : ""}
</section>`;
}

function briefTable(brief) {
  const rows = [];
  const walk = (node, prefix) => {
    for (const [key, field] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (field && "source" in field) {
        rows.push(`<tr><td class="muted">${esc(p)}</td><td>${formatValue(field.value)}</td><td><span class="src ${field.source}">${field.source}</span></td><td class="muted">${field.confidence}</td><td class="muted small">${esc(field.note || "")}</td></tr>`);
      } else walk(field, p);
    }
  };
  walk(brief, "");
  return `<table class="brief">${rows.join("")}</table>`;
}

function formatValue(value) {
  if (Array.isArray(value) && value[0]?.hex) return value.map((c) => `<span class="dot" style="background:${esc(c.hex)}" title="${esc(c.name)}"></span>`).join("") + ` <span class="muted small">${value.map((c) => esc(c.name)).join(", ")}</span>`;
  if (Array.isArray(value)) return esc(value.join(", ") || "—");
  if (value && typeof value === "object") return `<span class="small">${esc(JSON.stringify(value))}</span>`;
  return esc(value ?? "—");
}

async function directionBlock(d, trace, catalog, rendersDir) {
  const shortlist = trace.shortlists[d.id];
  const proposals = trace.proposals.filter((p) => p.directionId === d.id);
  const layer = (name) => {
    const l = shortlist?.layers[name];
    if (!l) return "";
    return `<p class="small"><b>${name}</b> (${l.candidates.length}/${l.considered})</p><div class="cands">${l.candidates
      .map((c) => `<span class="cand" title="${esc(`${c.productId}/${c.variantId} · colour ${c.scoreParts.colour} style ${c.scoreParts.style} light ${c.scoreParts.light} pref ${c.scoreParts.preference}`)}"><span class="dot" style="background:${c.hex}"></span>${esc(c.name)} <span class="muted">${esc(c.category)} ${c.score.toFixed(2)}</span></span>`)
      .join("")}</div>`;
  };
  const proposalRows = await Promise.all(proposals.map((p) => proposalBlock(p, trace, catalog, rendersDir)));
  return `<div class="direction"><h4>${esc(d.id)} · ${esc(d.title)}</h4><p class="small">${esc(d.intent)}</p>
    <p class="small"><span class="tag">${esc(d.colourStrategy)}</span> <span class="tag">${esc(d.lightLevel)}</span> visual: ${esc(d.layers.visual.join(" / "))} · functional: ${esc(d.layers.functional?.join(" / ") || "none")}</p>
    ${layer("visual")}${layer("functional")}${proposalRows.join("")}</div>`;
}

async function proposalBlock(p, trace, catalog, rendersDir) {
  const v = catalog.variants.get(p.visual.variantId);
  const f = p.functional ? catalog.variants.get(p.functional.variantId) : null;
  const renders = trace.renders.filter((r) => r.proposalId === p.proposalId);
  const imgs = await Promise.all(
    renders.map(async (r) => {
      const faith = trace.faithfulness.find((x) => x.renderId === r.renderId);
      const src = await thumb(path.join(rendersDir, r.imagePath), 280);
      return `<figure>${src ? `<img src="${src}" alt="render" />` : "<div class='missing'>render file missing</div>"}<figcaption>render ${r.attempt}${faith ? ` · ΔE ${faith.deltaE?.toFixed(1) ?? "n/a"} <span class="${faith.pass ? "ok" : "bad"}">${faith.pass ? "pass" : "off-colour"}</span>` : ""}</figcaption></figure>`;
    })
  );
  const critique = trace.critiques.find((c) => c.proposalId === p.proposalId);
  return `<div class="proposal"><p class="small"><b>${esc(p.proposalId)}</b> attempt ${p.attempt} · <b>${esc(p.status || "proposed")}</b>${p.source !== "model" ? ` <span class="warn">${esc(p.source)}</span>` : ""}
    · visual <span class="dot" style="background:${v?.hex || "#ccc"}"></span>${esc(v?.name || p.visual.variantId)} (${esc(v?.category || "?")})${f ? ` · functional ${esc(f.name)} (${esc(f.category)})` : ""}</p>
    <ul class="small">${p.rationale.map((r) => `<li>${esc(r.claim)} <span class="muted">[${esc(r.briefFields.join(", "))}]</span></li>`).join("")}</ul>
    ${imgs.length ? `<div class="renders">${imgs.join("")}</div>` : ""}
    ${critique ? `<p class="small">Critique <b class="${critique.verdict}">${critique.verdict}</b> (${critique.source}) harmony ${critique.scores.harmony} · intent ${critique.scores.intent} · room ${critique.scores.roomFit} · installed ${critique.scores.installed}: ${esc(critique.reason)}</p>` : ""}</div>`;
}

async function presentationBlock(trace, catalog, rendersDir) {
  const items = await Promise.all(
    trace.presentation.items.map(async (item) => {
      const render = trace.renders.find((r) => item.renderUrl && item.renderUrl.endsWith(encodeURIComponent(r.imagePath)));
      const src = render ? await thumb(path.join(rendersDir, render.imagePath), 360) : null;
      return `<div class="card">${src ? `<img src="${src}" alt="" />` : ""}<p><b>${esc(item.title)}</b> <span class="${item.status === "accepted" ? "ok" : "warn"}">${esc(item.status)}</span></p>
        <p class="small">${esc(item.visual.name)} · ${esc(item.visual.category)}${item.functional ? ` + ${esc(item.functional.name)} · ${esc(item.functional.category)}` : ""}</p></div>`;
    })
  );
  const chips = trace.presentation.assumptions.map((a) => `<span class="chip ${a.source}">${esc(a.label || a.field)}: ${esc(typeof a.value === "object" ? JSON.stringify(a.value) : a.value)}</span>`);
  return `<h3>Presented</h3><div class="cards">${items.join("") || "<p class='muted'>Nothing presented.</p>"}</div>${chips.length ? `<p class="small">What I assumed: ${chips.join(" ")}</p>` : ""}`;
}

function stageTable(trace) {
  const rows = trace.stages.map((s) => {
    const a = s.attempts.at(-1) || {};
    return `<tr><td>${s.seq}</td><td>${esc(s.stage)}</td><td>${s.round}</td><td class="${s.outcome === "ok" ? "" : "warn"}">${esc(s.outcome || "")}</td><td>${s.attempts.length}</td>
      <td>${esc(a.provider || "")}${a.wouldBe ? ` → ${esc(a.wouldBe.provider)}/${esc(a.wouldBe.model)}` : a.model ? `/${esc(a.model)}` : ""}</td>
      <td>${s.latencyMs}</td><td>${s.attempts.reduce((n, x) => n + (x.usage?.totalTokens || 0), 0) || ""}</td>
      <td>${s.attempts.reduce((n, x) => n + (x.estimatedCostUsd || 0), 0).toFixed(5)}</td><td class="small">${esc((s.warnings || []).map((w) => w.code).join(", "))}</td></tr>`;
  });
  return `<div class="scroll"><table class="small"><thead><tr><th>#</th><th>Stage</th><th>Round</th><th>Outcome</th><th>Attempts</th><th>Provider → would be</th><th>ms</th><th>Tokens</th><th>Est. $</th><th>Warnings</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const thumbCache = new Map();
async function thumb(file, size) {
  if (!fs.existsSync(file)) return null;
  const key = `${file}:${size}`;
  if (!thumbCache.has(key)) {
    const bytes = await sharp(file).rotate().resize({ width: size, height: size, fit: "inside" }).jpeg({ quality: 72 }).toBuffer();
    thumbCache.set(key, `data:image/jpeg;base64,${bytes.toString("base64")}`);
  }
  return thumbCache.get(key);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const CSS = `
:root{--ink:#1f1d1a;--muted:#6d675f;--line:#e2ddd5;--ok:#2f7d4f;--bad:#a63d2f;--warn:#9a6a1d;font-family:ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:#f6f4f0}
body{margin:0;padding:1.2rem 1.6rem;max-width:1400px}
h1{margin:.2rem 0}h2{margin:0 0 .6rem;font-size:1.1rem}h3{font-size:.95rem;margin:1rem 0 .4rem}h4{margin:0 0 .3rem;font-size:.9rem}
section{background:#fff;border:1px solid var(--line);border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--muted);margin:0}
.muted{color:var(--muted)}.small{font-size:.8rem}.ok{color:var(--ok);font-weight:600}.bad,.DROP{color:var(--bad);font-weight:600}.warn,.REVISE{color:var(--warn);font-weight:600}.ACCEPT{color:var(--ok)}
.banner{background:#fbf1e6;border:1px solid #ecd2b0;padding:.5rem .8rem;border-radius:8px;display:inline-block}
table{border-collapse:collapse;width:100%;font-size:.82rem}th,td{text-align:left;padding:.3rem .45rem;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;white-space:nowrap}
.scroll{overflow-x:auto}.two{display:grid;grid-template-columns:minmax(0,360px) minmax(0,1fr);gap:1rem}@media(max-width:800px){.two{grid-template-columns:minmax(0,1fr)}}
img.room{width:100%;border-radius:8px}
.src{font-size:.66rem;font-weight:700;text-transform:uppercase;padding:.05rem .4rem;border-radius:999px;color:#fff}.src.stated{background:#2f5d50}.src.inferred{background:#3c5a8a}.src.assumed{background:#9a6a1d}
.dot{display:inline-block;width:.9rem;height:.9rem;border-radius:50%;border:1px solid rgba(0,0,0,.15);vertical-align:middle;margin-right:.2rem}
.directions{display:grid;gap:.8rem}.direction{border:1px solid var(--line);border-radius:8px;padding:.7rem}
.tag{background:#efece6;border-radius:999px;padding:0 .45rem;font-size:.72rem}
.cands{display:flex;flex-wrap:wrap;gap:.3rem .8rem;font-size:.75rem}.cand{white-space:nowrap}
.proposal{border-top:1px dashed var(--line);margin-top:.5rem;padding-top:.4rem}
.renders,.cards{display:flex;gap:.6rem;flex-wrap:wrap}.renders figure{margin:0;font-size:.72rem}.renders img{width:220px;border-radius:6px;display:block}
.card{width:260px;border:1px solid var(--line);border-radius:8px;padding:.5rem}.card img{width:100%;border-radius:6px}
.chip{border:1px dashed var(--warn);border-radius:999px;padding:0 .45rem;margin:.1rem;display:inline-block}.chip.inferred{border-color:#3c5a8a}
.warnings{background:#fbf1e6;border:1px solid #ecd2b0;border-radius:8px;padding:.5rem .8rem;font-size:.8rem;margin:.8rem 0}.warnings ul{margin:.3rem 0 0;padding-left:1rem}
code{background:#efece6;padding:0 .25em;border-radius:3px;font-size:.85em}details{margin-top:.8rem}summary{cursor:pointer;font-size:.85rem}
.missing{width:220px;height:140px;display:grid;place-items:center;background:#eee;color:var(--muted);border-radius:6px}`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code || 0),
    (error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exit(1);
    }
  );
}
