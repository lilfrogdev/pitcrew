import { expect, it } from "vite-plus/test";
import { agentTeamFixture } from "./agent-team-harness";

type Fixture = Awaited<ReturnType<typeof agentTeamFixture>>;
async function share(f: Fixture, threadId: string) {
  for (const path of [
    `/projects/${f.ownedRepository.projectId}/invitations`,
    `/threads/${threadId}/invitations`,
  ]) {
    const response = await f.owner(path, { recipient: "@johncena", role: "editor" });
    expect(response.status, await response.clone().text()).toBe(201);
    const value = (await response.json()) as { token: string };
    expect((await f.john(`/invitations/${value.token}/accept`, {})).status).toBe(200);
  }
}
async function send(f: Fixture, threadId: string, body: unknown, recipient = false) {
  const response = await (recipient ? f.john : f.owner)(`/threads/${threadId}/messages`, body);
  return {
    status: response.status,
    value: (await response.json()) as {
      message?: { id: string };
      turn?: { id: string };
      id?: string;
      error?: string;
    },
  };
}
async function snapshot(f: Fixture) {
  return f.repository.invocationSnapshot(f.ownedRepository.projectId);
}
async function waitFor(
  f: Fixture,
  predicate: (s: Awaited<ReturnType<typeof snapshot>>) => boolean,
) {
  for (let i = 0; i < 400; i++) {
    const state = await snapshot(f);
    if (predicate(state)) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("Local synthetic conversation did not reach its expected durable state");
}

it("two native accounts send Team notes without inference, invoke once, and recover intent-bound receipts after restart", async () => {
  const f = await agentTeamFixture({ memoryEnabled: true });
  try {
    const thread = await f.makeThread("Agent Team native receipt");
    await share(f, thread.id);
    for (const [i, content] of [
      "Ordinary Team note",
      "Pasted @agent",
      "> Quoted @agent",
      "`@agent` code",
      "@johncena human mention",
    ].entries()) {
      const mentions = i === 4 ? [{ actor: f.recipientActor, start: 0, end: 9 }] : [];
      expect(
        (
          await send(
            f,
            thread.id,
            { content, idempotencyKey: `team-${i}`, destination: "team", mentions },
            i === 1,
          )
        ).status,
      ).toBe(201);
    }
    expect(await snapshot(f)).toMatchObject({ turns: [], runs: [], modelCalls: [] });
    expect(await f.repository.memorySnapshot()).toEqual({});
    const body = {
      content: "@agent @agent explain the saved notes",
      idempotencyKey: "one-invocation",
      destination: "agent",
      agentMentions: [
        { start: 0, end: 6 },
        { start: 7, end: 13 },
      ],
    };
    const first = await send(f, thread.id, body, true);
    expect(first.status, JSON.stringify(first.value)).toBe(201);
    expect(first.value.turn).toBeDefined();
    const completed = await waitFor(f, (s) => s.turns.some((t) => t.status === "completed"));
    expect(completed.turns).toHaveLength(1);
    expect(completed.runs).toEqual([]);
    expect(completed.modelCalls).toHaveLength(1);
    expect(completed.turns[0].input?.credentialActor).toBe(f.recipientActor);
    expect(completed.turns[0].actor).toBe(f.recipientActor);
    expect(await f.repository.tryDelegate(first.value.turn!.id)).toMatchObject({
      ok: false,
      error: "execution_disabled",
    });
    await f.restart();
    const replay = await send(f, thread.id, body, true);
    expect(replay.status).toBe(201);
    expect(replay.value.message?.id).toBe(first.value.message?.id);
    expect(replay.value.turn?.id).toBe(first.value.turn?.id);
    expect(
      (await send(f, thread.id, { ...body, destination: "team", agentMentions: [] }, true)).status,
    ).toBe(409);
    const after = await snapshot(f);
    expect(after.turns).toHaveLength(1);
    expect(after.modelCalls).toHaveLength(1);
    expect(after.runs).toEqual([]);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("provider absence and disabled conversation reject only explicit invocation while retaining Team notes", async () => {
  for (const options of [{ withProvider: false }, { conversationEnabled: false }]) {
    const f = await agentTeamFixture(options);
    try {
      const thread = await f.makeThread("Disabled provider Team");
      const note = await send(f, thread.id, {
        content: "Keep my draft and save this note",
        idempotencyKey: "note",
        destination: "team",
      });
      expect(note.status).toBe(201);
      const agent = await send(f, thread.id, {
        content: "Explain",
        idempotencyKey: "agent",
        destination: "agent",
      });
      expect(agent.status).toBeGreaterThanOrEqual(400);
      const teamAgent = await send(f, thread.id, {
        content: "@agent explain",
        idempotencyKey: "mention",
        destination: "team",
        agentMentions: [{ start: 0, end: 6 }],
      });
      expect(teamAgent.status).toBeGreaterThanOrEqual(400);
      expect(await snapshot(f)).toMatchObject({ turns: [], runs: [], modelCalls: [] });
    } finally {
      await f.mf.dispose();
    }
  }
}, 90000);

it("Team posts during an active main turn wait for the next invocation instead of steering its frozen context", async () => {
  const f = await agentTeamFixture({ memoryEnabled: true });
  try {
    const thread = await f.makeThread("Frozen active Agent context");
    await share(f, thread.id);
    await f.repository.holdModel();
    const first = await send(f, thread.id, {
      content: "Explain the current note",
      destination: "agent",
      idempotencyKey: "first",
    });
    expect(first.status, JSON.stringify(first.value)).toBe(201);
    for (let i = 0; i < 400 && !(await f.repository.modelEntered()); i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(await f.repository.modelEntered()).toBe(true);
    const note = await send(
      f,
      thread.id,
      {
        content: "FUTURE_TEAM_NOTE: prefer explicit Save changes",
        destination: "team",
        idempotencyKey: "future-note",
      },
      true,
    );
    expect(note.status).toBe(201);
    await f.repository.releaseModel();
    const frozen = await waitFor(f, (s) => s.turns[0]?.status === "completed");
    expect(JSON.stringify(frozen.modelCalls[0].messages)).not.toContain("FUTURE_TEAM_NOTE");
    expect(frozen.turns).toHaveLength(1);
    expect(frozen.runs).toEqual([]);
    const next = await send(f, thread.id, {
      content: "Recall the preferences",
      destination: "agent",
      idempotencyKey: "next",
    });
    expect(next.status).toBe(201);
    const second = await waitFor(
      f,
      (s) => s.turns.length === 2 && s.turns[1].status === "completed",
    );
    expect(JSON.stringify(second.modelCalls[1].messages)).toContain("FUTURE_TEAM_NOTE");
    expect(second.modelCalls).toHaveLength(2);
    expect(second.runs).toEqual([]);
  } finally {
    await f.repository.releaseModel();
    await f.mf.dispose();
  }
}, 90000);
