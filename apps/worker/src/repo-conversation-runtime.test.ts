import { expect, it } from "vite-plus/test";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { configureModels } from "./pi-models";
import { repositoryConversationTools } from "./repo-conversation-tools";
import { Coordinator, initialState } from "./coordinator";
import { resolveCatalog, configureConversation } from "./model-selection";
import { repositoryPrompt } from "./repo-conversation-driver";
it("the actual repo Pi tool loop delegates the current message once with frozen inherited models", async () => {
  const core = new Coordinator(initialState(), () => {});
  const thread = core.createThread("Implementation", "thread");
  const catalog = resolveCatalog({ EXECUTION_MODE: "fake" });
  const admitted = core.queueTurn(
    thread.id,
    "Implement a blue button",
    "message",
    "owner",
    catalog,
  );
  const input = core.beginConversation(admitted.turn.id)!;
  const faux = fauxProvider({ provider: "pitcrew-fixture", models: [{ id: "fixture" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_change", {}, { id: "call-one" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("delegate_change", {}, { id: "call-two" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("The isolated implementation run is queued."),
  ]);
  const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
  const registry = createRegistry();
  registry.install(
    repositoryConversationTools(async () => core.delegateConversation(input.turnId)),
  );
  const context = {
    abortSignal: AbortSignal.timeout(5000),
    value: () => undefined,
    toString: () => "[Synthetic repo test]",
  };
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const conversation = await configureConversation(
      harness,
      model,
      input.models.repoAgent,
      context,
    );
    const prompt = await repositoryPrompt(input, async () => {
      throw Error("no_image");
    });
    const receipt = await conversation.submit(
      { type: "input", requestId: `repo:${input.turnId}`, content: prompt },
      context,
    );
    await receipt.wait(context);
    await conversation.waitForIdle(context);
    expect(core.state.runs).toHaveLength(1);
    const request = core.begin(core.state.runs[0].id)!;
    expect(request.runModels).toEqual(admitted.turn.models);
    expect(request.messages.map((message) => message.content)).toEqual(["Implement a blue button"]);
    expect(core.state.reviews).toEqual([]);
    expect(core.state.runs[0].status).toBe("running");
  } finally {
    await harness.close(context);
  }
});
