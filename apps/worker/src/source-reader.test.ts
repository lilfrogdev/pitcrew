import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Run, SourceTree, SourceFile, SourceDiff, SourcePatch } from "@pitcrew/protocol";
import type { PublisherIdentity } from "../../../packages/execution/src/trusted-publisher";
import { SourceReader, sourcePath, unifiedPatch, SOURCE_LIMITS } from "./source-reader";
import { Coordinator, initialState } from "./coordinator";
import { Collaboration } from "./collaboration";
import { api } from "./api";
const a = "a".repeat(40),
  b = "b".repeat(40),
  rootA = "c".repeat(40),
  rootB = "d".repeat(40),
  oldBlob = "e".repeat(40),
  newBlob = "f".repeat(40),
  folder = "1".repeat(40);
const entry = (name: string, hash = oldBlob, mode = "100644"): ArtifactsTreeEntry => ({
  name,
  hash,
  mode,
  type: mode === "40000" ? "tree" : mode === "160000" ? "gitlink" : "blob",
});
function fixture() {
  const core = new Coordinator(initialState({ baseSha: a }), () => {});
  const thread = core.createThread("source", "source-test");
  const owner = { actor: "owner", email: "owner@example.com" };
  const access = new Collaboration(core, owner, owner.email);
  access.bootstrap();
  const artifactId = `pc-${core.state.project.id.length}-${core.state.project.id}-run`;
  const run: Run = {
    id: "run",
    threadId: thread.id,
    status: "awaiting_review",
    baseSha: a,
    candidateSha: b,
    configurationRevision: core.state.project.configurationRevision,
    artifactId,
    artifactAdmission: {
      sourceName: "source",
      sourceRepositoryId: "source-id",
      fingerprint: "test",
      deadline: 123,
    },
  };
  core.state.runs.push(run);
  let published: PublisherIdentity | undefined = {
    kind: "publish",
    operationId: "publish:run",
    runId: "run",
    repositoryAgentName: "pitcrew",
    admissionFingerprint: "test",
    artifactId,
    artifactRepositoryId: "fork-id",
    artifactRemote: `https://fixture.artifacts.cloudflare.net/git/ns/${artifactId}.git`,
    sourceId: "source",
    sourceRepositoryId: "source-id",
    sourceRemote: "https://fixture.artifacts.cloudflare.net/git/ns/source.git",
    baseSha: a,
    candidateSha: b,
    configurationRevision: run.configurationRevision,
    deadline: 123,
    bundleDigest: "0".repeat(64),
    authorization: "never-return-this-secret",
  };
  const source = { name: "source", repositoryId: "source-id" };
  const calls: string[] = [];
  let hook: ((method: string) => void) | undefined;
  let head = a;
  const infos = {
    source: {
      id: "source-id",
      name: "source",
      defaultBranch: "main",
      remote: "https://fixture.artifacts.cloudflare.net/git/ns/source.git",
      source: null,
    },
    fork: {
      id: "fork-id",
      name: artifactId,
      defaultBranch: "main",
      remote: `https://fixture.artifacts.cloudflare.net/git/ns/${artifactId}.git`,
      source: "artifacts:ns/source",
    },
  };
  const trees = new Map([
    [
      rootA,
      [
        entry("README.md"),
        entry("src", folder, "40000"),
        entry("link", newBlob, "120000"),
        entry("sub", newBlob, "160000"),
      ],
    ],
    [
      rootB,
      [entry("README.md", newBlob), entry("src", folder, "40000"), entry("added.txt", oldBlob)],
    ],
    [folder, [entry("app.ts")]],
  ]);
  const blobs = new Map([
    [oldBlob, new Blob(["hello\nold\n"])],
    [newBlob, new Blob(["hello\nnew\n"])],
  ]);
  const observed = (method: string) => {
    calls.push(method);
    hook?.(method);
  };
  const repos = ["source", "fork"].map(
    (which) =>
      ({
        [Symbol.dispose]() {
          calls.push("dispose");
        },
        async info() {
          observed(`${which}.info`);
          return infos[which as "source"] as ArtifactsRepoInfo;
        },
        async log() {
          observed("log");
          return [{ hash: head }];
        },
        async readCommit(hash: string) {
          observed("commit");
          return [a, b].includes(hash) ? { hash, treeHash: hash === a ? rootA : rootB } : null;
        },
        async readTree(hash: string) {
          observed("tree");
          return trees.get(hash) ?? null;
        },
        async readBlob(hash: string) {
          observed("blob");
          return blobs.get(hash) ?? null;
        },
        async createToken() {
          throw Error("TOKEN_CREATION_FORBIDDEN");
        },
        async readFile() {
          throw Error("PATH_RESOLUTION_FORBIDDEN");
        },
      }) as unknown as ArtifactsRepo,
  );
  const artifacts = {
    async get(name: string) {
      observed("get");
      if (!["source", artifactId].includes(name)) throw Error("ARBITRARY_SOURCE");
      return repos[name === "source" ? 0 : 1];
    },
  };
  const reader = () =>
    new SourceReader(
      artifacts,
      core,
      access,
      () => source,
      () => published,
    );
  const read = (
    action: "tree" | "file" | "diff",
    query: Record<string, string> = {},
    instance = reader(),
  ) => instance.request(thread.id, action, new URLSearchParams(query));
  return {
    core,
    thread,
    run,
    access,
    artifacts,
    reader,
    read,
    infos,
    trees,
    blobs,
    calls,
    hook: (fn: typeof hook) => {
      hook = fn;
    },
    head: (hash: string) => {
      head = hash;
    },
    publication: (value: typeof published) => {
      published = value;
    },
  };
}
describe("authorized immutable Artifacts source reads", () => {
  it("disposes acquired handles after get-stage revocation and late timeout completion", async () => {
    const revoked = fixture();
    revoked.hook((method) => {
      if (method === "get")
        delete revoked.core.state.collaboration!.threadMembers[revoked.thread.id].owner;
    });
    await expect(revoked.read("tree")).rejects.toMatchObject({ status: 404 });
    expect(revoked.calls.filter((call) => call === "dispose")).toHaveLength(1);
    const delayed = fixture();
    const handle = await delayed.artifacts.get("source");
    let resolve!: (repo: ArtifactsRepo) => void;
    delayed.artifacts.get = () =>
      new Promise<ArtifactsRepo>((done) => {
        resolve = done;
      });
    vi.useFakeTimers();
    try {
      const pending = delayed.read("tree");
      const rejected = expect(pending).rejects.toMatchObject({
        code: "source_timeout",
        status: 503,
      });
      await vi.advanceTimersByTimeAsync(8001);
      await rejected;
      resolve(handle);
      await Promise.resolve();
      await Promise.resolve();
      expect(delayed.calls.filter((call) => call === "dispose")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fences branch metadata changes and returns diff pages and directory/file replacements", async () => {
    const stale = fixture();
    const initial = (await stale.read("tree")) as SourceTree;
    stale.hook((method) => {
      if (method === "blob") stale.infos.source.defaultBranch = "another";
    });
    await expect(
      stale.read("file", { path: "README.md", version: initial.version }),
    ).rejects.toMatchObject({ code: "source_stale" });
    const paged = fixture();
    paged.trees.set(
      rootA,
      Array.from({ length: 150 }, (_, index) => entry(`changed-${index}`, oldBlob)),
    );
    paged.trees.set(
      rootB,
      Array.from({ length: 150 }, (_, index) => entry(`changed-${index}`, newBlob)),
    );
    const first = (await paged.read("diff", { runId: "run" })) as SourceDiff;
    expect(first.total).toBe(150);
    expect(first.entries).toHaveLength(100);
    expect(
      (
        (await paged.read("diff", {
          runId: "run",
          version: first.version,
          cursor: first.cursor!,
        })) as SourceDiff
      ).entries,
    ).toHaveLength(50);
    const replaced = fixture();
    replaced.trees.set(rootB, [entry("src", newBlob)]);
    const manifest = (await replaced.read("diff", { runId: "run" })) as SourceDiff;
    expect(manifest.entries).toContainEqual({
      path: "src",
      change: "added",
      beforeMode: undefined,
      afterMode: "100644",
    });
    expect(
      (
        (await replaced.read("diff", {
          runId: "run",
          path: "src",
          version: manifest.version,
        })) as SourcePatch
      ).patch,
    ).toContain("+new");
  });

  it("navigates a real binding tree and reads exact blobs without credentials or path API", async () => {
    const f = fixture(),
      tree = (await f.read("tree")) as SourceTree;
    expect(tree.entries.map((item) => item.name)).toEqual(["README.md", "link", "src", "sub"]);
    const nested = (await f.read("tree", { path: "src", version: tree.version })) as SourceTree;
    expect(nested.entries[0].path).toBe("src/app.ts");
    const file = (await f.read("file", {
      path: "src/app.ts",
      version: tree.version,
    })) as SourceFile;
    expect(file).toMatchObject({
      text: "hello\nold\n",
      status: "text",
      sha: a,
      sourceId: "source-id",
    });
    for (const path of ["link", "sub"]) {
      const count = f.calls.filter((item) => item === "blob").length;
      expect(((await f.read("file", { path, version: tree.version })) as SourceFile).status).toBe(
        path === "link" ? "symlink" : "submodule",
      );
      expect(f.calls.filter((item) => item === "blob")).toHaveLength(count);
    }
    await expect(
      f.read("file", { path: "link/secret", version: tree.version }),
    ).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(tree)).not.toContain("remote");
  });
  it("shows admitted base/candidate patches and added/deleted files, plus modes", async () => {
    const f = fixture(),
      diff = (await f.read("diff", { runId: "run" })) as SourceDiff;
    expect(diff.entries).toEqual([
      { path: "README.md", change: "modified", beforeMode: "100644", afterMode: "100644" },
      { path: "added.txt", change: "added", beforeMode: undefined, afterMode: "100644" },
      { path: "link", change: "deleted", beforeMode: "120000", afterMode: undefined },
      { path: "sub", change: "deleted", beforeMode: "160000", afterMode: undefined },
    ]);
    const patch = (await f.read("diff", {
      runId: "run",
      path: "README.md",
      version: diff.version,
    })) as SourcePatch;
    expect(patch.patch).toContain("-old\n+new\n");
    expect(patch.baseSha).toBe(a);
    expect(patch.candidateSha).toBe(b);
    expect(JSON.stringify(diff)).not.toContain("never-return");
    f.trees.set(rootB, [entry("README.md", oldBlob, "100755")]);
    expect(
      (
        (await f.read("diff", {
          runId: "run",
          path: "README.md",
          version: diff.version,
        })) as SourcePatch
      ).status,
    ).toBe("mode_only");
  });
  it("rejects traversal, duplicate/unknown selectors and arbitrary refs", async () => {
    for (const path of [
      "..",
      "../secret",
      "/etc/passwd",
      "src/../secret",
      "src//a",
      "src\\a",
      ".git/config",
      "a\u0000b",
    ])
      expect(() => sourcePath(path, false)).toThrow();
    const f = fixture();
    for (const params of [
      new URLSearchParams("ref=main"),
      new URLSearchParams("path=a&path=b"),
      new URLSearchParams("repo=https://evil.test"),
      new URLSearchParams("cursor=100"),
    ])
      await expect(f.reader().request(f.thread.id, "tree", params)).rejects.toMatchObject({
        status: 400,
      });
  });
  it("conceals inaccessible threads/runs and rechecks revocation after every read stage", async () => {
    const stages = ["get", "source.info", "log", "commit", "tree", "blob"];
    for (const stage of stages) {
      const f = fixture(),
        tree = (await f.read("tree")) as SourceTree;
      f.hook((method) => {
        if (method === stage) delete f.core.state.collaboration!.threadMembers[f.thread.id].owner;
      });
      await expect(
        f.read("file", { path: "README.md", version: tree.version }),
      ).rejects.toMatchObject({ status: 404 });
    }
    const f = fixture();
    await expect(
      f.reader().request("inaccessible", "tree", new URLSearchParams()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.read("diff", { runId: "another-thread" })).rejects.toMatchObject({
      status: 404,
    });
    delete f.core.state.collaboration!.projectMembers.owner;
    await expect(f.read("tree")).rejects.toMatchObject({ status: 404 });
  });
  it("checks source and fork replacement, provenance and frozen publication/run tuples", async () => {
    for (const edit of [
      (f: ReturnType<typeof fixture>) => {
        f.infos.fork.id = "replacement";
      },
      (f: ReturnType<typeof fixture>) => {
        f.infos.fork.source = "artifacts:ns/other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.candidateSha = a;
      },
      (f: ReturnType<typeof fixture>) => {
        f.publication(undefined);
      },
    ]) {
      const f = fixture();
      edit(f);
      await expect(f.read("diff", { runId: "run" })).rejects.toMatchObject({ status: 409 });
    }
    const f = fixture();
    f.hook((method) => {
      if (method === "blob") f.infos.source.id = "replacement";
    });
    const tree = (await f.read("tree")) as SourceTree;
    await expect(
      f.read("file", { path: "README.md", version: tree.version }),
    ).rejects.toMatchObject({ status: 409 });
    const g = fixture();
    g.hook((method) => {
      if (method === "tree") g.run.candidateSha = a;
    });
    await expect(g.read("diff", { runId: "run" })).rejects.toMatchObject({ status: 409 });
  });
  it("fences a source head change, paginates stable trees, and fails oversized trees", async () => {
    const f = fixture();
    f.trees.set(
      rootA,
      Array.from({ length: 150 }, (_, index) => entry(`file-${String(index).padStart(3, "0")}`)),
    );
    const first = (await f.read("tree")) as SourceTree;
    expect(first.entries).toHaveLength(100);
    expect(first.cursor).toBe("100");
    expect(
      ((await f.read("tree", { version: first.version, cursor: first.cursor! })) as SourceTree)
        .entries,
    ).toHaveLength(50);
    f.head(b);
    await expect(
      f.read("file", { path: "file-000", version: first.version }),
    ).rejects.toMatchObject({ status: 409 });
    f.head(a);
    f.trees.set(
      rootA,
      Array.from({ length: 2049 }, (_, index) => entry(`file-${index}`)),
    );
    await expect(f.read("tree")).rejects.toMatchObject({ status: 413 });
  });
  it("detects binary/invalid UTF-8 and bounds blobs before decoding", async () => {
    for (const blob of [
      new Blob([new Uint8Array([0, 1])]),
      new Blob([new Uint8Array([255])]),
      new Blob(["x".repeat(SOURCE_LIMITS.fileBytes + 1)]),
      new Blob(["\n".repeat(4001)]),
    ]) {
      const f = fixture();
      f.blobs.set(oldBlob, blob);
      const tree = (await f.read("tree")) as SourceTree;
      expect(
        ((await f.read("file", { path: "README.md", version: tree.version })) as SourceFile).status,
      ).toBe(blob.size > SOURCE_LIMITS.fileBytes || blob.size === 4001 ? "too_large" : "binary");
    }
  });
  it("makes the API read-only, no-store, and propagates unavailable sources", async () => {
    const f = fixture(),
      app = api(
        f.core,
        () => {},
        undefined,
        { actor: "owner" },
        undefined,
        f.access,
        false,
        f.reader(),
      );
    const response = await app.request(`/api/threads/${f.thread.id}/source/tree`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(
      (
        await app.request(`/api/threads/${f.thread.id}/source/tree`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });
});
it("generates escaped unified paths and no-newline markers with a bounded linear hunk", () => {
  expect(unifiedPatch('a"b.ts', "old", "new")).toContain('--- "a/a\\"b.ts"');
  expect(unifiedPatch("a.ts", "old", "new")).toContain("\\ No newline at end of file");
  expect(unifiedPatch("large", "x\n".repeat(4001), "y\n")).toBeUndefined();
});

it("emits empty-file addition/deletion patches accepted by Git's parser", () => {
  for (const added of [true, false]) {
    const patch = unifiedPatch("empty.txt", "", "", added, !added)!;
    expect(execFileSync("git", ["apply", "--numstat", "-"], { input: patch }).toString()).toBe(
      "0\t0\tempty.txt\n",
    );
  }
});
