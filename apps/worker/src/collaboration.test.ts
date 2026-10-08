import { describe, expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration, type Identity } from "./collaboration";
import { Coordinator, initialState } from "./coordinator";

const owner: Identity = { actor: "access:owner-sub", email: "dev@lilfrogdev.com" };
const bryan: Identity = { actor: "access:bryan-sub", email: "bryan.aldair.zamora@gmail.com" };
const other: Identity = { actor: "access:other-sub", email: "other@example.com" };
function fixture() {
  let saved = initialState();
  const core = new Coordinator(saved, (state) => {
    saved = structuredClone(state);
  });
  const access = (identity: Identity) => new Collaboration(core, identity, owner.email);
  const request = (identity: Identity, path: string, method = "GET", body?: object) =>
    api(core, () => {}, undefined, identity, undefined, access(identity)).request(path, {
      method,
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
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
      title: "private task",
      idempotencyKey: "task-1",
    });
    const thread = (await created.json()) as { id: string };
    expect(created.status).toBe(201);
    const projectInvite = (await (
      await f.request(owner, "/api/projects/pitcrew/invitations", "POST", {
        email: bryan.email,
        role: "editor",
      })
    ).json()) as { token: string };
    expect((await f.request(other, `/api/invitations/${projectInvite.token}`)).status).toBe(404);
    expect(
      (await f.request(other, `/api/invitations/${projectInvite.token}/accept`, "POST", {})).status,
    ).toBe(404);
    expect(
      (await f.request(bryan, `/api/invitations/${projectInvite.token}/accept`, "POST", {})).status,
    ).toBe(200);
    expect(
      (await f.request(bryan, `/api/invitations/${projectInvite.token}/accept`, "POST", {})).status,
    ).toBe(410);
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(404);
    expect(await (await f.request(bryan, "/api/projects/pitcrew/threads")).json()).toEqual([]);
    expect(await (await f.request(bryan, "/api/projects/pitcrew/events")).json()).toEqual(
      f.core.state.events.filter((event) => !event.provenance?.threadId),
    );
    const threadInvite = (await (
      await f.request(owner, `/api/threads/${thread.id}/invitations`, "POST", {
        email: bryan.email,
        role: "editor",
      })
    ).json()) as { token: string };
    expect(
      (await f.request(bryan, `/api/invitations/${threadInvite.token}/accept`, "POST", {})).status,
    ).toBe(200);
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(200);
    const expired = (await (
      await f.request(owner, `/api/threads/${thread.id}/invitations`, "POST", {
        email: other.email,
        role: "editor",
      })
    ).json()) as { invitation: { id: string }; token: string };
    f.core.state.collaboration!.invitations[expired.invitation.id].expiresAt =
      "2020-01-01T00:00:00Z";
    expect(
      (await f.request(other, `/api/invitations/${expired.token}/accept`, "POST", {})).status,
    ).toBe(410);
  });
  it("revocation is immediately enforced on reconnect and pending invitations", async () => {
    const f = fixture();
    f.access(owner).bootstrap();
    const thread = (await (
      await f.request(owner, "/api/projects/pitcrew/threads", "POST", {
        title: "task",
        idempotencyKey: "task-2",
      })
    ).json()) as { id: string };
    const projectInvite = (await (
      await f.request(owner, "/api/projects/pitcrew/invitations", "POST", {
        email: bryan.email,
        role: "editor",
      })
    ).json()) as { token: string };
    await f.request(bryan, `/api/invitations/${projectInvite.token}/accept`, "POST", {});
    const threadInvite = (await (
      await f.request(owner, `/api/threads/${thread.id}/invitations`, "POST", {
        email: bryan.email,
        role: "editor",
      })
    ).json()) as { token: string };
    await f.request(bryan, `/api/invitations/${threadInvite.token}/accept`, "POST", {});
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(200);
    expect(
      (
        await f.request(
          owner,
          `/api/projects/pitcrew/members/${encodeURIComponent(bryan.actor)}`,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await f.request(bryan, `/api/threads/${thread.id}/messages`)).status).toBe(404);
    expect((await f.request(bryan, "/api/projects/pitcrew/events")).status).toBe(404);
    const pending = (await (
      await f.request(owner, "/api/projects/pitcrew/invitations", "POST", {
        email: bryan.email,
        role: "editor",
      })
    ).json()) as { token: string };
    expect(
      (await f.request(owner, `/api/invitations/${pending.token}/revoke`, "POST", {})).status,
    ).toBe(200);
    expect(
      (await f.request(bryan, `/api/invitations/${pending.token}/accept`, "POST", {})).status,
    ).toBe(410);
  });
  it("serializes duplicate acceptance in durable state", async () => {
    const f = fixture();
    f.access(owner).bootstrap();
    const invite = await f.access(owner).invite("project", "pitcrew", bryan.email, "editor");
    const results = await Promise.allSettled([
      f.access(bryan).accept(invite.token),
      f.access(bryan).accept(invite.token),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      Object.values(f.core.state.collaboration!.projectMembers).filter(
        (m) => m.actor === bryan.actor,
      ),
    ).toHaveLength(1);
  });
  it("keeps an account-owned repository independent and persists shared notes across coordinator reloads", async () => {
    const f = fixture();
    f.access(owner).bootstrap();
    const project = f.core.addOwnedProject(
      "pitcrew-test",
      "verified-source-id",
      owner.actor,
      owner.email,
    );
    expect(project.id).not.toBe("pitcrew");
    expect(() =>
      f.core.addOwnedProject("pitcrew-test", "verified-source-id", owner.actor, owner.email),
    ).toThrow("repository_already_registered");
    const open = () =>
      new Coordinator(f.core.state.ownedProjects![project.id].state, (state) =>
        f.core.updateOwnedProject(project.id, state),
      );
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

it("revokes duplicate thread invitations with membership and preserves the event cursor across hidden work", async () => {
  const f = fixture();
  f.access(owner).bootstrap();
  const thread = f.core.createThread("private task", "private", owner.actor, owner.email);
  await f
    .access(bryan)
    .accept((await f.access(owner).invite("project", "pitcrew", bryan.email, "editor")).token);
  const first = await f.access(owner).invite("thread", thread.id, bryan.email, "editor");
  await f.access(bryan).accept(first.token);
  const duplicate = await f.access(owner).invite("thread", thread.id, bryan.email, "editor");
  f.access(owner).remove("thread", thread.id, bryan.actor);
  await expect(f.access(bryan).accept(duplicate.token)).rejects.toThrow("invitation_unavailable");
  f.core.appendNote(thread.id, "private note", "hidden", owner.actor, owner);
  const events = await f.request(bryan, "/api/projects/pitcrew/events");
  expect(events.headers.get("X-Next-Sequence")).toBe(String(f.core.state.events.at(-1)!.sequence));
  expect(JSON.stringify(await events.json())).not.toContain(thread.id);
});

it("denies writes revoked during request streaming and async profile validation", async () => {
  const f = fixture();
  f.access(owner).bootstrap();
  await f
    .access(bryan)
    .accept((await f.access(owner).invite("project", "pitcrew", bryan.email, "editor")).token);
  const thread = f.core.createThread("shared", "stream", owner.actor, owner.email);
  await f
    .access(bryan)
    .accept((await f.access(owner).invite("thread", thread.id, bryan.email, "editor")).token);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => (release = resolve));
  const app = api(f.core, () => {}, undefined, bryan, undefined, f.access(bryan), true);
  const stream = new ReadableStream({
    async start(controller) {
      await paused;
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ content: "revoked message", idempotencyKey: "streamed" }),
        ),
      );
      controller.close();
    },
  });
  const pending = app.request(`/api/threads/${thread.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  f.access(owner).remove("thread", thread.id, bryan.actor);
  release();
  expect((await pending).status).toBe(404);
  expect(f.core.state.messages).toEqual([]);
  const old = f.core.profile();
  await expect(
    f.core.updateProfile({ ...old, revision: "revoked-update" }, old.revision, () => {
      f.access(owner).remove("project", "pitcrew", bryan.actor);
      f.access(bryan).requireProject("pitcrew");
    }),
  ).rejects.toThrow("not_found");
  expect(f.core.profile().revision).toBe(old.revision);
});

it("hides private worker knowledge in API context, events and frozen execution context", async () => {
  const f = fixture();
  f.access(owner).bootstrap();
  await f
    .access(bryan)
    .accept((await f.access(owner).invite("project", "pitcrew", bryan.email, "editor")).token);
  const privateThread = f.core.createThread("private", "private-task", owner.actor, owner.email);
  const run = f.core.submit(
    privateThread.id,
    "private task marker",
    "private-run",
    owner.actor,
    undefined,
    owner,
  ).run;
  const input = f.core.begin(run.id)!;
  expect(
    f.core.appendWorkerKnowledge(input.knowledgeContext!, {
      key: "private-discovery",
      text: "private knowledge marker",
      kind: "constraint",
      sourceRefs: [{ kind: "code", id: "file.ts" }],
    }).status,
  ).toBe("recorded");
  const ownThread = f.core.createThread("Bryan task", "bryan-task", bryan.actor, bryan.email);
  const ownRun = f.core.submit(
    ownThread.id,
    "own work",
    "own-run",
    bryan.actor,
    undefined,
    bryan,
  ).run;
  for (const value of [
    await (await f.request(bryan, "/api/projects/pitcrew/context")).json(),
    await (await f.request(bryan, "/api/projects/pitcrew/events")).json(),
    f.core.begin(ownRun.id),
    f.core.refreshWorkerKnowledge(f.core.begin(ownRun.id)!.knowledgeContext!),
  ]) {
    expect(JSON.stringify(value)).not.toContain("private knowledge marker");
    expect(JSON.stringify(value)).not.toContain("private task marker");
  }
  expect(() =>
    f.core.appendKnowledge(bryan.actor, "guess", {
      id: `worker:${run.id}:private-discovery`,
      expectedVersion: 1,
      status: "accepted",
      text: "stolen decision",
      kind: "constraint",
      sourceRefs: [{ kind: "code", id: "file.ts" }],
      reason: "test",
    }),
  ).toThrow("not_found");
  expect(f.core.runAuthorized(ownRun.id)).toBe(true);
  f.access(owner).remove("project", "pitcrew", bryan.actor);
  expect(f.core.runAuthorized(ownRun.id)).toBe(false);
});

it("migrates legacy reconnect idempotency only to the verified owner without duplicate tasks", async () => {
  const { resolveCatalog } = await import("./model-selection");
  const catalog = resolveCatalog({ MODEL_CONFIGURATION: '{"provider":"fake"}' });
  const core = new Coordinator(initialState(), () => {});
  const thread = core.createThread("legacy", "thread-key", owner.actor);
  const original = core.queueTurn(thread.id, "legacy task", "turn-key", owner.actor, catalog);
  for (const [kind, key] of [
    ["thread", "thread-key"],
    ["conversation", "turn-key"],
  ]) {
    core.state.keys[`${kind}_${key}`] =
      core.state.keys[`${kind}_${JSON.stringify([owner.actor, key])}`];
    delete core.state.keys[`${kind}_${JSON.stringify([owner.actor, key])}`];
  }
  const reloaded = new Coordinator(structuredClone(core.state), () => {});
  new Collaboration(reloaded, bryan, owner.email).bootstrap();
  expect(reloaded.state.collaboration).toBeUndefined();
  new Collaboration(reloaded, owner, owner.email).bootstrap();
  expect(reloaded.createThread("legacy", "thread-key", owner.actor, owner.email).id).toBe(
    thread.id,
  );
  expect(
    reloaded.queueTurn(thread.id, "legacy task", "turn-key", owner.actor, catalog).turn.id,
  ).toBe(original.turn.id);
  expect(reloaded.state.conversationTurns).toHaveLength(1);
  expect(reloaded.state.threads).toHaveLength(1);
});

it("owner invitation metadata omits secrets and ID revoke blocks acceptance; editors cannot manage invitations", async () => {
  const f = fixture();
  f.access(owner).bootstrap();
  const invite = await f.access(owner).invite("project", "pitcrew", bryan.email, "editor");
  const list = await f.request(owner, "/api/projects/pitcrew/invitations");
  expect(list.status).toBe(200);
  const serialized = await list.text();
  expect(serialized).not.toContain(invite.token);
  expect(serialized).not.toContain("digest");
  expect(serialized).toContain(invite.invitation.id);
  expect(
    (
      await f.request(
        other,
        `/api/projects/pitcrew/invitations/${invite.invitation.id}/revoke`,
        "POST",
        {},
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        owner,
        `/api/projects/pitcrew/invitations/${invite.invitation.id}/revoke`,
        "POST",
        {},
      )
    ).status,
  ).toBe(200);
  await expect(f.access(bryan).accept(invite.token)).rejects.toMatchObject({ status: 410 });
  const editorInvite = await f.access(owner).invite("project", "pitcrew", bryan.email, "editor");
  await f.access(bryan).accept(editorInvite.token);
  const thread = f.core.createThread(
    "Editor-created thread",
    "editor-thread",
    bryan.actor,
    bryan.email,
  );
  await expect(
    f.access(bryan).invite("thread", thread.id, other.email, "editor"),
  ).rejects.toMatchObject({ status: 403 });
  expect((await f.request(bryan, "/api/projects/pitcrew/invitations")).status).toBe(403);
});

it("frozen projects deny invitation links, thread reads, writes and idempotent replays while retaining historical records", async () => {
  const f = fixture();
  f.access(owner).bootstrap();
  const thread = f.core.createThread("Retained history", "history", owner.actor, owner.email);
  const note = f.core.appendNote(thread.id, "retained note", "original-note", owner.actor);
  const invite = await f.access(owner).invite("project", "pitcrew", bryan.email, "editor");
  f.core.freezeRepository("deleting");
  expect(f.saved().messages).toContainEqual(note);
  expect(f.saved().collaboration!.invitations[invite.invitation.id].revokedAt).toBeDefined();
  expect((await f.request(owner, `/api/threads/${thread.id}/messages`)).status).toBe(404);
  await expect(f.access(bryan).accept(invite.token)).rejects.toMatchObject({ status: 404 });
  expect(() => f.core.appendNote(thread.id, "retained note", "original-note", owner.actor)).toThrow(
    "not_found",
  );
  expect(() => f.core.createThread("new", "new", owner.actor, owner.email)).toThrow("not_found");
  expect(f.core.actorAuthorized(owner.actor, thread.id)).toBe(false);
  f.core.freezeRepository("deleted");
  f.core.freezeRepository("deleting");
  expect(f.saved().repositoryLifecycle).toBe("deleted");
});
