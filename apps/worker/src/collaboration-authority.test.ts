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
  const access = (identity: Identity) => new Collaboration(core, identity, owner.email);
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
    const fresh = { ...recipient, username: "latest_label", displayName: "Latest Name" };
    const response = await f
      .request(recipient, async (operation) => operation(fresh))
      .request(`/api/invitations/${f.invitation.token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: owner, username: "forged" }),
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
