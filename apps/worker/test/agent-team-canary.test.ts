import { expect, it } from "vite-plus/test";
import { agentTeamFixture } from "./agent-team-harness";

type Fixture = Awaited<ReturnType<typeof agentTeamFixture>>;
const qwen = "qwen/qwen3.8-flash";
const body = (key: string) => ({
  content: "Explain synthetic notes",
  destination: "agent",
  idempotencyKey: key,
});
function policy(
  f: Fixture,
  threadId: string,
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
) {
  return {
    id: "synthetic-finite-trial",
    actor: f.issuerActor,
    projectId: f.ownedRepository.projectId,
    threadId,
    expiresAt,
    maxTurns: 2,
  };
}
async function send(f: Fixture, thread: string, key: string) {
  const response = await f.owner(`/threads/${thread}/messages`, body(key));
  return {
    status: response.status,
    value: (await response.json()) as { turn?: { id: string }; error?: string },
  };
}
async function waitFor(
  f: Fixture,
  predicate: (s: Awaited<ReturnType<Fixture["repository"]["invocationSnapshot"]>>) => boolean,
) {
  for (let i = 0; i < 400; i++) {
    const s = await f.repository.invocationSnapshot(f.ownedRepository.projectId);
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("synthetic_turn_timeout");
}
async function providerCalls(f: Fixture) {
  const ns = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
  const stub = ns.get(ns.idFromName(`openrouter:${f.issuerActor}`)) as unknown as {
    fixtureCalls(): Promise<unknown[]>;
  };
  return stub.fixtureCalls();
}

it("native canary admits only its immutable account/project/thread, charges exactly two concurrent turns, replays and survives restart without reset", async () => {
  for (const memoryEnabled of [false, true]) {
    const f = await agentTeamFixture({ model: qwen, memoryEnabled });
    try {
      const thread = await f.makeThread(),
        other = await f.makeThread();
      const p = policy(f, thread.id);
      await f.repository.canary(JSON.stringify(p));
      const before = await providerCalls(f);
      expect((await send(f, other.id, "wrong-thread")).status).toBe(403);
      await f.repository.canary(JSON.stringify({ ...p, projectId: "other-project" }));
      expect((await send(f, thread.id, "wrong-project")).status).toBe(403);
      await f.repository.canary(JSON.stringify({ ...p, actor: f.recipientActor }));
      expect((await send(f, thread.id, "wrong-account")).status).toBe(403);
      await f.repository.canary(JSON.stringify(p));
      expect(await providerCalls(f)).toEqual(before);
      const results = await Promise.all(
        ["one", "two", "three"].map((key) => send(f, thread.id, key)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 429]);
      const saved = await waitFor(
        f,
        (s) => s.turns.length === 2 && s.turns.every((t) => t.status === "completed"),
      );
      expect(saved.modelCalls).toHaveLength(2);
      const tools = (saved.modelCalls[0].options as { tools?: string[] }).tools ?? [];
      expect(tools).not.toContain("delegate_change");
      expect(tools.some((name) => name.includes("visualization"))).toBe(false);
      expect(tools.filter((name) => name.startsWith("memory_")).length).toBe(memoryEnabled ? 3 : 0);
      expect(saved.runs).toEqual([]);
      expect(
        saved.turns.every(
          (t) => t.models.repoAgent.modelId === "default" && t.models.repoAgent.effort === "off",
        ),
      ).toBe(true);
      expect(saved.turns.every((t) => !!t.input?.memoryEnabled === memoryEnabled)).toBe(true);
      expect((await f.repository.canarySnapshot()).receipts).toHaveLength(2);
      const admittedIndex = results.findIndex((r) => r.status === 201),
        key = ["one", "two", "three"][admittedIndex];
      expect((await send(f, thread.id, key)).value.turn?.id).toBe(
        results[admittedIndex].value.turn?.id,
      );
      const exhaustedCalls = await providerCalls(f);
      expect((await send(f, thread.id, "four")).status).toBe(429);
      expect(await providerCalls(f)).toEqual(exhaustedCalls);
      await f.repository.canary(undefined);
      expect((await send(f, thread.id, "removed-policy")).status).toBe(403);
      await f.repository.canary(JSON.stringify({ ...p, id: "new-id" }));
      expect((await send(f, thread.id, "changed-id")).status).toBe(403);
      await f.repository.canary(JSON.stringify({ ...p, maxTurns: 1 }));
      expect((await send(f, thread.id, "changed-policy")).status).toBe(403);
      await f.restart();
      expect((await send(f, thread.id, "removed-after-restart")).status).toBe(403);
      await f.repository.canary(JSON.stringify(p));
      expect((await send(f, thread.id, key)).value.turn?.id).toBe(
        results[admittedIndex].value.turn?.id,
      );
      expect((await send(f, thread.id, "restart-third")).status).toBe(429);
      expect((await f.repository.canarySnapshot()).receipts).toHaveLength(2);
      const note = await f.owner(`/threads/${other.id}/messages`, {
        content: "Pasted @agent remains a note",
        destination: "team",
        idempotencyKey: "team",
      });
      expect(note.status).toBe(201);
    } finally {
      await f.mf.dispose();
    }
  }
}, 90000);

it("empty/invalid canary and non-Qwen server configuration fail closed before provider reads while Team notes stay available", async () => {
  const f = await agentTeamFixture();
  try {
    const thread = await f.makeThread(),
      p = policy(f, thread.id);
    const before = await providerCalls(f);
    for (const raw of [
      "",
      "null",
      "{}",
      "invalid",
      JSON.stringify({ ...p, maxTurns: 3 }),
      JSON.stringify({ ...p, unexpected: true }),
      JSON.stringify(p),
    ]) {
      await f.repository.canary(raw);
      expect((await send(f, thread.id, crypto.randomUUID())).status).toBe(403);
    }
    expect(await providerCalls(f)).toEqual(before);
    expect((await f.repository.invocationSnapshot(f.ownedRepository.projectId)).turns).toEqual([]);
    expect(
      (
        await f.owner(`/threads/${thread.id}/messages`, {
          content: "@agent quoted mention",
          destination: "team",
          idempotencyKey: "note",
        })
      ).status,
    ).toBe(201);
    expect((await f.repository.canarySnapshot()).scopes).toHaveLength(1);
    await f.repository.canary(undefined);
    expect((await send(f, thread.id, "wrong-model-policy-removed")).status).toBe(403);
    expect(await providerCalls(f)).toEqual(before);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("unavailable provider failures consume durable canary quota and cannot be refunded by replay or restart", async () => {
  const f = await agentTeamFixture({ model: qwen, withProvider: false });
  try {
    const thread = await f.makeThread(),
      p = policy(f, thread.id);
    await f.repository.canary(JSON.stringify(p));
    const first = await send(f, thread.id, "failed-one");
    expect(first.status).toBe(201);
    expect((await send(f, thread.id, "failed-two")).status).toBe(201);
    await waitFor(f, (s) => s.turns.length === 2 && s.turns.every((t) => t.status === "failed"));
    expect((await send(f, thread.id, "failed-one")).value.turn?.id).toBe(first.value.turn?.id);
    expect((await send(f, thread.id, "failed-three")).status).toBe(429);
    await f.restart();
    await f.repository.canary(JSON.stringify(p));
    expect((await send(f, thread.id, "failed-four")).status).toBe(429);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(2);
    expect((await f.repository.invocationSnapshot(f.ownedRepository.projectId)).modelCalls).toEqual(
      [],
    );
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("pre-existing global queued turns lack receipts and are denied before provider lookup or child startup", async () => {
  const f = await agentTeamFixture({ model: qwen });
  try {
    const thread = await f.makeThread();
    const turnId = await f.repository.oldQueuedTurn(
      f.ownedRepository.projectId,
      thread.id,
      f.issuerActor,
    );
    await f.repository.canary(JSON.stringify(policy(f, thread.id)));
    const before = await providerCalls(f);
    await f.repository.resumeFixtureTurn(turnId);
    const saved = await waitFor(f, (s) => ["failed", "completed"].includes(s.turns[0]?.status));
    expect(saved.turns[0].status, JSON.stringify(saved)).toBe("failed");
    expect(saved.modelCalls).toEqual([]);
    expect(await providerCalls(f)).toEqual(before);
    expect((await f.repository.canarySnapshot()).receipts).toEqual([]);
    for (const kind of ["fresh", "model", "tool"] as const)
      expect(await f.repository.conversationOperation(turnId, kind)).toMatchObject({ ok: false });
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("logout revokes an admitted original session across model, tool, compressor and resume fences even after signing in again", async () => {
  const f = await agentTeamFixture({ model: qwen, memoryEnabled: true });
  try {
    const thread = await f.makeThread();
    await f.repository.canary(JSON.stringify(policy(f, thread.id)));
    await f.repository.holdModel();
    const first = await send(f, thread.id, "logout");
    await waitFor(f, (s) => s.modelCalls.length === 1);
    const turnId = first.value.turn!.id;
    expect((await f.owner("/auth/sign-out", {})).status).toBe(200);
    await f.login(f.personas.issuer.email);
    for (const kind of ["fresh", "model", "tool"] as const)
      expect(await f.repository.conversationOperation(turnId, kind)).toMatchObject({ ok: false });
    expect(await f.repository.compressionFence(turnId)).toMatchObject({ ok: false });
    expect(
      await f.repository.blockedCompression(turnId, f.ownedRepository.projectId),
    ).toMatchObject({ ok: false });
    await f.repository.releaseModel();
    await waitFor(f, (s) => s.turns[0]?.status === "failed");
    await f.repository.resumeFixtureTurn(turnId);
    expect(
      (await f.repository.invocationSnapshot(f.ownedRepository.projectId)).modelCalls,
    ).toHaveLength(1);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(1);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("actual expiry denies every further paid dispatch, tool, compressor and queued resume without resetting quota", async () => {
  const f = await agentTeamFixture({ model: qwen });
  try {
    const thread = await f.makeThread(),
      p = policy(f, thread.id, new Date(Date.now() + 2500).toISOString());
    await f.repository.canary(JSON.stringify(p));
    await f.repository.holdModel();
    const first = await send(f, thread.id, "expiry-one");
    expect(first.status).toBe(201);
    await waitFor(f, (s) => s.modelCalls.length === 1);
    const second = await send(f, thread.id, "expiry-two");
    expect(second.status).toBe(201);
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(p.expiresAt) - Date.now() + 50)));
    const before = await providerCalls(f);
    expect((await send(f, thread.id, "expired-third")).status).toBe(403);
    for (const kind of ["fresh", "model", "tool"] as const)
      expect(await f.repository.conversationOperation(first.value.turn!.id, kind)).toMatchObject({
        ok: false,
      });
    expect(await f.repository.compressionFence(first.value.turn!.id)).toMatchObject({ ok: false });
    expect(
      await f.repository.blockedCompression(first.value.turn!.id, f.ownedRepository.projectId),
    ).toMatchObject({ ok: false });
    await f.repository.releaseModel();
    await waitFor(f, (s) => s.turns.every((t) => t.status === "failed"));
    expect(
      (await f.repository.invocationSnapshot(f.ownedRepository.projectId)).modelCalls,
    ).toHaveLength(1);
    expect(await providerCalls(f)).toEqual(before);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(2);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("canary receipt remains valid at quota exhaustion while existing per-turn main/tool/memory budgets still stop dispatch", async () => {
  for (const memoryEnabled of [false, true]) {
    const f = await agentTeamFixture({ model: qwen, memoryEnabled });
    try {
      const thread = await f.makeThread();
      await f.repository.canary(JSON.stringify(policy(f, thread.id)));
      await f.repository.holdModel();
      const first = await send(f, thread.id, "budget-one");
      await waitFor(f, (s) => s.modelCalls.length === 1);
      expect((await send(f, thread.id, "budget-two")).status).toBe(201);
      const turnId = first.value.turn!.id;
      expect(await f.repository.compressionFence(turnId)).toMatchObject({ ok: true });
      expect(await f.repository.nativeImageFence(turnId)).toMatchObject({
        ok: false,
        error: "conversation_canary_denied",
      });
      expect(await f.repository.forbiddenVisualization(turnId)).toMatchObject({
        ok: false,
        error: "conversation_canary_denied",
      });
      if (memoryEnabled) {
        const memory = await f.repository.memorySnapshot();
        expect(memory.repo_memory_turns).toHaveLength(1);
        expect(
          JSON.parse((memory.repo_memory_turns[0] as { limits: string }).limits).maxCompressions,
        ).toBe(4);
      }
      // Pending initial request owns 16KiB; each synthetic request immediately
      // settles its own reservation, proving the durable 16-main-call ceiling.
      for (let i = 0; i < 15; i++) {
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
      for (let i = 0; i < 32; i++)
        expect(
          await f.repository.conversationOperation(turnId, "tool", `budget:${i}`),
        ).toMatchObject({ ok: true });
      expect(
        await f.repository.conversationOperation(turnId, "tool", "budget:overflow"),
      ).toMatchObject({ ok: false, error: "conversation_budget_exhausted" });
      expect((await send(f, thread.id, "budget-three")).status).toBe(429);
      expect(await f.repository.tryDelegate(turnId)).toMatchObject({
        ok: false,
        error: "execution_disabled",
      });
      await f.repository.releaseModel();
    } finally {
      await f.mf.dispose();
    }
  }
}, 90000);

it("native memory-off shared destination hides the sender's private sibling knowledge and active intent while preserving destination context", async () => {
  const f = await agentTeamFixture({ model: qwen });
  try {
    const hidden = await f.makeThread("Private sibling"),
      target = await f.makeThread("Shared target");
    for (const path of [
      `/projects/${f.ownedRepository.projectId}/invitations`,
      `/threads/${target.id}/invitations`,
    ]) {
      const invited = await f.owner(path, { recipient: "@johncena", role: "editor" });
      expect(invited.status).toBe(201);
      expect(
        (
          await f.john(
            `/invitations/${((await invited.json()) as { token: string }).token}/accept`,
            {},
          )
        ).status,
      ).toBe(200);
    }
    const unscoped = await f.repository.seedScopedContext(
      f.ownedRepository.projectId,
      hidden.id,
      f.issuerActor,
      "PRIVATE_SIBLING",
    );
    expect(JSON.stringify(unscoped)).toContain("PRIVATE_SIBLING_KNOWLEDGE");
    expect(JSON.stringify(unscoped)).toContain("PRIVATE_SIBLING_ACTIVE_INTENT");
    await f.repository.seedScopedContext(
      f.ownedRepository.projectId,
      target.id,
      f.issuerActor,
      "DESTINATION",
    );
    expect((await f.john(`/threads/${hidden.id}/messages`)).status).toBe(404);
    await f.repository.canary(JSON.stringify(policy(f, target.id)));
    expect((await f.john(`/threads/${target.id}/messages`, body("non-target-member"))).status).toBe(
      403,
    );
    expect((await send(f, target.id, "privacy")).status).toBe(201);
    const saved = await waitFor(f, (s) => s.turns[0]?.status === "completed");
    expect(saved.turns[0].input?.memoryEnabled).toBeUndefined();
    expect(JSON.stringify(saved.turns[0].input)).not.toContain("PRIVATE_SIBLING");
    expect(JSON.stringify(saved.turns[0].input?.repositoryContext)).toContain(
      "DESTINATION_KNOWLEDGE",
    );
    expect(JSON.stringify(saved.turns[0].input?.repositoryContext)).toContain(
      "DESTINATION_ACTIVE_INTENT",
    );
    expect(JSON.stringify(saved.modelCalls)).not.toContain("PRIVATE_SIBLING");
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("first inspected valid policy latches before acceptance so removal or retargeting cannot open global mode", async () => {
  const f = await agentTeamFixture({ model: qwen });
  try {
    const target = await f.makeThread(),
      other = await f.makeThread(),
      p = policy(f, target.id);
    await f.repository.canary(JSON.stringify(p));
    expect((await send(f, other.id, "initial-non-target")).status).toBe(403);
    expect((await f.repository.canarySnapshot()).receipts).toEqual([]);
    expect((await f.repository.canarySnapshot()).scopes).toHaveLength(1);
    const before = await providerCalls(f);
    await f.repository.canary(undefined);
    expect((await send(f, other.id, "removed-before-first")).status).toBe(403);
    await f.repository.canary(JSON.stringify({ ...p, id: "new-before-first", threadId: other.id }));
    expect((await send(f, other.id, "changed-before-first")).status).toBe(403);
    expect(await providerCalls(f)).toEqual(before);
    await f.repository.canary(JSON.stringify(p));
    expect((await send(f, target.id, "first-accepted")).status).toBe(201);
    await waitFor(f, (s) => s.turns[0]?.status === "completed");
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("historical native image blocks are denied before canary provider dispatch even when the new message is text-only", async () => {
  const f = await agentTeamFixture({ model: qwen });
  try {
    const thread = await f.makeThread();
    await f.repository.historicalImage(f.ownedRepository.projectId, thread.id, f.issuerActor);
    await f.repository.canary(JSON.stringify(policy(f, thread.id)));
    expect((await send(f, thread.id, "text-after-image")).status).toBe(201);
    const saved = await waitFor(f, (s) => s.turns[1]?.status === "failed");
    expect(saved.turns[1].input?.messages.some((m) => m.attachments?.length)).toBe(true);
    expect(saved.modelCalls).toHaveLength(0);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(1);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("expiry while provider readiness yields denies child admission before getAgentByName stores any input", async () => {
  const f = await agentTeamFixture({ model: qwen });
  try {
    const thread = await f.makeThread();
    const credentials = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
    const credentialStub = credentials.get(
      credentials.idFromName(`openrouter:${f.issuerActor}`),
    ) as unknown as { delayConfigured(milliseconds: number): Promise<void> };
    await credentialStub.delayConfigured(2000);
    await f.repository.canary(
      JSON.stringify(policy(f, thread.id, new Date(Date.now() + 1000).toISOString())),
    );
    const first = await send(f, thread.id, "expire-during-readiness");
    expect(first.status).toBe(201);
    const saved = await waitFor(f, (s) => s.turns[0]?.status === "failed");
    expect(saved.modelCalls).toEqual([]);
    expect((await f.repository.canarySnapshot()).receipts).toHaveLength(1);
    const conversations = await f.mf.getDurableObjectNamespace("CONVERSATION");
    const child = conversations.get(
      conversations.idFromName(`repo:${f.ownedRepository.projectId}:${first.value.turn!.id}`),
    ) as unknown as { savedInput(): Promise<boolean> };
    expect(await child.savedInput()).toBe(false);
  } finally {
    await f.mf.dispose();
  }
}, 90000);
