// v2 UI: start a session, stream its events, render the Brief with provenance,
// the directions and shortlists, proposals with renders and critique, and the
// final presentation with editable assumption chips and reactions.

const $ = (selector) => document.querySelector(selector);
const state = { config: null, roomId: null, imageDataUrl: null, session: null, busy: false };

const ENUMS = {
  lightLevel: ["bright", "medium", "dim"],
  "needs.privacy": ["low", "medium", "high"],
  "needs.blackout": ["low", "medium", "high"],
  "needs.glare": ["low", "medium", "high"],
  "needs.moisture": ["low", "medium", "high"],
  "needs.safety": ["low", "medium", "high"],
  "preferences.warmth": ["warm", "cool", "neutral"],
  "preferences.lightness": ["lighter", "darker"]
};

init();

async function init() {
  const [config, rooms] = await Promise.all([getJson("/api/v2/config"), getJson("/api/v2/rooms")]);
  state.config = config;
  ENUMS.roomType = config.roomTypes.map((r) => r.id);

  const badge = $("#mode-badge");
  badge.textContent = config.mode === "live" ? "LIVE · paid calls" : `${config.mode.toUpperCase()} · no paid calls`;
  badge.className = `badge ${config.mode}`;

  $("#orchestrator").innerHTML = config.orchestrators.map((name) => `<option>${esc(name)}</option>`).join("");
  const fromQuery = new URLSearchParams(location.search).get("orchestrator");
  if (fromQuery && config.orchestrators.includes(fromQuery)) $("#orchestrator").value = fromQuery;

  $("#room-type").insertAdjacentHTML("beforeend", config.roomTypes.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join(""));

  $("#rooms").innerHTML = rooms.rooms
    .map((room) => `<button type="button" class="room" data-room="${esc(room.id)}" title="${esc(room.id)}"><img src="${room.url}" alt="${esc(room.id)}" loading="lazy" /><span>${esc(room.id)}</span></button>`)
    .join("");
  $("#rooms").addEventListener("click", (event) => {
    const button = event.target.closest("[data-room]");
    if (!button) return;
    selectRoom({ roomId: button.dataset.room, url: button.querySelector("img").src });
  });

  $("#upload").addEventListener("change", async () => {
    const file = $("#upload").files?.[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
    selectRoom({ imageDataUrl: dataUrl, url: dataUrl });
    $("#upload-note").hidden = config.mode === "live";
  });

  $("#run").addEventListener("click", start);
  $("#feedback-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("#feedback").value.trim();
    if (text) react({ kind: "feedback", proposalId: null, text });
  });
}

function selectRoom({ roomId = null, imageDataUrl = null, url }) {
  state.roomId = roomId;
  state.imageDataUrl = imageDataUrl;
  document.querySelectorAll(".room").forEach((el) => el.classList.toggle("selected", el.dataset.room === roomId));
  $("#room-preview").src = url;
  $("#room-preview").hidden = false;
  $("#run").disabled = false;
}

async function start() {
  resetResults();
  const body = {
    roomId: state.roomId || undefined,
    imageDataUrl: state.imageDataUrl || undefined,
    text: $("#prefs").value.trim() || null,
    roomType: $("#room-type").value || null
  };
  await stream(`/api/v2/sessions?orchestrator=${encodeURIComponent($("#orchestrator").value)}`, body);
}

async function react(reaction) {
  if (!state.session || state.busy) return;
  $("#react-note").textContent = "";
  await stream(`/api/v2/sessions/${state.session.sessionId}/react?orchestrator=${encodeURIComponent($("#orchestrator").value)}`, { reaction });
}

async function stream(url, body) {
  setBusy(true, "Working…");
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Request failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  } catch (error) {
    showWarnings([{ code: "request-failed", message: error.message, stage: null }]);
  } finally {
    setBusy(false);
  }
}

function onEvent(event) {
  switch (event.type) {
    case "session":
      $("#session-id").textContent = event.sessionId;
      $("#trace-link").href = `/api/v2/traces/${event.sessionId}`;
      $("#trace-section").hidden = false;
      break;
    case "stage-start":
      setStatus(`Running ${event.stage}${event.directionId ? ` · ${event.directionId}` : ""}…`);
      break;
    case "brief":
      renderBrief(event.brief);
      break;
    case "directions":
      renderDirections({ directions: event.directions, shortlists: {}, proposals: [], renders: [], faithfulness: [], critiques: [] });
      break;
    case "warning":
      appendWarning(event.warning);
      break;
    case "error":
      appendWarning({ code: "run-error", message: event.message, stage: null });
      break;
    case "final":
      state.session = event.session;
      renderSession(event.session);
      break;
    default:
      break;
  }
}

function renderSession(session) {
  if (session.brief) renderBrief(session.brief);
  if (session.directions.length > 0) renderDirections(session);
  renderDecisions(session.decisions);
  showWarnings(session.warnings);
  renderPresentation(session);
  const cursor = session.cursor.next;
  setStatus(cursor === "await-reaction" ? "Waiting for your reaction." : cursor === "done" ? "Done — you picked a proposal." : `Stopped at ${cursor}.`);
}

// ------------------------------------------------------------------ Brief

function renderBrief(brief) {
  $("#brief-section").hidden = false;
  const rows = flattenBrief(brief).map(({ path, field }) => `
    <div class="brief-row" data-field="${esc(path)}">
      <span class="field">${esc(label(path))}</span>
      <span class="value">${formatValue(path, field.value)}</span>
      <span class="src ${field.source}" title="${esc(field.note || "")}">${field.source}</span>
      <span class="conf" title="confidence ${field.confidence}"><i style="width:${Math.round(field.confidence * 100)}%"></i></span>
    </div>`);
  $("#brief").innerHTML = rows.join("");
}

function flattenBrief(brief, prefix = "") {
  const out = [];
  for (const [key, node] of Object.entries(brief)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (node && typeof node === "object" && "source" in node) out.push({ path, field: node });
    else if (node && typeof node === "object") out.push(...flattenBrief(node, path));
  }
  return out;
}

function formatValue(path, value) {
  if (path === "palette" && Array.isArray(value)) {
    return value.map((c) => `<span class="swatch-dot" style="background:${esc(c.hex)}" title="${esc(`${c.name} · ${c.role} · ${Math.round(c.weight * 100)}%`)}"></span>`).join("") +
      `<span class="muted small"> ${value.map((c) => esc(c.name)).join(", ")}</span>`;
  }
  if (path === "windowRegion" && value) return `<span class="muted small">x ${value.x} y ${value.y} w ${value.w} h ${value.h}</span>`;
  if (Array.isArray(value)) return value.length ? esc(value.join(", ")) : `<span class="muted">none</span>`;
  if (value === null || value === undefined) return `<span class="muted">none</span>`;
  return esc(String(value));
}

// ------------------------------------------------------------------ Directions

function renderDirections(session) {
  $("#directions-section").hidden = false;
  $("#directions").innerHTML = session.directions
    .map((d) => {
      const shortlist = session.shortlists?.[d.id];
      const proposals = (session.proposals || []).filter((p) => p.directionId === d.id && p.round === (session.round || 1));
      return `
      <article class="direction">
        <header>
          <h3>${esc(d.title)}</h3>
          <p>${esc(d.intent)}</p>
          <div class="tags">
            <span class="tag">${esc(d.colourStrategy)}</span><span class="tag">${esc(d.lightLevel)}</span>
            <span class="tag">visual: ${esc(d.layers.visual.join(" / "))}</span>
            <span class="tag">functional: ${esc(d.layers.functional ? d.layers.functional.join(" / ") : "none")}</span>
          </div>
          <p class="muted small">${esc(d.textureNote)}</p>
        </header>
        ${shortlist ? renderShortlist(shortlist) : ""}
        ${proposals.map((p) => renderProposal(p, session)).join("")}
      </article>`;
    })
    .join("");
}

function renderShortlist(shortlist) {
  return ["visual", "functional"]
    .filter((layer) => shortlist.layers[layer])
    .map((layer) => {
      const l = shortlist.layers[layer];
      return `<div class="shortlist"><h4>${layer} shortlist <span class="muted small">${l.candidates.length} of ${l.considered} considered${l.excludedNoSwatch ? `, ${l.excludedNoSwatch} without swatch excluded` : ""}</span></h4>
        <div class="chips">${l.candidates
          .map((c) => `<figure class="chip" title="${esc(`${c.category} · ${c.productId}/${c.variantId}\ncolour ${c.scoreParts.colour} · style ${c.scoreParts.style} · light ${c.scoreParts.light} · pref ${c.scoreParts.preference}`)}">
            ${c.swatchImageUrl ? `<img src="${c.swatchImageUrl}" alt="" loading="lazy" />` : `<span class="swatch-dot big" style="background:${c.hex}"></span>`}
            <figcaption>${esc(c.name)}<br /><span class="muted">${esc(c.category)} · ${c.score.toFixed(2)}</span></figcaption></figure>`)
          .join("")}</div></div>`;
    })
    .join("");
}

function renderProposal(proposal, session) {
  const renders = (session.renders || []).filter((r) => r.proposalId === proposal.proposalId);
  const critique = (session.critiques || []).find((c) => c.proposalId === proposal.proposalId);
  const faith = (session.faithfulness || []).filter((f) => f.proposalId === proposal.proposalId);
  return `<div class="proposal ${proposal.status || ""}">
    <h4>Attempt ${proposal.attempt} · <span class="status">${esc(proposal.status || "proposed")}</span>${proposal.source !== "model" ? ` <span class="warn-inline">${esc(proposal.source)}</span>` : ""}</h4>
    <p class="small">visual <code>${esc(proposal.visual.variantId)}</code>${proposal.functional ? ` · functional <code>${esc(proposal.functional.variantId)}</code>` : ""}</p>
    <div class="renders">${renders.map((r) => `<figure><img src="/v2-renders/${encodeURIComponent(r.imagePath)}" alt="render" loading="lazy" /><figcaption>render ${r.attempt}${faithLabel(faith.find((f) => f.renderId === r.renderId))}</figcaption></figure>`).join("")}</div>
    ${critique ? `<p class="small"><span class="verdict ${critique.verdict}">${critique.verdict}</span> ${esc(critique.reason)}</p>` : ""}
  </div>`;
}

function faithLabel(f) {
  if (!f) return "";
  return ` · ΔE ${f.deltaE === null ? "n/a" : f.deltaE.toFixed(1)} <span class="${f.pass ? "ok" : "bad"}">${f.pass ? "faithful" : "off-colour"}</span>`;
}

// ------------------------------------------------------------------ Presentation

function renderPresentation(session) {
  const p = session.presentation;
  $("#presentation-section").hidden = !p;
  if (!p) return;

  $("#presentation").innerHTML = p.items.length === 0
    ? `<p class="muted">No proposal survived critique this round. See the warnings and decisions below.</p>`
    : p.items
        .map((item) => `
      <article class="card ${item.status}">
        ${item.renderUrl ? `<img class="render" src="${item.renderUrl}" alt="Render of ${esc(item.title)}" />` : `<div class="render none">no render</div>`}
        <div class="card-body">
          <h3>${esc(item.title)} ${item.status !== "accepted" ? `<span class="warn-inline">${esc(item.status)}</span>` : ""}</h3>
          <p class="muted small">${esc(item.intent || "")}</p>
          ${productLine("Visual", item.visual)}
          ${item.functional ? productLine("Functional (described, not rendered)", item.functional) : ""}
          <ul class="rationale">${item.rationale
            .map((r) => `<li data-fields="${esc(r.briefFields.join(" "))}">${esc(r.claim)} ${r.briefFields.map((f) => `<span class="field-ref">${esc(label(f))}</span>`).join("")}</li>`)
            .join("")}</ul>
          ${item.critique ? `<p class="small"><span class="verdict ${item.critique.verdict}">${item.critique.verdict}</span> ${esc(item.critique.reason)}</p>` : ""}
          ${session.cursor.next === "await-reaction" ? `<div class="card-actions">
            <button type="button" data-pick="${esc(item.proposalId)}">I like this one</button>
            <input type="text" placeholder="Refine this one…" data-refine-input="${esc(item.proposalId)}" />
            <button type="button" class="secondary" data-refine="${esc(item.proposalId)}">Refine</button>
          </div>` : ""}
        </div>
      </article>`)
        .join("");

  $("#presentation").onclick = (event) => {
    const pick = event.target.closest("[data-pick]");
    if (pick) return react({ kind: "pick", proposalId: pick.dataset.pick });
    const refine = event.target.closest("[data-refine]");
    if (refine) {
      const text = document.querySelector(`[data-refine-input="${CSS.escape(refine.dataset.refine)}"]`).value.trim();
      if (text) react({ kind: "feedback", proposalId: refine.dataset.refine, text });
    }
  };
  $("#presentation").onmouseover = (event) => {
    const li = event.target.closest("[data-fields]");
    document.querySelectorAll(".brief-row").forEach((row) => row.classList.toggle("hl", Boolean(li && li.dataset.fields.split(" ").includes(row.dataset.field))));
  };

  $("#assumptions").innerHTML = p.assumptions.length
    ? `<h3>What I assumed <span class="muted small">— click to correct</span></h3><div class="assumption-chips">${p.assumptions
        .map((a) => `<button type="button" class="assumption ${a.source}" data-field="${esc(a.field)}" title="${esc(`${a.source}, confidence ${a.confidence}`)}">${esc(a.label || label(a.field))}: <strong>${esc(chipValue(a.value))}</strong></button>`)
        .join("")}</div><div id="assumption-editor"></div>`
    : "";
  $("#assumptions").onclick = (event) => {
    const chip = event.target.closest(".assumption");
    if (chip) openEditor(chip.dataset.field, p.assumptions.find((a) => a.field === chip.dataset.field));
  };

  $("#feedback-form").hidden = session.cursor.next !== "await-reaction";
  if (session.reactions.length > 0) {
    const last = session.decisions.filter((d) => d.policy === "reaction-reentry").at(-1);
    if (last) $("#react-note").textContent = `Last reaction → ${last.decision}: ${last.reason}`;
  }
}

function productLine(title, product) {
  if (!product) return "";
  return `<div class="product"><span class="swatch-dot big" style="background:${esc(product.hex || "#ccc")}"></span>
    <div><strong>${esc(title)}</strong><br />${esc(product.name)} · ${esc(product.category)}<br /><span class="muted small">${esc(product.productId)} / ${esc(product.variantId)}</span></div></div>`;
}

function openEditor(field, assumption) {
  const editor = $("#assumption-editor");
  const options = ENUMS[field];
  const current = chipValue(assumption.value);
  editor.innerHTML = `<form class="editor"><label>${esc(label(field))}
      ${options ? `<select name="value">${options.map((o) => `<option ${o === assumption.value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>` : `<input name="value" value="${esc(current)}" />`}
    </label><button type="submit">Update and redesign</button></form>`;
  editor.querySelector("form").onsubmit = (event) => {
    event.preventDefault();
    let value = new FormData(event.target).get("value");
    if (Array.isArray(assumption.value)) value = String(value).split(",").map((v) => v.trim()).filter(Boolean);
    react({ kind: "edit-assumption", proposalId: null, edits: [{ field, value }] });
  };
}

function chipValue(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? v.name : v)).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value === null ? "none" : String(value);
}

// ------------------------------------------------------------------ Decisions and warnings

function renderDecisions(decisions) {
  $("#decisions-section").hidden = decisions.length === 0;
  $("#decisions").innerHTML = decisions
    .map((d) => `<li><code>${esc(d.policy)}</code> → <strong>${esc(d.decision)}</strong>${d.directionId ? ` <span class="muted">(${esc(d.directionId)})</span>` : ""}: ${esc(d.reason)}</li>`)
    .join("");
}

function showWarnings(warnings) {
  const box = $("#warnings");
  box.hidden = warnings.length === 0;
  box.innerHTML = warnings.length ? `<h3>${warnings.length} warning${warnings.length === 1 ? "" : "s"}</h3><ul>${warnings.map(warningItem).join("")}</ul>` : "";
}

function appendWarning(warning) {
  const box = $("#warnings");
  if (box.hidden) {
    box.hidden = false;
    box.innerHTML = "<h3>Warnings</h3><ul></ul>";
  }
  box.querySelector("ul").insertAdjacentHTML("beforeend", warningItem(warning));
}

function warningItem(w) {
  return `<li><code>${esc(w.stage || "run")}</code> <strong>${esc(w.code)}</strong> ${esc(w.message)}</li>`;
}

// ------------------------------------------------------------------ helpers

function resetResults() {
  for (const id of ["#presentation-section", "#brief-section", "#directions-section", "#decisions-section", "#warnings"]) $(id).hidden = true;
  state.session = null;
}

function setBusy(busy, message) {
  state.busy = busy;
  $("#run").disabled = busy || (!state.roomId && !state.imageDataUrl);
  document.body.classList.toggle("busy", busy);
  if (message) setStatus(message);
}

function setStatus(message) {
  $("#status").textContent = message;
}

function label(path) {
  return path.replace("preferences.", "pref: ").replace("needs.", "need: ").replace(/([A-Z])/g, " $1").toLowerCase();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
