import { describe, expect, it } from "vite-plus/test";
import { Coordinator, initialState, fakeExecution, type State } from "./coordinator";
import { api } from "./api";
function fixture() {
  let saved = initialState(),
    n = 0;
  const core = new Coordinator(
    saved,
    (state) => {
      saved = structuredClone(state);
    },
    () => "now",
    () => String(++n),
  );
  return { core, saved: () => saved };
}
describe("thread/change/run traceability", () => {
  it("keeps multiple changes in one thread and multiple exact runs for one change", async () => {
    const f = fixture(),
      thread = f.core.createThread("shared conversation", "thread");
    const first = f.core.submit(thread.id, "implement alpha", "alpha");
    const second = f.core.submit(thread.id, "implement beta", "beta");
    expect(first.run.changeId).toBe(first.change!.id);
    expect(second.change!.id).not.toBe(first.change!.id);
    expect(() => f.core.retryChange(first.change!.id, "busy")).toThrow("change_busy");
    const origin = f.core.begin(first.run.id)!;
    f.core.complete(first.run.id, await fakeExecution.delegate(origin));
    f.core.state.project.baseSha = "c".repeat(40);
    f.core.state.project.configurationRevision = "poc-v2";
    const retry = f.core.retryChange(first.change!.id, "retry");
    expect(f.core.retryChange(first.change!.id, "retry")).toEqual(retry);
    expect(retry.id).not.toBe(first.run.id);
    expect(retry.changeId).toBe(first.run.changeId);
    expect(retry.baseSha).toBe("c".repeat(40));
    expect(first.change!.contextRevision).toBe(`${first.run.baseSha}:poc-v1:1`);
    const input = f.core.begin(retry.id)!;
    expect(input.messages.map((message) => message.content)).toEqual(["implement alpha"]);
    expect(input.changeId).toBe(first.change!.id);
    expect(f.core.evidence(first.run.id).tests!.baseSha).toBe(first.run.baseSha);
  });
  it("migrates legacy runs deterministically without inventing absent message origins", () => {
    const f = fixture(),
      thread = f.core.createThread("legacy", "thread"),
      submitted = f.core.submit(thread.id, "legacy intent", "message");
    const legacy = f.saved();
    delete legacy.changes;
    for (const run of legacy.runs) delete run.changeId;
    const old = legacy.keys.message_message.result as typeof submitted;
    delete old.change;
    delete old.run.changeId;
    legacy.runs.push({ ...legacy.runs[0], id: "missing", messageId: undefined });
    let saved: State | undefined;
    const recovered = new Coordinator(legacy, (state) => {
      saved = structuredClone(state);
    });
    expect(recovered.state.runs[0].changeId).toBe(`legacy:${submitted.run.id}`);
    expect(recovered.change("legacy:missing").originMessageIds).toEqual([]);
    expect(() => recovered.retryChange("legacy:missing", "retry")).toThrow("origin_unavailable");
    const replay = recovered.submit(thread.id, "legacy intent", "message");
    expect(replay.run.changeId).toBe(recovered.state.runs[0].changeId);
    expect(replay.change!.originMessageIds).toEqual([submitted.message.id]);
    const again = new Coordinator(saved!, () => {
      throw Error("should not remigrate");
    });
    expect(again.state.changes).toHaveLength(2);
  });
  it("exposes additive change and retry APIs while existing message/runs clients remain compatible", async () => {
    const f = fixture(),
      thread = f.core.createThread("conversation", "thread");
    const app = api(f.core, async (id) => {
      await f.core.dispatch(id, fakeExecution);
    });
    const response = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "intent", idempotencyKey: "message" }),
    });
    expect(response.status).toBe(201);
    const submitted = (await response.json()) as ReturnType<Coordinator["submit"]>;
    expect(await (await app.request(`/api/threads/${thread.id}/changes`)).json()).toHaveLength(1);
    const retry = await app.request(`/api/changes/${submitted.change!.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "retry" }),
    });
    expect(retry.status).toBe(201);
    expect(
      await (await app.request(`/api/changes/${submitted.change!.id}/runs`)).json(),
    ).toHaveLength(2);
    expect(await (await app.request(`/api/threads/${thread.id}/runs`)).json()).toHaveLength(2);
  });
});
