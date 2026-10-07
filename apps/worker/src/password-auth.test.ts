import { it, expect } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
const base = "https://fixture.pitcrew.test";
const password = "synthetic-fixture-password-only";
const syntheticCode = () =>
  btoa(String.fromCharCode(...randomBytes(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function fixture() {
  const bundle = await build({
    entryPoints: [new URL("../test/password-auth-worker.ts", import.meta.url).pathname],
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
    d1Databases: { AUTH_DB: "synthetic-password-auth" },
    durableObjects: { AUTH_FIXTURE: { className: "PasswordAuthFixture", useSQLite: true } },
    bindings: {
      AUTH_MODE: "password-only",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "synthetic-better-auth-secret-never-live-123456789",
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
  let seq = 1;
  const req = (path: string, body?: unknown, cookie?: string, headers = {}) =>
    mf.dispatchFetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-connecting-ip": `192.0.2.${seq++}`,
        ...(body === undefined ? {} : { origin: base, "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const grant = async (email = "dev@lilfrogdev.com", expiresAt = Date.now() + 1800000) => {
    const code = syntheticCode(),
      id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at) VALUES(?,?,?,?)",
      )
      .bind(id, email, createHash("sha256").update(code).digest("hex"), expiresAt)
      .run();
    return { code, id, email };
  };
  const enroll = (code: string, username = "owner") =>
    req("/api/auth/enroll", {
      code,
      password,
      name: username,
      username,
      image: "/avatars/frog.svg",
    });
  const login = async (email = "dev@lilfrogdev.com", pw = password) => {
    const response = await req("/api/auth/sign-in/email", { email, password: pw });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    return response.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
  };
  const restart = async () => {
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// synthetic restart" }),
    );
    db = await mf.getD1Database("AUTH_DB");
  };
  return {
    mf,
    get db() {
      return db;
    },
    req,
    grant,
    enroll,
    login,
    restart,
  };
}
it("real Better Auth/workerd/D1 creates two privately enrolled unverified accounts and persists native hashes and sessions without SSO or mail", async () => {
  const f = await fixture();
  try {
    expect(await (await f.req("/api/auth/get-session")).json()).toBeNull();
    const owner = await f.grant(),
      bryan = await f.grant("bryan.aldair.zamora@gmail.com");
    expect((await f.enroll(owner.code)).status).toBe(200);
    expect((await f.enroll(bryan.code, "bryan")).status).toBe(200);
    const users = await f.db
      .prepare("SELECT id,email,email_verified,access_actor FROM user ORDER BY email")
      .all();
    expect(users.results).toHaveLength(2);
    for (const user of users.results) {
      expect(user.email_verified).toBe(0);
      expect(user.access_actor).toMatch(/^enrollment:/);
    }
    const hashes = await f.db.prepare("SELECT password FROM account").all();
    for (const account of hashes.results) {
      expect(account.password).not.toBe(password);
      expect(String(account.password).length).toBeGreaterThan(64);
    }
    expect((await f.db.prepare("SELECT COUNT(*) AS count FROM verification").first())?.count).toBe(
      0,
    );
    const cookie = await f.login();
    const response = await f.req("/api/auth/get-session", undefined, cookie, {
      "cf-access-jwt-assertion": "forged",
    });
    const text = await response.text();
    expect(text).not.toMatch(/token|accessActor|enrollment:/);
    const user = JSON.parse(text).user;
    expect(user).toMatchObject({
      email: owner.email,
      emailVerified: false,
      username: "owner",
      image: "/avatars/frog.svg",
    });
    expect(await (await f.req("/api/test/principal", undefined, cookie)).json()).toEqual({
      actor: `account:${user.id}`,
      credentialActor: `account:${user.id}`,
    });
    const bryanCookie = await f.login(bryan.email);
    expect(
      JSON.parse(await (await f.req("/api/auth/get-session", undefined, bryanCookie)).text()).user
        .id,
    ).not.toBe(user.id);
    await f.restart();
    expect(
      JSON.parse(await (await f.req("/api/auth/get-session", undefined, cookie)).text()).user.id,
    ).toBe(user.id);
    await f.db
      .prepare("UPDATE session SET expires_at=? WHERE user_id=?")
      .bind(Date.now() - 1, user.id)
      .run();
    expect(await (await f.req("/api/auth/get-session", undefined, cookie)).json()).toBeNull();
  } finally {
    await f.mf.dispose();
  }
});
it("capability recipient binding, expiry, atomic race/replay and partial-creation failures deny takeover", async () => {
  const f = await fixture();
  try {
    const owner = await f.grant();
    expect(
      (
        await f.req("/api/auth/enroll", {
          code: owner.code,
          email: "bryan.aldair.zamora@gmail.com",
          password,
          name: "x",
          username: "owner",
        })
      ).status,
    ).toBe(400);
    expect((await f.enroll(syntheticCode())).status).toBe(400);
    const raced = await Promise.all([f.enroll(owner.code), f.enroll(owner.code)]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await f.enroll(owner.code)).status).toBe(400);
    expect((await f.db.prepare("SELECT count(*) count FROM user").first())?.count).toBe(1);
    const bryan = await f.grant("bryan.aldair.zamora@gmail.com", Date.now() - 1);
    expect((await f.enroll(bryan.code, "bryan")).status).toBe(400);
    await f.db
      .prepare("UPDATE auth_enrollment SET expires_at=? WHERE id=?")
      .bind(Date.now() + 1800000, bryan.id)
      .run();
    // A unique username conflict consumes the grant without creating an
    // eligible account; a retry must never quietly restore the capability.
    expect([400, 503]).toContain((await f.enroll(bryan.code, "owner")).status);
    expect((await f.enroll(bryan.code, "bryan")).status).toBe(400);
    expect(
      (
        await f.db
          .prepare("SELECT consumed_at,consumed_user_id FROM auth_enrollment WHERE id=?")
          .bind(bryan.id)
          .first()
      )?.consumed_user_id,
    ).toBeNull();
    expect((await f.req("/api/auth/sign-in/email", { email: bryan.email, password })).status).toBe(
      401,
    );
    const cookie = await f.login();
    await f.db
      .prepare("UPDATE auth_enrollment SET consumed_user_id=NULL WHERE id=?")
      .bind(owner.id)
      .run();
    expect(await (await f.req("/api/auth/get-session", undefined, cookie)).json()).toBeNull();
    expect((await f.req("/api/auth/sign-in/email", { email: owner.email, password })).status).toBe(
      401,
    );
  } finally {
    await f.mf.dispose();
  }
});
it("public signup, recovery, SSO/linking and cross-origin or injected profile claims remain unavailable", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "sign-up/email",
      "request-password-reset",
      "reset-password",
      "send-verification-email",
      "sign-in/social",
      "link-social",
      "change-email",
    ])
      expect((await f.req(`/api/auth/${path}`, {})).status).toBe(404);
    expect((await f.req("/api/auth/verify-email?token=synthetic")).status).toBe(404);
    expect(
      (await f.req("/api/auth/enroll", {}, undefined, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await f.req("/api/auth/get-session?claim=owner")).status).toBe(400);
    const owner = await f.grant();
    expect((await f.enroll(owner.code)).status).toBe(200);
    const cookie = await f.login();
    expect(
      (
        await f.req(
          "/api/auth/update-user",
          { accessActor: "access:owner", emailVerified: true },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.req("/api/auth/update-user", { image: "https://tracker.example/a.png" }, cookie))
        .status,
    ).toBe(400);
    expect(
      (await f.req("/api/auth/update-user", { name: "New Name", username: "new_name" }, cookie))
        .status,
    ).toBe(200);
    expect(
      JSON.parse(await (await f.req("/api/auth/get-session", undefined, cookie)).text()).user,
    ).toMatchObject({ name: "New Name", username: "new_name", emailVerified: false });
    // A pre-existing Access-backed account is not admitted by an email match.
    await f.db
      .prepare("UPDATE user SET access_actor='access:legacy' WHERE email=?")
      .bind(owner.email)
      .run();
    expect((await f.req("/api/auth/sign-in/email", { email: owner.email, password })).status).toBe(
      401,
    );
  } finally {
    await f.mf.dispose();
  }
});
it("password change verifies old password, revokes other sessions, logout/revoke/expiry enforce durable authority", async () => {
  const f = await fixture();
  try {
    const owner = await f.grant();
    expect((await f.enroll(owner.code)).status).toBe(200);
    const first = await f.login(),
      second = await f.login();
    const changed = await f.req(
      "/api/auth/change-password",
      { currentPassword: password, newPassword: password + "new", revokeOtherSessions: false },
      second,
    );
    expect(changed.status).toBe(200);
    expect(await (await f.req("/api/auth/get-session", undefined, first)).json()).toBeNull();
    expect((await f.req("/api/auth/sign-in/email", { email: owner.email, password })).status).toBe(
      401,
    );
    const cookie = await f.login(owner.email, password + "new");
    expect((await f.req("/api/auth/revoke-sessions", {}, cookie)).status).toBe(200);
    expect(await (await f.req("/api/auth/get-session", undefined, cookie)).json()).toBeNull();
    await f.db.prepare("DELETE FROM auth_admission").run();
    await f.db.prepare("DELETE FROM rate_limit").run();
    const logout = await f.login(owner.email, password + "new");
    expect((await f.req("/api/auth/sign-out", {}, logout)).status).toBe(200);
    expect(await (await f.req("/api/auth/get-session", undefined, logout)).json()).toBeNull();
  } finally {
    await f.mf.dispose();
  }
});
it("atomic IP and recipient-purpose admission count malformed requests and persist across a Worker restart", async () => {
  const f = await fixture();
  try {
    await f.db
      .prepare("INSERT INTO auth_admission(key,count,started_at) VALUES('password:stale',100,?)")
      .bind(Date.now() - 86400001)
      .run();
    for (let n = 0; n < 5; n++)
      expect(
        (await f.req("/api/auth/enroll", {}, undefined, { "cf-connecting-ip": "192.0.2.200" }))
          .status,
      ).toBe(400);
    expect(
      await f.db.prepare("SELECT key FROM auth_admission WHERE key='password:stale'").first(),
    ).toBeNull();
    await f.restart();
    const throttled = await f.req("/api/auth/enroll", {}, undefined, {
      "cf-connecting-ip": "192.0.2.200",
    });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("x-retry-after"))).toBeGreaterThan(0);
    for (let n = 0; n < 5; n++)
      expect(
        (await f.req("/api/auth/sign-in/email", { email: "dev@lilfrogdev.com", password })).status,
      ).toBe(401);
    expect(
      (await f.req("/api/auth/sign-in/email", { email: "dev@lilfrogdev.com", password })).status,
    ).toBe(429);
  } finally {
    await f.mf.dispose();
  }
});
it("a failed primary-store session deletion never returns a successful logout or revocation receipt", async () => {
  const f = await fixture();
  try {
    const owner = await f.grant();
    expect((await f.enroll(owner.code)).status).toBe(200);
    const cookie = await f.login();
    await f.db
      .prepare(
        "CREATE TRIGGER refuse_session_delete BEFORE DELETE ON session BEGIN SELECT RAISE(FAIL,'synthetic deletion fault'); END",
      )
      .run();
    expect((await f.req("/api/auth/sign-out", {}, cookie)).status).toBe(503);
    expect((await f.req("/api/auth/revoke-sessions", {}, cookie)).status).toBe(503);
    expect(await f.db.prepare("SELECT id FROM session LIMIT 1").first()).not.toBeNull();
    await f.db.prepare("DROP TRIGGER refuse_session_delete").run();
    expect((await f.req("/api/auth/sign-out", {}, cookie)).status).toBe(200);
    expect(await f.db.prepare("SELECT id FROM session LIMIT 1").first()).toBeNull();
  } finally {
    await f.mf.dispose();
  }
});
it("password visualization grants freeze original session authority and replacement signin cannot revive a revoked grant", async () => {
  const f = await fixture();
  try {
    const owner = await f.grant();
    expect((await f.enroll(owner.code)).status).toBe(200);
    const cookie = await f.login();
    const first = JSON.parse(
      await (await f.req("/api/test/visualization-grant", undefined, cookie)).text(),
    );
    expect(first.mode).toBe("password-only");
    expect(first.actor).toMatch(/^account:/);
    expect((await f.req("/api/test/frozen-visualization")).status).toBe(200);
    expect((await f.req("/api/auth/revoke-sessions", {}, cookie)).status).toBe(200);
    expect((await f.req("/api/test/frozen-visualization")).status).toBe(401);
    const replacement = await f.login();
    const second = JSON.parse(
      await (await f.req("/api/test/visualization-grant", undefined, replacement)).text(),
    );
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await f.req("/api/test/frozen-visualization")).status).toBe(401);
    await f.db.prepare("UPDATE auth_enrollment SET consumed_user_id=NULL").run();
    expect((await f.req("/api/test/visualization-grant", undefined, replacement)).status).toBe(401);
  } finally {
    await f.mf.dispose();
  }
});
it("the real shared authority queue orders a paused old-password signin before password change and revokes its created session", async () => {
  const f = await fixture();
  try {
    const owner = await f.grant();
    expect((await f.enroll(owner.code)).status).toBe(200);
    const cookie = await f.login();
    const pendingLogin = f.req(
      "/api/auth/sign-in/email",
      { email: owner.email, password },
      undefined,
      { "x-test-pause-sign-in": "true" },
    );
    const waitFor = async (
      predicate: (value: { pending: number; verifyPaused: boolean }) => boolean,
    ) => {
      for (let n = 0; n < 200; n++) {
        const state = JSON.parse(await (await f.req("/api/test/queue-state")).text());
        if (predicate(state)) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw Error("Synthetic queue wait timed out");
    };
    await waitFor((state) => state.verifyPaused);
    const changing = f.req(
      "/api/auth/change-password",
      { currentPassword: password, newPassword: password + "new" },
      cookie,
    );
    await waitFor((state) => state.pending === 2);
    expect((await f.req("/api/test/release-verify")).status).toBe(200);
    const created = await pendingLogin;
    expect(created.status).toBe(200);
    const staleCookie = created.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
    expect((await changing).status).toBe(200);
    expect(await (await f.req("/api/auth/get-session", undefined, staleCookie)).json()).toBeNull();
    expect((await f.req("/api/auth/sign-in/email", { email: owner.email, password })).status).toBe(
      401,
    );
  } finally {
    await f.mf.dispose();
  }
});
