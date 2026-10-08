// Bounded synthetic transport for the real browser HTTP adapter. No cloud calls.
export function createFixture() {
  const owner = {
    projectId: "qa-owner",
    name: "Owner display",
    repositoryName: "owner-physical",
    repositoryId: "qa-repository-id",
    description: "Original description",
    metadataRevision: 0,
    role: "owner",
    status: "present",
    lifecycle: "registered",
    deletable: true,
  };
  const editor = {
    ...owner,
    projectId: "qa-editor",
    name: "Editor display",
    repositoryName: "editor-physical",
    repositoryId: "qa-editor-id",
    role: "editor",
    deletable: false,
  };
  const external = {
    ...owner,
    projectId: "qa-external",
    name: "External display",
    repositoryName: "external-physical",
    repositoryId: "qa-external-id",
    deletable: false,
  };
  const invitation = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "pending@example.test",
    role: "editor",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scope: "project",
    projectId: owner.projectId,
  };
  let state;
  const reset = (scenario = "normal") =>
    (state = {
      scenario,
      repositories: structuredClone([owner, editor, external]),
      creations: [],
      invitations: [structuredClone(invitation)],
      members: [
        { actor: "qa-owner-actor", email: "owner@example.test", role: "owner" },
        { actor: "qa-editor-actor", email: "editor@example.test", role: "editor" },
      ],
      calls: [],
      deletes: 0,
      held: [],
    });
  reset();
  const json = (res, value, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  return {
    get state() {
      return state;
    },
    reset,
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      if (raw.length > 8192) return json(res, {}, 413);
      const body = raw ? JSON.parse(raw) : undefined;
      if (path === "/fixture/reset") {
        reset(body.scenario);
        return json(res, { ok: true });
      }
      if (path === "/fixture/release") {
        for (const release of state.held.splice(0)) release();
        return json(res, { ok: true });
      }
      if (path === "/fixture/switch") {
        state.repositories = [
          {
            ...owner,
            projectId: "qa-second-account",
            name: "Second account repository",
            repositoryName: "second-account-physical",
            repositoryId: "qa-second-account-id",
          },
        ];
        return json(res, { ok: true });
      }
      if (path === "/fixture/state") return json(res, { ...state, held: state.held.length });
      if (!path.startsWith("/api/")) return false;
      state.calls.push({ method: req.method, path, body });
      if (path === "/api/local-session") return json(res, { nonce: null });
      if (path === "/api/project-adoptions") return json(res, []);
      if (path === "/api/repository-creations")
        return json(res, {
          approval: null,
          creations: state.creations,
          capabilities: {
            create: state.scenario !== "gate-off",
            manage: state.scenario !== "gate-off",
          },
        });
      if (path === "/api/repositories") {
        const snapshot = structuredClone(state.repositories.filter((x) => x.status !== "deleted"));
        if (state.scenario === "late-read") {
          state.scenario = "normal";
          // Send no-store admission immediately; hold only the JSON body. Otherwise
          // Chromium serializes duplicate GETs behind its provisional HTTP cache lock.
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.flushHeaders();
          state.held.push(() => res.end(JSON.stringify({ repositories: snapshot })));
          return;
        }
        if (state.scenario === "read-failure")
          return json(res, { diagnostic: "private-provider-diagnostic" }, 503);
        return json(res, { repositories: snapshot });
      }
      if (path === "/api/repositories/create") {
        if (state.scenario === "create-failure")
          return json(res, { diagnostic: "private-provider-diagnostic" }, 503);
        const suffix = state.creations.length ? `-${state.creations.length + 1}` : "";
        const item = {
          ...owner,
          projectId: `qa-created${suffix}`,
          repositoryId: `qa-created-id${suffix}`,
          repositoryName: body.name,
          name: body.displayName,
          description: body.description,
        };
        state.repositories.push(item);
        const creation = {
          name: body.name,
          repositoryId: item.repositoryId,
          projectId: item.projectId,
          status: "ready",
        };
        state.creations.push(creation);
        return json(res, creation, 200);
      }
      const match = path.match(/^\/api\/projects\/([^/]+)\/(.*)$/);
      if (!match) return json(res, {}, 404);
      const [, projectId, tail] = match;
      const item = state.repositories.find((x) => x.projectId === projectId);
      if (!item) return json(res, {}, 404);
      if (tail === "repository" && req.method === "PATCH") {
        if (state.scenario === "edit-conflict")
          return json(res, { diagnostic: "private-provider-diagnostic" }, 409);
        item.name = body.displayName;
        item.description = body.description;
        item.metadataRevision++;
        return json(res, {
          id: item.projectId,
          name: item.name,
          description: item.description,
          metadataRevision: item.metadataRevision,
          repository: `artifact:${item.repositoryName}`,
        });
      }
      if (tail === "repository/delete") {
        state.deletes++;
        if (state.scenario === "delete-failure")
          return json(res, { diagnostic: "private-provider-diagnostic" }, 503);
        item.status = state.deletes === 1 ? "deleting" : "deleted";
        item.lifecycle = item.status;
        item.deletable = false;
        const creation = state.creations.find(
          (record) =>
            record.name === item.repositoryName && record.repositoryId === item.repositoryId,
        );
        if (creation) creation.status = item.status;
        return json(res, item, item.status === "deleting" ? 202 : 200);
      }
      if (tail === "repository")
        return json(
          res,
          state.scenario === "wrong-delete-target" ? { ...item, repositoryId: "wrong-id" } : item,
        );
      if (tail === "members") return json(res, state.members);
      if (tail.startsWith("members/") && req.method === "DELETE") {
        state.members = state.members.filter((x) => x.actor !== decodeURIComponent(tail.slice(8)));
        return json(res, { ok: true });
      }
      if (tail === "invitations" && req.method === "GET") return json(res, state.invitations);
      if (tail === "invitations" && req.method === "POST") {
        if (state.scenario === "invite-failure")
          return json(res, { diagnostic: "private-provider-diagnostic" }, 503);
        const created = {
          ...invitation,
          id: "00000000-0000-4000-8000-000000000002",
          email: body.email,
        };
        state.invitations.push(created);
        const result = { token: "a".repeat(64), invitation: created };
        if (state.scenario === "late-invite") {
          state.scenario = "normal";
          state.held.push(() => json(res, result));
          return;
        }
        return json(res, result, 201);
      }
      if (tail.startsWith("invitations/") && tail.endsWith("/revoke")) {
        const id = tail.split("/")[1];
        const invite = state.invitations.find((x) => x.id === id);
        invite.revokedAt = "2026-10-08T00:00:00Z";
        return json(res, invite);
      }
      return json(res, {}, 404);
    },
  };
}
