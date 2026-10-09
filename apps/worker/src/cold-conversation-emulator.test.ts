import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

it("gates conversation recovery on the independent chat switch while coding switches stay disabled", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/cold-conversation-worker.ts", import.meta.url).pathname],
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
  const admitted = {
    ENVIRONMENT: "production",
    EXECUTION_MODE: "cloud",
    INFRASTRUCTURE_ADMISSION_ENABLED: "true",
    CLOUD_CONVERSATION_ENABLED: "true",
    MODEL_CONFIGURATION: '{"provider":"fake"}',
    CONFIGURATION_REVISION: "fixture",
  };
  let options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: admitted,
    durableObjects: { CONVERSATION: { className: "ColdConversationFixture", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-cold-conversation-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const call = async (name: string, operation: string, extra = {}) => {
    const response = await mf.dispatchFetch("http://fixture/", {
      method: "POST",
      body: JSON.stringify({ name, operation, ...extra }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  let reloads = 0;
  const reload = async (bindings = {}) => {
    options = {
      ...options,
      script: bundle.outputFiles[0].text + `\n// reload ${++reloads}`,
      bindings: { ...admitted, ...bindings },
    };
    await mf.setOptions(convertV4MiniflareOptions(options));
  };
  try {
    const observed = await call("observed", "seed");
    await reload();
    expect((await call("observed", "result", { turnId: observed.result })).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      started: false,
    });
    // Positive control: the real async RPC starts Pi and resumes pending tasks.
    expect((await call("observed", "awaken")).snapshot).toMatchObject({ opens: 1, resumes: 1 });
    // Chat remains admitted independently when sandbox/infrastructure execution is off.
    for (const [name, bindings] of [
      ["infra-off", { INFRASTRUCTURE_ADMISSION_ENABLED: "false" }],
      ["execution-off", { EXECUTION_MODE: "disabled" }],
    ] as const) {
      await reload();
      await call(name, "seed");
      await reload(bindings);
      expect((await call(name, "awaken")).snapshot).toMatchObject({ opens: 1, resumes: 1 });
    }
    for (const [name, bindings] of [
      ["conversation-off", { CLOUD_CONVERSATION_ENABLED: "false" }],
    ] as const) {
      await reload();
      await call(name, "seed");
      await call(name, "queue");
      await reload(bindings);
      expect((await call(name, "awaken")).snapshot).toMatchObject({ opens: 0, resumes: 0 });
      expect((await call(name, "fire")).snapshot).toMatchObject({ opens: 0, resumes: 0 });
      await call(`${name}-running`, "seed", { running: true });
      expect((await call(`${name}-running`, "start")).result).toEqual({
        status: "failed",
        error: "conversation_configuration_unavailable",
      });
      expect((await call(`${name}-running`, "awaken")).snapshot).toMatchObject({
        opens: 0,
        resumes: 0,
      });
    }
    for (const crossing of ["open", "root"]) {
      await reload();
      await call(crossing, "seed", { crossing });
      expect((await call(crossing, "awaken")).snapshot).toMatchObject({
        opens: 1,
        resumes: 0,
        closes: 1,
      });
    }
  } finally {
    await mf.dispose();
  }
}, 30000);
