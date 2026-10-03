import { Hono } from "hono";
import { AdmissionError, Coordinator } from "./coordinator";
export function fixtureAccess(
  request: Request,
  env: { ENVIRONMENT: string; FIXTURE_IDENTITY?: string },
) {
  const host = new URL(request.url).hostname;
  return (
    env.ENVIRONMENT === "development" &&
    env.FIXTURE_IDENTITY === "lilfrogdev" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(host)
  );
}
export function api(coordinator: Coordinator, dispatch: (id: string) => void) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      { error: error instanceof AdmissionError ? error.code : "internal_error" },
      error instanceof AdmissionError ? (error.status as 400) : 500,
    ),
  );
  app.get("/api/projects", (c) => c.json([coordinator.state.project]));
  app.get("/api/projects/:projectId/threads", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(coordinator.state.threads);
  });
  app.post("/api/projects/:projectId/threads", async (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = await c.req.json();
    return c.json(coordinator.createThread(body.title, body.idempotencyKey), 201);
  });
  app.get("/api/threads/:threadId/messages", (c) => {
    coordinator.thread(c.req.param("threadId"));
    return c.json(coordinator.state.messages.filter((m) => m.threadId === c.req.param("threadId")));
  });
  app.post("/api/threads/:threadId/messages", async (c) => {
    const body = await c.req.json();
    const result = coordinator.submit(c.req.param("threadId"), body.content, body.idempotencyKey);
    dispatch(result.run.id);
    return c.json(result, 201);
  });
  app.get("/api/threads/:threadId/runs", (c) => {
    coordinator.thread(c.req.param("threadId"));
    return c.json(coordinator.state.runs.filter((r) => r.threadId === c.req.param("threadId")));
  });
  app.get("/api/runs/:runId/evidence", (c) => c.json(coordinator.evidence(c.req.param("runId"))));
  app.get("/api/runs/:runId/reviews", (c) =>
    c.json(coordinator.evidence(c.req.param("runId")).reviews),
  );
  app.get("/api/projects/:projectId/events", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const after = Number(c.req.query("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new AdmissionError("invalid_cursor");
    return c.json(coordinator.state.events.filter((e) => e.sequence > after));
  });
  app.post("/api/runs/:runId/merge-approval", (c) => c.json({ error: "merge_unavailable" }, 501));
  return app;
}
