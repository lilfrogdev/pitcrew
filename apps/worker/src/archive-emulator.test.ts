import { localHeaders } from "../test/local-session";
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
  const post = async (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: await localHeaders(mf),
      body: JSON.stringify(body),
    });
  try {
    const baseline = await get("/projects/pitcrew/intake");
    const knowledge = {
      idempotencyKey: "admission-knowledge",
      mutation: {
        id: "admission-knowledge",
        expectedVersion: 0,
        status: "accepted",
        kind: "constraint",
        text: "Explicit owner guidance",
        reason: "Owner decision",
        sourceRefs: [{ kind: "code", id: "source", revision: "base", path: "package.json" }],
      },
    };
    const profile = {
      profile: { ...baseline.profile, revision: "owner-profile" },
      expectedRevision: baseline.profile.revision,
    };
    for (const [path, body] of [
      ["verification-profile", profile],
      ["knowledge", knowledge],
    ] as const) {
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/json"]) {
        const response = await mf.dispatchFetch(`http://localhost/api/projects/pitcrew/${path}`, {
          method: "POST",
          headers: { Origin: "https://attacker.example", "Content-Type": type },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(403);
      }
    }
    expect((await get("/projects/pitcrew/intake")).profile).toEqual(baseline.profile);
    expect(
      (await get("/projects/pitcrew/context")).acceptedDecisions.some(
        (entry: any) => entry.id === knowledge.mutation.id,
      ),
    ).toBe(false);
    const trusted = await localHeaders(mf);
    const withoutCapability = await mf.dispatchFetch(
      "http://localhost/api/projects/pitcrew/knowledge",
      {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify(knowledge),
      },
    );
    expect(withoutCapability.status).toBe(403);
    for (const [path, body, status] of [
      ["verification-profile", profile, 200],
      ["knowledge", knowledge, 201],
    ] as const) {
      const response = await mf.dispatchFetch(`http://localhost/api/projects/pitcrew/${path}`, {
        method: "POST",
        headers: { ...trusted, Origin: "http://localhost:5173" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
    }
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
    expect((await get("/projects/pitcrew/intake")).profile.revision).toBe("owner-profile");
    expect(
      (await get("/projects/pitcrew/context")).acceptedDecisions.some(
        (entry: any) => entry.id === knowledge.mutation.id,
      ),
    ).toBe(true);
    expect(
      (await get("/projects/pitcrew/threads")).find((item: any) => item.id === thread.id).archived,
    ).toBe(true);
    expect(
      (await get(`/threads/${thread.id}/messages`)).some(
        (message: any) => message.content === "Retain transcript",
      ),
    ).toBe(true);
    expect(await get(`/threads/${thread.id}/changes`)).toHaveLength(0);
    expect(await get(`/threads/${thread.id}/runs`)).toHaveLength(0);
    expect((await post(route, { archived: true })).status).toBe(200);
    expect((await post(route, { archived: false })).status).toBe(200);
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload restore" }),
    );
    expect((await get("/projects/pitcrew/intake")).profile.revision).toBe("owner-profile");
    expect(
      (await get("/projects/pitcrew/context")).acceptedDecisions.some(
        (entry: any) => entry.id === knowledge.mutation.id,
      ),
    ).toBe(true);
    expect(
      (await get("/projects/pitcrew/threads")).find((item: any) => item.id === thread.id).archived,
    ).toBe(false);
  } finally {
    await mf.dispose();
  }
}, 20000);
