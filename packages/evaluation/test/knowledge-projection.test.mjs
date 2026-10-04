import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { projectKnowledge, applyKnowledgePage } from "../../../apps/worker/src/knowledge.ts";
import { createKnowledgeHistory, HISTORY_SEEDS, HISTORY_SIZES } from "../src/knowledge-history.ts";
import { fixtureJournal, assertAnswerKey } from "./fixture-journal.mjs";

for (const size of HISTORY_SIZES) {
  for (const seed of HISTORY_SEEDS) {
    test(`${size} events seed ${seed}: actual projection preserves proposals, corrections and provenance`, () => {
      const history = createKnowledgeHistory(size, seed);
      const events = fixtureJournal(history);
      for (const key of history.answerKeys) {
        // The runtime receives only source history through the question's cutoff, never keys.
        const prefix = events.slice(0, key.cutoff);
        const current = projectKnowledge(prefix, history.projectId, history.repository);
        assertAnswerKey(assert, current, key);
        for (const entry of current.entries) {
          assert.equal(entry.projectId, history.projectId);
          assert.equal(entry.repository, history.repository);
          assert.equal(entry.visibility, "repository");
          assert.ok(prefix.some((event) => event.knowledge?.eventId === entry.eventId));
          if (entry.id === "untrusted-approval") {
            assert.equal(entry.actor.kind, "worker");
            assert.equal(entry.status, "proposed");
          }
        }
      }
      let paged = { revision: 0, complete: true, entries: [] };
      for (let offset = 0; offset < events.length; offset += 256)
        paged = applyKnowledgePage(
          paged,
          events.slice(offset, offset + 256),
          history.projectId,
          history.repository,
        );
      assert.deepEqual(paged, projectKnowledge(events, history.projectId, history.repository));
    });
  }
}

test("projection keeps repository and project scopes isolated despite colliding claim IDs", () => {
  const history = createKnowledgeHistory(1_000, 7);
  const events = fixtureJournal(history);
  const foreign = structuredClone(events[1]);
  foreign.sequence = 1001;
  foreign.projectId = "foreign-project";
  foreign.knowledge.projectId = "foreign-project";
  foreign.knowledge.repository = "https://example.invalid/foreign/repo";
  foreign.knowledge.text = "Foreign repository claim must not overwrite local knowledge";
  const withForeign = [...events, foreign];
  assert.deepEqual(
    projectKnowledge(withForeign, history.projectId, history.repository).entries,
    projectKnowledge(events, history.projectId, history.repository).entries,
  );
  assert.deepEqual(projectKnowledge(events, "foreign-project", history.repository).entries, []);
  assert.deepEqual(
    projectKnowledge(events, history.projectId, "https://example.invalid/foreign/repo").entries,
    [],
  );
});

test("bounded pages reject oversize input and a corrupted version without mutating prior view", () => {
  const history = createKnowledgeHistory(1_000, 41);
  const events = fixtureJournal(history);
  const current = projectKnowledge(events.slice(0, 2), history.projectId, history.repository);
  const before = structuredClone(current);
  assert.throws(() =>
    applyKnowledgePage(current, events.slice(0, 257), history.projectId, history.repository),
  );
  const bad = structuredClone(events[3]);
  bad.knowledge.version = 99;
  assert.throws(
    () => applyKnowledgePage(current, [bad], history.projectId, history.repository),
    /invalid_knowledge_history/,
  );
  assert.deepEqual(current, before);
});

test("SQLite close/reopen retains exact event sources and resumes projection at an explicit cursor", () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-knowledge-replay-"));
  const path = join(directory, "replay.sqlite");
  const history = createKnowledgeHistory(1_000, 2026);
  const events = fixtureJournal(history);
  const cutoff = history.answerKeys[2].cutoff;
  let database;
  try {
    database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE events(sequence INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE projection(id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    const insert = database.prepare("INSERT INTO events VALUES (?, ?)");
    const first = projectKnowledge(events.slice(0, cutoff), history.projectId, history.repository);
    database.exec("BEGIN");
    for (const event of events.slice(0, cutoff)) insert.run(event.sequence, JSON.stringify(event));
    database.prepare("INSERT INTO projection VALUES(1, ?, ?)").run(cutoff, JSON.stringify(first));
    database.exec("COMMIT");
    database.close();
    database = undefined;
    database = new DatabaseSync(path);
    const row = database.prepare("SELECT cursor,body FROM projection WHERE id=1").get();
    assert.equal(row.cursor, cutoff);
    let resumed = JSON.parse(row.body);
    assertAnswerKey(assert, resumed, history.answerKeys[2]);
    const persisted = database
      .prepare("SELECT body FROM events ORDER BY sequence")
      .all()
      .map((event) => JSON.parse(event.body));
    assert.deepEqual(persisted, events.slice(0, cutoff));
    const tail = events.filter((event) => event.sequence > row.cursor);
    for (let offset = 0; offset < tail.length; offset += 256)
      resumed = applyKnowledgePage(
        resumed,
        tail.slice(offset, offset + 256),
        history.projectId,
        history.repository,
      );
    assert.deepEqual(resumed, projectKnowledge(events, history.projectId, history.repository));
    assertAnswerKey(assert, resumed, history.answerKeys.at(-1));
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
