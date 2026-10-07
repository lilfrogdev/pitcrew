// Synthetic test fixture only: no production authentication or provider transport.
import { DurableObject } from "cloudflare:workers";
import { api } from "../src/api";
import { AdmissionError, Coordinator, initialState } from "../src/coordinator";
import { Collaboration } from "../src/collaboration";
import { sqlUploadStore } from "../src/uploads";
import { resolveCatalog } from "../src/model-selection";
import { VisualizationAuthorityGate } from "../src/visualization-authority-gate";
export class UploadFixture extends DurableObject {
  private failNextPersist = false;
  private gate = new VisualizationAuthorityGate();
  private store = sqlUploadStore(
    this.ctx.storage.sql,
    (operation) => this.ctx.storage.transactionSync(operation),
    () => this.clock,
  );
  private clock = Date.now();
  private core = new Coordinator(
    this.ctx.storage.sql
      .exec<{ value: string }>(
        "CREATE TABLE IF NOT EXISTS state(value TEXT); SELECT value FROM state",
      )
      .toArray()[0]?.value
      ? JSON.parse(
          this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM state").toArray()[0]
            .value,
        )
      : initialState(),
    (state) => {
      if (this.failNextPersist) {
        this.failNextPersist = false;
        throw Error("synthetic_persistence_failure");
      }
      this.ctx.storage.sql.exec("DELETE FROM state");
      this.ctx.storage.sql.exec("INSERT INTO state VALUES(?)", JSON.stringify(state));
    },
    undefined,
    undefined,
    undefined,
    (operation) => this.ctx.storage.transactionSync(operation),
    this.store,
  );
  private revoked = new Set<string>();
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    const owner = new Collaboration(
      this.core,
      { actor: "account:alice", email: "alice@example.invalid" },
      "alice@example.invalid",
    );
    owner.bootstrap();
  }
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/test/fail-next-send") {
      this.failNextPersist = true;
      return Response.json({ ok: true });
    }
    const actor = request.headers.get("x-test-actor") ?? "alice";
    if (!["alice", "bob"].includes(actor)) return new Response(null, { status: 401 });
    const identity = { actor: `account:${actor}`, email: `${actor}@example.invalid` };
    const access = new Collaboration(this.core, identity, "alice@example.invalid");
    if (new URL(request.url).pathname === "/test/expire") {
      this.clock += 25 * 60 * 60 * 1000;
      this.store.cleanup();
      return Response.json({ ok: true });
    }
    if (new URL(request.url).pathname === "/test/revoke")
      return this.gate.run(async () => {
        this.revoked.add(actor);
        return Response.json({ ok: true });
      });
    return api(
      this.core,
      () => {},
      undefined,
      identity,
      request.headers.get("x-test-conversation")
        ? { catalog: resolveCatalog({ EXECUTION_MODE: "fake" }), dispatch: () => {} }
        : undefined,
      access,
      !request.headers.get("x-test-conversation"),
      undefined,
      undefined,
      undefined,
      this.store,
      (operation) =>
        this.gate.run(async () => {
          if (this.revoked.has(actor)) throw new AdmissionError("unauthorized", 401);
          return operation();
        }),
    ).fetch(request);
  }
}
export default {
  fetch(request: Request, env: { UPLOAD: DurableObjectNamespace<UploadFixture> }) {
    return env.UPLOAD.get(env.UPLOAD.idFromName("fixture")).fetch(request);
  },
};
