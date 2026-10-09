import { expect, it } from "vite-plus/test";
import {
  sharingFixture,
  issuerEmail,
  recipientEmail,
  recipientUsername,
  readyCreation,
} from "./repository-management-sharing-harness";

type Fixture = Awaited<ReturnType<typeof sharingFixture>>;
type Invitation = {
  id: string;
  recipient?: string;
  email?: string;
  projectId: string;
  scope: string;
  threadId?: string;
  acceptedBy?: string;
  revokedAt?: string;
};
type Issued = { token: string; invitation: Invitation };
const projectInvites = (f: Fixture) => `/projects/${f.ownedRepository.projectId}/invitations`;
const acceptPath = (token: string) => `/invitations/${token}/accept`;
async function issued(f: Fixture, path: string, selector: string, legacy = false) {
  const response = await f.owner(
    path,
    legacy ? { email: selector, role: "editor" } : { recipient: selector, role: "editor" },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  const value = (await response.json()) as Issued;
  expect(value.token).toMatch(/^[a-f0-9]{64}$/);
  expect(value.invitation).not.toHaveProperty("recipientActor");
  expect(value.invitation).not.toHaveProperty("digest");
  expect(value.invitation).not.toHaveProperty("email");
  return value;
}
async function projectGrant(f: Fixture, selector = recipientUsername, legacy = false) {
  const invite = await issued(f, projectInvites(f), selector, legacy);
  const accepted = await f.john(acceptPath(invite.token), {});
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  expect(await accepted.json()).toMatchObject({
    id: invite.invitation.id,
    acceptedBy: f.recipientActor,
  });
  return invite;
}
async function projectState(f: Fixture) {
  return (await f.repository.storedState()).ownedProjects![f.ownedRepository.projectId].state;
}
async function waitLookup(f: Fixture) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await f.repository.recipientLookupEntered()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("real_d1_recipient_lookup_not_reached");
}
async function close(f: Fixture) {
  await f.repository.releaseRecipientLookup();
  await f.repository.releaseTransport();
  await f.mf.dispose();
}

it("a username invite resolves John to a stable native account and acceptance opens the actual repository directory without granting private threads", async () => {
  const f = await sharingFixture();
  try {
    const thread = await f.makeThread();
    expect(await (await f.john("/repositories")).json()).toMatchObject({ repositories: [] });
    const invite = await issued(f, projectInvites(f), "@JoHnCeNa");
    expect(invite.invitation).toMatchObject({
      recipient: "@johncena",
      scope: "project",
      projectId: f.ownedRepository.projectId,
    });
    const stored = (await projectState(f)).collaboration!.invitations[
      invite.invitation.id
    ] as unknown as { recipientActor: string; digest: string };
    expect(stored.recipientActor).toBe(f.recipientActor);
    expect(stored.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(await projectState(f))).not.toContain(invite.token);
    expect((await f.john(`/invitations/${invite.token}`)).status).toBe(200);
    expect((await f.john(acceptPath(invite.token), {})).status).toBe(200);
    const directory = (await (await f.john("/repositories")).json()) as {
      repositories: { projectId: string; role: string; repositoryId: string }[];
    };
    expect(directory.repositories).toContainEqual(
      expect.objectContaining({
        projectId: f.ownedRepository.projectId,
        repositoryId: f.ownedRepository.repositoryId,
        role: "editor",
      }),
    );
    expect((await f.john(`/projects/${f.ownedRepository.projectId}/context`)).status).toBe(200);
    expect(await (await f.john(`/projects/${f.ownedRepository.projectId}/threads`)).json()).toEqual(
      [],
    );
    expect((await f.john(`/threads/${thread.id}/messages`)).status).toBe(404);
    expect((await f.john(`/threads/${thread.id}/source/tree`)).status).toBe(404);
    expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor]).toMatchObject({
      actor: f.recipientActor,
      username: "johncena",
      role: "editor",
    });
    expect((await f.john(acceptPath(invite.token), {})).status).toBe(410);
  } finally {
    await close(f);
  }
}, 90000);

it("email and legacy email-selector bodies use the same stable account resolution while preserving unverified native email state", async () => {
  for (const legacy of [false, true]) {
    const f = await sharingFixture();
    try {
      const before = await f.db.prepare("SELECT id,email_verified FROM user ORDER BY id").all();
      expect(before.results).toHaveLength(2);
      expect(before.results.every((user) => user.email_verified === 0)).toBe(true);
      const invite = await issued(f, projectInvites(f), recipientEmail.toUpperCase(), legacy);
      expect(invite.invitation.recipient).toBe(recipientEmail);
      expect(
        (await projectState(f)).collaboration!.invitations[invite.invitation.id],
      ).toMatchObject({ recipientActor: f.recipientActor });
      expect((await f.john(acceptPath(invite.token), {})).status).toBe(200);
      expect(
        await f.db.prepare("SELECT id,email_verified FROM user ORDER BY id").all(),
      ).toMatchObject({ results: before.results });
      expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor].actor).toBe(
        f.recipientActor,
      );
      expect((await f.john(`/projects/${f.ownedRepository.projectId}/context`)).status).toBe(200);
    } finally {
      await close(f);
    }
  }
}, 90000);

it("an outsider cannot receive thread-only membership until explicit repository acceptance, and subsequent thread sharing grants only the selected thread", async () => {
  for (const selector of [recipientEmail, "@JoHnCeNa"]) {
    const f = await sharingFixture();
    try {
      const first = await f.makeThread("Shared target");
      const sibling = await f.makeThread("Owner private sibling");
      const before = await projectState(f);
      const outsider = await f.owner(`/threads/${first.id}/invitations`, {
        recipient: "johncena",
        role: "editor",
      });
      expect(outsider.status, await outsider.clone().text()).toBe(400);
      expect(await outsider.json()).toEqual({ error: "recipient_unavailable" });
      expect(await projectState(f)).toEqual(before);
      expect(await (await f.john("/repositories")).json()).toMatchObject({ repositories: [] });
      await projectGrant(f);
      const existingProjectMembers = (await projectState(f)).collaboration!.projectMembers;
      const invite = await issued(f, `/threads/${first.id}/invitations`, selector);
      expect(invite.invitation).toMatchObject({
        recipient: selector === recipientEmail ? recipientEmail : "@johncena",
        scope: "thread",
        threadId: first.id,
      });
      expect((await f.john(acceptPath(invite.token), {})).status).toBe(200);
      expect((await projectState(f)).collaboration!.projectMembers).toEqual(existingProjectMembers);
      const visible = (await (
        await f.john(`/projects/${f.ownedRepository.projectId}/threads`)
      ).json()) as { id: string }[];
      expect(visible.map((thread) => thread.id)).toEqual([first.id]);
      expect((await f.john(`/threads/${first.id}/messages`)).status).toBe(200);
      for (const suffix of ["messages", "members", "presence", "source/tree"])
        expect((await f.john(`/threads/${sibling.id}/${suffix}`)).status).toBe(404);
      const note = await f.john(`/threads/${first.id}/messages`, {
        content: "Real synthetic recipient note",
        idempotencyKey: "recipient-note",
        author: { actor: f.issuerActor, username: "forged" },
      });
      expect(note.status).toBe(201);
      const messages = (await (await f.owner(`/threads/${first.id}/messages`)).json()) as {
        author: { actor: string; username: string };
      }[];
      expect(messages[0].author).toMatchObject({ actor: f.recipientActor, username: "johncena" });
    } finally {
      await close(f);
    }
  }
}, 90000);

it("username rename and reuse do not retarget a pending invitation, and acceptance records the current caller labels", async () => {
  const f = await sharingFixture();
  try {
    const invite = await issued(f, projectInvites(f), "johncena");
    expect(
      (await f.john("/auth/update-user", { username: "renamed_john", name: "Current John label" }))
        .status,
    ).toBe(200);
    expect(
      (await f.owner("/auth/update-user", { username: "johncena", name: "Distinct issuer" }))
        .status,
    ).toBe(200);
    expect((await f.owner(acceptPath(invite.token), {})).status).toBe(404);
    expect((await f.john(acceptPath(invite.token), {})).status).toBe(200);
    expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor]).toMatchObject({
      actor: f.recipientActor,
      username: "renamed_john",
      displayName: "Current John label",
      role: "editor",
    });
    expect((await projectState(f)).collaboration!.projectMembers[f.issuerActor].role).toBe("owner");
    const self = await f.owner(projectInvites(f), { recipient: "johncena", role: "editor" });
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ error: "already_member" });
  } finally {
    await close(f);
  }
}, 90000);

it("email reassignment between two synthetic native accounts cannot move a pending invitation to the account reusing the old address", async () => {
  const f = await sharingFixture();
  try {
    const invite = await issued(f, projectInvites(f), recipientEmail);
    // Trusted local D1 setup models persisted address changes. Both accounts keep
    // their genuine enrollment eligibility and original stable account IDs.
    await f.syntheticEmailChange(f.recipientActor, "bryan.aldair.zamora@gmail.com");
    await f.syntheticEmailChange(f.issuerActor, recipientEmail);
    expect(await (await f.john("/account")).json()).toMatchObject({
      actor: f.recipientActor,
      email: "bryan.aldair.zamora@gmail.com",
    });
    expect(await (await f.owner("/account")).json()).toMatchObject({
      actor: f.issuerActor,
      email: recipientEmail,
    });
    expect((await f.owner(acceptPath(invite.token), {})).status).toBe(404);
    expect((await f.john(acceptPath(invite.token), {})).status).toBe(200);
    expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor]).toMatchObject({
      actor: f.recipientActor,
      email: "bryan.aldair.zamora@gmail.com",
    });
    expect(
      (await f.owner(projectInvites(f), { recipient: recipientEmail, role: "editor" })).status,
    ).toBe(409);
    const verified = await f.db.prepare("SELECT email_verified FROM user").all();
    expect(verified.results.every((user) => user.email_verified === 0)).toBe(true);
  } finally {
    await close(f);
  }
}, 90000);

it("strict native invite bodies reject caller-selected principals and return generic errors for unknown accounts and prevent ambiguous usernames", async () => {
  const f = await sharingFixture();
  try {
    const before = await projectState(f);
    for (const body of [
      { recipient: "johncena", role: "editor", actor: f.recipientActor },
      { recipient: "johncena", role: "editor", recipientActor: f.recipientActor },
      { recipient: "johncena", email: recipientEmail, role: "editor" },
      { recipient: "johncena", role: "editor", token: "typed-secret" },
    ]) {
      const response = await f.owner(projectInvites(f), body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    for (const recipient of ["unknown_account", "nobody@example.test"]) {
      const response = await f.owner(projectInvites(f), { recipient, role: "editor" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "recipient_unavailable" });
    }
    for (const recipient of ["two words", "@@johncena", "a", "a".repeat(255), null, []]) {
      const response = await f.owner(projectInvites(f), { recipient, role: "editor" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_recipient" });
    }
    expect(
      (await f.john(projectInvites(f), { recipient: "repository_owner", role: "editor" })).status,
    ).toBe(404);
    expect(await projectState(f)).toEqual(before);
    // The actual normalized D1 index prevents ambiguous native usernames.
    await expect(
      f.db
        .prepare("UPDATE user SET username=? WHERE id=?")
        .bind("JOHNCENA", f.issuerActor.slice(8))
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    const users = await f.db
      .prepare("SELECT username FROM user WHERE lower(username)=?")
      .bind("johncena")
      .all();
    expect(users.results).toEqual([{ username: "johncena" }]);
    expect(Object.keys((await projectState(f)).collaboration!.invitations)).toHaveLength(0);
  } finally {
    await close(f);
  }
}, 90000);

it("guessed tokens and another native actor cannot accept or redirect a token, and safe owner revocation prevents later acceptance", async () => {
  const f = await sharingFixture();
  try {
    const invite = await issued(f, projectInvites(f), "johncena");
    const before = await projectState(f);
    expect((await f.john(acceptPath("0".repeat(64)), {})).status).toBe(404);
    expect(
      (
        await f.owner(
          acceptPath(invite.token),
          {},
          {
            "x-pitcrew-actor": f.recipientActor,
          },
        )
      ).status,
    ).toBe(404);
    const injection = await f.owner(acceptPath(invite.token), {
      actor: f.recipientActor,
    });
    expect(injection.status).toBe(400);
    expect(await injection.json()).toEqual({ error: "invalid_request" });
    expect(await projectState(f)).toEqual(before);
    const listed = (await (await f.owner(projectInvites(f))).json()) as Invitation[];
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/recipientActor|digest|token/i);
    expect(listed[0].recipient).toBe("@johncena");
    const revoked = await f.owner(projectInvites(f) + `/${invite.invitation.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      id: invite.invitation.id,
      revokedAt: expect.any(String),
    });
    expect((await f.john(acceptPath(invite.token), {})).status).toBe(410);
    expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor]).toBeUndefined();
  } finally {
    await close(f);
  }
}, 90000);

it("native legacy email-only tokens fail closed and can be revoked and reissued with a stable actor binding", async () => {
  const f = await sharingFixture();
  try {
    const legacy = await f.repository.seedLegacyInvitation(
      f.ownedRepository.projectId,
      f.issuerActor,
      recipientEmail,
    );
    expect((await f.john(acceptPath(legacy.token), {})).status).toBe(410);
    expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor]).toBeUndefined();
    expect((await f.owner(projectInvites(f) + `/${legacy.id}/revoke`, {})).status).toBe(200);
    const current = await projectGrant(f, recipientEmail, true);
    expect((await projectState(f)).collaboration!.invitations[current.invitation.id]).toMatchObject(
      { recipientActor: f.recipientActor, acceptedBy: f.recipientActor },
    );
  } finally {
    await close(f);
  }
}, 90000);

it("original issuer session expiry after a genuine asynchronous D1 recipient lookup prevents invitation commit and a later login cannot revive that request", async () => {
  const f = await sharingFixture();
  try {
    await f.repository.holdRecipientLookup();
    const pending = f.owner(projectInvites(f), { recipient: "johncena", role: "editor" });
    await waitLookup(f);
    await f.db
      .prepare("UPDATE session SET expires_at=? WHERE user_id=?")
      .bind(Date.now() - 1000, f.issuerActor.slice(8))
      .run();
    await f.repository.releaseRecipientLookup();
    const result = await pending;
    expect(result.status, await result.clone().text()).toBe(401);
    expect(Object.keys((await projectState(f)).collaboration!.invitations)).toHaveLength(0);
    expect(await f.login(issuerEmail, "repository_owner")).toBe(f.issuerActor);
    await issued(f, projectInvites(f), "johncena");
  } finally {
    await close(f);
  }
}, 90000);

it("current owner and thread authority are rechecked after genuine recipient lookup before any invitation is stored", async () => {
  for (const scope of ["project", "thread"] as const) {
    const f = await sharingFixture();
    try {
      if (scope === "thread") await projectGrant(f);
      const thread = await f.makeThread();
      const path = scope === "project" ? projectInvites(f) : `/threads/${thread.id}/invitations`;
      const beforeCount = Object.keys((await projectState(f)).collaboration!.invitations).length;
      await f.repository.holdRecipientLookup();
      const pending = f.owner(path, { recipient: "johncena", role: "editor" });
      await waitLookup(f);
      if (scope === "project")
        await f.repository.demoteIssuer(f.ownedRepository.projectId, f.issuerActor);
      else
        await f.repository.revokeIssuerThread(
          f.ownedRepository.projectId,
          thread.id,
          f.issuerActor,
        );
      await f.repository.releaseRecipientLookup();
      const result = await pending;
      expect(scope === "project" ? [403, 404] : [404], await result.clone().text()).toContain(
        result.status,
      );
      expect(Object.keys((await projectState(f)).collaboration!.invitations)).toHaveLength(
        beforeCount,
      );
      expect(
        (await projectState(f)).collaboration!.threadMembers[thread.id]?.[f.recipientActor],
      ).toBeUndefined();
    } finally {
      await close(f);
    }
  }
}, 90000);

it("queued recipient acceptance cannot commit after its original session is invalidated", async () => {
  const f = await sharingFixture();
  try {
    const invite = await issued(f, projectInvites(f), "johncena");
    await f.repository.holdAuthority();
    const acceptance = f.john(acceptPath(invite.token), {});
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await f.repository.authorityPending()) !== 2)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await f.repository.authorityPending()).toBe(2);
      await f.db
        .prepare("DELETE FROM session WHERE user_id=?")
        .bind(f.recipientActor.slice(8))
        .run();
    } finally {
      await f.repository.releaseAuthority();
    }
    expect((await acceptance).status).toBe(401);
    expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor]).toBeUndefined();
    expect(
      (await projectState(f)).collaboration!.invitations[invite.invitation.id].acceptedBy,
    ).toBeUndefined();
    expect(await f.login(recipientEmail, "johncena")).toBe(f.recipientActor);
    expect((await f.john(acceptPath(invite.token), {})).status).toBe(200);
  } finally {
    await close(f);
  }
}, 90000);

it("thread and repository membership revocation removes current access and pending grants while retaining historical recipient messages", async () => {
  const f = await sharingFixture();
  try {
    await projectGrant(f);
    const first = await f.makeThread("Revocable shared thread");
    const second = await f.makeThread("Pending shared thread");
    const granted = await issued(f, `/threads/${first.id}/invitations`, "@johncena");
    expect((await f.john(acceptPath(granted.token), {})).status).toBe(200);
    expect(
      (
        await f.john(`/threads/${first.id}/messages`, {
          content: "Historical recipient message",
          idempotencyKey: "historical-recipient",
        })
      ).status,
    ).toBe(201);
    const historical = await (await f.owner(`/threads/${first.id}/messages`)).json();
    const pending = await issued(f, `/threads/${second.id}/invitations`, recipientEmail);
    expect(
      (
        await f.owner(
          `/threads/${first.id}/members/${encodeURIComponent(f.recipientActor)}`,
          undefined,
          {},
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await f.john(`/threads/${first.id}/messages`)).status).toBe(404);
    expect((await f.john(`/projects/${f.ownedRepository.projectId}/context`)).status).toBe(200);
    expect(
      (
        await f.owner(
          `/projects/${f.ownedRepository.projectId}/members/${encodeURIComponent(f.recipientActor)}`,
          undefined,
          {},
          "DELETE",
        )
      ).status,
    ).toBe(200);
    const denied = await f.john(acceptPath(pending.token), {});
    expect([404, 410], await denied.clone().text()).toContain(denied.status);
    expect((await projectState(f)).collaboration!.projectMembers[f.recipientActor]).toBeUndefined();
    expect(
      (await projectState(f)).collaboration!.threadMembers[second.id]?.[f.recipientActor],
    ).toBeUndefined();
    expect(await (await f.john("/repositories")).json()).toMatchObject({ repositories: [] });
    expect(await (await f.owner(`/threads/${first.id}/messages`)).json()).toEqual(historical);
    expect(await f.login(recipientEmail, "johncena")).toBe(f.recipientActor);
    expect((await f.john(`/threads/${first.id}/messages`)).status).toBe(404);
  } finally {
    await close(f);
  }
}, 90000);

it("case-insensitive email ambiguity in actual D1 fails closed before creating any invitation", async () => {
  const f = await sharingFixture();
  try {
    const johnOwned = await readyCreation(
      f,
      await f.create("john-ambiguity-check", recipientEmail),
      "john-ambiguity-check",
      recipientEmail,
    );
    // D1's exact user-email index permits this persisted collision. The
    // enrollment CHECK remains unchanged: the conflicting account is ineligible,
    // and lookup must decline ambiguity rather than select the eligible row.
    await f.db
      .prepare("UPDATE user SET email=? WHERE id=?")
      .bind(recipientEmail.toUpperCase(), f.issuerActor.slice(8))
      .run();
    const users = await f.db
      .prepare("SELECT id FROM user WHERE lower(email)=?")
      .bind(recipientEmail)
      .all();
    expect(users.results).toHaveLength(2);
    const response = await f.john(`/projects/${johnOwned.projectId}/invitations`, {
      recipient: recipientEmail,
      role: "editor",
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toEqual({ error: "recipient_unavailable" });
    const state = (await f.repository.storedState()).ownedProjects![johnOwned.projectId!].state;
    expect(Object.keys(state.collaboration!.invitations)).toHaveLength(0);
    expect(Object.keys(state.collaboration!.projectMembers)).toEqual([f.recipientActor]);
  } finally {
    await close(f);
  }
}, 90000);

it("real logout queues behind an admitted lookup, then invalidates the original session without invalidating the stable invitation recipient", async () => {
  const f = await sharingFixture();
  try {
    await f.repository.holdRecipientLookup();
    const pending = f.owner(projectInvites(f), { recipient: "johncena", role: "editor" });
    await waitLookup(f);
    const originalSession = f.cookies.get(issuerEmail);
    const logout = f.owner("/auth/sign-out", {});
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (await f.repository.authorityPending()) !== 2)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await f.repository.authorityPending()).toBe(2);
    await f.repository.releaseRecipientLookup();
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(201);
    const invite = (await response.json()) as Issued;
    const signedOut = await logout;
    expect(signedOut.status, await signedOut.clone().text()).toBe(200);
    expect((await f.owner(projectInvites(f))).status).toBe(401);
    expect((await f.john(acceptPath(invite.token), {})).status).toBe(200);
    expect(await f.login(issuerEmail, "repository_owner")).toBe(f.issuerActor);
    expect(f.cookies.get(issuerEmail)).not.toBe(originalSession);
    expect((await f.owner(projectInvites(f))).status).toBe(200);
  } finally {
    await close(f);
  }
}, 90000);
