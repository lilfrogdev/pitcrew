import { expect, it } from "vite-plus/test";
import { modelBrand } from "./model-brand";

it("identifies the model owner independently of an aggregator's routing provider", () => {
  for (const [model, expected] of [
    ["anthropic/claude-sonnet-5", "claude"],
    ["qwen/qwen3.8-flash", "qwen"],
    ["deepseek/deepseek-r1-distill-qwen-32b", "deepseek"],
    ["google/gemini-2.5-pro", "gemini"],
    ["google/gemma-3-27b-it", "google"],
    ["openai/gpt-5", "openai"],
    ["meta-llama/llama-4-maverick", "meta"],
    ["mistralai/codestral", "mistral"],
    ["moonshotai/kimi-k2", "kimi"],
    ["z-ai/glm-4.5", "glm"],
  ]) {
    expect(modelBrand({ model })).toBe(expected);
  }
});

it("recognizes standalone family identifiers and normalized casing", () => {
  expect(modelBrand({ model: " Sonnet5 " })).toBe("claude");
  expect(modelBrand({ model: "Qwen3.8-Flash" })).toBe("qwen");
  expect(modelBrand({ model: "deepseek-r1-distill-llama" })).toBe("deepseek");
  expect(modelBrand({ model: "o3-mini" })).toBe("openai");
});

it("leaves unknown, automatic, and misleading identities neutral", () => {
  for (const model of [
    "unknown/gpt-5",
    "openrouter/auto",
    "claudeish",
    "qwenish",
    "some-deepseek-model",
    "synthetic/model-1",
    "",
  ]) {
    expect(modelBrand({ model })).toBeUndefined();
  }
  expect(modelBrand(undefined)).toBeUndefined();
});
