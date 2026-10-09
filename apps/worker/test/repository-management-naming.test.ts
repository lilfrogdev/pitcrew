import { expect, it } from "vite-plus/test";
import {
  fixture,
  readyCreation,
  transportCounts,
  ownerEmail,
  colleagueEmail,
} from "./repository-management-harness";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Record = {
  name: string;
  logicalName?: string;
  projectId?: string;
  id?: string;
  repositoryName?: string;
  repositoryId?: string;
  ownerActor?: string;
  status: string;
};
const route = (id: string) => `/projects/${id}/repository`;
const slug = (name: string) => name.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "").toLowerCase();
const renameBody = (logicalName: string, expectedRevision = 0) => ({
  logicalName,
  displayName: "Readable renamed project",
  description: "Synthetic naming notes",
  expectedRevision,
});
function assertBinding(
  record: {
    logicalName?: string;
    repositoryName: string;
    projectId?: string;
    repositoryId?: string;
  },
  logicalName: string,
) {
  expect(record.logicalName).toBe(slug(logicalName));
  expect(record.projectId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(record.repositoryName).toBe(
    slug(logicalName).slice(0, 30) + "-" + record.projectId!.replaceAll("-", ""),
  );
  expect(record.repositoryName.length).toBeLessThanOrEqual(63);
  expect(record.repositoryId).toBe("immutable-created_" + record.repositoryName);
}
async function create(f: Fixture, logicalName: string, email = ownerEmail) {
  const response = await f.create(logicalName, email);
  const record = await readyCreation(f, response, logicalName, email);
  assertBinding(record, logicalName);
  return record as typeof record & { projectId: string; repositoryId: string; logicalName: string };
}
async function rows(f: Fixture) {
  return (await f.repository.lifecycleRows()) as Record[];
}
async function close(f: Fixture) {
  await f.repository.releaseTransport();
  await f.mf.dispose();
}

it("canonical concurrent create commits its physical UUID before provider work and keeps that intent across restart and case variants", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    const input = " \tMiXeD-NAME\r\n";
    await f.repository.pause("create");
    const first = f.create(input);
    await f.waitPaused();
    const durable = (await rows(f))[0];
    expect(durable).toMatchObject({
      logicalName: "mixed-name",
      ownerActor: owner,
      status: "pending",
      projectId: expect.any(String),
    });
    expect(durable.name).toBe("mixed-name-" + durable.projectId!.replaceAll("-", ""));
    const createCalls = (await transportCounts(f)).calls.filter((call) =>
      call.startsWith("create:"),
    );
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(createCalls[0].slice(7))).toMatchObject({ name: durable.name });
    const publicPending = (await f.discovery()).creations[0];
    expect(publicPending).toMatchObject({
      name: "mixed-name",
      logicalName: "mixed-name",
      repositoryName: durable.name,
      status: "pending",
    });
    expect(publicPending).not.toHaveProperty("projectId");
    const duplicate = f.create("MIXED-name");
    await f.repository.releaseTransport();
    const a = await readyCreation(f, await first, input);
    const b = await readyCreation(f, await duplicate, "MIXED-name");
    expect(b).toEqual(a);
    assertBinding(a, input);
    expect(a.projectId).toBe(durable.projectId);
    expect((await transportCounts(f)).creates).toBe(1);
    await f.restart();
    expect(await create(f, "Mixed-Name")).toEqual(a);
    expect((await transportCounts(f)).creates).toBe(1);
    expect((await f.repository.storedState()).ownedProjects![a.projectId!].sourceName).toBe(
      durable.name,
    );
  } finally {
    await close(f);
  }
}, 90000);

it("two real owners may choose the same logical name and receive separate immutable physical repositories and projects", async () => {
  const f = await fixture();
  try {
    const actors = [await f.enroll(), await f.enroll(colleagueEmail, "second_namespace")];
    const [a, b] = await Promise.all([
      create(f, "shared-name"),
      create(f, " SHARED-NAME ", colleagueEmail),
    ]);
    expect(a.logicalName).toBe(b.logicalName);
    expect(a.projectId).not.toBe(b.projectId);
    expect(a.repositoryName).not.toBe(b.repositoryName);
    expect(a.repositoryId).not.toBe(b.repositoryId);
    const state = await f.repository.storedState();
    expect(state.ownedProjects![a.projectId].ownerActor).toBe(actors[0]);
    expect(state.ownedProjects![b.projectId].ownerActor).toBe(actors[1]);
    expect((await f.request(route(b.projectId))).status).toBe(404);
    expect((await f.request(route(a.projectId), colleagueEmail)).status).toBe(404);
    expect((await f.discovery()).creations.map((record) => record.repositoryName)).toEqual([
      a.repositoryName,
    ]);
    expect(
      (await f.discovery(colleagueEmail)).creations.map((record) => record.repositoryName),
    ).toEqual([b.repositoryName]);
    expect((await transportCounts(f)).creates).toBe(2);
  } finally {
    await close(f);
  }
}, 90000);

it("logical rename canonicalizes atomically, rejects same-owner collisions, releases the old logical name and leaves physical binding and configuration unchanged", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    await f.enroll(colleagueEmail, "unrelated_owner");
    const own = await create(f, "original-name");
    await create(f, "occupied-name");
    await create(f, "renamed-name", colleagueEmail);
    const before = (await f.repository.storedState()).ownedProjects![own.projectId];
    const callsBefore = (await transportCounts(f)).calls;
    const collision = await f.request(
      route(own.projectId),
      ownerEmail,
      renameBody(" OCCUPIED-NAME "),
      {},
      "PATCH",
    );
    expect(collision.status, await collision.clone().text()).toBe(409);
    expect(await collision.json()).toEqual({ error: "repository_exists" });
    expect((await f.repository.storedState()).ownedProjects![own.projectId]).toEqual(before);
    const response = await f.request(
      route(own.projectId),
      ownerEmail,
      renameBody(" RENAMED-Name "),
      {},
      "PATCH",
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      id: own.projectId,
      logicalName: "renamed-name",
      metadataRevision: 1,
    });
    const after = (await f.repository.storedState()).ownedProjects![own.projectId];
    expect(after.sourceName).toBe(before.sourceName);
    expect(after.sourceId).toBe(before.sourceId);
    expect(after.ownerActor).toBe(before.ownerActor);
    expect(after.state.project).toMatchObject({
      id: own.projectId,
      repository: before.state.project.repository,
      baseSha: before.state.project.baseSha,
      configurationRevision: before.state.project.configurationRevision,
    });
    expect((await transportCounts(f)).calls).toEqual(callsBefore);
    const idempotent = await readyCreation(f, await f.create("RENAMED-NAME"), "RENAMED-NAME");
    expect(idempotent.projectId).toBe(own.projectId);
    expect(idempotent.repositoryName).toBe(own.repositoryName);
    const released = await create(f, "original-name");
    expect(released.projectId).not.toBe(own.projectId);
    expect(released.repositoryName).not.toBe(own.repositoryName);
    await f.restart();
    expect(await (await f.request(route(own.projectId))).json()).toMatchObject({
      logicalName: "renamed-name",
      repositoryName: own.repositoryName,
      repositoryId: own.repositoryId,
      metadataRevision: 1,
      deletable: false,
    });
  } finally {
    await close(f);
  }
}, 90000);

it("provider ALREADY_EXISTS quarantines the preallocated UUID and logical reservation without regeneration on case variants or restart", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    const other = await create(f, "rename-candidate");
    await f.repository.configure({ create: "already_exists" });
    const first = await f.create("colliding-intent");
    expect(first.status, await first.clone().text()).toBe(202);
    const pending = (await first.json()) as Record;
    expect(pending).toMatchObject({
      name: "colliding-intent",
      logicalName: "colliding-intent",
      repositoryName: expect.any(String),
      status: "pending",
    });
    expect(pending).not.toHaveProperty("projectId");
    const saved = (await rows(f)).find((record) => record.logicalName === "colliding-intent")!;
    expect(saved.projectId).toEqual(expect.any(String));
    expect(saved.name).toBe("colliding-intent-" + saved.projectId!.replaceAll("-", ""));
    expect(
      (
        await f.request(
          route(other.projectId),
          ownerEmail,
          renameBody("COLLIDING-INTENT"),
          {},
          "PATCH",
        )
      ).status,
    ).toBe(409);
    await f.restart();
    await f.repository.configure({});
    const retry = await f.create(" COLLIDING-INTENT ");
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(pending);
    expect((await rows(f)).find((record) => record.logicalName === "colliding-intent")).toEqual(
      saved,
    );
    expect((await transportCounts(f)).creates).toBe(2); // one other repository and one failed mutation
    const physical = await f.repository.repositories();
    expect(physical).toHaveLength(2);
    expect(physical.find((repo) => repo.name === other.repositoryName)).toBeDefined();
    expect(physical.find((repo) => repo.name === saved.name)).toMatchObject({
      id: "synthetic-foreign-existing_" + saved.name,
      tokens: [{ id: "foreign-sole-token", state: "active" }],
    });
    expect((await transportCounts(f)).revokes).toBe(1); // only the other repository's initial token
    expect((await f.repository.storedState()).ownedProjects).not.toHaveProperty(saved.projectId!);
  } finally {
    await close(f);
  }
}, 90000);

it("cleanup and registration failures retain the allocated UUID and physical name through explicit recovery and cold restart", async () => {
  for (const failure of ["cleanup", "metadata"] as const) {
    const f = await fixture();
    try {
      await f.enroll();
      await f.repository.configure(
        failure === "cleanup" ? { revokeFailure: true } : { logError: true },
      );
      const first = await f.create("durable-recovery");
      expect(first.status).toBe(202);
      const partial = (await first.json()) as Record;
      expect(partial).not.toHaveProperty("projectId");
      const saved = (await rows(f))[0];
      expect(saved.projectId).toEqual(expect.any(String));
      expect(saved.name).toBe("durable-recovery-" + saved.projectId!.replaceAll("-", ""));
      expect(Object.keys((await f.repository.storedState()).ownedProjects ?? {})).toHaveLength(0);
      await f.restart();
      await f.repository.configure({});
      const recovered = await create(f, "DURABLE-RECOVERY");
      expect(recovered.projectId).toBe(saved.projectId);
      expect(recovered.repositoryName).toBe(saved.name);
      expect((await transportCounts(f)).creates).toBe(1);
      expect(
        (await f.repository.repositories())
          .flatMap((repo) => repo.tokens)
          .every((token) => token.state === "revoked"),
      ).toBe(true);
    } finally {
      await close(f);
    }
  }
}, 90000);

it("concurrent create and rename resolve to one owner-scoped logical target, including idempotent creation of a winning renamed intent", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    const own = await create(f, "race-source");
    const [rename, creation] = await Promise.all([
      f.request(route(own.projectId), ownerEmail, renameBody("race-target"), {}, "PATCH"),
      f.create(" RACE-TARGET "),
    ]);
    expect([200, 409], await rename.clone().text()).toContain(rename.status);
    const created = await readyCreation(f, creation, " RACE-TARGET ");
    const entries = Object.values((await f.repository.storedState()).ownedProjects ?? {});
    expect(
      entries.filter((entry) => entry.state.project.logicalName === "race-target"),
    ).toHaveLength(1);
    if (rename.status === 200) {
      expect(created.projectId).toBe(own.projectId);
      expect(created.repositoryName).toBe(own.repositoryName);
      expect((await transportCounts(f)).creates).toBe(1);
    } else {
      expect(created.projectId).not.toBe(own.projectId);
      expect((await transportCounts(f)).creates).toBe(2);
    }
    const replay = await readyCreation(f, await f.create("RACE-TARGET"), "RACE-TARGET");
    expect(replay).toEqual(created);
  } finally {
    await close(f);
  }
}, 90000);

it("a deleting logical name stays reserved while confirmed deletion permits a fresh UUID without freeing the old physical tombstone", async () => {
  const f = await fixture(true, true);
  try {
    await f.enroll();
    const own = await create(f, "reusable-name");
    await f.repository.configure({ deleteFailure: true });
    const body = { confirmation: own.repositoryName, repositoryId: own.repositoryId };
    const deletion = await f.request(route(own.projectId) + "/delete", ownerEmail, body);
    expect(deletion.status).toBe(202);
    expect((await f.create("REUSABLE-NAME")).status).toBe(409);
    expect((await transportCounts(f)).creates).toBe(1);
    await f.repository.configure({});
    expect((await f.request(route(own.projectId) + "/delete", ownerEmail, body)).status).toBe(200);
    const recreated = await create(f, " REUSABLE-NAME ");
    expect(recreated.projectId).not.toBe(own.projectId);
    expect(recreated.repositoryName).not.toBe(own.repositoryName);
    const tombstone = (await rows(f)).find((record) => record.name === own.repositoryName)!;
    expect(tombstone.status).toBe("deleted");
    await f.repository.physicalRepository(own.repositoryName, "out-of-band-old-name-replacement");
    expect((await f.request(route(own.projectId) + "/delete", ownerEmail, body)).status).toBe(200);
    expect(
      (await f.repository.repositories()).find((repo) => repo.name === own.repositoryName)?.id,
    ).toBe("out-of-band-old-name-replacement");
    expect(
      (await transportCounts(f)).calls.filter((call) => call.startsWith("delete:")).length,
    ).toBe(2);
    await f.restart();
    expect(await create(f, "reusable-name")).toEqual(recreated);
    expect((await rows(f)).find((record) => record.name === own.repositoryName)?.status).toBe(
      "deleted",
    );
  } finally {
    await close(f);
  }
}, 90000);

it("legacy exact physical approval remains unchanged and adopted physical-name fallback cannot bypass an active logical reservation", async () => {
  const f = await fixture(false);
  try {
    const owner = await f.enroll();
    const exact = "legacy-approved-physical";
    await f.repository.approve(owner, exact);
    const legacy = await readyCreation(f, await f.create(exact), exact);
    expect(legacy.repositoryName).toBe(exact);
    expect(legacy.repositoryId).toBe("immutable-created_" + exact);
    expect(legacy.logicalName).toBeUndefined();
    await f.repository.management(true);
    const existing = await readyCreation(f, await f.create(exact), exact);
    expect(existing.projectId).toBe(legacy.projectId);
    expect(existing.repositoryName).toBe(exact);
    await f.repository.registerAdoptedRepository(
      "adopted-name",
      "synthetic-adopted-id",
      owner,
      ownerEmail,
    );
    expect((await f.create("adopted-name")).status).toBe(409);
    await f.repository.configure({ create: "ambiguous" });
    expect((await f.create("reserved-for-adoption")).status).toBe(202);
    await f.repository.configure({});
    await f.repository.physicalRepository("reserved-for-adoption", "synthetic-adoption-source");
    await f.repository.approveAdoption(owner, "reserved-for-adoption", "synthetic-adoption-source");
    const before = await f.repository.storedState();
    const adoption = await f.request("/projects", ownerEmail, {
      name: "reserved-for-adoption",
      repositoryId: "synthetic-adoption-source",
    });
    expect(adoption.status, await adoption.clone().text()).toBe(409);
    expect(await f.repository.storedState()).toEqual(before);
    expect((await transportCounts(f)).creates).toBe(2);
  } finally {
    await close(f);
  }
}, 90000);

it("logical-name validation and session revalidation prevent malformed or revoked rename requests from changing reservations", async () => {
  const f = await fixture();
  try {
    await f.enroll();
    const own = await create(f, "validation-source");
    const long = "a".repeat(63);
    const max = await create(f, long);
    expect(max.repositoryName).toBe("a".repeat(30) + "-" + max.projectId.replaceAll("-", ""));
    const before = await f.repository.storedState();
    const callsBefore = (await transportCounts(f)).calls;
    for (const logicalName of [
      "",
      "-leading",
      "with_underscore",
      "two words",
      "a".repeat(64),
      "é",
      "\u00a0not-ascii-trim\u00a0",
      null,
      1,
    ]) {
      const invalidRename = await f.request(
        route(own.projectId),
        ownerEmail,
        { ...renameBody("valid"), logicalName },
        {},
        "PATCH",
      );
      expect(
        invalidRename.status,
        JSON.stringify(logicalName) + ":" + (await invalidRename.clone().text()),
      ).toBe(400);
      expect(
        (
          await f.request("/repositories/create", ownerEmail, {
            name: logicalName,
            credentialConsent: true,
          })
        ).status,
      ).toBe(400);
    }
    expect(await f.repository.storedState()).toEqual(before);
    expect((await transportCounts(f)).calls).toEqual(callsBefore);
    await f.repository.management(false);
    const disabledRename = await f.request(
      route(own.projectId),
      ownerEmail,
      renameBody("gate-rejected-name"),
      {},
      "PATCH",
    );
    expect(disabledRename.status).toBe(404);
    expect((await f.repository.storedState()).ownedProjects![own.projectId]).toEqual(
      before.ownedProjects![own.projectId],
    );
    await f.repository.management(true);
    await create(f, "gate-rejected-name");
    await f.repository.holdAuthority();
    const rename = f.request(
      route(own.projectId),
      ownerEmail,
      renameBody("revoked-reservation"),
      {},
      "PATCH",
    );
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
    expect((await rename).status).toBe(401);
    expect((await f.repository.storedState()).ownedProjects![own.projectId]).toEqual(
      before.ownedProjects![own.projectId],
    );
    await f.login();
    const available = await create(f, "revoked-reservation");
    expect(available.projectId).not.toBe(own.projectId);
  } finally {
    await close(f);
  }
}, 90000);

it("concurrent case variants occupying the final project slot retain one intent and remain idempotent after registration reaches capacity", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    for (let index = 0; index < 19; index++)
      await f.repository.seedProject("synthetic-capacity-" + index, owner, ownerEmail);
    await f.repository.pause("create");
    const first = f.create("last-slot");
    await f.waitPaused();
    const duplicate = f.create(" LAST-SLOT ");
    const saved = (await rows(f)).find((record) => record.logicalName === "last-slot")!;
    expect(saved.projectId).toEqual(expect.any(String));
    await f.repository.releaseTransport();
    const a = await readyCreation(f, await first, "last-slot");
    const b = await readyCreation(f, await duplicate, " LAST-SLOT ");
    expect(b).toEqual(a);
    expect(a.projectId).toBe(saved.projectId);
    expect(Object.keys((await f.repository.storedState()).ownedProjects ?? {})).toHaveLength(20);
    expect(await readyCreation(f, await f.create("LAST-SLOT"), "LAST-SLOT")).toEqual(a);
    const full = await f.create("new-over-capacity");
    expect(full.status, await full.clone().text()).toBe(429);
    expect(
      (await rows(f)).find((record) => record.logicalName === "new-over-capacity"),
    ).toBeUndefined();
    expect((await transportCounts(f)).creates).toBe(1);
    await f.restart();
    expect(await readyCreation(f, await f.create("last-slot"), "last-slot")).toEqual(a);
    expect((await transportCounts(f)).creates).toBe(1);
  } finally {
    await close(f);
  }
}, 90000);
