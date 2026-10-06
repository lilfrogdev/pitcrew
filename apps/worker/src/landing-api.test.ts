import { localHeaders } from "../test/local-session";
import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { api } from "./api";
import { Coordinator, initialState } from "./coordinator";
it("returns explicit unconfigured landing capability and rejects malformed request bodies", async () => {
  const app = api(new Coordinator(initialState(), () => {}), () => {});
  expect(await (await app.request("/api/capabilities")).json()).toEqual({
    landing: { enabled: false, backend: null },
  });
  expect(
    (
      await app.request("/api/runs/missing/merge-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await app.request("/api/runs/missing/landing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      })
    ).status,
  ).toBe(400);
});
it("runs production repository routes with trusted evidence, one-use SQLite approval and config gate in a local fake backend", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/landing-worker.ts", import.meta.url).pathname],
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
  const mf = new Miniflare(
    convertV4MiniflareOptions({
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
        LANDING_MODE: "fixture",
      },
      durableObjects: { REPOSITORY: { className: "LandingFixtureAgent", useSQLite: true } },
      resourcePersistencePath: `/tmp/pitcrew-landing-runtime-${crypto.randomUUID()}`,
    }),
  );
  const post = async (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost${path}`, {
      method: "POST",
      headers: await localHeaders(mf),
      body: JSON.stringify(body),
    });
  try {
    const input = (await (await mf.dispatchFetch("http://localhost/__seed")).json()) as {
      runId: string;
      expectedTargetSha: string;
      candidateSha: string;
      configurationRevision: string;
      idempotencyKey: string;
    };
    const runPath = `/api/runs/${input.runId}`;
    expect((await mf.dispatchFetch("http://remote.example/api/projects")).status).toBe(403);
    expect(await (await mf.dispatchFetch("http://localhost/api/capabilities")).json()).toEqual({
      landing: { enabled: true, backend: "fixture" },
    });
    expect(
      (await post(`${runPath}/merge-approval`, { ...input, candidateSha: "c".repeat(40) })).status,
    ).toBe(409);
    const response = await post(`${runPath}/merge-approval`, {
      ...input,
      actor: "forged-browser-actor",
      artifactId: "forged-fork",
    });
    expect(response.status).toBe(201);
    const authorization = (await response.json()) as {
      authorizationId: string;
      state: string;
      actor?: string;
      backend: string;
      expiresAt: number;
    };
    expect(authorization).toMatchObject({ state: "authorized", backend: "fixture" });
    expect(authorization.actor).toBeUndefined();
    expect(authorization.expiresAt).toBeGreaterThan(Date.now());
    expect(
      (await post("/api/runs/wrong/landing", { authorizationId: authorization.authorizationId }))
        .status,
    ).toBe(404);
    const landed = await (
      await post(`${runPath}/landing`, {
        authorizationId: authorization.authorizationId,
        actor: "forged",
      })
    ).json();
    expect(landed).toMatchObject({
      status: "landed",
      landedSha: input.candidateSha,
      backend: "fixture",
    });
    expect(
      await (
        await post(`${runPath}/landing`, { authorizationId: authorization.authorizationId })
      ).json(),
    ).toEqual(landed);
    const projectsAfter = (await (
      await mf.dispatchFetch("http://localhost/api/projects")
    ).json()) as { baseSha: string }[];
    expect(projectsAfter[0].baseSha).toBe(input.candidateSha);
    const runsAfter = (await (
      await mf.dispatchFetch(`http://localhost/api/runs/${input.runId}/evidence`)
    ).json()) as { run: { status: string; landing: { backend: string } } };
    expect(runsAfter.run).toMatchObject({ status: "completed", landing: { backend: "fixture" } });
    const threadResponse = await post("/api/projects/pitcrew/threads", {
      title: "second change",
      idempotencyKey: "second-thread",
    });
    const thread = (await threadResponse.json()) as { id: string };
    const second = (await (
      await post(`/api/threads/${thread.id}/messages`, {
        content: "next fixture change",
        idempotencyKey: "second-message",
      })
    ).json()) as { run: { baseSha: string } };
    expect(second.run.baseSha).toBe(input.candidateSha);
    const replay = (await (
      await post(`${runPath}/merge-approval`, input)
    ).json()) as typeof authorization;
    expect(replay.authorizationId).toBe(authorization.authorizationId);
    expect(replay.state).toBe("landed");
    expect(
      (await post(`${runPath}/merge-approval`, { ...input, candidateSha: "c".repeat(40) })).status,
    ).toBe(409);
    // A separate object retains a pending gate and blocks a configuration write
    // within the same storage transaction. No task/model/container is involved.
    const secondInput = (await (
      await mf.dispatchFetch("http://localhost/__seed?object=gate")
    ).json()) as typeof input;
    const blockedApproval = await post(
      `/api/runs/${secondInput.runId}/merge-approval?object=gate`,
      { ...secondInput, idempotencyKey: "gate" },
    );
    expect(blockedApproval.status).toBe(201);
    const permission = (await blockedApproval.json()) as typeof authorization;
    expect(
      await (
        await post("/__block-config?object=gate", {
          authorizationId: permission.authorizationId,
          runId: secondInput.runId,
        })
      ).json(),
    ).toEqual({ blocked: true });
    const projects = (await (
      await mf.dispatchFetch("http://localhost/api/projects?object=gate")
    ).json()) as { configurationRevision: string }[];
    expect(projects[0].configurationRevision).toBe(secondInput.configurationRevision);
    const pending = (await (
      await post(`/api/runs/${secondInput.runId}/merge-approval?object=gate`, {
        ...secondInput,
        idempotencyKey: "gate",
      })
    ).json()) as typeof authorization;
    expect(pending).toMatchObject({
      authorizationId: permission.authorizationId,
      state: "pending",
    });
    expect(
      await (
        await post(`/api/runs/${secondInput.runId}/landing?object=gate`, {
          authorizationId: permission.authorizationId,
        })
      ).json(),
    ).toMatchObject({ status: "uncertain", code: "RECONCILIATION_REQUIRED", backend: "fixture" });
  } finally {
    await mf.dispose();
  }
}, 20000);
