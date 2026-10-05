import { afterEach, expect, it, vi } from "vite-plus/test";
import { httpApi } from "./api";
import { createRepositoryApi } from "./repository-api";
afterEach(() => vi.unstubAllGlobals());
it("initializes the HTTP repository adapter without a circular module crash", () => {
  expect(httpApi.repositories).toBeDefined();
  expect(createRepositoryApi().list).toBeTypeOf("function");
});
it("uses existing session admission for consented mutations and sends no credentials", async () => {
  const fetcher = vi.fn(async (path: string) =>
    path === "/api/local-session"
      ? Response.json({ nonce: null })
      : Response.json({ name: "sandbox", status: "ready" }),
  );
  vi.stubGlobal("fetch", fetcher);
  await createRepositoryApi().provision({
    name: "sandbox",
    operation: "create",
    credentialConsent: true,
  });
  expect(fetcher.mock.calls[1][0]).toBe("/api/repositories/create");
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("token");
});
it("renders only allowlisted errors, even if backend errors include secret text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "SECRET" }, { status: 500 })),
  );
  await expect(createRepositoryApi().list()).rejects.toThrow("Refresh to check its status");
});
