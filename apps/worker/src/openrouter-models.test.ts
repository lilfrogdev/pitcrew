import { expect, it, vi } from "vite-plus/test";
import { resolveCatalog, resolveRunModels, validateSelection } from "./model-selection";
import { configureModels } from "./pi-models";
import { qwenPayload } from "./openrouter-models";
import { selectionAttachmentCapabilities } from "@pitcrew/protocol";
const config = (model: string) => ({
  provider: "byok" as const,
  providerId: "openrouter",
  model,
  secretBinding: "OPENROUTER_API_KEY",
});
const env = (model: string) => ({
  EXECUTION_MODE: "cloud",
  MODEL_CONFIGURATION: JSON.stringify(config(model)),
  OPENROUTER_API_KEY: "synthetic-not-a-credential",
});

it("configures native OpenRouter with only the explicit binding and no provider request", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("provider calls forbidden"));
  try {
    const { models, model } = configureModels(config("deepseek/deepseek-v4-flash-vision-exp"), {
      secrets: { OPENROUTER_API_KEY: "synthetic-not-a-credential" },
    });
    expect(model.provider).toBe("openrouter");
    expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(await models.getAuth("openai")).toBeUndefined();
    expect((await models.getAuth("openrouter"))?.source).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(() => configureModels(config(model.id), {})).toThrow("model_not_configured");
    expect(() =>
      configureModels(config("invented/model"), { secrets: { OPENROUTER_API_KEY: "synthetic" } }),
    ).toThrow("model_not_configured");
  } finally {
    fetch.mockRestore();
  }
});
it.each([
  ["deepseek/deepseek-v4-flash", ["off", "high", "xhigh"], false, 0.027, 1.28],
  ["deepseek/deepseek-v4-flash-0731", ["off", "low", "high", "max"], false, 0.0152, 1.28],
  ["deepseek/deepseek-v4-flash-vision-exp", ["off", "low", "high", "max"], true, 0.2156, 0.6468],
])("preserves verified capabilities for %s", (id, efforts, images, input, output) => {
  const catalog = resolveCatalog(env(id as string));
  const choice = catalog.choices[0];
  expect(choice.efforts).toEqual(efforts);
  expect(catalog.defaultSelection.effort).toBe("high");
  expect(choice.pricing).toEqual({
    input,
    output,
    currency: "USD",
    per: "million_tokens",
    asOf: "2026-10-05",
  });
  expect(choice.contextWindow).toBe(1048576);
  expect(selectionAttachmentCapabilities(catalog.choices, resolveRunModels(catalog)).images).toBe(
    images,
  );
  expect(() => validateSelection(catalog, { modelId: "default", effort: "medium" })).toThrow(
    "invalid_model_selection",
  );
  expect(JSON.stringify(catalog.choices)).not.toMatch(/synthetic|secretBinding|OPENROUTER_API_KEY/);
});
it("fences the catalog when switching dated model variants", () => {
  expect(resolveCatalog(env("deepseek/deepseek-v4-flash")).revision).not.toBe(
    resolveCatalog(env("deepseek/deepseek-v4-flash-0731")).revision,
  );
});
it("publishes Qwen with verified vision and explicit reasoning off until budget constraints are verified", () => {
  const catalog = resolveCatalog(env("qwen/qwen3.8-flash"));
  expect(catalog.choices[0].efforts).toEqual(["off"]);
  expect(catalog.defaultSelection.effort).toBe("off");
  expect(catalog.choices[0].imageLimits).toBeDefined();
  expect(catalog.choices[0].pricing?.input).toBe(0.15);
  expect(() => validateSelection(catalog, { modelId: "default", effort: "low" })).toThrow(
    "invalid_model_selection",
  );
  expect(qwenPayload({ reasoning: { effort: "none" }, tool_choice: "auto" })).toEqual({
    reasoning: { enabled: false },
    tool_choice: "auto",
  });
  expect(() => qwenPayload({ reasoning: { effort: "low" } })).toThrow(
    "unsupported_reasoning_preset",
  );
  expect(() => qwenPayload({ tool_choice: "required" })).toThrow("unsupported_tool_choice");
});
it("sends the exact documented Qwen reasoning/tool contract through native Pi with mocked fetch", async () => {
  const { models, model } = configureModels(config("qwen/qwen3.8-flash"), {
    secrets: { OPENROUTER_API_KEY: "synthetic-not-a-credential" },
  });
  let sent: Record<string, unknown> | undefined;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"mocked"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  await models.completeSimple(
    model,
    {
      messages: [{ role: "user", content: "Synthetic fixture only", timestamp: 0 }],
      tools: [
        {
          name: "fixture",
          description: "Offline tool fixture",
          parameters: { type: "object", properties: {} } as never,
        },
      ],
    },
    { maxTokens: 256, fetch, toolChoice: "auto" },
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(sent?.model).toBe("qwen/qwen3.8-flash");
  expect(sent?.reasoning).toEqual({ enabled: false });
  expect(sent?.tool_choice).toBe("auto");
  expect(sent?.tools).toHaveLength(1);
});
it("offers explicit mixed model choices and freezes image compatibility across roles", () => {
  const catalog = resolveCatalog({
    ...env("qwen/qwen3.8-flash"),
    MODELS_CONFIGURATION: JSON.stringify([
      { id: "deepseek-text", configuration: config("deepseek/deepseek-v4-flash") },
      { id: "deepseek-vision", configuration: config("deepseek/deepseek-v4-flash-vision-exp") },
    ]),
  });
  expect(catalog.choices.map((choice) => choice.model)).toEqual([
    "qwen/qwen3.8-flash",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-flash-vision-exp",
  ]);
  const frozen = resolveRunModels(catalog, undefined, {
    default: catalog.defaultSelection,
    roles: { reviewer: { modelId: "deepseek-text", effort: "high" } },
  });
  expect(frozen.repoAgent).toEqual({ modelId: "default", effort: "off" });
  expect(frozen.reviewer.modelId).toBe("deepseek-text");
  expect(frozen.catalogRevision).toBe(catalog.revision);
  expect(selectionAttachmentCapabilities(catalog.choices, frozen).images).toBe(false);
});
