import { describe, expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration, type Identity } from "./collaboration";
import { Coordinator, initialState } from "./coordinator";

const owner: Identity = { actor: "access:owner-sub", email: "dev@lilfrogdev.com" };
const bryan: Identity = { actor: "access:bryan-sub", email: "bryan.aldair.zamora@gmail.com" };
const other: Identity = { actor: "access:other-sub", email: "other@example.com" };
function fixture() {
  let saved = initialState();
  const core = new Coordinator(saved, (state) => { saved = structuredClone(state); });
  const access = (identity: Identity) => new Collaboration(core, identity, owner.email);
  const request = (identity: Identity, path: string, method = "GET", body?: object) =>
    api(core, () => {}, undefined, identity, undefined, access(identity)).request(path, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  return { core, access, request, saved: () => saved };
}
describe("verified account collaboration", () => {
  it("migrates old data only for configured owner and denies project access to other allowlisted identities", async () => {
    const f = fixture();
    const legacy = f.core.createThread("existing private work", "legacy");
    f.access(bryan).bootstrap();
    expect(f.core.state.collaboration).toBeUndefined();
    expect(await (await f.request(bryan, "/api/projects")).json()).toEqual([]);
    expect((await f.request(bryan, `/api/threads/${legacy.id}/messages`)).status).toBe(404);
    f.access(owner).bootstrap();
    expect(f.core.state.collaboration?.projectMembers[owner.actor].role).toBe("owner");
    expect(f.core.state.collaboration?.threadMembers[legacy.id][owner.actor].role).toBe("owner");
    expect((await f.request(owner, `/api/threads/${legacy.id}/messages`)).status).toBe(200);
    expect((await f.request(bryan, "/api/projects/pitcrew/context")).status).toBe(404);
    expect((await f.request(bryan, "/api/runs/guessed/evidence")).status).toBe(404);
    expect(f.saved().collaboration).toBeDefined();
  });
  it("binds project and thread invitations to verified email, rejects replay/expiry and filters private events", async () => {
    const f = fixture();
    f.access(owner).bootstrap();
    const created = await f.request(owner, "/api/projects/pitcrew/threads", "POST", {
      title: "private task", idempotencyKey: "task-1",
    });
    const thread = await created.json() as { id: string };
    expect(created.status).toBe(201);
    const projectInvite = await (await f.request(owner, "/api/projects/pitcrew/invitations", "POST", {
      email: bryan.email, role: "editor",
    })).json() as { token: string };
    expect((await f.request(other, `/api/invitations/${projectInvite.token}`)).status).toBe(404);
    expect((await f.request(other, `/api/invitations/${projectInvite.token}/accept`, "POST", {})).status).toBe(404);
    expect((await f.request(bryan, `/api/invitations/${projectInvite.token}/accept`, "POST", {})).status).toBe(200);
    expect((await f.request(bryan, `/api/invitations/${projectInvite.token}/accept`, "POST", {})).status).toBe(410);
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(404);
    expect(await (await f.request(bryan, "/api/projects/pitcrew/threads")).json()).toEqual([]);
    expect(await (await f.request(bryan, "/api/projects/pitcrew/events")).json()).toEqual(
      f.core.state.events.filter((event) => !event.provenance?.threadId),
    );
    const threadInvite = await (await f.request(owner, `/api/threads/${thread.id}/invitations`, "POST", {
      email: bryan.email, role: "editor",
    })).json() as { token: string };
    expect((await f.request(bryan, `/api/invitations/${threadInvite.token}/accept`, "POST", {})).status).toBe(200);
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(200);
    const expired = await (await f.request(owner, `/api/threads/${thread.id}/invitations`, "POST", {
      email: other.email, role: "editor",
    })).json() as { invitation: { id: string }; token: string };
    f.core.state.collaboration!.invitations[expired.invitation.id].expiresAt = "2020-01-01T00:00:00Z";
    expect((await f.request(other, `/api/invitations/${expired.token}/accept`, "POST", {})).status).toBe(410);
  });
  it("revocation is immediately enforced on reconnect and pending invitations", async () => {
    const f = fixture();
    f.access(owner).bootstrap();
    const thread = await (await f.request(owner, "/api/projects/pitcrew/threads", "POST", {
      title: "task", idempotencyKey: "task-2",
    })).json() as { id: string };
    const projectInvite = await (await f.request(owner, "/api/projects/pitcrew/invitations", "POST", {
      email: bryan.email, role: "editor",
    })).json() as { token: string };
    await f.request(bryan, `/api/invitations/${projectInvite.token}/accept`, "POST", {});
    const threadInvite = await (await f.request(owner, `/api/threads/${thread.id}/invitations`, "POST", {
      email: bryan.email, role: "editor",
    })).json() as { token: string };
    await f.request(bryan, `/api/invitations/${threadInvite.token}/accept`, "POST", {});
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(200);
    expect((await f.request(owner, `/api/projects/pitcrew/members/${encodeURIComponent(bryan.actor)}`, "DELETE")).status).toBe(200);
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(404);
    expect((await f.request(bryan, "/api/projects/pitcrew/events")).status).toBe(404);
    const pending = await (await f.request(owner, "/api/projects/pitcrew/invitations", "POST", {
      email: bryan.email, role: "editor",
    })).json() as { token: string };
    expect((await f.request(owner, `/api/invitations/${pending.token}/revoke`, "POST", {})).status).toBe(200);
    expect((await f.request(bryan, `/api/invitations/${pending.token}/accept`, "POST", {})).status).toBe(410);
  });
  it("serializes duplicate acceptance in durable state", async () => {
    const f = fixture();
    f.access(owner).bootstrap();
    const invite = await f.access(owner).invite("project", "pitcrew", bryan.email, "editor");
    const results = await Promise.allSettled([
      f.access(bryan).accept(invite.token), f.access(bryan).accept(invite.token),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(Object.values(f.core.state.collaboration!.projectMembers).filter((m) => m.actor === bryan.actor)).toHaveLength(1);
  });
  it("keeps an account-owned repository independent and persists shared notes across coordinator reloads", async () => {
    const f = fixture();
    f.access(owner).bootstrap();
    const project = f.core.addOwnedProject("pitcrew-test", "verified-source-id", owner.actor, owner.email);
    expect(project.id).not.toBe("pitcrew");
    expect(() => f.core.addOwnedProject("pitcrew-test", "verified-source-id", owner.actor, owner.email))
      .toThrow("repository_already_registered");
    const open = () => new Coordinator(f.core.state.ownedProjects![project.id].state,
      (state) => f.core.updateOwnedProject(project.id, state));
    const repo = open();
    const repoAccess = new Collaboration(repo, owner, owner.email);
    const thread = repo.createThread("shared task", "task", owner.actor, owner.email);
    const note = repo.appendNote(thread.id, "Let's plan the change", "note-1", owner.actor);
    expect(open().state.messages).toContainEqual(note);
    expect(f.core.state.messages).toEqual([]);
    expect(new Collaboration(open(), bryan, owner.email).projectRole()).toBeUndefined();
    const invitation = await repoAccess.invite("project", project.id, bryan.email, "editor");
    await new Collaboration(open(), bryan, owner.email).accept(invitation.token);
    expect(new Collaboration(open(), bryan, owner.email).projectRole()).toBe("editor");
    expect(new Collaboration(open(), bryan, owner.email).visibleThread(thread.id)).toBe(false);
  });
});
