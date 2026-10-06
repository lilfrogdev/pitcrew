import { expect, it, vi } from "vite-plus/test";
import { resolveCatalog, resolveDisplayCatalog, configureSelectedModels } from "./model-selection";
import { providerModelsRequest } from "./provider-models";
const configuration =
  '{"provider":"byok","providerId":"openrouter","model":"qwen/qwen3.8-flash","secretBinding":"PRIVATE_BINDING"}';
it("publishes display metadata without reading credentials or relaxing execution catalog fences", () => {
  const read = vi.fn(() => {
    throw Error("must_not_read_key");
  });
  const env = {
    EXECUTION_MODE: "disabled",
    MODEL_CONFIGURATION: configuration,
    openRouterKey: read,
  };
  const catalog = resolveDisplayCatalog(env);
  expect(catalog.choices[0].provider).toBe("openrouter");
  expect(catalog.defaultSelection).toEqual({ modelId: "default", effort: "off" });
  expect(Object.keys(catalog).sort()).toEqual(["choices", "defaultSelection", "revision"]);
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE_BINDING");
  expect(read).not.toHaveBeenCalled();
  expect(() => resolveCatalog(env)).toThrow("model_not_enabled");
  expect(() => configureSelectedModels(env)).toThrow("model_not_enabled");
});
it("uses only the initiating user's stored-record boolean and exposes a GET-only, private catalog", async () => {
  const read = vi.fn(() => {
    throw Error("must_not_read_key");
  });
  const calls: string[] = [];
  const env = {
    EXECUTION_MODE: "disabled",
    MODEL_CONFIGURATION: configuration,
    CREDENTIAL_ENCRYPTION_KEY: btoa("a".repeat(32)),
    USER_CREDENTIALS: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        present: async (actor: string) => {
          calls.push(id + "/" + actor);
          return actor === "access:owner";
        },
        read,
      }),
    },
  } as unknown as Parameters<typeof providerModelsRequest>[1];
  const url = "https://fixture.test/api/provider-connection/openrouter/models";
  const owner = await providerModelsRequest(new Request(url), env, "access:owner");
  expect(owner.status).toBe(200);
  expect(owner.headers.get("cache-control")).toBe("private, no-store");
  expect(await owner.json()).toMatchObject({
    executionEnabled: false,
    models: [{ provider: "openrouter" }],
  });
  expect(await (await providerModelsRequest(new Request(url), env, "access:bryan")).json()).toEqual(
    { models: [], executionEnabled: false },
  );
  expect(calls).toEqual([
    "openrouter:access:owner/access:owner",
    "openrouter:access:bryan/access:bryan",
  ]);
  expect(read).not.toHaveBeenCalled();
  expect(
    (await providerModelsRequest(new Request(url, { method: "POST" }), env, "access:owner")).status,
  ).toBe(405);
  expect(
    (await providerModelsRequest(new Request(url + "?owner=other"), env, "access:owner")).status,
  ).toBe(400);
  expect(calls).toHaveLength(2);
});
