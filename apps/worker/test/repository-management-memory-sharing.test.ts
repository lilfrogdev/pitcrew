import { expect, it } from "vite-plus/test";
import { sharingFixture, recipientEmail } from "./repository-management-sharing-harness";
import type { RepositoryMemorySharingFixture } from "./fixtures/repository-management-memory-sharing-worker";

type RPC<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
async function composedFixture(memoryEnabled = false) {
  const f = await sharingFixture({
    worker: {
      entryPoint: new URL(
        "./fixtures/repository-management-memory-sharing-worker.ts",
        import.meta.url,
      ).pathname,
      className: "RepositoryMemorySharingFixture",
    },
    memoryEnabled,
    // Only deterministic local memory preparation uses the existing fake model.
    // Password HTTP ingress continues to expose execution as disabled.
    executionMode: "fake",
  });
  return {
    ...f,
    get memory() {
      return f.repository as unknown as RPC<RepositoryMemorySharingFixture>;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof composedFixture>>;
type Invitation = { token: string; invitation: { id: string; recipient: string } };
const secret = "PRIVATE_SOURCE_INCIDENT_CARGO_BILLING_DUPLICATE";
async function invite(f: Fixture, threadId?: string) {
  const response = await f.owner(
    threadId
      ? `/threads/${threadId}/invitations`
      : `/projects/${f.ownedRepository.projectId}/invitations`,
    {
      recipient: threadId ? recipientEmail : "@johncena",
      role: "editor",
    },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  const value = (await response.json()) as Invitation;
  expect(value.invitation).not.toHaveProperty("recipientActor");
  return value;
}
async function accept(f: Fixture, invitation: Invitation) {
  const response = await f.john(`/invitations/${invitation.token}/accept`, {});
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ acceptedBy: f.recipientActor });
}
async function note(f: Fixture, threadId: string, content: string) {
  const response = await f.owner(`/threads/${threadId}/messages`, {
    content,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  expect(await response.json()).not.toHaveProperty("turn");
}
async function revokeMember(f: Fixture, threadId?: string) {
  const path = threadId
    ? `/threads/${threadId}/members/`
    : `/projects/${f.ownedRepository.projectId}/members/`;
  const response = await f.owner(
    path + encodeURIComponent(f.recipientActor),
    undefined,
    {},
    "DELETE",
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

it("composed native sharing leaves MAIN memory absent by default and keeps ordinary destination history without disclosing private sibling history", async () => {
  const f = await composedFixture();
  try {
    await accept(f, await invite(f));
    const source = await f.makeThread("Private source");
    const destination = await f.makeThread("Shared destination");
    await note(f, source.id, secret);
    await note(f, destination.id, "Ordinary destination history");
    await accept(f, await invite(f, destination.id));
    const input = await f.memory.beginMemoryTurn(
      f.ownedRepository.projectId,
      destination.id,
      f.issuerActor,
    );
    expect(input.memoryEnabled).toBeUndefined();
    expect(input.memoryBrief).toBeUndefined();
    expect(JSON.stringify(input.messages)).toContain("Ordinary destination history");
    expect(JSON.stringify(input.messages)).not.toContain(secret);
    expect(await f.memory.memorySnapshot()).toEqual({});
    expect((await f.john(`/threads/${source.id}/messages`)).status).toBe(404);
    expect((await f.john(`/threads/${destination.id}/turns`)).status).toBe(200);
    expect(await f.memory.memorySnapshot()).toEqual({});
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("real accepted destination audiences and source membership fence enabled frozen memory while pending or ID-revoked invitations do not grant or remove access", async () => {
  const f = await composedFixture(true);
  try {
    await accept(f, await invite(f));
    const source = await f.makeThread("Private incident source");
    const destination = await f.makeThread("Destination awaiting recipient");
    await note(
      f,
      source.id,
      `Incident: ${secret}. Impact: duplicated billing. Preference: use explicit Save changes.`,
    );
    await note(f, destination.id, "Safe destination history");
    const sourceInvitation = await invite(f, source.id);
    const destinationInvitation = await invite(f, destination.id);
    const frozen = await f.memory.beginMemoryTurn(
      f.ownedRepository.projectId,
      destination.id,
      f.issuerActor,
    );
    expect(frozen.memoryEnabled).toBe(true);
    expect(JSON.stringify(frozen.memoryBrief)).toContain(secret);
    const cached = await f.memory.readRepoMemory(frozen.turnId, "cached-before-accept", "search", {
      query: secret,
    });
    expect(JSON.stringify(cached)).toContain(secret);
    // Pending invitations are not destination recipients or source grants.
    expect((await f.john(`/threads/${source.id}/messages`)).status).toBe(404);
    expect((await f.john(`/threads/${destination.id}/messages`)).status).toBe(404);
    await accept(f, destinationInvitation);
    expect((await f.john(`/threads/${destination.id}/messages`)).status).toBe(200);
    await expect(f.memory.memoryOperation(frozen.turnId, "fresh")).resolves.toMatchObject({
      ok: false,
      error: "memory_turn_conflict",
    });
    await expect(
      f.memory.memoryOperation(frozen.turnId, "search", "cached-before-accept", secret),
    ).resolves.toMatchObject({ ok: false, error: "memory_turn_conflict" });
    const publicTurns = await (await f.john(`/threads/${destination.id}/turns`)).json();
    expect(JSON.stringify(publicTurns)).not.toContain(secret);
    expect(JSON.stringify(publicTurns)).not.toContain("memoryBrief");
    const privateExcluded = await f.makeThread("Shared destination without source access");
    await accept(f, await invite(f, privateExcluded.id));
    const excluded = await f.memory.beginMemoryTurn(
      f.ownedRepository.projectId,
      privateExcluded.id,
      f.issuerActor,
    );
    expect(JSON.stringify(excluded.memoryBrief)).not.toContain(secret);
    const page = await f.memory.readRepoMemory(excluded.turnId, "excluded-private", "search", {
      query: secret,
    });
    expect(JSON.stringify(page)).not.toContain(secret);
    await accept(f, sourceInvitation);
    const shared = await f.makeThread("Shared destination with source access");
    await accept(f, await invite(f, shared.id));
    const authorized = await f.memory.beginMemoryTurn(
      f.ownedRepository.projectId,
      shared.id,
      f.issuerActor,
    );
    const authorizedTurnId = authorized.turnId;
    expect(JSON.stringify(authorized.memoryBrief)).toContain(secret);
    expect(
      JSON.stringify(
        await f.memory.readRepoMemory(authorizedTurnId, "cached-source", "search", {
          query: secret,
        }),
      ),
    ).toContain(secret);
    const retained = JSON.parse(
      JSON.stringify((await f.memory.memorySnapshot()).repo_memory_sources),
    );
    const idRevocation = await f.owner(
      `/projects/${f.ownedRepository.projectId}/invitations/${sourceInvitation.invitation.id}/revoke`,
      {},
    );
    expect(idRevocation.status).toBe(200);
    // Revoking an already accepted invitation changes its historical receipt;
    // current thread membership remains the actual disclosure authority.
    expect((await f.john(`/threads/${source.id}/messages`)).status).toBe(200);
    expect(
      JSON.stringify((await f.memory.freshConversationMemory(authorizedTurnId)).memoryBrief),
    ).toContain(secret);
    await revokeMember(f, source.id);
    expect((await f.john(`/threads/${source.id}/messages`)).status).toBe(404);
    await expect(f.memory.memoryOperation(authorizedTurnId, "fresh")).resolves.toMatchObject({
      ok: false,
      error: "memory_turn_conflict",
    });
    await expect(
      f.memory.memoryOperation(authorizedTurnId, "search", "cached-source", secret),
    ).resolves.toMatchObject({ ok: false, error: "memory_turn_conflict" });
    await expect(f.memory.memoryOperation(authorizedTurnId, "authorize")).resolves.toMatchObject({
      ok: false,
      error: "memory_turn_conflict",
    });
    expect((await f.memory.memorySnapshot()).repo_memory_sources).toEqual(retained);
    expect(
      JSON.stringify(await (await f.john(`/threads/${shared.id}/turns`)).json()),
    ).not.toContain(secret);
    await f.restart();
    await expect(f.memory.memoryOperation(authorizedTurnId, "fresh")).resolves.toMatchObject({
      ok: false,
      error: "memory_turn_conflict",
    });
    expect((await f.memory.memorySnapshot()).repo_memory_sources).toEqual(retained);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("real repository-member revocation fences the enabled native recipient's running MAIN memory after relogin without erasing source history", async () => {
  const f = await composedFixture(true);
  try {
    await accept(f, await invite(f));
    const source = await f.makeThread("Recipient source");
    const destination = await f.makeThread("Recipient destination");
    await note(f, source.id, `Incident: ${secret}`);
    await accept(f, await invite(f, source.id));
    await accept(f, await invite(f, destination.id));
    const input = await f.memory.beginMemoryTurn(
      f.ownedRepository.projectId,
      destination.id,
      f.recipientActor,
    );
    expect(input.credentialActor).toBe(f.recipientActor);
    const turn = (await f.memory.storedState()).ownedProjects![
      f.ownedRepository.projectId
    ].state.conversationTurns!.find((entry) => entry.id === input.turnId)!;
    expect(turn.actor).toBe(f.recipientActor);
    expect(turn.membershipActor ?? turn.actor).toBe(f.recipientActor);
    expect(JSON.stringify(input.memoryBrief)).toContain(secret);
    const before = (await f.memory.memorySnapshot()).repo_memory_sources;
    await revokeMember(f);
    expect((await f.john(`/threads/${destination.id}/messages`)).status).toBe(404);
    await expect(f.memory.memoryOperation(input.turnId, "fresh")).resolves.toMatchObject({
      ok: false,
      error: "conversation_access_revoked",
    });
    expect(await f.login(recipientEmail, "johncena")).toBe(f.recipientActor);
    expect(await (await f.john("/repositories")).json()).toMatchObject({ repositories: [] });
    await expect(f.memory.memoryOperation(input.turnId, "authorize")).resolves.toMatchObject({
      ok: false,
      error: "conversation_access_revoked",
    });
    expect((await f.memory.memorySnapshot()).repo_memory_sources).toEqual(before);
    expect(
      JSON.stringify(await (await f.owner(`/threads/${source.id}/messages`)).json()),
    ).toContain(secret);
  } finally {
    await f.mf.dispose();
  }
}, 90000);
