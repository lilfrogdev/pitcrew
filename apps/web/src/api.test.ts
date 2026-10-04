import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, httpApi } from "./api";
afterEach(() => vi.unstubAllGlobals());
describe("canonical HTTP adapter", () => {
  it("reads the latest sidebar run with one request, independent of historical run count", async () => {
    const runs = Array.from({ length: 1000 }, (_, i) => ({
      id: `run-${i}`,
      threadId: "thread/1",
      status: "completed",
      baseSha: "base",
      configurationRevision: "v1",
    }));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(runs)));
    vi.stubGlobal("fetch", fetch);
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
              path.endsWith("/messages")
                ? []
                : path.endsWith("/runs")
                  ? [{ ...run, status: "running" }]
                  : { run, tests: { status: "passed" }, reviews: [] },
            ),
          ),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await httpApi.snapshot("thread/1");
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/threads/thread%2F1/messages",
      "/api/threads/thread%2F1/runs",
      "/api/runs/run%2F1/evidence",
    ]);
    expect(result.runs[0].status).toBe("waiting_user");
  });
  it("submits the explicit idempotency key without development identity or access headers", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
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
    vi.stubGlobal("fetch", fetch);
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
    vi.stubGlobal("fetch", fetch);
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
      "/api/runs/run%2F1/merge-approval",
      "/api/runs/run%2F1/landing",
      "/api/runs/run%2F1/landing/reconcile",
    ]);
    expect(fetch.mock.calls.slice(1).map((call) => call[1].body)).toEqual([
      JSON.stringify(approval),
      JSON.stringify({ authorizationId: "receipt" }),
      JSON.stringify({ authorizationId: "receipt" }),
    ]);
  });
});
