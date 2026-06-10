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
  latestRecommendationPayload = payload;
  const recommendation = payload.recommendation;
  recommendationTitle.textContent = recommendation.displayName;

  const analysis = payload.analysis;
  const rankingHtml = payload.rankings
    .map(
      (item) => `
        <li>
          <img src="${item.imageUrl}" alt="${escapeHtml(item.displayName)}" />
          <div>
            <strong>${item.rank}. ${escapeHtml(item.displayName)}</strong>
            <span>${Math.round(item.score * 100)}% match</span>
            <p>${escapeHtml(item.reason)}</p>
          </div>
        </li>
      `
    )
    .join("");

  recommendationBody.innerHTML = `
    <div class="hero-result">
      <img src="${recommendation.imageUrl}" alt="${escapeHtml(recommendation.displayName)}" />
      <div>
        <p class="score">${Math.round(recommendation.confidence * 100)}% confidence</p>
        <p>${escapeHtml(recommendation.reason)}</p>
        <div class="preview-action">
          <span>Preview this product on the uploaded window?</span>
          <div class="generate-control">
            <button id="preview-button" type="button">Generate</button>
            <label class="image-provider-field" aria-label="Image generation provider">
              <select id="image-provider-input" name="imageProvider">
                <option value="openai"${imageProviderSelected(payload.provider, "openai")}>OpenAI image</option>
                <option value="gemini"${imageProviderSelected(payload.provider, "gemini")}>Gemini image</option>
              </select>
            </label>
          </div>
        </div>
      </div>
    </div>
    <div id="generated-preview" class="generated-preview" hidden></div>
    ${analysis ? renderAnalysis(analysis) : ""}
    <ol class="ranking-list">${rankingHtml}</ol>
  `;

  document.querySelectorAll(".product-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.productId === recommendation.productId);
  });

  document.querySelector("#preview-button")?.addEventListener("click", generatePreviewImage);
}

async function generatePreviewImage() {
  if (!imageDataUrl || !latestRecommendationPayload?.recommendation) return;

  const previewButton = document.querySelector("#preview-button");
  const imageProviderInput = document.querySelector("#image-provider-input");
  const previewContainer = document.querySelector("#generated-preview");
  const selectedImageProvider = imageProviderInput?.value || "openai";
  previewButton.disabled = true;
  if (imageProviderInput) imageProviderInput.disabled = true;
  previewButton.textContent = "Generating...";
  previewContainer.hidden = false;
  previewContainer.innerHTML = `<p>Creating installed product preview with ${escapeHtml(formatImageProvider(selectedImageProvider))}...</p>`;

  try {
    const response = await fetch("/api/preview-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageDataUrl,
        imageProvider: selectedImageProvider,
        productId: latestRecommendationPayload.recommendation.productId,
        recommendation: latestRecommendationPayload.recommendation
      })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Preview generation failed.");

    previewContainer.innerHTML = `
      <figure>
        <img src="${payload.imageDataUrl}" alt="${escapeHtml(payload.displayName)} installed preview" />
        <figcaption>
          <strong>${escapeHtml(payload.displayName)}</strong>
          <span>${escapeHtml(formatImageProvider(payload.provider))} · ${escapeHtml(payload.model)} · ${escapeHtml(payload.quality)} quality</span>
        </figcaption>
      </figure>
    `;
    jsonOutput.textContent = JSON.stringify(
      {
        recommendation: latestRecommendationPayload,
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
    previewButton.disabled = false;
    if (imageProviderInput) imageProviderInput.disabled = false;
    previewButton.textContent = "Generate";
  }
}

function formatImageProvider(provider) {
  return provider === "gemini" ? "Gemini" : "OpenAI";
}

function imageProviderSelected(recommendationProvider, imageProvider) {
  const supportedProvider = recommendationProvider === "openai" || recommendationProvider === "gemini"
    ? recommendationProvider
    : "openai";
  return supportedProvider === imageProvider ? " selected" : "";
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
