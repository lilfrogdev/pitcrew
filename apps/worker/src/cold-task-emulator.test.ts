import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

it("cold native observations, Stop, denied grants and saved wake jobs never resume Pi; admitted work still can", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/cold-task-worker.ts", import.meta.url).pathname],
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
  let options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ENVIRONMENT: "production",
      EXECUTION_MODE: "cloud",
      INFRASTRUCTURE_ADMISSION_ENABLED: "true",
      MODEL_CONFIGURATION: '{"provider":"fake"}',
      CONFIGURATION_REVISION: "fixture",
    },
    durableObjects: {
      CHANGE: { className: "ColdChangeFixture", useSQLite: true },
      REVIEW: { className: "ColdReviewFixture", useSQLite: true },
    },
    resourcePersistencePath: `/tmp/pitcrew-cold-task-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const call = async (name: string, operation: string, extra = {}) =>
    (await (
      await mf.dispatchFetch("http://fixture/", {
        method: "POST",
        body: JSON.stringify({ name, operation, ...extra }),
      })
    ).json()) as any;
  let reloads = 0;
  const reload = async (bindings = {}) => {
    options = {
      ...options,
      script: bundle.outputFiles[0].text + `\n// reload ${++reloads}`,
      bindings: { ...options.bindings, ...bindings },
    };
    await mf.setOptions(convertV4MiniflareOptions(options));
  };
  const deadline = Date.now() + 600_000;
  try {
    await call("observed", "seed", { deadline, stage: "done" });
    await reload();
    expect((await call("observed", "result")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
      started: false,
    });
    expect((await call("observed", "ack")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
      started: false,
    });
    expect((await call("observed", "result")).result.acknowledged).toBe(true);
    // Positive exploit control: the same observation behind an async native RPC
    // activates the installed lifecycle and would resume the seeded task.
    await call("legacy-observed", "seed", { deadline, stage: "done" });
    await reload();
    expect((await call("legacy-observed", "legacy-result")).snapshot).toMatchObject({
      opens: 1,
      resumes: 1,
      effects: 1,
      started: true,
    });

    await call("paused", "seed", { deadline });
    await call("paused", "queue", { time: deadline });
    await reload();
    expect((await call("paused", "stop")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
      stopped: { run_id: "cold-run" },
    });
    await reload();
    expect((await call("paused", "fire")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });
    expect((await call("paused", "result")).result).toMatchObject({
      stage: "blocked",
      cleanupVerified: true,
    });
    expect(await call("paused", "direct")).toMatchObject({ error: "execution_disabled" });

    for (const [name, grant] of [
      ["expired", Date.now() - 1],
      ["missing", undefined],
    ] as const) {
      await call(name, "seed", { deadline: grant });
      await call(name, "queue", { time: deadline });
      await reload();
      expect((await call(name, "fire")).snapshot).toMatchObject({
        opens: 0,
        resumes: 0,
        effects: 0,
      });
      expect((await call(name, "result")).result.stage).toBe("blocked");
    }

    await call("disabled", "seed", { deadline });
    await call("disabled", "queue", { time: deadline });
    await reload({ INFRASTRUCTURE_ADMISSION_ENABLED: "false" });
    expect((await call("disabled", "fire")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });
    await reload({ INFRASTRUCTURE_ADMISSION_ENABLED: "true" });

    await call("execution-off", "seed", { deadline });
    await call("execution-off", "queue", { time: deadline });
    await reload({ EXECUTION_MODE: "disabled" });
    expect((await call("execution-off", "fire")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });
    await reload({ EXECUTION_MODE: "cloud" });

    await call("cleanup", "seed", { deadline, stage: "blocked", cleanup: true });
    await reload();
    expect((await call("cleanup", "stop")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
      started: true,
    });
    expect((await call("cleanup", "result")).result.cleanupVerified).toBe(false);

    await call("review", "seed", { deadline, reviewer: true });
    await reload();
    expect(await call("review", "abort", { reviewer: true })).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
      started: false,
      stopped: { run_id: "cold-run" },
    });
    await reload();
    expect(await call("review", "awaken", { reviewer: true })).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });

    await call("allowed", "seed", { deadline, stage: "done" });
    await reload();
    expect((await call("allowed", "rebind")).result).toBe(deadline);
    expect((await call("allowed", "awaken")).snapshot).toMatchObject({
      opens: 1,
      resumes: 1,
      effects: 1,
    });
    await call("allowed", "queue", { time: deadline });
    await call("allowed", "expire");
    expect((await call("allowed", "fire")).snapshot).toMatchObject({
      opens: 1,
      resumes: 1,
      effects: 1,
      closes: 1,
    });
    await reload();
    expect((await call("allowed", "awaken")).snapshot).toMatchObject({
      opens: 1,
      resumes: 1,
      effects: 1,
    });

    await call("cross-root", "seed", { deadline, stage: "done", crossRoot: true });
    expect((await call("cross-root", "awaken")).snapshot).toMatchObject({
      opens: 1,
      resumes: 0,
      effects: 0,
      closes: 1,
    });

    await call("held", "seed", { deadline, stage: "done" });
    expect((await call("held", "held")).result).toEqual([
      "execution_disabled",
      "execution_disabled",
    ]);

    // A lost start acknowledgement may leave an admitted harness without a pipeline.
    // Stop still closes it and persists denial, while the caller retains its cleanup slot.
    await call("unstarted", "seed", { deadline, withoutPipeline: true });
    expect((await call("unstarted", "awaken")).snapshot).toMatchObject({ resumes: 1 });
    expect(await call("unstarted", "stop")).toMatchObject({ error: "not_found" });
    expect((await call("unstarted", "inspect")).snapshot).toMatchObject({
      closes: 1,
      stopped: { run_id: "cold-run" },
    });
    await reload();
    expect((await call("unstarted", "awaken")).snapshot).toMatchObject({
      opens: 1,
      resumes: 1,
      effects: 1,
    });
  } finally {
    await mf.dispose();
  }
}, 30_000);
