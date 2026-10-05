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

    // Expiry during the factory must still finish lifecycle startup so recovery
    // can record cleanup intent instead of failing before its capabilities start.
    await call("cross-open", "seed", { deadline, crossOpen: true });
    await call("cross-open", "queue", { time: deadline });
    expect((await call("cross-open", "awaken")).snapshot).toMatchObject({
      opens: 1,
      resumes: 0,
      effects: 0,
      closes: 1,
      started: true,
    });
    await call("cross-open", "fire");
    expect((await call("cross-open", "result")).result.stage).toBe("blocked");

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

    // Recover cleanup interrupted after its tombstone, assemble the pinned result,
    // and let the parent's retry-start-before-result protocol observe it after reload.
    await call("completed", "seed", {
      deadline,
      stage: "stop",
      allowCleanup: true,
      tombstone: true,
    });
    await call("completed", "queue", { time: deadline });
    await reload();
    expect((await call("completed", "fire")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });
    expect((await call("completed", "result")).result).toMatchObject({
      stage: "done",
      cleanupVerified: true,
      result: { summary: "pinned successful result", candidateSha: "b".repeat(40) },
    });
    await reload({
      INFRASTRUCTURE_ADMISSION_ENABLED: "false",
      EXECUTION_MODE: "disabled",
      CONFIGURATION_REVISION: "changed",
    });
    expect((await call("completed", "retry")).result).toMatchObject({ stage: "done" });
    expect((await call("completed", "retry")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });
    expect(await call("completed", "mismatch")).toMatchObject({ error: "idempotency_conflict" });
    expect((await call("completed", "result")).result.stage).toBe("done");
    await reload({
      INFRASTRUCTURE_ADMISSION_ENABLED: "true",
      EXECUTION_MODE: "cloud",
      CONFIGURATION_REVISION: "fixture",
    });

    await call("explicit-stop", "seed", { deadline, stage: "stop", allowCleanup: true });
    await call("explicit-stop", "queue", { time: deadline });
    await call("explicit-stop", "stop");
    await call("explicit-stop", "fire");
    expect((await call("explicit-stop", "result")).result).toMatchObject({
      stage: "blocked",
      cleanupVerified: true,
    });
    expect((await call("explicit-stop", "retry")).result.stage).toBe("blocked");

    await call("held-prepare", "seed", { deadline, allowCleanup: true });
    const preparing = call("held-prepare", "begin");
    let held = false;
    for (let i = 0; i < 50; i++) {
      held = (await call("held-prepare", "pending")).result;
      if (held) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(held).toBe(true);
    await call("held-prepare", "stop");
    expect((await call("held-prepare", "result")).result).toMatchObject({
      stage: "blocked",
      cleanupVerified: false,
    });
    expect((await call("held-prepare", "pending")).result).toBe(true);
    await call("held-prepare", "release");
    await preparing;
    expect((await call("held-prepare", "pending")).result).toBe(false);
    expect((await call("held-prepare", "result")).result).toMatchObject({
      stage: "blocked",
      cleanupVerified: true,
    });
    expect((await call("held-prepare", "inspect")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });

    // Unknown preparation ownership must survive Stop and a cold SQLite restart.
    await call("uncertain-prepare", "seed", { deadline, allowCleanup: true });
    await call("uncertain-prepare", "uncertain");
    await call("uncertain-prepare", "stop");
    await reload();
    expect((await call("uncertain-prepare", "result")).result).toMatchObject({
      stage: "blocked",
      error: "reconciliation_required",
      cleanupVerified: false,
    });
    expect((await call("uncertain-prepare", "inspect")).snapshot).toMatchObject({
      opens: 0,
      resumes: 0,
      effects: 0,
    });

    await call("legacy-uncertain", "seed", {
      deadline,
      stage: "blocked",
      uncertain: true,
      allowCleanup: true,
    });
    await call("legacy-uncertain", "stop");
    await reload();
    expect((await call("legacy-uncertain", "result")).result).toMatchObject({
      stage: "blocked",
      error: "reconciliation_required",
      cleanupVerified: false,
    });
  } finally {
    await mf.dispose();
  }
}, 30_000);
