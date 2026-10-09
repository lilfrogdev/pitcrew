// Bounded synthetic transport for the real browser HTTP adapter. No cloud calls.
import { randomUUID } from "node:crypto";

export function createFixture() {
  const owner = {
    projectId: "qa-owner",
    name: "Owner display",
    logicalName: "owner-logical",
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
    logicalName: "editor-logical",
    repositoryName: "editor-physical",
    repositoryId: "qa-editor-id",
    role: "editor",
    deletable: false,
  };
  const external = {
    ...owner,
    projectId: "qa-external",
    name: "External display",
    logicalName: "external-logical",
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
  const reset = (scenario = "normal", deleteEnabled = false) =>
    (state = {
      scenario,
      activeOwner: "a",
      projectOwners: { "qa-owner": "a", "qa-editor": "a", "qa-external": "a" },
      creationOwners: {},
      pendingProjects: {},
      deleteCapability:
        deleteEnabled === true && scenario !== "delete-off" && scenario !== "gate-off",
      repositories: structuredClone([owner, editor, external]),
      creations: [],
      invitations: [structuredClone(invitation)],
      members: [
        { actor: "qa-owner-actor", email: "owner@example.test", role: "owner" },
        { actor: "qa-editor-actor", email: "editor@example.test", role: "editor" },
      ],
      calls: [],
      deletes: 0,
      deleteCounts: {},
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
        reset(body.scenario, body.deleteEnabled);
        return json(res, { ok: true });
      }
      if (path === "/fixture/release") {
        for (const release of state.held.splice(0)) release();
        return json(res, { ok: true });
      }
      if (path === "/fixture/delete-capability") {
        state.deleteCapability = body.enabled === true;
        return json(res, { ok: true });
      }
      if (path === "/fixture/seed-ready") {
        // Another synthetic tab completed an intent after this UI's prior discovery.
        const logicalName = body.logicalName.trim().toLowerCase();
        const projectId = randomUUID();
        const repositoryName = `${logicalName.slice(0, 30)}-${projectId.replaceAll("-", "")}`;
        const item = {
          ...owner,
          projectId,
          logicalName,
          repositoryName,
          repositoryId: `qa-provider-${projectId}`,
          name: body.displayName,
          description: "Synthetic concurrent intent",
        };
        state.repositories.push(item);
        state.projectOwners[projectId] = state.activeOwner;
        state.pendingProjects[repositoryName] = structuredClone(item);
        state.creationOwners[repositoryName] = state.activeOwner;
        state.creations.push({
          name: logicalName,
          logicalName,
          repositoryName,
          repositoryId: item.repositoryId,
          projectId,
          status: "ready",
        });
        return json(res, { ok: true });
      }
      if (path === "/fixture/switch") {
        state.activeOwner = body.owner ?? "b";
        if (state.activeOwner === "b" && !state.projectOwners["qa-second-account"]) {
          state.repositories.push({
            ...owner,
            projectId: "qa-second-account",
            name: "Second account repository",
            logicalName: "second-account-logical",
            repositoryName: "second-account-physical",
            repositoryId: "qa-second-account-id",
          });
          state.projectOwners["qa-second-account"] = "b";
        }
        return json(res, { ok: true });
      }
      if (path === "/fixture/state") return json(res, { ...state, held: state.held.length });
      if (!path.startsWith("/api/")) return false;
      state.calls.push({ method: req.method, path, body });
      if (path === "/api/local-session") return json(res, { nonce: null });
      if (path === "/api/project-adoptions") return json(res, []);
      if (path === "/api/repository-creations")
        return json(res, {
          approval:
            state.scenario === "legacy-approved" ? { name: "legacy-approved-physical" } : null,
          creations: state.creations.filter(
            (record) =>
              state.creationOwners[record.repositoryName ?? record.name] === state.activeOwner,
          ),
          capabilities: {
            create: !["gate-off", "legacy-approved"].includes(state.scenario),
            manage: !["gate-off", "legacy-approved"].includes(state.scenario),
            ...(state.scenario === "delete-omitted" ? {} : { delete: state.deleteCapability }),
          },
        });
      if (path === "/api/repositories") {
        const snapshot = structuredClone(
          state.repositories.filter(
            (x) => x.status !== "deleted" && state.projectOwners[x.projectId] === state.activeOwner,
          ),
        );
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
        const proposedName = body.name.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(proposedName)) return json(res, {}, 400);
        const logicalName = proposedName.toLowerCase();
        const activeCreation = state.creations.find(
          (record) =>
            (record.logicalName ?? record.name) === logicalName &&
            record.status !== "deleted" &&
            state.creationOwners[record.repositoryName ?? record.name] === state.activeOwner,
        );
        if (activeCreation?.status === "deleting")
          return json(res, { error: "repository_exists" }, 409);
        if (activeCreation?.status === "ready") return json(res, activeCreation, 200);
        if (
          state.repositories.some(
            (item) =>
              state.projectOwners[item.projectId] === state.activeOwner &&
              item.logicalName === logicalName &&
              item.status !== "deleted",
          ) &&
          !activeCreation
        )
          return json(res, { error: "repository_exists" }, 409);
        const prior = activeCreation && state.pendingProjects[activeCreation.repositoryName];
        // Persist a stable intent before simulating any provider result.
        const projectId = prior?.projectId ?? randomUUID();
        const repositoryName =
          prior?.repositoryName ?? `${logicalName.slice(0, 30)}-${projectId.replaceAll("-", "")}`;
        const legacy = state.scenario === "legacy-approved";
        const item = {
          ...owner,
          projectId,
          repositoryId: prior?.repositoryId ?? `qa-provider-${projectId}`,
          logicalName,
          repositoryName: legacy ? logicalName : repositoryName,
          name: prior?.name ?? body.displayName ?? logicalName,
          description: prior?.description ?? body.description ?? "",
        };
        const creation = {
          name: logicalName,
          ...(!legacy ? { logicalName, repositoryName: item.repositoryName } : {}),
          repositoryId: item.repositoryId,
          status: "ready",
          projectId: item.projectId,
        };
        state.pendingProjects[item.repositoryName] = structuredClone(item);
        state.creationOwners[item.repositoryName] = state.activeOwner;
        if (state.scenario === "registration-recovery" && !activeCreation) {
          creation.status = "registration_required";
          delete creation.projectId;
          state.creations.push(creation);
          return json(res, creation, 202);
        }
        if (activeCreation) state.creations[state.creations.indexOf(activeCreation)] = creation;
        else state.creations.push(creation);
        state.repositories.push(item);
        state.projectOwners[item.projectId] = state.activeOwner;
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
        const proposedName = (body.logicalName ?? item.logicalName).trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(proposedName)) return json(res, {}, 400);
        const logicalName = proposedName.toLowerCase();
        if (
          state.repositories.some(
            (other) =>
              other.projectId !== item.projectId &&
              state.projectOwners[other.projectId] === state.activeOwner &&
              other.logicalName === logicalName &&
              other.status !== "deleted",
          )
        )
          return json(res, { error: "repository_exists" }, 409);
        if (
          state.creations.some(
            (record) =>
              record.repositoryName !== item.repositoryName &&
              state.creationOwners[record.repositoryName ?? record.name] === state.activeOwner &&
              (record.logicalName ?? record.name) === logicalName &&
              record.status !== "deleted",
          )
        )
          return json(res, { error: "repository_exists" }, 409);
        item.logicalName = logicalName;
        const creation = state.creations.find(
          (record) => record.repositoryName === item.repositoryName,
        );
        if (creation) {
          creation.logicalName = logicalName;
          creation.name = logicalName;
        }
        item.name = body.displayName;
        item.description = body.description;
        item.metadataRevision++;
        return json(res, {
          id: item.projectId,
          name: item.name,
          logicalName: item.logicalName,
          description: item.description,
          metadataRevision: item.metadataRevision,
          repository: `artifact:${item.repositoryName}`,
        });
      }
      if (tail === "repository/delete") {
        state.deletes++;
        if (state.scenario === "delete-failure")
          return json(res, { diagnostic: "private-provider-diagnostic" }, 503);
        state.deleteCounts[item.repositoryName] =
          (state.deleteCounts[item.repositoryName] ?? 0) + 1;
        item.status = state.deleteCounts[item.repositoryName] === 1 ? "deleting" : "deleted";
        item.lifecycle = item.status;
        item.deletable = false;
        const creation = state.creations.find(
          (record) =>
            (record.repositoryName ?? record.name) === item.repositoryName &&
            record.repositoryId === item.repositoryId,
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
          recipient: body.recipient,
        };
        delete created.email; // New native DTO has exactly one recipient label.
        if (state.scenario === "recipient-mismatch") created.recipient = "@other_synthetic_account";
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
