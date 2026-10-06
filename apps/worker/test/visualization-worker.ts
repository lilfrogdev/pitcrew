import { DurableObject } from "cloudflare:workers";
import { VisualizationStore } from "../src/visualization-store";
import { publishVisualization, visualizationRequest } from "../src/visualization-api";
import { VisualizationError } from "../../../packages/protocol/src/visualizations";
// Isolated emulator ONLY; no bindings or environment changes to the real Worker.
export class VisualizationFixture extends DurableObject {
  store = new VisualizationStore(this.ctx.storage.sql, (work) =>
    this.ctx.storage.transactionSync(work),
  );
  permitted = true;
  async fetch(request: Request) {
    const fixtureCall = /^\/fixture\/publish\/(\d+)$/.exec(new URL(request.url).pathname);
    if (fixtureCall && request.headers.get("x-fixture-actor") === "viewer") {
      try {
        const record = await publishVisualization(
          this.store,
          {
            actor: "account:viewer",
            repositoryId: "repo",
            threadId: "thread",
            turnId: "fixture-turn",
            invocationId: `fixture-call-${fixtureCall[1]}`,
          },
          {
            kind: "bars",
            title: "Chart",
            summary: "Two values",
            height: 320,
            points: [{ label: "A", value: 2 }],
          },
          async () => {},
          () => {
            if (!this.permitted) throw new VisualizationError("not_found", 404);
          },
        );
        return Response.json({ id: record.id }, { status: 201 });
      } catch (error) {
        return Response.json(
          { error: "denied" },
          { status: error instanceof VisualizationError ? error.status : 503 },
        );
      }
    }
    if (new URL(request.url).pathname === "/fixture/revoke") {
      this.permitted = false;
      return new Response("revoked");
    }
    return (
      (await visualizationRequest(request, this.store, {
        session: async () =>
          request.headers.get("x-fixture-actor") === "viewer"
            ? { actor: "account:viewer", accessEpoch: "fixture", expiresAt: Date.now() + 60000 }
            : undefined,
        requireThread: (context) => {
          if (!this.permitted || context.repositoryId !== "repo" || context.threadId !== "thread")
            throw new VisualizationError("not_found", 404);
        },
      })) ?? new Response("missing", { status: 404 })
    );
  }
}
export default {
  fetch(request: Request, env: { VISUALIZATIONS: DurableObjectNamespace<VisualizationFixture> }) {
    return env.VISUALIZATIONS.get(env.VISUALIZATIONS.idFromName("isolated-visualizations")).fetch(
      request,
    );
  },
};
