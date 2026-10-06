import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { readFile, readdir } from "node:fs/promises";

it("persists isolated account-owned repos, invitation acceptance, concurrent shared notes and revocation in the real worker", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "listing-test" };
  const base = "https://fixture.pitcrew.test";
  const issuer = "https://fixture.cloudflareaccess.com";
  const emails = ["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"];
  const actors = new Map<string, string>();
  const actor = (email: string) => actors.get(email)!;
  const token = (email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setSubject(email)
      .setIssuer(issuer)
      .setAudience("listing")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  const [owner, bryan, other] = await Promise.all([...emails, "other@example.com"].map(token));
  const bundle = await build({
    entryPoints: [new URL("../test/repository-listing-worker.ts", import.meta.url).pathname],
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
    d1Databases: { AUTH_DB: "synthetic-combined-accounts" },
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      AUTH_MODE: "better-auth",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "synthetic-better-auth-combined-secret-not-live-123456",
      AUTH_EMAIL_FROM: "auth@fixture.example",
      ENVIRONMENT: "production",
      EXECUTION_MODE: "disabled",
      INFRASTRUCTURE_ADMISSION_ENABLED: "false",
      CLOUD_CONVERSATION_ENABLED: "false",
      REPOSITORY_LIFECYCLE: "disabled",
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "listing",
      ACCESS_HOSTNAME: "fixture.pitcrew.test",
      ACCESS_EMAIL: emails[0],
      ACCESS_EMAILS: JSON.stringify(emails),
      TEST_ARTIFACTS_AVAILABLE: "true",
    },
    durableObjects: { REPOSITORY: { className: "RepositoryListingFixture", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-account-collaboration-${crypto.randomUUID()}`,
    outboundService: (request: Request) => {
      if (request.url !== `${issuer}/cdn-cgi/access/certs`)
        throw Error("unexpected_external_transport");
      return Response.json({ keys: [jwk] });
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
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
  await db.prepare("CREATE TABLE test_mail(recipient TEXT,subject TEXT,body TEXT)").run();
  const cookies = new Map<string, string>();
  const request = (path: string, jwt = owner, method = "GET", body?: object) =>
    mf.dispatchFetch(base + path, {
      method,
      headers: {
        "cf-access-jwt-assertion": jwt,
        origin: base,
        ...(cookies.get(jwt) ? { cookie: cookies.get(jwt)! } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const stub = async () => {
    const ns = await mf.getDurableObjectNamespace("REPOSITORY");
    return ns.get(ns.idFromName("pitcrew")) as unknown as {
      calls(): Promise<string[]>;
      executionCounts(): Promise<Record<string, number>>;
      seedProject(name: string, actor: string, email: string): Promise<{ id: string }>;
    };
  };
  try {
    expect((await mf.dispatchFetch(base + "/api/projects")).status).toBe(403);
    expect((await request("/api/projects", other)).status).toBe(403);
    expect((await request("/api/projects", owner)).status).toBe(401);
    const password = "synthetic-combined-password-only";
    for (const [jwt, email, username] of [
      [owner, emails[0], "owner"],
      [bryan, emails[1], "bryan"],
    ]) {
      const signup = await request("/api/auth/sign-up/email", jwt, "POST", {
        email,
        username,
        name: username,
        password,
        image: "/avatars/frog.svg",
      });
      expect(signup.status).toBe(200);
      const mail = await db
        .prepare("SELECT body FROM test_mail WHERE recipient=? ORDER BY rowid DESC LIMIT 1")
        .bind(email)
        .first<{ body: string }>();
      const code = new URL(mail!.body.slice(mail!.body.indexOf("http://"))).hash.slice(
        "#token=".length,
      );
      expect((await request(`/api/auth/verify-email?token=${code}`, jwt)).status).toBe(200);
      const login = await request("/api/auth/sign-in/email", jwt, "POST", { email, password });
      expect(login.status).toBe(200);
      cookies.set(
        jwt,
        login.headers
          .getSetCookie()
          .map((c) => c.split(";", 1)[0])
          .join("; "),
      );
      const account = (await (await request("/api/account", jwt)).json()) as {
        actor: string;
        username: string;
      };
      expect(account.actor.startsWith("account:")).toBe(true);
      expect(account.username).toBe(username);
      actors.set(email, account.actor);
    }
    const borrowed = cookies.get(bryan)!;
    cookies.set(bryan, cookies.get(owner)!);
    expect((await request("/api/projects", bryan)).status).toBe(401);
    cookies.set(bryan, borrowed);
    expect(
      (await request("/api/repositories/create", owner, "POST", { name: "test" })).status,
    ).toBe(503);
    for (const jwt of [owner, bryan]) {
      expect(await (await request("/api/projects", jwt)).json()).toEqual([]);
      expect(await (await request("/api/repositories", jwt)).json()).toEqual({
        repositories: [],
        cursor: null,
      });
    }
    const project = await (await stub()).seedProject("owner-test", actor(emails[0]), emails[0]);
    const privateProject = await (
      await stub()
    ).seedProject("bryan-private", actor(emails[1]), emails[1]);
    expect((await request(`/api/projects/${privateProject.id}/context`)).status).toBe(404);
    const thread = (await (
      await request(`/api/projects/${project.id}/threads`, owner, "POST", {
        title: "shared task",
        idempotencyKey: "create-task",
      })
    ).json()) as { id: string };
    const invite = async (path: string) =>
      (await (await request(path, owner, "POST", { email: emails[1], role: "editor" })).json()) as {
        token: string;
        invitation: { projectId: string };
      };
    const projectInvite = await invite(`/api/projects/${project.id}/invitations`);
    expect(projectInvite.invitation.projectId).toBe(project.id);
    expect((await request(`/api/invitations/${projectInvite.token}`, bryan)).status).toBe(200);
    expect(
      (await request(`/api/invitations/${projectInvite.token}/accept`, bryan, "POST", {})).status,
    ).toBe(200);
    expect(
      (await request(`/api/invitations/${projectInvite.token}/accept`, bryan, "POST", {})).status,
    ).toBe(410);
    expect((await request(`/api/threads/${thread.id}/messages`, bryan)).status).toBe(404);
    const threadInvite = await invite(`/api/threads/${thread.id}/invitations`);
    expect(
      (await request(`/api/invitations/${threadInvite.token}/accept`, bryan, "POST", {})).status,
    ).toBe(200);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(`/api/threads/${thread.id}/messages`, i % 2 ? bryan : owner, "POST", {
          content: `shared note ${i}`,
          idempotencyKey: `note-${i}`,
          author: { actor: "forged" },
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    const messages = (await (
      await request(`/api/threads/${thread.id}/messages`, bryan)
    ).json()) as { author: { actor: string } }[];
    expect(messages).toHaveLength(12);
    expect(
      messages.every((m) => [actor(emails[0]), actor(emails[1])].includes(m.author.actor)),
    ).toBe(true);
    expect(
      (
        await request(`/api/threads/${thread.id}/messages`, owner, "POST", {
          content: "shared note 0",
          idempotencyKey: "note-0",
        })
      ).status,
    ).toBe(201);
    expect((await (await stub()).executionCounts()).runs).toBe(0);
    expect(
      (await request(`/api/projects/${project.id}/intake/dispatch`, owner, "POST", {})).status,
    ).toBe(503);
    expect(
      (await request(`/api/projects/${project.id}/events`, bryan)).headers.get("x-next-sequence"),
    ).not.toBeNull();
    // Reinitialize the real Durable Object using the persisted SQLite state.
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload" }),
    );
    expect(
      (await (await request(`/api/threads/${thread.id}/messages`, bryan)).json()) as unknown[],
    ).toHaveLength(12);
    const revoked = await request(
      `/api/threads/${thread.id}/members/${encodeURIComponent(actor(emails[1]))}`,
      owner,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect((await request(`/api/threads/${thread.id}/messages`, bryan)).status).toBe(404);
    expect(
      (
        await request(`/api/threads/${thread.id}/messages`, bryan, "POST", {
          content: "denied",
          idempotencyKey: "deny",
        })
      ).status,
    ).toBe(404);
    expect(await (await stub()).calls()).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 30000);
