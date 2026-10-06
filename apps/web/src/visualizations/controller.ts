import {
  readVisualizationEnvelope,
  VISUALIZATION_LIMITS,
  type VisualizationEnvelope,
} from "../../../../packages/protocol/src/visualizations";

export type VisualizationSource = {
  accountId: string;
  repositoryId: string;
  threadId: string;
  load: (signal: AbortSignal) => Promise<unknown>;
};
export type VisualizationSnapshot = {
  source: VisualizationSource;
  envelope: VisualizationEnvelope;
  deadline: number;
} | null;
// One ephemeral thread, no browser storage/global cache. Losing authority removes
// data as well as frames. Async responses cannot repopulate a replaced context.
export class VisualizationController {
  private source?: VisualizationSource;
  private state: VisualizationSnapshot = null;
  private generation = 0;
  private pending?: AbortController;
  private expiry?: ReturnType<typeof setTimeout>;
  private refresh?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  constructor(private now = () => performance.now()) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  invalidate = () => {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
    clearTimeout(this.expiry);
    clearTimeout(this.refresh);
    this.state = null;
    this.emit();
  };
  configure(source?: VisualizationSource) {
    this.invalidate();
    this.source = source;
  }
  dispose() {
    this.configure();
  }
  async revalidate() {
    const source = this.source;
    if (!source || this.pending) return;
    const generation = this.generation,
      started = this.now(),
      pending = new AbortController();
    this.pending = pending;
    try {
      const value = await source.load(pending.signal);
      if (generation !== this.generation || source !== this.source || pending.signal.aborted)
        return;
      const envelope = readVisualizationEnvelope(value);
      const deadline = started + envelope.leaseMs;
      if (
        envelope.accountId !== source.accountId ||
        envelope.repositoryId !== source.repositoryId ||
        envelope.threadId !== source.threadId ||
        deadline <= this.now()
      )
        throw Error("visualization_unavailable");
      clearTimeout(this.expiry);
      clearTimeout(this.refresh);
      this.state = { source, envelope, deadline };
      this.emit();
      this.expiry = setTimeout(this.invalidate, Math.max(0, deadline - this.now()));
      this.refresh = setTimeout(
        () => {
          void this.revalidate();
        },
        Math.min(2500, Math.max(1, (deadline - this.now()) / 2)),
      );
    } catch {
      if (generation === this.generation) this.invalidate();
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
export async function loadVisualizationJson(url: string, signal: AbortSignal): Promise<unknown> {
  const target = new URL(url, location.origin);
  if (
    target.origin !== location.origin ||
    !/^\/api\/projects\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+\/visualizations$/.test(
      target.pathname,
    ) ||
    target.search ||
    target.hash
  )
    throw Error("visualization_unavailable");
  const result = await fetch(target, {
    signal,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (
    !result.ok ||
    result.headers.get("content-type")?.split(";", 1)[0] !== "application/json" ||
    !result.body
  )
    throw Error("visualization_unavailable");
  const reader = result.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > VISUALIZATION_LIMITS.threadBytes + 4096) {
      await reader.cancel();
      throw Error("visualization_unavailable");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
