import { expect, it } from "vite-plus/test";
import { Harness, createRegistry, defineTool } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { configureModels } from "./pi-models";
it("runs the actual Pi durable model/tool loop and deduplicates submission IDs with local storage", async () => {
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "fixture" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write_fixture", { content: "changed" }, { id: "call-1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("committed fixture"),
  ]);
  const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
  let written = "",
    calls = 0;
  const registry = createRegistry();
  registry.install({
    name: "test-worker",
    tools: [
      defineTool({
        name: "write_fixture",
        description: "Write the local fake sandbox",
        parameters: Type.Object({ content: Type.String() }),
        replay: "unsafe",
        execute: async ({ content }) => {
          calls++;
          written = content;
          return { content: [{ type: "text", text: "written" }] };
        },
      }),
    ],
  });
  const context = {
    abortSignal: AbortSignal.timeout(5000),
    value: () => undefined,
    toString: () => "[Local runtime test]",
  };
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const receipt = await conversation.submit(
      { type: "input", requestId: "change-fixture-1", content: "Implement fixture change" },
      context,
    );
    await receipt.wait(context);
    await conversation.waitForIdle(context);
    expect(written).toBe("changed");
    expect(calls).toBe(1);
    expect(faux.state.callCount).toBe(2);
    const replay = await conversation.submit(
      { type: "input", requestId: "change-fixture-1", content: "Implement fixture change" },
      context,
    );
    expect(replay.id).toBe(receipt.id);
    expect(calls).toBe(1);
    const view = await conversation.context(context);
    expect(JSON.stringify(view.messages)).toContain("committed fixture");
  } finally {
    await harness.close(context);
  }
});
