import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { State } from "./coordinator";
import type { AccountRepositoryCreationFixture } from "../test/account-repository-creation-worker";

const base = "https://fixture.pitcrew.test";
const ownerEmail = "dev@lilfrogdev.com",
  colleagueEmail = "bryan.aldair.zamora@gmail.com";
const password = "synthetic-creation-password-never-live";
const targetName = "approved-new-repo";
const consent = (name = targetName) => ({ name, credentialConsent: true });
type RPC<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
type Discovery = {
  approval: { name: string } | null;
  creations: {
    name: string;
    status: string;
    repositoryId?: string;
    projectId?: string;
    issue?: string;
  }[];
};

async function fixture() {
  const bundle = await build({
    entryPoints: [
      new URL("../test/account-repository-creation-worker.ts", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    alias: { path: "node:path" },
  });
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { AUTH_DB: "synthetic-account-creation" },
    resourcePersistencePath: `/tmp/pitcrew-account-creation-${crypto.randomUUID()}`,
    durableObjects: {
      REPOSITORY: { className: "AccountRepositoryCreationFixture", useSQLite: true },
      USER_CREDENTIALS: { className: "PasswordCredentialsFixture", useSQLite: true },
    },
    bindings: {
      AUTH_MODE: "password-only",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "synthetic-account-creation-secret-never-live-123456",
      ENVIRONMENT: "production",
      EXECUTION_MODE: "disabled",
      INFRASTRUCTURE_ADMISSION_ENABLED: "false",
      CLOUD_CONVERSATION_ENABLED: "false",
      REPOSITORY_LIFECYCLE: "disabled",
      TRUSTED_PUBLISHER_ENABLED: "false",
      ACCESS_EMAIL: ownerEmail,
      CONFIGURATION_REVISION: "account-creation-fixture",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    outboundService: () => {
      throw new Error("unexpected_external_transport");
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  let db = await mf.getD1Database("AUTH_DB");
  for (const file of (await readdir(new URL("../migrations/auth", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new URL(`../migrations/auth/${file}`, import.meta.url), "utf8");
    for (const statement of sql
      .split(";")
      .map((s) => s.replace(/--> statement-breakpoint/g, "").trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  let ns = await mf.getDurableObjectNamespace("REPOSITORY");
  let repository = ns.get(
    ns.idFromName("pitcrew"),
  ) as unknown as RPC<AccountRepositoryCreationFixture>;
  const cookies = new Map<string, string>(),
    usernames = new Map<string, string>();
  let sequence = 0;
  const request = (
    path: string,
    email = ownerEmail,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    mf.dispatchFetch(base + "/app/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: base,
        "cf-connecting-ip": `192.0.2.${(++sequence % 250) + 1}`,
        ...(cookies.has(email) ? { cookie: cookies.get(email)! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (email = ownerEmail) => {
    const response = await request("/auth/sign-in/username", email, {
      username: usernames.get(email),
      password,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    cookies.set(
      email,
      response.headers
        .getSetCookie()
        .map((c) => c.split(";", 1)[0])
        .join("; "),
    );
    return ((await (await request("/account", email)).json()) as { actor: string }).actor;
  };
  const enroll = async (email = ownerEmail, username = "owner") => {
    const code = Buffer.from(randomBytes(32)).toString("base64url");
    await db
      .prepare(
        "INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at) VALUES(?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        email,
        createHash("sha256").update(code).digest("hex"),
        Date.now() + 600000,
      )
      .run();
    const response = await request("/auth/enroll", email, {
      code,
      password,
      name: username,
      username,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    usernames.set(email, username);
    return login(email);
  };
  const discovery = async (email = ownerEmail) => {
    const response = await request("/repository-creations", email);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Discovery;
  };
  const create = (name = targetName, email = ownerEmail) =>
    request("/repositories/create", email, consent(name));
  const waitPaused = async () => {
    for (let count = 0; count < 750; count++) {
      if (await repository.pauseEntered()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("transport_pause_not_reached");
  };
  const restart = async () => {
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// force cold restart" }),
    );
    db = await mf.getD1Database("AUTH_DB");
    ns = await mf.getDurableObjectNamespace("REPOSITORY");
    repository = ns.get(
      ns.idFromName("pitcrew"),
    ) as unknown as RPC<AccountRepositoryCreationFixture>;
  };
  return {
    mf,
    get db() {
      return db;
    },
    get repository() {
      return repository;
    },
    cookies,
    request,
    enroll,
    login,
    discovery,
    create,
    waitPaused,
    restart,
  };
}

async function transportCounts(f: Awaited<ReturnType<typeof fixture>>) {
  const { calls } = await f.repository.snapshot();
  return {
    calls,
    creates: calls.filter((call) => call.startsWith("create:")).length,
    revokes: calls.filter((call) => call.startsWith("revoke:")).length,
  };
}

async function readyCreation(
  f: Awaited<ReturnType<typeof fixture>>,
  response: Awaited<ReturnType<Miniflare["dispatchFetch"]>>,
  name = targetName,
) {
  expect([200, 202], await response.clone().text()).toContain(response.status);
  const record = (await response.json()) as Discovery["creations"][number];
  expect(record.name).toBe(name);
  if (response.status === 200) {
    expect(record.status).toBe("ready");
    return record;
  }
  // Parallel workerd tests can exceed the route's five-second response window.
  // The admitted operation continues; observe its durable result without a POST retry.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const saved = (await f.discovery()).creations.find((entry) => entry.name === name);
    if (saved?.status === "ready") return saved;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("admitted_creation_never_became_ready:" + name);
}

it("authenticated discovery derives the exact rollout tuple from stable account identity and rejects impersonation or unsafe native ingress", async () => {
  const f = await fixture();
  try {
    expect((await f.request("/repository-creations")).status).toBe(401);
    const owner = await f.enroll(),
      colleague = await f.enroll(colleagueEmail, "bryan");
    expect(owner).not.toBe(colleague);
    expect(await f.discovery()).toEqual({
      approval: null,
      capabilities: { create: false, manage: false },
      creations: [],
    });
    expect((await f.create()).status).toBe(404);
    for (const [actor, name] of [
      ["access:legacy", targetName],
      [owner, ""],
      ["", targetName],
    ]) {
      await f.repository.approve(actor, name);
      expect(await f.discovery()).toEqual({
        approval: null,
        capabilities: { create: false, manage: false },
        creations: [],
      });
      expect((await f.create()).status).toBe(404);
    }
    const serverChosenName = "another-approved-name";
    await f.repository.approve(owner, serverChosenName);
    expect(await f.discovery()).toEqual({
      approval: { name: serverChosenName },
      capabilities: { create: false, manage: false },
      creations: [],
    });
    expect(await f.discovery(colleagueEmail)).toEqual({
      approval: null,
      capabilities: { create: false, manage: false },
      creations: [],
    });
    expect((await f.create(serverChosenName, colleagueEmail)).status).toBe(404);
    expect((await f.create(targetName)).status).toBe(404);
    for (const body of [
      { ...consent(serverChosenName), actor: owner },
      { ...consent(serverChosenName), ownerActor: owner },
      { ...consent(serverChosenName), email: ownerEmail },
      { ...consent(serverChosenName), repositoryId: "guessed" },
      { ...consent(serverChosenName), token: "typed-secret" },
      { name: serverChosenName },
      { name: serverChosenName, credentialConsent: false },
      [consent(serverChosenName)],
      null,
    ])
      expect((await f.request("/repositories/create", ownerEmail, body)).status).toBe(400);
    for (const extra of [
      { origin: "https://evil.test" },
      { origin: "" },
      { "sec-fetch-site": "cross-site" },
    ] as Record<string, string>[])
      expect(
        (await f.request("/repositories/create", ownerEmail, consent(serverChosenName), extra))
          .status,
      ).toBe(403);
    expect(
      (await f.request("/repositories/create?nonce=guessed", ownerEmail, consent(serverChosenName)))
        .status,
    ).toBe(400);
    expect((await f.request("/repository-creations?nonce=guessed")).status).toBe(400);
    expect(
      (
        await f.mf.dispatchFetch(base + "/api/repositories/create", {
          method: "POST",
          headers: {
            origin: base,
            cookie: f.cookies.get(ownerEmail)!,
            "content-type": "application/json",
            "x-auth-mode": "password-only",
          },
          body: JSON.stringify(consent(serverChosenName)),
        })
      ).status,
    ).toBe(403);
    expect((await transportCounts(f)).calls).toEqual([]);
    const response = await f.create(serverChosenName);
    expect(await readyCreation(f, response, serverChosenName)).toMatchObject({
      name: serverChosenName,
      status: "ready",
      repositoryId: "immutable-created_" + serverChosenName,
      projectId: expect.any(String),
    });
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("concurrent exact requests create once, revoke the provider token, register only the native owner, and survive a DO restart without changing legacy state", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.enroll(colleagueEmail, "bryan");
    await f.repository.seedLegacyBinding();
    const legacy = await f.repository.seedProject("legacy-project", "access:legacy", ownerEmail);
    const credentialsNS = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
    const credentials = credentialsNS.get(
      credentialsNS.idFromName("openrouter:access:legacy"),
    ) as unknown as {
      save(actor: string, key: string): Promise<void>;
      ciphertext(): Promise<string>;
    };
    await credentials.save("access:legacy", "sk-or-v1-synthetic-legacy-never-live");
    const ciphertext = await credentials.ciphertext(),
      before = await f.repository.storedState();
    await f.repository.approve(owner);
    await f.repository.pause("create");
    const first = f.create();
    await f.waitPaused();
    const duplicate = f.create();
    await f.repository.releaseTransport();
    const responses = await Promise.all([first, duplicate]);
    const records = await Promise.all(responses.map((r) => readyCreation(f, r)));
    expect(records[1]).toEqual(records[0]);
    const ready = records[0] as Discovery["creations"][number];
    expect(ready).toMatchObject({
      name: targetName,
      status: "ready",
      repositoryId: "immutable-created_" + targetName,
      projectId: expect.any(String),
    });
    const counts = await transportCounts(f);
    expect(counts.creates).toBe(1);
    expect(counts.revokes).toBe(1);
    expect(counts.calls.find((call) => call.startsWith("create:"))).toBe(
      'create:{"name":"approved-new-repo","options":{"readOnly":true,"setDefaultBranch":"main"}}',
    );
    expect(await f.repository.repositories()).toEqual([
      expect.objectContaining({
        name: targetName,
        readOnly: true,
        defaultBranch: "main",
        tokens: [{ id: "issued-1", state: "revoked" }],
      }),
    ]);
    // Materialize RPC results before restart; Miniflare invalidates proxy values.
    const after = JSON.parse(JSON.stringify(await f.repository.storedState())) as State;
    expect(after.collaboration).toEqual(before.collaboration);
    expect(after.identityBindings).toEqual(before.identityBindings);
    expect(after.ownedProjects![legacy.id]).toEqual(before.ownedProjects![legacy.id]);
    expect(after.ownedProjects![ready.projectId!].state.collaboration).toMatchObject({
      projectMembers: {
        [owner]: { actor: owner, email: ownerEmail, role: "owner", username: "owner" },
      },
      threadMembers: {},
      invitations: {},
    });
    expect(
      Object.keys(after.ownedProjects![ready.projectId!].state.collaboration!.projectMembers),
    ).toEqual([owner]);
    expect(after.ownedProjects![ready.projectId!].state.project.baseSha).toBe("0".repeat(40));
    expect(after.ownedProjects![ready.projectId!].state.threads).toHaveLength(0);
    expect(await credentials.ciphertext()).toBe(ciphertext);
    expect(await (await f.request("/projects", colleagueEmail)).json()).toEqual([]);
    expect((await f.request(`/projects/${ready.projectId}/context`, colleagueEmail)).status).toBe(
      404,
    );
    expect(JSON.stringify([records, after, await f.repository.lifecycleRows()])).not.toContain(
      "synthetic-creation-token-never-retain",
    );
    expect(counts.calls.every((call) => !/^(import|delete|email)/.test(call))).toBe(true);
    await f.restart();
    expect((await f.discovery()).creations).toEqual([ready]);
    expect(await (await f.create()).json()).toEqual(ready);
    expect((await transportCounts(f)).creates).toBe(1);
    expect(await f.repository.storedState()).toEqual(after);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("an ambiguous post-create response remains durable pending and exact retries never create, revoke or infer ownership", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    await f.repository.configure({ create: "ambiguous" });
    expect((await f.create()).status).toBe(202);
    expect((await f.discovery()).creations).toEqual([
      expect.objectContaining({ name: targetName, status: "pending" }),
    ]);
    expect(await f.repository.repositories()).toEqual([
      expect.objectContaining({ tokens: [{ id: "issued-1", state: "active" }] }),
    ]);
    await f.repository.configure({});
    expect((await f.create()).status).toBe(202);
    await f.restart();
    expect((await f.create()).status).toBe(202);
    expect((await transportCounts(f)).creates).toBe(1);
    expect((await transportCounts(f)).revokes).toBe(0);
    expect(await (await f.request("/projects")).json()).toEqual([]);
    await f.enroll(colleagueEmail, "bryan");
    expect(await f.discovery(colleagueEmail)).toEqual({
      approval: null,
      capabilities: { create: false, manage: false },
      creations: [],
    });
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("physical namespace collisions cause no creation or token revocation", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    await f.repository.physicalRepository(targetName);
    expect((await f.create()).status).toBe(409);
    expect((await transportCounts(f)).creates).toBe(0);
    expect((await transportCounts(f)).revokes).toBe(0);
    expect((await f.discovery()).creations).toEqual([]);
    expect(await (await f.request("/projects")).json()).toEqual([]);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("cleanup retries recover only the immutable created repository and never resubmit create or revoke replacement credentials", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    await f.repository.configure({ revokeFailure: true });
    expect((await f.create()).status).toBe(202);
    expect((await f.discovery()).creations[0]).toMatchObject({
      status: "cleanup_required",
      repositoryId: "immutable-created_" + targetName,
    });
    await f.repository.replaceRepositoryId(targetName, "replacement-id");
    await f.repository.configure({});
    const before = await transportCounts(f);
    expect((await f.create()).status).toBe(202);
    expect((await transportCounts(f)).revokes).toBe(before.revokes);
    expect(await (await f.request("/projects")).json()).toEqual([]);
    await f.repository.replaceRepositoryId(targetName, "immutable-created_" + targetName);
    const retry = await f.create();
    expect((await readyCreation(f, retry)).status).toBe("ready");
    expect((await transportCounts(f)).creates).toBe(1);
    expect((await f.discovery()).creations[0].status).toBe("ready");
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("unexpected multiple initial tokens remain quarantined without revoking unrelated credentials", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    await f.repository.configure({ tokenCount: 2 });
    expect((await f.create()).status).toBe(202);
    expect((await f.create()).status).toBe(202);
    expect((await f.discovery()).creations[0].status).toBe("cleanup_required");
    expect((await transportCounts(f)).creates).toBe(1);
    expect((await transportCounts(f)).revokes).toBe(0);
    expect(await (await f.request("/projects")).json()).toEqual([]);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("registration metadata errors and capacity recover from the same cleaned repository with an empty main head", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    await f.repository.configure({ logError: true });
    expect((await f.create()).status).toBe(202);
    expect((await f.discovery()).creations[0]).toMatchObject({
      status: "registration_required",
      repositoryId: "immutable-created_" + targetName,
    });
    const projects = [];
    for (let index = 0; index < 20; index++)
      projects.push(await f.repository.seedProject("capacity-" + index, owner, ownerEmail));
    await f.repository.configure({ emptyHeadNotFound: true });
    expect((await f.create()).status).toBe(202);
    expect((await f.discovery()).creations[0].status).toBe("registration_required");
    await f.repository.removeSeededProject(projects[0].id);
    // NOT_FOUND is a transport error, not proof of an empty repository.
    expect((await f.create()).status).toBe(202);
    await f.repository.configure({});
    const response = await f.create();
    const ready = await readyCreation(f, response);
    expect(
      (await f.repository.storedState()).ownedProjects![ready.projectId!].state.project.baseSha,
    ).toBe("0".repeat(40));
    expect((await transportCounts(f)).creates).toBe(1);
    expect((await transportCounts(f)).revokes).toBe(1);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("logout, revoke-all, expiry, relogin and changed approval during namespace lookup fence creation before the external mutation", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    for (const [index, action] of ["sign-out", "revoke-sessions", "expiry", "approval"].entries()) {
      const name = "fenced-before-create-" + index;
      await f.repository.approve(owner, name);
      await f.repository.pause("list");
      const operation = f.create(name);
      await f.waitPaused();
      if (action === "approval") await f.repository.approve("account:replacement", name);
      else if (action === "expiry")
        await f.db
          .prepare("UPDATE session SET expires_at=?")
          .bind(Date.now() - 1)
          .run();
      else expect((await f.request(`/auth/${action}`, ownerEmail, {})).status).toBe(200);
      if (action === "sign-out") await f.login();
      await f.repository.releaseTransport();
      expect((await operation).status).toBe(action === "approval" ? 404 : 401);
      if (["revoke-sessions", "expiry"].includes(action)) await f.login();
      expect((await transportCounts(f)).creates).toBe(0);
      expect(await (await f.request("/projects")).json()).toEqual([]);
    }
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("cleanup continues after session loss while registration waits for a fresh grant; post-head approval and source ID changes cannot register", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    for (const [index, action] of [
      "sign-out",
      "revoke-sessions",
      "expiry",
      "approval",
      "replacement",
    ].entries()) {
      const name = "fenced-registration-" + index;
      await f.repository.approve(owner, name);
      await f.repository.pause(action === "sign-out" ? "revoke" : "log");
      const operation = f.create(name);
      await f.waitPaused();
      if (action === "approval") await f.repository.approve("account:replacement", name);
      else if (action === "replacement")
        await f.repository.replaceRepositoryId(name, "replacement-during-head");
      else if (action === "expiry")
        await f.db
          .prepare("UPDATE session SET expires_at=?")
          .bind(Date.now() - 1)
          .run();
      else expect((await f.request(`/auth/${action}`, ownerEmail, {})).status).toBe(200);
      if (action === "sign-out") await f.login();
      await f.repository.releaseTransport();
      const response = await operation;
      expect(response.status).toBe(
        action === "approval" ? 404 : action === "replacement" ? 409 : 401,
      );
      if (["revoke-sessions", "expiry"].includes(action)) await f.login();
      expect(await (await f.request("/projects")).json()).toEqual([]);
      const repo = (await f.repository.repositories()).find((entry) => entry.name === name)!;
      expect(repo.tokens).toEqual([{ id: "issued-1", state: "revoked" }]);
      if (action === "replacement")
        await f.repository.replaceRepositoryId(name, "immutable-created_" + name);
      await f.repository.approve(owner, name);
      expect((await f.discovery()).creations.find((entry) => entry.name === name)!.status).toBe(
        "registration_required",
      );
      const recovered = await f.create(name);
      const project = await readyCreation(f, recovered, name);
      // Remove only this fixture's verified project so each subsequent assertion
      // can observe an empty native project list before registration recovery.
      await f.repository.removeSeededProject(project.projectId!);
    }
    expect((await transportCounts(f)).creates).toBe(5);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("a replacement BetterAuth account with the same email cannot inherit a stable-account rollout approval", async () => {
  const f = await fixture();
  try {
    const original = await f.enroll();
    await f.repository.approve(original);
    await f.db
      .prepare("UPDATE user SET email=? WHERE id=?")
      .bind("retired@example.test", original.slice(8))
      .run();
    await f.db
      .prepare("DELETE FROM auth_enrollment WHERE consumed_user_id=?")
      .bind(original.slice(8))
      .run();
    const replacement = await f.enroll(ownerEmail, "replacement");
    expect(replacement).not.toBe(original);
    expect(await f.discovery()).toEqual({
      approval: null,
      capabilities: { create: false, manage: false },
      creations: [],
    });
    expect((await f.create()).status).toBe(404);
    expect((await transportCounts(f)).creates).toBe(0);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("a mismatched provider create response quarantines the outcome without trusting its ID or retrying a mutation", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    await f.repository.configure({ create: "wrong_name" });
    const response = await f.create();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ name: targetName, status: "pending" });
    expect((await f.discovery()).creations).toEqual([{ name: targetName, status: "pending" }]);
    await f.repository.configure({});
    expect((await f.create()).status).toBe(202);
    expect((await transportCounts(f)).creates).toBe(1);
    expect((await transportCounts(f)).revokes).toBe(0);
    expect(await (await f.request("/projects")).json()).toEqual([]);
    expect(await f.repository.lifecycleRows()).toEqual([
      expect.objectContaining({ ownerActor: owner, name: targetName, status: "pending" }),
    ]);
    expect(JSON.stringify(await f.repository.lifecycleRows())).not.toContain("immutable-created_");
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("capacity is checked after namespace discovery and before creating a repository, then recovers after a slot is freed", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    const projects = [];
    for (let index = 0; index < 20; index++)
      projects.push(await f.repository.seedProject("full-" + index, owner, ownerEmail));
    expect((await f.create()).status).toBe(429);
    expect((await transportCounts(f)).creates).toBe(0);
    expect((await f.discovery()).creations).toEqual([]);
    expect(await f.repository.repositories()).toEqual([]);
    await f.repository.removeSeededProject(projects[0].id);
    expect((await readyCreation(f, await f.create())).status).toBe("ready");
    expect((await transportCounts(f)).creates).toBe(1);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

it("source replacement during token listing preserves the original immutable ID and cannot revoke a replacement repository's sole credential", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll();
    await f.repository.approve(owner);
    await f.repository.pause("tokens");
    const operation = f.create();
    await f.waitPaused();
    await f.repository.replaceRepositoryWithToken(targetName, "replacement-token-list-id");
    await f.repository.releaseTransport();
    expect((await operation).status).toBe(202);
    expect((await f.discovery()).creations).toEqual([
      {
        name: targetName,
        repositoryId: "immutable-created_" + targetName,
        status: "cleanup_required",
      },
    ]);
    expect(await f.repository.lifecycleRows()).toEqual([
      expect.objectContaining({
        name: targetName,
        id: "immutable-created_" + targetName,
        ownerActor: owner,
        status: "cleanup_required",
      }),
    ]);
    expect(await f.repository.repositories()).toEqual([
      expect.objectContaining({
        id: "replacement-token-list-id",
        tokens: [{ id: "replacement-sole-credential", state: "active" }],
      }),
    ]);
    expect((await transportCounts(f)).revokes).toBe(0);
    expect((await f.create()).status).toBe(202);
    expect((await transportCounts(f)).creates).toBe(1);
    expect((await transportCounts(f)).revokes).toBe(0);
    expect(await (await f.request("/projects")).json()).toEqual([]);
  } finally {
    await f.mf.dispose();
  }
}, 60000);
