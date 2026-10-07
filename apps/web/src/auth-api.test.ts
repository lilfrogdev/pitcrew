import { afterEach, expect, it, vi } from "vite-plus/test";
import { httpAuthApi } from "./auth-api";
afterEach(() => vi.unstubAllGlobals());

it("uses relay admission and preserves the honest verification flag while projecting public fields", async () => {
  const fetch = vi.fn(async (path: string) =>
    path.endsWith("local-session")
      ? Response.json({ nonce: "a".repeat(64) })
      : path.endsWith("get-session")
        ? Response.json({
            user: {
              id: "account-1",
              email: "owner@example.com",
              name: "Owner",
              username: "owner",
              emailVerified: false,
              image: null,
              accessActor: "private",
              token: "private",
            },
            token: "private",
          })
        : Response.json({ status: true }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await httpAuthApi.session()).toEqual({
    user: {
      id: "account-1",
      email: "owner@example.com",
      name: "Owner",
      username: "owner",
      emailVerified: false,
      image: null,
    },
  });
  const code = "a".repeat(42) + "A";
  await httpAuthApi.enroll("Owner", "owner", code, "synthetic-password");
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls[1][1].headers).toEqual({ "X-Pitcrew-Auth-Nonce": "a".repeat(64) });
  expect(calls[3][0]).toBe("/api/auth/enroll");
  expect(calls[3][1]).toMatchObject({
    method: "POST",
    headers: {
      "X-Pitcrew-Auth-Nonce": "a".repeat(64),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    cache: "no-store",
  });
  expect(JSON.parse(calls[3][1].body as string)).toEqual({
    name: "Owner",
    username: "owner",
    code,
    password: "synthetic-password",
  });
});

it("sends personally entered credentials only in the password sign-in request body", async () => {
  const fetch = vi.fn(async (path: string) =>
    Response.json(path.endsWith("local-session") ? { nonce: "b".repeat(64) } : {}),
  );
  vi.stubGlobal("fetch", fetch);
  await httpAuthApi.signIn("owner@example.com", "synthetic-password");
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls[1][0]).toBe("/api/auth/sign-in/email");
  expect(JSON.parse(calls[1][1].body as string)).toEqual({
    email: "owner@example.com",
    password: "synthetic-password",
  });
  expect(calls.every(([path]) => !path.includes("synthetic-password"))).toBe(true);
});

it("stops before authentication if local relay admission fails", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await expect(httpAuthApi.signIn("owner@example.com", "synthetic-password")).rejects.toThrow(
    "Account services are unavailable",
  );
  expect(fetch).toHaveBeenCalledOnce();
});

it("rejects malformed verification flags and unapproved remote avatars", async () => {
  const user = {
    id: "a",
    email: "owner@example.com",
    name: "Owner",
    username: "owner",
    emailVerified: "false" as unknown,
    image: null as string | null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      Response.json(path.endsWith("local-session") ? { nonce: "b".repeat(64) } : { user }),
    ),
  );
  await expect(httpAuthApi.session()).rejects.toThrow("Session unavailable");
  user.emailVerified = true;
  user.image = "https://unapproved.example/avatar.png";
  await expect(httpAuthApi.session()).rejects.toThrow("Session unavailable");
  user.image = "/avatars/frog_green.svg";
  expect(await httpAuthApi.session()).toEqual({ user });
});

it("reports failed sign-in without reflecting backend diagnostics and signs out through relay admission", async () => {
  const fetch = vi.fn(async (path: string) =>
    path.endsWith("local-session")
      ? Response.json({ nonce: "a".repeat(64) })
      : path.endsWith("sign-in/email")
        ? Response.json({ message: "synthetic-sensitive-diagnostic" }, { status: 401 })
        : Response.json({ status: true }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(httpAuthApi.signIn("owner@example.com", "wrong-password")).rejects.toThrow(
    "Authentication could not be completed. Try again.",
  );
  await httpAuthApi.signOut();
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls[3][0]).toBe("/api/auth/sign-out");
  expect(calls[3][1]).toMatchObject({
    method: "POST",
    body: "{}",
    headers: {
      "X-Pitcrew-Auth-Nonce": "a".repeat(64),
      "Content-Type": "application/json",
    },
  });
});
