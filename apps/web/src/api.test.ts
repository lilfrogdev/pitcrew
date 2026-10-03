import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, httpApi } from "./api";
afterEach(() => vi.unstubAllGlobals());
describe("canonical HTTP adapter", () => {
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
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await httpApi.send("thread", "change", "retry-key");
    expect(fetch.mock.calls[0]).toEqual([
      "/api/threads/thread/messages",
      {
        method: "POST",
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
});
