import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import type { KnowledgeSql } from "./knowledge-outbox";
import {
  RepoMemory,
  REPO_MEMORY_LIMITS,
  type RepoMemoryAccess,
  type RepoMemorySource,
} from "./repo-memory";

const access: RepoMemoryAccess = {
  projectId: "project",
  repository: "owner/repo",
  threadId: "thread",
  actor: "owner",
  allowedThreadIds: ["thread"],
  revision: "configuration-1",
};
const allow = () => true;
function source(
  id: string,
  text = "An immutable source.",
  threadId: string | null = "thread",
): RepoMemorySource {
  return {
    sourceId: id,
    projectId: access.projectId,
    repository: access.repository,
    threadId,
    kind: "message",
    date: "2026-10-09T00:00:00Z",
    text,
  };
}
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  const sql: KnowledgeSql = {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows as never };
    },
  };
  const memory = new RepoMemory(sql, (work) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return { db, memory, sql };
}

it("preserves full Unicode raw bodies, deduplicates immutable sources, and restores on-disk view and receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-memory-")),
    path = join(directory, "memory.sqlite");
  let f = fixture(path);
  try {
    const raw = "😀 Original\r\n history ".repeat(900),
      admitted = source("message", raw);
    const leaf = f.memory.append(admitted);
    f.memory.beginTurn("turn", access);
    const first = f.memory.zoom("turn", "zoom", access, allow, { nodeId: leaf.nodeId });
    expect(first.complete).toBe(false);
    expect(f.memory.append(admitted)).toEqual(leaf);
    expect(() => f.memory.append({ ...admitted, text: "replacement" })).toThrow(
      "memory_source_conflict",
    );
    expect(
      JSON.parse(
        f.sql.exec<{ body: string }>("SELECT body FROM repo_memory_sources").toArray()[0].body,
      ).text,
    ).toBe(raw);
    f.db.close();
    f = fixture(path);
    expect(f.memory.zoom("turn", "zoom", access, allow, { nodeId: leaf.nodeId })).toEqual(first);
    expect(
      f.sql.exec<{ tools: number }>("SELECT tools FROM repo_memory_turns").toArray()[0].tools,
    ).toBe(1);
    expect(f.memory.view("turn", "view", access, allow).items[0].pending).toBe(true);
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("persists a bounded binary cover of every source while keeping recent leaf ranges", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 256; i++)
      f.memory.append(source(`message-${i}`, `Source ${i} ${"context ".repeat(60)}`));
    const rows = f.sql
      .exec<{ first: number; level: number; position: number }>(
        "SELECT v.first,n.level,n.position FROM repo_memory_view v JOIN repo_memory_nodes n ON n.id=v.node_id ORDER BY v.first",
      )
      .toArray();
    expect(rows).toHaveLength(REPO_MEMORY_LIMITS.viewParts);
    let end = 0;
    for (const row of rows) {
      expect(row.first).toBe(end);
      end += 2 ** row.level;
    }
    expect(end).toBe(256);
    expect(rows.at(-1)?.level).toBe(0);
    expect(rows.at(-1)?.first).toBe(255);
    f.memory.beginTurn("turn", access);
    const page = f.memory.view("turn", "page-one", access, allow, { limit: 16 });
    expect(page.complete).toBe(false);
    expect(page.next).toBe(16);
    const tail = f.memory.view("turn", "page-two", access, allow, { offset: page.next, limit: 16 });
    expect(tail.complete).toBe(true);
    expect(tail.items.at(-1)?.sourceRefs[0]).toMatchObject({ first: 255, last: 256 });
    expect(
      f.sql.exec<{ n: number }>("SELECT count(*) AS n FROM repo_memory_nodes").toArray()[0].n,
    ).toBe(511);
  } finally {
    f.db.close();
  }
});

it("validates compressors by UTF8 bytes, binds exact inputs, and never changes raw history", async () => {
  const f = fixture();
  try {
    const admitted = source("long", "Original unabridged observation. ".repeat(40));
    f.memory.append(admitted);
    f.memory.beginTurn("turn", access);
    const job = await f.memory.nextCompression("turn", "compress", access, allow);
    expect(job?.source).toBe(admitted.text);
    expect(job?.inputId).toMatch(/^[a-f0-9]{64}$/);
    expect(job?.merge).toBe(false);
    for (const text of [
      "",
      "   ",
      "😀".repeat(129),
      "x".repeat(513),
      "bad\u0000",
      "\ud800",
      "multiple\nlines",
      "carriage\rreturn",
    ]) {
      expect(() =>
        f.memory.acceptSummary("turn", "compress", access, allow, { ...job!, text }),
      ).toThrow("invalid_memory_summary");
    }
    expect(() =>
      f.memory.acceptSummary("turn", "compress", access, allow, {
        ...job!,
        inputId: "forged",
        text: "Short summary.",
      }),
    ).toThrow("invalid_memory_claim");
    f.memory.acceptSummary("turn", "compress", access, allow, { ...job!, text: "Short summary." });
    f.memory.acceptSummary("turn", "compress", access, allow, { ...job!, text: "Short summary." });
    expect(() =>
      f.memory.acceptSummary("turn", "compress", access, allow, {
        ...job!,
        text: "Changed summary.",
      }),
    ).toThrow("memory_summary_conflict");
    expect(f.memory.view("turn", "view", access, allow).items[0]).toMatchObject({
      text: "Short summary.",
      pending: false,
    });
    expect(
      JSON.parse(
        f.sql.exec<{ body: string }>("SELECT body FROM repo_memory_sources").toArray()[0].body,
      ),
    ).toEqual(admitted);
  } finally {
    f.db.close();
  }
});

it("builds merges only from two ready children and retains complete descendant provenance", async () => {
  const f = fixture();
  try {
    f.memory.append(source("one", "a".repeat(400)));
    f.memory.append(source("two", "b".repeat(400)));
    f.memory.beginTurn("turn", access);
    const merge = await f.memory.nextCompression("turn", "compress", access, allow);
    expect(merge?.merge).toBe(true);
    expect(merge?.source).toBe(`${"a".repeat(400)}\n${"b".repeat(400)}`);
    expect(merge?.sourceRefs[0]).toMatchObject({ first: 0, last: 2 });
    const visited: string[] = [];
    f.memory.assertReferences(
      access,
      (ref) => {
        visited.push(ref.sourceId);
        return true;
      },
      merge!.sourceRefs,
    );
    expect(visited).toEqual(["one", "two"]);
    f.memory.acceptSummary("turn", "compress", access, allow, {
      ...merge!,
      text: "Both earlier observations.",
    });
    const children = f.memory.zoom("turn", "zoom", access, allow, { nodeId: merge!.nodeId });
    expect(children.items.map((item) => item.text)).toEqual(["a".repeat(400), "b".repeat(400)]);
  } finally {
    f.db.close();
  }
});

it("fences private threads, project/repository collisions, and revocation of cached results and summaries", async () => {
  const f = fixture();
  try {
    const publicLeaf = f.memory.append(source("same", "a".repeat(700))),
      privateLeaf = f.memory.append(
        source("same", "Private thread password observation.", "private"),
      );
    const otherLeaf = f.memory.append({
      ...source("same", "Other repository."),
      repository: "other/repo",
    });
    f.memory.beginTurn("turn", access);
    const job = await f.memory.nextCompression("turn", "compress", access, allow);
    f.memory.acceptSummary("turn", "compress", access, allow, {
      ...job!,
      text: "Visible public history.",
    });
    expect(f.memory.view("turn", "view", access, allow).items).toHaveLength(1);
    expect(() =>
      f.memory.zoom("turn", "private", access, allow, { nodeId: privateLeaf.nodeId }),
    ).toThrow("memory_access_denied");
    expect(() =>
      f.memory.zoom("turn", "other", access, allow, { nodeId: otherLeaf.nodeId }),
    ).toThrow("memory_access_denied");
    expect(() =>
      f.memory.zoom("turn", "raw", access, () => false, { nodeId: publicLeaf.nodeId }),
    ).toThrow("memory_access_denied");
    expect(() => f.memory.view("turn", "view", access, () => false)).toThrow(
      "memory_access_denied",
    );
    expect(() =>
      f.memory.acceptSummary("turn", "compress", access, () => false, {
        ...job!,
        text: "Visible public history.",
      }),
    ).toThrow("memory_access_denied");
    expect(() =>
      f.memory.assertReferences(access, allow, [{ ...job!.sourceRefs[0], sourceId: "forged" }]),
    ).toThrow("memory_access_denied");
    expect(() =>
      f.memory.assertReferences(access, allow, [{ ...job!.sourceRefs[0], last: 3 }]),
    ).toThrow("invalid_memory_reference");
  } finally {
    f.db.close();
  }
});

it("rechecks every descendant against destination audience safety, even for a requester belonging to both threads", () => {
  const f = fixture(),
    crossAccess = { ...access, allowedThreadIds: ["thread", "private"] };
  try {
    f.memory.append(source("public"));
    const secret = f.memory.append(source("private", "Confidential.", "private"));
    f.memory.beginTurn("turn", crossAccess);
    const audienceSafe = (ref: { threadId: string | null }) => ref.threadId !== "private";
    expect(() =>
      f.memory.zoom("turn", "private", crossAccess, audienceSafe, { nodeId: secret.nodeId }),
    ).toThrow("memory_access_denied");
    const found = f.memory.search("turn", "search", crossAccess, audienceSafe, {
      query: "Confidential",
    });
    expect(found.items).toEqual([]);
  } finally {
    f.db.close();
  }
});

it("searches a fixed raw-source page and returns an explicit cursor for old matches", () => {
  const f = fixture();
  try {
    f.memory.append(source("old", "A rare historical constraint."));
    for (let i = 0; i < 140; i++) f.memory.append(source(`recent-${i}`, "Unrelated recent work."));
    f.memory.beginTurn("turn", access);
    const first = f.memory.search("turn", "search-first", access, allow, { query: "rare" });
    expect(first.items).toEqual([]);
    expect(first.complete).toBe(false);
    expect(first.next).toBeDefined();
    const next = f.memory.search("turn", "search-next", access, allow, {
      query: "rare",
      before: first.next,
    });
    expect(next.complete).toBe(true);
    expect(next.items[0].text).toContain("rare historical");
    expect(next.items[0].sourceRefs[0].sourceId).toBe("old");
  } finally {
    f.db.close();
  }
});

it("preserves surrogate pairs at zoom page boundaries and supports oversized uncompressed sources", async () => {
  const f = fixture();
  try {
    const text = "😀".repeat(17000),
      leaf = f.memory.append(source("oversized", text));
    f.memory.beginTurn("turn", access);
    expect(await f.memory.nextCompression("turn", "compress", access, allow)).toBeUndefined();
    const first = f.memory.zoom("turn", "first", access, allow, { nodeId: leaf.nodeId, limit: 1 });
    expect(first.items[0].text).toBe("😀");
    expect(first.next).toBe(2);
    const tail = f.memory.zoom("turn", "tail", access, allow, {
      nodeId: leaf.nodeId,
      offset: 33998,
      limit: 2,
    });
    expect(tail.items[0].text).toBe("😀");
    expect(tail.complete).toBe(true);
  } finally {
    f.db.close();
  }
});

it("persists dispatch and tool caps through crash/restart without double-dispatching a lost claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-memory-budget-")),
    path = join(directory, "memory.sqlite");
  let f = fixture(path);
  try {
    f.memory.append(source("long", "x".repeat(800)));
    f.memory.beginTurn("turn", access, { maxToolCalls: 2, maxCompressions: 1 });
    const job = await f.memory.nextCompression("turn", "compress", access, allow);
    expect(job).toBeDefined();
    f.db.close();
    f = fixture(path);
    expect(await f.memory.nextCompression("turn", "compress", access, allow)).toBeUndefined();
    await expect(f.memory.nextCompression("turn", "retry", access, allow)).rejects.toThrow(
      "memory_turn_budget",
    );
    expect(() =>
      f.memory.beginTurn("turn", access, { maxToolCalls: 4, maxCompressions: 2 }),
    ).toThrow("memory_turn_conflict");
    f.memory.acceptSummary("turn", "compress", access, allow, {
      ...job!,
      text: "Accepted after restart.",
    });
    f.memory.view("turn", "view", access, allow);
    expect(() => f.memory.view("turn", "overflow", access, allow)).toThrow("memory_turn_budget");
    expect(
      f.sql
        .exec<{ tools: number; compressions: number }>(
          "SELECT tools,compressions FROM repo_memory_turns",
        )
        .toArray()[0],
    ).toMatchObject({ tools: 2, compressions: 1 });
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("counts empty polling and failed retrieval durably, while idempotent replay never resets caps", async () => {
  const f = fixture();
  try {
    const leaf = f.memory.append(source("one"));
    f.memory.beginTurn("turn", access, { maxToolCalls: 2, maxOutputBytes: 0 });
    expect(await f.memory.nextCompression("turn", "poll", access, allow)).toBeUndefined();
    expect(await f.memory.nextCompression("turn", "poll", access, allow)).toBeUndefined();
    expect(() => f.memory.zoom("turn", "failed", access, allow, { nodeId: leaf.nodeId })).toThrow(
      "memory_turn_budget",
    );
    expect(() => f.memory.zoom("turn", "failed", access, allow, { nodeId: leaf.nodeId })).toThrow(
      "memory_turn_budget",
    );
    expect(() => f.memory.view("turn", "overflow", access, allow)).toThrow("memory_turn_budget");
    expect(
      f.sql
        .exec<{ tools: number; output: number }>("SELECT tools,output FROM repo_memory_turns")
        .toArray()[0],
    ).toMatchObject({ tools: 2, output: 0 });
  } finally {
    f.db.close();
  }
});

it("rejects malformed ranges, access changes, budget increases, and source capacity without mutating raw records", () => {
  const f = fixture();
  try {
    const leaf = f.memory.append(source("one"));
    f.memory.beginTurn("turn", access, { maxToolCalls: 3 });
    expect(() =>
      f.memory.zoom("turn", "bad-offset", access, allow, { nodeId: leaf.nodeId, offset: -1 }),
    ).toThrow("invalid_memory_range");
    expect(() => f.memory.view("turn", "changed", { ...access, actor: "attacker" }, allow)).toThrow(
      "memory_turn_conflict",
    );
    expect(() =>
      f.memory.beginTurn("turn", { ...access, revision: "changed" }, { maxToolCalls: 3 }),
    ).toThrow("memory_turn_conflict");
    expect(() => f.memory.beginTurn("bad-budget", access, { maxCompressions: 100 })).toThrow(
      "invalid_memory_range",
    );
    expect(() =>
      f.memory.append(source("oversized", "a".repeat(REPO_MEMORY_LIMITS.sourceBytes + 1))),
    ).toThrow("invalid_memory_source");
    expect(
      f.sql.exec<{ n: number }>("SELECT count(*) AS n FROM repo_memory_sources").toArray()[0].n,
    ).toBe(1);
  } finally {
    f.db.close();
  }
});

it("rolls back source, binary nodes, and view together on a storage failure", () => {
  const f = fixture();
  try {
    f.db.exec(
      "CREATE TRIGGER fail_view BEFORE INSERT ON repo_memory_view BEGIN SELECT RAISE(ABORT,'disk failure'); END",
    );
    expect(() => f.memory.append(source("one"))).toThrow("disk failure");
    expect(
      f.sql.exec<{ n: number }>("SELECT count(*) AS n FROM repo_memory_sources").toArray()[0].n,
    ).toBe(0);
    expect(
      f.sql.exec<{ n: number }>("SELECT count(*) AS n FROM repo_memory_nodes").toArray()[0].n,
    ).toBe(0);
    f.db.exec("DROP TRIGGER fail_view");
    expect(f.memory.append(source("one")).index).toBe(0);
  } finally {
    f.db.close();
  }
});

it("caps uncertain compressor attempts across new turns and retains zoomable original history", async () => {
  const f = fixture();
  try {
    const leaf = f.memory.append(source("long", "Long original observation. ".repeat(60)));
    for (const turn of ["first", "second"]) {
      f.memory.beginTurn(turn, access);
      expect(await f.memory.nextCompression(turn, "dispatch", access, allow)).toBeDefined();
    }
    f.memory.beginTurn("third", access);
    expect(await f.memory.nextCompression("third", "dispatch", access, allow)).toBeUndefined();
    expect(
      f.memory.zoom("third", "raw", access, allow, { nodeId: leaf.nodeId }).items[0].text,
    ).toContain("Long original");
    expect(
      f.sql
        .exec<{ attempts: number; ready: number }>("SELECT attempts,ready FROM repo_memory_nodes")
        .toArray()[0],
    ).toMatchObject({ attempts: 2, ready: 0 });
  } finally {
    f.db.close();
  }
});

it("freezes source sequence at turn admission and expands mixed later covers without leaking future messages", async () => {
  const f = fixture();
  try {
    const first = f.memory.append(source("past", "An admitted historical constraint."));
    f.memory.beginTurn("old-turn", access);
    let future = first;
    for (let i = 0; i < 130; i++)
      future = f.memory.append(source(`future-${i}`, "Future confidential queued request."));
    const page = f.memory.view("old-turn", "view", access, allow);
    expect(page.complete).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].nodeId).toBe(first.nodeId);
    expect(page.items[0].text).toContain("historical constraint");
    expect(f.memory.search("old-turn", "search", access, allow, { query: "Future" })).toEqual({
      items: [],
      complete: true,
    });
    expect(() =>
      f.memory.zoom("old-turn", "future", access, allow, { nodeId: future.nodeId }),
    ).toThrow("memory_access_denied");
    const ref = {
      scopeId: JSON.stringify([access.projectId, access.repository, access.threadId]),
      first: 130,
      last: 131,
    };
    expect(() => f.memory.assertTurnReferences("old-turn", access, allow, [ref])).toThrow(
      "memory_access_denied",
    );
    expect(() => f.memory.assertReferences(access, allow, [ref])).not.toThrow();
    f.memory.beginTurn("new-turn", access);
    expect(
      f.memory.search("new-turn", "search", access, allow, { query: "Future", limit: 1 }).items,
    ).toHaveLength(1);
    expect(
      await f.memory.nextCompression("old-turn", "compression", access, allow),
    ).toBeUndefined();
  } finally {
    f.db.close();
  }
});

it("expands a mixed summary into only safe descendants for an authoritative source whitelist", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 64; i++) f.memory.append(source(`source-${i}`, `Raw source ${i}.`));
    f.memory.beginTurn("turn", access);
    const page = f.memory.view(
      "turn",
      "view",
      access,
      (ref) => ref.sourceId === "source-0" || ref.sourceId === "source-63",
    );
    expect(page.items.map((item) => item.text)).toEqual(["Raw source 0.", "Raw source 63."]);
    expect(
      page.items.flatMap((item) => item.sourceRefs).map((ref) => [ref.first, ref.last]),
    ).toEqual([
      [0, 1],
      [63, 64],
    ]);
  } finally {
    f.db.close();
  }
});

it("fails explicitly on missing, overlapping, or invalid persisted cover without changing the raw journal", () => {
  for (const corruption of [
    "UPDATE repo_memory_view SET node_id='missing'",
    "UPDATE repo_memory_view SET first=7",
    "DELETE FROM repo_memory_view",
    "UPDATE repo_memory_nodes SET text='corrupt',level=12",
  ]) {
    const f = fixture();
    try {
      f.memory.append(source("one"));
      f.memory.beginTurn("turn", access);
      const before = f.sql.exec<{ body: string }>("SELECT body FROM repo_memory_sources").toArray();
      f.db.exec(corruption);
      expect(() => new RepoMemory(f.sql, (work) => work())).toThrow("invalid_memory_layout");
      expect(() => f.memory.view("turn", "view", access, allow)).toThrow("invalid_memory_layout");
      expect(
        f.sql.exec<{ body: string }>("SELECT body FROM repo_memory_sources").toArray(),
      ).toEqual(before);
    } finally {
      f.db.close();
    }
  }
});

it("enforces an append-only raw table and authorizes overlapping aggregate ranges once per original source", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 64; i++) f.memory.append(source(`source-${i}`, `Observation ${i}.`));
    expect(() => f.db.exec("UPDATE repo_memory_sources SET body='replaced'")).toThrow(
      "memory_source_immutable",
    );
    expect(() => f.db.exec("DELETE FROM repo_memory_sources")).toThrow("memory_source_immutable");
    const scopeId = JSON.stringify([access.projectId, access.repository, access.threadId]);
    const refs = Array.from({ length: 128 }, (_, i) => ({
      scopeId,
      first: 0,
      last: i % 2 ? 64 : 32,
    }));
    let scanned = 0;
    f.memory.assertReferences(
      access,
      () => {
        scanned++;
        return true;
      },
      refs,
    );
    expect(scanned).toBe(64);
    expect(
      f.sql.exec<{ n: number }>("SELECT count(*) AS n FROM repo_memory_sources").toArray()[0].n,
    ).toBe(64);
  } finally {
    f.db.close();
  }
});

it("revalidates a frozen brief for another current reader without granting that reader original turn tools or claims", async () => {
  const f = fixture();
  try {
    f.memory.append(source("past", "An original observation. ".repeat(60)));
    const alice = {
      ...access,
      actor: "alice",
      allowedThreadIds: ["thread", "unused-original-scope"],
    };
    const bob = { ...access, actor: "bob", allowedThreadIds: ["thread", "extra-current-scope"] };
    f.memory.beginTurn("alice-turn", alice);
    const claim = await f.memory.nextCompression("alice-turn", "compression", alice, allow);
    const page = f.memory.view("alice-turn", "view", alice, allow);
    const refs = page.items.flatMap((item) => item.sourceRefs);
    const before = f.sql.exec("SELECT * FROM repo_memory_turns").toArray();
    const actors: string[] = [];
    expect(() =>
      f.memory.assertSnapshotReferences(
        "alice-turn",
        bob,
        (ref, current) => {
          actors.push(current.actor);
          return ref.threadId === "thread" && current.actor === "bob";
        },
        refs,
      ),
    ).not.toThrow();
    expect(actors).toEqual(["bob"]);
    expect(() => f.memory.assertTurnReferences("alice-turn", bob, allow, refs)).toThrow(
      "memory_turn_conflict",
    );
    expect(() => f.memory.view("alice-turn", "bob-view", bob, allow)).toThrow(
      "memory_turn_conflict",
    );
    await expect(
      f.memory.nextCompression("alice-turn", "bob-compression", bob, allow),
    ).rejects.toThrow("memory_turn_conflict");
    expect(() =>
      f.memory.acceptSummary("alice-turn", "compression", bob, allow, {
        ...claim!,
        text: "A shorter summary.",
      }),
    ).toThrow("memory_turn_conflict");
    expect(() => f.memory.beginTurn("alice-turn", bob)).toThrow("memory_turn_conflict");
    expect(f.sql.exec("SELECT * FROM repo_memory_turns").toArray()).toEqual(before);
  } finally {
    f.db.close();
  }
});

it("keeps saved snapshot revision, project, repository, destination, source scopes and exact cutoff while rechecking current ACL", () => {
  const f = fixture();
  try {
    f.memory.append(source("past"));
    f.memory.append(source("outside-original-scope", "An unrelated older source.", "extra"));
    const alice = { ...access, actor: "alice" },
      bob = { ...access, actor: "bob", allowedThreadIds: ["thread", "extra"] };
    f.memory.beginTurn("alice-turn", alice);
    const refs = f.memory
      .view("alice-turn", "view", alice, allow)
      .items.flatMap((item) => item.sourceRefs);
    f.memory.append(source("future", "A later queued observation."));
    expect(() => f.memory.assertSnapshotReferences("alice-turn", bob, allow, refs)).not.toThrow();
    expect(() => f.memory.assertSnapshotReferences("alice-turn", bob, () => false, refs)).toThrow(
      "memory_access_denied",
    );
    const currentMissingSourceScope = { ...bob, allowedThreadIds: ["extra"] };
    expect(() =>
      f.memory.assertSnapshotReferences("alice-turn", currentMissingSourceScope, allow, refs),
    ).toThrow("memory_access_denied");
    for (const changed of [
      { ...bob, projectId: "foreign" },
      { ...bob, repository: "foreign/repo" },
      { ...bob, threadId: "foreign-destination" },
      { ...bob, revision: "configuration-2" },
    ]) {
      expect(() => f.memory.assertSnapshotReferences("alice-turn", changed, allow, refs)).toThrow(
        "memory_snapshot_conflict",
      );
    }
    expect(() => f.memory.assertSnapshotReferences("missing", bob, allow, refs)).toThrow(
      "memory_snapshot_conflict",
    );
    const scopeId = JSON.stringify([access.projectId, access.repository, access.threadId]);
    expect(() =>
      f.memory.assertSnapshotReferences("alice-turn", bob, allow, [
        { scopeId, first: 1, last: 2, sourceId: "future" },
      ]),
    ).toThrow("memory_access_denied");
    const extraScope = JSON.stringify([access.projectId, access.repository, "extra"]);
    expect(() =>
      f.memory.assertSnapshotReferences("alice-turn", bob, allow, [
        { scopeId: extraScope, first: 0, last: 1 },
      ]),
    ).toThrow("memory_access_denied");
  } finally {
    f.db.close();
  }
});

it("restores the original snapshot cutoff and current-reader checks after SQLite restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-memory-snapshot-")),
    path = join(directory, "memory.sqlite");
  let f = fixture(path);
  try {
    const alice = { ...access, actor: "alice" },
      bob = { ...access, actor: "bob" };
    f.memory.append(source("old"));
    f.memory.beginTurn("alice-turn", alice);
    const refs = f.memory
      .view("alice-turn", "view", alice, allow)
      .items.flatMap((item) => item.sourceRefs);
    f.memory.append(source("new"));
    f.db.close();
    f = fixture(path);
    expect(() => f.memory.assertSnapshotReferences("alice-turn", bob, allow, refs)).not.toThrow();
    expect(() => f.memory.assertSnapshotReferences("alice-turn", bob, () => false, refs)).toThrow(
      "memory_access_denied",
    );
    expect(() =>
      f.memory.assertSnapshotReferences("alice-turn", bob, allow, [
        { ...refs[0], first: 1, last: 2 },
      ]),
    ).toThrow("memory_access_denied");
    expect(() => f.memory.view("alice-turn", "bob-view", bob, allow)).toThrow(
      "memory_turn_conflict",
    );
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
