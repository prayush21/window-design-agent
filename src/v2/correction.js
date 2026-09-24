import { text } from "../providers.js";
import { correctionNote } from "./runtime.js";

// On a retry, LLM stages append what the previous answer got wrong.
export function withCorrection(blocks, ctx) {
  const note = correctionNote(ctx.previousErrors);
  return note ? [...blocks, text(note)] : blocks;
}
