import { expect, it } from "vite-plus/test";
import { modelLabel } from "./model-label";

it("removes duplicated publisher prefixes from the current catalog while retaining distinct variants", () => {
  expect(modelLabel("Qwen: Qwen3.8 Flash")).toBe("Qwen3.8 Flash");
  expect(modelLabel("DeepSeek: DeepSeek V4 Flash 0423")).toBe("DeepSeek V4 Flash 0423");
  expect(modelLabel("DeepSeek: DeepSeek V4 Flash 0731")).toBe("DeepSeek V4 Flash 0731");
  expect(modelLabel("DeepSeek: DeepSeek V4 Flash Vision Exp")).toBe("DeepSeek V4 Flash Vision Exp");
  expect(modelLabel("qwen: Qwen3.8 Flash (free)")).toBe("Qwen3.8 Flash (free)");
});

it("preserves meaningful publishers, model names, and partial-prefix matches", () => {
  for (const label of [
    "Anthropic: Claude Sonnet 5",
    "Google: Gemini Pro",
    "OpenAI: GPT 5",
    "Meta: Llama 4",
    "Model: ModelScope Pro",
    "Claude Sonnet 5",
    "DeepSeek V4 Flash 0731",
    "Unknown model",
    "",
  ]) {
    expect(modelLabel(label)).toBe(label);
  }
});
