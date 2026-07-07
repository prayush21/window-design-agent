const form = document.querySelector("#recommendation-form");
const imageInput = document.querySelector("#image-input");
const providerInput = document.querySelector("#provider-input");
const modelInput = document.querySelector("#model-input");
const systemPromptInput = document.querySelector("#system-prompt-input");
const submitButton = document.querySelector("#submit-button");
const previewImage = document.querySelector("#preview-image");
const emptyPreview = document.querySelector("#empty-preview");
const catalogGrid = document.querySelector("#catalog-grid");
const recommendationTitle = document.querySelector("#recommendation-title");
const recommendationBody = document.querySelector("#recommendation-body");
const jsonOutput = document.querySelector("#json-output");
const MAX_PREVIEW_OPTIONS = 10;

let imageDataUrl = null;
let latestRecommendationPayload = null;

loadCatalog();
loadDefaultPrompt();

imageInput.addEventListener("change", async () => {
  const file = imageInput.files?.[0];
  if (!file) return;

  imageDataUrl = await fileToDataUrl(file);
  previewImage.src = imageDataUrl;
  previewImage.hidden = false;
  emptyPreview.hidden = true;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!imageDataUrl) return;

  setLoading(true);
  setResultMessage("Analyzing image and ranking products...");

  try {
    const response = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerInput.value,
        model: modelInput.value.trim() || undefined,
        systemPrompt: systemPromptInput.value.trim() || undefined,
        imageDataUrl
      })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Recommendation failed.");

    renderRecommendation(payload);
    jsonOutput.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    recommendationTitle.textContent = "Recommendation failed";
    recommendationBody.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    jsonOutput.textContent = JSON.stringify({ error: error.message }, null, 2);
  } finally {
    setLoading(false);
  }
});

async function loadCatalog() {
  const response = await fetch("/api/catalog");
  const catalog = await response.json();

  catalogGrid.innerHTML = catalog.products
    .map(
      (product) => `
        <figure class="product-card" data-product-id="${escapeHtml(product.productId)}">
          <img src="${product.imageUrl}" alt="${escapeHtml(product.displayName)}" />
          <figcaption>
            <strong>${escapeHtml(product.displayName)}</strong>
            <span>${escapeHtml(product.category)}</span>
            ${renderProductVariants(product)}
          </figcaption>
        </figure>
      `
    )
    .join("");
}

async function loadDefaultPrompt() {
  const response = await fetch("/api/default-prompt");
  const payload = await response.json();
  systemPromptInput.value = payload.systemPrompt || "";
}

function renderRecommendation(payload) {
  const previewOptions = getPreviewOptions(payload);
  latestRecommendationPayload = { ...payload, previewOptions };
  const recommendation = payload.recommendation;
  recommendationTitle.textContent = formatRecommendationName(recommendation);

  const analysis = payload.analysis;
  const rankingHtml = previewOptions
    .map((item, index) => renderRankingItem(item, index, payload.provider))
    .join("");

  recommendationBody.innerHTML = `
    <div class="hero-result">
      ${renderHeroImage(recommendation)}
      <div>
        <p class="score">${Math.round(recommendation.confidence * 100)}% confidence</p>
        <p class="variant-summary">${escapeHtml(formatVariantSummary(recommendation))}</p>
        <p>${escapeHtml(recommendation.reason)}</p>
        <div class="preview-action">
          <span>Preview this product on the uploaded window?</span>
          ${renderGenerateControl({ optionIndex: "recommendation", provider: payload.provider })}
        </div>
      </div>
    </div>
    <div class="generated-preview" data-preview-container="recommendation" hidden></div>
    ${analysis ? renderAnalysis(analysis) : ""}
    <ol class="ranking-list">${rankingHtml}</ol>
  `;

  document.querySelectorAll(".product-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.productId === recommendation.productId);
  });
  document.querySelectorAll(".variant-chip").forEach((chip) => {
    chip.classList.toggle("selected", chip.dataset.variantId === recommendation.variantId);
  });

  bindPreviewControls();
}

function getPreviewOptions(payload) {
  const rankings = Array.isArray(payload.rankings) ? payload.rankings : [];
  return rankings.slice(0, MAX_PREVIEW_OPTIONS);
}

function renderRankingItem(item, index, provider) {
  return `
    <li>
      ${renderRankingImage(item)}
      <div class="ranking-content">
        <div>
          <strong>${item.rank}. ${escapeHtml(formatRecommendationName(item))}</strong>
          <span>${Math.round(item.score * 100)}% match${item.texture ? ` · ${escapeHtml(item.texture)}` : ""}</span>
          <p>${escapeHtml(item.reason)}</p>
        </div>
        <div class="ranking-actions">
          ${renderGenerateControl({ optionIndex: String(index), provider })}
        </div>
        <div class="generated-preview ranking-preview" data-preview-container="${escapeHtml(String(index))}" hidden></div>
      </div>
    </li>
  `;
}

function renderGenerateControl({ optionIndex, provider }) {
  return `
    <div class="generate-control" data-preview-option-index="${escapeHtml(optionIndex)}">
      <button class="preview-generate-button" type="button">Generate</button>
      <label class="image-provider-field" aria-label="Image generation provider">
        <select class="image-provider-input" name="imageProvider">
          <option value="openai"${imageProviderSelected(provider, "openai")}>OpenAI image</option>
          <option value="gemini"${imageProviderSelected(provider, "gemini")}>Gemini image</option>
        </select>
      </label>
    </div>
  `;
}

function bindPreviewControls() {
  document.querySelectorAll(".preview-generate-button").forEach((button) => {
    button.addEventListener("click", () => generatePreviewImage(button));
  });
}

async function generatePreviewImage(triggerButton) {
  if (!imageDataUrl || !latestRecommendationPayload) return;

  const control = triggerButton.closest("[data-preview-option-index]");
  const optionIndex = control?.dataset.previewOptionIndex;
  const previewOption = getPreviewOption(optionIndex);
  if (!control || !previewOption) return;

  const imageProviderInput = control.querySelector(".image-provider-input");
  const previewContainer = document.querySelector(
    `[data-preview-container="${cssEscape(optionIndex)}"]`
  );
  if (!previewContainer) return;

  const selectedImageProvider = imageProviderInput?.value || "openai";
  triggerButton.disabled = true;
  if (imageProviderInput) imageProviderInput.disabled = true;
  triggerButton.textContent = "Generating...";
  previewContainer.hidden = false;
  previewContainer.innerHTML = `<p>Creating installed product preview with ${escapeHtml(formatImageProvider(selectedImageProvider))}...</p>`;

  try {
    const response = await fetch("/api/preview-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageDataUrl,
        imageProvider: selectedImageProvider,
        productId: previewOption.productId,
        variantId: previewOption.variantId,
        recommendation: previewOption
      })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Preview generation failed.");

    previewContainer.innerHTML = `
      <figure>
        <img src="${payload.imageDataUrl}" alt="${escapeHtml(payload.displayName)} installed preview" />
        <figcaption>
          <strong>${escapeHtml(formatRecommendationName(payload))}</strong>
          <span>${escapeHtml(formatImageProvider(payload.provider))} · ${escapeHtml(payload.model)} · ${escapeHtml(payload.quality)} quality</span>
        </figcaption>
      </figure>
    `;
    jsonOutput.textContent = JSON.stringify(
      {
        previewSource: previewOption,
        generatedPreview: {
          ...payload,
          imageDataUrl: "[base64 image omitted from debug view]"
        }
      },
      null,
      2
    );
  } catch (error) {
    previewContainer.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  } finally {
    triggerButton.disabled = false;
    if (imageProviderInput) imageProviderInput.disabled = false;
    triggerButton.textContent = "Generate";
  }
}

function getPreviewOption(optionIndex) {
  if (optionIndex === "recommendation") return latestRecommendationPayload.recommendation;

  const index = Number(optionIndex);
  if (!Number.isInteger(index)) return null;
  return latestRecommendationPayload.previewOptions[index] || null;
}

function formatImageProvider(provider) {
  return provider === "gemini" ? "Gemini" : "OpenAI";
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function imageProviderSelected(recommendationProvider, imageProvider) {
  const supportedProvider = recommendationProvider === "openai" || recommendationProvider === "gemini"
    ? recommendationProvider
    : "openai";
  return supportedProvider === imageProvider ? " selected" : "";
}

function renderProductVariants(product) {
  if (!Array.isArray(product.variants) || product.variants.length === 0) return "";

  return `
    <div class="variant-strip" aria-label="${escapeHtml(product.displayName)} variants">
      ${product.variants
        .map(
          (variant) => `
            <span class="variant-chip" data-variant-id="${escapeHtml(variant.variantId)}" title="${escapeHtml(
              formatVariantSummary(variant)
            )}">
              ${
                variant.swatchImageUrl
                  ? `<img src="${variant.swatchImageUrl}" alt="${escapeHtml(variant.name || variant.color || "Variant swatch")}" />`
                  : ""
              }
              <span>${escapeHtml(variant.name || variant.color || "Default")}</span>
            </span>
          `
        )
        .join("")}
    </div>
  `;
}

function renderHeroImage(item) {
  return `
    <div class="hero-media">
      <img class="product-image" src="${item.imageUrl}" alt="${escapeHtml(item.displayName)}" />
      ${
        item.swatchImageUrl
          ? `<img class="swatch-image" src="${item.swatchImageUrl}" alt="${escapeHtml(item.variantName || "Selected swatch")}" />`
          : ""
      }
    </div>
  `;
}

function renderRankingImage(item) {
  return `
    <div class="ranking-media">
      <img class="product-image" src="${item.imageUrl}" alt="${escapeHtml(item.displayName)}" />
      ${
        item.swatchImageUrl
          ? `<img class="swatch-image" src="${item.swatchImageUrl}" alt="${escapeHtml(item.variantName || "Variant swatch")}" />`
          : ""
      }
    </div>
  `;
}

function formatRecommendationName(item) {
  return [item.displayName, item.variantName && item.variantName !== "Default" ? item.variantName : null]
    .filter(Boolean)
    .join(" · ");
}

function formatVariantSummary(item) {
  return [item.color || item.variantName, item.material, item.texture, item.opacity]
    .filter((value) => value && value !== "unknown")
    .join(" · ");
}

function renderAnalysis(analysis) {
  const style = analysis.room?.style || [];
  const palette = analysis.room?.palette || [];

  return `
    <dl class="analysis-list">
      <div>
        <dt>Window</dt>
        <dd>${escapeHtml([analysis.window?.shape, analysis.window?.frameColor].filter(Boolean).join(", ") || "Unknown")}</dd>
      </div>
      <div>
        <dt>Room</dt>
        <dd>${escapeHtml([...style, ...palette].join(", ") || "Unknown")}</dd>
      </div>
      <div>
        <dt>Needs</dt>
        <dd>${escapeHtml(`privacy ${analysis.needs?.privacy || "unknown"}, light ${analysis.needs?.lightControl || "unknown"}`)}</dd>
      </div>
    </dl>
  `;
}

function setResultMessage(message) {
  recommendationTitle.textContent = "Working";
  recommendationBody.innerHTML = `<p>${escapeHtml(message)}</p>`;
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Running..." : "Run recommendation";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
