import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { assertArtifactSource, assertCandidateArtifact } from "./cloud-landing-api";
function info(name = "source"): ArtifactsRepoInfo {
  return {
    name,
    id: name === "source" ? "source-id" : "fork-id",
    remote: `https://fixture.artifacts.cloudflare.net/git/namespace/${name}.git`,
    defaultBranch: "main",
    readOnly: false,
    source: name === "source" ? null : "artifacts:namespace/source",
    description: null,
    createdAt: "",
    updatedAt: "",
    lastPushAt: null,
  };
}
it("pins directory names separately from metadata IDs and rejects cross-project forks and destinations", () => {
  const source = { name: "source", repositoryId: "source-id" };
  expect(() => assertArtifactSource(source, info())).not.toThrow();
  expect(() => assertArtifactSource({ ...source, repositoryId: "source" }, info())).toThrow(
    "ARTIFACT_SOURCE_MISMATCH",
  );
  expect(() => assertCandidateArtifact(source, info(), "fork", info("fork"))).not.toThrow();
  for (const invalid of [
    { ...info("fork"), source: "artifacts:namespace/another-project" },
    { ...info("fork"), id: "source-id" },
    { ...info("fork"), remote: "https://fixture.artifacts.cloudflare.net/git/other/fork.git" },
  ])
    expect(() => assertCandidateArtifact(source, info(), "fork", invalid)).toThrow(
      "CANDIDATE_ARTIFACT_MISMATCH",
    );
});
it("lands verified Artifacts evidence, holds uncertain cleanup, reconciles lost responses and fences revocation across metadata awaits", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/artifact-landing-worker.ts", import.meta.url).pathname],
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
        ENVIRONMENT: "production",
        EXECUTION_MODE: "cloud",
        LANDING_MODE: "artifacts",
        TRUSTED_PUBLISHER_ENABLED: "true",
        TRUSTED_PUBLISHER_AUTH_KEY: "fixture-key-not-a-secret-at-least-32-bytes",
        INFRASTRUCTURE_ADMISSION_ENABLED: "true",
        ARTIFACTS_CAS_CONFORMANCE_VERIFIED: "true",
        PROJECT_BASE_SHA: "a".repeat(40),
        CONFIGURATION_REVISION: "fixture-v1",
        ARTIFACT_REPOSITORY: "source",
        ARTIFACT_REPOSITORY_ID: "source-metadata-id",
      },
      durableObjects: { REPOSITORY: { className: "ArtifactLandingFixture", useSQLite: true } },
      resourcePersistencePath: `/tmp/artifact-landing-integration-${crypto.randomUUID()}`,
    }),
  );
  const get = async (path: string, object: string) =>
    (
      await mf.dispatchFetch(
        `http://localhost${path}${path.includes("?") ? "&" : "?"}object=${object}`,
      )
    ).json() as Promise<any>;
  const post = async (path: string, body: unknown, object: string) =>
    (
      await mf.dispatchFetch(`http://localhost${path}?object=${object}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json() as Promise<any>;
  try {
    const normal = await get("/seed", "normal"),
      path = `/api/runs/${normal.runId}`;
    expect(await get("/forged", "normal")).toEqual({ rejected: true });
    const approval = await post(
      `${path}/merge-approval`,
      { ...normal, sourceId: "browser-forged", actor: "browser-forged" },
      "normal",
    );
    expect(approval).toMatchObject({
      status: 201,
      body: { backend: "artifacts", state: "authorized" },
    });
    const landed = await post(
      `${path}/landing`,
      { authorizationId: approval.body.authorizationId },
      "normal",
    );
    expect(landed).toMatchObject({
      status: 200,
      body: { status: "landed", backend: "artifacts", landedSha: normal.candidateSha },
    });
    expect(
      await post(`${path}/landing`, { authorizationId: approval.body.authorizationId }, "normal"),
    ).toEqual(landed);
    expect(await get("/state", "normal")).toMatchObject({
      active: [],
      project: { baseSha: normal.candidateSha },
      runs: [{ status: "completed", landing: { backend: "artifacts" } }],
    });
    for (const mode of ["uncertain", "cleanup-failure"]) {
      const run = await get("/seed", mode),
        runPath = `/api/runs/${run.runId}`;
      const permitted = await post(`${runPath}/merge-approval`, run, mode);
      await get(`/mode?value=${mode}`, mode);
      expect(
        await post(`${runPath}/landing`, { authorizationId: permitted.body.authorizationId }, mode),
      ).toMatchObject({ body: { status: "uncertain" } });
      expect(await get("/state", mode)).toMatchObject({
        project: { baseSha: run.expectedTargetSha },
        runs: [{ status: "awaiting_review" }],
      });
      if (mode === "cleanup-failure") {
        expect((await get("/state", mode)).active).toHaveLength(1);
        expect(await post("/api/projects/pitcrew/verification-profile", { expectedRevision: "poc-checks-v1",
          profile: { projectId: "pitcrew", revision: "changed-profile", checks: [{ id: "whitespace", kind: "command",
            command: { argv: ["git", "diff", "--check"], timeoutMs: 1000, maxOutputBytes: 1024 } }] } }, mode))
          .toMatchObject({ status: 409, body: { error: "REPOSITORY_LANDING_BUSY" } });
        await get("/actor?value=other-actor", mode);
        expect(await post(`${runPath}/landing/reconcile`, { authorizationId: permitted.body.authorizationId }, mode))
          .toMatchObject({ status: 409, body: { error: "AUTHORIZATION_NOT_FOUND" } });
        expect(await get("/state", mode)).toMatchObject({ reconciliations: 0 });
        expect((await get("/state", mode)).active).toHaveLength(1);
        await get("/actor?value=fixture-owner", mode);
        expect(await post(`/api/runs/another-run/landing/reconcile`, { authorizationId: permitted.body.authorizationId }, mode))
          .toMatchObject({ status: 409, body: { error: "AUTHORIZATION_NOT_FOUND" } });
        expect(await get("/state", mode)).toMatchObject({ reconciliations: 0 });
        expect(
          await post(
            `${runPath}/landing/reconcile`,
            { authorizationId: permitted.body.authorizationId },
            mode,
          ),
        ).toMatchObject({ body: { status: "uncertain", code: "PUBLISHER_CLEANUP_REQUIRED" } });
        await get("/mode?value=landed", mode);
      }
      expect(
        await post(
          `${runPath}/landing/reconcile`,
          { authorizationId: permitted.body.authorizationId },
          mode,
        ),
      ).toMatchObject({ body: { status: "landed" } });
      expect(await get("/state", mode)).toMatchObject({
        active: [],
        project: { baseSha: run.candidateSha },
        runs: [{ status: "completed" }],
      });
    }
    const revoked = await get("/seed", "revoked"),
      revokedPath = `/api/runs/${revoked.runId}`;
    const permitted = await post(`${revokedPath}/merge-approval`, revoked, "revoked");
    await get("/revoke", "revoked");
    expect(
      await post(
        `${revokedPath}/landing`,
        { authorizationId: permitted.body.authorizationId },
        "revoked",
      ),
    ).toMatchObject({ body: { status: "rejected" } });
    expect(await get("/state", "revoked")).toMatchObject({
      head: revoked.expectedTargetSha,
      project: { baseSha: revoked.expectedTargetSha },
    });
    const expired = await get("/seed", "expired"), expiredPath = `/api/runs/${expired.runId}`;
    const expiredApproval = await post(`${expiredPath}/merge-approval`, expired, "expired");
    await get(`/expire?id=${expiredApproval.body.authorizationId}`, "expired");
    expect(await post(`${expiredPath}/landing`, { authorizationId: expiredApproval.body.authorizationId }, "expired"))
      .toMatchObject({ status: 409, body: { error: "AUTHORIZATION_EXPIRED" } });
    expect(await get("/state", "expired")).toMatchObject({ active: [], head: expired.expectedTargetSha });
    const stale = await get("/seed", "stale"),
      stalePath = `/api/runs/${stale.runId}`;
    const staleApproval = await post(`${stalePath}/merge-approval`, stale, "stale");
    await get("/conflict", "stale");
    expect(
      await post(
        `${stalePath}/landing`,
        { authorizationId: staleApproval.body.authorizationId },
        "stale",
      ),
    ).toMatchObject({ body: { status: "rejected", code: "STALE_TARGET" } });
  } finally {
    await mf.dispose();
  }
}, 30000);
