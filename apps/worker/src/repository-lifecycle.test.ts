import { expect, it, vi } from "vite-plus/test";
import {
  RepositoryLifecycle,
  lifecycleRequest,
  publicImportUrl,
  repositoryName,
  type LifecycleRecord,
} from "./repository-lifecycle";
function fixture() {
  const records = new Map<string, LifecycleRecord>();
  let present = false;
  let active = true;
  const repo = {
    [Symbol.dispose]() {},
    info: vi.fn(async () => ({ id: "new-id" })),
    listTokens: vi.fn(async () => ({
      total: 1,
      tokens: [{ id: "initial-id", state: active ? "active" : "revoked" }],
    })),
    revokeToken: vi.fn(async () => {
      active = false;
      return true;
    }),
  };
  const created = { id: "new-id", name: "sandbox", token: "SECRET_MUST_NOT_ESCAPE" };
  const binding = {
    list: vi.fn(async () => ({ repos: present ? [{ name: "sandbox" }] : [] })),
    get: vi.fn(async () => repo),
    create: vi.fn(async () => {
      present = true;
      return created;
    }),
    import: vi.fn(async () => {
      present = true;
      return created;
    }),
    delete: vi.fn(async () => {
      present = false;
      return true;
    }),
  };
  const referenced = vi.fn(() => false);
  const lifecycle = new RepositoryLifecycle(
    binding as unknown as Artifacts,
    {
      get: (name) => records.get(name),
      list: () => [...records.values()],
      put: (value) => records.set(value.name, { ...value }),
    },
    referenced,
  );
  const request = (path: string, body: unknown) =>
    lifecycleRequest(
      new Request(`https://backend/api/repositories/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      lifecycle,
    );
  return { records, repo, binding, lifecycle, referenced, request };
}
it("creates read-only, revokes credentials by metadata ID and exposes no plaintext", async () => {
  const f = fixture();
  const result = await f.request("create", { name: "sandbox", credentialConsent: true });
  expect(result.status).toBe(200);
  expect(await result.text()).not.toContain("SECRET");
  expect(JSON.stringify([...f.records.values()])).not.toContain("SECRET");
  expect(f.binding.create).toHaveBeenCalledWith("sandbox", {
    readOnly: true,
    setDefaultBranch: "main",
  });
  expect(f.repo.revokeToken).toHaveBeenCalledWith("initial-id");
  expect(f.records.get("sandbox")?.status).toBe("ready");
});
it("requires consent and validates public URLs/names before invoking the binding", async () => {
  const f = fixture();
  expect((await f.request("create", { name: "sandbox" })).status).toBe(400);
  for (const value of ["../bad", "A", "foo/bar", "-foo", "x".repeat(64)])
    expect(() => repositoryName(value)).toThrow();
  for (const value of [
    "http://github.com/a/b",
    "https://user:pass@github.com/a/b",
    "https://localhost/a/b",
    "https://github.com/a/b?token=x",
    "https://github.com/a/b/issues",
    "https://github.com/a/b#x",
  ]) {
    expect(() => publicImportUrl(value)).toThrow();
    expect(
      (await f.request("import", { name: "sandbox", credentialConsent: true, url: value })).status,
    ).toBe(400);
  }
  expect(f.binding.create).not.toHaveBeenCalled();
  expect(f.binding.import).not.toHaveBeenCalled();
});
it("imports a public default branch at depth1 and read-only", async () => {
  const f = fixture();
  await f.request("import", {
    name: "sandbox",
    credentialConsent: true,
    url: "https://github.com/example/repo",
  });
  expect(f.binding.import).toHaveBeenCalledWith({
    source: { url: "https://github.com/example/repo", depth: 1 },
    target: { name: "sandbox", opts: { readOnly: true } },
  });
});
it("serializes repeated creation and never replaces an existing or deleted name", async () => {
  const f = fixture();
  await Promise.all([
    f.lifecycle.provision("sandbox", "create"),
    f.lifecycle.provision("sandbox", "create"),
  ]);
  expect(f.binding.create).toHaveBeenCalledTimes(1);
  await f.lifecycle.remove("sandbox", "sandbox");
  await f.lifecycle.provision("sandbox", "create");
  expect(f.binding.create).toHaveBeenCalledTimes(1);
  const other = fixture();
  other.binding.list.mockResolvedValue({ repos: [{ name: "sandbox" }] });
  await expect(other.lifecycle.provision("sandbox", "create")).rejects.toThrow("repository_exists");
  expect(other.binding.create).not.toHaveBeenCalled();
  expect(other.repo.revokeToken).not.toHaveBeenCalled();
});
it("quarantines in-progress resources, reconciles cleanup and protects them from deletion", async () => {
  const f = fixture();
  f.binding.get.mockRejectedValueOnce(Error("IMPORT_IN_PROGRESS SECRET"));
  expect((await f.lifecycle.provision("sandbox", "import", "https://github.com/a/b")).status).toBe(
    "cleanup_required",
  );
  await expect(f.lifecycle.remove("sandbox", "sandbox")).rejects.toThrow("repository_protected");
  expect((await f.lifecycle.reconcile("sandbox")).status).toBe("ready");
  expect(f.binding.import).toHaveBeenCalledTimes(1);
});
it("does not retry or revoke tokens after ambiguous creation", async () => {
  const f = fixture();
  f.binding.create.mockRejectedValue(Error("SECRET transport failure"));
  expect((await f.lifecycle.provision("sandbox", "create")).status).toBe("pending");
  await f.lifecycle.provision("sandbox", "create");
  await expect(f.lifecycle.reconcile("sandbox")).rejects.toThrow();
  expect(f.binding.create).toHaveBeenCalledTimes(1);
  expect(f.repo.revokeToken).not.toHaveBeenCalled();
});
it("requires exact confirmation, excludes external/referenced/replaced resources and deletes once", async () => {
  const f = fixture();
  await expect(f.lifecycle.remove("sandbox", "sandbox")).rejects.toThrow("repository_protected");
  await f.lifecycle.provision("sandbox", "create");
  await expect(f.lifecycle.remove("sandbox", "other")).rejects.toThrow("confirmation_required");
  f.referenced.mockReturnValue(true);
  await expect(f.lifecycle.remove("sandbox", "sandbox")).rejects.toThrow("repository_protected");
  f.referenced.mockReturnValue(false);
  f.repo.info.mockResolvedValueOnce({ id: "replaced" });
  await expect(f.lifecycle.remove("sandbox", "sandbox")).rejects.toThrow("repository_protected");
  expect(f.binding.delete).not.toHaveBeenCalled();
  await f.lifecycle.remove("sandbox", "sandbox");
  await expect(f.lifecycle.remove("sandbox", "sandbox")).rejects.toThrow();
  expect(f.binding.delete).toHaveBeenCalledTimes(1);
});
it("redacts binding failures and fails closed with no configured backend", async () => {
  const f = fixture();
  f.binding.list.mockRejectedValue(Error("SECRET"));
  const response = await f.request("create", { name: "sandbox", credentialConsent: true });
  expect(await response.text()).not.toContain("SECRET");
  expect((await lifecycleRequest(new Request("https://backend/api/repositories"))).status).toBe(
    503,
  );
});
it("keeps pending creation visible, rejects a changed retry and bounds request bytes", async () => {
  const f = fixture();
  f.binding.create.mockRejectedValue(Error("transport failure"));
  await f.lifecycle.provision("sandbox", "create");
  expect((await f.lifecycle.list()).repositories).toEqual([
    { name: "sandbox", status: "unconfirmed", lifecycle: "pending", deletable: false },
  ]);
  await expect(
    f.lifecycle.provision("sandbox", "import", "https://github.com/a/b"),
  ).rejects.toThrow("repository_exists");
  expect(
    (
      await f.request("create", {
        name: "sandbox",
        credentialConsent: true,
        padding: "x".repeat(3000),
      })
    ).status,
  ).toBe(413);
});
it("rejects spoofed owner headers before lifecycle storage or service binding access", async () => {
  const { protectedFetch } = await import("./access");
  const f = fixture();
  const response = await protectedFetch(
    new Request("https://backend/api/repositories/create", {
      method: "POST",
      headers: {
        "cf-access-authenticated-user-email": "dev@lilfrogdev.com",
        origin: "https://backend",
      },
      body: JSON.stringify({ name: "sandbox", credentialConsent: true }),
    }),
    { ENVIRONMENT: "production" },
    (request) => lifecycleRequest(request, f.lifecycle),
  );
  expect(response.status).toBe(403);
  expect(f.binding.list).not.toHaveBeenCalled();
  expect(f.binding.create).not.toHaveBeenCalled();
});
it("does not mark cleanup complete with truncated token metadata or a failed revocation", async () => {
  const f = fixture();
  f.repo.revokeToken.mockResolvedValue(false);
  expect((await f.lifecycle.provision("sandbox", "create")).status).toBe("cleanup_required");
  const other = fixture();
  other.repo.listTokens.mockResolvedValue({ total: 2, tokens: [] });
  expect((await other.lifecycle.provision("sandbox", "create")).status).toBe("cleanup_required");
  expect(other.repo.revokeToken).not.toHaveBeenCalled();
});
