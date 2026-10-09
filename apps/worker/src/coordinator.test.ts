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
  it("keeps a quarantined attempt terminal when its late result arrives after retry", async () => {
    const f = fixture(),
      thread = f.core.createThread("change", "thread"),
      first = f.core.submit(thread.id, "fix", "message"),
      input = f.core.begin(first.run.id)!;
    f.core.fail(first.run.id, true);
    const retry = f.core.retryChange(first.change!.id, "retry"),
      before = structuredClone(f.saved());
    f.core.complete(first.run.id, await fakeExecution.delegate(input));
    expect(f.saved()).toEqual(before);
    expect(f.core.evidence(first.run.id).run.status).toBe("waiting_user");
    expect(f.core.evidence(retry.id).run.status).toBe("queued");
    expect(f.core.evidence(first.run.id).tests).toBeUndefined();
  });
  it("ignores results and failures for stopped attempts", async () => {
    const f = fixture(),
      thread = f.core.createThread("change", "thread"),
      { run } = f.core.submit(thread.id, "fix", "message"),
      input = f.core.begin(run.id)!;
    run.status = "stopped";
    const before = structuredClone(f.core.state);
    f.core.complete(run.id, await fakeExecution.delegate(input));
    f.core.fail(run.id);
    expect(f.core.state).toEqual(before);
  });
  it("preserves accepted completion when a duplicate in-flight dispatch fails later", async () => {
    const f = fixture(),
      thread = f.core.createThread("change", "thread"),
      { run } = f.core.submit(thread.id, "fix", "message");
    let reject!: (error: Error) => void;
    const delayed = f.core.dispatch(run.id, {
      delegate: () => new Promise((_, rejectResult) => (reject = rejectResult)),
    });
    await f.core.dispatch(run.id, fakeExecution);
    const accepted = structuredClone(f.saved());
    reject(Error("late provider failure"));
    await delayed;
    expect(f.saved()).toEqual(accepted);
    expect(f.core.evidence(run.id).run.status).toBe("awaiting_review");
  });
  it("owns an immutable copy of accepted evidence and review across transport retries", async () => {
    const f = fixture(),
      thread = f.core.createThread("change", "thread"),
      { run } = f.core.submit(thread.id, "fix", "message"),
      result = {
        ...(await fakeExecution.delegate(f.core.begin(run.id)!)),
        review: {
          decision: "request_changes" as const,
          summary: "original verdict",
          actor: "reviewer",
          baseSha: run.baseSha,
          candidateSha: run.baseSha,
          configurationRevision: run.configurationRevision,
          verificationGaps: ["original gap"],
        },
      };
    f.core.complete(run.id, result);
    const accepted = structuredClone(f.core.state);
    result.tests.stdout = "mutated after delivery";
    result.tests.argv.push("mutated");
    result.review.summary = "changed verdict";
    result.review.verificationGaps.push("changed gap");
    f.core.complete(run.id, result);
    expect(f.core.state).toEqual(accepted);
    expect(f.saved()).toEqual(accepted);
    const recovered = new Coordinator(f.saved(), () => {});
    recovered.complete(run.id, result);
    expect(recovered.state).toEqual(accepted);
  });
  it("publishes completion and review events only after evidence persistence commits", async () => {
    let saved = initialState(),
      fail = false,
      id = 0;
    const core = new Coordinator(
      saved,
      (state) => {
        if (fail) throw Error("disk");
        saved = structuredClone(state);
      },
      () => "now",
      () => String(++id),
    );
    const thread = core.createThread("change", "thread"),
      { run } = core.submit(thread.id, "fix", "message"),
      input = core.begin(run.id)!,
      result = {
        ...(await fakeExecution.delegate(input)),
        review: {
          decision: "request_changes" as const,
          summary: "verdict",
          actor: "reviewer",
          baseSha: run.baseSha,
          candidateSha: run.baseSha,
          configurationRevision: run.configurationRevision,
        },
      },
      before = structuredClone(saved);
    fail = true;
    expect(() => core.complete(run.id, result)).toThrow("disk");
    expect(core.state).toEqual(before);
    expect(saved).toEqual(before);
    fail = false;
    core.complete(run.id, result);
    expect(core.state.events.slice(-2).map((event) => event.type)).toEqual([
      "run.awaiting_review",
      "review.created",
    ]);
    expect(core.state.events.map((event) => event.sequence)).toEqual(
      core.state.events.map((_, index) => index + 1),
    );
    expect(core.state).toEqual(saved);
  });
  it("atomically creates message/run and replays same body after recovery", () => {
    const f = fixture(),
      t = f.core.createThread("change", "t");
    const first = f.core.submit(t.id, "fix", "k");
    const recovered = new Coordinator(f.saved(), () => {});
    expect(recovered.submit(t.id, "fix", "k")).toEqual(first);
    expect(recovered.state.runs).toHaveLength(1);
    expect(() => recovered.submit(t.id, "different", "k")).toThrow("idempotency_conflict");
  });
  it("recovers pinned dispatch input and retries lost result persistence without duplicating evidence", async () => {
    let saved = initialState(),
      fail = false;
    const core = new Coordinator(saved, (state) => {
      if (fail) throw Error("disk");
      saved = structuredClone(state);
    });
    const thread = core.createThread("request", "thread");
    const { run } = core.submit(thread.id, "first intent", "message");
    const input = core.begin(run.id)!;
    core.submit(thread.id, "later intent", "later");
    const recovered = new Coordinator(saved, (state) => {
      if (fail) throw Error("disk");
      saved = structuredClone(state);
    });
    recovered.recover(true);
    expect(recovered.begin(run.id)).toEqual(input);
    expect(input.messages.map((message) => message.content)).toEqual(["first intent"]);
    const result = await fakeExecution.delegate(input);
    fail = true;
    expect(() => recovered.complete(run.id, result)).toThrow("disk");
    expect(recovered.evidence(run.id).run.candidateSha).toBeUndefined();
    fail = false;
    recovered.complete(run.id, result);
    recovered.complete(run.id, result);
    expect(saved.events.filter((event) => event.type === "run.awaiting_review")).toHaveLength(1);
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
    expect(
      (
        await app.request("/api/runs/x/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
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
  it("rejects missing keys before namespacing and quarantines admitted queued work", () => {
    const f = fixture();
    expect(() => f.core.createThread("change", undefined as unknown as string)).toThrow(
      "invalid_idempotency_key",
    );
    const t = f.core.createThread("change", "t");
    const { run } = f.core.submit(t.id, "fix", "k");
    f.core.recover();
    expect(run.status).toBe("waiting_user");
    expect(run.error).toBe("reconciliation_required");
  });
  it("rejects mismatched original reviewer evidence", async () => {
    const f = fixture(),
      t = f.core.createThread("change", "t"),
      { run } = f.core.submit(t.id, "fix", "k");
    await f.core.dispatch(run.id, {
      delegate: async (input) => ({
        ...(await fakeExecution.delegate(input)),
        review: {
          decision: "approve",
          summary: "wrong run",
          actor: "reviewer",
          baseSha: "f".repeat(40),
          candidateSha: input.baseSha,
          configurationRevision: input.configurationRevision,
        },
      }),
    });
    expect(run.status).toBe("failed");
    expect(f.core.state.reviews).toHaveLength(0);
  });
  it("runs separate threads concurrently with isolated context", async () => {
    const f = fixture(),
      a = f.core.createThread("a", "a"),
      b = f.core.createThread("b", "b");
    const ar = f.core.submit(a.id, "only a", "a").run,
      br = f.core.submit(b.id, "only b", "b").run;
    const seen: string[][] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const adapter = {
      delegate: async (input: Parameters<typeof fakeExecution.delegate>[0]) => {
        seen.push(input.messages.map((m) => m.content));
        if (seen.length === 2) release();
        await barrier;
        return fakeExecution.delegate(input);
      },
    };
    await Promise.all([f.core.dispatch(ar.id, adapter), f.core.dispatch(br.id, adapter)]);
    expect(seen).toEqual([["only a"], ["only b"]]);
    expect(ar.status).toBe("awaiting_review");
    expect(br.status).toBe("awaiting_review");
  });
  it("bounds actual request bytes without Content-Length", async () => {
    const response = await api(fixture().core, () => {}).request("/api/projects/pitcrew/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "a".repeat(17000), idempotencyKey: "a" }),
    });
    expect(response.status).toBe(413);
  });
  it("briefs workers on accepted versioned context and other active thread intents", async () => {
    const f = fixture(),
      a = f.core.createThread("a", "a"),
      b = f.core.createThread("b", "b");
    const run = f.core.submit(a.id, "fix a", "a").run;
    f.core.submit(b.id, "fix b", "b");
    let seen: Parameters<typeof fakeExecution.delegate>[0] | undefined;
    await f.core.dispatch(run.id, {
      delegate: async (input) => {
        seen = input;
        return fakeExecution.delegate(input);
      },
    });
    expect(seen!.repositoryContext!.activeWork.map((work) => work.intent)).toEqual([
      "fix a",
      "fix b",
    ]);
    expect(seen!.repositoryContext!.acceptedDecisions).toHaveLength(1);
    expect(seen!.repositoryContext!.baseSha).toBe(run.baseSha);
  });
});

it("registers the preallocated project UUID and preserves distinct owner-local names independently of display labels", () => {
  const root = new Coordinator(initialState(), () => {});
  const allocated = crypto.randomUUID();
  const first = root.addOwnedProject(
    "acme-" + allocated.replaceAll("-", ""),
    "resource-one",
    "account:one",
    "one@example.com",
    undefined,
    undefined,
    { displayName: "Same label", description: "", logicalName: "acme" },
    allocated,
  );
  expect(first.id).toBe(allocated);
  expect(first.logicalName).toBe("acme");
  expect(() =>
    root.addOwnedProject(
      "different-physical",
      "resource-two",
      "account:one",
      "one@example.com",
      undefined,
      undefined,
      { displayName: "Other label", description: "", logicalName: "acme" },
    ),
  ).toThrow("repository_exists");
  const otherOwner = root.addOwnedProject(
    "owner-two-physical",
    "resource-three",
    "account:two",
    "two@example.com",
    undefined,
    undefined,
    { displayName: "Same label", description: "", logicalName: "acme" },
  );
  expect(otherOwner.name).toBe(first.name);
  expect(otherOwner.id).not.toBe(first.id);
});
