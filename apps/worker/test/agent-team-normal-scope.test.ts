import { expect, it } from "vite-plus/test";
import { agentTeamFixture, readyCreation } from "./agent-team-harness";

type Fixture = Awaited<ReturnType<typeof agentTeamFixture>>;
const body = (key: string) => ({
  content: "Explain synthetic notes",
  destination: "agent",
  idempotencyKey: key,
});
const policy = (f: Fixture, actor = f.issuerActor) => ({
  id: "synthetic-normal-interactive",
  actor,
  projectId: f.ownedRepository.projectId,
});
async function send(f: Fixture, threadId: string, key: string, recipient = false) {
  const response = await (recipient ? f.john : f.owner)(`/threads/${threadId}/messages`, body(key));
  return { status: response.status, value: (await response.json()) as { turn?: { id: string } } };
}
async function waitFor(
  f: Fixture,
  predicate: (s: Awaited<ReturnType<Fixture["repository"]["invocationSnapshot"]>>) => boolean,
) {
  for (let i = 0; i < 400; i++) {
    const s = await f.repository.invocationSnapshot(f.ownedRepository.projectId);
    if (predicate(s)) return s;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error("synthetic_normal_timeout");
}
async function calls(f: Fixture, actor: string) {
  const ns = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
  return (
    ns.get(ns.idFromName(`openrouter:${actor}`)) as unknown as {
      fixtureCalls(): Promise<unknown[]>;
    }
  ).fixtureCalls();
}
async function share(f: Fixture, threadId: string) {
  for (const path of [
    `/projects/${f.ownedRepository.projectId}/invitations`,
    `/threads/${threadId}/invitations`,
  ]) {
    const response = await f.owner(path, { recipient: "@johncena", role: "editor" });
    if (path.startsWith("/projects/") && response.status === 409) continue;
    expect(response.status).toBe(201);
    expect(
      (
        await f.john(
          `/invitations/${((await response.json()) as { token: string }).token}/accept`,
          {},
        )
      ).status,
    ).toBe(200);
  }
}

it("normal scope permits more than two native interactive turns and multiple authorized threads with memory, replay and restart", async () => {
  const f = await agentTeamFixture({ memoryEnabled: true });
  try {
    const a = await f.makeThread(),
      b = await f.makeThread(),
      p = policy(f);
    await f.repository.normalScope(JSON.stringify(p));
    const first = await send(f, a.id, "normal-0");
    expect(first.status).toBe(201);
    await waitFor(f, (s) => s.turns.length === 1 && s.turns[0].status === "completed");
    for (let i = 1; i < 5; i++) {
      expect((await send(f, i % 2 ? b.id : a.id, `normal-${i}`)).status).toBe(201);
      await waitFor(
        f,
        (s) => s.turns.length === i + 1 && s.turns.every((t) => t.status === "completed"),
      );
    }
    expect((await send(f, a.id, "normal-0")).value.turn?.id).toBe(first.value.turn?.id);
    await f.restart();
    await f.repository.normalScope(JSON.stringify(p));
    expect((await send(f, a.id, "normal-5")).status).toBe(201);
    const saved = await waitFor(
      f,
      (s) => s.turns.length === 6 && s.turns.every((t) => t.status === "completed"),
    );
    expect(
      saved.turns.every(
        (t) =>
          t.input?.memoryEnabled &&
          t.input.credentialActor === f.issuerActor &&
          t.normalConversationScopeId === p.id,
      ),
    ).toBe(true);
    expect(saved.turns.every((t) => t.models.repoAgent.modelId === "default")).toBe(true); // Existing non-Qwen catalog remains usable.
    expect(saved.modelCalls).toHaveLength(6);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(6);
    expect(saved.runs).toEqual([]);
    const tools = (saved.modelCalls[0].options as { tools: string[] }).tools;
    expect(tools.filter((name) => name.startsWith("memory_"))).toHaveLength(3);
    expect(tools.some((name) => name.includes("visualization") || name === "delegate_change")).toBe(
      false,
    );
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("authenticated own-turn Stop durably cancels queued/running work, rejects observers and wrong threads, and prevents replies or resumes", async () => {
  const f = await agentTeamFixture({ memoryEnabled: true });
  try {
    const thread = await f.makeThread(),
      other = await f.makeThread();
    await share(f, thread.id);
    await share(f, other.id);
    await f.repository.normalScope(JSON.stringify(policy(f, f.recipientActor)));
    await f.repository.holdModel();
    const first = await send(f, thread.id, "stop-running", true);
    expect(first.status).toBe(201);
    await waitFor(f, (s) => s.modelCalls.length === 1);
    const queued = await send(f, thread.id, "stop-queued", true);
    expect(queued.status).toBe(201);
    const turnId = first.value.turn!.id,
      queuedId = queued.value.turn!.id;
    const route = `/threads/${thread.id}/turns/${turnId}/stop`;
    const ownerTurns = await f.owner(`/threads/${thread.id}/turns`),
      ownTurns = await f.john(`/threads/${thread.id}/turns`);
    expect(((await ownerTurns.json()) as { canStop: boolean }[]).every((t) => !t.canStop)).toBe(
      true,
    );
    expect(((await ownTurns.json()) as { canStop: boolean }[]).every((t) => t.canStop)).toBe(true);
    expect((await f.owner(route, {})).status).toBe(404);
    expect((await f.john(`/threads/${other.id}/turns/${turnId}/stop`, {})).status).toBe(404);
    expect((await f.john(route, { actor: f.recipientActor })).status).toBe(400);
    const queuedStop = await f.john(`/threads/${thread.id}/turns/${queuedId}/stop`, {});
    expect(queuedStop.status).toBe(200);
    expect(await queuedStop.json()).toMatchObject({
      id: queuedId,
      status: "failed",
      error: "conversation_cancelled",
      canStop: false,
    });
    const stopped = f.john(route, {});
    await waitFor(f, (s) => s.turns[0]?.error === "conversation_cancelled");
    await f.repository.releaseModel();
    const response = await stopped;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: turnId,
      status: "failed",
      error: "conversation_cancelled",
      canStop: false,
    });
    expect((await f.john(route, {})).status).toBe(200);
    for (const id of [turnId, queuedId]) {
      expect(await f.repository.conversationOperation(id, "fresh")).toMatchObject({ ok: false });
      await f.repository.resumeFixtureTurn(id);
    }
    const saved = await f.repository.invocationSnapshot(f.ownedRepository.projectId);
    expect(saved.turns.every((t) => t.error === "conversation_cancelled")).toBe(true);
    expect(saved.modelCalls).toHaveLength(1);
    expect(saved.messages.some((m) => m.content.startsWith("Synthetic Agent answer"))).toBe(false);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("normal scope rejects another authorized account and another authorized project before provider reads; notes remain available", async () => {
  const f = await agentTeamFixture();
  try {
    const thread = await f.makeThread();
    await share(f, thread.id);
    const other = await readyCreation(
      f,
      await f.create("synthetic-other-normal", f.personas.issuer.email),
      "synthetic-other-normal",
      f.personas.issuer.email,
    );
    const otherThread = await f.owner(`/projects/${other.projectId}/threads`, {
      title: "Other project",
      idempotencyKey: "other-thread",
    });
    expect(otherThread.status).toBe(201);
    const otherThreadId = ((await otherThread.json()) as { id: string }).id;
    await f.repository.normalScope(JSON.stringify(policy(f)));
    const ownerBefore = await calls(f, f.issuerActor),
      recipientBefore = await calls(f, f.recipientActor);
    expect((await send(f, thread.id, "other-account", true)).status).toBe(403);
    expect((await send(f, otherThreadId, "other-project")).status).toBe(403);
    expect(await calls(f, f.issuerActor)).toEqual(ownerBefore);
    expect(await calls(f, f.recipientActor)).toEqual(recipientBefore);
    expect(
      (
        await f.john(`/threads/${thread.id}/messages`, {
          content: "@agent is quoted text",
          destination: "team",
          idempotencyKey: "normal-note",
        })
      ).status,
    ).toBe(201);
    expect((await f.repository.invocationSnapshot(f.ownedRepository.projectId)).modelCalls).toEqual(
      [],
    );
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("normal policy is strict, mutually exclusive with finite mode and latched against removal, retargeting or profile reset", async () => {
  const f = await agentTeamFixture();
  try {
    const thread = await f.makeThread(),
      p = policy(f),
      before = await calls(f, f.issuerActor);
    for (const raw of [
      "",
      "null",
      "{}",
      JSON.stringify({ ...p, maxTurns: 2 }),
      JSON.stringify({ ...p, actor: "typed-email@example.com" }),
    ]) {
      await f.repository.normalScope(raw);
      expect((await send(f, thread.id, crypto.randomUUID())).status).toBe(403);
    }
    await f.repository.normalScope(JSON.stringify(p));
    await f.repository.canary("");
    expect((await send(f, thread.id, "both-profiles")).status).toBe(403);
    await f.repository.canary(undefined);
    expect((await send(f, thread.id, "armed-normal")).status).toBe(201);
    await waitFor(f, (s) => s.turns[0]?.status === "completed");
    await f.repository.normalScope(undefined);
    expect((await send(f, thread.id, "removed-normal")).status).toBe(403);
    await f.repository.normalScope(JSON.stringify({ ...p, id: "replacement" }));
    expect((await send(f, thread.id, "retarget-normal")).status).toBe(403);
    await f.repository.normalScope(undefined);
    await f.repository.canary(
      JSON.stringify({
        ...p,
        threadId: thread.id,
        maxTurns: 2,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    expect((await send(f, thread.id, "reset-as-finite")).status).toBe(403);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(1);
    expect((await calls(f, f.issuerActor)).length).toBeGreaterThan(before.length);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("failed normal turns, idempotent replay and restart create no lifetime admission quota", async () => {
  const f = await agentTeamFixture({ withProvider: false });
  try {
    const thread = await f.makeThread(),
      p = policy(f);
    await f.repository.normalScope(JSON.stringify(p));
    const first = await send(f, thread.id, "normal-fail-0");
    for (let i = 1; i < 4; i++)
      expect((await send(f, thread.id, `normal-fail-${i}`)).status).toBe(201);
    await waitFor(f, (s) => s.turns.length === 4 && s.turns.every((t) => t.status === "failed"));
    expect((await send(f, thread.id, "normal-fail-0")).value.turn?.id).toBe(first.value.turn?.id);
    await f.restart();
    await f.repository.normalScope(JSON.stringify(p));
    expect((await send(f, thread.id, "normal-fail-4")).status).toBe(201);
    const saved = await waitFor(
      f,
      (s) => s.turns.length === 5 && s.turns.every((t) => t.status === "failed"),
    );
    expect(saved.modelCalls).toEqual([]);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(5);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("normal response keeps 16 main-call budget, supports native input and denies coding/publication", async () => {
  const f = await agentTeamFixture();
  try {
    const thread = await f.makeThread();
    await f.repository.normalScope(JSON.stringify(policy(f)));
    await f.repository.holdModel();
    const first = await send(f, thread.id, "normal-budget");
    await waitFor(f, (s) => s.modelCalls.length === 1);
    const turnId = first.value.turn!.id;
    // A normal turn keeps the existing model's native-input allowance.
    expect(await f.repository.nativeImageFence(turnId)).toMatchObject({ ok: true });
    for (let i = 0; i < 14; i++) {
      const id = crypto.randomUUID();
      expect(await f.repository.conversationOperation(turnId, "model", id)).toMatchObject({
        ok: true,
      });
      await f.repository.settleFixtureModel(turnId, id);
    }
    expect(await f.repository.conversationOperation(turnId, "model")).toMatchObject({
      ok: false,
      error: "conversation_budget_exhausted",
    });
    expect(await f.repository.tryDelegate(turnId)).toMatchObject({
      ok: false,
      error: "execution_disabled",
    });
    expect(await f.repository.forbiddenVisualization(turnId)).toMatchObject({ ok: false });
    await f.repository.releaseModel();
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("normal original sessions, current ACL and child cancellation remain authoritative", async () => {
  for (const revoke of ["logout", "membership", "stop"] as const) {
    const f = await agentTeamFixture({ memoryEnabled: true });
    try {
      const thread = await f.makeThread();
      await share(f, thread.id);
      await f.repository.normalScope(JSON.stringify(policy(f, f.recipientActor)));
      await f.repository.holdModel();
      const first = await send(f, thread.id, `normal-${revoke}`, true);
      expect(first.status).toBe(201);
      await waitFor(f, (s) => s.modelCalls.length === 1);
      const turnId = first.value.turn!.id;
      if (revoke === "logout") {
        expect((await f.john("/auth/sign-out", {})).status).toBe(200);
        await f.login(f.personas.recipient.email);
      } else if (revoke === "membership") {
        expect(
          (
            await f.owner(
              `/threads/${thread.id}/members/${encodeURIComponent(f.recipientActor)}`,
              undefined,
              {},
              "DELETE",
            )
          ).status,
        ).toBe(200);
      } else {
        const ns = await f.mf.getDurableObjectNamespace("CONVERSATION");
        const child = ns.get(
          ns.idFromName(`repo:${f.ownedRepository.projectId}:${turnId}`),
        ) as unknown as { stop(id: string): Promise<void> };
        const stopped = child.stop(turnId);
        await f.repository.releaseModel();
        await stopped;
        await waitFor(f, (s) => s.turns[0]?.status === "failed");
      }
      for (const kind of ["fresh", "tool", "model"] as const)
        expect(await f.repository.conversationOperation(turnId, kind)).toMatchObject({ ok: false });
      await f.repository.releaseModel();
      await waitFor(f, (s) => s.turns[0]?.status === "failed");
      await f.repository.resumeFixtureTurn(turnId);
      expect(
        (await f.repository.invocationSnapshot(f.ownedRepository.projectId)).modelCalls,
      ).toHaveLength(1);
    } finally {
      await f.mf.dispose();
    }
  }
}, 90000);
