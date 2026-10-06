import { expect, it } from "vite-plus/test";
import { api } from "./api";
import { principal, protectedFetch } from "./access";
import { Coordinator, initialState } from "./coordinator";
const env = { ENVIRONMENT: "development", FIXTURE_IDENTITY: "lilfrogdev" };
it("rejects both attacker-origin state mutations through protected Hono admission", async () => {
  const core = new Coordinator(initialState(), () => {});
  const post = async (path: string, body: unknown, origin: string) => {
    const request = new Request(`http://127.0.0.1:8787/api/projects/pitcrew/${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    });
    return protectedFetch(request, env, async (request) =>
      api(core, () => {}, undefined, (await principal(request, env))!).fetch(request),
    );
  };
  const profile = { ...core.profile(), revision: "attacker-revision" };
  expect(
    (
      await post(
        "verification-profile",
        { profile, expectedRevision: core.profile().revision },
        "http://attacker.example",
      )
    ).status,
  ).toBe(403);
  expect(core.profile().revision).toBe("poc-checks-v1");
  expect(
    (
      await post(
        "knowledge",
        {
          idempotencyKey: "attack",
          mutation: {
            id: "attack",
            expectedVersion: 0,
            status: "accepted",
            kind: "constraint",
            text: "Attacker guidance",
            reason: "Attacker choice",
            sourceRefs: [{ kind: "code", id: "source", revision: "base", path: "package.json" }],
          },
        },
        "https://attacker.example",
      )
    ).status,
  ).toBe(403);
  expect(core.repositoryContext().acceptedDecisions.some((entry) => entry.id === "attack")).toBe(
    false,
  );
});
it("enforces local origin and per-session capability on every unsafe method before routing", async () => {
  const base = "http://127.0.0.1:8787";
  const session = await protectedFetch(new Request(`${base}/api/local-session`), env, async () => {
    throw Error("no route");
  });
  const { nonce } = (await session.json()) as { nonce: string };
  const cookie = session.headers.get("set-cookie")!.split(";", 1)[0];
  expect(nonce).toMatch(/^[a-f0-9]{64}$/);
  expect(session.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect(session.headers.get("set-cookie")).not.toMatch(/Expires|Max-Age/);
  const origins = [
    undefined,
    "null",
    "http://attacker.example",
    "http://127.0.0.1:5174",
    `${base}/`,
    `${base}, ${base}`,
  ];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const origin of origins) {
      const request = new Request(`${base}/api/projects/pitcrew/knowledge`, {
        method,
        headers: {
          cookie,
          "X-Pitcrew-Local-Nonce": nonce,
          ...(origin ? { origin } : {}),
          "X-Forwarded-Host": "127.0.0.1:5173",
        },
      });
      expect(await principal(request, env)).toBeUndefined();
    }
  }
  for (const badCookie of ["", `${cookie}; ${cookie}`, "pitcrew-local-nonce=guess"]) {
    expect(
      await principal(
        new Request(`${base}/api/x`, {
          method: "POST",
          headers: { origin: base, cookie: badCookie, "X-Pitcrew-Local-Nonce": nonce },
        }),
        env,
      ),
    ).toBeUndefined();
  }
  expect(
    await principal(
      new Request(`${base}/api/x`, {
        method: "POST",
        headers: { origin: base, cookie, "X-Pitcrew-Local-Nonce": "0".repeat(64) },
      }),
      env,
    ),
  ).toBeUndefined();
  for (const origin of [base, "http://127.0.0.1:5173", "http://localhost:5173"]) {
    expect(
      await principal(
        new Request(`${base}/api/x`, {
          method: "POST",
          headers: { origin, cookie, "X-Pitcrew-Local-Nonce": nonce },
        }),
        env,
      ),
    ).toEqual({ actor: "lilfrogdev", email: "dev@lilfrogdev.com" });
  }
  for (const headers of [
    { origin: "https://attacker.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ] as Record<string, string>[]) {
    expect(
      (
        await protectedFetch(
          new Request(`${base}/api/local-session`, { headers }),
          env,
          async () => {
            throw Error("no route");
          },
        )
      ).status,
    ).toBe(403);
  }
  const next = await protectedFetch(
    new Request(`${base}/api/local-session`, { headers: { cookie } }),
    env,
    async () => {
      throw Error("no route");
    },
  );
  expect(await next.json()).toEqual({ nonce });
});
it("rejects alternate media types on all POST routes and preserves legitimate profile/knowledge mutations", async () => {
  const core = new Coordinator(initialState(), () => {});
  const app = api(core, () => {}, undefined, { actor: "lilfrogdev" });
  const paths = [
    "/projects/pitcrew/knowledge",
    "/projects/pitcrew/verification-profile",
    "/projects/pitcrew/reports",
    "/projects/pitcrew/intake/move",
    "/projects/pitcrew/intake/dispatch",
    "/projects/pitcrew/threads",
    "/projects/pitcrew/threads/x/archive",
    "/threads/x/messages",
    "/changes/x/runs",
    "/runs/x/merge-approval",
    "/runs/x/landing",
    "/runs/x/landing/reconcile",
  ];
  for (const path of paths)
    for (const type of [
      undefined,
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/jsonp",
      "application/json, text/plain",
    ]) {
      const response = await app.request(`http://localhost/api${path}`, {
        method: "POST",
        headers: type ? { "Content-Type": type } : {},
        body: "{}",
      });
      expect(response.status).toBe(415);
    }
  const nonceResponse = await protectedFetch(
    new Request("http://localhost/api/local-session"),
    env,
    async () => {
      throw Error("no route");
    },
  );
  const { nonce } = (await nonceResponse.json()) as { nonce: string };
  const headers = {
    origin: "http://localhost",
    cookie: nonceResponse.headers.get("set-cookie")!.split(";", 1)[0],
    "X-Pitcrew-Local-Nonce": nonce,
    "Content-Type": "Application/JSON; charset=utf-8",
  };
  const post = (path: string, body: unknown) =>
    protectedFetch(
      new Request(`http://localhost/api/projects/pitcrew/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      env,
      async (request) =>
        api(core, () => {}, undefined, (await principal(request, env))!).fetch(request),
    );
  expect(
    (
      await post("verification-profile", {
        profile: { ...core.profile(), revision: "owner-revision" },
        expectedRevision: core.profile().revision,
      })
    ).status,
  ).toBe(200);
  expect(core.profile().revision).toBe("owner-revision");
  expect(
    (
      await post("knowledge", {
        idempotencyKey: "owner",
        mutation: {
          id: "owner",
          expectedVersion: 0,
          status: "accepted",
          kind: "constraint",
          text: "Owner guidance",
          reason: "Owner choice",
          sourceRefs: [{ kind: "code", id: "source", revision: "base", path: "package.json" }],
        },
      })
    ).status,
  ).toBe(201);
  expect(core.repositoryContext().acceptedDecisions.some((entry) => entry.id === "owner")).toBe(
    true,
  );
});
