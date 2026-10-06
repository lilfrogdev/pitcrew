import type {
  Run,
  SourceBinding,
  SourceTree,
  SourceFile,
  DiffBinding,
  SourceDiff,
  SourcePatch,
  DiffEntry,
} from "@pitcrew/protocol";
import { AdmissionError, type Coordinator } from "./coordinator";
import type { Collaboration } from "./collaboration";
import { artifactRemote, type ArtifactSource } from "./cloud-landing-api";
import type { PublisherIdentity } from "../../../packages/execution/src/trusted-publisher";

// Read-only Workers binding; no Git, filesystem, credential or container access.
export type ReaderBinding = Pick<Artifacts, "get">;
export const SOURCE_LIMITS = {
  calls: 128,
  entries: 6000,
  treeEntries: 2048,
  nameBytes: 524288,
  fileBytes: 65536,
  patchBytes: 196608,
  lines: 4000,
  depth: 32,
  page: 100,
  timeoutMs: 8000,
} as const;
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
function fail(code: string, status = 409): never {
  throw new AdmissionError(code, status);
}
export function sourcePath(value: string, empty = true): string {
  if (
    (!value && !empty) ||
    value.length > 1024 ||
    // eslint-disable-next-line no-control-regex -- Repository paths cannot contain controls.
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    (value &&
      value
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) ||
    value.split("/").length > SOURCE_LIMITS.depth
  )
    fail("invalid_source_request", 400);
  return value;
}
function page<T>(items: T[], cursor: string | undefined) {
  if (
    cursor !== undefined &&
    (!/^(0|[1-9][0-9]{0,4})$/.test(cursor) || Number(cursor) > items.length)
  )
    fail("invalid_source_request", 400);
  const offset = Number(cursor ?? 0);
  return {
    entries: items.slice(offset, offset + SOURCE_LIMITS.page),
    cursor: offset + SOURCE_LIMITS.page < items.length ? String(offset + SOURCE_LIMITS.page) : null,
  };
}
function kind(entry: ArtifactsTreeEntry) {
  if (entry.mode === "40000" || entry.mode === "040000") return "directory" as const;
  if (entry.mode === "100644" || entry.mode === "100755") return "file" as const;
  if (entry.mode === "120000") return "symlink" as const;
  if (entry.mode === "160000") return "submodule" as const;
  return fail("source_data_invalid", 503);
}
async function version(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const activeReads = new WeakMap<Coordinator, number>();
class Budget {
  extraFence?: () => void;
  calls = 0;
  entries = 0;
  nameBytes = 0;
  readonly deadline = Date.now() + SOURCE_LIMITS.timeoutMs;
  constructor(readonly fence: () => void) {}
  check() {
    this.fence();
    this.extraFence?.();
    if (Date.now() > this.deadline) fail("source_timeout", 503);
  }
  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    if (++this.calls > SOURCE_LIMITS.calls) fail("source_limit_exceeded", 413);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AdmissionError("source_timeout", 503)),
            Math.max(1, this.deadline - Date.now()),
          );
        }),
      ]);
      this.check();
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  async acquire(operation: () => Promise<ArtifactsRepo>): Promise<ArtifactsRepo> {
    let handle: ArtifactsRepo | undefined;
    let done = false,
      handedOff = false;
    const dispose = (value: ArtifactsRepo) => {
      try {
        value[Symbol.dispose]();
      } catch {
        /* No read credential or persistent resource is owned. */
      }
    };
    try {
      const result = await this.read(async () => {
        handle = await operation();
        if (done) dispose(handle);
        return handle;
      });
      handedOff = true;
      return result;
    } finally {
      done = true;
      if (!handedOff && handle) dispose(handle);
    }
  }
  async tree(repo: ArtifactsRepo, hash: string) {
    if (!sha(hash)) fail("source_data_invalid", 503);
    const entries = await this.read(() => repo.readTree(hash));
    if (!entries) fail("source_unavailable", 404);
    if (
      entries.length > SOURCE_LIMITS.treeEntries ||
      (this.entries += entries.length) > SOURCE_LIMITS.entries
    )
      fail("source_limit_exceeded", 413);
    const names = new Set<string>();
    for (const entry of entries) {
      sourcePath(entry.name, false);
      if (entry.name.includes("/") || names.has(entry.name) || !sha(entry.hash))
        fail("source_data_invalid", 503);
      names.add(entry.name);
      this.nameBytes += new TextEncoder().encode(entry.name).length;
      if (this.nameBytes > SOURCE_LIMITS.nameBytes) fail("source_limit_exceeded", 413);
      kind(entry);
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  async commit(repo: ArtifactsRepo, hash: string) {
    if (!sha(hash)) fail("source_unavailable", 404);
    const commit = await this.read(() => repo.readCommit(hash));
    if (!commit || commit.hash !== hash || !sha(commit.treeHash)) fail("source_unavailable", 404);
    return commit;
  }
  async resolve(repo: ArtifactsRepo, root: string, path: string) {
    let hash = root;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const entry = (await this.tree(repo, hash)).find((item) => item.name === parts[index]);
      if (!entry) fail("not_found", 404);
      if (index === parts.length - 1) return entry;
      if (kind(entry) !== "directory") fail("not_found", 404);
      hash = entry.hash;
    }
    return fail("not_found", 404);
  }
  async content(repo: ArtifactsRepo, entry: ArtifactsTreeEntry | undefined) {
    if (!entry) return { status: "text" as const, text: "", bytes: 0 };
    const type = kind(entry);
    if (type !== "file") return { status: type === "directory" ? ("binary" as const) : type };
    const blob = await this.read(() => repo.readBlob(entry.hash));
    if (!blob) fail("source_unavailable", 404);
    if (blob.size > SOURCE_LIMITS.fileBytes)
      return { status: "too_large" as const, bytes: blob.size };
    const bytes = await this.read(() => blob.arrayBuffer());
    if (bytes.byteLength > SOURCE_LIMITS.fileBytes) fail("source_limit_exceeded", 413);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // eslint-disable-next-line no-control-regex -- Only printable UTF-8 and text whitespace are rendered.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
        return { status: "binary" as const, bytes: blob.size };
      if (text.split("\n").length > SOURCE_LIMITS.lines)
        return { status: "too_large" as const, bytes: blob.size };
      return { status: "text" as const, text, bytes: blob.size };
    } catch {
      return { status: "binary" as const, bytes: blob.size };
    }
  }
}
/** A valid unified patch with a bounded replacement hunk; no quadratic LCS. */
export function unifiedPatch(
  path: string,
  before: string,
  after: string,
  added = false,
  deleted = false,
  mode = "100644",
): string | undefined {
  if (!before && !after && (added || deleted))
    return `diff --git ${JSON.stringify("a/" + path)} ${JSON.stringify("b/" + path)}\n${added ? "new" : "deleted"} file mode ${mode}\nindex ${added ? "0000000..e69de29" : "e69de29..0000000"}\n`;
  const split = (text: string) => (text ? text.match(/[^\n]*\n|[^\n]+$/g)! : []);
  const left = split(before),
    right = split(after);
  if (left.length + right.length > SOURCE_LIMITS.lines) return;
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) prefix++;
  while (
    suffix < Math.min(left.length, right.length) - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix++;
  if (before === after && !added && !deleted) return "";
  const start = Math.max(0, prefix - 3),
    leftEnd = Math.min(left.length, left.length - suffix + 3),
    rightEnd = Math.min(right.length, right.length - suffix + 3);
  const line = (value: string, marker: string) =>
    `${marker}${value.endsWith("\n") ? value : value + "\n\\ No newline at end of file\n"}`;
  let patch = `--- ${added ? "/dev/null" : JSON.stringify("a/" + path)}\n+++ ${deleted ? "/dev/null" : JSON.stringify("b/" + path)}\n`;
  patch += `@@ -${leftEnd === start ? start : start + 1},${leftEnd - start} +${rightEnd === start ? start : start + 1},${rightEnd - start} @@\n`;
  patch += left
    .slice(start, prefix)
    .map((value) => line(value, " "))
    .join("");
  patch += left
    .slice(prefix, left.length - suffix)
    .map((value) => line(value, "-"))
    .join("");
  patch += right
    .slice(prefix, right.length - suffix)
    .map((value) => line(value, "+"))
    .join("");
  patch += left
    .slice(left.length - suffix, leftEnd)
    .map((value) => line(value, " "))
    .join("");
  return new TextEncoder().encode(patch).length <= SOURCE_LIMITS.patchBytes ? patch : undefined;
}
export class SourceReader {
  constructor(
    private readonly artifacts: ReaderBinding,
    private readonly core: Coordinator,
    private readonly access: Collaboration,
    private readonly source: () => ArtifactSource | undefined,
    private readonly publication: (runId: string) => PublisherIdentity | undefined,
  ) {}
  async request(
    threadId: string,
    action: "tree" | "file" | "diff",
    query: URLSearchParams,
  ): Promise<SourceTree | SourceFile | SourceDiff | SourcePatch> {
    this.access.requireThread(threadId);
    const allowed =
      action === "diff" ? ["runId", "path", "version", "cursor"] : ["path", "version", "cursor"];
    if (
      [...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1) ||
      [...query.values()].some((value) => value.length > 1024) ||
      (query.has("cursor") && !query.has("version"))
    )
      fail("invalid_source_request", 400);
    if (action === "file" && (!query.has("version") || query.has("cursor")))
      fail("invalid_source_request", 400);
    if (action === "diff" && query.has("path") && (!query.has("version") || query.has("cursor")))
      fail("invalid_source_request", 400);
    if ((activeReads.get(this.core) ?? 0) >= 3) fail("source_capacity", 429);
    activeReads.set(this.core, (activeReads.get(this.core) ?? 0) + 1);
    const source = this.source();
    const sourceStamp = JSON.stringify(source);
    const projectStamp = JSON.stringify([
      this.core.state.project.id,
      this.core.state.project.configurationRevision,
    ]);
    const fence = () => {
      this.access.requireThread(threadId);
      if (
        sourceStamp !== JSON.stringify(this.source()) ||
        projectStamp !==
          JSON.stringify([
            this.core.state.project.id,
            this.core.state.project.configurationRevision,
          ])
      )
        fail("source_stale", 409);
    };
    const budget = new Budget(fence);
    try {
      if (!source) fail("source_unavailable", 503);
      using repo = await budget.acquire(() => this.artifacts.get(source.name));
      let sourceInfoStamp: string | undefined;
      const verifySource = async () => {
        const info = await budget.read(() => repo.info());
        if (info.id !== source.repositoryId || info.name !== source.name) fail("source_stale", 409);
        const next = JSON.stringify([
          info.id,
          info.name,
          info.defaultBranch,
          info.remote,
          info.source,
        ]);
        if (sourceInfoStamp !== undefined && sourceInfoStamp !== next) fail("source_stale", 409);
        sourceInfoStamp = next;
        return info;
      };
      const info = await verifySource();
      if (action === "diff")
        return await this.diff(threadId, query, source, repo, info, budget, verifySource);
      const head = async () => {
        const [commit] = await budget.read(() => repo.log({ ref: info.defaultBranch, limit: 1 }));
        if (!commit || !sha(commit.hash)) fail("source_unavailable", 404);
        return commit.hash;
      };
      const hash = await head();
      const binding: SourceBinding = {
        projectId: this.core.state.project.id,
        threadId,
        sourceId: source.repositoryId,
        sha: hash,
        version: await version([this.core.state.project.id, threadId, source.repositoryId, hash]),
      };
      budget.check();
      if (query.has("version") && query.get("version") !== binding.version)
        fail("source_stale", 409);
      const commit = await budget.commit(repo, hash);
      const path = sourcePath(query.get("path") ?? "", action === "tree");
      let result: SourceTree | SourceFile;
      if (action === "tree") {
        const entry = path ? await budget.resolve(repo, commit.treeHash, path) : undefined;
        if (entry && kind(entry) !== "directory") fail("not_found", 404);
        const entries = (await budget.tree(repo, entry?.hash ?? commit.treeHash)).map((item) => ({
          name: item.name,
          path: path ? `${path}/${item.name}` : item.name,
          mode: item.mode,
          kind: kind(item),
        }));
        result = { ...binding, path, ...page(entries, query.get("cursor") ?? undefined) };
      } else {
        const entry = await budget.resolve(repo, commit.treeHash, path);
        if (kind(entry) === "directory") fail("not_found", 404);
        result = { ...binding, path, ...(await budget.content(repo, entry)) };
      }
      await verifySource();
      if ((await head()) !== hash) fail("source_stale", 409);
      budget.check();
      return result;
    } catch (error) {
      if (error instanceof AdmissionError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND")
        fail("not_found", 404);
      return fail("source_unavailable", 503);
    } finally {
      activeReads.set(this.core, (activeReads.get(this.core) ?? 1) - 1);
    }
  }
  private async diff(
    threadId: string,
    query: URLSearchParams,
    source: ArtifactSource,
    repo: ArtifactsRepo,
    sourceInfo: ArtifactsRepoInfo,
    budget: Budget,
    verifySource: () => Promise<ArtifactsRepoInfo>,
  ): Promise<SourceDiff | SourcePatch> {
    const runId = query.get("runId");
    const run = this.core.state.runs.find(
      (item) => item.id === runId && item.threadId === threadId,
    );
    if (!run) fail("not_found", 404);
    const publication = this.publication(run.id);
    const stamp = JSON.stringify([run, publication]);
    const check = () => {
      const current = this.core.state.runs.find(
        (item) => item.id === run.id && item.threadId === threadId,
      );
      if (stamp !== JSON.stringify([current, this.publication(run.id)])) fail("source_stale", 409);
    };
    budget.extraFence = check;
    this.admit(run, publication, source);
    const pinned = publication!;
    using fork = await budget.acquire(() => this.artifacts.get(pinned.artifactId));
    check();
    const verifyFork = async () => {
      const info = await budget.read(() => fork.info());
      const parent = artifactRemote(sourceInfo.remote),
        child = artifactRemote(info.remote);
      if (
        info.id !== pinned.artifactRepositoryId ||
        info.name !== pinned.artifactId ||
        info.source !== `artifacts:${parent.pathname.split("/")[2]}/${source.name}` ||
        child.hostname !== parent.hostname ||
        child.pathname.split("/")[2] !== parent.pathname.split("/")[2] ||
        decodeURIComponent(child.pathname.split("/")[3]) !== `${pinned.artifactId}.git`
      )
        fail("source_stale", 409);
      check();
    };
    await verifyFork();
    const binding: DiffBinding = {
      projectId: this.core.state.project.id,
      threadId,
      runId: run.id,
      sourceId: source.repositoryId,
      artifactId: pinned.artifactRepositoryId,
      baseSha: run.baseSha,
      candidateSha: run.candidateSha!,
      configurationRevision: run.configurationRevision,
      version: await version([
        this.core.state.project.id,
        threadId,
        source.repositoryId,
        pinned.artifactRepositoryId,
        run.id,
        run.baseSha,
        run.candidateSha,
        run.configurationRevision,
      ]),
    };
    check();
    if (query.has("version") && query.get("version") !== binding.version) fail("source_stale", 409);
    const before = await budget.commit(repo, binding.baseSha),
      after = await budget.commit(fork, binding.candidateSha);
    check();
    let result: SourceDiff | SourcePatch;
    if (query.has("path")) {
      const path = sourcePath(query.get("path")!, false);
      const resolve = async (target: ArtifactsRepo, root: string) => {
        try {
          return await budget.resolve(target, root, path);
        } catch (error) {
          if (error instanceof AdmissionError && error.code === "not_found") return;
          throw error;
        }
      };
      const leftEntry = await resolve(repo, before.treeHash),
        rightEntry = await resolve(fork, after.treeHash);
      const left = leftEntry && kind(leftEntry) !== "directory" ? leftEntry : undefined,
        right = rightEntry && kind(rightEntry) !== "directory" ? rightEntry : undefined;
      if (
        (!left && !right) ||
        (left?.hash === right?.hash && left?.mode === right?.mode) ||
        kind(left ?? right!) === "directory"
      )
        fail("not_found", 404);
      const old = await budget.content(repo, left),
        next = await budget.content(fork, right);
      check();
      const status = old.status !== "text" ? old.status : next.status;
      const patch =
        status === "text"
          ? unifiedPatch(path, old.text!, next.text!, !left, !right, right?.mode ?? left?.mode)
          : undefined;
      result = {
        ...binding,
        path,
        beforeMode: left?.mode,
        afterMode: right?.mode,
        status:
          status !== "text"
            ? status
            : patch === undefined
              ? "too_large"
              : patch === ""
                ? "mode_only"
                : "text",
        ...(patch ? { patch } : {}),
      };
    } else {
      const entries: DiffEntry[] = [];
      const walk = async (
        leftHash: string | undefined,
        rightHash: string | undefined,
        prefix: string,
        depth: number,
      ): Promise<void> => {
        check();
        if (leftHash === rightHash) return;
        if (depth > SOURCE_LIMITS.depth) fail("source_limit_exceeded", 413);
        const left = leftHash ? await budget.tree(repo, leftHash) : [],
          right = rightHash ? await budget.tree(fork, rightHash) : [];
        const names = [...new Set([...left, ...right].map((item) => item.name))].sort();
        const leftMap = new Map(left.map((entry) => [entry.name, entry])),
          rightMap = new Map(right.map((entry) => [entry.name, entry]));
        for (const name of names) {
          const a = leftMap.get(name),
            b = rightMap.get(name),
            path = sourcePath(prefix ? `${prefix}/${name}` : name, false);
          if (a?.hash === b?.hash && a?.mode === b?.mode) continue;
          const aDir = a && kind(a) === "directory",
            bDir = b && kind(b) === "directory";
          if (aDir || bDir)
            await walk(aDir ? a.hash : undefined, bDir ? b.hash : undefined, path, depth + 1);
          if ((a && !aDir) || (b && !bDir))
            entries.push({
              path,
              change: !a || aDir ? "added" : !b || bDir ? "deleted" : "modified",
              beforeMode: aDir ? undefined : a?.mode,
              afterMode: bDir ? undefined : b?.mode,
            });
        }
      };
      await walk(before.treeHash, after.treeHash, "", 0);
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      result = {
        ...binding,
        ...page(entries, query.get("cursor") ?? undefined),
        total: entries.length,
        renameDetection: false,
      };
    }
    await verifySource();
    await verifyFork();
    check();
    return result;
  }
  private admit(run: Run, pinned: PublisherIdentity | undefined, source: ArtifactSource) {
    if (
      !pinned ||
      pinned.kind !== "publish" ||
      pinned.runId !== run.id ||
      pinned.sourceId !== source.name ||
      pinned.sourceRepositoryId !== source.repositoryId ||
      run.artifactAdmission?.sourceName !== source.name ||
      run.artifactAdmission.sourceRepositoryId !== source.repositoryId ||
      pinned.artifactId !== run.artifactId ||
      pinned.artifactId !==
        `pc-${this.core.state.project.id.length}-${this.core.state.project.id}-${run.id}` ||
      !pinned.artifactRepositoryId ||
      pinned.baseSha !== run.baseSha ||
      pinned.candidateSha !== run.candidateSha ||
      pinned.configurationRevision !== run.configurationRevision ||
      !sha(run.baseSha) ||
      !sha(run.candidateSha ?? "")
    )
      fail("source_unavailable", 409);
  }
}
