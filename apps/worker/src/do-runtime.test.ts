import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
async function fixtureOptions(bindings: Record<string, string>) {
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
    bindings,
    durableObjects: { FIXTURE: { className: "FixtureAgent", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-do-runtime-${crypto.randomUUID()}`,
  };
  return options;
}
interface Status {
  pipeline?: {
    stage: string;
    result?: { candidateSha: string };
    resultAcknowledged?: boolean;
    cleanupPending?: boolean;
    stopRequested?: boolean;
    review?: unknown;
  };
  edits: { calls: number }[];
  stops: { calls: number }[];
}
async function waitFor(mf: Miniflare, predicate: (status: Status) => boolean) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = (await (await mf.dispatchFetch("http://fixture/status")).json()) as Status;
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("fixture_timeout");
}
it("resumes actual PiHarness and lifecycle pipeline on local DO SQLite after restart before publication", async () => {
  const options = await fixtureOptions({ PAUSE_STAGE: "publish" });
  const script = options.script;
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
    const pending = (await (await mf.dispatchFetch("http://fixture/status")).json()) as Status;
    expect(pending.pipeline?.resultAcknowledged).not.toBe(true);
    expect(pending.pipeline?.result?.candidateSha).toBe("b".repeat(40));
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: {},
        script: script + "\n// delivery interrupted",
      }),
    );
    const resumed = await waitFor(mf, (status) => status.pipeline?.stage === "done");
    expect(resumed.pipeline?.resultAcknowledged).not.toBe(true);
    expect(resumed.pipeline?.result).toEqual(pending.pipeline?.result);
    expect((await mf.dispatchFetch("http://fixture/acknowledge")).status).toBe(200);
    expect((await mf.dispatchFetch("http://fixture/acknowledge")).status).toBe(200);
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: {},
        script: script + "\n// acknowledged restart",
      }),
    );
    const acknowledged = await waitFor(
      mf,
      (status) => status.pipeline?.resultAcknowledged === true,
    );
    expect(acknowledged.pipeline?.result).toEqual(pending.pipeline?.result);
    expect(acknowledged.edits).toMatchObject([{ calls: 1 }]);
  } finally {
    await mf.dispose();
  }
}, 20000);

it("persists Stop and retries only failed cleanup across repeated local SQLite restarts", async () => {
  const options = await fixtureOptions({
    PAUSE_STAGE: "publish",
    FAIL_STOP_ONCE: "1",
    PAUSE_CLEANUP: "1",
  });
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  try {
    await mf.dispatchFetch("http://fixture/start");
    const paused = await waitFor(mf, (status) => status.pipeline?.stage === "publish");
    expect(paused.edits).toMatchObject([{ calls: 1 }]);
    await mf.dispatchFetch("http://fixture/stop");
    const pending = await waitFor(
      mf,
      (status) => status.pipeline?.cleanupPending === true && status.stops[0]?.calls === 1,
    );
    expect(pending.pipeline).toMatchObject({ stage: "blocked", stopRequested: true });
    expect(pending.pipeline?.result).toBeUndefined();
    for (let restart = 1; restart <= 2; restart++) {
      await mf.setOptions(
        convertV4MiniflareOptions({
          ...options,
          script: options.script + `\n// cleanup restart ${restart}`,
        }),
      );
      const recovered = await waitFor(mf, (status) => status.pipeline?.stopRequested === true);
      expect(recovered.pipeline?.cleanupPending).toBe(true);
      expect(recovered.stops).toMatchObject([{ calls: 1 }]);
      expect(recovered.edits).toMatchObject([{ calls: 1 }]);
    }
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: { FAIL_STOP_ONCE: "1" },
        script: options.script + "\n// cleanup released",
      }),
    );
    const cleaned = await waitFor(mf, (status) => status.pipeline?.cleanupPending === false);
    expect(cleaned.pipeline).toMatchObject({ stage: "blocked", stopRequested: true });
    expect(cleaned.pipeline?.result).toBeUndefined();
    expect(cleaned.pipeline?.review).toBeUndefined();
    expect(cleaned.stops).toMatchObject([{ calls: 2 }]);
    expect(cleaned.edits).toMatchObject([{ calls: 1 }]);
    await mf.dispatchFetch("http://fixture/start");
    await mf.dispatchFetch("http://fixture/stop");
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: {},
        script: options.script + "\n// stopped terminal restart",
      }),
    );
    const terminal = await waitFor(mf, (status) => status.pipeline?.stopRequested === true);
    expect(terminal.pipeline?.cleanupPending).toBe(false);
    expect(terminal.stops).toMatchObject([{ calls: 2 }]);
    expect(terminal.edits).toMatchObject([{ calls: 1 }]);
  } finally {
    await mf.dispose();
  }
}, 30000);
