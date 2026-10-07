import { describe, expect, it, vi } from "vite-plus/test";
import { PresenceClient, type PresenceApi, type PresenceState } from "./thread-presence";
const clientId = "00000000-0000-0000-0000-000000000001";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  let now = 10000;
  let state: PresenceState = { usernames: [], reconnecting: false };
  const writes: { threadId: string; clientId: string; sequence: number; active: boolean }[] = [];
  const api: PresenceApi = {
    read: async () => ({ typers: [] }),
    write: async (threadId, body) => {
      writes.push({ threadId, ...body });
    },
  };
  const client = new PresenceClient(
    api,
    "thread-one",
    clientId,
    (next) => {
      state = next;
    },
    () => now,
  );
  return {
    client,
    writes,
    api,
    state: () => state,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("presence client lifecycle", () => {
  it("coalesces activity behind a delayed start and always transmits its final stop", async () => {
    const f = fixture();
    let release!: () => void;
    f.api.write = async (threadId, body) => {
      f.writes.push({ threadId, ...body });
      if (body.active)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    };
    f.client.activity();
    f.advance(2000);
    f.client.activity();
    f.client.stop();
    expect(f.writes).toHaveLength(1);
    release();
    await settle();
    expect(f.writes.map((item) => item.active)).toEqual([true, false]);
    expect(f.writes.at(-1)?.sequence).toBe(3);
  });
  it("ignores a stop error after a successful reconnect and retries capacity-rejected stops", async () => {
    const f = fixture();
    let rejectStop!: () => void;
    f.api.write = async (_threadId, body) => {
      if (!body.active)
        await new Promise<void>((_resolve, reject) => {
          rejectStop = () => reject(Error("old offline"));
        });
    };
    f.client.activity();
    await settle();
    f.client.suspend();
    await settle();
    f.api.read = async () => ({ typers: [{ username: "Alice", expiresInMs: 6000 }] });
    f.client.resume();
    await settle();
    rejectStop();
    await settle();
    expect(f.state()).toEqual({ usernames: ["Alice"], reconnecting: false });
    vi.useFakeTimers();
    try {
      const g = fixture();
      let stopped = 0;
      g.api.write = async (_threadId, body) => {
        if (!body.active && ++stopped === 1) throw { status: 409 };
      };
      g.client.activity();
      await Promise.resolve();
      g.client.stop();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(stopped).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("throttles input, stops on inactivity/send and never sends a draft", async () => {
    const f = fixture();
    f.client.activity();
    f.client.activity();
    f.client.activity();
    expect(f.writes).toEqual([{ threadId: "thread-one", clientId, sequence: 1, active: true }]);
    f.advance(2000);
    f.client.activity();
    await settle();
    expect(f.writes.at(-1)?.active).toBe(true);
    f.advance(2000);
    f.client.tick();
    await settle();
    f.advance(2000);
    f.client.tick();
    expect(f.writes.at(-1)?.active).toBe(false);
    f.client.activity();
    f.client.stop();
    await settle();
    expect(f.writes.at(-1)?.active).toBe(false);
    expect(Object.keys(f.writes[0]).sort()).toEqual(["active", "clientId", "sequence", "threadId"]);
  });
  it("stops on blur/hide/pagehide and resumes reading without replaying old activity", async () => {
    const f = fixture();
    f.client.activity();
    f.client.suspend();
    await settle();
    expect(f.writes.at(-1)?.active).toBe(false);
    f.client.activity();
    f.advance(10000);
    f.client.tick();
    expect(f.writes).toHaveLength(2);
    f.client.resume();
    await f.client.read();
    expect(f.writes).toHaveLength(2);
    f.client.activity();
    f.client.close();
    await settle();
    expect(f.writes.at(-1)?.active).toBe(false);
    f.client.activity();
    expect(f.writes).toHaveLength(4);
  });
  it("expires visible names even while reads hang, including delayed snapshots", async () => {
    const f = fixture();
    f.api.read = async () => ({ typers: [{ username: "Alice", expiresInMs: 6000 }] });
    await f.client.read();
    expect(f.state().usernames).toEqual(["Alice"]);
    f.advance(6000);
    f.client.tick();
    expect(f.state().usernames).toEqual([]);
    let release!: () => void;
    f.api.read = () =>
      new Promise((resolve) => {
        release = () => resolve({ typers: [{ username: "Alice", expiresInMs: 6000 }] });
      });
    const pending = f.client.read();
    f.advance(7000);
    release();
    await pending;
    expect(f.state().usernames).toEqual([]);
  });
  it("clears stale names on disconnect and ignores responses from a previous visibility generation", async () => {
    const f = fixture();
    let release!: () => void;
    f.api.read = () =>
      new Promise((resolve) => {
        release = () => resolve({ typers: [{ username: "Alice", expiresInMs: 6000 }] });
      });
    const pending = f.client.read();
    f.client.suspend();
    release();
    await pending;
    expect(f.state().usernames).toEqual([]);
    f.api.read = async () => {
      throw Error("offline");
    };
    f.client.resume();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.state().reconnecting).toBe(true);
    f.client.activity();
    expect(f.writes).toHaveLength(0);
    f.api.read = async () => ({ typers: [] });
    await f.client.read();
    expect(f.state().reconnecting).toBe(false);
    expect(f.writes).toHaveLength(0);
    f.client.activity();
    expect(f.writes.at(-1)?.active).toBe(true);
  });
  it("does not claim ordinary polls or temporary write capacity as reconnection", async () => {
    const f = fixture();
    await f.client.read();
    expect(f.state().reconnecting).toBe(false);
    f.api.write = async () => {
      throw { status: 429 };
    };
    f.client.activity();
    await Promise.resolve();
    expect(f.state().reconnecting).toBe(false);
  });
});
