import type { ModelChoice } from "@pitcrew/protocol";

export type ModelBrand =
  | "claude"
  | "qwen"
  | "deepseek"
  | "gemini"
  | "google"
  | "openai"
  | "grok"
  | "meta"
  | "mistral"
  | "kimi"
  | "glm"
  | "minimax"
  | "nvidia"
  | "cohere";

const vendors = new Map<string, ModelBrand>([
  ["anthropic", "claude"],
  ["qwen", "qwen"],
  ["qwenlm", "qwen"],
  ["deepseek", "deepseek"],
  ["openai", "openai"],
  ["x-ai", "grok"],
  ["xai", "grok"],
  ["meta-llama", "meta"],
  ["meta", "meta"],
  ["mistralai", "mistral"],
  ["mistral", "mistral"],
  ["moonshotai", "kimi"],
  ["moonshot", "kimi"],
  ["z-ai", "glm"],
  ["zhipuai", "glm"],
  ["zhipu", "glm"],
  ["minimax", "minimax"],
  ["nvidia", "nvidia"],
  ["cohere", "cohere"],
]);

const families: [RegExp, ModelBrand][] = [
  [/^(claude|sonnet|opus|haiku)(?:$|[-_.:]|\d)/, "claude"],
  [/^qwen(?:$|[-_.:]|\d)/, "qwen"],
  [/^deepseek(?:$|[-_.:]|\d)/, "deepseek"],
  [/^gemini(?:$|[-_.:]|\d)/, "gemini"],
  [/^gemma(?:$|[-_.:]|\d)/, "google"],
  [/^(gpt|chatgpt)(?:$|[-_.:]|\d)|^o\d+(?:$|[-_.:])/, "openai"],
  [/^grok(?:$|[-_.:]|\d)/, "grok"],
  [/^llama(?:$|[-_.:]|\d)/, "meta"],
  [/^(mistral|mixtral|codestral|devstral|magistral|ministral)(?:$|[-_.:]|\d)/, "mistral"],
  [/^kimi(?:$|[-_.:]|\d)/, "kimi"],
  [/^(glm|chatglm)(?:$|[-_.:]|\d)/, "glm"],
  [/^minimax(?:$|[-_.:]|\d)/, "minimax"],
  [/^nemotron(?:$|[-_.:]|\d)/, "nvidia"],
  [/^command(?:$|[-_.:]|\d)/, "cohere"],
];

/** Presentation only: routing still uses the catalog's provider and model unchanged. */
export function modelBrand(model: Pick<ModelChoice, "model"> | undefined): ModelBrand | undefined {
  const identity = model?.model.trim().toLowerCase();
  if (!identity) return undefined;
  const slash = identity.indexOf("/");
  if (slash !== -1) {
    const vendor = identity.slice(0, slash);
    const name = identity.slice(slash + 1);
    if (vendor === "google") return /^gemini(?:$|[-_.:]|\d)/.test(name) ? "gemini" : "google";
    return vendors.get(vendor);
  }
  return families.find(([pattern]) => pattern.test(identity))?.[1];
}
