import { expect, it } from "vite-plus/test";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureModels } from "./pi-models";
import { knowledgeReporting } from "./knowledge-reporting";
import { KnowledgeOutbox, type KnowledgeSql } from "./knowledge-outbox";
import type { WorkerKnowledgeContext } from "@pitcrew/protocol";

const trusted: WorkerKnowledgeContext = {
  attemptId: "run",
  projectId: "project",
  repository: "repo",
  threadId: "thread",
  changeId: "change",
  runId: "run",
  baseSha: "a".repeat(40),
  configurationRevision: "1",
  contextRevision: "1",
};
it("rejects traversal and unsupported source claims before queuing any candidate note", async () => {
  const context = {
    abortSignal: AbortSignal.timeout(5000),
    value: () => undefined,
    toString: () => "[Source validation fixture]",
  };
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "fixture" }] });
  const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
  let notes = 0,
    reads = 0;
  const registry = createRegistry();
  registry.install(
    knowledgeReporting({
      context: () => trusted,
      readSource: async () => {
        reads++;
        return { text: "actual source", sha: trusted.baseSha };
      },
      enqueue: async () => {
        notes++;
      },
      flush: async () => {},
    }),
  );
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "report_knowledge",
          {
            text: "Invented",
            kind: "discovery",
            sources: [{ path: "../secret", revision: "base", excerpt: "actual source" }],
          },
          { id: "invalid-path" },
        ),
        fauxToolCall(
          "report_knowledge",
          {
            text: "Invented",
            kind: "discovery",
            sources: [{ path: "fixture.ts", revision: "base", excerpt: "not present" }],
          },
          { id: "invalid-source" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("fixture done"),
  ]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    await (
      await conversation.submit(
        { type: "input", requestId: "invalid-report", content: "validate fixture" },
        context,
      )
    ).wait(context);
    expect(notes).toBe(0);
    expect(reads).toBe(1);
    const view = await conversation.context(context);
    expect(JSON.stringify(view.messages)).toContain("invalid_knowledge_path");
    expect(JSON.stringify(view.messages)).toContain("knowledge_source_mismatch");
  } finally {
    await harness.close(context);
  }
});
it("persists an immediate source-backed proposal in real Pi/SQLite, survives restart and three synthetic manual compactions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-pi-notes-"));
  const context = {
    abortSignal: AbortSignal.timeout(10000),
    value: () => undefined,
    toString: () => "[Synthetic reporting fixture]",
  };
  const faux = fauxProvider({
    provider: "fixture",
    models: [{ id: "fixture", contextWindow: 128000 }],
  });
  const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
  let db = new DatabaseSync(join(directory, "outbox.sqlite"));
  const sql = (): KnowledgeSql => ({
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows as never };
    },
  });
  let outbox = new KnowledgeOutbox(sql());
  let flushes = 0,
    reads = 0,
    immediate = false;
  const registry = createRegistry();
  registry.install(
    knowledgeReporting({
      context: () => trusted,
      readSource: async () => {
        reads++;
        return { text: "verified constraint", sha: trusted.baseSha };
      },
      enqueue: async (note) => {
        outbox.enqueue(note);
        immediate = true;
      },
      flush: async () => {
        flushes++;
        throw Error("offline");
      },
    }),
  );
  const options = {
    models,
    registry,
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
  };
  let harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    options,
    context,
  );
  try {
    let conversation = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const draft = {
      type: "input" as const,
      requestId: "change-run",
      content: "Report a verified source constraint while working.",
    };
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "report_knowledge",
          {
            text: "Candidate constraint",
            kind: "constraint",
            sources: [{ path: "fixture.ts", revision: "base", excerpt: "verified constraint" }],
          },
          { id: "note-1" },
        ),
        { stopReason: "toolUse" },
      ),
      () => {
        expect(immediate).toBe(true);
        expect(outbox.pending()).toHaveLength(1);
        return fauxAssistantMessage("continue working " + "x".repeat(500));
      },
    ]);
    const receipt = await conversation.submit(draft, context);
    await receipt.wait(context);
    await conversation.waitForIdle(context);
    expect(faux.state.callCount).toBe(2); // Reporting introduced no extra semantic model request.
    expect(reads).toBe(1);
    const persisted = JSON.parse(outbox.pending()[0].body);
    expect(persisted.context).toEqual(trusted);
    expect(persisted.report.sourceRefs[0]).toEqual({
      kind: "code",
      id: "fixture.ts",
      revision: trusted.baseSha,
      path: "fixture.ts",
    });
    await harness.close(context);
    db.close();
    db = new DatabaseSync(join(directory, "outbox.sqlite"));
    outbox = new KnowledgeOutbox(sql());
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "pi.sqlite")),
      options,
      context,
    );
    conversation = await harness.root(context);
    const replay = await conversation.submit(draft, context);
    expect(replay.id).toBe(receipt.id);
    expect(reads).toBe(1);
    const heads: string[] = [];
    for (let i = 0; i < 3; i++) {
      faux.setResponses([fauxAssistantMessage("synthetic continued work " + "y".repeat(500))]);
      await (
        await conversation.submit(
          {
            type: "input",
            requestId: `follow-${i}`,
            content: "more fixture work " + "z".repeat(500),
          },
          context,
        )
      ).wait(context);
      const before = flushes;
      faux.setResponses([
        fauxAssistantMessage(`Synthetic summary ${i}: intentionally omit the constraint.`),
      ]);
      const task = await harness.waitForTask(
        await conversation.compact(undefined, context),
        context,
      );
      expect(task.state.status).toBe("terminal");
      await conversation.waitForIdle(context);
      const view = await conversation.context(context);
      expect(view.head).toBeDefined();
      heads.push(String(view.head!.id));
      expect(flushes).toBe(before + 1); // Real pre-compaction hook retries selected notes without replacing summary.
      expect(outbox.pending()).toHaveLength(1);
    }
    expect(new Set(heads).size).toBe(3);
    expect(faux.state.callCount).toBe(8);
    const archive = await conversation.entries({}, 100, undefined, context);
    expect(JSON.stringify(archive)).toContain("Candidate constraint");
    const row = outbox.pending()[0];
    await outbox.deliver(async () => ({ eventId: row.id, status: "recorded" }));
    expect(outbox.pending()).toHaveLength(0);
    expect(reads).toBe(1);
  } finally {
    await harness.close(context);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
