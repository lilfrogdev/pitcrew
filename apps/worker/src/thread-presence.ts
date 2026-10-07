import type { Collaboration } from "./collaboration";
import { AdmissionError } from "./coordinator";

export const TYPING_TTL_MS = 6000;
const TOMBSTONE_MS = 60000;
type Lease = {
  projectId: string;
  threadId: string;
  actor: string;
  clientId: string;
  username: string;
  sequence: number;
  expiresAt: number;
  touchedAt: number;
  lastActiveAt: number;
};

/** One RepositoryAgent instance owns this memory. Never serialize it or emit chat events. */
export class ThreadPresence {
  private leases = new Map<string, Lease>();
  private budgets = new Map<string, { startedAt: number; reads: number; writes: number }>();
  constructor(private now = Date.now) {}

  private prune() {
    const now = this.now();
    for (const [key, lease] of this.leases)
      if (now - lease.touchedAt >= TOMBSTONE_MS) this.leases.delete(key);
    for (const [key, budget] of this.budgets)
      if (now - budget.startedAt >= 60000) this.budgets.delete(key);
  }
  private admit(actor: string, write: boolean) {
    this.prune();
    let budget = this.budgets.get(actor);
    if (!budget) {
      if (this.budgets.size >= 1024) throw new AdmissionError("capacity", 429);
      budget = { startedAt: this.now(), reads: 0, writes: 0 };
      this.budgets.set(actor, budget);
    }
    const kind = write ? "writes" : "reads";
    if (++budget[kind] > (write ? 120 : 240)) throw new AdmissionError("capacity", 429);
  }
  read(
    projectId: string,
    threadId: string,
    access: Collaboration,
    authorized: (actor: string) => boolean,
  ) {
    access.requireThread(threadId);
    this.admit(access.identity.actor, false);
    const now = this.now();
    const actors = new Map<string, { username: string; expiresAt: number }>();
    for (const lease of this.leases.values()) {
      if (lease.projectId !== projectId || lease.threadId !== threadId) continue;
      if (!authorized(lease.actor)) {
        // Retain sequence fences while removing the revoked actor's visible presence.
        lease.expiresAt = 0;
        continue;
      }
      if (lease.actor === access.identity.actor || lease.expiresAt <= now) continue;
      const prior = actors.get(lease.actor);
      if (!prior || prior.expiresAt < lease.expiresAt)
        actors.set(lease.actor, { username: lease.username, expiresAt: lease.expiresAt });
    }
    return {
      typers: [...actors.values()]
        .sort((a, b) => a.username.localeCompare(b.username))
        .map(({ username, expiresAt }) => ({ username, expiresInMs: expiresAt - now })),
    };
  }

  write(projectId: string, threadId: string, access: Collaboration, body: Record<string, unknown>) {
    access.requireThread(threadId);
    this.admit(access.identity.actor, true);
    if (
      Object.keys(body).sort().join(",") !== "active,clientId,sequence" ||
      typeof body.clientId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.clientId) ||
      typeof body.active !== "boolean" ||
      !Number.isSafeInteger(body.sequence) ||
      Number(body.sequence) < 1
    )
      throw new AdmissionError("invalid_presence");
    const username = access.identity.username;
    if (typeof username !== "string" || !/^[a-zA-Z0-9_]{3,32}$/.test(username))
      throw new AdmissionError("presence_unavailable", 503);
    const now = this.now();
    const key = JSON.stringify([projectId, threadId, access.identity.actor, body.clientId]);
    const previous = this.leases.get(key);
    if (previous && Number(body.sequence) <= previous.sequence) return;
    const own = [...this.leases.values()].filter((lease) => lease.actor === access.identity.actor);
    if (
      body.active &&
      (!previous || previous.expiresAt <= now) &&
      own.filter((lease) => lease.expiresAt > now).length >= 8
    )
      throw new AdmissionError("capacity", 429);
    if (!previous) {
      if (this.leases.size >= 2048 || own.length >= 64) throw new AdmissionError("capacity", 429);
    }
    const tooSoon = body.active && previous && now - previous.lastActiveAt < 1000;
    this.leases.set(key, {
      projectId,
      threadId,
      actor: access.identity.actor,
      clientId: body.clientId,
      username,
      sequence: Number(body.sequence),
      touchedAt: now,
      // Advance the sequence even when throttling, so old requests cannot revive typing.
      expiresAt: body.active ? (tooSoon ? previous.expiresAt : now + TYPING_TTL_MS) : 0,
      lastActiveAt: body.active && !tooSoon ? now : (previous?.lastActiveAt ?? -Infinity),
    });
  }
}
