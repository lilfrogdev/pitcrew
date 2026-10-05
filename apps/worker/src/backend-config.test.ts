import { readFileSync } from "node:fs";
import { expect, it, vi } from "vite-plus/test";
import { resolveCatalog, resolveRunModels, validateFrozenModels } from "./model-selection";

const config = JSON.parse(
  readFileSync(new URL("../wrangler.backend.json", import.meta.url), "utf8"),
);

it("keeps the local frontend, paid execution and lifecycle behind disabled backend gates", () => {
  expect(config.assets).toBeUndefined();
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.vars).toMatchObject({
    ENVIRONMENT: "production",
    EXECUTION_MODE: "disabled",
    INFRASTRUCTURE_ADMISSION_ENABLED: "false",
    CLOUD_CONVERSATION_ENABLED: "false",
    REPOSITORY_LIFECYCLE: "disabled",
  });
  expect(config.durable_objects.bindings).toContainEqual({
    name: "CONVERSATION",
    class_name: "RepoConversationAgent",
  });
  expect(config.migrations).toContainEqual({
    tag: "v3",
    new_sqlite_classes: ["RepoConversationAgent"],
  });
  expect(config.account_id).toBe("004227d2029c56b084ce15356768def3");
  expect(config.artifacts).toEqual([{ binding: "ARTIFACTS", namespace: "pitcrew" }]);
});

it("preserves the selected model catalog and frozen role contract without provider transport", () => {
  const fetcher = vi.fn(() => {
    throw Error("provider_transport_forbidden");
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    // Catalog inspection uses a synthetic key only, never an ambient credential.
    const env = {
      ...config.vars,
      EXECUTION_MODE: "cloud",
      OPENROUTER_API_KEY: "synthetic-invalid-never-called",
    };
    const catalog = resolveCatalog(env);
    expect(catalog.choices.map((choice) => choice.model)).toEqual([
      "qwen/qwen3.8-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-flash-vision-exp",
    ]);
    expect(catalog.defaultSelection).toEqual({ modelId: "default", effort: "off" });
    const frozen = resolveRunModels(catalog);
    expect(() => validateFrozenModels(env, frozen)).not.toThrow();
    expect(JSON.stringify(catalog.choices)).not.toContain("secretBinding");
    expect(JSON.stringify(catalog.choices)).not.toContain(env.OPENROUTER_API_KEY);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
