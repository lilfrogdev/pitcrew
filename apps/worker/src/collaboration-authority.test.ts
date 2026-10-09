import { describe, expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration, type CollaborationAuthority, type Identity } from "./collaboration";
import { AdmissionError, Coordinator, initialState } from "./coordinator";

const owner: Identity = { actor: "account:owner", email: "owner@example.test", username: "owner" };
const recipient: Identity = {
  actor: "account:recipient",
  email: "recipient@example.test",
  username: "old_label",
};
async function fixture() {
  const core = new Coordinator(initialState(), () => {});
  const access = (identity: Identity) =>
    new Collaboration(core, identity, owner.email, {
      resolveRecipient: async () => ({ actor: recipient.actor, recipient: "@old_label" }),
      requireSession: async () => {},
    });
  access(owner).bootstrap();
  const thread = core.createThread("Shared", "shared", owner.actor, owner.email);
  const invitation = await access(owner).invite(
    "project",
    core.state.project.id,
    recipient.email,
    "editor",
  );
  const request = (identity: Identity, authority: CollaborationAuthority) =>
    api(
      core,
      () => {},
      undefined,
      identity,
      undefined,
      access(identity),
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authority,
    );
  return { core, access, thread, invitation, request };
}

describe("collaboration session authority", () => {
  it("reads a bounded caller body before checking session authority and cannot accept after revocation", async () => {
    const f = await fixture();
    const before = structuredClone(f.core.state);
    let release!: () => void,
      checked = false;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await paused;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const pending = f
      .request(recipient, async () => {
        checked = true;
        throw new AdmissionError("unauthorized", 401);
      })
      .request(`/api/invitations/${f.invitation.token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checked).toBe(false);
    expect(f.core.state).toEqual(before);
    release();
    expect((await pending).status).toBe(401);
    expect(checked).toBe(true);
    expect(f.core.state).toEqual(before);
  });

  it("accepts only fresh server profile metadata for the same account and recipient identifier", async () => {
    const f = await fixture();
    const fresh = {
      ...recipient,
      email: "changed@example.test",
      username: "latest_label",
      displayName: "Latest Name",
    };
    const response = await f
      .request(recipient, async (operation) => operation(fresh))
      .request(`/api/invitations/${f.invitation.token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    expect(response.status).toBe(200);
    expect(f.core.state.collaboration!.projectMembers[recipient.actor]).toEqual({
      ...fresh,
      role: "editor",
    });
    expect(f.core.state.collaboration!.invitations[f.invitation.invitation.id].acceptedBy).toBe(
      recipient.actor,
    );
    const mismatch = await fixture();
    const denied = await mismatch
      .request(recipient, async (operation) => operation({ ...fresh, actor: owner.actor }))
      .request(`/api/invitations/${mismatch.invitation.token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    expect(denied.status).toBe(404);
    expect(mismatch.core.state.collaboration!.projectMembers[recipient.actor]).toBeUndefined();
  });

  it("guards invitation creation, revocation and member removal before durable effects", async () => {
    const f = await fixture();
    f.core.updateCollaboration((state) => {
      state.collaboration!.projectMembers[recipient.actor] = { ...recipient, role: "editor" };
      state.collaboration!.threadMembers[f.thread.id][recipient.actor] = {
        ...recipient,
        role: "editor",
      };
    });
    const before = structuredClone(f.core.state);
    let checked = 0;
    const request = f.request(owner, async () => {
      checked++;
      throw new AdmissionError("unauthorized", 401);
    });
    for (const [path, method, body] of [
      [
        `/api/projects/${f.core.state.project.id}/invitations`,
        "POST",
        { email: recipient.email, role: "editor" },
      ],
      [
        `/api/threads/${f.thread.id}/invitations`,
        "POST",
        { email: recipient.email, role: "editor" },
      ],
      [`/api/invitations/${f.invitation.token}/revoke`, "POST", {}],
      [
        `/api/projects/${f.core.state.project.id}/members/${encodeURIComponent(recipient.actor)}`,
        "DELETE",
        undefined,
      ],
      [
        `/api/threads/${f.thread.id}/members/${encodeURIComponent(recipient.actor)}`,
        "DELETE",
        undefined,
      ],
    ] as const) {
      const response = await request.request(path, {
        method,
        ...(body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      expect(response.status).toBe(401);
      expect(f.core.state).toEqual(before);
    }
    expect(checked).toBe(5);
  });
});

it("rejects actor injection into invitation issuance and acceptance without durable effects", async () => {
  const f = await fixture();
  const before = structuredClone(f.core.state);
  const authority: CollaborationAuthority = async (operation) => operation(owner);
  for (const body of [
    { recipient: "old_label", role: "editor", recipientActor: owner.actor },
    { recipient: "old_label", email: recipient.email, role: "editor" },
    { recipient: "old_label", role: "editor", digest: "forged" },
  ]) {
    const response = await f
      .request(owner, authority)
      .request("/api/projects/pitcrew/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(response.status).toBe(400);
  }
  const response = await f
    .request(recipient, async (operation) => operation(recipient))
    .request(`/api/invitations/${f.invitation.token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: owner.actor }),
    });
  expect(response.status).toBe(400);
  expect(f.core.state).toEqual(before);
});

it("rechecks the original session and owner role after asynchronous account resolution", async () => {
  const f = await fixture();
  const before = structuredClone(f.core.state);
  let checked = false;
  const expired = new Collaboration(f.core, owner, owner.email, {
    resolveRecipient: async () => ({ actor: recipient.actor, recipient: "@old_label" }),
    requireSession: async () => {
      checked = true;
      throw new AdmissionError("unauthorized", 401);
    },
  });
  await expect(expired.invite("project", "pitcrew", "old_label", "editor")).rejects.toMatchObject({
    status: 401,
  });
  expect(checked).toBe(true);
  expect(f.core.state).toEqual(before);
  const revoked = new Collaboration(f.core, owner, owner.email, {
    resolveRecipient: async () => {
      f.core.state.collaboration!.projectMembers[owner.actor].role = "editor";
      return { actor: recipient.actor, recipient: "@old_label" };
    },
    requireSession: async () => {},
  });
  await expect(revoked.invite("project", "pitcrew", "old_label", "editor")).rejects.toMatchObject({
    status: 403,
  });
  expect(Object.keys(f.core.state.collaboration!.invitations)).toHaveLength(1);
});

it("does not let a renamed/reassigned selector or native unverified email claim inherit a token", async () => {
  const f = await fixture();
  expect(f.invitation.invitation).toMatchObject({ recipient: "@old_label" });
  expect(f.invitation.invitation).not.toHaveProperty("email");
  expect(f.invitation.invitation).not.toHaveProperty("recipientActor");
  expect(f.invitation.invitation).not.toHaveProperty("digest");
  const replacement = { ...recipient, actor: "account:replacement" };
  await expect(f.access(replacement).accept(f.invitation.token)).rejects.toMatchObject({
    status: 404,
  });
  const legacy = new Collaboration(f.core, { ...owner, actor: "access:legacy" }, owner.email);
  f.core.state.collaboration!.projectMembers["access:legacy"] = {
    ...owner,
    actor: "access:legacy",
    role: "owner",
  };
  const emailOnly = await legacy.invite("project", "pitcrew", recipient.email, "editor");
  await expect(f.access(recipient).accept(emailOnly.token)).rejects.toMatchObject({ status: 410 });
  expect(f.core.state.collaboration!.projectMembers[recipient.actor]).toBeUndefined();
  expect(
    f.core.state.collaboration!.invitations[emailOnly.invitation.id].recipientActor,
  ).toBeUndefined();
});

it("native thread invitation requires project membership and grants no sibling thread", async () => {
  const f = await fixture();
  await expect(
    f.access(owner).invite("thread", f.thread.id, "old_label", "editor"),
  ).rejects.toMatchObject({ code: "recipient_unavailable" });
  await f.access(recipient).accept(f.invitation.token);
  const sibling = f.core.createThread("Private", "private", owner.actor, owner.email);
  const invite = await f.access(owner).invite("thread", f.thread.id, "@OLD_LABEL", "editor");
  await f.access(recipient).accept(invite.token);
  expect(f.access(recipient).visibleThread(f.thread.id)).toBe(true);
  expect(f.access(recipient).visibleThread(sibling.id)).toBe(false);
  await expect(
    f.access(owner).invite("thread", f.thread.id, "old_label", "editor"),
  ).rejects.toMatchObject({ status: 409 });
});

it("pending thread invitations require the inviter to remain a current project owner", async () => {
  const f = await fixture();
  await f.access(recipient).accept(f.invitation.token);
  const token = (await f.access(owner).invite("thread", f.thread.id, "old_label", "editor")).token;
  f.core.state.collaboration!.projectMembers[owner.actor].role = "editor";
  expect(f.core.state.collaboration!.threadMembers[f.thread.id][owner.actor].role).toBe("owner");
  await expect(f.access(recipient).accept(token)).rejects.toMatchObject({ status: 410 });
  expect(f.core.state.collaboration!.threadMembers[f.thread.id][recipient.actor]).toBeUndefined();
});

it("member removal revokes pending account-bound tokens after an email change", async () => {
  const f = await fixture();
  await f.access(recipient).accept(f.invitation.token);
  const first = await f.access(owner).invite("thread", f.thread.id, "old_label", "editor");
  const pending = await f.access(owner).invite("thread", f.thread.id, "old_label", "editor");
  const fresh = { ...recipient, email: "new-email@example.test", username: "new_label" };
  await f.access(fresh).accept(first.token);
  f.access(owner).remove("thread", f.thread.id, recipient.actor);
  expect(f.core.state.collaboration!.invitations[pending.invitation.id].revokedAt).toBeDefined();
  await expect(f.access(fresh).accept(pending.token)).rejects.toMatchObject({ status: 410 });
});

it("acceptance and token revocation recheck the original session after hashing before writes", async () => {
  const f = await fixture();
  const before = structuredClone(f.core.state);
  const expired = (identity: Identity) =>
    new Collaboration(f.core, identity, owner.email, {
      resolveRecipient: async () => ({ actor: recipient.actor, recipient: "@old_label" }),
      requireSession: async () => {
        throw new AdmissionError("unauthorized", 401);
      },
    });
  await expect(expired(recipient).accept(f.invitation.token)).rejects.toMatchObject({
    status: 401,
  });
  await expect(expired(owner).revoke(f.invitation.token)).rejects.toMatchObject({ status: 401 });
  expect(f.core.state).toEqual(before);
});
