import { expect, it } from "vite-plus/test";
import { agentTeamFixture, recipientEmail } from "./agent-team-harness";

type Fixture = Awaited<ReturnType<typeof agentTeamFixture>>;
async function grant(f: Fixture, threadId?: string) {
  const invitation = await f.owner(
    threadId
      ? `/threads/${threadId}/invitations`
      : `/projects/${f.ownedRepository.projectId}/invitations`,
    { recipient: recipientEmail, role: "editor" },
  );
  expect(invitation.status, await invitation.clone().text()).toBe(201);
  const value = (await invitation.json()) as { token: string };
  const accepted = await f.john(`/invitations/${value.token}/accept`, {});
  expect(accepted.status, await accepted.clone().text()).toBe(200);
}
async function credentialCalls(f: Fixture, actor: string) {
  const namespace = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
  const stub = namespace.get(namespace.idFromName(`openrouter:${actor}`)) as unknown as {
    fixtureCalls(): Promise<{ operation: string; actor: string }[]>;
  };
  return stub.fixtureCalls();
}
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error("synthetic_invocation_wait_timeout");
}

it("real password sessions keep raw Team text and malformed reserved spans outside provider admission", async () => {
  const f = await agentTeamFixture({ withProvider: false });
  try {
    const thread = await f.makeThread();
    const path = `/threads/${thread.id}/messages`;
    const before = await credentialCalls(f, f.issuerActor);
    for (const content of [
      "@agent pasted without selection",
      "`@agent`",
      "> @agent",
      'unclosed "quoted @agent',
    ]) {
      const response = await f.owner(path, {
        content,
        idempotencyKey: crypto.randomUUID(),
        credentialActor: f.recipientActor,
        actor: f.recipientActor,
        author: { actor: f.recipientActor, username: "forged" },
        invokeAgent: true,
      });
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({
        destination: "team",
        author: { actor: f.issuerActor },
      });
    }
    for (const content of [
      "> quoted\n@agent",
      "- > @agent",
      "```\n@agent\n```",
      'say "hello @agent"',
    ]) {
      const start = content.indexOf("@agent");
      const response = await f.owner(path, {
        content,
        idempotencyKey: crypto.randomUUID(),
        agentMentions: [{ start, end: start + 6 }],
      });
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_agent_mentions" });
    }
    expect(await credentialCalls(f, f.issuerActor)).toEqual(before);
    const attempted = await f.owner(path, {
      content: "explicit",
      destination: "agent",
      idempotencyKey: "missing-provider",
    });
    expect(attempted.status).toBe(409);
    expect(await attempted.json()).toMatchObject({ error: "provider_credential_unavailable" });
    const snapshot = await f.repository.invocationSnapshot(f.ownedRepository.projectId);
    expect(snapshot.messages).toHaveLength(4);
    expect(snapshot.turns).toHaveLength(0);
    expect(snapshot.runs).toHaveLength(0);
    expect(snapshot.modelCalls).toHaveLength(0);
    const unauthenticated = await f.owner(
      path,
      { content: "anonymous", destination: "agent", idempotencyKey: "anonymous" },
      { cookie: "" },
    );
    expect(unauthenticated.status).toBe(401);
    expect(
      (
        await f.john(path, {
          content: "nonmember",
          destination: "agent",
          idempotencyKey: "nonmember",
        })
      ).status,
    ).toBe(404);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("native accounts cannot replay another account's note or charge another account through spoofed message fields", async () => {
  const f = await agentTeamFixture();
  try {
    await grant(f);
    const thread = await f.makeThread();
    await grant(f, thread.id);
    const path = `/threads/${thread.id}/messages`;
    const key = "same-native-key";
    const note = await f.owner(path, { content: "owner private note", idempotencyKey: key });
    expect(note.status).toBe(201);
    const noteId = ((await note.json()) as { id: string }).id;
    const ownerCredentials = await credentialCalls(f, f.issuerActor);
    const invoked = await f.john(path, {
      content: "recipient explicit request",
      destination: "agent",
      idempotencyKey: key,
      credentialActor: f.issuerActor,
      payer: f.issuerActor,
      actor: f.issuerActor,
      membershipActor: f.issuerActor,
      author: { actor: f.issuerActor, username: "repository_owner" },
    });
    expect(invoked.status, await invoked.clone().text()).toBe(201);
    const receipt = (await invoked.json()) as {
      message: { id: string; author: { actor: string } };
      turn: { id: string; actor?: string };
    };
    expect(receipt.message.id).not.toBe(noteId);
    expect(receipt.message.author.actor).toBe(f.recipientActor);
    const saved = await waitFor(
      () => f.repository.invocationSnapshot(f.ownedRepository.projectId),
      (snapshot) => snapshot.turns.some((turn) => turn.status === "completed"),
    );
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]).toMatchObject({
      actor: f.recipientActor,
      membershipActor: f.recipientActor,
      input: { credentialActor: f.recipientActor },
    });
    expect(saved.modelCalls).toHaveLength(1);
    expect(saved.runs).toHaveLength(0);
    expect(await credentialCalls(f, f.issuerActor)).toEqual(ownerCredentials);
    expect(
      (await credentialCalls(f, f.recipientActor)).every((call) => call.actor === f.recipientActor),
    ).toBe(true);
    const delegate = await f.repository.tryDelegate(receipt.turn.id);
    expect(delegate).toMatchObject({ ok: false, error: "execution_disabled" });
    const replay = await f.john(path, {
      content: "recipient explicit request",
      destination: "agent",
      idempotencyKey: key,
    });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { message: { id: string } }).message.id).toBe(
      receipt.message.id,
    );
    await f.restart();
    const changed = await f.john(path, {
      content: "recipient explicit request",
      destination: "team",
      idempotencyKey: key,
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "idempotency_conflict" });
    const revoked = await f.owner(
      `/threads/${thread.id}/members/${encodeURIComponent(f.recipientActor)}`,
      undefined,
      {},
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await f.john(path, {
          content: "recipient explicit request",
          destination: "agent",
          idempotencyKey: key,
        })
      ).status,
    ).toBe(404);
    const final = await f.repository.invocationSnapshot(f.ownedRepository.projectId);
    expect(final.modelCalls).toHaveLength(1);
    expect(final.runs).toHaveLength(0);
  } finally {
    await f.mf.dispose();
  }
}, 90000);

it("memory-off native invocations have durable model/tool budgets and lose authority on original-session logout", async () => {
  const f = await agentTeamFixture();
  try {
    const thread = await f.makeThread();
    await f.repository.holdModel();
    const response = await f.owner(`/threads/${thread.id}/messages`, {
      content: "Hold synthetic answer",
      destination: "agent",
      idempotencyKey: "budget-authority",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { turn } = (await response.json()) as { turn: { id: string } };
    await waitFor(() => f.repository.modelEntered(), Boolean);
    const input = await f.repository.freshConversationMemory(turn.id);
    expect(input.memoryEnabled).toBeUndefined();
    for (let count = 0; count < 15; count++) {
      const requestId = crypto.randomUUID();
      await f.repository.authorizeConversationModel(turn.id, 1, 0, false, requestId);
      await f.repository.authorizeConversationModel(turn.id, 0, 1, true, requestId);
    }
    expect(await f.repository.conversationOperation(turn.id, "model")).toMatchObject({
      ok: false,
      error: "conversation_budget_exhausted",
    });
    for (let count = 0; count < 32; count++)
      await f.repository.authorizeConversationTool(turn.id, `bounded-tool-${count}`);
    // Retrying the same tool receipt does not consume a second admission.
    await f.repository.authorizeConversationTool(turn.id, "bounded-tool-0");
    expect(
      await f.repository.conversationOperation(turn.id, "tool", crypto.randomUUID()),
    ).toMatchObject({ ok: false, error: "conversation_budget_exhausted" });
    const logout = await f.owner("/auth/sign-out", {});
    expect(logout.status, await logout.clone().text()).toBe(200);
    expect(await f.repository.conversationOperation(turn.id, "fresh")).toMatchObject({ ok: false });
    await f.repository.releaseModel();
    const final = await waitFor(
      () => f.repository.invocationSnapshot(f.ownedRepository.projectId),
      (snapshot) => snapshot.turns[0]?.status === "failed",
    );
    expect(final.modelCalls).toHaveLength(1);
    expect(final.runs).toHaveLength(0);
    expect(
      final.messages.some((message) => message.content.startsWith("Synthetic Agent answer")),
    ).toBe(false);
    // Signing in again cannot make the revoked original turn/session authoritative.
    await f.login(f.personas.issuer.email, f.personas.issuer.username);
    expect(await f.repository.conversationOperation(turn.id, "fresh")).toMatchObject({ ok: false });
  } finally {
    await f.repository.releaseModel();
    await f.mf.dispose();
  }
}, 90000);

it("fresh native threads remain private and neither destinations nor agent-name collisions create memberships", async () => {
  const f = await agentTeamFixture();
  try {
    await grant(f);
    const renamed = await f.john("/auth/update-user", { username: "agent" });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const thread = await f.makeThread("Owner private thread");
    const path = `/threads/${thread.id}/messages`;
    const invitations = await (
      await f.owner(`/projects/${f.ownedRepository.projectId}/invitations`)
    ).json();
    const members = async () =>
      (await (await f.owner(`/threads/${thread.id}/members`)).json()) as { actor: string }[];
    expect((await members()).map((member) => member.actor)).toEqual([f.issuerActor]);
    expect((await f.john(path)).status).toBe(404);
    expect(
      (
        await f.john(path, {
          content: "project member only",
          destination: "agent",
          idempotencyKey: "project-only",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.owner(path, {
          content: "Hello @agent",
          destination: "team",
          idempotencyKey: "raw-human-label",
        })
      ).status,
    ).toBe(201);
    const invalidHumanPing = await f.owner(path, {
      content: "Hello @agent",
      destination: "team",
      idempotencyKey: "human-collision",
      mentions: [{ actor: f.recipientActor, start: 6, end: 12 }],
    });
    expect(invalidHumanPing.status).toBe(400);
    expect(await invalidHumanPing.json()).toMatchObject({ error: "invalid_mentions" });
    const invocation = await f.owner(path, {
      content: "Hello @agent",
      destination: "agent",
      idempotencyKey: "reserved-collision",
      agentMentions: [{ start: 6, end: 12 }],
    });
    expect(invocation.status, await invocation.clone().text()).toBe(201);
    await waitFor(
      () => f.repository.invocationSnapshot(f.ownedRepository.projectId),
      (snapshot) => snapshot.turns[0]?.status === "completed",
    );
    expect((await members()).map((member) => member.actor)).toEqual([f.issuerActor]);
    expect((await f.john(path)).status).toBe(404);
    expect(
      await (await f.owner(`/projects/${f.ownedRepository.projectId}/invitations`)).json(),
    ).toEqual(invitations);
    const created = await f.john(`/projects/${f.ownedRepository.projectId}/threads`, {
      title: "Recipient private thread",
      idempotencyKey: "recipient-private",
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const ownThread = (await created.json()) as { id: string };
    expect((await f.owner(`/threads/${ownThread.id}/messages`)).status).toBe(404);
    expect((await f.john(`/threads/${ownThread.id}/messages`)).status).toBe(200);
    await f.restart();
    expect((await f.john(path)).status).toBe(404);
    expect((await f.owner(`/threads/${ownThread.id}/messages`)).status).toBe(404);
  } finally {
    await f.mf.dispose();
  }
}, 90000);
