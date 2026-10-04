import { SqliteLandingStore } from "../../../packages/execution/src/landing-store";
import { fixtureLandingApi, assertConfigurationIdle, type LandingApi } from "./landing-api";
import { cloudInitialState } from "./cloud-configuration";
import { principal, protectedFetch, type AccessEnv } from "./access";
import { Agent } from "agents";
import { ChangeAgent, ReviewAgent, type PiEnv } from "./pi-agents";
export { ChangeAgent, ReviewAgent };
import { DurableJobs } from "./durable-jobs";
import { api } from "./api";
import { Coordinator, fakeExecution, initialState, type State } from "./coordinator";
interface Env extends PiEnv, AccessEnv {
  ASSETS?: Fetcher;
  PROJECT_BASE_SHA?: string;
  CHANGE: DurableObjectNamespace<ChangeAgent>;
  ARTIFACT_REPOSITORY?: string;
  REPOSITORY: DurableObjectNamespace<RepositoryAgent>;
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  LANDING_MODE?: string;
  EXECUTION_MODE: string;
}
export class RepositoryAgent extends Agent<Env> {
  private coordinator?: Coordinator;
  private landingStore?: SqliteLandingStore;
  private getLandingStore() {
    return (this.landingStore ??= new SqliteLandingStore(this.ctx.storage));
  }
  private landing(core: Coordinator): LandingApi | undefined {
    if (
      this.env.ENVIRONMENT !== "development" ||
      this.env.LANDING_MODE !== "fixture" ||
      this.env.FIXTURE_IDENTITY !== "lilfrogdev"
    )
      return;
    void this
      .sql`CREATE TABLE IF NOT EXISTS fixture_target(id INTEGER PRIMARY KEY,sha TEXT NOT NULL)`;
    void this.sql`INSERT OR IGNORE INTO fixture_target VALUES(1,${core.state.project.baseSha})`;
    return fixtureLandingApi(
      core,
      this.getLandingStore(),
      {
        targetHead: async () =>
          this.sql<{ sha: string }>`SELECT sha FROM fixture_target WHERE id=1`[0].sha,
        land: async (authorization) =>
          this.ctx.storage.transactionSync(() => {
            const [target] = this.sql<{ sha: string }>`SELECT sha FROM fixture_target WHERE id=1`;
            if (target.sha !== authorization.expectedTargetSha)
              return { status: "rejected", code: "STALE_TARGET" };
            void this.sql`UPDATE fixture_target SET sha=${authorization.candidateSha} WHERE id=1`;
            return { status: "landed" };
          }),
      },
      this.env.FIXTURE_IDENTITY,
    );
  }
  private readonly jobs: DurableJobs;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.jobs = new DurableJobs(
      "repository-results",
      async (jobs) => {
        if (this.env.EXECUTION_MODE !== "cloud") return;
        const core = this.getCoordinator();
        for (const run of core.state.runs)
          if (["queued", "running", "awaiting_review"].includes(run.status))
            await jobs.enqueue(run.id, { runId: run.id });
      },
      async (payload) => {
        const runId = (payload as { runId: string }).runId,
          core = this.getCoordinator();
        const run = core.evidence(runId).run;
        const input =
          core.begin(runId) ??
          (run.status === "awaiting_review" ? core.state.requests?.[runId] : undefined);
        if (!input) return;
        if (!this.env.ARTIFACT_REPOSITORY || !this.env.MODEL_CONFIGURATION) {
          core.fail(runId, true);
          return;
        }
        try {
          const worker = this.env.CHANGE.get(
            this.env.CHANGE.idFromName(`change:${input.projectId}:${input.runId}`),
          );
          const admission = await worker.start({
            ...input,
            repository: this.env.ARTIFACT_REPOSITORY,
          });
          if (
            admission.stage === "blocked" &&
            "error" in admission &&
            admission.error === "reconciliation_required"
          ) {
            core.fail(runId, true);
            return;
          }
          const receipt = await worker.result(runId);
          if (receipt.stage === "done" && receipt.result) {
            await core.completeVerified(runId, receipt.result);
            await worker.acknowledge(runId);
            return;
          }
          if (receipt.stage === "blocked") {
            core.fail(runId, receipt.error === "reconciliation_required");
            return;
          }
          return { rescheduleAt: Date.now() + 1000 };
        } catch {
          // A transport/storage error is not acknowledgement or supersession.
          // Unsafe effects are quarantined by the child journal, not replayed here.
          return { rescheduleAt: Date.now() + 1000 };
        }
      },
    );
    this.lifecycle.use(this.jobs);
  }

  private getCoordinator() {
    if (this.coordinator) return this.coordinator;
    void this
      .sql`CREATE TABLE IF NOT EXISTS repository_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`;
    const rows = this.sql<{ value: string }>`SELECT value FROM repository_state WHERE id=1`;
    const state = rows[0]
      ? (JSON.parse(rows[0].value) as State)
      : this.env.EXECUTION_MODE === "cloud"
        ? cloudInitialState(this.env)
        : initialState();
    this.coordinator = new Coordinator(state, (state) =>
      this.ctx.storage.transactionSync(() => {
        const [previous] = this.sql<{
          value: string;
        }>`SELECT value FROM repository_state WHERE id=1`;
        if (previous)
          assertConfigurationIdle(
            this.getLandingStore(),
            (JSON.parse(previous.value) as State).project,
            state.project,
          );
        void this
          .sql`INSERT INTO repository_state(id,value) VALUES(1,${JSON.stringify(state)}) ON CONFLICT(id) DO UPDATE SET value=excluded.value`;
      }),
    );
    this.coordinator.recover(this.env.EXECUTION_MODE === "cloud");
    return this.coordinator;
  }
  async onRequest(request: Request) {
    if (!(await principal(request, this.env)))
      return Response.json({ error: "access_not_configured" }, { status: 403 });
    if (Number(request.headers.get("content-length") ?? 0) > 16384)
      return Response.json({ error: "body_too_large" }, { status: 413 });
    const coordinator = this.getCoordinator();
    const app = api(
      coordinator,
      async (id) => {
        if (this.env.EXECUTION_MODE === "fake")
          this.ctx.waitUntil(coordinator.dispatch(id, fakeExecution));
        if (this.env.EXECUTION_MODE === "cloud") await this.jobs.enqueue(id, { runId: id });
      },
      this.landing(coordinator),
      (await principal(request, this.env))!,
    );
    return app.fetch(request);
  }
}
export default {
  fetch(request: Request, env: Env) {
    return protectedFetch(
      request,
      env,
      (request) => {
        const stub = env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew"));
        return stub.fetch(request);
      },
      env.ASSETS,
    );
  },
} satisfies ExportedHandler<Env>;
