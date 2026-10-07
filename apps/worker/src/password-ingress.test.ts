import { expect, it } from "vite-plus/test";
import { passwordApiRoute, passwordIngressRequest } from "./password-ingress";

const base = "https://fixture.pitcrew.test";
const env = { AUTH_MODE: "password-only", BETTER_AUTH_URL: base };
const request = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  new Request(base + path, { method, headers: { origin: base, ...headers } });
const status = (value: Request | Response) => (value instanceof Response ? value.status : 200);

it("normalizes only scoped allowlisted account routes and removes caller identity claims", () => {
  const input = request("/app/api/threads/task/source/diff?path=app.ts", "GET", {
    "cf-access-jwt-assertion": "forged",
    "cf-access-token": "forged",
    authorization: "forged",
    "x-user-email": "owner@example.com",
    "x-pitcrew-auth-mode": "password-only",
    "cf-connecting-ip": "192.0.2.1",
    cookie: "__Secure-pitcrew-auth.session_token=held-cookie",
  });
  const normalized = passwordIngressRequest(input, env);
  expect(normalized).toBeInstanceOf(Request);
  if (!(normalized instanceof Request)) throw Error();
  expect(normalized.url).toBe(base + "/api/threads/task/source/diff?path=app.ts");
  expect(normalized.headers.get("cookie")).toContain("held-cookie");
  expect(normalized.headers.get("cf-connecting-ip")).toBe("192.0.2.1");
  for (const key of [
    "cf-access-jwt-assertion",
    "cf-access-token",
    "authorization",
    "x-user-email",
    "x-pitcrew-auth-mode",
  ])
    expect(normalized.headers.has(key)).toBe(false);
  expect(
    status(
      passwordIngressRequest(request("/app/api/threads/t/members/account%3Auser", "DELETE"), env),
    ),
  ).toBe(200);
  for (const path of [
    "/api/projects/p/threads/t/visualizations",
    "/api/projects/p/threads/t/visualizations/v",
    "/api/threads/t/presence",
  ])
    expect(status(passwordIngressRequest(request("/app" + path), env))).toBe(200);
  expect(
    status(
      passwordIngressRequest(
        request("/app/api/threads/t/presence", "POST", { "content-type": "application/json" }),
        env,
      ),
    ),
  ).toBe(200);
  expect(passwordApiRoute("/api/threads/t/presence", "DELETE")).toBe(false);
  expect(passwordApiRoute("/api/project-adoptions", "GET")).toBe(true);
  expect(passwordApiRoute("/api/projects", "POST")).toBe(true);
});

it("denies lifecycle, paid runs, publisher routes and unused auth methods", () => {
  for (const path of [
    "/api/repositories/create",
    "/api/repositories/import",
    "/api/repositories/delete",
    "/api/repositories/reconcile",
    "/api/projects/p/intake/dispatch",
    "/api/changes/c/runs",
    "/api/runs/r/merge-approval",
    "/api/runs/r/landing",
    "/api/runs/r/landing/reconcile",
    "/api/auth/sign-up/email",
    "/api/auth/sign-in/email",
    "/api/auth/is-username-available",
    "/api/auth/send-verification-email",
    "/api/auth/request-password-reset",
    "/api/projects/p/threads/t/visualizations",
  ]) {
    expect(passwordApiRoute(path, "POST")).toBe(false);
    expect(
      status(
        passwordIngressRequest(
          request("/app" + path, "POST", { "content-type": "application/json" }),
          env,
        ),
      ),
    ).toBe(404);
  }
  for (const action of [
    "enroll",
    "sign-in/username",
    "sign-out",
    "revoke-sessions",
    "update-user",
    "change-password",
  ])
    expect(passwordApiRoute("/api/auth/" + action, "POST")).toBe(true);
});

it("fails closed on wrong mode, origin, methods, selectors and ambiguous encodings", () => {
  expect(
    status(
      passwordIngressRequest(request("/app/api/account"), { ...env, AUTH_MODE: "better-auth" }),
    ),
  ).toBe(404);
  expect(status(passwordIngressRequest(request("/api/account"), env))).toBe(404);
  expect(
    status(
      passwordIngressRequest(request("/app/api/account"), {
        ...env,
        BETTER_AUTH_URL: "https://other.test",
      }),
    ),
  ).toBe(403);
  for (const headers of [
    { origin: "https://evil.test" },
    { "sec-fetch-site": "same-site" },
  ] as Record<string, string>[])
    expect(status(passwordIngressRequest(request("/app/api/account", "GET", headers), env))).toBe(
      403,
    );
  const noOrigin = new Request(base + "/app/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(status(passwordIngressRequest(noOrigin, env))).toBe(403);
  expect(status(passwordIngressRequest(request("/app/api/auth/sign-out", "POST"), env))).toBe(415);
  for (const path of [
    "/app/api/threads/a%2fb/messages",
    "/app/api/threads/a%5cb/messages",
    "/app/api/threads/a%252fb/messages",
    "/app/api//account",
    "/app/api/account?actor=owner",
    "/app/api/capabilities?projectId=a&projectId=b",
    "/app/api/threads/t/source/file?path=a&path=b",
    "/app/api/threads/t/presence?username=other",
    "/app/api/projects/p/events?after=-1",
  ])
    expect(status(passwordIngressRequest(request(path), env))).toBeGreaterThanOrEqual(400);
});

it("admits native username sign-in without admitting legacy email or enumeration routes", () => {
  const input = new Request(base + "/app/api/auth/sign-in/username", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify({ username: "MiXeD_owner", password: "synthetic-password" }),
  });
  const normalized = passwordIngressRequest(input, env);
  expect(normalized).toBeInstanceOf(Request);
  if (!(normalized instanceof Request)) throw Error();
  expect(normalized.url).toBe(base + "/api/auth/sign-in/username");
  expect(normalized.headers.get("cf-connecting-ip")).toBe("192.0.2.1");
  expect(passwordApiRoute("/api/auth/sign-in/username", "GET")).toBe(false);
});
