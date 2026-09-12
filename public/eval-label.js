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
  countIdeal: document.querySelector("#count-ideal")
};

let cases = [];
let products = [];
let index = 0;
let saveTimer = null;

init();

async function init() {
  const [casesResponse, catalogResponse] = await Promise.all([
    fetch("/api/eval/cases"),
    fetch("/api/catalog")
  ]);

  cases = (await casesResponse.json()).cases || [];
  products = (await catalogResponse.json()).products || [];

  if (cases.length === 0) {
    document.querySelector(".layout").innerHTML =
      `<div class="empty">No photos in <code>evals/rooms/</code> yet. Drop some in and reload.</div>`;
    return;
  }

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

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("textarea, input")) return;
    if (event.key === "ArrowLeft") move(-1);
    if (event.key === "ArrowRight") move(1);
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

function renderCatalog() {
  elements.catalogPane.innerHTML = products
    .map(
      (product) => `
        <div class="product-group">
          <div class="product-head">
            <img src="${product.imageUrl}" alt="" />
            <div>
              <h3>${escapeHtml(product.displayName)}</h3>
              <div class="variant-meta">${escapeHtml(product.category)}</div>
            </div>
          </div>
          <div class="variant-grid">
            ${product.variants.map(renderVariant).join("")}
          </div>
        </div>`
    )
    .join("");

  elements.catalogPane.addEventListener("click", (event) => {
    const tile = event.target.closest(".variant");
    if (tile) toggleVariant(tile.dataset.variantId, event.shiftKey);
  });
}

function renderVariant(variant) {
  const meta = [variant.color, variant.material].filter(Boolean).join(" · ");
  return `
    <button class="variant" type="button" data-variant-id="${escapeHtml(variant.variantId)}" data-state="none">
      ${
        variant.swatchImageUrl
          ? `<img src="${variant.swatchImageUrl}" alt="" />`
          : `<span class="noswatch"></span>`
      }
      <span class="variant-mark"></span>
      <span class="variant-name">${escapeHtml(variant.name || variant.color || "Default")}</span>
      <span class="variant-meta">${escapeHtml(meta || variant.variantId)}</span>
    </button>`;
}

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

    labels.acceptable = labels.acceptable.filter((id) => id !== variantId);
    labels.unacceptable = labels.unacceptable.filter((id) => id !== variantId);
    labels.ideal = labels.ideal.filter((id) => id !== variantId);

    if (nextState === "acceptable") labels.acceptable.push(variantId);
    if (nextState === "unacceptable") labels.unacceptable.push(variantId);
  }

  paintLabels();
  queueSave();
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
  renderStrip();
}

function paintLabels() {
  const labels = current().labels;

  for (const tile of elements.catalogPane.querySelectorAll(".variant")) {
    const variantId = tile.dataset.variantId;
    const state = stateOf(labels, variantId);
    const isIdeal = labels.ideal.includes(variantId);
    tile.dataset.state = state;
    tile.dataset.ideal = String(isIdeal);
    tile.querySelector(".variant-mark").textContent = isIdeal
      ? "★"
      : state === "acceptable"
        ? "✓"
        : state === "unacceptable"
          ? "✕"
          : "";
  }

  elements.countAcceptable.textContent = `${labels.acceptable.length} acceptable`;
  elements.countUnacceptable.textContent = `${labels.unacceptable.length} unacceptable`;
  elements.countIdeal.textContent = `${labels.ideal.length} ideal`;
  renderStrip();
  updateProgress();
}

function isLabeled(testCase) {
  return testCase.labels.acceptable.length > 0 || testCase.labels.unacceptable.length > 0;
}

function updateProgress() {
  const done = cases.filter(isLabeled).length;
  elements.progress.textContent = `${done} / ${cases.length} labeled`;
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
