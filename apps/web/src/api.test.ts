import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, httpApi } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("bounds protected visualization reads, uses cancellation/no-store and refuses redirects/oversized JSON", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ artifacts: [] });
    }),
  );
  const controller = new AbortController();
  expect(await httpApi.visualizations!("repo", "thread", controller.signal)).toEqual({
    artifacts: [],
  });
  expect(calls[0].url.pathname).toBe("/api/projects/repo/threads/thread/visualizations");
  expect(calls[0].init).toMatchObject({
    signal: controller.signal,
    cache: "no-store",
    redirect: "error",
    credentials: "same-origin",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ huge: "x".repeat(524288 + 4096) })),
  );
  await expect(httpApi.visualizations!("repo", "thread", controller.signal)).rejects.toThrow(
    "visualization_unavailable",
  );
});
it("overlays authenticated display models on the actual fixture transport without authorizing Send", async () => {
  const native = {
    landing: { enabled: false, backend: null },
    composer: {
      conversation: true,
      models: [{ id: "default", provider: "pitcrew-fixture" }],
      settings: { default: { modelId: "default", effort: "off" } },
    },
  };
  const models = [
    {
      id: "default",
      label: "Qwen",
      provider: "openrouter",
      model: "qwen/qwen3.8-flash",
      efforts: ["off"],
      contextWindow: 1000000,
    },
  ];
  let connected = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      Response.json(
        path.endsWith("/models")
          ? connected
            ? {
                models,
                catalogRevision: "a".repeat(64),
                defaultSelection: { modelId: "default", effort: "off" },
                executionEnabled: true,
              }
            : { models: [], executionEnabled: false }
          : native,
      ),
    ),
  );
  expect((await httpApi.capabilities()).composer).toMatchObject({
    conversation: false,
    displayOnly: true,
    executionEnabled: false,
    models,
  });
  connected = false;
  expect((await httpApi.capabilities()).composer?.models[0].provider).toBe("pitcrew-fixture");
});
it("uses a separate secure connection session and returns public status only", async () => {
  const fetch = vi.fn(async (path: string) =>
    path.endsWith("/session")
      ? Response.json({ nonce: "a".repeat(64) })
      : Response.json({
          available: true,
          storageAvailable: true,
          configured: true,
          executionEnabled: false,
          key: "never-returned",
        }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await httpApi.openrouter!.store("synthetic-not-a-credential")).toEqual({
    available: true,
    storageAvailable: true,
    configured: true,
    executionEnabled: false,
  });
  expect(fetch.mock.calls[0][0]).toBe("/api/provider-connection/openrouter/session");
  const init = (fetch.mock.calls as unknown as [string, RequestInit][])[1][1];
  expect(init.headers).toEqual({
    "Content-Type": "application/json",
    "X-Pitcrew-Connection-Nonce": "a".repeat(64),
  });
  expect(init.body).toBe(JSON.stringify({ action: "store", key: "synthetic-not-a-credential" }));
  expect(init.cache).toBe("no-store");
});
it("removes only the current user provider record and fails closed for legacy storage status", async () => {
  const fetch = vi.fn(async (path: string) =>
    path.endsWith("/session")
      ? Response.json({ nonce: "b".repeat(64) })
      : Response.json({ available: true, configured: false, executionEnabled: false }),
  );
  vi.stubGlobal("fetch", fetch);
  expect((await httpApi.openrouter!.remove()).storageAvailable).toBe(false);
  const init = (fetch.mock.calls as unknown as [string, RequestInit][])[1][1];
  expect(init.body).toBe(JSON.stringify({ action: "remove" }));
});
function withSession(fetch: (path: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
    path === "/api/local-session"
      ? Promise.resolve(new Response(JSON.stringify({ nonce: null })))
      : fetch(path, init),
  );
}
describe("canonical HTTP adapter", () => {
  it("posts repository-scoped archive/restore state with escaped identifiers", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async (_path, input) =>
          new Response(
            JSON.stringify({ id: "thread/1", archived: JSON.parse(input.body).archived }),
          ),
      );
    withSession(fetch);
    expect((await httpApi.setThreadArchived!("project/1", "thread/1", true)).archived).toBe(true);
    expect((await httpApi.setThreadArchived!("project/1", "thread/1", false)).archived).toBe(false);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(
      Array(2).fill("/api/projects/project%2F1/threads/thread%2F1/archive"),
    );
    expect(fetch.mock.calls.map(([, input]) => JSON.parse(input.body))).toEqual([
      { archived: true },
      { archived: false },
    ]);
  });
  it("reads the latest sidebar run with one request, independent of historical run count", async () => {
    const runs = Array.from({ length: 1000 }, (_, i) => ({
      id: `run-${i}`,
      threadId: "thread/1",
      status: "completed",
      baseSha: "base",
      configurationRevision: "v1",
    }));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(runs)));
    withSession(fetch);
    expect(await httpApi.latestRun!("thread/1")).toEqual(runs.at(-1));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/threads/thread%2F1/runs"]);
  });
  it("returns no sidebar status for a conversation without runs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]")));
    expect(await httpApi.latestRun!("empty")).toBeUndefined();
  });
  it("loads messages and per-run evidence using escaped identifiers", async () => {
    const run = {
      id: "run/1",
      threadId: "thread/1",
      status: "waiting_user",
      baseSha: "base",
      candidateSha: "candidate",
      configurationRevision: "r1",
    };
    const fetch = vi
      .fn()
      .mockImplementation(
        async (path: string) =>
          new Response(
            JSON.stringify(
              path.endsWith("/messages") || path.endsWith("/turns")
                ? []
                : path.endsWith("/runs")
                  ? [{ ...run, status: "running" }]
                  : { run, tests: { status: "passed" }, reviews: [] },
            ),
          ),
      );
    withSession(fetch);
    const result = await httpApi.snapshot("thread/1");
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/threads/thread%2F1/messages",
      "/api/threads/thread%2F1/runs",
      "/api/threads/thread%2F1/turns",
      "/api/runs/run%2F1/evidence",
    ]);
    expect(result.runs[0].status).toBe("waiting_user");
  });
  it("submits the explicit idempotency key without development identity or access headers", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("{}"));
    withSession(fetch);
    await httpApi.send("thread", "change", "retry-key");
    expect(fetch.mock.calls[0]).toEqual([
      "/api/threads/thread/messages",
      {
        method: "POST",
        signal: expect.any(AbortSignal),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "change", idempotencyKey: "retry-key" }),
      },
    ]);
  });
  it("sanitizes denial and network errors without reading error bodies", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("private server details", { status: 403 }))
      .mockRejectedValueOnce(new Error("private network details"));
    withSession(fetch);
    await expect(httpApi.projects()).rejects.toThrow("Access is unavailable");
    await expect(httpApi.projects()).rejects.toEqual(new ApiError(0));
  });
  it("sanitizes malformed upstream responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>upstream details</html>")),
    );
    await expect(httpApi.projects()).rejects.toEqual(new ApiError(0));
  });
  it("sends exact approval then separate landing and read-only reconciliation bodies", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("{}"));
    withSession(fetch);
    const approval = {
      expectedTargetSha: "base",
      candidateSha: "candidate",
      configurationRevision: "v1",
      idempotencyKey: "key",
    };
    await httpApi.capabilities();
    await httpApi.approve("run/1", approval);
    await httpApi.land("run/1", "receipt");
    await httpApi.reconcile("run/1", "receipt");
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/capabilities",
      "/api/provider-connection/openrouter/models",
      "/api/runs/run%2F1/merge-approval",
      "/api/runs/run%2F1/landing",
      "/api/runs/run%2F1/landing/reconcile",
    ]);
    expect(fetch.mock.calls.slice(2).map((call) => call[1].body)).toEqual([
      JSON.stringify(approval),
      JSON.stringify({ authorizationId: "receipt" }),
      JSON.stringify({ authorizationId: "receipt" }),
    ]);
  });
});
it("obtains a session nonce before local mutations and never sends it in the body", async () => {
  const nonce = "a".repeat(64);
  const fetch = vi
    .fn()
    .mockImplementation(async (path: string) =>
      Response.json(path === "/api/local-session" ? { nonce } : {}),
    );
  vi.stubGlobal("fetch", fetch);
  await httpApi.send("thread", "change", "retry-key");
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    "/api/local-session",
    "/api/threads/thread/messages",
  ]);
  expect(fetch.mock.calls[1][1].headers).toEqual({
    "Content-Type": "application/json",
    "X-Pitcrew-Local-Nonce": nonce,
  });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    content: "change",
    idempotencyKey: "retry-key",
  });
});
it("fails closed before a mutation when session bootstrap is denied or malformed", async () => {
  for (const response of [
    new Response("denied", { status: 403 }),
    Response.json({ nonce: "guess" }),
  ]) {
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    await expect(httpApi.send("thread", "change", "key")).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledOnce();
  }
});
it("sends stable mention references and gives a bounded stale-member recovery error", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async (path: string) =>
      path === "/api/local-session"
        ? Response.json({ nonce: null })
        : Response.json(
            { error: "invalid_mentions", diagnostic: "private detail" },
            { status: 400 },
          ),
    );
  vi.stubGlobal("fetch", fetch);
  const mentions = [{ actor: "account:john", start: 0, end: 9 }];
  await expect(
    httpApi.send("thread", "@johncena review", "mention-retry", undefined, undefined, mentions),
  ).rejects.toThrow(
    "A mentioned member changed or is unavailable. Reselect the @username before sending.",
  );
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    content: "@johncena review",
    idempotencyKey: "mention-retry",
    mentions,
  });
});
it("shares bootstrap between simultaneous first mutations", async () => {
  const nonce = "b".repeat(64);
  let complete!: (response: Response) => void;
  const bootstrap = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const fetch = vi
    .fn()
    .mockImplementation((path: string) =>
      path === "/api/local-session" ? bootstrap : Promise.resolve(Response.json({})),
    );
  vi.stubGlobal("fetch", fetch);
  const one = httpApi.send("one", "change", "one"),
    two = httpApi.send("two", "change", "two");
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/local-session"]);
  complete(Response.json({ nonce }));
  await Promise.all([one, two]);
  expect(
    fetch.mock.calls.slice(1).map(([, input]) => input.headers["X-Pitcrew-Local-Nonce"]),
  ).toEqual([nonce, nonce]);
});
it("refreshes a raced session once after a denied local admission with identical mutation input", async () => {
  let sessions = 0,
    mutations = 0;
  const fetch = vi
    .fn()
    .mockImplementation(async (path: string) =>
      path === "/api/local-session"
        ? Response.json({ nonce: (++sessions === 1 ? "a" : "b").repeat(64) })
        : ++mutations === 1
          ? new Response("denied", { status: 403 })
          : Response.json({}),
    );
  vi.stubGlobal("fetch", fetch);
  await httpApi.send("thread", "change", "same-key");
  const writes = fetch.mock.calls.filter(([path]) => path !== "/api/local-session");
  expect(writes).toHaveLength(2);
  expect(writes[0][1].body).toBe(writes[1][1].body);
  expect(writes.map(([, input]) => input.headers["X-Pitcrew-Local-Nonce"])).toEqual([
    "a".repeat(64),
    "b".repeat(64),
  ]);
});

it("uses the production authenticated session without a local nonce and strips private response fields", async () => {
  const fetch = vi.fn(async (path: string) =>
    path.endsWith("/session")
      ? Response.json({ nonce: null })
      : Response.json({
          available: true,
          storageAvailable: true,
          configured: true,
          executionEnabled: false,
          key: "synthetic_should_not_escape",
        }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await httpApi.openrouter!.store("sk-or-v1-synthetic_never_live")).toEqual({
    available: true,
    storageAvailable: true,
    configured: true,
    executionEnabled: false,
  });
  const init = (fetch.mock.calls as unknown as [string, RequestInit][])[1][1];
  expect(init.headers).toEqual({ "Content-Type": "application/json" });
});

it("reads the account directory envelope and scopes capabilities to the selected repository", async () => {
  const fetch = vi.fn(async (path: string) =>
    Response.json(
      path === "/api/repositories"
        ? {
            repositories: [
              {
                projectId: "repo-1",
                name: "Shared repo",
                role: "editor",
                status: "present",
                lifecycle: "registered",
                deletable: false,
              },
            ],
            cursor: null,
          }
        : { landing: { enabled: false, backend: null }, notesEnabled: true },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  expect((await httpApi.collaboration!.repositories())[0].projectId).toBe("repo-1");
  expect((await httpApi.capabilities("repo / one")).notesEnabled).toBe(true);
  expect(fetch.mock.calls[1][0]).toBe("/api/capabilities?projectId=repo%20%2F%20one");
});

it("reads approved adoptions without caching and submits only the exact name and immutable repository ID", async () => {
  const candidate = { name: "approved target", repositoryId: "immutable/id" };
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    Response.json(
      path === "/api/project-adoptions"
        ? [{ ...candidate, actor: "private" }]
        : { id: "project-1" },
    ),
  );
  withSession(fetch);
  expect(await httpApi.collaboration!.approvedProjectAdoptions!()).toEqual([candidate]);
  await httpApi.collaboration!.adoptProject!(candidate.name, candidate.repositoryId);
  expect(fetch.mock.calls[0]).toEqual([
    "/api/project-adoptions",
    expect.objectContaining({ method: "GET", cache: "no-store" }),
  ]);
  expect(fetch.mock.calls[1]).toEqual([
    "/api/projects",
    expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate),
    }),
  ]);
});

it("rejects malformed approved-adoption responses and empty target identifiers", async () => {
  for (const value of [
    { adoptions: [] },
    [null],
    [{ name: "repo", repositoryId: "" }],
    [{ name: "", repositoryId: "id" }],
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(value)),
    );
    await expect(httpApi.collaboration!.approvedProjectAdoptions!()).rejects.toBeInstanceOf(
      ApiError,
    );
  }
});

const creationTarget = { name: "account-approved-empty" };
const createdRepository = {
  ...creationTarget,
  repositoryId: "immutable-empty-id",
  projectId: "registered-project-id",
  status: "ready",
};
it("reads account creation approval without caching and projects only public lifecycle metadata", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      approval: { ...creationTarget, actor: "private-actor" },
      creations: [{ ...createdRepository, token: "secret", issue: "provider secret diagnostic" }],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await httpApi.collaboration!.repositoryCreations!()).toEqual({
    approval: creationTarget,
    creations: [createdRepository],
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "/api/repository-creations",
    expect.objectContaining({ method: "GET", cache: "no-store" }),
  );
});

it("uses existing account session admission and submits only the approved name with explicit consent", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path === "/api/local-session"
      ? Response.json({ nonce: "a".repeat(64) })
      : Response.json({ ...createdRepository, token: "secret" }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await httpApi.collaboration!.createRepository!(creationTarget.name, true)).toEqual(
    createdRepository,
  );
  expect(fetch.mock.calls[1]).toEqual([
    "/api/repositories/create",
    expect.objectContaining({
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Pitcrew-Local-Nonce": "a".repeat(64) },
      body: JSON.stringify({ name: creationTarget.name, credentialConsent: true }),
    }),
  ]);
  expect(timeout).toHaveBeenCalledWith(45000);
  timeout.mockRestore();
});

it.each(["pending", "cleanup_required", "registration_required"])(
  "returns safe %s metadata for accepted but incomplete creation",
  async (status) => {
    withSession(async () => Response.json({ ...creationTarget, status }, { status: 202 }));
    expect(await httpApi.collaboration!.createRepository!(creationTarget.name, true)).toEqual({
      ...creationTarget,
      status,
    });
  },
);

it("never repeats an account creation POST after admission rejection or unknown network outcome", async () => {
  for (const fail of [false, true]) {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/local-session") return Response.json({ nonce: "b".repeat(64) });
      if (fail) throw Error("private network detail");
      return Response.json({ error: "secret server diagnostic" }, { status: 403 });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      httpApi.collaboration!.createRepository!(creationTarget.name, true),
    ).rejects.toEqual(new ApiError(fail ? 0 : 403));
    expect(fetch.mock.calls.filter(([path]) => path === "/api/repositories/create")).toHaveLength(
      1,
    );
  }
});

it("fails closed for malformed creation discovery including missing readiness identifiers and duplicate names", async () => {
  for (const value of [
    {},
    { approval: {}, creations: [] },
    { approval: { name: "" }, creations: [] },
    { approval: null, creations: [null] },
    { approval: null, creations: [{ ...creationTarget, status: "ready" }] },
    { approval: null, creations: [{ ...creationTarget, status: "other" }] },
    { approval: null, creations: [{ ...createdRepository, status: ["ready"] }] },
    { approval: null, creations: [createdRepository, createdRepository] },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(value)),
    );
    await expect(httpApi.collaboration!.repositoryCreations!()).rejects.toEqual(new ApiError(0));
  }
});

it("rejects creation responses with another target, missing registration, or incorrect completion status", async () => {
  for (const [value, status] of [
    [{ ...createdRepository, name: "another-repository" }, 200],
    [{ ...creationTarget, status: "ready" }, 200],
    [createdRepository, 202],
    [{ ...creationTarget, status: "pending" }, 200],
  ] as const) {
    withSession(async () => Response.json(value, { status }));
    await expect(
      httpApi.collaboration!.createRepository!(creationTarget.name, true),
    ).rejects.toEqual(new ApiError(0));
  }
});

it("rejects missing credential consent before requesting the account session", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    httpApi.collaboration!.createRepository!(creationTarget.name, false as unknown as true),
  ).rejects.toEqual(new ApiError(0));
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds simultaneous product reads and releases a slot after an interrupted request", async () => {
  let active = 0,
    maximum = 0,
    count = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      const current = ++count;
      try {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        if (current === 2) throw Error("interrupted read");
        return Response.json([]);
      } finally {
        active--;
      }
    }),
  );
  const { apiFetch } = await import("./api");
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => apiFetch("/projects")));
  expect(maximum).toBe(3);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(9);
  expect(active).toBe(0);
});

it("reads self-service capabilities and directory metadata while omitting private fields", async () => {
  const entry = {
    projectId: "project",
    name: "Display",
    repositoryName: "physical",
    repositoryId: "immutable",
    description: "Description",
    metadataRevision: 2,
    role: "owner",
    status: "deleting",
    lifecycle: "deleting",
    deletable: true,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      Response.json(
        path === "/api/repository-creations"
          ? {
              approval: null,
              creations: [],
              capabilities: { create: true, manage: true, delete: true, token: "private" },
            }
          : { repositories: [{ ...entry, token: "private", actor: "private" }] },
      ),
    ),
  );
  expect(await httpApi.collaboration!.repositoryCreations!()).toEqual({
    approval: null,
    creations: [],
    capabilities: { create: true, manage: true, delete: true },
  });
  expect(await httpApi.collaboration!.repositories()).toEqual([entry]);
});
const repositoryTargetStatus = {
  projectId: "project/id",
  name: "A display label with spaces",
  repositoryName: "physical",
  repositoryId: "immutable",
  description: "Description",
  metadataRevision: 2,
  role: "owner",
  status: "deleting",
  lifecycle: "deleting",
  deletable: false,
};
it("sends create metadata only when supplied and keeps metadata edit and deletion bound to exact paths", async () => {
  const fetch = vi.fn(async (path: string) =>
    path === "/api/local-session"
      ? Response.json({ nonce: null })
      : Response.json(
          path.endsWith("/delete")
            ? { ...repositoryTargetStatus, token: "private" }
            : path.endsWith("/create")
              ? { ...createdRepository }
              : { id: "project" },
          { status: path.endsWith("/delete") ? 202 : 200 },
        ),
  );
  vi.stubGlobal("fetch", fetch);
  await httpApi.collaboration!.createRepository!(creationTarget.name, true, {
    displayName: "Display",
    description: "Description",
  });
  await httpApi.collaboration!.updateRepository!("project/id", {
    displayName: "New",
    description: "",
    expectedRevision: 2,
  });
  expect(
    await httpApi.collaboration!.deleteRepository!("project/id", {
      confirmation: "physical",
      repositoryId: "immutable",
    }),
  ).toEqual(repositoryTargetStatus);
  const mutations = (fetch.mock.calls as unknown as [string, RequestInit][]).filter(
    ([path]) => path !== "/api/local-session",
  );
  expect(
    mutations.map(([path, init]) => [path, init.method, JSON.parse(init.body as string)]),
  ).toEqual([
    [
      "/api/repositories/create",
      "POST",
      {
        name: creationTarget.name,
        credentialConsent: true,
        displayName: "Display",
        description: "Description",
      },
    ],
    [
      "/api/projects/project%2Fid/repository",
      "PATCH",
      { displayName: "New", description: "", expectedRevision: 2 },
    ],
    [
      "/api/projects/project%2Fid/repository/delete",
      "POST",
      { confirmation: "physical", repositoryId: "immutable" },
    ],
  ]);
  expect(mutations.every(([, init]) => init.cache === "no-store")).toBe(true);
});
it("never repeats destructive repository mutations after local admission or network failure", async () => {
  for (const fail of [false, true]) {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/local-session") return Response.json({ nonce: "c".repeat(64) });
      if (fail) throw Error("secret diagnostic");
      return Response.json({ error: "secret diagnostic" }, { status: 403 });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      httpApi.collaboration!.deleteRepository!("project", {
        confirmation: "physical",
        repositoryId: "immutable",
      }),
    ).rejects.toEqual(new ApiError(fail ? 0 : 403));
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/delete"))).toHaveLength(1);
  }
});
it("reads and revokes safe pending invitation metadata by ID without retrieving the token", async () => {
  const invitation = {
    id: "invite/id",
    email: "recipient@example.test",
    role: "editor",
    scope: "project",
    projectId: "project/id",
    expiresAt: "2099-01-01T00:00:00Z",
  };
  const fetch = vi.fn(async (path: string) =>
    path === "/api/local-session"
      ? Response.json({ nonce: null })
      : Response.json(
          path.endsWith("/revoke")
            ? { ...invitation, revokedAt: "2026-01-01", token: "private", digest: "private" }
            : [{ ...invitation, token: "private", digest: "private" }],
        ),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await httpApi.collaboration!.projectInvitations!("project/id")).toEqual([invitation]);
  expect(await httpApi.collaboration!.revokeProjectInvitation!("project/id", "invite/id")).toEqual({
    ...invitation,
    revokedAt: "2026-01-01",
  });
  expect(fetch.mock.calls.at(-1)?.[0]).toBe(
    "/api/projects/project%2Fid/invitations/invite%2Fid/revoke",
  );
});
it("fails closed for malformed capabilities and immutable directory identifiers", async () => {
  for (const capabilities of [null, {}, { create: true }, { create: true, manage: "true" }]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ approval: null, creations: [], capabilities })),
    );
    await expect(httpApi.collaboration!.repositoryCreations!()).rejects.toEqual(new ApiError(0));
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        repositories: [
          {
            projectId: "project",
            name: "Display",
            role: "owner",
            status: "present",
            lifecycle: "registered",
            deletable: true,
            repositoryId: "",
          },
        ],
      }),
    ),
  );
  await expect(httpApi.collaboration!.repositories()).rejects.toEqual(new ApiError(0));
});

it("rejects deletion responses whose HTTP completion status conflicts with lifecycle", async () => {
  for (const [status, httpStatus] of [
    ["deleting", 200],
    ["deleted", 202],
    ["present", 200],
  ] as const) {
    withSession(async () =>
      Response.json(
        {
          ...repositoryTargetStatus,
          status,
          lifecycle: status === "present" ? "registered" : status,
        },
        { status: httpStatus },
      ),
    );
    await expect(
      httpApi.collaboration!.deleteRepository!("project", {
        confirmation: "physical",
        repositoryId: "immutable",
      }),
    ).rejects.toEqual(new ApiError(0));
  }
});

it("reads full immutable deletion status with display spaces and rejects thin or malformed projections", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...repositoryTargetStatus, token: "private" })),
  );
  expect(await httpApi.collaboration!.repositoryStatus!("project/id")).toEqual(
    repositoryTargetStatus,
  );
  for (const value of [
    { name: "physical", status: "deleting" },
    { ...repositoryTargetStatus, repositoryName: "Display Name" },
    { ...repositoryTargetStatus, repositoryId: "" },
    { ...repositoryTargetStatus, projectId: "" },
    { ...repositoryTargetStatus, name: " " },
    { ...repositoryTargetStatus, name: "x".repeat(81) },
    { ...repositoryTargetStatus, lifecycle: "registered" },
    { ...repositoryTargetStatus, deletable: true },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(value)),
    );
    await expect(httpApi.collaboration!.repositoryStatus!("project/id")).rejects.toEqual(
      new ApiError(0),
    );
  }
});

it("keeps creation capabilities and safe deletion tombstones without requiring obsolete project IDs", async () => {
  const tombstones = [
    { name: "retiring-repo", repositoryId: "retiring-immutable", status: "deleting" },
    { name: "retired-repo", repositoryId: "retired-immutable", status: "deleted" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        approval: null,
        capabilities: { create: true, manage: true, delete: false },
        creations: tombstones.map((item) => ({
          ...item,
          token: "private",
          providerDiagnostic: "private",
        })),
      }),
    ),
  );
  expect(await httpApi.collaboration!.repositoryCreations!()).toEqual({
    approval: null,
    capabilities: { create: true, manage: true, delete: false },
    creations: tombstones,
  });
  for (const tombstone of [
    { name: "retired-repo", status: "deleted" },
    { name: "retiring-repo", repositoryId: "", status: "deleting" },
    { name: "retired-repo", repositoryId: "retired-immutable", projectId: "", status: "deleted" },
    { name: "invalid physical name", repositoryId: "retired-immutable", status: "deleted" },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          approval: null,
          capabilities: { create: true, manage: true, delete: false },
          creations: [tombstone],
        }),
      ),
    );
    await expect(httpApi.collaboration!.repositoryCreations!()).rejects.toEqual(new ApiError(0));
  }
});
it.each(["deleting", "deleted"])(
  "rejects %s as an unexpected create POST result instead of announcing a new repository",
  async (status) => {
    withSession(async () =>
      Response.json(
        { ...creationTarget, repositoryId: "immutable-retired", status },
        { status: 202 },
      ),
    );
    await expect(
      httpApi.collaboration!.createRepository!(creationTarget.name, true),
    ).rejects.toEqual(new ApiError(0));
  },
);
it("defaults an omitted independent delete capability to false and rejects malformed deletion capability", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        approval: null,
        creations: [],
        capabilities: { create: true, manage: true },
      }),
    ),
  );
  expect(await httpApi.collaboration!.repositoryCreations!()).toEqual({
    approval: null,
    creations: [],
    capabilities: { create: true, manage: true, delete: false },
  });
  for (const deletion of [null, "enabled", 1, {}]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          approval: null,
          creations: [],
          capabilities: { create: true, manage: true, delete: deletion },
        }),
      ),
    );
    await expect(httpApi.collaboration!.repositoryCreations!()).rejects.toEqual(new ApiError(0));
  }
});

it("normalizes broad logical creation names while preserving the generated physical identity and safe namespace metadata", async () => {
  const result = {
    ...createdRepository,
    name: "sample",
    logicalName: "sample",
    repositoryName: `sample-${"a".repeat(32)}`,
  };
  const fetch = vi.fn(async (path: string) =>
    path === "/api/local-session"
      ? Response.json({ nonce: null })
      : Response.json({ ...result, token: "private" }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    await httpApi.collaboration!.createRepository!("  SaMpLe  ", true, {
      displayName: "Label",
      description: "",
    }),
  ).toEqual(result);
  expect(fetch.mock.calls.at(-1)).toEqual([
    "/api/repositories/create",
    expect.objectContaining({
      body: JSON.stringify({
        name: "sample",
        credentialConsent: true,
        displayName: "Label",
        description: "",
      }),
    }),
  ]);
});
it("keeps retired and recreated logical names distinct by physical identity and rejects inconsistent logical metadata", async () => {
  const old = {
    name: "sample",
    logicalName: "sample",
    repositoryName: `sample-${"a".repeat(32)}`,
    repositoryId: "old-provider",
    status: "deleted",
  };
  const active = {
    ...createdRepository,
    name: "sample",
    logicalName: "sample",
    repositoryName: `sample-${"b".repeat(32)}`,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        approval: null,
        capabilities: { create: true, manage: true, delete: false },
        creations: [old, active],
      }),
    ),
  );
  expect((await httpApi.collaboration!.repositoryCreations!()).creations).toEqual([old, active]);
  for (const creations of [
    [old, { ...active, repositoryName: old.repositoryName }],
    [{ ...active, logicalName: "different" }],
    [{ ...active, repositoryName: undefined }],
    [{ ...active, logicalName: "SAMPLE" }],
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ approval: null, creations })),
    );
    await expect(httpApi.collaboration!.repositoryCreations!()).rejects.toEqual(new ApiError(0));
  }
});
it("normalizes logical rename PATCH input and surfaces only recognized conflict codes", async () => {
  const fetch = vi.fn(async (path: string) =>
    path === "/api/local-session"
      ? Response.json({ nonce: null })
      : Response.json({
          id: "project",
          logicalName: "new-name",
          repository: "artifact:unchanged-physical",
        }),
  );
  vi.stubGlobal("fetch", fetch);
  await httpApi.collaboration!.updateRepository!("project", {
    logicalName: " New-Name ",
    displayName: "Display",
    description: "",
    expectedRevision: 2,
  });
  expect(fetch.mock.calls.at(-1)).toEqual([
    "/api/projects/project/repository",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        logicalName: "new-name",
        displayName: "Display",
        description: "",
        expectedRevision: 2,
      }),
    }),
  ]);
  for (const code of ["repository_exists", "revision_conflict", "private provider diagnostic"]) {
    withSession(async () => Response.json({ error: code, token: "private" }, { status: 409 }));
    await expect(
      httpApi.collaboration!.updateRepository!("project", {
        logicalName: "new-name",
        displayName: "Display",
        description: "",
      }),
    ).rejects.toEqual(
      new ApiError(
        409,
        code === "private provider diagnostic" ? undefined : (code as ApiError["code"]),
      ),
    );
  }
});
it("rejects invalid logical names before create or rename admission", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const name of ["a_b", "-start", "x".repeat(64), "\u00a0sample\u00a0", "éclair"]) {
    await expect(
      httpApi.collaboration!.createRepository!(name, true, {
        displayName: "Display",
        description: "",
      }),
    ).rejects.toEqual(new ApiError(400));
    await expect(
      httpApi.collaboration!.updateRepository!("project", {
        logicalName: name,
        displayName: "Display",
        description: "",
      }),
    ).rejects.toEqual(new ApiError(400));
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("reads canonical logical names in directory and status while continuing to accept legacy physical fallbacks", async () => {
  const status = { ...repositoryTargetStatus, logicalName: "logical-sample" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      Response.json(path.endsWith("/repository") ? status : { repositories: [status] }),
    ),
  );
  expect((await httpApi.collaboration!.repositories())[0].logicalName).toBe("logical-sample");
  expect((await httpApi.collaboration!.repositoryStatus!("project/id")).logicalName).toBe(
    "logical-sample",
  );
});
