import { describe, expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration, type Identity } from "./collaboration";
import { Coordinator, initialState } from "./coordinator";
import { resolveCatalog } from "./model-selection";
import type { Message, SubmittedMention } from "@pitcrew/protocol";
const owner: Identity = { actor: "account:owner", email: "owner@example.com", username: "owner" };
const john: Identity = { actor: "account:john", email: "john@example.com", username: "johncena" };
const alice: Identity = { actor: "account:alice", email: "alice@example.com", username: "alice" };
function fixture(mode: "note" | "conversation" | "execution" = "note") {
  let saved = initialState();
  const core = new Coordinator(saved, (state) => {
    saved = structuredClone(state);
  });
  const access = new Collaboration(core, owner, owner.email);
  access.bootstrap();
  const thread = core.createThread("Shared", "shared", owner.actor, owner.email);
  const privateThread = core.createThread("Private", "private", owner.actor, owner.email);
  core.updateCollaboration((state) => {
    for (const identity of [john, alice]) {
      state.collaboration!.projectMembers[identity.actor] = { ...identity, role: "editor" };
      state.collaboration!.threadMembers[thread.id][identity.actor] = {
        ...identity,
        role: "editor",
      };
    }
  });
  const make = (identity = owner, authority?: Parameters<typeof api>[11]) =>
    api(
      core,
      () => {},
      undefined,
      identity,
      mode === "conversation"
        ? {
            catalog: resolveCatalog({ MODEL_CONFIGURATION: '{"provider":"fake"}' }),
            dispatch: () => {},
          }
        : undefined,
      new Collaboration(core, identity, owner.email),
      mode === "note",
      undefined,
      undefined,
      undefined,
      undefined,
      authority,
    );
  const post = (body: Record<string, unknown>, app = make(), id = thread.id) =>
    app.request(`/api/threads/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { core, saved: () => saved, thread, privateThread, access, make, post };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const mention = { actor: john.actor, start: 0, end: 9 };
describe("durable actor mentions", () => {
  for (const mode of ["note", "conversation", "execution"] as const) {
    it(`${mode}: validates, preserves multiple mentions, reloads and deduplicates retries`, async () => {
      const f = fixture(mode);
      const content = "  @JohnCENA and @alice then @johncena unknown @outsider  ";
      const refs: SubmittedMention[] = [
        { ...mention, start: 2, end: 11 },
        { actor: alice.actor, start: 16, end: 22 },
        { ...mention, start: 28, end: 37 },
      ];
      const body = { content, mentions: refs, idempotencyKey: "same" };
      const first = await f.post(body);
      expect(first.status, await first.clone().text()).toBe(201);
      const stored = f.core.state.messages.at(-1)!;
      expect(stored.content).toBe(content.trim());
      expect(stored.mentions).toEqual(
        refs.map((ref) => ({
          ...ref,
          start: ref.start - 2,
          end: ref.end - 2,
          username: ref.actor === john.actor ? "johncena" : "alice",
        })),
      );
      const second = await f.post(body);
      expect(second.status).toBe(201);
      expect(f.core.state.messages).toHaveLength(1);
      expect(f.core.state.events.filter((event) => event.type === "message.created")).toHaveLength(
        1,
      );
      expect(new Coordinator(f.saved(), () => {}).state.messages[0]).toEqual(stored);
      const forgedRetry = await f.post({ ...body, mentions: [{ ...refs[0], actor: alice.actor }] });
      expect(forgedRetry.status).toBe(409);
      // Historical identity survives rename, but new stale selections are rejected.
      new Collaboration(f.core, { ...john, username: "newjohn" }, owner.email).refreshProfile();
      expect((await f.post(body)).status).toBe(201);
      expect((await f.post({ ...body, idempotencyKey: "stale" })).status).toBe(400);
      f.access.remove("thread", f.thread.id, john.actor);
      const retry = await f.post(body);
      expect(retry.status).toBe(201);
      const read = await f.make().request(`/api/threads/${f.thread.id}/messages`);
      const messages = (await read.json()) as Message[];
      expect(messages[0].mentions?.map((ref) => ref.actor)).toEqual([alice.actor]);
      expect(messages[0].content).toBe(content.trim());
      expect(
        (
          await f.post({
            content: "@newjohn",
            mentions: [{ ...mention, end: 8 }],
            idempotencyKey: "revoked",
          })
        ).status,
      ).toBe(400);
      expect(f.core.state.messages).toHaveLength(1);
    });
  }
  it("rejects forged actors, off-thread targets, wrong token identity, ranges and extra snapshot fields atomically", async () => {
    const f = fixture();
    const cases = [
      [{ ...mention, actor: "account:unknown" }],
      [{ ...mention, actor: alice.actor }],
      [{ ...mention, start: -1 }],
      [{ ...mention, end: 8 }],
      [{ ...mention, end: 500 }],
      [{ ...mention, username: "forged" }],
      [{ ...mention, start: 0.5 }],
      [mention, mention],
      Array(33).fill(mention),
      "@johncena",
      null,
    ];
    for (const [i, mentions] of cases.entries()) {
      expect(
        (await f.post({ content: "@johncena", mentions, idempotencyKey: `invalid-${i}` })).status,
      ).toBe(400);
      expect(f.core.state.messages).toHaveLength(0);
    }
    expect(
      (
        await f.post(
          { content: "@johncena", mentions: [mention], idempotencyKey: "private" },
          f.make(),
          f.privateThread.id,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.post(
          {
            content: "@owner",
            mentions: [{ actor: owner.actor, start: 0, end: 6 }],
            idempotencyKey: "hidden",
          },
          f.make(john),
          f.privateThread.id,
        )
      ).status,
    ).toBe(404);
  });
  it("keeps literal unmatched, escaped and code text and rejects forged code references", async () => {
    const f = fixture();
    for (const content of [
      "\\@johncena",
      "`@johncena`",
      "```\n@johncena\n```",
      "~~~\n@johncena\n~~~",
      "name@johncena",
      "    @johncena",
    ]) {
      const start = content.indexOf("@johncena");
      expect(
        (
          await f.post({
            content,
            mentions: [{ ...mention, start, end: start + 9 }],
            idempotencyKey: `forged-${start}-${content}`,
          })
        ).status,
      ).toBe(400);
    }
    const content = "unknown @outsider and `@johncena` \\@alice";
    expect((await f.post({ content, idempotencyKey: "literal" })).status).toBe(201);
    expect(f.core.state.messages[0].content).toBe(content);
    expect(f.core.state.messages[0].mentions).toBeUndefined();
  });
  it("rechecks sender and target membership inside delayed write authority; filters orphan roster entries", async () => {
    const f = fixture();
    const gate = deferred();
    const started = deferred();
    const app = f.make(owner, async (operation) => {
      started.resolve();
      await gate.promise;
      return operation();
    });
    const request = f.post(
      { content: "@johncena", mentions: [mention], idempotencyKey: "race" },
      app,
    );
    await started.promise;
    f.access.remove("thread", f.thread.id, john.actor);
    gate.resolve();
    expect((await request).status).toBe(400);
    expect(f.core.state.messages).toHaveLength(0);
    delete f.core.state.collaboration!.projectMembers[alice.actor];
    const roster = await f.make().request(`/api/threads/${f.thread.id}/members`);
    expect(((await roster.json()) as Identity[]).map((member) => member.actor)).toEqual([
      owner.actor,
    ]);
    const gate2 = deferred();
    const started2 = deferred();
    const revoked = f.make(alice, async (operation) => {
      started2.resolve();
      await gate2.promise;
      return operation();
    });
    // Restore access to begin the request, then revoke while authority waits.
    f.core.state.collaboration!.projectMembers[alice.actor] = { ...alice, role: "editor" };
    const request2 = f.post({ content: "plain", idempotencyKey: "sender-race" }, revoked);
    await started2.promise;
    f.access.remove("project", f.core.state.project.id, alice.actor);
    gate2.resolve();
    expect((await request2).status).toBe(404);
    expect(f.core.state.messages).toHaveLength(0);
  });
});
