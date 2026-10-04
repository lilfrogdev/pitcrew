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
  const app = new Hono<{ Variables: { body: Record<string, unknown> } }>();
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const reader = c.req.raw.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > 16384) {
            await reader.cancel();
            throw new AdmissionError("body_too_large", 413);
          }
          chunks.push(result.value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        c.set("body", JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        throw new AdmissionError("invalid_json");
      }
    }
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: error instanceof AdmissionError ? error.code : "internal_error" },
      error instanceof AdmissionError ? (error.status as 400) : 500,
    ),
  );
  app.get("/api/projects/:projectId/context", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(coordinator.repositoryContext());
  });
  app.get("/api/projects", (c) => c.json([coordinator.state.project]));
  app.get("/api/projects/:projectId/threads", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(coordinator.state.threads);
  });
  app.post("/api/projects/:projectId/threads", async (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    return c.json(
      coordinator.createThread(body.title as string, body.idempotencyKey as string),
      201,
    );
  });
  app.get("/api/threads/:threadId/messages", (c) => {
    coordinator.thread(c.req.param("threadId"));
    return c.json(coordinator.state.messages.filter((m) => m.threadId === c.req.param("threadId")));
  });
  app.post("/api/threads/:threadId/messages", async (c) => {
    const body = c.get("body");
    const result = coordinator.submit(
      c.req.param("threadId"),
      body.content as string,
      body.idempotencyKey as string,
    );
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
