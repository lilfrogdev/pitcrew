import { Hono } from "hono";
import { ExecutionError } from "../../../packages/execution/src/contracts";
import type { LandingApi } from "./landing-api";
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
export function api(
  coordinator: Coordinator,
  dispatch: (id: string) => void | Promise<void>,
  landing?: LandingApi,
  identity: { actor: string } = { actor: "local-fixture" },
) {
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
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw Error("invalid_json");
        c.set("body", parsed);
      } catch {
        throw new AdmissionError("invalid_json");
      }
    }
    await next();
  });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof AdmissionError || error instanceof ExecutionError
            ? error.code
            : "internal_error",
      },
      error instanceof AdmissionError
        ? (error.status as 400)
        : error instanceof ExecutionError
          ? 409
          : 500,
    ),
  );
  app.get("/api/projects/:projectId/context", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(coordinator.repositoryContext());
  });
  app.post("/api/projects/:projectId/knowledge", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    return c.json(
      coordinator.appendKnowledge(
        identity.actor,
        body.idempotencyKey as string,
        body.mutation as Parameters<Coordinator["appendKnowledge"]>[2],
      ),
      201,
    );
  });
  app.post("/api/projects/:projectId/verification-profile", async (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    return c.json(
      await coordinator.updateProfile(
        body.profile as Parameters<Coordinator["updateProfile"]>[0],
        body.expectedRevision as string,
      ),
    );
  });
  app.get("/api/projects/:projectId/verification-metrics", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(coordinator.metrics());
  });
  app.get("/api/projects/:projectId/intake", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json({ groups: coordinator.groups(), profile: coordinator.profile() });
  });
  app.post("/api/projects/:projectId/reports", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(
      coordinator.receive(
        identity.actor,
        c.get("body") as unknown as Parameters<Coordinator["receive"]>[1],
      ),
      201,
    );
  });
  app.post("/api/projects/:projectId/intake/move", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    return c.json(
      coordinator.move(
        identity.actor,
        body.idempotencyKey as string,
        body as unknown as Parameters<Coordinator["move"]>[2],
      ),
    );
  });
  app.post("/api/projects/:projectId/intake/dispatch", async (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    const result = await coordinator.dispatchGroup(
      identity.actor,
      body.idempotencyKey as string,
      body as unknown as Parameters<Coordinator["dispatchGroup"]>[2],
      body.acceptance as Parameters<Coordinator["dispatchGroup"]>[3],
      body.profileRevision as string,
    );
    await dispatch(result.runId);
    return c.json(result, 201);
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
  app.post("/api/projects/:projectId/threads/:threadId/archive", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(coordinator.setThreadArchived(c.req.param("threadId"), c.get("body").archived));
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
      identity.actor,
    );
    await dispatch(result.run.id);
    return c.json(result, 201);
  });
  app.get("/api/threads/:threadId/changes", (c) => {
    coordinator.thread(c.req.param("threadId"));
    return c.json(
      coordinator.state.changes!.filter((change) => change.threadId === c.req.param("threadId")),
    );
  });
  app.get("/api/changes/:changeId", (c) => c.json(coordinator.change(c.req.param("changeId"))));
  app.get("/api/changes/:changeId/runs", (c) => {
    coordinator.change(c.req.param("changeId"));
    return c.json(coordinator.state.runs.filter((run) => run.changeId === c.req.param("changeId")));
  });
  app.post("/api/changes/:changeId/runs", async (c) => {
    const run = coordinator.retryChange(
      c.req.param("changeId"),
      c.get("body").idempotencyKey as string,
    );
    await dispatch(run.id);
    return c.json(run, 201);
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
    if (!Number.isSafeInteger(after) || after < 0) throw new AdmissionError("invalid_event_cursor");
    const page = coordinator.eventsAfter(after);
    c.header("X-Next-Sequence", String(page.at(-1)?.sequence ?? after));
    return c.json(page);
  });
  app.get("/api/capabilities", (c) =>
    c.json({ landing: { enabled: !!landing, backend: landing?.backend ?? null } }),
  );
  const configured = () => {
    if (!landing) throw new AdmissionError("landing_unconfigured", 503);
    return landing;
  };
  const string = (value: unknown, name: string) => {
    if (typeof value !== "string" || !value || value.length > 256)
      throw new AdmissionError(`invalid_${name}`);
    return value;
  };
  app.post("/api/runs/:runId/merge-approval", async (c) => {
    const context = configured(),
      body = c.get("body"),
      runId = c.req.param("runId");
    await coordinator.requireCurrentVerification(runId);
    const authorization = await context.service.authorize({
      runId,
      actor: context.actor,
      expectedTargetSha: string(body.expectedTargetSha, "expected_target_sha"),
      candidateSha: string(body.candidateSha, "candidate_sha"),
      configurationRevision: string(body.configurationRevision, "configuration_revision"),
      idempotencyKey: string(body.idempotencyKey, "idempotency_key"),
    });
    return c.json(
      {
        authorizationId: authorization.authorizationId,
        runId: authorization.runId,
        expectedTargetSha: authorization.expectedTargetSha,
        candidateSha: authorization.candidateSha,
        configurationRevision: authorization.configurationRevision,
        expiresAt: authorization.expiresAt,
        state: context.store.get(authorization.authorizationId, context.actor, runId).state,
        backend: context.backend,
      },
      201,
    );
  });
  app.post("/api/runs/:runId/landing", async (c) => {
    const context = configured();
    const result = await context.service.land({
      runId: c.req.param("runId"),
      actor: context.actor,
      authorizationId: string(c.get("body").authorizationId, "authorization_id"),
    });
    const receipt = { ...result, backend: context.backend };
    coordinator.confirmFixtureLanding(c.req.param("runId"), receipt);
    return c.json(receipt);
  });
  app.post("/api/runs/:runId/landing/reconcile", async (c) => {
    const context = configured();
    const result = await context.service.reconcile({
      runId: c.req.param("runId"),
      actor: context.actor,
      authorizationId: string(c.get("body").authorizationId, "authorization_id"),
    });
    const receipt = { ...result, backend: context.backend };
    coordinator.confirmFixtureLanding(c.req.param("runId"), receipt);
    return c.json(receipt);
  });
  return app;
}
