const STATES = ["none", "acceptable", "unacceptable"];

const elements = {
  progress: document.querySelector("#progress"),
  saveState: document.querySelector("#save-state"),
  position: document.querySelector("#position"),
  prev: document.querySelector("#prev-button"),
  next: document.querySelector("#next-button"),
  roomImage: document.querySelector("#room-image"),
  caseId: document.querySelector("#case-id"),
  notes: document.querySelector("#notes-input"),
  expectFailure: document.querySelector("#expect-failure-input"),
  catalogPane: document.querySelector("#catalog-pane"),
  caseStrip: document.querySelector("#case-strip"),
  countAcceptable: document.querySelector("#count-acceptable"),
  countUnacceptable: document.querySelector("#count-unacceptable"),
  countIdeal: document.querySelector("#count-ideal"),
  coverage: document.querySelector("#coverage"),
  search: document.querySelector("#search-input"),
  familyChips: document.querySelector("#family-chips"),
  stateChips: document.querySelector("#state-chips"),
  visibleCount: document.querySelector("#visible-count"),
  collapseAll: document.querySelector("#collapse-all"),
  expandAll: document.querySelector("#expand-all")
};

let cases = [];
let products = [];
let variantIds = [];
let index = 0;
let saveTimer = null;

// Filter state. Families is a set of colorFamily values; empty means all.
const filter = { query: "", families: new Set(), state: "all" };

init();

async function init() {
  const [casesResponse, catalogResponse] = await Promise.all([
    fetch("/api/eval/cases"),
    fetch("/api/catalog")
  ]);

  cases = (await casesResponse.json()).cases || [];
  const catalog = await catalogResponse.json();
  products = catalog.products || [];
  variantIds = products.flatMap((product) => product.variants.map((variant) => variant.variantId));

  if (cases.length === 0) {
    document.querySelector(".layout").innerHTML =
      `<div class="empty">No photos in <code>evals/rooms/</code> yet. Drop some in and reload.</div>`;
    return;
  }

  document.querySelector("#catalog-name").textContent = catalog.catalogVersion || "";
  renderFilters();
  renderCatalog();
  renderCase();
  bindEvents();
}

function bindEvents() {
  elements.prev.addEventListener("click", () => move(-1));
  elements.next.addEventListener("click", () => move(1));

  elements.notes.addEventListener("input", () => {
    current().notes = elements.notes.value;
    queueSave();
  });

  elements.expectFailure.addEventListener("change", () => {
    current().expectFailure = elements.expectFailure.checked;
    queueSave();
  });

  elements.search.addEventListener("input", () => {
    filter.query = elements.search.value.trim().toLowerCase();
    applyFilter();
  });

  elements.collapseAll.addEventListener("click", () => setAllOpen(false));
  elements.expandAll.addEventListener("click", () => setAllOpen(true));

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("textarea, input")) return;
    if (event.key === "ArrowLeft") move(-1);
    if (event.key === "ArrowRight") move(1);
    if (event.key === "/") {
      event.preventDefault();
      elements.search.focus();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (saveTimer) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

function current() {
  return cases[index];
}

function move(delta) {
  const next = index + delta;
  if (next < 0 || next >= cases.length) return;
  index = next;
  renderCase();
}

// ---------- filters ----------

function renderFilters() {
  const families = new Map();
  for (const product of products) {
    for (const variant of product.variants) {
      const family = variant.colorFamily || "unknown";
      families.set(family, (families.get(family) || 0) + 1);
    }
  }
  const ordered = [...families.entries()].sort((a, b) => b[1] - a[1]);

  elements.familyChips.innerHTML = ordered
    .map(
      ([family, count]) =>
        `<button class="filter-chip" type="button" data-family="${escapeHtml(family)}" aria-pressed="false">${escapeHtml(
          family
        )} <span class="count">${count}</span></button>`
    )
    .join("");

  elements.familyChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".filter-chip");
    if (!chip) return;
    const family = chip.dataset.family;
    if (filter.families.has(family)) filter.families.delete(family);
    else filter.families.add(family);
    chip.setAttribute("aria-pressed", String(filter.families.has(family)));
    applyFilter();
  });

  elements.stateChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".filter-chip");
    if (!chip) return;
    filter.state = chip.dataset.state;
    for (const other of elements.stateChips.querySelectorAll(".filter-chip")) {
      other.setAttribute("aria-pressed", String(other === chip));
    }
    applyFilter();
  });
}

function variantMatches(tile) {
  if (filter.families.size > 0 && !filter.families.has(tile.dataset.family)) return false;
  if (filter.state === "unlabeled" && tile.dataset.state !== "none") return false;
  if (filter.state === "labeled" && tile.dataset.state === "none") return false;
  if (filter.query && !tile.dataset.search.includes(filter.query)) return false;
  return true;
}

// Filtering toggles visibility rather than re-rendering: 321 tiles repaint far faster
// than they rebuild, and open/closed state of sections survives.
function applyFilter() {
  let visible = 0;
  for (const section of elements.catalogPane.querySelectorAll(".category")) {
    let sectionVisible = 0;
    for (const group of section.querySelectorAll(".product-group")) {
      let groupVisible = 0;
      for (const tile of group.querySelectorAll(".variant")) {
        const show = variantMatches(tile);
        tile.hidden = !show;
        if (show) groupVisible += 1;
      }
      group.hidden = groupVisible === 0;
      sectionVisible += groupVisible;
    }
    section.hidden = sectionVisible === 0;
    section.querySelector(".cat-visible").textContent = sectionVisible === section.dataset.total
      ? ""
      : `${sectionVisible} shown`;
    visible += sectionVisible;
  }
  const isFiltered = filter.query || filter.families.size > 0 || filter.state !== "all";
  elements.visibleCount.textContent = isFiltered ? `${visible} of ${variantIds.length} shown` : "";
}

// ---------- catalog ----------

function renderCatalog() {
  const byCategory = new Map();
  for (const product of products) {
    if (!byCategory.has(product.category)) byCategory.set(product.category, []);
    byCategory.get(product.category).push(product);
  }

  elements.catalogPane.innerHTML = [...byCategory.entries()]
    .map(([category, group]) => {
      const total = group.reduce((n, product) => n + product.variants.length, 0);
      const open = readOpen(category);
      return `
        <section class="category" data-category="${escapeHtml(category)}" data-total="${total}">
          <div class="cat-head">
            <button class="cat-toggle" type="button" aria-expanded="${open}">
              <span class="caret"></span>
              <h2>${escapeHtml(category)}</h2>
              <span class="cat-meta">${group.length} product${group.length === 1 ? "" : "s"} · ${total} colour${
                total === 1 ? "" : "s"
              }</span>
              <span class="cat-visible"></span>
            </button>
            <span class="cat-labeled" data-role="labeled"></span>
            <span class="bulk">
              <button type="button" class="bulk-bad" data-scope="category" title="Mark every unlabeled colour in this category unacceptable">✕ rest</button>
              <button type="button" class="bulk-clear" data-scope="category" title="Clear every label in this category">clear</button>
            </span>
          </div>
          <div class="cat-body" ${open ? "" : "hidden"}>
            ${group.map(renderProduct).join("")}
          </div>
        </section>`;
    })
    .join("");

  elements.catalogPane.addEventListener("click", (event) => {
    const toggle = event.target.closest(".cat-toggle");
    if (toggle) {
      const section = toggle.closest(".category");
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      section.querySelector(".cat-body").hidden = !open;
      writeOpen(section.dataset.category, open);
      return;
    }

    const bulk = event.target.closest(".bulk-bad, .bulk-clear");
    if (bulk) {
      const scope = bulk.closest(bulk.dataset.scope === "category" ? ".category" : ".product-group");
      const ids = [...scope.querySelectorAll(".variant")].map((tile) => tile.dataset.variantId);
      if (bulk.classList.contains("bulk-bad")) markRestUnacceptable(ids);
      else clearLabels(ids);
      return;
    }

    const tile = event.target.closest(".variant");
    if (tile) toggleVariant(tile.dataset.variantId, event.shiftKey);
  });
}

function renderProduct(product) {
  return `
    <div class="product-group" data-product-id="${escapeHtml(product.productId)}">
      <div class="product-head">
        <img src="${product.imageUrl}" alt="" loading="lazy" />
        <div class="product-title">
          <h3>${escapeHtml(product.displayName)}</h3>
          ${product.description ? `<div class="variant-meta">${escapeHtml(product.description)}</div>` : ""}
        </div>
        <span class="bulk">
          <button type="button" class="bulk-bad" data-scope="product" title="Mark every unlabeled colour of this product unacceptable">✕ rest</button>
          <button type="button" class="bulk-clear" data-scope="product" title="Clear this product's labels">clear</button>
        </span>
      </div>
      <div class="variant-grid">
        ${product.variants.map((variant) => renderVariant(product, variant)).join("")}
      </div>
    </div>`;
}

function renderVariant(product, variant) {
  const name = variant.name || variant.color || "Default";
  const meta = [variant.colorFamily, variant.warmth, variant.opacity !== "unknown" ? variant.opacity : null]
    .filter(Boolean)
    .join(" · ");
  const search = [product.productId, product.category, product.displayName, name, variant.variantId, variant.colorFamily]
    .join(" ")
    .toLowerCase();
  return `
    <button class="variant" type="button" data-variant-id="${escapeHtml(variant.variantId)}" data-state="none"
      data-family="${escapeHtml(variant.colorFamily || "unknown")}" data-search="${escapeHtml(search)}"
      title="${escapeHtml(variant.variantId)}">
      ${
        variant.swatchImageUrl
          ? `<img src="${variant.swatchImageUrl}" alt="" loading="lazy" />`
          : `<span class="noswatch" title="no swatch — only the room photo">no swatch</span>`
      }
      <span class="variant-mark"></span>
      <span class="variant-name">${escapeHtml(name)}</span>
      <span class="variant-meta">${escapeHtml(meta || variant.variantId)}</span>
    </button>`;
}

// ---------- labels ----------

// none → acceptable → unacceptable → none. Shift toggles ideal, which implies acceptable.
function toggleVariant(variantId, isShift) {
  const labels = current().labels;

  if (isShift) {
    if (labels.ideal.includes(variantId)) {
      labels.ideal = labels.ideal.filter((id) => id !== variantId);
    } else {
      labels.ideal.push(variantId);
      labels.unacceptable = labels.unacceptable.filter((id) => id !== variantId);
      if (!labels.acceptable.includes(variantId)) labels.acceptable.push(variantId);
    }
  } else {
    const state = stateOf(labels, variantId);
    const nextState = STATES[(STATES.indexOf(state) + 1) % STATES.length];
    removeLabels(labels, variantId);
    if (nextState === "acceptable") labels.acceptable.push(variantId);
    if (nextState === "unacceptable") labels.unacceptable.push(variantId);
  }

  paintLabels();
  queueSave();
}

// Bulk: only touches variants that carry no label yet, so an explicit acceptable or
// ideal in the group survives "the rest are wrong".
function markRestUnacceptable(ids) {
  const labels = current().labels;
  for (const id of ids) {
    if (stateOf(labels, id) === "none") labels.unacceptable.push(id);
  }
  paintLabels();
  queueSave();
}

function clearLabels(ids) {
  const labels = current().labels;
  for (const id of ids) removeLabels(labels, id);
  paintLabels();
  queueSave();
}

function removeLabels(labels, variantId) {
  labels.acceptable = labels.acceptable.filter((id) => id !== variantId);
  labels.unacceptable = labels.unacceptable.filter((id) => id !== variantId);
  labels.ideal = labels.ideal.filter((id) => id !== variantId);
}

function stateOf(labels, variantId) {
  if (labels.acceptable.includes(variantId)) return "acceptable";
  if (labels.unacceptable.includes(variantId)) return "unacceptable";
  return "none";
}

function renderCase() {
  const testCase = current();

  elements.roomImage.src = `/eval-rooms/${encodeURIComponent(testCase.photo.replace(/^rooms\//, ""))}`;
  elements.roomImage.alt = testCase.id;
  elements.caseId.textContent = testCase.id;
  elements.notes.value = testCase.notes || "";
  elements.expectFailure.checked = Boolean(testCase.expectFailure);
  elements.position.textContent = `${index + 1} / ${cases.length}`;
  elements.prev.disabled = index === 0;
  elements.next.disabled = index === cases.length - 1;

  paintLabels();
}

function paintLabels() {
  const labels = current().labels;
  const acceptable = new Set(labels.acceptable);
  const unacceptable = new Set(labels.unacceptable);
  const ideal = new Set(labels.ideal);

  for (const section of elements.catalogPane.querySelectorAll(".category")) {
    let labeled = 0;
    for (const tile of section.querySelectorAll(".variant")) {
      const variantId = tile.dataset.variantId;
      const state = acceptable.has(variantId) ? "acceptable" : unacceptable.has(variantId) ? "unacceptable" : "none";
      const isIdeal = ideal.has(variantId);
      tile.dataset.state = state;
      tile.dataset.ideal = String(isIdeal);
      tile.querySelector(".variant-mark").textContent = isIdeal ? "★" : state === "acceptable" ? "✓" : state === "unacceptable" ? "✕" : "";
      if (state !== "none") labeled += 1;
    }
    const total = Number(section.dataset.total);
    const badge = section.querySelector('[data-role="labeled"]');
    badge.textContent = labeled === 0 ? "" : labeled === total ? "all labeled" : `${labeled} / ${total}`;
    badge.dataset.done = String(labeled === total);
  }

  elements.countAcceptable.textContent = `${labels.acceptable.length} acceptable`;
  elements.countUnacceptable.textContent = `${labels.unacceptable.length} unacceptable`;
  elements.countIdeal.textContent = `${labels.ideal.length} ideal`;

  const labeledHere = variantIds.filter((id) => acceptable.has(id) || unacceptable.has(id)).length;
  elements.coverage.textContent = `${labeledHere} / ${variantIds.length} colours labeled for this room`;

  applyFilter();
  renderStrip();
  updateProgress();
}

function isLabeled(testCase) {
  return testCase.labels.acceptable.length > 0 || testCase.labels.unacceptable.length > 0;
}

function updateProgress() {
  const done = cases.filter(isLabeled).length;
  elements.progress.textContent = `${done} / ${cases.length} rooms labeled`;
}

function renderStrip() {
  elements.caseStrip.innerHTML = cases
    .map(
      (testCase, position) =>
        `<button class="case-pip" type="button" data-position="${position}" data-active="${
          position === index
        }" data-labeled="${isLabeled(testCase)}">${escapeHtml(testCase.id)}</button>`
    )
    .join("");

  for (const pip of elements.caseStrip.querySelectorAll(".case-pip")) {
    pip.addEventListener("click", () => {
      index = Number(pip.dataset.position);
      renderCase();
    });
  }
}

// ---------- open/closed state, per browser ----------

function readOpen(category) {
  try {
    const stored = JSON.parse(localStorage.getItem("evalLabelOpen") || "{}");
    return stored[category] !== false;
  } catch {
    return true;
  }
}

function writeOpen(category, open) {
  try {
    const stored = JSON.parse(localStorage.getItem("evalLabelOpen") || "{}");
    stored[category] = open;
    localStorage.setItem("evalLabelOpen", JSON.stringify(stored));
  } catch {
    /* storage unavailable: sections just reopen next time */
  }
}

function setAllOpen(open) {
  for (const section of elements.catalogPane.querySelectorAll(".category")) {
    section.querySelector(".cat-toggle").setAttribute("aria-expanded", String(open));
    section.querySelector(".cat-body").hidden = !open;
    writeOpen(section.dataset.category, open);
  }
}

// ---------- save ----------

function queueSave() {
  elements.saveState.textContent = "unsaved…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}

async function save() {
  try {
    const response = await fetch("/api/eval/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cases })
    });
    if (!response.ok) throw new Error((await response.json()).error || "Save failed.");
    elements.saveState.textContent = `saved ${new Date().toLocaleTimeString()}`;
    saveTimer = null;
  } catch (error) {
    elements.saveState.textContent = `save failed: ${error.message}`;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
