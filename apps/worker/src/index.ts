import { Agent } from "agents";
import { ChangeAgent, ReviewAgent, type PiEnv } from "./pi-agents";
export { ChangeAgent, ReviewAgent };
import { DurableJobs } from "./durable-jobs";
import { api, fixtureAccess } from "./api";
import { Coordinator, fakeExecution, initialState, type State } from "./coordinator";
interface Env extends PiEnv {
  CHANGE: DurableObjectNamespace<ChangeAgent>;
  ARTIFACT_REPOSITORY?: string;
  REPOSITORY: DurableObjectNamespace<RepositoryAgent>;
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  EXECUTION_MODE: string;
}
export class RepositoryAgent extends Agent<Env> {
  private coordinator?: Coordinator;
  private readonly jobs: DurableJobs;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.jobs = new DurableJobs(
      "repository-results",
      async (jobs) => {
        if (this.env.EXECUTION_MODE !== "cloud") return;
        const core = this.getCoordinator();
        for (const run of core.state.runs)
          if (["queued", "running"].includes(run.status))
            await jobs.enqueue(run.id, { runId: run.id });
      },
      async (payload) => {
        const runId = (payload as { runId: string }).runId,
          core = this.getCoordinator();
        const input = core.begin(runId);
        if (!input) return;
        try {
          if (!this.env.ARTIFACT_REPOSITORY || !this.env.MODEL_CONFIGURATION)
            throw Error("execution_not_configured");
          const worker = this.env.CHANGE.get(
            this.env.CHANGE.idFromName(`change:${input.projectId}:${input.runId}`),
          );
          await worker.start({ ...input, repository: this.env.ARTIFACT_REPOSITORY });
          const receipt = await worker.result(runId);
          if (receipt.stage === "done" && receipt.result) {
            core.complete(runId, receipt.result);
            return;
          }
          if (receipt.stage === "blocked") {
            core.fail(runId, receipt.error === "reconciliation_required");
            return;
          }
          return { rescheduleAt: Date.now() + 1000 };
        } catch {
          core.fail(runId, true);
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
    this.coordinator = new Coordinator(
      rows[0] ? (JSON.parse(rows[0].value) as State) : initialState(),
      (state) => {
        void this
          .sql`INSERT INTO repository_state(id,value) VALUES(1,${JSON.stringify(state)}) ON CONFLICT(id) DO UPDATE SET value=excluded.value`;
      },
    );
    this.coordinator.recover(this.env.EXECUTION_MODE === "cloud");
    return this.coordinator;
  }
  async onRequest(request: Request) {
    if (!fixtureAccess(request, this.env))
      return Response.json({ error: "access_not_configured" }, { status: 403 });
    if (Number(request.headers.get("content-length") ?? 0) > 16384)
      return Response.json({ error: "body_too_large" }, { status: 413 });
    const coordinator = this.getCoordinator();
    const app = api(coordinator, async (id) => {
      if (this.env.EXECUTION_MODE === "fake")
        this.ctx.waitUntil(coordinator.dispatch(id, fakeExecution));
      if (this.env.EXECUTION_MODE === "cloud") await this.jobs.enqueue(id, { runId: id });
    });
    return app.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (!fixtureAccess(request, env))
      return Response.json({ error: "access_not_configured" }, { status: 403 });
    const stub = env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew"));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
