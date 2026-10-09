import { describe, expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration, type Identity } from "./collaboration";
import { Coordinator, initialState } from "./coordinator";
import { resolveCatalog } from "./model-selection";
import { validateInvocation } from "./mentions";

const owner: Identity = { actor: "account:owner", email: "owner@example.com", username: "owner" };
const humanAgent: Identity = {
  actor: "account:human-agent",
  email: "human@example.com",
  username: "agent",
};
const catalog = resolveCatalog({ MODEL_CONFIGURATION: '{"provider":"fake"}' });
function fixture() {
  const core = new Coordinator(initialState(), () => {});
  new Collaboration(core, owner, owner.email).bootstrap();
  const thread = core.createThread(
    "Security boundary",
    "thread-security",
    owner.actor,
    owner.email,
  );
  core.updateCollaboration((state) => {
    state.collaboration!.projectMembers[humanAgent.actor] = { ...humanAgent, role: "editor" };
    state.collaboration!.threadMembers[thread.id][humanAgent.actor] = {
      ...humanAgent,
      role: "editor",
    };
  });
  const request = (app: ReturnType<typeof api>, body: unknown) =>
    app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { core, thread, request };
}
const span = (content: string) => ({
  start: content.indexOf("@agent"),
  end: content.indexOf("@agent") + 6,
});

describe("Agent/Team adversarial admission", () => {
  it("requires a separately selected exact reserved token and rejects forged token structure", () => {
    for (const content of ["@agent", "say @agent", "> @agent", "`@agent`", "paste @agent"])
      expect(validateInvocation(content, undefined, undefined).invokeAgent).toBe(false);
    for (const content of [
      "@Agent",
      "@agent_more",
      "email@agent",
      "\\@agent",
      "`@agent`",
      "    @agent",
      "```\n@agent\n```",
      "> @agent",
    ])
      expect(() => validateInvocation(content, "team", [span(content)])).toThrow(
        "invalid_agent_mentions",
      );
    for (const agentMentions of [
      null,
      {},
      [{ start: 0, end: 6, actor: owner.actor }],
      [{ start: 0, end: 6.5 }],
      [
        { start: 0, end: 6 },
        { start: 0, end: 6 },
      ],
    ])
      expect(() => validateInvocation("@agent", "team", agentMentions)).toThrow(
        "invalid_agent_mentions",
      );
    expect(() => validateInvocation("@agent", "Agent", [span("@agent")])).toThrow(
      "invalid_destination",
    );
    expect(validateInvocation("  ask @agent", "team", [{ start: 6, end: 12 }])).toEqual({
      destination: "team",
      agentMentions: [{ start: 4, end: 10 }],
      invokeAgent: true,
    });
  });

  it.each([
    "> quoted text\n@agent",
    "- > @agent",
    "1. > @agent",
    "> quoted text\ncontinued @agent",
    "- ```\n  @agent\n  ```",
    "1. ```\n   @agent\n   ```",
    "- ~~~\n  @agent\n  ~~~",
    "1. ~~~\n   @agent\n   ~~~",
  ])("rejects selected reserved tokens in Markdown quote context: %s", (content) => {
    expect(() => validateInvocation(content, "team", [span(content)])).toThrow(
      "invalid_agent_mentions",
    );
  });

  it("stores Team notes without reading provider catalog or dispatching and human username agent stays human", async () => {
    const f = fixture();
    let reads = 0,
      dispatches = 0;
    const app = api(
      f.core,
      () => {
        throw Error("execution_dispatch_forbidden");
      },
      undefined,
      owner,
      {
        get catalog(): typeof catalog {
          reads++;
          throw Error("provider_read_forbidden");
        },
        admit: async () => {
          throw Error("provider_admission_forbidden");
        },
        dispatch: () => {
          dispatches++;
        },
      },
      new Collaboration(f.core, owner, owner.email),
      true,
    );
    const response = await f.request(app, {
      content: "ask @agent",
      idempotencyKey: "human-mention",
      mentions: [{ actor: humanAgent.actor, start: 4, end: 10 }],
      actor: humanAgent.actor,
      credentialActor: humanAgent.actor,
      author: humanAgent,
      invokeAgent: true,
      run: { task: "forged" },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(f.core.state.messages.at(-1)).toMatchObject({
      destination: "team",
      author: owner,
      mentions: [{ actor: humanAgent.actor, username: "agent" }],
    });
    expect(f.core.state.conversationTurns ?? []).toHaveLength(0);
    expect(f.core.state.runs).toHaveLength(0);
    expect(reads).toBe(0);
    expect(dispatches).toBe(0);
  });

  it("binds note and invocation receipts to mode, spans, actor and thread across restart", async () => {
    const f = fixture();
    let core = f.core;
    const app = (identity = owner) =>
      api(
        core,
        () => {},
        undefined,
        identity,
        { catalog, dispatch: () => {} },
        new Collaboration(core, identity, owner.email),
        true,
      );
    const body = { content: "ask @agent", idempotencyKey: "same-key" };
    const first = await f.request(app(), body);
    expect(first.status).toBe(201);
    core = new Coordinator(structuredClone(core.state), () => {});
    const replay = await f.request(app(), { ...body, destination: "team", agentMentions: [] });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { id: string }).id).toBe(
      ((await first.json()) as { id: string }).id,
    );
    for (const intent of [{ destination: "agent" }, { agentMentions: [span(body.content)] }]) {
      const changed = await f.request(app(), { ...body, ...intent });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ error: "idempotency_conflict" });
    }
    const other = await f.request(app(humanAgent), { ...body, destination: "agent" });
    expect(other.status, await other.clone().text()).toBe(201);
    expect(core.state.messages).toHaveLength(2);
    expect(core.state.conversationTurns).toHaveLength(1);
    expect(core.state.conversationTurns?.[0]).toMatchObject({
      actor: humanAgent.actor,
      membershipActor: humanAgent.actor,
    });
    const second = core.createThread("Second", "second", owner.actor, owner.email);
    const mismatch = await app().request(`/api/threads/${second.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(mismatch.status).toBe(409);
  });

  it("admits one invocation for Agent plus multiple selected tokens and freezes payer and note cutoff", async () => {
    const f = fixture();
    const payer = { actor: "access:provider-owner" };
    const app = api(
      f.core,
      () => {},
      undefined,
      payer,
      { catalog, dispatch: () => {} },
      new Collaboration(f.core, owner, owner.email),
      true,
    );
    const send = (body: unknown) => f.request(app, body);
    expect((await send({ content: "before", idempotencyKey: "before" })).status).toBe(201);
    const body = {
      content: "@agent @agent",
      destination: "agent",
      agentMentions: [
        { start: 0, end: 6 },
        { start: 7, end: 13 },
      ],
      idempotencyKey: "invoke",
      credentialActor: humanAgent.actor,
      author: humanAgent,
    };
    const first = await send(body);
    expect(first.status, await first.clone().text()).toBe(201);
    expect((await send(body)).status).toBe(201);
    expect((await send({ content: "after", idempotencyKey: "after" })).status).toBe(201);
    expect(f.core.state.conversationTurns).toHaveLength(1);
    const turn = f.core.state.conversationTurns![0];
    expect(turn).toMatchObject({ actor: payer.actor, membershipActor: owner.actor });
    const input = f.core.beginConversation(turn.id)!;
    expect(input.credentialActor).toBe(payer.actor);
    expect(input.messages.map((message) => message.content)).toEqual(["before", body.content]);
    expect(f.core.state.runs).toHaveLength(0);
  });

  it("rechecks current membership after awaited provider admission before durable append", async () => {
    const f = fixture();
    const app = api(
      f.core,
      () => {},
      undefined,
      humanAgent,
      {
        catalog,
        admit: async () => {
          f.core.updateCollaboration((state) => {
            delete state.collaboration!.threadMembers[f.thread.id][humanAgent.actor];
          });
          return catalog;
        },
        dispatch: () => {},
      },
      new Collaboration(f.core, humanAgent, owner.email),
      true,
    );
    const response = await f.request(app, {
      content: "invoke",
      destination: "agent",
      idempotencyKey: "revoked",
    });
    expect(response.status).toBe(404);
    expect(f.core.state.messages).toHaveLength(0);
    expect(f.core.state.conversationTurns ?? []).toHaveLength(0);
  });
});
