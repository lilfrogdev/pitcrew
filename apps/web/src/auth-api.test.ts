import { afterEach, expect, it, vi } from "vite-plus/test";
import { httpAuthApi } from "./auth-api";
afterEach(() => vi.unstubAllGlobals());

it("uses relay admission for reads and mutations and projects only public account fields", async () => {
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
              emailVerified: true,
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
      emailVerified: true,
      image: null,
    },
  });
  await httpAuthApi.enroll("Owner", "owner", "owner@example.com", "synthetic-password");
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls[1][1].headers).toEqual({ "X-Pitcrew-Auth-Nonce": "a".repeat(64) });
  expect(calls[3][1].headers).toEqual({
    "X-Pitcrew-Auth-Nonce": "a".repeat(64),
    "Content-Type": "application/json",
  });
  expect(JSON.parse(calls[3][1].body as string)).toEqual({
    name: "Owner",
    username: "owner",
    email: "owner@example.com",
    password: "synthetic-password",
  });
});

it("stops before authentication if local relay admission fails", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await expect(httpAuthApi.signIn("owner@example.com", "synthetic-password")).rejects.toThrow(
    "Account services are unavailable",
  );
  expect(fetch).toHaveBeenCalledOnce();
});

it("rejects an unverified account or an unapproved remote avatar in a projected session", async () => {
  const user = {
    id: "a",
    email: "owner@example.com",
    name: "Owner",
    username: "owner",
    emailVerified: false,
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
});
