import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyKnowledgePage,
  projectKnowledge,
  validKnowledge,
  KNOWLEDGE_LIMITS,
} from "../../../apps/worker/src/knowledge.ts";
import { createKnowledgeHistory } from "../src/knowledge-history.ts";
import { fixtureJournal } from "./fixture-journal.mjs";

const history = createKnowledgeHistory(1_000, 7);
const journal = fixtureJournal(history);
const proposal = journal[1];
const accepted = journal[3];

for (const [name, change] of [
  [
    "fractional cursor",
    (event) => {
      event.sequence = 2.5;
    },
  ],
  [
    "NaN cursor",
    (event) => {
      event.sequence = NaN;
    },
  ],
  [
    "infinite cursor",
    (event) => {
      event.sequence = Infinity;
    },
  ],
  [
    "unsafe cursor",
    (event) => {
      event.sequence = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "string cursor",
    (event) => {
      event.sequence = "2";
    },
  ],
  [
    "mismatched entity",
    (event) => {
      event.entityId = "different-claim";
    },
  ],
  [
    "missing event identity",
    (event) => {
      delete event.knowledge.eventId;
    },
  ],
  [
    "missing actor",
    (event) => {
      delete event.knowledge.actor;
    },
  ],
  [
    "unknown actor",
    (event) => {
      event.knowledge.actor.kind = "model";
    },
  ],
  [
    "empty actor identity",
    (event) => {
      event.knowledge.actor.id = " ";
    },
  ],
  [
    "foreign visibility",
    (event) => {
      event.knowledge.visibility = "private";
    },
  ],
  [
    "missing source base",
    (event) => {
      delete event.knowledge.baseSha;
    },
  ],
  [
    "empty configuration revision",
    (event) => {
      event.knowledge.configurationRevision = " ";
    },
  ],
]) {
  test(`journal rejects ${name} atomically`, () => {
    const event = structuredClone(proposal);
    change(event);
    const current = { revision: 0, complete: true, entries: [] };
    const before = structuredClone(current);
    assert.throws(
      () => applyKnowledgePage(current, [event], history.projectId, history.repository),
      /invalid_knowledge_history/,
    );
    assert.deepEqual(current, before);
  });
}

for (const [name, prefix, status, version, actor] of [
  ["supersession without a prior claim", [], "superseded", 1, "principal"],
  ["accepted claim downgraded to proposal", journal.slice(0, 4), "proposed", 3, "principal"],
  ["superseded claim resurrected", journal.slice(0, 504), "accepted", 4, "principal"],
  ["worker self-acceptance", journal.slice(0, 2), "accepted", 2, "worker"],
]) {
  test(`replay rejects ${name} even with the next valid version`, () => {
    const event = structuredClone(accepted);
    event.sequence = 1001;
    Object.assign(event.knowledge, { status, version, actor: { kind: actor, id: "fixture" } });
    const current = projectKnowledge(prefix, history.projectId, history.repository);
    const before = structuredClone(current);
    assert.throws(
      () => applyKnowledgePage(current, [event], history.projectId, history.repository),
      /invalid_knowledge_history/,
    );
    assert.deepEqual(current, before);
  });
}

test("valid correction replaces exact source revision and attribution without mutating the previous view", () => {
  const current = projectKnowledge(journal.slice(0, 4), history.projectId, history.repository);
  const before = structuredClone(current);
  const correction = structuredClone(accepted);
  correction.sequence = 5;
  Object.assign(correction.knowledge, {
    version: 3,
    text: "Use the corrected transport policy.",
    eventId: "principal:reviewer:correction",
    actor: { kind: "principal", id: "reviewer" },
    sourceRefs: [{ kind: "review", id: "correction-review", revision: "c".repeat(40) }],
  });
  const result = applyKnowledgePage(current, [correction], history.projectId, history.repository);
  assert.deepEqual(result.entries, [correction.knowledge]);
  result.entries[0].sourceRefs[0].revision = "mutated";
  assert.deepEqual(current, before);
  assert.equal(correction.knowledge.sourceRefs[0].revision, "c".repeat(40));
});

test("UTF-8 record limit rejects multi-byte sources even when every field fits its character limit", () => {
  const mutation = {
    ...proposal.knowledge,
    expectedVersion: 0,
    text: "界".repeat(512),
    reason: "界".repeat(256),
    sourceRefs: Array.from({ length: 8 }, (_, i) => ({
      kind: "code",
      id: String(i),
      revision: "界".repeat(200),
    })),
  };
  assert.ok(
    new TextEncoder().encode(JSON.stringify(mutation)).length > KNOWLEDGE_LIMITS.recordBytes,
  );
  assert.equal(validKnowledge(mutation), false);
});

function denseEvent(sequence, id, version, wide = false) {
  return {
    sequence,
    projectId: history.projectId,
    type: "knowledge.changed",
    entityId: id,
    createdAt: "2026-01-01T00:00:00Z",
    knowledge: {
      id,
      version,
      status: "accepted",
      kind: "constraint",
      text: wide ? "界".repeat(512) : `Correction ${version}`,
      reason: "Explicit correction",
      sourceRefs: [{ kind: "review", id: `source-${id}`, revision: `revision-${version}` }],
      eventId: `principal:owner:${sequence}`,
      actor: { kind: "principal", id: "owner" },
      projectId: history.projectId,
      repository: history.repository,
      visibility: "repository",
      baseSha: "base",
      configurationRevision: "config",
    },
  };
}

test("100,000 knowledge changes preserve the latest correction and source for all 100 claims at capacity", () => {
  const events = Array.from({ length: 100_000 }, (_, index) =>
    denseEvent(index + 1, `claim-${index % 100}`, Math.floor(index / 100) + 1),
  );
  const current = projectKnowledge(events, history.projectId, history.repository);
  assert.equal(current.revision, 100_000);
  assert.equal(current.entries.length, 100);
  for (let index = 0; index < 100; index++) {
    const entry = current.entries.find((value) => value.id === `claim-${index}`);
    assert.equal(entry.version, 1000);
    assert.equal(entry.text, "Correction 1000");
    assert.equal(entry.sourceRefs[0].revision, "revision-1000");
    assert.equal(entry.eventId, `principal:owner:${99_901 + index}`);
  }
  const before = structuredClone(current);
  assert.throws(
    () =>
      applyKnowledgePage(
        current,
        [denseEvent(100_001, "overflow", 1)],
        history.projectId,
        history.repository,
      ),
    /knowledge_projection_capacity/,
  );
  assert.deepEqual(current, before);
  const correction = denseEvent(100_001, "claim-0", 1001);
  const updated = applyKnowledgePage(current, [correction], history.projectId, history.repository);
  assert.equal(updated.entries.length, 100);
  assert.deepEqual(updated.entries[0], correction.knowledge);
});

test("projection byte capacity stops multi-byte claims before the count limit and retains every accepted claim", () => {
  let current = { revision: 0, complete: true, entries: [] };
  let overflow;
  for (let index = 0; index < KNOWLEDGE_LIMITS.entries; index++) {
    const event = denseEvent(index + 1, `wide-${index}`, 1, true);
    assert.equal(validKnowledge({ ...event.knowledge, expectedVersion: 0 }), true);
    const candidate = {
      revision: event.sequence,
      complete: true,
      entries: [...current.entries, event.knowledge],
    };
    if (
      new TextEncoder().encode(JSON.stringify(candidate)).length > KNOWLEDGE_LIMITS.projectionBytes
    ) {
      overflow = event;
      break;
    }
    current = applyKnowledgePage(current, [event], history.projectId, history.repository);
  }
  assert.ok(overflow, "must reach byte limit before 100 entries");
  assert.ok(current.entries.length < KNOWLEDGE_LIMITS.entries);
  const before = structuredClone(current);
  assert.throws(
    () => applyKnowledgePage(current, [overflow], history.projectId, history.repository),
    /knowledge_projection_capacity/,
  );
  assert.deepEqual(current, before);
  assert.ok(current.entries.every((entry) => entry.status === "accepted"));
});
