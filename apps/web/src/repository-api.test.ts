import { afterEach, expect, it, vi } from "vite-plus/test";
import { apiFetch, httpApi } from "./api";
import { createRepositoryApi } from "./repository-api";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("initializes the HTTP repository adapter without a circular module crash", () => {
  expect(httpApi.repositories).toBeDefined();
  expect(createRepositoryApi().list).toBeTypeOf("function");
});
it("uses isolated backend session admission for consented mutations and sends no credentials", async () => {
  const fetcher = vi.fn(async (path: string) =>
    path === "/api/backend-session"
      ? Response.json({ nonce: "a".repeat(64) })
      : Response.json({ name: "sandbox", status: "ready" }),
  );
  vi.stubGlobal("fetch", fetcher);
  await createRepositoryApi().provision({
    name: "sandbox",
    operation: "create",
    credentialConsent: true,
  });
  expect(fetcher.mock.calls[0][0]).toBe("/api/backend-session");
  expect(fetcher.mock.calls[1][0]).toBe("/api/repositories/create");
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("X-Pitcrew-Local-Nonce");
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("token");
});
it("renders only allowlisted errors, even if backend errors include secret text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "SECRET" }, { status: 500 })),
  );
  await expect(createRepositoryApi().list()).rejects.toThrow("Refresh to check its status");
});

it("allows the bounded Access preparation and upstream deadline for repository requests", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path === "/api/backend-session"
        ? Response.json({ nonce: "a".repeat(64) })
        : path.endsWith("/create")
          ? Response.json({ name: "sandbox", status: "ready" })
          : Response.json({ repositories: [], cursor: null }),
    ),
  );
  await createRepositoryApi().list();
  expect(timeout).toHaveBeenCalledWith(45000);
  timeout.mockClear();
  await createRepositoryApi().provision({
    name: "sandbox",
    operation: "create",
    credentialConsent: true,
  });
  expect(timeout).toHaveBeenCalledWith(45000);
  timeout.mockClear();
  await apiFetch("/snapshot");
  expect(timeout).toHaveBeenCalledExactlyOnceWith(45000);
});

it("never automatically retries repository mutations after Access or admission rejection", async () => {
  const fetcher = vi.fn(async (path: string) =>
    path === "/api/backend-session" || path === "/api/local-session"
      ? Response.json({ nonce: "a".repeat(64) })
      : Response.json({ error: "backend_sign_in_required" }, { status: 403 }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createRepositoryApi().provision({
      name: "sandbox",
      operation: "create",
      credentialConsent: true,
    }),
  ).rejects.toThrow();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/repositories/create")).toHaveLength(
    1,
  );
  fetcher.mockClear();
  await apiFetch("/threads/thread/messages", { text: "synthetic" });
  expect(
    fetcher.mock.calls.filter(([path]) => path === "/api/threads/thread/messages"),
  ).toHaveLength(2);
});
it("normalizes equivalent public GitHub import forms before requesting the backend session", async () => {
  const fetcher = vi.fn(async (path: string, _init?: RequestInit) =>
    path === "/api/backend-session"
      ? Response.json({ nonce: "a".repeat(64) })
      : Response.json({ name: "sandbox", status: "ready" }),
  );
  vi.stubGlobal("fetch", fetcher);
  for (const [url, canonical] of [
    ["https://github.com/example/repo", "https://github.com/example/repo"],
    ["https://github.com/example/repo/", "https://github.com/example/repo"],
    ["https://github.com/example/repo.git/", "https://github.com/example/repo.git"],
    ["HTTPS://GITHUB.COM:443/Example/repo.name/", "https://github.com/Example/repo.name"],
  ]) {
    fetcher.mockClear();
    await createRepositoryApi().provision({
      name: "sandbox",
      operation: "import",
      url,
      credentialConsent: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe("/api/backend-session");
    const [path, init] = fetcher.mock.calls[1];
    expect(path).toBe("/api/repositories/import");
    expect(JSON.parse(init!.body as string)).toEqual({
      name: "sandbox",
      url: canonical,
      credentialConsent: true,
    });
  }
});
it("rejects unsafe or ambiguous import URLs locally without session or mutation requests", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  for (const url of [
    "http://github.com/a/b",
    "https://user:password@github.com/a/b",
    "https://github.com/a/b?token=synthetic",
    "https://github.com/a/b#fragment",
    "https://github.com/a/b/issues",
    "https://github.com/a/b//",
    "https://github.com/owner.name/repo",
    "https://github.com/a/../owner/repo",
    "https://github.com/a/%62",
    "https://github.com:444/a/b",
    "https://github.com.evil.example/a/b",
    "https://github.com/a/b\n",
    "https://github.com/a\\b",
    "not a URL",
    undefined,
  ])
    await expect(
      createRepositoryApi().provision({
        name: "sandbox",
        operation: "import",
        url,
        credentialConsent: true,
      }),
    ).rejects.toThrow("Enter a public GitHub repository HTTPS URL");
  expect(fetcher).not.toHaveBeenCalled();
});
