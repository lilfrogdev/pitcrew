import { expect, it, vi } from "vite-plus/test";
import {
  accountRepositoryDeletion,
  accountRepositoryManagement,
} from "./account-repository-creation";
import {
  RepositoryLifecycle,
  lifecycleRequest,
  publicImportUrl,
  repositoryName,
  logicalRepositoryName,
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

it("native deletion defaults off while routine management stays enabled", () => {
  const env = {
    AUTH_MODE: "password-only",
    ENVIRONMENT: "production",
    ARTIFACTS: {},
    ACCOUNT_REPOSITORY_MANAGEMENT: "enabled",
  };
  const actor = "account:immutable-owner";
  expect(accountRepositoryManagement(env, actor)).toBe(true);
  for (const flag of [undefined, "", "disabled", "false", "true", "ENABLED"])
    expect(accountRepositoryDeletion({ ...env, ACCOUNT_REPOSITORY_DELETE: flag }, actor)).toBe(
      false,
    );
  expect(accountRepositoryDeletion({ ...env, ACCOUNT_REPOSITORY_DELETE: "enabled" }, actor)).toBe(
    true,
  );
});

it("native delete approval cannot bypass management, native identity, production or the binding", () => {
  const env = {
    AUTH_MODE: "password-only",
    ENVIRONMENT: "production",
    ARTIFACTS: {},
    ACCOUNT_REPOSITORY_MANAGEMENT: "enabled",
    ACCOUNT_REPOSITORY_DELETE: "enabled",
  };
  for (const override of [
    { ACCOUNT_REPOSITORY_MANAGEMENT: undefined },
    { ACCOUNT_REPOSITORY_MANAGEMENT: "disabled" },
    { AUTH_MODE: "better-auth" },
    { ENVIRONMENT: "development" },
    { ARTIFACTS: undefined },
  ])
    expect(accountRepositoryDeletion({ ...env, ...override }, "account:immutable-owner")).toBe(
      false,
    );
  for (const actor of [
    "",
    "access:owner",
    "account:",
    "account:owner@example.com",
    "account:" + "x".repeat(129),
  ])
    expect(accountRepositoryDeletion(env, actor)).toBe(false);
});

function logicalFixture() {
  const records = new Map<string, LifecycleRecord>();
  const repos = new Map<string, { id: string; active: boolean }>();
  const registrations: {
    ownerActor: string;
    name: string;
    logicalName: string;
    projectId?: string;
    deleted: boolean;
  }[] = [];
  const binding = {
    list: vi.fn(async () => ({ repos: [...repos].map(([name, repo]) => ({ name, id: repo.id })) })),
    create: vi.fn(async (name: string) => {
      const intent = records.get(name)!;
      expect(intent.status).toBe("pending");
      expect(intent.projectId).toMatch(/^[a-f0-9-]{36}$/);
      expect(name).toBe(
        `${intent.logicalName!.slice(0, 30)}-${intent.projectId!.replaceAll("-", "")}`,
      );
      const repo = { id: "resource-" + intent.projectId, active: true };
      repos.set(name, repo);
      return { name, id: repo.id, token: "never-expose" };
    }),
    import: vi.fn(async () => {
      throw Error("unexpected_import");
    }),
    get: vi.fn(async (name: string) => {
      const current = () => {
        const repo = repos.get(name);
        if (!repo) throw Error("NOT_FOUND");
        return repo;
      };
      current();
      return {
        [Symbol.dispose]() {},
        info: async () => ({ id: current().id }),
        listTokens: async () => ({
          total: 1,
          tokens: [{ id: "token-id", state: current().active ? "active" : "revoked" }],
        }),
        revokeToken: async (_id: string) => {
          current().active = false;
          return true;
        },
      };
    }),
    delete: vi.fn(async (name: string) => {
      repos.delete(name);
      return true;
    }),
  };
  const lifecycle = new RepositoryLifecycle(
    binding as unknown as Artifacts,
    {
      get: (name) => records.get(name),
      list: () => [...records.values()],
      put: (record) => records.set(record.name, structuredClone(record)),
    },
    () => false,
    () => registrations,
  );
  const admission = async (commit: () => void) => {
    commit();
  };
  const create = (name: string, owner = "account:owner") =>
    lifecycle.provisionLogical(name, owner, { displayName: "Label", description: "" }, admission);
  return { records, repos, binding, registrations, lifecycle, admission, create };
}

it("canonicalizes account-local ASCII slugs without accepting non-ASCII names or separators", () => {
  expect(logicalRepositoryName(" Acme-Website ")).toBe("acme-website");
  expect(logicalRepositoryName("\t\nAcme-Website\r\v\f ")).toBe("acme-website");
  for (const value of [
    "",
    "-name",
    "folder/name",
    "has space",
    "KK",
    "é",
    "a".repeat(64),
    null,
    "\u00a0not-ascii-trim\u00a0",
  ])
    expect(() => logicalRepositoryName(value)).toThrow("invalid_name");
});

it("serializes case variants into one intent and stable UUID while different owners reuse a logical name", async () => {
  const f = logicalFixture();
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      f.create(index % 2 ? "ACME-Website" : " acme-website "),
    ),
  );
  expect(new Set(concurrent.map((record) => record.name)).size).toBe(1);
  expect(new Set(concurrent.map((record) => record.projectId)).size).toBe(1);
  expect(f.binding.create).toHaveBeenCalledTimes(1);
  const anotherOwner = await f.create("Acme-Website", "account:another-owner");
  expect(anotherOwner.name).not.toBe(concurrent[0].name);
  expect(anotherOwner.projectId).not.toBe(concurrent[0].projectId);
  expect(anotherOwner.logicalName).toBe("acme-website");
  expect(f.binding.create).toHaveBeenCalledTimes(2);
  const longest = await f.create("a".repeat(63));
  expect(longest.name.length).toBe(63);
  expect(longest.logicalName!.length).toBe(63);
});

it("keeps the UUID and logical reservation after ambiguous provisioning without submitting again", async () => {
  const f = logicalFixture();
  f.binding.create.mockImplementationOnce(async () => {
    throw Error("response_lost");
  });
  const first = await f.create("acme");
  expect(first.status).toBe("pending");
  const recovered = new RepositoryLifecycle(
    f.binding as unknown as Artifacts,
    {
      get: (name) => f.records.get(name),
      list: () => [...f.records.values()],
      put: (record) => f.records.set(record.name, record),
    },
    () => false,
  );
  const retry = await recovered.provisionLogical(
    "ACME",
    "account:owner",
    { displayName: "changed", description: "changed" },
    f.admission,
  );
  expect(retry.projectId).toBe(first.projectId);
  expect(retry.name).toBe(first.name);
  expect(retry.displayName).toBe("Label");
  expect(f.binding.create).toHaveBeenCalledTimes(1);
});

it("reserves logical renames atomically against creates and frees the previous logical name without renaming the provider", async () => {
  const f = logicalFixture();
  const original = await f.create("original");
  const another = await f.create("another");
  await expect(
    f.lifecycle.renameLogical(original.name, original.id!, "account:owner", "ANOTHER", f.admission),
  ).rejects.toThrow("repository_exists");
  expect(f.records.get(original.name)?.logicalName).toBe("original");
  await f.lifecycle.renameLogical(
    original.name,
    original.id!,
    "account:owner",
    "renamed",
    f.admission,
  );
  expect(f.records.get(original.name)?.id).toBe(original.id);
  expect(f.records.get(original.name)?.projectId).toBe(original.projectId);
  const reuse = await f.create("ORIGINAL");
  expect(reuse.name).not.toBe(original.name);
  expect(reuse.projectId).not.toBe(original.projectId);
  const raced = await Promise.allSettled([
    f.lifecycle.renameLogical(another.name, another.id!, "account:owner", "claimed", f.admission),
    f.create("CLAIMED"),
  ]);
  expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  expect(f.binding.create).toHaveBeenCalledTimes(3);
  expect(f.lifecycle.logicalCreation("account:owner", "claimed")?.name).toBe(another.name);
  expect(f.records.get(original.name)?.name).toBe(original.name);
});

it("holds deleting logical names until confirmed absence then reuses them with fresh UUIDs while retiring physical names", async () => {
  const f = logicalFixture();
  const original = await f.create("acme");
  f.binding.delete.mockResolvedValueOnce(false);
  const pending = await f.lifecycle.removeOwned(
    original.name,
    original.id!,
    original.name,
    "account:owner",
    async () => {},
    async () => {},
  );
  expect(pending.status).toBe("deleting");
  await expect(f.create("ACME")).rejects.toThrow("deletion_pending");
  const removed = await f.lifecycle.removeOwned(
    original.name,
    original.id!,
    original.name,
    "account:owner",
    async () => {},
    async () => {},
  );
  expect(removed.status).toBe("deleted");
  const next = await f.create("ACME");
  expect(next.projectId).not.toBe(original.projectId);
  expect(next.name).not.toBe(original.name);
  await expect(
    f.lifecycle.provision(original.name, "create", undefined, "account:owner"),
  ).rejects.toThrow("repository_name_retired");
});

it("checks adopted legacy registrations and session admission before persisting a new logical intent", async () => {
  const f = logicalFixture();
  f.registrations.push({
    ownerActor: "account:owner",
    name: "legacy",
    logicalName: "legacy",
    deleted: false,
  });
  await expect(f.create("LEGACY")).rejects.toThrow("repository_exists");
  await expect(
    f.lifecycle.provisionLogical(
      "new",
      "account:owner",
      { displayName: "New", description: "" },
      async () => {
        throw Error("unauthorized");
      },
    ),
  ).rejects.toThrow("unauthorized");
  expect(f.records.size).toBe(0);
  expect(f.binding.create).not.toHaveBeenCalled();
});

it("rejects injected project UUID collisions before provisioning even when logical prefixes differ", async () => {
  for (const secondName of ["a".repeat(30) + "-two", "different-prefix"]) {
    const f = logicalFixture();
    const first = await f.create("a".repeat(30) + "-one");
    const before = f.binding.list.mock.calls.length;
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(first.projectId as ReturnType<typeof crypto.randomUUID>);
    try {
      await expect(f.create(secondName)).rejects.toThrow("repository_identity_changed");
      expect(f.binding.create).toHaveBeenCalledTimes(1);
      expect(f.binding.list.mock.calls.length).toBe(before);
      expect(f.records.size).toBe(1);
    } finally {
      uuid.mockRestore();
    }
  }
});

it("retired and registered project UUIDs cannot be reused for a new physical repository", async () => {
  for (const source of ["retired", "registered"]) {
    const f = logicalFixture();
    const projectId = crypto.randomUUID();
    if (source === "retired")
      f.records.set("old-physical", {
        name: "old-physical",
        logicalName: "old",
        projectId,
        ownerActor: "account:other",
        operation: "create",
        status: "deleted",
      });
    else
      f.registrations.push({
        name: "legacy-physical",
        logicalName: "legacy",
        projectId,
        ownerActor: "account:other",
        deleted: true,
      });
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(projectId);
    try {
      await expect(f.create("new")).rejects.toThrow("repository_identity_changed");
      expect(f.binding.create).not.toHaveBeenCalled();
      expect(f.binding.list).not.toHaveBeenCalled();
    } finally {
      uuid.mockRestore();
    }
  }
});

it("a generated managed physical-name collision cannot borrow a legacy intent lacking its UUID mapping", async () => {
  const f = logicalFixture();
  const projectId = crypto.randomUUID();
  const physical = `acme-${projectId.replaceAll("-", "")}`;
  f.records.set(physical, {
    name: physical,
    ownerActor: "account:owner",
    operation: "create",
    id: "legacy-id",
    status: "ready",
  });
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(projectId);
  try {
    await expect(f.create("acme")).rejects.toThrow("repository_identity_changed");
    expect(f.binding.create).not.toHaveBeenCalled();
    expect(f.records.get(physical)?.id).toBe("legacy-id");
    expect(f.records.get(physical)?.projectId).toBeUndefined();
  } finally {
    uuid.mockRestore();
  }
});
