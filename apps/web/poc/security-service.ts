import { DatabaseSync } from "node:sqlite";
import { VisualizationStore, type VisualizationSql } from "../../worker/src/visualization-store";
import { publishVisualization, visualizationRequest } from "../../worker/src/visualization-api";
import { VisualizationError } from "../../../packages/protocol/src/visualizations";
// Local test service only, deliberately separate from real account authentication.
export async function fixtureVisualizationService() {
  const db = new DatabaseSync(":memory:");
  const sql: VisualizationSql = {
    exec(query, ...args) {
      const stmt = db.prepare(query);
      const rows = /^SELECT/i.test(query) ? stmt.all(...args) : (stmt.run(...args), []);
      return { toArray: () => rows };
    },
  };
  const store = new VisualizationStore(sql, (work) => {
    db.exec("BEGIN");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  const context = {
    actor: "account:demo",
    repositoryId: "pitcrew",
    threadId: "visualization",
    turnId: "fixture-turn",
    invocationId: "fixture-chart",
  };
  await publishVisualization(
    store,
    context,
    {
      kind: "bars",
      title: "Server admitted chart",
      summary: "Private server description",
      height: 320,
      points: [
        { label: "One", value: 10 },
        { label: "Two", value: 20 },
      ],
    },
    async () => {},
    () => {},
  );
  await publishVisualization(
    store,
    { ...context, invocationId: "fixture-document" },
    {
      kind: "document",
      title: "Server admitted note",
      summary: "Private document description",
      height: 240,
      nodes: [
        {
          tag: "details",
          children: [
            { tag: "summary", children: [{ text: "Expand explanation" }] },
            { text: '<script src="/sentinel">hostile text is inert</script>' },
          ],
        },
      ],
    },
    async () => {},
    () => {},
  );
  let permitted = true;
  return {
    revoke() {
      permitted = false;
    },
    close() {
      db.close();
    },
    request(request: Request) {
      return visualizationRequest(request, store, {
        session: async () =>
          request.headers.get("cookie")?.includes("fixture-private=value")
            ? { actor: context.actor, accessEpoch: "fixture-epoch", expiresAt: Date.now() + 60000 }
            : undefined,
        requireThread: (c) => {
          if (
            !permitted ||
            c.repositoryId !== context.repositoryId ||
            c.threadId !== context.threadId
          )
            throw new VisualizationError("not_found", 404);
        },
      });
    },
  };
}
