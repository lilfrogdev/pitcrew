import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
it("runs intake dispatch through actual RepositoryAgent SQLite, reload and protected HTTP", async () => {
  const bundle = await build({
    entryPoints: [new URL("./index.ts", import.meta.url).pathname],
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
      EXECUTION_MODE: "fake",
      FIXTURE_IDENTITY: "lilfrogdev",
    },
    durableObjects: { REPOSITORY: { className: "RepositoryAgent", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-intake-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const get = async (path: string) =>
    (await mf.dispatchFetch(`http://localhost/api${path}`)).json() as Promise<any>;
  const post = (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(body),
    });
  try {
    const report = {
      source: { system: "manual", id: "original" },
      occurredAt: "2026-10-03T00:00:00Z",
      content: "Retain this original",
    };
    expect((await post("/projects/pitcrew/reports", report)).status).toBe(201);
    const intake = await get("/projects/pitcrew/intake"),
      group = intake.groups[0];
    const body = {
      groupId: group.id,
      revision: group.revision,
      idempotencyKey: "once",
      profileRevision: intake.profile.revision,
      acceptance: {
        revision: "a1",
        criteria: [
          { id: "retain", text: "Original source stays traceable", checkIds: ["tests", "types"] },
        ],
      },
    };
    const response = await post("/projects/pitcrew/intake/dispatch", body);
    expect(response.status).toBe(201);
    const link = (await response.json()) as any;
    let evidence: any;
    for (let i = 0; i < 50; i++) {
      evidence = await get(`/runs/${link.runId}/evidence`);
      if (evidence.verification) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(evidence.verification.outcomes.every((o: any) => o.status === "blocked")).toBe(true);
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload intake" }),
    );
    expect(await (await post("/projects/pitcrew/intake/dispatch", body)).json()).toEqual(link);
    expect(await get(`/threads/${link.threadId}/runs`)).toHaveLength(1);
    expect((await get("/projects/pitcrew/intake")).groups[0].reports[0].source).toEqual(
      report.source,
    );
  } finally {
    await mf.dispose();
  }
}, 20000);
