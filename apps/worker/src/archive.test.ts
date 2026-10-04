import { describe, expect, it } from "vite-plus/test";
import { Coordinator, fakeExecution, initialState, type State } from "./coordinator";
import { api } from "./api";
import { protectedFetch } from "./access";

function fixture() {
  let saved: State = structuredClone(initialState()),
    writes = 0,
    fail = false;
  const core = new Coordinator(structuredClone(saved), (state) => {
    if (fail) throw Error("storage unavailable");
    writes++;
    saved = structuredClone(state);
  });
  return {
    core,
    saved: () => structuredClone(saved),
    writes: () => writes,
    fail: () => {
      fail = true;
    },
  };
}
describe("conversation archiving", () => {
  it("migrates legacy threads durably once and preserves content through restart and repeated archive/restore", async () => {
    const f = fixture();
    const thread = f.core.createThread("Archive me", "create");
    const submission = f.core.submit(thread.id, "Keep my work", "send");
    const input = f.core.begin(submission.run.id)!;
    const legacy = f.saved();
    for (const item of legacy.threads) delete item.archived;
    let migrated: State = legacy,
      writes = 0;
    const core = new Coordinator(legacy, (state) => {
      migrated = structuredClone(state);
      writes++;
    });
    expect(writes).toBe(1);
    expect(core.thread(thread.id).archived).toBe(false);
    const content = structuredClone(core.state);
    const archived = core.setThreadArchived(thread.id, true);
    archived.title = "external mutation";
    for (let n = 0; n < 600; n++) core.setThreadArchived(thread.id, true);
    expect(writes).toBe(2);
    expect(core.thread(thread.id).title).toBe("Archive me");
    const recovered = new Coordinator(structuredClone(migrated), (state) => {
      migrated = structuredClone(state);
      writes++;
    });
    expect(writes).toBe(2);
    expect(recovered.thread(thread.id).archived).toBe(true);
    expect(recovered.state.runs.find((run) => run.id === submission.run.id)?.status).toBe(
      "running",
    );
    const actual = structuredClone(recovered.state);
    actual.threads = content.threads;
    expect(actual).toEqual(content);
    recovered.complete(submission.run.id, await fakeExecution.delegate(input));
    expect(recovered.evidence(submission.run.id).run.status).toBe("awaiting_review");
    expect(recovered.thread(thread.id).archived).toBe(true);
    recovered.setThreadArchived(thread.id, false);
    const restored = structuredClone(migrated);
    recovered.setThreadArchived(thread.id, false);
    expect(migrated).toEqual(restored);
    expect(new Coordinator(structuredClone(migrated), () => {}).thread(thread.id).archived).toBe(
      false,
    );
    expect(recovered.state.messages).toEqual(content.messages);
    expect(recovered.state.changes).toEqual(content.changes);
  });
  it("rolls back failed persistence and rejects invalid state and unknown threads", () => {
    const f = fixture(),
      thread = f.core.createThread("Keep", "create"),
      before = f.saved();
    for (const value of [undefined, null, "true", 1])
      expect(() => f.core.setThreadArchived(thread.id, value)).toThrow("invalid_archived");
    expect(() => f.core.setThreadArchived("unknown", true)).toThrow("not_found");
    f.fail();
    expect(() => f.core.setThreadArchived(thread.id, true)).toThrow("storage unavailable");
    expect(f.core.state).toEqual(before);
    expect(f.saved()).toEqual(before);
  });
  it("uses repository/thread admission and lists archived metadata while preserving readable work", async () => {
    const f = fixture(),
      thread = f.core.createThread("Keep", "create");
    f.core.submit(thread.id, "Keep message", "send");
    let dispatched = 0;
    const app = api(f.core, () => {
      dispatched++;
    });
    const route = `/api/projects/${thread.projectId}/threads/${thread.id}/archive`;
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await post(route.replace(thread.projectId, "other-project"), { archived: true })).status,
    ).toBe(404);
    expect(
      (await post(route.replace(thread.id, "missing-thread"), { archived: true })).status,
    ).toBe(404);
    expect((await post(route, {})).status).toBe(400);
    expect((await post(route, { archived: "true" })).status).toBe(400);
    for (const archived of [true, true, false, false, true]) {
      const response = await post(route, { archived });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...thread, archived });
    }
    const list = (await (
      await app.request(`/api/projects/${thread.projectId}/threads`)
    ).json()) as { id: string; archived: boolean }[];
    expect(list.find((item) => item.id === thread.id)?.archived).toBe(true);
    expect(
      ((await (await app.request(`/api/threads/${thread.id}/messages`)).json()) as unknown[])
        .length,
    ).toBe(1);
    expect(dispatched).toBe(0);
    const before = f.saved();
    const unauthorized = await protectedFetch(
      new Request(`https://private.example${route}`, {
        method: "POST",
        body: JSON.stringify({ archived: false }),
      }),
      { ENVIRONMENT: "production" },
      async (request) => app.fetch(request),
    );
    expect(unauthorized.status).toBe(403);
    expect(f.saved()).toEqual(before);
  });
});
