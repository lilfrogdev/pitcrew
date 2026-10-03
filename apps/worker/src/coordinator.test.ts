import { describe, expect, it } from "vite-plus/test";
import { Coordinator, fakeExecution, initialState, type State } from "./coordinator";
import { api, fixtureAccess } from "./api";
function fixture() {
  let saved: State = initialState(),
    id = 0;
  const core = new Coordinator(
    saved,
    (s) => {
      saved = structuredClone(s);
    },
    () => "2026-10-03T00:00:00Z",
    () => String(++id),
  );
  return { core, saved: () => saved };
}
describe("durable coordinator", () => {
  it("atomically creates message/run and replays same body after recovery", () => {
    const f = fixture(),
      t = f.core.createThread("change", "t");
    const first = f.core.submit(t.id, "fix", "k");
    const recovered = new Coordinator(f.saved(), () => {});
    expect(recovered.submit(t.id, "fix", "k")).toEqual(first);
    expect(recovered.state.runs).toHaveLength(1);
    expect(() => recovered.submit(t.id, "different", "k")).toThrow("idempotency_conflict");
  });
  it("bounds admission without persisting partial message", () => {
    const f = fixture(),
      t = f.core.createThread("change", "t");
    for (let i = 0; i < 4; i++) f.core.submit(t.id, "fix", String(i));
    expect(() => f.core.submit(t.id, "fifth", "5")).toThrow("capacity");
    expect(f.saved().messages).toHaveLength(4);
  });
  it("rolls back state when persistence fails", () => {
    const core = new Coordinator(initialState(), () => {
      throw Error("disk");
    });
    expect(() => core.createThread("change", "t")).toThrow("disk");
    expect(core.state.threads).toHaveLength(0);
  });
  it("does not replay uncertain running mutations on recovery", async () => {
    const f = fixture(),
      t = f.core.createThread("change", "t"),
      { run } = f.core.submit(t.id, "fix", "k");
    run.status = "running";
    f.core.recover();
    expect(run.status).toBe("waiting_user");
    expect(run.error).toBe("reconciliation_required");
    await f.core.dispatch(run.id, {
      delegate: () => {
        throw Error("must not call");
      },
    });
    expect(run.status).toBe("waiting_user");
  });
  it("fake evidence cannot claim passing QA or merge", async () => {
    const f = fixture(),
      t = f.core.createThread("change", "t"),
      { run } = f.core.submit(t.id, "fix", "k");
    await f.core.dispatch(run.id, fakeExecution);
    expect(f.core.evidence(run.id)).toMatchObject({
      run: { status: "awaiting_review" },
      tests: { status: "not_run" },
      reviews: [],
    });
  });
  it("sanitizes adapter failures and rejects mismatched hashes", async () => {
    const f = fixture(),
      t = f.core.createThread("change", "t"),
      { run } = f.core.submit(t.id, "fix", "k");
    await f.core.dispatch(run.id, {
      delegate: async () => {
        throw Error("secret");
      },
    });
    expect(run.error).toBe("execution_failed");
    expect(JSON.stringify(f.saved())).not.toContain("secret");
  });
  it("serves chat and rejects client review insertion", async () => {
    const f = fixture(),
      app = api(f.core, () => {});
    let response = await app.request("/api/projects/pitcrew/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fix", idempotencyKey: "t" }),
    });
    const t = (await response.json()) as { id: string };
    response = await app.request(`/api/threads/${t.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "fix", idempotencyKey: "k" }),
    });
    expect(response.status).toBe(201);
    expect((await app.request("/api/runs/x/reviews", { method: "POST" })).status).toBe(404);
  });
  it("fails closed outside loopback development fixture", () => {
    expect(
      fixtureAccess(new Request("https://pitcrew.example"), {
        ENVIRONMENT: "development",
        FIXTURE_IDENTITY: "lilfrogdev",
      }),
    ).toBe(false);
    expect(
      fixtureAccess(new Request("http://localhost"), {
        ENVIRONMENT: "production",
        FIXTURE_IDENTITY: "lilfrogdev",
      }),
    ).toBe(false);
    expect(
      fixtureAccess(new Request("http://localhost"), {
        ENVIRONMENT: "development",
        FIXTURE_IDENTITY: "lilfrogdev",
      }),
    ).toBe(true);
  });
});
