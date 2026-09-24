import fs from "node:fs";
import { callProvider } from "../providers.js";
import { generateProductPreview } from "../image-preview.js";
import { loadFixtureStore, mockRender } from "../mock-provider.js";

// The only door from v2 to a model. Stages ask for "an LLM call for stage X" or
// "an image for stage X"; this adapter decides mock vs live from config.mode and
// refuses any real call unless the user set DESIGN_AGENT_LIVE=1.

export class LiveCallRefusedError extends Error {
  constructor(stage) {
    super(`Refused a real provider call for stage "${stage}": DESIGN_AGENT_LIVE is not 1.`);
    this.name = "LiveCallRefusedError";
  }
}

export function createProviders(config, { fixturesDir, env = process.env } = {}) {
  let store = null;
  const fixtures = () => {
    store ??= loadFixtureStore(fixturesDir);
    return store;
  };

  function assertLive(stage) {
    if (config.mode !== "live" || env.DESIGN_AGENT_LIVE !== "1") throw new LiveCallRefusedError(stage);
  }

  return {
    mode: config.mode,

    async llm({ stage, blocks, fixtureKey, attempt = 1 }) {
      const target = config.stages[stage];
      if (!target) throw new Error(`No provider config for stage "${stage}".`);
      if (config.mode === "baseline") throw new Error(`Stage "${stage}" asked for a model in baseline mode.`);

      if (config.mode === "mock") {
        const response = await callProvider({
          provider: "mock",
          blocks,
          mock: { stage, key: fixtureKey, attempt, store: fixtures() }
        });
        return { ...response, wouldBe: { provider: target.provider, model: target.model } };
      }

      assertLive(stage);
      const response = await callProvider({ provider: target.provider, model: target.model, blocks });
      return { ...response, wouldBe: null };
    },

    async image({ stage, roomPhotoPath, roomDataUrl, product, variant, recommendation, mock }) {
      const target = config.stages[stage];
      if (config.mode !== "live") {
        // Mock render: flat swatch-coloured patch over the window region. An optional
        // fixture may override the colour, which is how off-colour renders are tested.
        const override = fixtures().get(stage, mock.fixtureKey);
        const response = override?.responses?.[Math.min(mock.attempt, override.responses.length) - 1];
        const colourHex = response?.json?.colourHex || mock.colourHex;
        const bytes = await mockRender({ roomBytes: fs.readFileSync(roomPhotoPath), region: mock.region, colourHex });
        return {
          provider: "mock",
          model: "mock",
          bytes,
          mimeType: "image/jpeg",
          usage: { images: 1, inputTokens: null, outputTokens: null, totalTokens: null, estimated: true },
          wouldBe: { provider: target.provider, model: target.model },
          fixture: override ? { file: override.file, note: override.note || null } : null
        };
      }

      assertLive(stage);
      const preview = await generateProductPreview({
        provider: target.provider,
        model: target.model,
        userImageDataUrl: roomDataUrl,
        product,
        variant,
        recommendation
      });
      const match = preview.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      return {
        provider: preview.provider,
        model: preview.model,
        bytes: Buffer.from(match[2], "base64"),
        mimeType: match[1],
        usage: { images: 1, ...(preview.usage || {}) },
        wouldBe: null
      };
    }
  };
}
