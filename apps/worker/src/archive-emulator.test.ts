import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
it("persists archive and restore through actual RepositoryAgent SQLite restarts", async () => {
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
    resourcePersistencePath: `/tmp/pitcrew-archive-${crypto.randomUUID()}`,
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
    const created = await post("/projects/pitcrew/threads", {
      title: "Persist my archive",
      idempotencyKey: "create",
    });
    const thread = (await created.json()) as { id: string; archived: boolean };
    expect(thread.archived).toBe(false);
    await post(`/threads/${thread.id}/messages`, {
      content: "Retain transcript",
      idempotencyKey: "send",
    });
    const route = `/projects/pitcrew/threads/${thread.id}/archive`;
    expect((await post(route, { archived: true })).status).toBe(200);
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload archive" }),
    );
    expect(
      (await get("/projects/pitcrew/threads")).find((item: any) => item.id === thread.id).archived,
    ).toBe(true);
    expect(
      (await get(`/threads/${thread.id}/messages`)).some(
        (message: any) => message.content === "Retain transcript",
      ),
    ).toBe(true);
    expect(await get(`/threads/${thread.id}/changes`)).toHaveLength(1);
    expect(await get(`/threads/${thread.id}/runs`)).toHaveLength(1);
    expect((await post(route, { archived: true })).status).toBe(200);
    expect((await post(route, { archived: false })).status).toBe(200);
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload restore" }),
    );
    expect(
      (await get("/projects/pitcrew/threads")).find((item: any) => item.id === thread.id).archived,
    ).toBe(false);
  } finally {
    await mf.dispose();
  }
}, 20000);
