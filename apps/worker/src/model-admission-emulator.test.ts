import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
it("native worker/reviewer DO startup and restart honor admitted alternate model and effort before RPC", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/model-admission-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "node-path",
        setup(build) {
          build.onResolve({ filter: /^path$/ }, () => ({
            path: "path",
            namespace: "node-builtins",
          }));
          build.onLoad({ filter: /.*/, namespace: "node-builtins" }, () => ({
            contents: "export * from 'node:path';",
          }));
        },
      },
    ],
  });
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ENVIRONMENT: "development",
      EXECUTION_MODE: "cloud",
      INFRASTRUCTURE_ADMISSION_ENABLED: "true",
      TEST_ADMISSION_DEADLINE: String(Date.now() + 120000),
      MODEL_CONFIGURATION: '{"provider":"fake"}',
      MODELS_CONFIGURATION:
        '[{"id":"alternate","configuration":{"provider":"byok","providerId":"openai","model":"gpt-6-sol","secretBinding":"SYNTHETIC_KEY"}}]',
      SYNTHETIC_KEY: "synthetic-invalid-never-called",
    },
    durableObjects: {
      CHANGE: { className: "ModelChangeFixture", useSQLite: true },
      REVIEW: { className: "ModelReviewFixture", useSQLite: true },
    },
    resourcePersistencePath: `/tmp/pitcrew-model-admission-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  try {
    const change = (await (await mf.dispatchFetch("http://fixture/change")).json()) as any;
    expect(change.model).toEqual({ provider: "openai", modelId: "gpt-6-sol" });
    expect(change.thinkingLevel).toBe("high");
    const review = (await (await mf.dispatchFetch("http://fixture/review")).json()) as any;
    expect(review.model).toEqual({ provider: "openai", modelId: "gpt-6-sol" });
    expect(review.thinkingLevel).toBe("low");
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// restart fixture" }),
    );
    const resumed = (await (await mf.dispatchFetch("http://fixture/change")).json()) as any;
    expect(resumed.model).toEqual(change.model);
    expect(resumed.thinkingLevel).toBe("high");
  } finally {
    await mf.dispose();
  }
});
