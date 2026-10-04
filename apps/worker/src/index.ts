import { Agent } from "agents";
import { api, fixtureAccess } from "./api";
import { Coordinator, fakeExecution, initialState, type State } from "./coordinator";
interface Env {
  REPOSITORY: DurableObjectNamespace<RepositoryAgent>;
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  EXECUTION_MODE: string;
}
export class RepositoryAgent extends Agent<Env> {
  private coordinator?: Coordinator;
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
    this.coordinator.recover();
    return this.coordinator;
  }
  async onRequest(request: Request) {
    if (!fixtureAccess(request, this.env))
      return Response.json({ error: "access_not_configured" }, { status: 403 });
    if (Number(request.headers.get("content-length") ?? 0) > 16384)
      return Response.json({ error: "body_too_large" }, { status: 413 });
    const coordinator = this.getCoordinator();
    const app = api(coordinator, (id) => {
      if (this.env.EXECUTION_MODE === "fake")
        this.ctx.waitUntil(coordinator.dispatch(id, fakeExecution));
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
