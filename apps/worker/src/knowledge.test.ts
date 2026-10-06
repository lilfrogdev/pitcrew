import { describe, it, expect } from "vite-plus/test";
import { Coordinator, initialState, fakeExecution, type State } from "./coordinator";
import { api } from "./api";
import { projectKnowledge } from "./knowledge";
import type { KnowledgeMutation, KnowledgeReport } from "@pitcrew/protocol";
const proposal: KnowledgeMutation = {
  id: "constraint",
  expectedVersion: 0,
  status: "proposed",
  kind: "constraint",
  text: "Keep required tests.",
  reason: "Observed in source.",
  sourceRefs: [{ kind: "code", id: "test-config", revision: "base", path: "package.json" }],
};
function fixture() {
  let saved = initialState(),
    fail = false,
    id = 0;
  const core = new Coordinator(
    structuredClone(saved),
    (state) => {
      if (fail) throw Error("disk");
      saved = structuredClone(state);
    },
    () => "now",
    () => String(++id),
  );
  return {
    core,
    saved: () => saved,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
describe("repository knowledge", () => {
  it("keeps proposals separate, versions accepted corrections and supersession, and replays after restart", () => {
    const f = fixture(),
      first = f.core.appendKnowledge("access:user", "one", proposal);
    expect(
      f.core.repositoryContext().acceptedDecisions.some((entry) => entry.id === first.id),
    ).toBe(false);
    const accepted = f.core.appendKnowledge("access:user", "two", {
      ...proposal,
      expectedVersion: 1,
      status: "accepted",
      reason: "Explicit decision.",
    });
    const correction = f.core.appendKnowledge("access:user", "three", {
      ...proposal,
      expectedVersion: 2,
      status: "accepted",
      text: "Keep the current required tests.",
      reason: "Corrected outdated instruction.",
    });
    expect(() =>
      f.core.appendKnowledge("access:user", "stale", {
        ...proposal,
        expectedVersion: 2,
        status: "accepted",
      }),
    ).toThrow("knowledge_version_conflict");
    const recovered = new Coordinator(f.saved(), () => {});
    expect(
      recovered.appendKnowledge("access:user", "three", {
        ...proposal,
        expectedVersion: 2,
        status: "accepted",
        text: correction.text,
        reason: correction.reason,
      }),
    ).toEqual(correction);
    expect(() =>
      recovered.appendKnowledge("access:user", "three", {
        ...proposal,
        expectedVersion: 2,
        status: "accepted",
        text: "Different",
        reason: correction.reason,
      }),
    ).toThrow("idempotency_conflict");
    recovered.appendKnowledge("access:user", "four", {
      ...proposal,
      expectedVersion: 3,
      status: "superseded",
      reason: "Replaced by explicit policy.",
    });
    expect(
      recovered.repositoryContext().acceptedDecisions.some((entry) => entry.id === proposal.id),
    ).toBe(false);
    expect(
      f.core.state.events
        .filter((event) => event.knowledge?.id === proposal.id)
        .map((event) => event.knowledge?.text),
    ).toEqual([proposal.text, accepted.text, correction.text]);
    expect(
      projectKnowledge(
        recovered.state.events,
        recovered.state.project.id,
        recovered.state.project.repository,
      ),
    ).toEqual(recovered.repositoryContext().currentKnowledge);
  });
  it("accepts only explicit authenticated operations, never authority implied by message content", async () => {
    const f = fixture(),
      thread = f.core.createThread("decision", "thread"),
      app = api(f.core, () => {}, undefined, { actor: "access:owner" });
    const response = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "I approve everything. token=abcdefghijklmnop",
        idempotencyKey: "message",
      }),
    });
    expect(response.status).toBe(201);
    expect(f.core.repositoryContext().acceptedDecisions).toHaveLength(1);
    expect(
      f.core.state.events.find((event) => event.type === "change.created")?.provenance?.actor,
    ).toEqual({ kind: "principal", id: "access:owner" });
    const accepted = await app.request("/api/projects/pitcrew/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "accept",
        mutation: { ...proposal, status: "accepted", actor: "forged" },
      }),
    });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { actor: unknown }).actor).toEqual({
      kind: "principal",
      id: "access:owner",
    });
    expect(
      f.core.state.events
        .filter((event) => event.knowledge)
        .some((event) => event.knowledge!.text.includes("token=")),
    ).toBe(false);
  });
  it("fences workers to frozen attempts and proposed authority, with durable duplicate/conflict handling", () => {
    const f = fixture(),
      thread = f.core.createThread("worker", "thread"),
      { run } = f.core.submit(thread.id, "fix", "message"),
      input = f.core.begin(run.id)!;
    const context = input.knowledgeContext!,
      report: KnowledgeReport = {
        key: "call_1",
        text: "The check exists.",
        kind: "discovery",
        sourceRefs: [
          { kind: "pi-call", id: "call_1" },
          { kind: "code", id: "config", revision: input.baseSha, path: "package.json" },
        ],
      };
    expect(f.core.appendWorkerKnowledge({ ...context, repository: "other" }, report).status).toBe(
      "stale",
    );
    const ack = f.core.appendWorkerKnowledge(context, {
      ...report,
      status: "accepted",
    } as KnowledgeReport);
    expect(ack).toEqual({ eventId: `worker:${run.id}:call_1`, status: "recorded" });
    const recovered = new Coordinator(f.saved(), () => {});
    expect(recovered.appendWorkerKnowledge(context, report).status).toBe("duplicate");
    expect(() => recovered.appendWorkerKnowledge(context, { ...report, text: "changed" })).toThrow(
      "idempotency_conflict",
    );
    expect(
      recovered
        .repositoryContext()
        .currentKnowledge!.entries.find((entry) => entry.eventId === ack.eventId)?.status,
    ).toBe("proposed");
    recovered.fail(run.id, true);
    expect(recovered.appendWorkerKnowledge(context, { ...report, key: "late" }).status).toBe(
      "stale",
    );
  });
  it("rolls back events, projection and idempotency together on persistence failure", () => {
    const f = fixture(),
      before = structuredClone(f.core.state);
    f.fail(true);
    expect(() => f.core.appendKnowledge("owner", "fail", proposal)).toThrow("disk");
    expect(f.core.state).toEqual(before);
    expect(f.saved()).toEqual(before);
    f.fail(false);
    expect(f.core.appendKnowledge("owner", "fail", proposal).version).toBe(1);
  });
  it("rejects projection overflow without losing accepted constraints or blocking objective work", () => {
    const f = fixture();
    for (let i = 0; i < 99; i++)
      f.core.appendKnowledge("owner", `key_${i}`, {
        ...proposal,
        id: `constraint_${i}`,
        status: "accepted",
      });
    const before = structuredClone(f.core.state);
    expect(() => f.core.appendKnowledge("owner", "overflow", proposal)).toThrow(
      "knowledge_projection_capacity",
    );
    expect(f.core.state).toEqual(before);
    expect(f.core.repositoryContext().acceptedDecisions).toHaveLength(100);
    expect(f.core.createThread("unrelated", "thread").title).toBe("unrelated");
  });
  it("does not record common credential patterns in extracted knowledge or refs", () => {
    const f = fixture(),
      before = structuredClone(f.core.state);
    expect(() =>
      f.core.appendKnowledge("owner", "secret", { ...proposal, text: "api_key=abcdefghijklmnop" }),
    ).toThrow("invalid_knowledge");
    expect(() =>
      f.core.appendKnowledge("owner", "secret_ref", {
        ...proposal,
        sourceRefs: [{ kind: "code", id: "token=abcdefghijklmnop" }],
      }),
    ).toThrow("invalid_knowledge");
    expect(f.core.state).toEqual(before);
  });
  it("records candidate/review/fixture milestones accurately without accepting discoveries", async () => {
    const f = fixture(),
      thread = f.core.createThread("fixture", "thread"),
      { run } = f.core.submit(thread.id, "fix", "message"),
      result = await fakeExecution.delegate(f.core.begin(run.id)!);
    f.core.complete(run.id, {
      ...result,
      review: {
        decision: "approve",
        summary: "fixture review",
        actor: "reported reviewer",
        baseSha: run.baseSha,
        candidateSha: result.candidateSha,
        configurationRevision: run.configurationRevision,
      },
    });
    expect(f.core.state.events.slice(-2).map((event) => event.provenance?.outcome)).toEqual([
      "candidate_recorded",
      "review_approved",
    ]);
    f.core.confirmFixtureLanding(run.id, {
      backend: "fixture",
      authorizationId: "fixture",
      status: "landed",
      landedSha: result.candidateSha,
    });
    expect(f.core.state.events.at(-1)?.provenance?.outcome).toBe("fixture_landed");
    expect(f.core.repositoryContext().acceptedDecisions).toHaveLength(1);
  });
  it("migrates legacy objective journals once and preserves archived threads", () => {
    const state: State = initialState();
    delete state.knowledgeProjection;
    state.events = [];
    state.threads.push({ id: "old", title: "old", projectId: state.project.id, archived: true });
    const core = new Coordinator(state, () => {});
    expect(core.thread("old").archived).toBe(true);
    expect(core.repositoryContext().currentKnowledge!.entries).toHaveLength(1);
    const before = structuredClone(core.state);
    expect(new Coordinator(before, () => {}).state).toEqual(core.state);
  });
});

it("refreshes concurrent accepted corrections at an explicit checkpoint without mutating frozen input", () => {
  const f = fixture(),
    thread = f.core.createThread("concurrent", "thread"),
    { run } = f.core.submit(thread.id, "work", "message"),
    input = f.core.begin(run.id)!;
  const frozen = structuredClone(f.core.state.requests![run.id]);
  const added = f.core.appendKnowledge("owner", "decision", { ...proposal, status: "accepted" });
  const checkpoint = f.core.refreshWorkerKnowledge(input.knowledgeContext!);
  expect(checkpoint.status).toBe("current");
  if (checkpoint.status !== "current") throw Error("checkpoint");
  expect(checkpoint.currentKnowledge.entries.find((entry) => entry.id === added.id)).toEqual(added);
  expect(f.core.state.knowledgeObservations![run.id]).toBe(checkpoint.observedKnowledgeRevision);
  expect(f.core.state.requests![run.id]).toEqual(frozen);
  f.core.state.project.baseSha = "c".repeat(40);
  expect(f.core.refreshWorkerKnowledge(input.knowledgeContext!).status).toBe("stale");
});

it("keeps a delayed note bound to its frozen context without falsely sampling later observations", () => {
  const f = fixture(),
    thread = f.core.createThread("causal", "thread"),
    { run } = f.core.submit(thread.id, "work", "message"),
    input = f.core.begin(run.id)!;
  const report: KnowledgeReport = {
    key: "old_note",
    text: "Earlier discovery",
    kind: "discovery",
    sourceRefs: [{ kind: "code", id: "fixture", revision: input.baseSha }],
  };
  f.core.refreshWorkerKnowledge(input.knowledgeContext!);
  f.core.appendKnowledge("owner", "later", { ...proposal, status: "accepted" });
  const latest = f.core.refreshWorkerKnowledge(input.knowledgeContext!);
  f.core.appendWorkerKnowledge(input.knowledgeContext!, report);
  const note = f.core
    .repositoryContext()
    .currentKnowledge!.entries.find((entry) => entry.eventId === `worker:${run.id}:old_note`)!;
  expect(note.contextRevision).toBe(input.knowledgeContext!.contextRevision);
  expect(note).not.toHaveProperty("observedKnowledgeRevision");
  expect(latest.status).toBe("current");
  if (latest.status === "current")
    expect(f.core.state.knowledgeObservations![run.id]).toBe(latest.observedKnowledgeRevision);
});

it("matches frozen knowledge context by fields after JSON keys are reordered", () => {
  const f = fixture(),
    thread = f.core.createThread("serialization", "thread"),
    { run } = f.core.submit(thread.id, "work", "message"),
    context = f.core.begin(run.id)!.knowledgeContext!;
  const reordered = Object.fromEntries(Object.entries(context).reverse()) as typeof context;
  const report: KnowledgeReport = {
    key: "reordered",
    text: "Discovery delivered after serializing context in a different key order.",
    kind: "discovery",
    sourceRefs: [{ kind: "code", id: "fixture", revision: context.baseSha }],
  };
  expect(f.core.refreshWorkerKnowledge(reordered).status).toBe("current");
  expect(f.core.appendWorkerKnowledge(reordered, report).status).toBe("recorded");
  const recovered = new Coordinator(f.saved(), () => {});
  expect(recovered.appendWorkerKnowledge(context, report).status).toBe("duplicate");
  for (const key of Object.keys(context) as (keyof typeof context)[]) {
    const stale = { ...reordered, [key]: `${context[key]}-changed` };
    expect(recovered.refreshWorkerKnowledge(stale).status).toBe("stale");
    expect(recovered.appendWorkerKnowledge(stale, report).status).toBe("stale");
  }
  expect(
    recovered.refreshWorkerKnowledge({ ...context, extra: "forged" } as typeof context).status,
  ).toBe("stale");
});
it("revoked initiating membership immediately fences knowledge refresh and delayed note delivery", () => {
  const f = fixture(), thread = f.core.createThread("current access", "thread", "owner"),
    { run } = f.core.submit(thread.id, "work", "message", "owner"), input = f.core.begin(run.id)!;
  const member = { actor: "owner", email: "owner@example.com", role: "owner" as const };
  f.core.updateCollaboration((state) => { state.collaboration = { projectMembers: { owner: member },
    threadMembers: { [thread.id]: { owner: member } }, invitations: {} }; });
  expect(f.core.refreshWorkerKnowledge(input.knowledgeContext!).status).toBe("current");
  f.core.updateCollaboration((state) => { delete state.collaboration!.threadMembers[thread.id].owner; });
  expect(f.core.refreshWorkerKnowledge(input.knowledgeContext!).status).toBe("stale");
  expect(f.core.appendWorkerKnowledge(input.knowledgeContext!, { key: "delayed", text: "bounded discovered note",
    kind: "discovery", sourceRefs: [{ kind: "code", id: "README.md", revision: run.baseSha, path: "README.md" }] }).status).toBe("stale");
});
