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
    revokeToken: vi.fn(async (_id: string) => {
      active = false;
      return true;
    }),
  };
  const created = { id: "new-id", name: "sandbox", token: "SECRET_MUST_NOT_ESCAPE" };
  const binding = {
    list: vi.fn(async () => ({ repos: present ? [{ name: "sandbox", id: "new-id" }] : [] })),
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
it("normalizes equivalent GitHub import forms before the binding and persisted identity", async () => {
  for (const [url, canonical] of [
    ["https://github.com/example/repo", "https://github.com/example/repo"],
    ["https://github.com/example/repo/", "https://github.com/example/repo"],
    ["https://github.com/example/repo.git/", "https://github.com/example/repo.git"],
    ["HTTPS://GITHUB.COM:443/Example/repo.name/", "https://github.com/Example/repo.name"],
  ]) {
    const f = fixture();
    expect(
      (await f.request("import", { name: "sandbox", credentialConsent: true, url })).status,
    ).toBe(200);
    expect(
      (await f.request("import", { name: "sandbox", credentialConsent: true, url: canonical }))
        .status,
    ).toBe(200);
    expect(f.binding.import).toHaveBeenCalledExactlyOnceWith({
      source: { url: canonical, depth: 1 },
      target: { name: "sandbox", opts: { readOnly: true } },
    });
    expect(f.records.get("sandbox")?.source).toBe(canonical);
  }
});
it("rejects unsafe or ambiguous import syntax without records, credentials or resource effects", async () => {
  const f = fixture();
  for (const url of [
    "https://github.com/owner.name/repo",
    "https://github.com/a/b//",
    "https://github.com/a/../owner/repo",
    "https://github.com/a/%2e%2e/owner/repo",
    "https://github.com/a/%62",
    "https://github.com/a/.",
    "https://github.com/a/..",
    "https://github.com:444/a/b",
    "https://github.com./a/b",
    "https://github.com.evil.example/a/b",
    "https://github.com/a/b?",
    "https://github.com/a/b#",
    "https://github.com/a/b\n",
    " https://github.com/a/b",
    "https://github.com/a\\b",
    "https://user@github.com/a/b",
    "//github.com/a/b",
    "https://github.com/a/" + "b".repeat(512),
    "not a URL",
    null,
  ]) {
    expect(() => publicImportUrl(url)).toThrow("invalid_public_url");
    const response = await f.request("import", { name: "sandbox", credentialConsent: true, url });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_public_url" });
  }
  expect(f.records.size).toBe(0);
  expect(f.binding.import).not.toHaveBeenCalled();
  expect(f.repo.revokeToken).not.toHaveBeenCalled();
});
it("serializes repeated creation and never replaces an existing or deleted name", async () => {
  const f = fixture();
  await Promise.all([
    f.lifecycle.provision("sandbox", "create"),
    f.lifecycle.provision("sandbox", "create"),
  ]);
  expect(f.binding.create).toHaveBeenCalledTimes(1);
  await f.lifecycle.remove("sandbox", "sandbox");
  await expect(f.lifecycle.provision("sandbox", "create")).rejects.toThrow(
    "repository_name_retired",
  );
  expect(f.binding.create).toHaveBeenCalledTimes(1);
  const other = fixture();
  other.binding.list.mockResolvedValue({ repos: [{ name: "sandbox", id: "new-id" }] });
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
  expect(await f.lifecycle.remove("sandbox", "sandbox")).toEqual({
    name: "sandbox",
    status: "deleted",
  });
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
it("persists delete intent, reconciles response loss safely and keeps tombstone retries idempotent", async () => {
  const f = fixture();
  await f.lifecycle.provision("sandbox", "create");
  f.binding.delete.mockImplementationOnce(async () => {
    f.binding.list.mockResolvedValue({ repos: [] });
    throw Error("response lost SECRET");
  });
  await expect(f.lifecycle.remove("sandbox", "sandbox")).rejects.toThrow();
  expect(f.records.get("sandbox")?.status).toBe("deleting");
  expect((await f.lifecycle.list()).repositories[0].lifecycle).toBe("deleting");
  await expect(f.lifecycle.provision("sandbox", "create")).rejects.toThrow("deletion_pending");
  f.binding.get.mockRejectedValueOnce(Error("unknown transport"));
  await expect(f.lifecycle.reconcile("sandbox")).rejects.toThrow("deletion_pending");
  expect(f.records.get("sandbox")?.status).toBe("deleting");
  f.binding.get.mockRejectedValueOnce(Error("NOT_FOUND"));
  expect((await f.lifecycle.reconcile("sandbox")).status).toBe("deleted");
  expect(await f.lifecycle.remove("sandbox", "sandbox")).toEqual({
    name: "sandbox",
    status: "deleted",
  });
  expect(f.binding.delete).toHaveBeenCalledTimes(1);
});
it("delete reconciliation keeps the same existing ID frozen and never admits a replacement", async () => {
  const f = fixture();
  await f.lifecycle.provision("sandbox", "create");
  f.binding.delete.mockRejectedValue(Error("response lost"));
  await expect(f.lifecycle.remove("sandbox", "sandbox")).rejects.toThrow();
  f.repo.info.mockResolvedValueOnce({ id: "replacement" });
  await expect(f.lifecycle.reconcile("sandbox")).rejects.toThrow("deletion_pending");
  expect(f.records.get("sandbox")?.status).toBe("deleting");
  expect((await f.lifecycle.reconcile("sandbox")).status).toBe("deleting");
  expect(f.binding.delete).toHaveBeenCalledTimes(1);
});
it("does not claim ownership/deletion permission for a replacement sharing the name", async () => {
  const f = fixture();
  await f.lifecycle.provision("sandbox", "create");
  f.binding.list.mockResolvedValue({ repos: [{ name: "sandbox", id: "replacement" }] });
  const [item] = (await f.lifecycle.list()).repositories;
  expect(item.lifecycle).toBe("external");
  expect(item.deletable).toBe(false);
});
it("rejects protected names before minting and retired names with an explicit error", async () => {
  const f = fixture();
  f.referenced.mockReturnValue(true);
  expect((await f.request("create", { name: "sandbox", credentialConsent: true })).status).toBe(
    409,
  );
  expect(f.binding.create).not.toHaveBeenCalled();
  f.referenced.mockReturnValue(false);
  await f.lifecycle.provision("sandbox", "create");
  await f.lifecycle.remove("sandbox", "sandbox");
  const response = await f.request("create", { name: "sandbox", credentialConsent: true });
  expect(await response.json()).toEqual({ error: "repository_name_retired" });
});
it("exposes allowlisted import failures without raw messages, unsafe cleanup or resubmission", async () => {
  for (const [code, issue] of [
    ["REMOTE_AUTH_REQUIRED", "import_source_authentication_required"],
    ["NOT_FOUND", "import_source_not_found"],
    ["MEMORY_LIMIT", "import_limit_exceeded"],
  ]) {
    const f = fixture();
    f.binding.import.mockRejectedValue(Error(`${code}: SECRET`));
    const input = { name: "sandbox", url: "https://github.com/a/b", credentialConsent: true };
    const response = await f.request("import", input);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: issue });
    expect(f.records.get("sandbox")?.status).toBe("pending");
    expect(f.records.get("sandbox")?.issue).toBe(issue);
    expect(JSON.stringify([...f.records.values()])).not.toContain("SECRET");
    await f.request("import", input);
    expect(f.binding.import).toHaveBeenCalledTimes(1);
    expect(f.repo.revokeToken).not.toHaveBeenCalled();
  }
});
it("binds lifecycle records to their initiating account and denies guessed names or legacy unowned records", async () => {
  const f = fixture();
  await f.lifecycle.provision("sandbox", "create", undefined, "account:owner");
  expect(f.records.get("sandbox")?.ownerActor).toBe("account:owner");
  const calls = f.binding.get.mock.calls.length;
  await expect(
    f.lifecycle.provision("sandbox", "create", undefined, "account:colleague"),
  ).rejects.toThrow("not_found");
  await expect(f.lifecycle.reconcile("sandbox", "account:colleague")).rejects.toThrow("not_found");
  await expect(f.lifecycle.remove("sandbox", "sandbox", "account:colleague")).rejects.toThrow(
    "not_found",
  );
  expect(f.binding.get.mock.calls.length).toBe(calls);
  f.records.set("legacy", { name: "legacy", operation: "create", status: "ready", id: "old-id" });
  await expect(f.lifecycle.remove("legacy", "legacy", "account:owner")).rejects.toThrow(
    "not_found",
  );
});

it("native deletion freezes before provider access, revokes by ID, confirms absence and retires names", async () => {
  const f = fixture();
  await f.lifecycle.provision("sandbox", "create", undefined, "account:owner");
  f.repo.revokeToken.mockClear();
  let frozen = false;
  const fresh = vi.fn(async () => {});
  f.repo.listTokens.mockResolvedValue({
    total: 2,
    tokens: [
      { id: "one-id", state: "active" },
      { id: "two-id", state: "active" },
    ],
  });
  f.repo.revokeToken.mockImplementation(async () => {
    expect(frozen).toBe(true);
    f.repo.listTokens.mockResolvedValue({ total: 0, tokens: [] });
    return true;
  });
  f.binding.delete.mockImplementation(async () => {
    expect(frozen).toBe(true);
    f.binding.get.mockRejectedValue(Error("NOT_FOUND"));
    return true;
  });
  const removed = await f.lifecycle.removeOwned(
    "sandbox",
    "new-id",
    "sandbox",
    "account:owner",
    async () => {
      frozen = true;
    },
    fresh,
  );
  expect(removed.status).toBe("deleted");
  expect(f.repo.revokeToken.mock.calls.map(([id]) => id)).toEqual(["one-id", "two-id"]);
  expect(fresh.mock.calls.length).toBeGreaterThan(6);
  await expect(
    f.lifecycle.provision("sandbox", "create", undefined, "account:owner"),
  ).rejects.toThrow("repository_name_retired");
});

it("native delete acceptance and response loss remain frozen until explicit same-ID recovery", async () => {
  const f = fixture();
  await f.lifecycle.provision("sandbox", "create", undefined, "account:owner");
  f.binding.delete.mockRejectedValueOnce(Error("transport secret"));
  const fresh = async () => {};
  expect(
    (await f.lifecycle.removeOwned("sandbox", "new-id", "sandbox", "account:owner", fresh, fresh))
      .status,
  ).toBe("deleting");
  expect((await f.lifecycle.observeDeletion("sandbox", "new-id", "account:owner")).status).toBe(
    "deleting",
  );
  expect(f.binding.delete).toHaveBeenCalledTimes(1);
  await expect(
    f.lifecycle.removeOwned("sandbox", "replacement", "sandbox", "account:owner", fresh, fresh),
  ).rejects.toThrow("repository_identity_changed");
  f.binding.delete.mockImplementationOnce(async () => {
    f.binding.get.mockRejectedValue(Error("NOT_FOUND"));
    return true;
  });
  expect(
    (await f.lifecycle.removeOwned("sandbox", "new-id", "sandbox", "account:owner", fresh, fresh))
      .status,
  ).toBe("deleted");
  expect(f.binding.delete).toHaveBeenCalledTimes(2);
});

it("native deletion rejects session loss or source replacement before token and delete admission", async () => {
  for (const mode of ["session", "replacement"]) {
    const f = fixture();
    await f.lifecycle.provision("sandbox", "create", undefined, "account:owner");
    f.repo.revokeToken.mockClear();
    const fresh =
      mode === "session"
        ? async () => {
            throw Error("unauthorized");
          }
        : async () => {};
    if (mode === "replacement") f.repo.info.mockResolvedValue({ id: "replacement" });
    await expect(
      f.lifecycle.removeOwned(
        "sandbox",
        "new-id",
        "sandbox",
        "account:owner",
        async () => {},
        fresh,
      ),
    ).rejects.toThrow(mode === "session" ? "unauthorized" : "repository_identity_changed");
    expect(f.records.get("sandbox")?.status).toBe("deleting");
    expect(f.repo.revokeToken).not.toHaveBeenCalled();
    expect(f.binding.delete).not.toHaveBeenCalled();
  }
});

it("token NOT_FOUND and incomplete metadata never establish repository absence", async () => {
  const f = fixture();
  await f.lifecycle.provision("sandbox", "create", undefined, "account:owner");
  f.repo.listTokens.mockRejectedValue(Error("NOT_FOUND"));
  const fresh = async () => {};
  expect(
    (await f.lifecycle.removeOwned("sandbox", "new-id", "sandbox", "account:owner", fresh, fresh))
      .status,
  ).toBe("deleting");
  expect(f.binding.delete).not.toHaveBeenCalled();
  f.repo.listTokens.mockResolvedValue({ total: 2, tokens: [] });
  expect(
    (await f.lifecycle.removeOwned("sandbox", "new-id", "sandbox", "account:owner", fresh, fresh))
      .status,
  ).toBe("deleting");
  expect(f.binding.delete).not.toHaveBeenCalled();
});
