import { RepositoryAgent } from "../src/index";
import { api } from "../src/api";
import { sqliteAdmission } from "../src/infrastructure-admission";
import type {
  PublisherInput,
  PublisherLandingInput,
  PublisherIdentity,
} from "../../../packages/execution/src/trusted-publisher";
const base = "a".repeat(40),
  candidate = "b".repeat(40),
  actor = "fixture-owner";
export class ArtifactLandingFixture extends RepositoryAgent {
  private currentFork = "";
  private landMode = "landed";
  private requestActor = actor;
  private reconciliations = 0;
  private metadataAction = "";
  constructor(ctx: DurableObjectState, original: ConstructorParameters<typeof RepositoryAgent>[1]) {
    const env = { ...original };
    super(ctx, env);
    const info = (name: string): ArtifactsRepoInfo => ({
      id: name === "source" ? "source-metadata-id" : "fork-metadata-id",
      name,
      defaultBranch: "main",
      readOnly: false,
      source: name === "source" ? null : "artifacts:namespace/source",
      remote: `https://fixture.artifacts.cloudflare.net/git/namespace/${name}.git`,
      description: null,
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      lastPushAt: null,
    });
    env.ARTIFACTS = {
      get: async (name: string) => ({
        [Symbol.dispose]() {},
        info: async () => {
          if (this.metadataAction === "revoke") {
            this.metadataAction = "";
            this.getCoordinator().updateCollaboration((state) => {
              delete state.collaboration!.projectMembers[actor];
            });
          }
          return info(name);
        },
        log: async () => [{ hash: this.head() }],
      }),
    } as unknown as Artifacts;
    const publisher = {
      publish: async (_input: PublisherInput) => ({
        status: "published",
        cleanupVerified: true,
        fingerprint: "fixture",
      }),
      publishedBundle: async () => ({ bundleBase64: "Zml4dHVyZQ==", bundleDigest: "d".repeat(64) }),
      cleanup: async () => this.landMode !== "cleanup-failure",
      reconcile: async () => {
        this.reconciliations++;
        return {
          cleanupVerified: this.landMode !== "cleanup-failure",
          candidatePresent: this.head() === candidate,
          head: this.head(),
          status: "uncertain",
        };
      },
      land: async (input: PublisherLandingInput) => {
        const { bundleBase64: _bundle, ...identity } = input;
        this.assertPublisherAdmission({ ...identity, kind: "land" });
        if (this.landMode !== "rejected")
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO fixture_artifact_head VALUES(1,?)",
            candidate,
          );
        if (this.landMode === "uncertain") throw Error("response_lost_after_write");
        return {
          status: this.landMode === "rejected" ? "rejected" : "landed",
          fingerprint: "fixture",
          cleanupVerified: this.landMode !== "cleanup-failure",
        };
      },
    };
    env.TRUSTED_PUBLISHER = {
      idFromName: (name: string) => name,
      get: () => publisher,
    } as unknown as typeof env.TRUSTED_PUBLISHER;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_artifact_head(id INTEGER PRIMARY KEY,sha TEXT NOT NULL)",
    );
  }
  private head() {
    return (
      this.ctx.storage.sql
        .exec<{ sha: string }>("SELECT sha FROM fixture_artifact_head WHERE id=1")
        .toArray()[0]?.sha ?? base
    );
  }
  async seed() {
    const core = this.getCoordinator(),
      thread = core.createThread("artifacts fixture", "thread", actor);
    core.updateCollaboration((state) => {
      const member = { actor, email: "fixture@example.com", role: "owner" as const };
      state.collaboration = {
        projectMembers: { [actor]: member },
        threadMembers: { [thread.id]: { [actor]: member } },
        invitations: {},
      };
    });
    const { run } = core.submit(thread.id, "change source", "message", actor);
    core.begin(run.id);
    const gate = sqliteAdmission(this.ctx.storage),
      admitted = gate.reserve(run.id, "f".repeat(64), true);
    if (!admitted.allowed) throw Error("seed_admission_failed");
    core.freezeArtifactAdmission(run.id, {
      sourceName: "source",
      sourceRepositoryId: "source-metadata-id",
      fingerprint: admitted.reservation.fingerprint,
      deadline: admitted.reservation.deadline,
    });
    const signed = await this.authorizePublisherCandidate(run.id, candidate, "d".repeat(64));
    this.currentFork = signed.artifactId;
    core.complete(run.id, {
      workerId: signed.artifactId,
      artifactId: signed.artifactId,
      baseSha: base,
      candidateSha: candidate,
      summary: "fixture",
      tests: {
        baseSha: base,
        candidateSha: candidate,
        configurationRevision: "fixture-v1",
        status: "passed",
        argv: ["fixture"],
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      },
      review: {
        baseSha: base,
        candidateSha: candidate,
        configurationRevision: "fixture-v1",
        decision: "approve",
        actor: "independent-reviewer",
        summary: "approved",
      },
    });
    gate.release(run.id, true);
    return {
      runId: run.id,
      expectedTargetSha: base,
      candidateSha: candidate,
      configurationRevision: "fixture-v1",
      idempotencyKey: "approval",
      artifactId: signed.artifactId,
    };
  }
  async route(path: string, body?: unknown) {
    const core = this.getCoordinator(),
      app = api(core, () => {}, this.landing(core, this.requestActor));
    const response = await app.request(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, body: await response.json() };
  }
  async setActor(value: string) {
    this.requestActor = value;
  }
  async expireApproval(id: string) {
    const sql = this.ctx.storage.sql;
    const [row] = sql
      .exec<{ record: string }>("SELECT record FROM landing_permissions WHERE id=?", id)
      .toArray();
    const record = JSON.parse(row.record);
    record.authorization.expiresAt = Date.now() - 1;
    sql.exec("UPDATE landing_permissions SET record=? WHERE id=?", JSON.stringify(record), id);
  }
  async mode(mode: string) {
    this.landMode = mode;
  }
  async revokeAtMetadata() {
    this.metadataAction = "revoke";
  }
  async conflict() {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO fixture_artifact_head VALUES(1,?)",
      "c".repeat(40),
    );
  }
  async snapshot() {
    return {
      project: this.getCoordinator().state.project,
      runs: this.getCoordinator().state.runs,
      active: sqliteAdmission(this.ctx.storage).active(),
      reconciliations: this.reconciliations,
      head: this.head(),
      artifactId: this.currentFork,
    };
  }
  async forgedCandidate() {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM repository_publisher_authority")
      .toArray();
    const { input } = JSON.parse(rows[0].value) as { input: PublisherIdentity };
    try {
      this.assertPublisherAdmission({ ...input, sourceRepositoryId: "other-project-id" });
      return false;
    } catch {
      return true;
    }
  }
}
export default {
  async fetch(
    request: Request,
    env: { REPOSITORY: DurableObjectNamespace<ArtifactLandingFixture> },
  ) {
    const url = new URL(request.url),
      stub = env.REPOSITORY.get(
        env.REPOSITORY.idFromName(url.searchParams.get("object") ?? "pitcrew"),
      );
    if (url.pathname === "/seed") return Response.json(await stub.seed());
    if (url.pathname === "/actor") {
      await stub.setActor(url.searchParams.get("value")!);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/expire") {
      await stub.expireApproval(url.searchParams.get("id")!);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/mode") {
      await stub.mode(url.searchParams.get("value")!);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/revoke") {
      await stub.revokeAtMetadata();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/conflict") {
      await stub.conflict();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/state") return Response.json(await stub.snapshot());
    if (url.pathname === "/forged")
      return Response.json({ rejected: await stub.forgedCandidate() });
    const body = request.method === "POST" ? await request.json() : undefined;
    return Response.json(await stub.route(url.pathname, body));
  },
};
