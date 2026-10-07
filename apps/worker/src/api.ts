import {
  selectionAttachmentCapabilities,
  ATTACHMENT_LIMITS,
  AttachmentValidationError,
} from "@pitcrew/protocol";
import type { ModelCatalog } from "./model-selection";
import { resolveRunModels } from "./model-selection";
import type { SourceTree, SourceFile, SourceDiff, SourcePatch } from "@pitcrew/protocol";
import { Hono } from "hono";
import { ExecutionError } from "../../../packages/execution/src/contracts";
import type { LandingApi } from "./landing-api";
import { AdmissionError, Coordinator } from "./coordinator";
import type { Collaboration } from "./collaboration";
import type { ThreadPresence } from "./thread-presence";
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
  conversation?: { catalog: ModelCatalog; dispatch: (id: string) => void | Promise<void> },
  access?: Collaboration,
  executionDisabled = false,
  sourceReader?: {
    request(
      threadId: string,
      action: "tree" | "file" | "diff",
      query: URLSearchParams,
    ): Promise<SourceTree | SourceFile | SourceDiff | SourcePatch>;
  },
  presence?: ThreadPresence,
  presenceAuthority?: (operation: () => Response) => Promise<Response>,
) {
  const app = new Hono<{ Variables: { body: Record<string, unknown> } }>();
  app.use("/api/threads/:threadId/presence", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  const authorizePath = (path: string) => {
    if (!access) return;
    const parts = path.split("/").slice(1);
    if (parts[0] !== "api") throw new AdmissionError("not_found", 404);
    if (
      parts[1] === "account" ||
      parts[1] === "invitations" ||
      (parts[1] === "projects" && parts.length === 2)
    )
      return;
    if (parts[1] === "projects") {
      access.requireProject(parts[2]);
      if (parts[3] === "threads" && parts[4]) access.requireThread(parts[4]);
    } else if (parts[1] === "threads") access.requireThread(parts[2]);
    else if (parts[1] === "changes") {
      const change = coordinator.state.changes?.find((item) => item.id === parts[2]);
      if (!change) throw new AdmissionError("not_found", 404);
      access.requireThread(change.threadId);
    } else if (parts[1] === "runs") {
      const run = coordinator.state.runs.find((item) => item.id === parts[2]);
      if (!run) throw new AdmissionError("not_found", 404);
      access.requireThread(run.threadId);
    } else if (parts[1] === "capabilities") access.requireProject(coordinator.state.project.id);
    else throw new AdmissionError("not_found", 404);
  };
  if (access)
    app.use("*", async (c, next) => {
      authorizePath(new URL(c.req.url).pathname);
      await next();
    });
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      if (
        c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
      )
        throw new AdmissionError("unsupported_media_type", 415);
      const reader = c.req.raw.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      const presenceBody = new URL(c.req.url).pathname.endsWith("/presence");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timedOut = presenceBody
        ? new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              void reader?.cancel();
              reject(new AdmissionError("invalid_presence"));
            }, 5000);
          })
        : undefined;
      try {
        if (reader) {
          while (true) {
            const result = await (timedOut
              ? Promise.race([reader.read(), timedOut])
              : reader.read());
            if (result.done) break;
            size += result.value.byteLength;
            const limit = new URL(c.req.url).pathname.endsWith("/presence")
              ? 512
              : /^\/api\/threads\/[^/]+\/messages$/.test(new URL(c.req.url).pathname)
                ? ATTACHMENT_LIMITS.requestBytes
                : 16384;
            if (size > limit) {
              await reader.cancel();
              throw new AdmissionError("body_too_large", 413);
            }
            chunks.push(result.value);
          }
        }
      } finally {
        if (deadline) clearTimeout(deadline);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw Error("invalid_json");
        c.set("body", parsed);
      } catch {
        throw new AdmissionError("invalid_json");
      }
    }
    await next();
  });
  if (access)
    app.use("*", async (c, next) => {
      authorizePath(new URL(c.req.url).pathname);
      await next();
    });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof AdmissionError ||
          error instanceof ExecutionError ||
          error instanceof AttachmentValidationError
            ? error.code
            : error instanceof Error && error.message === "invalid_model_selection"
              ? error.message
              : "internal_error",
      },
      error instanceof AdmissionError
        ? (error.status as 400)
        : error instanceof AttachmentValidationError ||
            (error instanceof Error && error.message === "invalid_model_selection")
          ? 400
          : error instanceof ExecutionError
            ? 409
            : 500,
    ),
  );
  app.get("/api/threads/:threadId/source/:action", async (c) => {
    const action = c.req.param("action");
    if (!["tree", "file", "diff"].includes(action)) throw new AdmissionError("not_found", 404);
    access?.requireThread(c.req.param("threadId"));
    if (!sourceReader || !access) throw new AdmissionError("source_unavailable", 503);
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(
      await sourceReader.request(
        c.req.param("threadId"),
        action as "tree" | "file" | "diff",
        new URL(c.req.url).searchParams,
      ),
    );
  });
  app.use("/api/threads/:threadId/presence", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (!access || !presence) throw new AdmissionError("not_found", 404);
    if (new URL(c.req.url).search) throw new AdmissionError("invalid_presence");
    await next();
  });
  app.get("/api/threads/:threadId/presence", async (c) => {
    const read = () =>
      c.json(
        presence!.read(coordinator.state.project.id, c.req.param("threadId"), access!, (actor) =>
          coordinator.actorAuthorized(actor, c.req.param("threadId")),
        ),
      );
    return presenceAuthority ? presenceAuthority(read) : read();
  });
  app.post("/api/threads/:threadId/presence", async (c) => {
    const write = () => {
      presence!.write(
        coordinator.state.project.id,
        c.req.param("threadId"),
        access!,
        c.get("body"),
      );
      return c.json({ ok: true });
    };
    return presenceAuthority ? presenceAuthority(write) : write();
  });
  app.get("/api/projects/:projectId/context", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const context = coordinator.repositoryContext(access?.identity.actor);
    if (access) {
      context.activeWork = context.activeWork.filter((work) => access.visibleThread(work.threadId));
      context.activeWorkOmitted = 0;
    }
    return c.json(context);
  });
  app.post("/api/projects/:projectId/knowledge", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    return c.json(
      coordinator.appendKnowledge(
        access?.identity.actor ?? identity.actor,
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
        () => access?.requireProject(c.req.param("projectId")),
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
    const groups = coordinator.groups();
    if (access)
      for (const group of groups) {
        group.links = group.links.filter((link) => access.visibleThread(link.threadId));
        for (const report of group.reports)
          if (report.dispatch && !access.visibleThread(report.dispatch.threadId))
            delete report.dispatch;
      }
    return c.json({ groups, profile: coordinator.profile() });
  });
  app.post("/api/projects/:projectId/reports", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(
      coordinator.receive(
        access?.identity.actor ?? identity.actor,
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
        access?.identity.actor ?? identity.actor,
        body.idempotencyKey as string,
        body as unknown as Parameters<Coordinator["move"]>[2],
      ),
    );
  });
  app.post("/api/projects/:projectId/intake/dispatch", async (c) => {
    if (executionDisabled) throw new AdmissionError("execution_disabled", 503);
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    const result = await coordinator.dispatchGroup(
      identity.actor,
      body.idempotencyKey as string,
      body as unknown as Parameters<Coordinator["dispatchGroup"]>[2],
      body.acceptance as Parameters<Coordinator["dispatchGroup"]>[3],
      body.profileRevision as string,
      conversation?.catalog,
      access?.identity.actor,
    );
    await dispatch(result.runId);
    return c.json(result, 201);
  });
  app.get("/api/account", (c) => c.json(access?.account() ?? identity));
  app.get("/api/projects", (c) => c.json(access?.projectRole() ? [coordinator.state.project] : []));
  app.get("/api/projects/:projectId/members", (c) =>
    c.json(access?.projectMembers(c.req.param("projectId")) ?? []),
  );
  app.get("/api/threads/:threadId/members", (c) =>
    c.json(access?.threadMembers(c.req.param("threadId")) ?? []),
  );
  app.post("/api/projects/:projectId/invitations", async (c) => {
    if (!access) throw new AdmissionError("collaboration_unavailable", 503);
    const body = c.get("body");
    return c.json(
      await access.invite("project", c.req.param("projectId"), body.email, body.role),
      201,
    );
  });
  app.post("/api/threads/:threadId/invitations", async (c) => {
    if (!access) throw new AdmissionError("collaboration_unavailable", 503);
    const body = c.get("body");
    return c.json(
      await access.invite("thread", c.req.param("threadId"), body.email, body.role),
      201,
    );
  });
  app.get("/api/invitations/:token", async (c) =>
    c.json(await access?.preview(c.req.param("token"))),
  );
  app.post("/api/invitations/:token/accept", async (c) =>
    c.json(await access?.accept(c.req.param("token"))),
  );
  app.post("/api/invitations/:token/revoke", async (c) =>
    c.json(await access?.revoke(c.req.param("token"))),
  );
  app.delete("/api/projects/:projectId/members/:actor", (c) =>
    c.json(access?.remove("project", c.req.param("projectId"), c.req.param("actor"))),
  );
  app.delete("/api/threads/:threadId/members/:actor", (c) =>
    c.json(access?.remove("thread", c.req.param("threadId"), c.req.param("actor"))),
  );
  app.get("/api/projects/:projectId/threads", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(
      coordinator.state.threads.filter((thread) => !access || access.visibleThread(thread.id)),
    );
  });
  app.post("/api/projects/:projectId/threads", async (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    const body = c.get("body");
    return c.json(
      coordinator.createThread(
        body.title as string,
        body.idempotencyKey as string,
        access?.identity.actor ?? identity.actor,
        access?.identity.email,
      ),
      201,
    );
  });
  app.post("/api/projects/:projectId/threads/:threadId/archive", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    return c.json(coordinator.setThreadArchived(c.req.param("threadId"), c.get("body").archived));
  });
  app.post("/api/projects/:projectId/model-settings", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    if (!conversation) throw new AdmissionError("conversation_unavailable", 503);
    return c.json(coordinator.updateModelSettings(conversation.catalog, c.get("body").settings));
  });
  app.post("/api/projects/:projectId/threads/:threadId/model-selection", (c) => {
    if (c.req.param("projectId") !== coordinator.state.project.id)
      throw new AdmissionError("not_found", 404);
    if (!conversation) throw new AdmissionError("conversation_unavailable", 503);
    return c.json(
      coordinator.setThreadModelSelection(
        c.req.param("threadId"),
        conversation.catalog,
        c.get("body").modelSelection,
      ),
    );
  });
  app.get("/api/threads/:threadId/attachments/:attachmentId", (c) => {
    const image = coordinator.readThreadAttachment(
      c.req.param("threadId"),
      c.req.param("attachmentId"),
    );
    const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "content-type": image.mediaType,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
  app.get("/api/threads/:threadId/turns", (c) => {
    coordinator.thread(c.req.param("threadId"));
    return c.json(
      (coordinator.state.conversationTurns ?? [])
        .filter((turn) => turn.threadId === c.req.param("threadId"))
        .map(
          ({ input: _input, actor: _actor, membershipActor: _member, ...publicTurn }) => publicTurn,
        ),
    );
  });
  app.get("/api/threads/:threadId/messages", (c) => {
    coordinator.thread(c.req.param("threadId"));
    return c.json(coordinator.state.messages.filter((m) => m.threadId === c.req.param("threadId")));
  });
  app.post("/api/threads/:threadId/messages", async (c) => {
    const body = c.get("body");
    if (executionDisabled) {
      if (
        body.attachments !== undefined &&
        (!Array.isArray(body.attachments) || body.attachments.length)
      )
        throw new AdmissionError("note_attachments_unavailable");
      return c.json(
        coordinator.appendNote(
          c.req.param("threadId"),
          body.content as string,
          body.idempotencyKey as string,
          identity.actor,
          access?.identity,
        ),
        201,
      );
    }
    if (conversation) {
      const result = coordinator.queueTurn(
        c.req.param("threadId"),
        body.content as string,
        body.idempotencyKey as string,
        identity.actor,
        conversation.catalog,
        body.modelSelection,
        body.attachments,
        access?.identity,
      );
      await conversation.dispatch(result.turn.id);
      return c.json(result, 201);
    }
    const result = coordinator.submit(
      c.req.param("threadId"),
      body.content as string,
      body.idempotencyKey as string,
      identity.actor,
      body.attachments,
      access?.identity,
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
    if (executionDisabled) throw new AdmissionError("execution_disabled", 503);
    const run = coordinator.retryChange(
      c.req.param("changeId"),
      c.get("body").idempotencyKey as string,
      conversation?.catalog,
      identity.actor,
      access?.identity.actor,
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
    if (!Number.isSafeInteger(after) || after < 0) throw new AdmissionError("invalid_event_cursor");
    const scanned = coordinator.eventsAfter(after);
    const page = scanned.filter(
      (event) =>
        !access ||
        !(event.provenance?.threadId ?? event.knowledge?.threadId) ||
        access.visibleThread((event.provenance?.threadId ?? event.knowledge?.threadId)!),
    );
    c.header("X-Next-Sequence", String(scanned.at(-1)?.sequence ?? after));
    return c.json(page);
  });
  app.get("/api/capabilities", (c) =>
    c.json({
      landing: { enabled: !!landing, backend: landing?.backend ?? null },
      ...(executionDisabled ? { notesEnabled: true } : {}),
      ...(conversation
        ? {
            composer: {
              conversation: true,
              models: conversation.catalog.choices,
              settings: coordinator.state.project.modelSettings ?? {
                default: conversation.catalog.defaultSelection,
              },
              attachments: selectionAttachmentCapabilities(
                conversation.catalog.choices,
                resolveRunModels(
                  conversation.catalog,
                  undefined,
                  coordinator.state.project.modelSettings,
                ),
              ),
            },
          }
        : {}),
    }),
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
    coordinator.confirmLanding(c.req.param("runId"), receipt);
    return c.json(receipt);
  });
  app.post("/api/runs/:runId/landing/reconcile", async (c) => {
    const context = configured();
    const result = await (context.reconcile ?? context.service.reconcile.bind(context.service))({
      runId: c.req.param("runId"),
      actor: context.actor,
      authorizationId: string(c.get("body").authorizationId, "authorization_id"),
    });
    const receipt = { ...result, backend: context.backend };
    coordinator.confirmLanding(c.req.param("runId"), receipt);
    return c.json(receipt);
  });
  return app;
}
