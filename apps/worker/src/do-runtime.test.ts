import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
it("resumes actual PiHarness and lifecycle pipeline on local DO SQLite after restart before publication", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/runtime-worker.ts", import.meta.url).pathname],
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
  const script = bundle.outputFiles[0].text;
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { PAUSE_STAGE: "publish" },
    durableObjects: { FIXTURE: { className: "FixtureAgent", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-do-runtime-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  try {
    expect((await mf.dispatchFetch("http://fixture/start")).status).toBe(200);
    let status: {
      pipeline?: { stage: string; result?: { candidateSha: string } };
      edits: { calls: number }[];
    } = { edits: [] };
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      status = (await (await mf.dispatchFetch("http://fixture/status")).json()) as typeof status;
      if (status.pipeline?.stage === "publish" || status.pipeline?.stage === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.pipeline?.stage).toBe("publish");
    expect(status.edits).toMatchObject([{ calls: 1 }]);
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: {},
        script: script + "\n// force runtime reload",
      }),
    );
    let recovered = status;
    const recoveryDeadline = Date.now() + 15000;
    while (Date.now() < recoveryDeadline) {
      recovered = (await (await mf.dispatchFetch("http://fixture/status")).json()) as typeof status;
      if (recovered.pipeline?.stage === "done" || recovered.pipeline?.stage === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(recovered.pipeline?.stage).toBe("done");
    expect(recovered.edits).toMatchObject([{ calls: 1 }]);
    await mf.dispatchFetch("http://fixture/start");
    const replay = (await (
      await mf.dispatchFetch("http://fixture/status")
    ).json()) as typeof status;
    expect(replay.edits).toMatchObject([{ calls: 1 }]);
  } finally {
    await mf.dispose();
  }
}, 20000);
