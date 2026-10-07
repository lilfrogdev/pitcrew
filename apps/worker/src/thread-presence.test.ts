import { describe, expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration, type Identity } from "./collaboration";
import { AdmissionError, Coordinator, initialState } from "./coordinator";
import { ThreadPresence, TYPING_TTL_MS } from "./thread-presence";
import {
  PresenceClient,
  type PresenceApi,
  type PresenceState,
  type TypingSnapshot,
} from "../../web/src/thread-presence";
const alice: Identity = { actor: "account:alice", email: "alice@example.com", username: "Alice" };
const bob: Identity = { actor: "account:bob", email: "bob@example.com", username: "Bob" };
const charlie: Identity = {
  actor: "account:charlie",
  email: "charlie@example.com",
  username: "Charlie",
};
const dana: Identity = { actor: "account:dana", email: "dana@example.com", username: "Dana" };
const tab = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
function fixture() {
  let now = 10000;
  const core = new Coordinator(initialState(), () => {});
  const thread = core.createThread("Shared", "shared");
  const privateThread = core.createThread("Private", "private");
  const access = (identity: Identity) => new Collaboration(core, identity, alice.email);
  access(alice).bootstrap();
  core.updateCollaboration((state) => {
    for (const identity of [bob, charlie, dana]) {
      const member = { ...identity, role: "editor" as const };
      state.collaboration!.projectMembers[identity.actor] = member;
      state.collaboration!.threadMembers[thread.id][identity.actor] = member;
    }
  });
  const presence = new ThreadPresence(() => now);
  const request = (identity: Identity, id = thread.id, body?: Record<string, unknown>) =>
    api(
      core,
      () => {},
      undefined,
      identity,
      undefined,
      access(identity),
      true,
      undefined,
      presence,
    ).request(
      `/api/threads/${id}/presence`,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
  const write = (identity: Identity, clientId = tab(1), sequence = 1, active = true) =>
    request(identity, thread.id, { clientId, sequence, active });
  const read = async (identity: Identity) =>
    (await request(identity)).json() as Promise<TypingSnapshot>;
  const clientApi = (identity: Identity): PresenceApi => ({
    read: async (id) => {
      const r = await request(identity, id);
      if (!r.ok) throw { status: r.status };
      return r.json();
    },
    write: async (id, body) => {
      const r = await request(identity, id, body);
      if (!r.ok) throw { status: r.status };
    },
  });
  return {
    core,
    thread,
    privateThread,
    access,
    request,
    write,
    read,
    clientApi,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("ephemeral thread typing", () => {
  it("enforces eight active clients when prior inactive leases reactivate", async () => {
    const f = fixture();
    for (let index = 1; index <= 9; index++)
      expect((await f.write(alice, tab(index), 1, false)).status).toBe(200);
    for (let index = 1; index <= 8; index++)
      expect((await f.write(alice, tab(index), 2, true)).status).toBe(200);
    expect((await f.write(alice, tab(9), 2, true)).status).toBe(429);
  });
  it("uses trusted usernames, excludes self, deduplicates tabs and never persists typing", async () => {
    const f = fixture();
    const durable = JSON.stringify(f.core.state);
    expect((await f.write(alice)).status).toBe(200);
    await f.write(alice, tab(2));
    await f.write(charlie, tab(3));
    await f.write(dana, tab(4));
    expect(await f.read(bob)).toEqual({
      typers: [
        { username: "Alice", expiresInMs: 6000 },
        { username: "Charlie", expiresInMs: 6000 },
        { username: "Dana", expiresInMs: 6000 },
      ],
    });
    expect((await f.read(alice)).typers).toHaveLength(2);
    await f.write(alice, tab(1), 2, false);
    expect((await f.read(bob)).typers).toHaveLength(3);
    await f.write(alice, tab(2), 2, false);
    expect((await f.read(bob)).typers.map((item: { username: string }) => item.username)).toEqual([
      "Charlie",
      "Dana",
    ]);
    expect(JSON.stringify(f.core.state)).toBe(durable);
    expect((await f.request(bob)).headers.get("Cache-Control")).toBe("private, no-store");
    expect(
      (
        await f.request(alice, f.thread.id, {
          active: true,
          sequence: 3,
          clientId: tab(1),
          username: "Spoof",
          text: "private draft",
        })
      ).status,
    ).toBe(400);
  });
  it("fences out-of-order starts and expires crashed clients", async () => {
    const f = fixture();
    await f.write(alice, tab(1), 2, false);
    await f.write(alice, tab(1), 1, true);
    expect(await f.read(bob)).toEqual({ typers: [] });
    await f.write(alice, tab(1), 3, true);
    f.advance(1000);
    expect((await f.read(bob)).typers[0].expiresInMs).toBe(5000);
    f.advance(TYPING_TTL_MS - 1000);
    expect(await f.read(bob)).toEqual({ typers: [] });
    // Object restart has no presence to restore.
    expect(
      new ThreadPresence(f.now).read("pitcrew", f.thread.id, f.access(bob), () => true),
    ).toEqual({ typers: [] });
  });
  it("denies private threads, absent membership and revoked readers/writers without a roster", async () => {
    const f = fixture();
    expect((await f.request(bob, f.privateThread.id)).status).toBe(404);
    expect((await f.request(bob, "missing")).status).toBe(404);
    await f.write(bob);
    f.access(alice).remove("thread", f.thread.id, bob.actor);
    expect(await f.read(alice)).toEqual({ typers: [] });
    expect((await f.request(bob)).status).toBe(404);
    expect((await f.write(bob, tab(1), 2)).status).toBe(404);
    await f.write(charlie);
    f.access(alice).remove("project", "pitcrew", charlie.actor);
    expect(await f.read(dana)).toEqual({ typers: [] });
    expect((await f.write(charlie, tab(1), 2)).status).toBe(404);
  });
  it("rechecks membership after receiving a delayed body", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ active: true, sequence: 1, clientId: tab(1) })),
        );
        controller.close();
      },
    });
    const app = api(
      f.core,
      () => {},
      undefined,
      bob,
      undefined,
      f.access(bob),
      true,
      undefined,
      new ThreadPresence(f.now),
    );
    const pending = app.request(`/api/threads/${f.thread.id}/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await Promise.resolve();
    f.access(alice).remove("thread", f.thread.id, bob.actor);
    release();
    expect((await pending).status).toBe(404);
  });
  it("checks session authority after a delayed body before refreshing presence", async () => {
    const f = fixture();
    const presence = new ThreadPresence(f.now);
    let bodyReady = false;
    let sessionActive = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ active: true, sequence: 1, clientId: tab(1) })),
        );
        bodyReady = true;
        controller.close();
      },
    });
    const app = api(
      f.core,
      () => {},
      undefined,
      bob,
      undefined,
      f.access(bob),
      true,
      undefined,
      presence,
      async (operation) => {
        expect(bodyReady).toBe(true);
        if (!sessionActive) throw new AdmissionError("unauthorized", 401);
        return operation();
      },
    );
    const pending = app.request(`/api/threads/${f.thread.id}/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await Promise.resolve();
    sessionActive = false;
    release();
    expect((await pending).status).toBe(401);
    expect(presence.read("pitcrew", f.thread.id, f.access(alice), () => true)).toEqual({
      typers: [],
    });
  });
  it("throttles refresh bursts and bounds tabs and request rates", async () => {
    const f = fixture();
    await f.write(alice);
    for (let sequence = 2; sequence <= 20; sequence++) {
      f.advance(20);
      await f.write(alice, tab(1), sequence);
    }
    expect((await f.read(bob)).typers[0].expiresInMs).toBe(5620);
    for (let index = 2; index <= 8; index++)
      expect((await f.write(alice, tab(index))).status).toBe(200);
    expect((await f.write(alice, tab(9))).status).toBe(429);
    for (let sequence = 21; sequence <= 130; sequence++) await f.write(alice, tab(1), sequence);
    expect((await f.write(alice, tab(1), 131)).status).toBe(429);
    f.advance(60000);
    expect((await f.write(alice, tab(1), 132)).status).toBe(200);
  });
  it("connects two independent clients through real API routes and clears revocation", async () => {
    const f = fixture();
    let seen: PresenceState = { usernames: [], reconnecting: false };
    const a = new PresenceClient(f.clientApi(alice), f.thread.id, tab(1), () => {}, f.now);
    const b = new PresenceClient(
      f.clientApi(bob),
      f.thread.id,
      tab(2),
      (state) => {
        seen = state;
      },
      f.now,
    );
    a.activity();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await b.read();
    expect(seen.usernames).toEqual(["Alice"]);
    a.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await b.read();
    expect(seen.usernames).toEqual([]);
    f.advance(2000);
    a.activity();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.access(alice).remove("thread", f.thread.id, bob.actor);
    await b.read();
    expect(seen).toEqual({ usernames: [], reconnecting: false });
    a.close();
    b.close();
  });
});
