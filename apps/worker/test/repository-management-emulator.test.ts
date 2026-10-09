import { expect, it } from "vite-plus/test";
import {
  fixture,
  readyCreation,
  transportCounts,
  ownerEmail,
  colleagueEmail,
  targetName,
} from "./repository-management-harness";

const outsiderEmail = "dev@lilfrogdev.com";
const createBody = (name = targetName) => ({ name, credentialConsent: true });
const projectRoute = (id: string) => `/projects/${id}/repository`;
const editBody = (displayName = "Changed label", expectedRevision = 0) => ({
  displayName,
  description: "Private project description",
  expectedRevision,
});
async function createOwned(
  f: Awaited<ReturnType<typeof fixture>>,
  name = targetName,
  email = ownerEmail,
) {
  const record = await readyCreation(f, await f.create(name, email), name, email);
  expect(record.projectId).toEqual(expect.any(String));
  expect(record.repositoryId).toBe("immutable-created_" + record.repositoryName);
  if (record.logicalName !== undefined) {
    expect(record.logicalName).toBe(name.trim().toLowerCase());
    expect(record.projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(record.repositoryName).toBe(
      record.logicalName.slice(0, 30) + "-" + record.projectId!.replaceAll("-", ""),
    );
    expect(record.repositoryName.length).toBeLessThanOrEqual(63);
  }
  return record as typeof record & { projectId: string; repositoryId: string };
}
async function invite(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
  email = colleagueEmail,
) {
  const response = await f.request(path, ownerEmail, { email, role: "editor" });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { token: string; invitation: { id: string } };
}
async function thread(f: Awaited<ReturnType<typeof fixture>>, projectId: string) {
  const response = await f.request(`/projects/${projectId}/threads`, ownerEmail, {
    title: "Synthetic retained conversation",
    idempotencyKey: "synthetic-thread",
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  await f.repository.releaseTransport();
  await f.mf.dispose();
}

it("broad capability is off by default and does not expand the exact legacy approval", async () => {
  const f = await fixture(false);
  try {
    const owner = await f.enroll();
    await f.enroll(colleagueEmail, "second_owner");
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: false, manage: false, delete: false },
      approval: null,
      creations: [],
    });
    expect((await f.create()).status).toBe(404);
    await f.repository.approve(owner, targetName);
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: false, manage: false, delete: false },
      approval: { name: targetName },
    });
    expect(await f.discovery(colleagueEmail)).toMatchObject({
      capabilities: { create: false, manage: false, delete: false },
      approval: null,
    });
    expect((await f.create("synthetic-not-approved")).status).toBe(404);
    const own = await createOwned(f);
    expect(
      (await f.request(projectRoute(own.projectId), ownerEmail, editBody(), {}, "PATCH")).status,
    ).toBe(404);
    expect(
      (
        await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, {
          confirmation: own.repositoryName,
          repositoryId: own.repositoryId,
        })
      ).status,
    ).toBe(404);
    expect((await transportCounts(f)).calls.filter((call) => call.startsWith("delete:"))).toEqual(
      [],
    );
  } finally {
    await close(f);
  }
}, 90000);

it("two real accounts create independent repositories with stable ownership, idempotency, scrubbed credentials and restart persistence", async () => {
  const f = await fixture();
  try {
    const actors = [await f.enroll(), await f.enroll(colleagueEmail, "second_owner")];
    expect(actors[0]).not.toBe(actors[1]);
    expect(actors.every((actor) => actor.startsWith("account:"))).toBe(true);
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: true, manage: true, delete: false },
      approval: null,
    });
    await f.repository.pause("create");
    const pending = f.create();
    await f.waitPaused();
    const duplicate = f.create();
    await f.repository.releaseTransport();
    const own = await readyCreation(f, await pending);
    expect(await readyCreation(f, await duplicate)).toEqual(own);
    const second = await createOwned(f, "synthetic-owned-b", colleagueEmail);
    const state = await f.repository.storedState();
    const firstEntry = state.ownedProjects![own.projectId!];
    const secondEntry = state.ownedProjects![second.projectId];
    expect(firstEntry.ownerActor).toBe(actors[0]);
    expect(secondEntry.ownerActor).toBe(actors[1]);
    expect(firstEntry.sourceName).toBe(own.repositoryName);
    expect(firstEntry.sourceId).toBe(own.repositoryId);
    expect((await f.discovery()).creations.map((record) => record.name)).toEqual([targetName]);
    expect((await f.discovery(colleagueEmail)).creations.map((record) => record.name)).toEqual([
      "synthetic-owned-b",
    ]);
    const physical = await f.repository.repositories();
    expect(
      physical.flatMap((repo) => repo.tokens).every((token) => token.state === "revoked"),
    ).toBe(true);
    expect(
      JSON.stringify([state, await f.repository.lifecycleRows(), await f.discovery()]),
    ).not.toContain("synthetic-creation-token-never-retain");
    expect((await transportCounts(f)).creates).toBe(2);
    await f.restart();
    expect(await f.login()).toBe(actors[0]);
    expect(await f.login(colleagueEmail)).toBe(actors[1]);
    expect(await readyCreation(f, await f.create())).toEqual(own);
    expect((await transportCounts(f)).creates).toBe(2);
    expect((await f.request(projectRoute(second.projectId))).status).toBe(404);
  } finally {
    await close(f);
  }
}, 90000);

it("strict ingress rejects actor forgery, unconsented credentials, unknown fields, query selectors and foreign origins before provider work", async () => {
  const f = await fixture();
  try {
    const actor = await f.enroll();
    for (const body of [
      { ...createBody(), actor },
      { ...createBody(), ownerActor: actor },
      { ...createBody(), email: ownerEmail },
      { ...createBody(), token: "synthetic-forged" },
      { name: targetName },
      { name: targetName, credentialConsent: false },
      { ...createBody(), displayName: 7 },
      { ...createBody(), description: [] },
      [],
      null,
    ])
      expect((await f.request("/repositories/create", ownerEmail, body)).status).toBe(400);
    for (const extra of [
      { origin: "https://foreign.test" },
      { origin: "" },
      { "sec-fetch-site": "cross-site" },
    ] as Record<string, string>[])
      expect(
        (await f.request("/repositories/create", ownerEmail, createBody(), extra)).status,
      ).toBe(403);
    expect(
      (await f.request("/repositories/create?actor=account%3Aforged", ownerEmail, createBody()))
        .status,
    ).toBe(400);
    expect((await f.request("/repository-creations?account=forged")).status).toBe(400);
    expect((await transportCounts(f)).calls).toEqual([]);
    const own = await createOwned(f);
    const before = await f.repository.storedState();
    for (const body of [
      { ...editBody(), actor },
      { ...editBody(), repositoryName: "replacement" },
      { ...editBody(), expectedRevision: -1 },
    ])
      expect(
        (await f.request(projectRoute(own.projectId), ownerEmail, body, {}, "PATCH")).status,
      ).toBe(400);
    expect(
      (
        await f.request(
          projectRoute(own.projectId) + "?actor=forged",
          ownerEmail,
          editBody(),
          {},
          "PATCH",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          projectRoute(own.projectId),
          ownerEmail,
          editBody(),
          { origin: "https://foreign.test" },
          "PATCH",
        )
      ).status,
    ).toBe(403);
    expect(await f.repository.storedState()).toEqual(before);
  } finally {
    await close(f);
  }
}, 90000);

it("only the account owner edits display metadata; concurrent revisions preserve the immutable source, root project and configuration", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.enroll(colleagueEmail, "editor_user");
    await f.enroll(outsiderEmail, "outsider_user");
    const response = await f.request("/repositories/create", ownerEmail, {
      ...createBody(),
      displayName: "Friendly initial title",
      description: "Initial notes",
    });
    const own = await readyCreation(f, response);
    const projectId = own.projectId!;
    const invitation = await invite(f, `/projects/${projectId}/invitations`);
    expect(
      (await f.request(`/invitations/${invitation.token}/accept`, colleagueEmail, {})).status,
    ).toBe(200);
    const before = await f.repository.storedState();
    expect(before.ownedProjects![projectId].ownerActor).toBe(owner);
    expect(before.ownedProjects![projectId].state.project).toMatchObject({
      name: "Friendly initial title",
      description: "Initial notes",
    });
    for (const email of [colleagueEmail, outsiderEmail]) {
      expect(
        (await f.request(projectRoute(projectId), email, editBody(), {}, "PATCH")).status,
      ).toBe(404);
      expect((await f.request(projectRoute(projectId), email)).status).toBe(404);
    }
    const edits = await Promise.all(
      ["First winner", "Second winner"].map((name) =>
        f.request(projectRoute(projectId), ownerEmail, editBody(name), {}, "PATCH"),
      ),
    );
    expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = (await edits.find((result) => result.status === 200)!.json()) as {
      name: string;
      metadataRevision: number;
    };
    expect(winner.metadataRevision).toBe(1);
    const after = await f.repository.storedState();
    expect(after.ownedProjects![projectId].sourceName).toBe(
      before.ownedProjects![projectId].sourceName,
    );
    expect(after.ownedProjects![projectId].sourceId).toBe(
      before.ownedProjects![projectId].sourceId,
    );
    expect(after.ownedProjects![projectId].state.project).toMatchObject({
      name: winner.name,
      description: "Private project description",
      metadataRevision: 1,
    });
    expect(after.project).toEqual(before.project);
    expect(after.ownedProjects![projectId].state.project.repository).toBe(
      before.ownedProjects![projectId].state.project.repository,
    );
    expect(after.ownedProjects![projectId].state.project.baseSha).toBe(
      before.ownedProjects![projectId].state.project.baseSha,
    );
    expect(after.ownedProjects![projectId].state.project.configurationRevision).toBe(
      before.ownedProjects![projectId].state.project.configurationRevision,
    );
    expect((await transportCounts(f)).calls.filter((call) => call.startsWith("delete:"))).toEqual(
      [],
    );
    await f.restart();
    const { repositories: directory } = (await (await f.request("/repositories")).json()) as {
      repositories: {
        name: string;
        repositoryName: string;
        repositoryId: string;
        metadataRevision: number;
      }[];
    };
    expect(directory).toContainEqual(
      expect.objectContaining({
        name: winner.name,
        repositoryName: own.repositoryName,
        repositoryId: own.repositoryId,
        metadataRevision: 1,
      }),
    );
  } finally {
    await close(f);
  }
}, 90000);

it("pending invitations expose safe owner-only IDs and revocation cannot grant membership or be undone by accept", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    await f.enroll(colleagueEmail, "invitee_user");
    await f.enroll(outsiderEmail, "unrelated_user");
    const own = await createOwned(f);
    const first = await invite(f, `/projects/${own.projectId}/invitations`);
    const listingResponse = await f.request(`/projects/${own.projectId}/invitations`);
    expect(listingResponse.status, await listingResponse.clone().text()).toBe(200);
    const listing = (await listingResponse.json()) as { id: string; status: string }[];
    expect(listing).toHaveLength(1);
    expect(JSON.stringify(listing)).not.toMatch(/token|digest|sha256/i);
    expect(JSON.stringify(listing)).not.toContain(first.token);
    const id = listing[0].id;
    expect(typeof id).toBe("string");
    for (const email of [colleagueEmail, outsiderEmail]) {
      expect((await f.request(`/projects/${own.projectId}/invitations`, email)).status).toBe(404);
      expect(
        (await f.request(`/projects/${own.projectId}/invitations/${id}/revoke`, email, {})).status,
      ).toBe(404);
    }
    const revoked = await f.request(
      `/projects/${own.projectId}/invitations/${id}/revoke`,
      ownerEmail,
      {},
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(JSON.stringify(await revoked.json())).not.toMatch(/token|digest|sha256/i);
    expect((await f.request(`/invitations/${first.token}/accept`, colleagueEmail, {})).status).toBe(
      410,
    );
    expect((await f.request(`/projects/${own.projectId}/context`, colleagueEmail)).status).toBe(
      404,
    );
    const second = await invite(f, `/projects/${own.projectId}/invitations`);
    const secondList = (await (
      await f.request(`/projects/${own.projectId}/invitations`)
    ).json()) as { id: string; status: string }[];
    const pending = secondList.find((invitation) => invitation.id !== id)!;
    const races = await Promise.all([
      f.request(`/invitations/${second.token}/accept`, colleagueEmail, {}),
      f.request(`/projects/${own.projectId}/invitations/${pending.id}/revoke`, ownerEmail, {}),
    ]);
    expect(races.every((result) => [200, 409, 410].includes(result.status))).toBe(true);
    const members = (await (await f.request(`/projects/${own.projectId}/members`)).json()) as {
      actor: string;
    }[];
    const accepted = races[0].status === 200;
    expect(members.length).toBe(accepted ? 2 : 1);
  } finally {
    await close(f);
  }
}, 90000);

it("explicit deletion freezes descendants and pending invitations, retains historical messages, retires the name and survives restart", async () => {
  const f = await fixture(true, true);
  try {
    const owner = await f.enroll();
    const editor = await f.enroll(colleagueEmail, "editor_user");
    await f.enroll(outsiderEmail, "outsider_user");
    const own = await createOwned(f);
    const child = await thread(f, own.projectId);
    const projectInvite = await invite(f, `/projects/${own.projectId}/invitations`);
    expect(
      (await f.request(`/invitations/${projectInvite.token}/accept`, colleagueEmail, {})).status,
    ).toBe(200);
    const threadInvite = await invite(f, `/threads/${child.id}/invitations`);
    expect(
      (await f.request(`/invitations/${threadInvite.token}/accept`, colleagueEmail, {})).status,
    ).toBe(200);
    const pending = await invite(f, `/projects/${own.projectId}/invitations`, outsiderEmail);
    const message = await f.request(`/threads/${child.id}/messages`, colleagueEmail, {
      content: "Retained historical synthetic note",
      idempotencyKey: "retained-note",
      author: { actor: "account:forged" },
    });
    expect(message.status).toBe(201);
    const before = await f.repository.storedState();
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    for (const invalid of [
      { ...body, confirmation: "Friendly initial title" },
      { ...body, actor: owner },
    ])
      expect(
        (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, invalid)).status,
      ).toBe(400);
    expect(
      (
        await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, {
          ...body,
          repositoryId: "different-immutable",
        })
      ).status,
    ).toBe(409);
    expect(
      (await f.request(projectRoute(own.projectId) + "/delete", colleagueEmail, body)).status,
    ).toBe(404);
    await f.repository.pause("delete");
    const deletion = f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    await f.waitPaused();
    for (const email of [ownerEmail, colleagueEmail]) {
      for (const path of [
        `/projects/${own.projectId}/context`,
        `/threads/${child.id}/messages`,
        `/threads/${child.id}/events`,
        `/threads/${child.id}/source/tree`,
        `/threads/${child.id}/presence`,
      ])
        expect((await f.request(path, email)).status, path).toBe(404);
      expect(
        (
          await f.request(`/threads/${child.id}/messages`, email, {
            content: "Blocked",
            idempotencyKey: "blocked",
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (await f.request(`/invitations/${pending.token}/accept`, outsiderEmail, {})).status,
    ).toBe(404);
    const countWhilePaused = (await transportCounts(f)).calls.filter((call) =>
      call.startsWith("delete:"),
    ).length;
    expect(countWhilePaused).toBe(1);
    await f.repository.releaseTransport();
    expect((await deletion).status).toBe(200);
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName),
    ).toBeUndefined();
    const after = await f.repository.storedState();
    expect(after.ownedProjects![own.projectId].state.messages).toEqual(
      before.ownedProjects![own.projectId].state.messages,
    );
    expect(after.ownedProjects![own.projectId].state.messages[0].author!.actor).toBe(editor);
    const recreated = await createOwned(f);
    expect(recreated.projectId).not.toBe(own.projectId);
    expect(recreated.repositoryName).not.toBe(own.repositoryName);
    await f.restart();
    expect((await f.request(`/threads/${child.id}/messages`)).status).toBe(404);
    expect(await createOwned(f)).toEqual(recreated);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(1);
  } finally {
    await close(f);
  }
}, 90000);

it("cleanup failures quarantine deletion; explicit recovery cannot delete a replaced immutable repository", async () => {
  const f = await fixture(true, true);
  try {
    await f.enroll();
    const own = await createOwned(f);
    // A new provider credential may be issued after creation. Deletion must clean it.
    await f.repository.replaceRepositoryWithToken(own.repositoryName, own.repositoryId);
    await f.repository.configure({ revokeFailure: true });
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    const failed = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect(failed.status, await failed.clone().text()).toBe(202);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(0);
    expect((await f.request(`/projects/${own.projectId}/context`)).status).toBe(404);
    await f.repository.replaceRepositoryWithToken(own.repositoryName, "replacement-immutable-id");
    await f.repository.configure({});
    const recovery = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect([202, 409], await recovery.clone().text()).toContain(recovery.status);
    const replacement = (await f.repository.repositories()).find(
      (repo) => repo.name === own.repositoryName,
    )!;
    expect(replacement.id).toBe("replacement-immutable-id");
    expect(replacement.tokens).toEqual([{ id: "replacement-sole-credential", state: "active" }]);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(0);
    expect((await f.create()).status).toBe(409);
  } finally {
    await close(f);
  }
}, 90000);

it("original-session logout during awaited provider metadata stops creation admission despite a fresh login", async () => {
  const f = await fixture();
  try {
    const actor = await f.enroll();
    await f.repository.pause("info");
    const creation = f.create();
    await f.waitPaused();
    const logout = await f.request("/auth/sign-out", ownerEmail, {});
    expect(logout.status).toBe(200);
    expect(await f.login()).toBe(actor);
    await f.repository.releaseTransport();
    const result = await creation;
    expect([401, 202], await result.clone().text()).toContain(result.status);
    expect(Object.values((await f.repository.storedState()).ownedProjects ?? {})).toHaveLength(0);
    // Credential cleanup was admitted with provisioning and continues safely;
    // the revoked request must never commit account/project ownership.
    expect((await transportCounts(f)).revokes).toBe(1);
    expect((await f.discovery()).creations).not.toContainEqual(
      expect.objectContaining({ status: "ready" }),
    );
    // Recovery is an explicit new request carrying the fresh session.
    expect(await readyCreation(f, await f.create())).toMatchObject({ status: "ready" });
    expect((await transportCounts(f)).creates).toBe(1);
  } finally {
    await close(f);
  }
}, 90000);

it("ambiguous creation never repeats the provider mutation and only explicit observation-driven recovery registers the same account resource", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    await f.repository.configure({ create: "ambiguous" });
    const result = await f.create();
    expect(result.status).toBe(202);
    expect(Object.values((await f.repository.storedState()).ownedProjects ?? {})).toHaveLength(0);
    expect((await transportCounts(f)).creates).toBe(1);
    await f.restart();
    await f.repository.configure({});
    const observation = await f.discovery();
    expect(observation.creations).toHaveLength(1);
    expect((await transportCounts(f)).creates).toBe(1);
    // The provider mutation may have succeeded even though its response was lost.
    // A duplicate request must retain uncertainty and must never create again.
    const retry = await f.create();
    expect([200, 202], await retry.clone().text()).toContain(retry.status);
    expect((await transportCounts(f)).creates).toBe(1);
    expect(await f.repository.repositories()).toHaveLength(1);
    expect(JSON.stringify(await f.repository.lifecycleRows())).not.toContain(
      "synthetic-creation-token-never-retain",
    );
  } finally {
    await close(f);
  }
}, 90000);

it("failed deletion requires explicit retry and lost success can be reconciled without deleting a replacement or recycling its name", async () => {
  const f = await fixture(true, true);
  try {
    await f.enroll();
    const own = await createOwned(f);
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    await f.repository.configure({ deleteFailure: true });
    const failed = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect(failed.status, await failed.clone().text()).toBe(202);
    const afterFailure = (await transportCounts(f)).calls.filter((call) =>
      call.startsWith("delete:"),
    ).length;
    expect(afterFailure).toBe(1);
    await f.restart();
    await f.repository.configure({ deleteAmbiguous: true });
    for (let index = 0; index < 2; index++)
      expect((await f.request(projectRoute(own.projectId))).status).toBe(200);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(afterFailure);
    const recovery = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect([200, 202], await recovery.clone().text()).toContain(recovery.status);
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName),
    ).toBeUndefined();
    const beforeAbsentRetry = (await transportCounts(f)).calls.filter((call) =>
      call.startsWith("delete:"),
    ).length;
    await f.repository.configure({});
    const absentRetry = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect(absentRetry.status, await absentRetry.clone().text()).toBe(200);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(beforeAbsentRetry);
    await f.repository.physicalRepository(own.repositoryName, "privileged-replacement");
    expect(
      (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body)).status,
    ).toBe(200);
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName)?.id,
    ).toBe("privileged-replacement");
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(beforeAbsentRetry);
    const recreated = await createOwned(f);
    expect(recreated.repositoryName).not.toBe(own.repositoryName);
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName)?.id,
    ).toBe("privileged-replacement");
  } finally {
    await close(f);
  }
}, 90000);

it("membership revocation removes descendant access, preserves fresh verified labels and historical notes, and never removes the owner", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    const editor = await f.enroll(colleagueEmail, "original_editor");
    const own = await createOwned(f);
    const child = await thread(f, own.projectId);
    for (const path of [
      `/projects/${own.projectId}/invitations`,
      `/threads/${child.id}/invitations`,
    ]) {
      const invitation = await invite(f, path);
      expect(
        (await f.request(`/invitations/${invitation.token}/accept`, colleagueEmail, {})).status,
      ).toBe(200);
    }
    expect(
      (
        await f.request(`/threads/${child.id}/messages`, colleagueEmail, {
          content: "Historical author",
          idempotencyKey: "historical-author",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await f.request("/auth/update-user", colleagueEmail, {
          username: "renamed_editor",
          name: "Verified new label",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(`/threads/${child.id}/messages`, colleagueEmail, {
          content: "Current author",
          idempotencyKey: "current-author",
          author: { actor: owner, username: "forged" },
        })
      ).status,
    ).toBe(201);
    const notes = (await (await f.request(`/threads/${child.id}/messages`)).json()) as {
      author: { actor: string; username: string };
    }[];
    expect(notes.map((note) => note.author.actor)).toEqual([editor, editor]);
    expect(notes.map((note) => note.author.username)).toEqual([
      "original_editor",
      "renamed_editor",
    ]);
    const ownerRemoval = await f.request(
      `/projects/${own.projectId}/members/${encodeURIComponent(owner)}`,
      ownerEmail,
      undefined,
      {},
      "DELETE",
    );
    expect([400, 403], await ownerRemoval.clone().text()).toContain(ownerRemoval.status);
    const removal = await f.request(
      `/projects/${own.projectId}/members/${encodeURIComponent(editor)}`,
      ownerEmail,
      undefined,
      {},
      "DELETE",
    );
    expect(removal.status, await removal.clone().text()).toBe(200);
    for (const path of [
      `/projects/${own.projectId}/context`,
      `/threads/${child.id}/messages`,
      `/threads/${child.id}/members`,
      `/threads/${child.id}/source/tree`,
      `/threads/${child.id}/events`,
      `/threads/${child.id}/presence`,
    ])
      expect((await f.request(path, colleagueEmail)).status, path).toBe(404);
    expect(
      (
        await f.request(`/threads/${child.id}/messages`, colleagueEmail, {
          content: "Revoked note",
          idempotencyKey: "revoked",
        })
      ).status,
    ).toBe(404);
    expect(await (await f.request(`/threads/${child.id}/messages`)).json()).toEqual(notes);
    expect(
      (await f.request(projectRoute(own.projectId), colleagueEmail, editBody(), {}, "PATCH"))
        .status,
    ).toBe(404);
    expect(await f.login(colleagueEmail, "renamed_editor")).toBe(editor);
    expect((await f.request(`/threads/${child.id}/messages`, colleagueEmail)).status).toBe(404);
  } finally {
    await close(f);
  }
}, 90000);

it("session revocation and expiry while provider metadata awaits cannot be laundered by account relogin", async () => {
  for (const action of ["revoke-sessions", "expiry"] as const) {
    const f = await fixture();
    try {
      const actor = await f.enroll();
      await f.repository.pause("info");
      const creation = f.create();
      await f.waitPaused();
      if (action === "expiry")
        await f.db
          .prepare("UPDATE session SET expires_at=?")
          .bind(Date.now() - 1000)
          .run();
      else expect((await f.request("/auth/revoke-sessions", ownerEmail, {})).status).toBe(200);
      expect(await f.login()).toBe(actor);
      await f.repository.releaseTransport();
      const result = await creation;
      expect([401, 202], await result.clone().text()).toContain(result.status);
      expect(Object.values((await f.repository.storedState()).ownedProjects ?? {})).toHaveLength(0);
      expect((await transportCounts(f)).revokes).toBe(1);
      expect(await readyCreation(f, await f.create())).toMatchObject({ status: "ready" });
      expect((await transportCounts(f)).creates).toBe(1);
    } finally {
      await close(f);
    }
  }
}, 90000);

it("owner-session revocation during deletion token discovery leaves a frozen resource until a fresh explicit recovery", async () => {
  const f = await fixture(true, true);
  try {
    const owner = await f.enroll();
    const own = await createOwned(f);
    await f.repository.replaceRepositoryWithToken(own.repositoryName, own.repositoryId);
    await f.repository.pause("tokens");
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    const deletion = f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    await f.waitPaused();
    expect((await f.request("/auth/sign-out", ownerEmail, {})).status).toBe(200);
    expect(await f.login()).toBe(owner);
    await f.repository.releaseTransport();
    const failed = await deletion;
    expect([401, 202], await failed.clone().text()).toContain(failed.status);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(0);
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName)?.tokens,
    ).toEqual([{ id: "replacement-sole-credential", state: "active" }]);
    expect((await f.request(`/projects/${own.projectId}/context`)).status).toBe(404);
    const recovery = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect(recovery.status, await recovery.clone().text()).toBe(200);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(1);
  } finally {
    await close(f);
  }
}, 90000);

it("active repository work blocks deletion before provider mutation and remains available until explicit idle deletion", async () => {
  const f = await fixture(true, true);
  try {
    await f.enroll();
    const own = await createOwned(f);
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    for (const kind of ["run", "conversation"] as const) {
      await f.repository.syntheticActiveWork(own.projectId, kind, true);
      const blocked = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
      expect(blocked.status, await blocked.clone().text()).toBe(409);
      expect(await blocked.json()).toMatchObject({ error: "repository_busy" });
      expect((await f.request(`/projects/${own.projectId}/context`)).status).toBe(200);
      expect(
        (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
      ).toBe(0);
      await f.repository.syntheticActiveWork(own.projectId, kind, false);
    }
    expect(
      (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body)).status,
    ).toBe(200);
  } finally {
    await close(f);
  }
}, 90000);

it("queued metadata edits retain their original session and cannot commit after it expires", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    const own = await createOwned(f);
    const before = await f.repository.storedState();
    await f.repository.holdAuthority();
    const edit = f.request(projectRoute(own.projectId), ownerEmail, editBody(), {}, "PATCH");
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await f.repository.authorityPending()) !== 2)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await f.repository.authorityPending()).toBe(2);
      await f.db
        .prepare("UPDATE session SET expires_at=?")
        .bind(Date.now() - 1000)
        .run();
    } finally {
      await f.repository.releaseAuthority();
    }
    expect((await edit).status).toBe(401);
    expect((await f.repository.storedState()).ownedProjects![own.projectId].state.project).toEqual(
      before.ownedProjects![own.projectId].state.project,
    );
    await f.login();
    expect(
      (await f.request(projectRoute(own.projectId), ownerEmail, editBody(), {}, "PATCH")).status,
    ).toBe(200);
  } finally {
    await close(f);
  }
}, 90000);

it("missing-token provider errors cannot falsely certify repository absence or unfreeze a present physical resource", async () => {
  const f = await fixture(true, true);
  try {
    await f.enroll();
    const own = await createOwned(f);
    await f.repository.replaceRepositoryWithToken(own.repositoryName, own.repositoryId);
    await f.repository.configure({ revokeNotFound: true });
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    const deletion = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect(deletion.status, await deletion.clone().text()).toBe(202);
    expect(await deletion.json()).toMatchObject({
      projectId: own.projectId,
      name: targetName,
      repositoryName: own.repositoryName,
      repositoryId: own.repositoryId,
      description: "",
      metadataRevision: 0,
      role: "owner",
      status: "deleting",
      lifecycle: "deleting",
      deletable: false,
    });
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName)?.id,
    ).toBe(own.repositoryId);
    expect(await f.repository.lifecycleRows()).toContainEqual(
      expect.objectContaining({ name: own.repositoryName, status: "deleting" }),
    );
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(0);
    await f.restart();
    const observed = await f.request(projectRoute(own.projectId));
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ status: "deleting" });
    expect((await f.request(`/projects/${own.projectId}/context`)).status).toBe(404);
    await f.repository.configure({});
    expect(
      (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body)).status,
    ).toBe(200);
  } finally {
    await close(f);
  }
}, 90000);

it("legitimately adopted repositories named like old fixtures allow owner display edits and deletion while retaining immutable source metadata", async () => {
  const f = await fixture(true, true);
  try {
    const owner = await f.enroll();
    await f.enroll(colleagueEmail, "other_owner");
    for (const [index, physicalName] of ["pitcrew", "pitcrew-test"].entries()) {
      const immutableId = "synthetic-adopted-immutable-" + index;
      const project = await f.repository.registerAdoptedRepository(
        physicalName,
        immutableId,
        owner,
        ownerEmail,
      );
      const original = (await f.repository.storedState()).ownedProjects![project.id];
      const initial = await f.request(projectRoute(project.id));
      expect(initial.status, await initial.clone().text()).toBe(200);
      expect(await initial.json()).toMatchObject({
        repositoryName: physicalName,
        repositoryId: immutableId,
        deletable: true,
      });
      const displayName = "Friendly adopted repository " + index;
      const edit = await f.request(
        projectRoute(project.id),
        ownerEmail,
        editBody(displayName),
        {},
        "PATCH",
      );
      expect(edit.status, await edit.clone().text()).toBe(200);
      const updated = (await f.repository.storedState()).ownedProjects![project.id];
      expect(updated.sourceName).toBe(original.sourceName);
      expect(updated.sourceId).toBe(original.sourceId);
      expect(updated.state.project).toMatchObject({
        repository: original.state.project.repository,
        baseSha: original.state.project.baseSha,
        configurationRevision: original.state.project.configurationRevision,
        name: displayName,
        metadataRevision: 1,
      });
      expect((await f.request(projectRoute(project.id), colleagueEmail)).status).toBe(404);
      const body = { confirmation: physicalName, repositoryId: immutableId };
      const deletion = await f.request(projectRoute(project.id) + "/delete", ownerEmail, body);
      expect(deletion.status, await deletion.clone().text()).toBe(200);
      const projection = await deletion.json();
      expect(projection).toMatchObject({
        projectId: project.id,
        name: displayName,
        repositoryName: physicalName,
        repositoryId: immutableId,
        description: "Private project description",
        metadataRevision: 1,
        role: "owner",
        status: "deleted",
        lifecycle: "deleted",
        deletable: false,
      });
      expect(await (await f.request(projectRoute(project.id))).json()).toEqual(projection);
      expect(
        (await f.repository.repositories()).find((repo) => repo.name === physicalName),
      ).toBeUndefined();
    }
    expect((await transportCounts(f)).creates).toBe(0);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(2);
  } finally {
    await close(f);
  }
}, 90000);

it("configured root bindings and actual artifact root sources permit account metadata edits but reject physical deletion before provider access", async () => {
  for (const mode of ["binding", "project"] as const) {
    const f = await fixture(true, true);
    try {
      const owner = await f.enroll();
      const physicalName = "synthetic-configured-root-" + mode;
      const immutableId = "synthetic-root-immutable-" + mode;
      const project = await f.repository.registerAdoptedRepository(
        physicalName,
        immutableId,
        owner,
        ownerEmail,
      );
      const projectId = project.id;
      await f.repository.configuredRootSource(physicalName, mode);
      const displayName = "Account metadata for protected root " + mode;
      const edit = await f.request(
        projectRoute(projectId),
        ownerEmail,
        editBody(displayName),
        {},
        "PATCH",
      );
      expect(edit.status, await edit.clone().text()).toBe(200);
      const observation = await f.request(projectRoute(projectId));
      expect(observation.status).toBe(200);
      expect(await observation.json()).toMatchObject({
        name: displayName,
        repositoryName: physicalName,
        repositoryId: immutableId,
        status: "present",
        deletable: false,
      });
      const before = await f.repository.storedState();
      const callsBefore = (await transportCounts(f)).calls;
      const deletion = await f.request(projectRoute(projectId) + "/delete", ownerEmail, {
        confirmation: physicalName,
        repositoryId: immutableId,
      });
      expect(deletion.status, await deletion.clone().text()).toBe(409);
      expect(await deletion.json()).toEqual({ error: "repository_protected" });
      expect((await transportCounts(f)).calls).toEqual(callsBefore);
      expect(await f.repository.storedState()).toEqual(before);
      expect(
        (await f.repository.repositories()).find((repo) => repo.name === physicalName)?.id,
      ).toBe(immutableId);
      await f.restart();
      expect((await f.request(projectRoute(projectId))).status).toBe(200);
      expect(
        (
          await f.request(projectRoute(projectId) + "/delete", ownerEmail, {
            confirmation: physicalName,
            repositoryId: immutableId,
          })
        ).status,
      ).toBe(409);
      expect((await transportCounts(f)).calls).toEqual(callsBefore);
    } finally {
      await close(f);
    }
  }
}, 90000);

it("management alone permits creation metadata and safe invitation work while physical deletion remains disabled before parsing or provider work", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    await f.enroll(colleagueEmail, "gated_invitee");
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: true, manage: true, delete: false },
    });
    const own = await createOwned(f);
    const edit = await f.request(
      projectRoute(own.projectId),
      ownerEmail,
      editBody("Delete disabled display label"),
      {},
      "PATCH",
    );
    expect(edit.status, await edit.clone().text()).toBe(200);
    const invitation = await invite(f, `/projects/${own.projectId}/invitations`);
    const invitations = (await (
      await f.request(`/projects/${own.projectId}/invitations`)
    ).json()) as { id: string }[];
    expect(
      (
        await f.request(
          `/projects/${own.projectId}/invitations/${invitations[0].id}/revoke`,
          ownerEmail,
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.request(`/invitations/${invitation.token}/accept`, colleagueEmail, {})).status,
    ).toBe(410);
    const observation = await f.request(projectRoute(own.projectId));
    expect(observation.status).toBe(200);
    expect(await observation.json()).toMatchObject({
      name: "Delete disabled display label",
      repositoryName: own.repositoryName,
      repositoryId: own.repositoryId,
      status: "present",
      deletable: false,
    });
    const { repositories } = (await (await f.request("/repositories")).json()) as {
      repositories: { deletable: boolean }[];
    };
    expect(repositories).toHaveLength(1);
    expect(repositories[0].deletable).toBe(false);
    const before = await f.repository.storedState();
    const callsBefore = (await transportCounts(f)).calls;
    const valid = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    for (const body of [
      valid,
      {},
      null,
      [],
      { ...valid, actor: "account:forged" },
      { ...valid, confirmation: "wrong physical name" },
    ])
      expect(
        (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body)).status,
      ).toBe(404);
    const malformed = await f.mf.dispatchFetch(
      "https://fixture.pitcrew.test/app/api" + projectRoute(own.projectId) + "/delete",
      {
        method: "POST",
        headers: {
          origin: "https://fixture.pitcrew.test",
          cookie: f.cookies.get(ownerEmail)!,
          "content-type": "application/json",
        },
        body: "{",
      },
    );
    expect(malformed.status).toBe(404);
    for (const path of [projectRoute(own.projectId), projectRoute(own.projectId) + "/delete"]) {
      const rawDelete = await f.request(path, ownerEmail, undefined, {}, "DELETE");
      expect([403, 404, 405], await rawDelete.clone().text()).toContain(rawDelete.status);
    }
    const namespaceDelete = await f.request("/repositories/delete", ownerEmail, {
      name: targetName,
      confirmation: own.repositoryName,
    });
    expect([403, 404], await namespaceDelete.clone().text()).toContain(namespaceDelete.status);
    expect((await transportCounts(f)).calls).toEqual(callsBefore);
    expect(await f.repository.storedState()).toEqual(before);
    expect(await f.repository.lifecycleRows()).toContainEqual(
      expect.objectContaining({ name: own.repositoryName, status: "ready" }),
    );
    await f.restart();
    expect(await f.discovery()).toMatchObject({ capabilities: { delete: false } });
    expect(
      (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, valid)).status,
    ).toBe(404);
    expect((await transportCounts(f)).calls).toEqual(callsBefore);
  } finally {
    await close(f);
  }
}, 90000);

it("the delete switch alone cannot expand legacy creation approval or enable management or physical deletion", async () => {
  const f = await fixture(false, true);
  try {
    const owner = await f.enroll();
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: false, manage: false, delete: false },
    });
    expect((await f.create()).status).toBe(404);
    await f.repository.approve(owner, targetName);
    const own = await createOwned(f);
    const { repositories } = (await (await f.request("/repositories")).json()) as {
      repositories: { deletable: boolean }[];
    };
    expect(repositories[0].deletable).toBe(false);
    const callsBefore = (await transportCounts(f)).calls;
    const before = await f.repository.storedState();
    expect(
      (await f.request(projectRoute(own.projectId), ownerEmail, editBody(), {}, "PATCH")).status,
    ).toBe(404);
    expect(
      (
        await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, {
          confirmation: own.repositoryName,
          repositoryId: own.repositoryId,
        })
      ).status,
    ).toBe(404);
    expect((await transportCounts(f)).calls).toEqual(callsBefore);
    expect(await f.repository.storedState()).toEqual(before);
  } finally {
    await close(f);
  }
}, 90000);

it("disabling physical deletion fences provider awaits and recovery while allowing pending observation without destructive work", async () => {
  const f = await fixture(true, true);
  try {
    await f.enroll();
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: true, manage: true, delete: true },
    });
    const own = await createOwned(f);
    await f.repository.replaceRepositoryWithToken(own.repositoryName, own.repositoryId);
    await f.repository.pause("tokens");
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    const deletion = f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    await f.waitPaused();
    await f.repository.deletion(false);
    await f.repository.releaseTransport();
    const fenced = await deletion;
    expect(fenced.status, await fenced.clone().text()).toBe(404);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(0);
    expect((await transportCounts(f)).revokes).toBe(1); // only the initial creation cleanup
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName)?.tokens,
    ).toEqual([{ id: "replacement-sole-credential", state: "active" }]);
    const frozen = await f.repository.storedState();
    expect(frozen.ownedProjects![own.projectId].state.repositoryLifecycle).toBe("deleting");
    expect((await f.request(`/projects/${own.projectId}/context`)).status).toBe(404);
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: true, manage: true, delete: false },
    });
    const callsBeforeRecovery = (await transportCounts(f)).calls;
    for (const requestBody of [body, {}, null])
      expect(
        (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, requestBody)).status,
      ).toBe(404);
    expect((await transportCounts(f)).calls).toEqual(callsBeforeRecovery);
    expect(await f.repository.storedState()).toEqual(frozen);
    const observed = await f.request(projectRoute(own.projectId));
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({
      status: "deleting",
      deletable: false,
      repositoryName: own.repositoryName,
      repositoryId: own.repositoryId,
    });
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(0);
    await f.restart();
    expect((await f.request(projectRoute(own.projectId))).status).toBe(200);
    expect(
      (await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body)).status,
    ).toBe(404);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(0);
    await f.repository.deletion(true);
    const recovery = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, body);
    expect(recovery.status, await recovery.clone().text()).toBe(200);
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(1);
  } finally {
    await close(f);
  }
}, 90000);

it("an explicitly disabled delete flag has the same native refusal as an absent flag", async () => {
  const f = await fixture(true, "disabled");
  try {
    await f.enroll();
    expect(await f.discovery()).toMatchObject({
      capabilities: { create: true, manage: true, delete: false },
    });
    const own = await createOwned(f);
    const before = await f.repository.storedState();
    const callsBefore = (await transportCounts(f)).calls;
    const result = await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, {
      confirmation: own.repositoryName,
      repositoryId: own.repositoryId,
    });
    expect(result.status, await result.clone().text()).toBe(404);
    expect((await transportCounts(f)).calls).toEqual(callsBefore);
    expect(await f.repository.storedState()).toEqual(before);
    const observed = await f.request(projectRoute(own.projectId));
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ status: "present", deletable: false });
    await f.restart();
    expect((await f.request(projectRoute(own.projectId) + "/delete", ownerEmail, {})).status).toBe(
      404,
    );
    expect((await transportCounts(f)).calls).toEqual(callsBefore);
  } finally {
    await close(f);
  }
}, 90000);
