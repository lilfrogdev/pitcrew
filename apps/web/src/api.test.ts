import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, httpApi } from "./api";
afterEach(() => vi.unstubAllGlobals());
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
