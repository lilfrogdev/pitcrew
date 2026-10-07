export type TypingSnapshot = { typers: { username: string; expiresInMs: number }[] };
export interface PresenceApi {
  read(threadId: string): Promise<TypingSnapshot>;
  write(
    threadId: string,
    signal: { clientId: string; sequence: number; active: boolean },
  ): Promise<unknown>;
}
export type PresenceState = { usernames: string[]; reconnecting: boolean };
const TTL = 6000;

/** No draft value enters this controller or the transport. */
export class PresenceClient {
  private sequence = 0;
  private lastActivity = 0;
  private lastWrite = -Infinity;
  private active = false;
  private suspended = false;
  private closed = false;
  private unavailable = false;
  private connected = false;
  private reading = false;
  private readGeneration = 0;
  private connectionGeneration = 0;
  private writing = false;
  private pendingWrite?: { active: boolean; sequence: number; generation: number };
  private expires: { username: string; at: number }[] = [];
  private state: PresenceState = { usernames: [], reconnecting: false };
  constructor(
    private api: PresenceApi,
    private threadId: string,
    private clientId: string,
    private emit: (state: PresenceState) => void,
    private now = Date.now,
    private onAccessLost?: () => void,
  ) {}
  private publish() {
    const usernames = this.expires
      .filter((item) => item.at > this.now())
      .map((item) => item.username);
    if (JSON.stringify(usernames) === JSON.stringify(this.state.usernames)) return;
    this.state = { ...this.state, usernames };
    this.emit(this.state);
  }
  private failure(error: unknown) {
    if (this.closed || this.suspended) return;
    const status =
      error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    if ([409, 429].includes(status)) return;
    this.stop();
    this.expires = [];
    if ([401, 403, 404].includes(status)) {
      this.unavailable = true;
      if (status !== 404 || this.connected) this.onAccessLost?.();
      this.state = { usernames: [], reconnecting: false };
    } else this.state = { usernames: [], reconnecting: true };
    this.emit(this.state);
  }
  private write(active: boolean) {
    const sequence = ++this.sequence;
    this.lastWrite = this.now();
    this.pendingWrite = { active, sequence, generation: this.connectionGeneration };
    void this.flush();
  }
  private async flush() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pendingWrite) {
        const write = this.pendingWrite;
        this.pendingWrite = undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await this.api.write(this.threadId, {
              clientId: this.clientId,
              sequence: write.sequence,
              active: write.active,
            });
            break;
          } catch (error) {
            const status =
              error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
            if (
              !write.active &&
              [409, 429].includes(status) &&
              attempt < 3 &&
              write.sequence === this.sequence
            ) {
              await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
              if (write.sequence !== this.sequence) break;
              continue;
            }
            // A prior connection's stop failure cannot override a successful reconnect.
            if (
              write.sequence === this.sequence &&
              write.generation === this.connectionGeneration &&
              status !== 503
            )
              this.failure(error);
            break;
          }
        }
      }
    } finally {
      this.writing = false;
    }
  }
  activity(hasInput = true) {
    if (!hasInput) {
      this.stop();
      return;
    }
    if (this.closed || this.suspended || this.unavailable || this.state.reconnecting) return;
    this.lastActivity = this.now();
    if (!this.active || this.now() - this.lastWrite >= 2000) {
      this.active = true;
      this.write(true);
    }
  }
  stop() {
    this.lastActivity = 0;
    if (!this.active) return;
    this.active = false;
    this.write(false);
  }
  suspend() {
    ++this.connectionGeneration;
    this.stop();
    this.suspended = true;
    ++this.readGeneration;
    this.expires = [];
    this.state = { ...this.state, usernames: [] };
    this.emit(this.state);
  }
  resume() {
    if (this.closed) return;
    this.suspended = false;
    ++this.connectionGeneration;
    // A reconnect never replays activity from an old draft.
    void this.read();
  }
  offline() {
    ++this.connectionGeneration;
    this.stop();
    ++this.readGeneration;
    this.expires = [];
    this.state = { usernames: [], reconnecting: true };
    this.emit(this.state);
  }
  tick() {
    this.publish();
    if (this.closed || this.suspended) return;
    if (this.active && this.now() - this.lastActivity >= 4000) this.stop();
    else if (this.active && this.now() - this.lastWrite >= 2000) this.write(true);
  }
  async read() {
    if (this.closed || this.suspended || this.unavailable || this.reading) return;
    this.reading = true;
    const generation = this.readGeneration;
    const started = this.now();
    try {
      const snapshot = await this.api.read(this.threadId);
      if (this.closed || this.suspended || generation !== this.readGeneration) return;
      if (
        !Array.isArray(snapshot?.typers) ||
        snapshot.typers.length > 2048 ||
        snapshot.typers.some(
          (item) =>
            typeof item?.username !== "string" ||
            !/^[a-zA-Z0-9_]{3,32}$/.test(item.username) ||
            !Number.isFinite(item.expiresInMs) ||
            item.expiresInMs <= 0 ||
            item.expiresInMs > TTL,
        )
      )
        throw Error("invalid_presence");
      this.connected = true;
      ++this.connectionGeneration;
      // Subtract the whole round-trip, so a stalled response cannot renew an expired lease.
      this.expires = snapshot.typers.map((item) => ({
        username: item.username,
        at: started + item.expiresInMs,
      }));
      const reconnecting = this.state.reconnecting;
      this.state = { ...this.state, reconnecting: false };
      if (reconnecting) this.emit(this.state);
      this.publish();
    } catch (error) {
      if (generation === this.readGeneration) this.failure(error);
    } finally {
      this.reading = false;
    }
  }
  close() {
    ++this.connectionGeneration;
    this.stop();
    this.closed = true;
    ++this.readGeneration;
  }
}
