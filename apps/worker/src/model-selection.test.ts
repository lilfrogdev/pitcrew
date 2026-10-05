import { expect, it } from "vite-plus/test";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { configureModels } from "./pi-models";
import {
  configureConversation,
  resolveCatalog,
  resolveRunModels,
  validateSelection,
} from "./model-selection";

it("publishes only enabled metadata and rejects unsupported effort, model, or credential fields", () => {
  const catalog = resolveCatalog({ MODEL_CONFIGURATION: '{"provider":"fake"}' });
  expect(catalog.defaultSelection).toEqual({ modelId: "default", effort: "off" });
  expect(catalog.choices[0].imageLimits?.maxBytes).toBe(1024 * 1024);
  expect(JSON.stringify(catalog.choices)).not.toContain("secretBinding");
  expect(() => validateSelection(catalog, { modelId: "default", effort: "high" })).toThrow(
    "invalid_model_selection",
  );
  expect(() => validateSelection(catalog, { modelId: "unlisted", effort: "off" })).toThrow(
    "invalid_model_selection",
  );
  expect(() =>
    validateSelection(catalog, { modelId: "default", effort: "off", secretBinding: "API_KEY" }),
  ).toThrow("invalid_model_selection");
});
it("freezes independent inherited selections and explicit existing-role overrides", () => {
  const catalog = resolveCatalog({
    MODELS_CONFIGURATION: '[{"id":"review","configuration":{"provider":"fake"}}]',
  });
  const selected = { modelId: "default", effort: "off" as const };
  const frozen = resolveRunModels(catalog, selected, {
    default: selected,
    roles: { reviewer: { modelId: "review", effort: "off" } },
  });
  selected.modelId = "review";
  expect(frozen.repoAgent.modelId).toBe("default");
  expect(frozen.implementer.modelId).toBe("default");
  expect(frozen.reviewer.modelId).toBe("review");
  expect(Object.isFrozen(frozen.implementer)).toBe(true);
  expect(() =>
    resolveRunModels(catalog, undefined, {
      default: catalog.defaultSelection,
      roles: { researcher: catalog.defaultSelection },
    } as never),
  ).toThrow("invalid_model_selection");
});
it("uses pinned Pi reasoning/image metadata without making provider requests", () => {
  const env = {
    EXECUTION_MODE: "cloud",
    MODEL_CONFIGURATION:
      '{"provider":"byok","providerId":"openai","model":"gpt-6-sol","secretBinding":"TEST_KEY"}',
    TEST_KEY: "synthetic-not-a-credential",
  };
  const catalog = resolveCatalog(env);
  expect(catalog.choices[0].provider).toBe("openai");
  expect(catalog.choices[0].efforts).toContain("high");
  expect(catalog.choices[0].imageLimits?.maxBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(JSON.stringify(catalog.choices)).not.toContain("synthetic");
  expect(JSON.stringify(catalog.choices)).not.toContain("TEST_KEY");
});
it("rejects duplicate deployment ids and never admits remote models to local mode", () => {
  expect(() =>
    resolveCatalog({
      MODELS_CONFIGURATION: '[{"id":"default","configuration":{"provider":"fake"}}]',
    }),
  ).toThrow("model_not_configured");
  expect(() =>
    resolveCatalog({
      MODEL_CONFIGURATION:
        '{"provider":"byok","providerId":"openai","model":"gpt-6-sol","secretBinding":"TEST_KEY"}',
    }),
  ).toThrow("model_not_enabled");
});
it("configures and persists actual durable Pi model and effort before a faux submission", async () => {
  const faux = fauxProvider({
    provider: "test-selection",
    models: [{ id: "selected", reasoning: true }],
  });
  faux.setResponses([fauxAssistantMessage("selected model used")]);
  const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
  const context = {
    abortSignal: AbortSignal.timeout(5000),
    value: () => undefined,
    toString: () => "selection fixture",
  };
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  try {
    const conversation = await configureConversation(
      harness,
      model,
      { modelId: "test", effort: "high" },
      context,
    );
    const agent = await conversation.agent(context);
    expect(agent.model).toEqual({ provider: "test-selection", modelId: "selected" });
    expect(agent.thinkingLevel).toBe("high");
    const receipt = await conversation.submit(
      { type: "input", requestId: "selected-run", content: "Synthetic fixture only" },
      context,
    );
    await receipt.wait(context);
    await conversation.waitForIdle(context);
    expect(faux.state.callCount).toBe(1);
    expect(JSON.stringify((await conversation.context(context)).messages)).toContain(
      "selected model used",
    );
  } finally {
    await harness.close(context);
  }
});
it("intersects attachment support and budgets across inherited and overridden roles", async () => {
  const { selectionAttachmentCapabilities } = await import("@pitcrew/protocol");
  const vision = resolveCatalog({}).choices[0];
  const text = { ...vision, id: "text-only", imageLimits: undefined, contextWindow: 8192 };
  const selection = { modelId: "default", effort: "off" as const };
  const capabilities = selectionAttachmentCapabilities([vision, text], {
    repoAgent: selection,
    implementer: selection,
    reviewer: { modelId: "text-only", effort: "off" },
  });
  expect(capabilities.images).toBe(false);
  expect(capabilities.maxImages).toBe(0);
  expect(capabilities.textTotalBytes).toBe(2048);
  expect(capabilities.reason).toContain("does not support");
  const supported = selectionAttachmentCapabilities([vision], {
    repoAgent: selection,
    implementer: selection,
    reviewer: selection,
  });
  expect(supported.images).toBe(true);
  expect(supported.imageTotalBytes).toBeLessThanOrEqual(1048576);
});
it("fences frozen catalog mappings and capability metadata but excludes credential values", async () => {
  const { configureSelectedModels, validateFrozenModels } = await import("./model-selection");
  const env = {
    EXECUTION_MODE: "cloud",
    MODEL_CONFIGURATION:
      '{"provider":"byok","providerId":"openai","model":"gpt-6-sol","secretBinding":"TEST_KEY"}',
    TEST_KEY: "synthetic-one",
  };
  const catalog = resolveCatalog(env);
  const frozen = resolveRunModels(catalog);
  expect(frozen.catalogRevision).toMatch(/^[a-f0-9]{64}$/);
  const rotated = { ...env, TEST_KEY: "synthetic-two" };
  expect(resolveCatalog(rotated).revision).toBe(catalog.revision);
  const changed = {
    ...env,
    MODEL_CONFIGURATION:
      '{"provider":"byok","providerId":"openai","model":"gpt-6-astra","secretBinding":"TEST_KEY"}',
  };
  expect(() => configureSelectedModels(changed, frozen.repoAgent, frozen.catalogRevision)).toThrow(
    "model_configuration_changed",
  );
  expect(() => validateFrozenModels(changed, frozen)).toThrow("model_configuration_changed");
  expect(() => resolveCatalog({ EXECUTION_MODE: "cloud" })).toThrow("model_not_configured");
});
