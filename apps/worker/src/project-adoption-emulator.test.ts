import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { State } from "./coordinator";

const base = "https://fixture.pitcrew.test";
const ownerEmail = "dev@lilfrogdev.com",
  bryanEmail = "bryan.aldair.zamora@gmail.com";
const password = "synthetic-onboarding-password-only";
const target = { name: "approved-existing-repo", repositoryId: "immutable-repository-id" };
async function fixture() {
  const bundle = await build({
    entryPoints: [new URL("../test/project-adoption-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    alias: { path: "node:path" },
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      telemetry: { enabled: false },
      cf: false,
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-03",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { AUTH_DB: "synthetic-project-adoption" },
      durableObjects: {
        REPOSITORY: { className: "ProjectAdoptionFixture", useSQLite: true },
        USER_CREDENTIALS: { className: "PasswordCredentialsFixture", useSQLite: true },
      },
      bindings: {
        AUTH_MODE: "password-only",
        BETTER_AUTH_URL: base,
        BETTER_AUTH_SECRET: "synthetic-project-adoption-secret-never-live-123456",
        ENVIRONMENT: "production",
        EXECUTION_MODE: "disabled",
        INFRASTRUCTURE_ADMISSION_ENABLED: "false",
        CLOUD_CONVERSATION_ENABLED: "false",
        REPOSITORY_LIFECYCLE: "disabled",
        TRUSTED_PUBLISHER_ENABLED: "false",
        ACCESS_EMAIL: ownerEmail,
        CONFIGURATION_REVISION: "onboarding-fixture",
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
      outboundService: () => {
        throw Error("unexpected_external_transport");
      },
    }),
  );
  const db = await mf.getD1Database("AUTH_DB");
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
  const ns = await mf.getDurableObjectNamespace("REPOSITORY");
  const repository = ns.get(ns.idFromName("pitcrew")) as unknown as {
    approve(actor?: string, name?: string, repositoryId?: string): Promise<void>;
    replaceMetadataId(id: string): Promise<void>;
    pause(stage: string): Promise<void>;
    pauseEntered(): Promise<boolean>;
    releaseMetadata(): Promise<void>;
    seedProject(name: string, actor: string, email: string): Promise<{ id: string }>;
    seedLegacyBinding(): Promise<void>;
    storedState(): Promise<State>;
    snapshot(): Promise<{ calls: string[] }>;
  };
  const cookies = new Map<string, string>();
  let seq = 0;
  const request = (path: string, email = ownerEmail, body?: unknown) =>
    mf.dispatchFetch(base + "/app/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: base,
        "cf-connecting-ip": `192.0.2.${++seq}`,
        ...(cookies.has(email) ? { cookie: cookies.get(email)! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (email: string) => {
    const response = await request("/auth/sign-in/email", email, { email, password });
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
  const enroll = async (email: string, username: string) => {
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
    return login(email);
  };
  const waitPaused = async () => {
    for (let count = 0; count < 100; count++) {
      if (await repository.pauseEntered()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("metadata_pause_not_reached");
  };
  return { mf, db, repository, request, enroll, login, waitPaused, cookies };
}

it("empty native accounts adopt only the exact approved source through production HTTP, then invite Bryan without touching legacy ACLs or ciphertext", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll(ownerEmail, "owner"),
      bryan = await f.enroll(bryanEmail, "bryan");
    // Seed only the unrelated legacy fixture; onboarding itself uses HTTP.
    await f.repository.seedLegacyBinding();
    const legacy = await f.repository.seedProject("legacy-project", "access:legacy", ownerEmail);
    const credentialsNS = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
    const credentials = credentialsNS.get(
      credentialsNS.idFromName("openrouter:access:legacy"),
    ) as unknown as {
      save(actor: string, key: string): Promise<void>;
      ciphertext(): Promise<string>;
    };
    await credentials.save("access:legacy", "sk-or-v1-synthetic-never-live");
    const ciphertext = await credentials.ciphertext();
    const before = await f.repository.storedState();
    expect(await (await f.request("/projects")).json()).toEqual([]);
    expect(await (await f.request("/project-adoptions")).json()).toEqual([]);
    expect((await f.request("/projects", ownerEmail, target)).status).toBe(404);
    await f.repository.approve("access:legacy");
    expect((await f.request("/projects", ownerEmail, target)).status).toBe(404);
    await f.repository.approve(owner, target.name, "");
    expect(await (await f.request("/project-adoptions")).json()).toEqual([]);
    expect((await f.request("/projects", ownerEmail, target)).status).toBe(404);
    await f.repository.approve(owner, "", target.repositoryId);
    expect(await (await f.request("/project-adoptions")).json()).toEqual([]);
    expect((await f.request("/projects", ownerEmail, target)).status).toBe(404);
    await f.repository.approve(owner);
    expect(await (await f.request("/project-adoptions")).json()).toEqual([target]);
    expect(await (await f.request("/project-adoptions", bryanEmail)).json()).toEqual([]);
    expect((await f.request("/projects", bryanEmail, target)).status).toBe(404);
    for (const body of [
      { ...target, actor: owner },
      { ...target, email: ownerEmail },
      { name: target.name },
      [target],
    ])
      expect((await f.request("/projects", ownerEmail, body)).status).toBe(400);
    for (const body of [
      { ...target, name: "guessed" },
      { ...target, repositoryId: "replacement" },
    ])
      expect((await f.request("/projects", ownerEmail, body)).status).toBe(404);
    await f.repository.replaceMetadataId("replacement");
    expect((await f.request("/projects", ownerEmail, target)).status).toBe(409);
    await f.repository.replaceMetadataId(target.repositoryId);
    const concurrent = await Promise.all([
      f.request("/projects", ownerEmail, target),
      f.request("/projects", ownerEmail, target),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([201, 409]);
    const project = (await concurrent.find((r) => r.status === 201)!.json()) as {
      id: string;
      baseSha: string;
    };
    expect(project.baseSha).toBe("2".repeat(40));
    expect((await f.request("/projects", ownerEmail, target)).status).toBe(409);
    expect(await (await f.request("/project-adoptions")).json()).toEqual([]);
    expect((await f.request(`/projects/${legacy.id}/context`)).status).toBe(404);
    expect((await f.request(`/projects/${project.id}/context`, bryanEmail)).status).toBe(404);
    const after = await f.repository.storedState();
    expect(after.collaboration).toEqual(before.collaboration);
    expect(after.identityBindings).toEqual(before.identityBindings);
    expect(after.ownedProjects![legacy.id]).toEqual(before.ownedProjects![legacy.id]);
    expect(after.ownedProjects![project.id].state.collaboration!.projectMembers).toEqual({
      [owner]: { actor: owner, email: ownerEmail, role: "owner" },
    });
    expect(await credentials.ciphertext()).toBe(ciphertext);
    expect(await (await f.request("/projects", bryanEmail)).json()).toEqual([]);
    const invite = await f.request(`/projects/${project.id}/invitations`, ownerEmail, {
      email: bryanEmail,
      role: "editor",
    });
    expect(invite.status).toBe(201);
    const { token } = (await invite.json()) as { token: string };
    expect((await f.request(`/invitations/${token}/accept`, bryanEmail, {})).status).toBe(200);
    const members = await (await f.request(`/projects/${project.id}/members`)).json();
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: bryan, email: bryanEmail, role: "editor" }),
      ]),
    );
    expect(
      (await f.repository.snapshot()).calls.every(
        (call: string) => call.startsWith("get:") || call.startsWith("log:"),
      ),
    ).toBe(true);
  } finally {
    await f.mf.dispose();
  }
});

it("logout, revoke-all, expiry and changed approval during metadata awaits cannot commit a stale adoption", async () => {
  const f = await fixture();
  try {
    const owner = await f.enroll(ownerEmail, "owner");
    for (const [index, action] of ["sign-out", "revoke-sessions", "expiry", "approval"].entries()) {
      await f.repository.approve(owner);
      await f.repository.pause(index % 2 ? "log" : "info");
      const adoption = f.request("/projects", ownerEmail, target);
      await f.waitPaused();
      if (action === "approval") await f.repository.approve("account:guessed");
      else if (action === "expiry")
        await f.db
          .prepare("UPDATE session SET expires_at=?")
          .bind(Date.now() - 1)
          .run();
      else expect((await f.request(`/auth/${action}`, ownerEmail, {})).status).toBe(200);
      // A replacement signin must not restore the original adoption grant.
      if (action === "sign-out") await f.login(ownerEmail);
      await f.repository.releaseMetadata();
      expect((await adoption).status).toBe(action === "approval" ? 404 : 401);
      if (["revoke-sessions", "expiry"].includes(action)) await f.login(ownerEmail);
      expect(await (await f.request("/projects")).json()).toEqual([]);
      expect(Object.keys((await f.repository.storedState()).ownedProjects ?? {})).toHaveLength(0);
    }
  } finally {
    await f.mf.dispose();
  }
});

it("a later real native account with the same email cannot inherit an earlier stable-account approval", async () => {
  const f = await fixture();
  try {
    const original = await f.enroll(ownerEmail, "original");
    await f.repository.approve(original);
    // Model replaced fixture account/enrollment data, then create the replacement
    // through the real library. This is not an operator recovery/setup procedure.
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
    expect(await (await f.request("/project-adoptions")).json()).toEqual([]);
    expect((await f.request("/projects", ownerEmail, target)).status).toBe(404);
    expect(Object.keys((await f.repository.storedState()).ownedProjects ?? {})).toHaveLength(0);
  } finally {
    await f.mf.dispose();
  }
});
