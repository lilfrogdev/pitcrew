import { describe, it, expect } from "vite-plus/test";
import { Coordinator, initialState, type State } from "./coordinator";
import { api } from "./api";
import { resolveCatalog } from "./model-selection";
const catalog = resolveCatalog({ EXECUTION_MODE: "fake" });
function fixture() {
  let persisted: State = initialState(),
    id = 0;
  const core = new Coordinator(
    persisted,
    (s) => {
      persisted = structuredClone(s);
    },
    () => "2026-10-05T00:00:00Z",
    () => `id${++id}`,
  );
  const thread = core.createThread("Conversation", "thread");
  return {
    core,
    thread,
    reload: () =>
      new Coordinator(structuredClone(persisted), (s) => {
        persisted = structuredClone(s);
      }),
  };
}
describe("durable repository conversation", () => {
  it("queues durable turns without creating change runs, replays idempotently and freezes selection", () => {
    const f = fixture();
    const first = f.core.queueTurn(
      f.thread.id,
      "Explain the architecture",
      "one",
      "alice",
      catalog,
    );
    expect(f.core.state.runs).toHaveLength(0);
    expect(
      f.core.queueTurn(f.thread.id, "Explain the architecture", "one", "alice", catalog),
    ).toEqual(first);
    expect(() => f.core.queueTurn(f.thread.id, "Different", "one", "alice", catalog)).toThrow(
      "idempotency_conflict",
    );
    const frozen = structuredClone(first.turn.models);
    f.core.setThreadModelSelection(f.thread.id, catalog, catalog.defaultSelection);
    f.core.updateModelSettings(catalog, {
      default: catalog.defaultSelection,
      roles: { reviewer: catalog.defaultSelection },
    });
    expect(f.reload().conversationTurn(first.turn.id).models).toEqual(frozen);
  });
  it("serializes queued turns and includes earlier replies without later user messages", () => {
    const f = fixture();
    const a = f.core.queueTurn(f.thread.id, "Question one", "one", "alice", catalog);
    const b = f.core.queueTurn(f.thread.id, "Question two", "two", "alice", catalog);
    expect(f.core.beginConversation(b.turn.id)).toBeUndefined();
    expect(f.core.beginConversation(a.turn.id)?.messages.map((m) => m.content)).toEqual([
      "Question one",
    ]);
    f.core.completeConversation(a.turn.id, "Answer one");
    const input = f.reload().beginConversation(b.turn.id)!;
    expect(input.messages.map((m) => m.content)).toEqual([
      "Question one",
      "Answer one",
      "Question two",
    ]);
    expect(input.messageId).toBe(b.message.id);
  });
  it("delegates once with original user message and frozen model config, preserving legacy run semantics", () => {
    const f = fixture();
    const first = f.core.queueTurn(f.thread.id, "Implement the button", "one", "alice", catalog);
    expect(() => f.core.delegateConversation(first.turn.id)).toThrow("conversation_not_running");
    f.core.beginConversation(first.turn.id);
    const run = f.core.delegateConversation(first.turn.id);
    expect(f.reload().delegateConversation(first.turn.id).id).toBe(run.id);
    const request = f.core.begin(run.id)!;
    expect(request.runModels).toEqual(first.turn.models);
    expect(request.messages.map((m) => m.id)).toEqual([first.message.id]);
    expect(f.core.state.messages).toHaveLength(1);
    expect(f.core.state.changes).toHaveLength(1);
  });
  it("rejects stale delegation and invalid settings without changing accepted turns", () => {
    const f = fixture();
    const first = f.core.queueTurn(f.thread.id, "Implement", "one", "alice", catalog);
    f.core.beginConversation(first.turn.id);
    f.core.state.project.baseSha = "a".repeat(40);
    expect(() => f.core.delegateConversation(first.turn.id)).toThrow("stale_configuration");
    expect(() =>
      f.core.updateModelSettings(catalog, {
        default: catalog.defaultSelection,
        roles: { researcher: catalog.defaultSelection },
      }),
    ).toThrow("invalid_model_settings");
    expect(() =>
      f.core.queueTurn(f.thread.id, "q", "two", "alice", catalog, {
        modelId: "secret",
        effort: "high",
      }),
    ).toThrow("invalid_model_selection");
  });
  it("returns conversation capabilities, persists an unsent selection and dispatches only a turn", async () => {
    const f = fixture(),
      dispatched: string[] = [];
    const app = api(
      f.core,
      () => {
        throw Error("must_not_dispatch_worker");
      },
      undefined,
      { actor: "alice" },
      {
        catalog,
        dispatch: (id) => {
          dispatched.push(id);
        },
      },
    );
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const caps = (await (await app.request("/api/capabilities")).json()) as any;
    expect(caps.composer.conversation).toBe(true);
    expect(JSON.stringify(caps)).not.toContain("secretBinding");
    expect(
      (
        await post(`/api/projects/pitcrew/threads/${f.thread.id}/model-selection`, {
          modelSelection: catalog.defaultSelection,
        })
      ).status,
    ).toBe(200);
    expect(f.reload().thread(f.thread.id).modelSelection).toEqual(catalog.defaultSelection);
    const response = await post(`/api/threads/${f.thread.id}/messages`, {
      content: "Question",
      idempotencyKey: "one",
    });
    const receipt = (await response.json()) as any;
    expect(response.status).toBe(201);
    expect(receipt.run).toBeUndefined();
    expect(dispatched).toEqual([receipt.turn.id]);
    const turns = (await (await app.request(`/api/threads/${f.thread.id}/turns`)).json()) as any;
    expect(turns[0].input).toBeUndefined();
    expect(turns[0].actor).toBeUndefined();
  });
});
it("stores synthetic images by immutable reference, replays exact bytes and rejects incompatible history", async () => {
  const { attachmentStore } = await import("./attachment-store");
  const rows = new Map<string, import("@pitcrew/protocol").ImageAttachment>();
  const store = attachmentStore(
    (id) => rows.get(id),
    (id, value) => {
      rows.set(id, value);
    },
  );
  const core = new Coordinator(initialState(), () => {}, undefined, undefined, store);
  const thread = core.createThread("Images", "thread");
  const image = {
    id: "image",
    name: "synthetic.png",
    mediaType: "image/png" as const,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  };
  const first = core.queueTurn(
    thread.id,
    "Inspect this synthetic square",
    "image",
    "owner",
    catalog,
    undefined,
    [image],
  );
  expect(JSON.stringify(core.state)).not.toContain(image.data);
  expect(rows.size).toBe(1);
  expect(
    core.queueTurn(
      thread.id,
      "Inspect this synthetic square",
      "image",
      "owner",
      catalog,
      undefined,
      [image],
    ),
  ).toEqual(first);
  expect(rows.size).toBe(1);
  const otherUser = core.queueTurn(
    thread.id,
    "Inspect this synthetic square",
    "image",
    "other",
    catalog,
    undefined,
    [image],
  );
  expect(otherUser.turn.id).not.toBe(first.turn.id);
  expect(otherUser.turn.actor).toBe("other");
  const unsupported = structuredClone(catalog);
  unsupported.choices[0].imageLimits = undefined;
  expect(() => core.queueTurn(thread.id, "Followup", "next", "owner", unsupported)).toThrow(
    "attachment_images_unsupported",
  );
  expect(core.state.messages).toHaveLength(2);
});
it("quarantines catalog-changed runs without accepting a late worker completion", async () => {
  const { fakeExecution } = await import("./coordinator");
  const f = fixture();
  const admitted = f.core.queueTurn(f.thread.id, "Implement", "one", "owner", catalog);
  f.core.beginConversation(admitted.turn.id);
  const run = f.core.delegateConversation(admitted.turn.id);
  const input = f.core.begin(run.id)!;
  f.core.blockModelConfiguration(run.id);
  expect(f.core.evidence(run.id).run.error).toBe("model_configuration_changed");
  expect(f.core.evidence(run.id).run.status).toBe("waiting_user");
  f.core.complete(run.id, await fakeExecution.delegate(input));
  expect(f.core.evidence(run.id).tests).toBeUndefined();
  expect(f.core.evidence(run.id).run.status).toBe("waiting_user");
});

it("freezes earlier plan discussion as reference context while authorizing only the current request", () => {
  const f = fixture();
  const plan = f.core.queueTurn(
    f.thread.id,
    "Discuss a blue button with a red border",
    "plan",
    "alice",
    catalog,
  );
  f.core.beginConversation(plan.turn.id);
  f.core.completeConversation(
    plan.turn.id,
    "The plan uses a blue button, a red border, and keyboard access.",
  );
  const request = f.core.queueTurn(
    f.thread.id,
    "Implement the plan we discussed",
    "implement",
    "alice",
    catalog,
  );
  const input = f.core.beginConversation(request.turn.id)!;
  const run = f.core.delegateConversation(request.turn.id);
  f.core.completeConversation(request.turn.id, "Implementation queued");
  f.core.queueTurn(f.thread.id, "Unrelated later request", "later", "alice", catalog);
  const admitted = f.reload().begin(run.id)!;
  expect(admitted.messages.map((m) => m.id)).toEqual([request.message.id]);
  expect(admitted.conversationContext).toEqual(
    input.messages.filter((m) => m.id !== request.message.id),
  );
  expect(admitted.conversationContext?.map((m) => m.content)).toEqual([
    "Discuss a blue button with a red border",
    "The plan uses a blue button, a red border, and keyboard access.",
  ]);
  expect(f.core.change(run.changeId!).originMessageIds).toEqual([request.message.id]);
});
