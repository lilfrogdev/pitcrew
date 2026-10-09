import { expect, it } from "vite-plus/test";
import { api } from "./api";
import { Coordinator, initialState, type State } from "./coordinator";
import {
  resolveCatalog,
  conversationModelEnv,
  conversationsEnabled,
  codingEnabled,
} from "./model-selection";
const catalog = resolveCatalog({ MODEL_CONFIGURATION: '{"provider":"fake"}' });
function fixture() {
  let saved = initialState();
  const core = new Coordinator(saved, (state) => {
    saved = structuredClone(state);
  });
  const thread = core.createThread("Team", "thread");
  const turns: string[] = [],
    runs: string[] = [];
  let providerChecks = 0;
  const make = (target = core, enabled = true, actor = "sender") =>
    api(
      target,
      (id) => {
        runs.push(id);
      },
      undefined,
      { actor },
      enabled
        ? {
            catalog,
            admit: async () => {
              providerChecks++;
              return catalog;
            },
            dispatch: (id) => {
              turns.push(id);
            },
          }
        : undefined,
    );
  const post = (body: Record<string, unknown>, app = make()) =>
    app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    core,
    thread,
    turns,
    runs,
    make,
    post,
    saved: () => saved,
    checks: () => providerChecks,
  };
}
it("Team defaults to a durable human note without consulting model/provider admission in any mode", async () => {
  const f = fixture();
  for (const [index, content] of [
    "hello @agent",
    "`@agent`",
    "> quoted @agent",
    '"quoted @agent"',
  ].entries()) {
    const result = await f.post({ content, idempotencyKey: String(index) });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ content, destination: "team", invocation: "none" });
  }
  expect(
    (await f.post({ content: "provider missing", idempotencyKey: "off" }, f.make(f.core, false)))
      .status,
  ).toBe(201);
  expect(f.checks()).toBe(0);
  expect(f.turns).toEqual([]);
  expect(f.runs).toEqual([]);
  expect(f.core.state.conversationTurns ?? []).toEqual([]);
  expect(f.core.state.runs).toEqual([]);
});
it("explicit destination and selected repeated @agent mentions admit exactly one frozen sender-owned turn", async () => {
  const f = fixture();
  const body = {
    destination: "agent",
    content: "  @agent and @agent  ",
    agentMentions: [
      { start: 2, end: 8 },
      { start: 13, end: 19 },
    ],
    idempotencyKey: "once",
    credentialActor: "victim",
  };
  const result = await f.post(body);
  expect(result.status).toBe(201);
  const receipt = (await result.json()) as any;
  expect(receipt).toMatchObject({
    invocation: "queued",
    message: {
      destination: "agent",
      content: "@agent and @agent",
      agentMentions: [
        { start: 0, end: 6 },
        { start: 11, end: 17 },
      ],
    },
  });
  expect(f.core.beginConversation(receipt.turn.id)?.credentialActor).toBe("sender");
  expect((await f.post(body)).status).toBe(201);
  expect(f.checks()).toBe(1);
  expect(f.core.state.messages).toHaveLength(1);
  expect(f.core.state.conversationTurns).toHaveLength(1);
  expect(f.core.state.runs).toEqual([]);
  const next = await f.post({
    content: "ask @agent",
    destination: "team",
    agentMentions: [{ start: 4, end: 10 }],
    idempotencyKey: "selected",
  });
  expect(next.status).toBe(201);
  expect(((await next.json()) as any).message.destination).toBe("team");
  expect(f.core.state.conversationTurns).toHaveLength(2);
});
it("one admission receipt fences mode changes, restarts, changed intent and actor ownership", async () => {
  const f = fixture();
  const note = { content: "same", idempotencyKey: "same" };
  const original = await (await f.post(note, f.make(f.core, false))).json();
  const reloaded = new Coordinator(f.saved(), () => {});
  expect(await (await f.post({ ...note, destination: "team" }, f.make(reloaded))).json()).toEqual(
    original,
  );
  expect((await f.post({ ...note, destination: "agent" }, f.make(reloaded))).status).toBe(409);
  expect(reloaded.state.messages).toHaveLength(1);
  expect(reloaded.state.runs).toEqual([]);
  const request = { content: "question", destination: "agent", idempotencyKey: "turn" };
  const queued = (await (await f.post(request)).json()) as any;
  const restarted = new Coordinator(f.saved(), () => {});
  const replay = await f.post(request, f.make(restarted, false));
  expect(replay.status).toBe(201);
  expect(((await replay.json()) as any).turn.id).toBe(queued.turn.id);
  expect((await f.post({ ...request, destination: "team" }, f.make(restarted))).status).toBe(409);
  expect((await f.post(note, f.make(restarted, false, "other"))).status).toBe(201);
  expect(restarted.state.messages).toHaveLength(3);
});
it("invalid routing never writes a message or turn and explicit unavailable Agent never becomes a note/run", async () => {
  const f = fixture();
  const invalid = [null, false, "Agent", "", 42, {}];
  for (const [index, destination] of invalid.entries()) {
    expect(
      (await f.post({ destination, content: "hello", idempotencyKey: `bad-${index}` })).status,
    ).toBe(400);
  }
  for (const [index, content] of [
    "`@agent`",
    "\\@agent",
    "> quoted\n@agent",
    "- > @agent",
    '"quoted @agent"',
  ].entries()) {
    const start = content.indexOf("@agent");
    expect(
      (
        await f.post({
          content,
          agentMentions: [{ start, end: start + 6 }],
          idempotencyKey: `span-${index}`,
        })
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await f.post(
        { content: "work", destination: "agent", idempotencyKey: "disabled" },
        f.make(f.core, false),
      )
    ).status,
  ).toBe(503);
  expect(f.core.state.messages).toEqual([]);
  expect(f.core.state.runs).toEqual([]);
  expect(f.core.state.conversationTurns ?? []).toEqual([]);
});
it("the message and receipt commit atomically and a failed persist can safely retry", async () => {
  let fail = false,
    saved: State = initialState();
  const core = new Coordinator(saved, (state) => {
    if (fail) throw Error("synthetic_persist_failure");
    saved = structuredClone(state);
  });
  const thread = core.createThread("Atomic", "thread");
  const body = { destination: "agent", content: "explain", idempotencyKey: "retry" };
  const admission = core.inspectMessageAdmission(thread.id, body, "sender").admission;
  fail = true;
  expect(() =>
    core.queueTurn(
      thread.id,
      "explain",
      "retry",
      "sender",
      catalog,
      undefined,
      undefined,
      undefined,
      undefined,
      admission,
    ),
  ).toThrow("synthetic_persist_failure");
  expect(core.state.messages).toEqual([]);
  expect(core.inspectMessageAdmission(thread.id, body, "sender").replay).toBeUndefined();
  fail = false;
  const admitted = core.queueTurn(
    thread.id,
    "explain",
    "retry",
    "sender",
    catalog,
    undefined,
    undefined,
    undefined,
    undefined,
    admission,
  );
  expect(
    new Coordinator(saved, () => {}).inspectMessageAdmission(thread.id, body, "sender").replay,
  ).toEqual(admitted);
});
it("chat resolver admission leaves the actual coding/infrastructure environment disabled", () => {
  const env = {
    EXECUTION_MODE: "disabled",
    INFRASTRUCTURE_ADMISSION_ENABLED: "false",
    CLOUD_CONVERSATION_ENABLED: "true",
  };
  expect(conversationsEnabled(env)).toBe(true);
  expect(codingEnabled(env)).toBe(false);
  expect(
    codingEnabled({
      EXECUTION_MODE: "cloud",
      INFRASTRUCTURE_ADMISSION_ENABLED: "true",
      AUTH_MODE: "password-only",
    }),
  ).toBe(false);
  expect(conversationModelEnv(env).EXECUTION_MODE).toBe("cloud");
  expect(env.EXECUTION_MODE).toBe("disabled");
  expect(env.INFRASTRUCTURE_ADMISSION_ENABLED).toBe("false");
});

it("a missing model configuration cannot disable Team capabilities or perform provider checks", async () => {
  const f = fixture();
  const app = api(
    f.core,
    () => {},
    undefined,
    { actor: "sender" },
    {
      get catalog(): ReturnType<typeof resolveCatalog> {
        throw Error("model_not_configured");
      },
      dispatch: () => {},
    },
  );
  expect(await (await app.request("/api/capabilities")).json()).toEqual({
    landing: { enabled: false, backend: null },
    notesEnabled: true,
  });
  expect((await f.post({ content: "hello", idempotencyKey: "note" }, app)).status).toBe(201);
  expect(f.core.state.runs).toEqual([]);
});
