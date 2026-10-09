import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { RepositorySharingFixture } from "./fixtures/repository-management-sharing-worker";

const base = "https://fixture.pitcrew.test";
// The existing enrollment policy only accepts these recipient labels. Every
// account, enrollment code, password and session is created in temporary D1;
// no mailbox is contacted and no live account or credential is used.
const ownerEmail = "john.cena@example.com",
  colleagueEmail = "lara.croft@example.com";
const password = "synthetic-creation-password-never-live";
const targetName = "synthetic-owned-a";
const consent = (name = targetName) => ({ name, credentialConsent: true });
type RPC<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
type Discovery = {
  capabilities: { create: boolean; manage: boolean; delete: boolean };
  approval: { name: string } | null;
  creations: {
    name: string;
    logicalName?: string;
    repositoryName?: string;
    status: string;
    repositoryId?: string;
    projectId?: string;
    issue?: string;
  }[];
};

export async function fixture(enabled = true, deleteEnabled: boolean | "disabled" = false) {
  const bundle = await build({
    entryPoints: [
      new URL("./fixtures/repository-management-sharing-worker.ts", import.meta.url).pathname,
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
    d1Databases: { AUTH_DB: "synthetic-recipient-sharing" },
    resourcePersistencePath: `/tmp/pitcrew-recipient-sharing-${crypto.randomUUID()}`,
    durableObjects: {
      REPOSITORY: { className: "RepositorySharingFixture", useSQLite: true },
      USER_CREDENTIALS: { className: "PasswordCredentialsFixture", useSQLite: true },
    },
    bindings: {
      ACCOUNT_REPOSITORY_MANAGEMENT: enabled ? "enabled" : "disabled",
      ...(deleteEnabled === true
        ? { ACCOUNT_REPOSITORY_DELETE: "enabled" }
        : deleteEnabled === "disabled"
          ? { ACCOUNT_REPOSITORY_DELETE: "disabled" }
          : {}),
      AUTH_MODE: "password-only",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "synthetic-recipient-sharing-secret-never-live-123456",
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
  let repository = ns.get(ns.idFromName("pitcrew")) as unknown as RPC<RepositorySharingFixture>;
  await repository.management(enabled);
  await repository.deletion(deleteEnabled);
  const cookies = new Map<string, string>(),
    usernames = new Map<string, string>();
  let sequence = 0;
  const request = (
    path: string,
    email = ownerEmail,
    body?: unknown,
    extra: Record<string, string> = {},
    method = body === undefined ? "GET" : "POST",
  ) =>
    mf.dispatchFetch(base + "/app/api" + path, {
      method,
      headers: {
        origin: base,
        "cf-connecting-ip": `192.0.2.${(++sequence % 250) + 1}`,
        ...(cookies.has(email) ? { cookie: cookies.get(email)! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (email = ownerEmail, username = usernames.get(email)) => {
    const response = await request("/auth/sign-in/username", email, {
      username,
      password,
    });
    assert.equal(response.status, 200, await response.clone().text());
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
    assert.equal(response.status, 200, await response.clone().text());
    usernames.set(email, username);
    return login(email);
  };
  const discovery = async (email = ownerEmail) => {
    const response = await request("/repository-creations", email);
    assert.equal(response.status, 200, await response.clone().text());
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
    repository = ns.get(ns.idFromName("pitcrew")) as unknown as RPC<RepositorySharingFixture>;
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
    managementEnabled: enabled,
    request,
    enroll,
    login,
    discovery,
    create,
    waitPaused,
    restart,
  };
}

export async function transportCounts(f: Awaited<ReturnType<typeof fixture>>) {
  const { calls } = await f.repository.snapshot();
  return {
    calls,
    creates: calls.filter((call) => call.startsWith("create:")).length,
    revokes: calls.filter((call) => call.startsWith("revoke:")).length,
  };
}

export async function readyCreation(
  f: Awaited<ReturnType<typeof fixture>>,
  response: Awaited<ReturnType<Miniflare["dispatchFetch"]>>,
  name = targetName,
  email = ownerEmail,
) {
  assert.ok([200, 202].includes(response.status), await response.clone().text());
  const record = (await response.json()) as Discovery["creations"][number];
  const expectedName = f.managementEnabled ? name.trim().toLowerCase() : name;
  assert.equal(record.name, expectedName);
  if (response.status === 200) {
    assert.equal(record.status, "ready");
    return { ...record, repositoryName: record.repositoryName ?? record.name };
  }
  // Parallel workerd tests can exceed the route's five-second response window.
  // The admitted operation continues; observe its durable result without a POST retry.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const saved = (await f.discovery(email)).creations.find(
      (entry) =>
        entry.name === expectedName &&
        (record.repositoryName
          ? entry.repositoryName === record.repositoryName
          : entry.status !== "deleted"),
    );
    if (saved?.status === "ready")
      return { ...saved, repositoryName: saved.repositoryName ?? saved.name };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("admitted_creation_never_became_ready:" + name);
}

export { base, ownerEmail, colleagueEmail, targetName };

export const issuerEmail = colleagueEmail;
export const recipientEmail = ownerEmail;
export const recipientUsername = "johncena";
export const syntheticPassword = password;
export async function sharingFixture() {
  const f = await fixture();
  const issuerActor = await f.enroll(issuerEmail, "repository_owner");
  const recipientActor = await f.enroll(recipientEmail, recipientUsername);
  const repo = await readyCreation(
    f,
    await f.create("synthetic-shared-repository", issuerEmail),
    "synthetic-shared-repository",
    issuerEmail,
  );
  const ownedRepository = repo as typeof repo & { projectId: string; repositoryId: string };
  const owner = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    method = body === undefined ? "GET" : "POST",
  ) => f.request(path, issuerEmail, body, extra, method);
  const john = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    method = body === undefined ? "GET" : "POST",
  ) => f.request(path, recipientEmail, body, extra, method);
  const makeThread = async (title = "Synthetic shared notes") => {
    const response = await owner(`/projects/${ownedRepository.projectId}/threads`, {
      title,
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as { id: string; projectId: string; title: string };
  };
  const syntheticEmailChange = async (actor: string, email: string) => {
    const userId = actor.slice("account:".length);
    await f.db.batch([
      f.db
        .prepare("UPDATE auth_enrollment SET recipient_email=? WHERE consumed_user_id=?")
        .bind(email, userId),
      f.db.prepare("UPDATE user SET email=? WHERE id=?").bind(email, userId),
    ]);
  };
  return {
    ...f,
    get db() {
      return f.db;
    },
    get repository() {
      return f.repository;
    },
    personas: {
      issuer: { email: issuerEmail, username: "repository_owner", password, actor: issuerActor },
      recipient: {
        email: recipientEmail,
        username: recipientUsername,
        password,
        actor: recipientActor,
      },
    },
    issuerActor,
    recipientActor,
    ownedRepository,
    owner,
    john,
    makeThread,
    syntheticEmailChange,
  };
}
