import { it, expect } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { readFile, readdir } from "node:fs/promises";
const base = "https://fixture.pitcrew.test";
const password = "synthetic-fixture-password-only";
async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = (sub: string, email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(sub)
      .setIssuer("https://fixture.cloudflareaccess.com")
      .setAudience("fixture")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  const tokens = {
    owner: await token("owner", "dev@lilfrogdev.com"),
    bryan: await token("bryan", "bryan.aldair.zamora@gmail.com"),
    changedSub: await token("another-owner", "dev@lilfrogdev.com"),
    other: await token("other", "outsider@example.com"),
  };
  const bundle = await build({
    entryPoints: [new URL("../test/auth-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
  });
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { AUTH_DB: "synthetic-auth" },
    bindings: {
      AUTH_MODE: "better-auth",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "synthetic-better-auth-secret-never-live-123456789",
      AUTH_EMAIL_FROM: "auth@fixture.example",
      TEST_PUBLIC_JWK: JSON.stringify(await exportJWK(publicKey)),
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
  await db.prepare("CREATE TABLE test_mail(recipient TEXT,subject TEXT,body TEXT)").run();
  await db.prepare("CREATE TABLE test_mail_failure(error TEXT)").run();
  const req = (
    who: keyof typeof tokens,
    path: string,
    body?: unknown,
    cookie?: string,
    headers = {},
  ) =>
    mf.dispatchFetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-access-jwt-assertion": tokens[who],
        "cf-connecting-ip": who === "bryan" ? "192.0.2.2" : "192.0.2.1",
        ...(body === undefined ? {} : { origin: base, "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const mailToken = async (subject: string, recipient = "dev@lilfrogdev.com") => {
    const row = await db
      .prepare(
        "SELECT body FROM test_mail WHERE subject=? AND recipient=? ORDER BY rowid DESC LIMIT 1",
      )
      .bind(subject, recipient)
      .first<{ body: string }>();
    expect(row).not.toBeNull();
    return new URL(row!.body.slice(row!.body.indexOf("http://"))).hash.slice("#token=".length);
  };
  const signup = (who: "owner" | "bryan" = "owner") =>
    req(who, "/api/auth/sign-up/email", {
      email: who === "owner" ? "dev@lilfrogdev.com" : "bryan.aldair.zamora@gmail.com",
      password,
      name: who === "owner" ? "Owner" : "Bryan",
      username: who,
      image: "/avatars/frog.svg",
    });
  const login = async () => {
    const r = await req("owner", "/api/auth/sign-in/email", {
      email: "dev@lilfrogdev.com",
      password,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: true });
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    expect(r.headers.get("set-cookie")).toContain("Secure");
    return r.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
  };
  const restart = async () => {
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        script: options.script + "\n// synthetic cold restart",
      }),
    );
    db = await mf.getD1Database("AUTH_DB");
  };
  return {
    mf,
    get db() {
      return db;
    },
    req,
    signup,
    login,
    mailToken,
    restart,
    tokens,
  };
}
it("real Better Auth + Drizzle + workerd D1 verifies enrollment, hashes passwords, binds subjects, expires/revokes sessions and resets once", async () => {
  const f = await fixture();
  try {
    expect((await f.req("other", "/api/auth/get-session")).status).toBe(503);
    expect(
      (
        await f.req("owner", "/api/auth/sign-up/email", {
          email: "bryan.aldair.zamora@gmail.com",
          password,
          name: "x",
          username: "owner",
        })
      ).status,
    ).toBe(403);
    expect((await f.signup()).status).toBe(200);
    const stored = await f.db
      .prepare("SELECT access_actor,username,email_verified FROM user")
      .first();
    expect(stored).toMatchObject({
      access_actor: "access:owner",
      username: "owner",
      email_verified: 0,
    });
    const hash = await f.db.prepare("SELECT password FROM account").first<{ password: string }>();
    expect(hash!.password).not.toBe(password);
    expect(hash!.password.length).toBeGreaterThan(64);
    expect(
      (await f.req("owner", "/api/auth/sign-in/email", { email: "dev@lilfrogdev.com", password }))
        .status,
    ).toBe(403);
    const verification = await f.mailToken("Verify your Pitcrew email");
    expect((await f.req("bryan", "/api/auth/verify-email?token=" + verification)).status).toBe(403);
    expect((await f.req("owner", "/api/auth/verify-email?token=" + verification)).status).toBe(200);
    const cookie = await f.login();
    const session = await f.req("owner", "/api/auth/get-session", undefined, cookie);
    const text = await session.text();
    expect(text).not.toContain("accessActor");
    expect(text).not.toContain("token");
    const user = JSON.parse(text).user;
    expect(user).toMatchObject({
      emailVerified: true,
      username: "owner",
      image: "/avatars/frog.svg",
    });
    expect(await (await f.req("owner", "/api/test/principal", undefined, cookie)).json()).toEqual({
      actor: `account:${user.id}`,
      credentialActor: "access:owner",
    });
    expect(
      await (await f.req("changedSub", "/api/auth/get-session", undefined, cookie)).json(),
    ).toBeNull();
    expect(
      (
        await f.req("changedSub", "/api/auth/sign-in/email", {
          email: "dev@lilfrogdev.com",
          password,
        })
      ).status,
    ).toBe(403);
    expect((await f.req("bryan", "/api/auth/update-user", { name: "hijack" }, cookie)).status).toBe(
      401,
    );
    expect(
      (
        await f.req(
          "owner",
          "/api/auth/update-user",
          { name: "New name", username: "new_owner" },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.req("owner", "/api/auth/update-user", { accessActor: "access:bryan" }, cookie))
        .status,
    ).toBe(400);
    expect(
      (await f.req("owner", "/api/auth/request-password-reset", { email: "dev@lilfrogdev.com" }))
        .status,
    ).toBe(200);
    const reset = await f.mailToken("Reset your Pitcrew password");
    expect(
      (
        await f.req("bryan", "/api/auth/reset-password", {
          token: reset,
          newPassword: password + "-new",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.req("owner", "/api/auth/reset-password", {
          token: reset,
          newPassword: password + "-new",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.req("owner", "/api/auth/reset-password", {
          token: reset,
          newPassword: password + "-again",
        })
      ).status,
    ).toBe(400);
    expect((await f.req("owner", "/api/test/principal", undefined, cookie)).status).toBe(401);
    const changedLogin = await f.req(
      "owner",
      "/api/auth/sign-in/email",
      { email: "dev@lilfrogdev.com", password: password + "-new" },
      undefined,
      { "cf-connecting-ip": "192.0.2.3" },
    );
    const newCookie = changedLogin.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
    expect(changedLogin.status).toBe(200);
    expect((await f.req("owner", "/api/auth/sign-out", {}, newCookie)).status).toBe(200);
    expect((await f.req("owner", "/api/test/principal", undefined, newCookie)).status).toBe(401);
    await f.db.prepare("UPDATE session SET expires_at=0").run();
    expect(
      await (await f.req("owner", "/api/auth/get-session", undefined, newCookie)).json(),
    ).toBeNull();
  } finally {
    await f.mf.dispose();
  }
}, 30000);
it("real library enforces origin/endpoint/body restrictions and atomic concurrent password rate limits", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.req(
          "owner",
          "/api/auth/sign-in/email",
          { email: "dev@lilfrogdev.com", password },
          undefined,
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.req("owner", "/api/auth/sign-up/email", {
          email: "dev@lilfrogdev.com",
          password,
          name: "owner",
          username: "owner",
          accessActor: "access:bryan",
        })
      ).status,
    ).toBe(400);
    expect((await f.req("owner", "/api/auth/change-email", {})).status).toBe(404);
    expect((await f.req("owner", "/api/auth/sign-in/social", {})).status).toBe(404);
    expect(
      (
        await f.req("owner", "/api/auth/sign-in/email", {
          email: "dev@lilfrogdev.com",
          password: "x".repeat(9000),
        })
      ).status,
    ).toBe(400);
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        f.req("owner", "/api/auth/sign-in/email", { email: "dev@lilfrogdev.com", password }),
      ),
    );
    // The preceding oversized password body consumed one subject attempt.
    expect(attempts.filter((r) => r.status === 401)).toHaveLength(4);
    expect(attempts.filter((r) => r.status === 429)).toHaveLength(8);
    expect(attempts.find((r) => r.status === 429)!.headers.get("x-retry-after")).toBeTruthy();
  } finally {
    await f.mf.dispose();
  }
}, 30000);
it("counts invalid tokens before validation and survives restart with durable subject admission", async () => {
  const f = await fixture();
  try {
    const verify = await Promise.all(
      Array.from({ length: 14 }, () => f.req("owner", "/api/auth/verify-email?token=malformed")),
    );
    expect(verify.filter((r) => r.status === 400)).toHaveLength(10);
    expect(verify.filter((r) => r.status === 429)).toHaveLength(4);
    const reset = await Promise.all(
      Array.from({ length: 9 }, (_, n) =>
        f.req("owner", "/api/auth/reset-password", { token: `guess-${n}`, newPassword: password }),
      ),
    );
    expect(reset.filter((r) => r.status === 400)).toHaveLength(5);
    expect(reset.filter((r) => r.status === 429)).toHaveLength(4);
    await f.restart();
    expect(
      (
        await f.req("owner", "/api/auth/reset-password", {
          token: "another-guess",
          newPassword: password,
        })
      ).status,
    ).toBe(429);
    expect(
      (await f.req("bryan", "/api/auth/reset-password", { token: "guess", newPassword: password }))
        .status,
    ).toBe(400);
    expect(
      (
        await f.mf.dispatchFetch(base + "/api/auth/get-session", {
          headers: { "cf-access-jwt-assertion": "invalid.jwt.signature" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await f.mf.dispose();
  }
}, 30000);
it("real library rotates password sessions, revokes every login, rejects expired reset and sanitizes native email errors", async () => {
  const f = await fixture();
  try {
    expect((await f.signup()).status).toBe(200);
    expect(
      (
        await f.req(
          "owner",
          "/api/auth/verify-email?token=" + (await f.mailToken("Verify your Pitcrew email")),
        )
      ).status,
    ).toBe(200);
    const first = await f.login(),
      second = await f.login();
    await f.restart();
    expect((await f.req("owner", "/api/test/principal", undefined, first)).status).toBe(200);
    expect(
      (
        await f.req(
          "owner",
          "/api/auth/change-password",
          {
            currentPassword: password,
            newPassword: password + "-changed",
            revokeOtherSessions: true,
          },
          first,
        )
      ).status,
    ).toBe(200);
    expect((await f.req("owner", "/api/test/principal", undefined, second)).status).toBe(401);
    const login = await f.req("owner", "/api/auth/sign-in/email", {
      email: "dev@lilfrogdev.com",
      password: password + "-changed",
    });
    expect(login.status).toBe(200);
    const third = login.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
    expect((await f.req("owner", "/api/auth/revoke-sessions", {}, third)).status).toBe(200);
    expect((await f.req("owner", "/api/test/principal", undefined, third)).status).toBe(401);
    const renewed = await f.req("owner", "/api/auth/sign-in/email", {
      email: "dev@lilfrogdev.com",
      password: password + "-changed",
    });
    const live = renewed.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
    await f.db.prepare("UPDATE session SET expires_at=0").run();
    expect((await f.req("owner", "/api/test/principal", undefined, live)).status).toBe(401);
    expect(
      (await f.req("owner", "/api/auth/request-password-reset", { email: "dev@lilfrogdev.com" }))
        .status,
    ).toBe(200);
    const reset = await f.mailToken("Reset your Pitcrew password");
    await f.db
      .prepare("UPDATE verification SET expires_at=0 WHERE identifier LIKE 'reset-password:%'")
      .run();
    expect(
      (await f.req("owner", "/api/auth/reset-password", { token: reset, newPassword: password }))
        .status,
    ).toBe(400);
    const failed = await f.req(
      "owner",
      "/api/auth/request-password-reset",
      { email: "dev@lilfrogdev.com" },
      undefined,
      { "x-test-mail-fail": "true" },
    );
    expect(await failed.json()).toEqual({ status: true });
    const error = await f.db
      .prepare("SELECT error FROM test_mail_failure LIMIT 1")
      .first<{ error: string }>();
    expect(error?.error).toBe("auth_email_delivery_failed");
  } finally {
    await f.mf.dispose();
  }
}, 30000);
it("only one concurrent reset redeems its token and email verification expires", async () => {
  const f = await fixture();
  try {
    expect((await f.signup()).status).toBe(200);
    const expired = await new SignJWT({ email: "dev@lilfrogdev.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(new TextEncoder().encode("synthetic-better-auth-secret-never-live-123456789"));
    expect((await f.req("owner", "/api/auth/verify-email?token=" + expired)).status).toBe(400);
    expect(
      (await f.req("owner", "/api/auth/request-password-reset", { email: "dev@lilfrogdev.com" }))
        .status,
    ).toBe(200);
    const reset = await f.mailToken("Reset your Pitcrew password");
    const responses = await Promise.all(
      Array.from({ length: 3 }, (_, n) =>
        f.req("owner", "/api/auth/reset-password", { token: reset, newPassword: password + n }),
      ),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(2);
  } finally {
    await f.mf.dispose();
  }
}, 30000);
