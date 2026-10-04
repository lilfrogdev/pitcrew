import assert from "node:assert/strict";
import { test } from "node:test";
import { createKnowledgeHistory, HISTORY_SEEDS, HISTORY_SIZES } from "../src/knowledge-history.ts";

test("fixed seed preserves input history and the independently authored answer key", () => {
  const first = createKnowledgeHistory(1_000, 41);
  const second = createKnowledgeHistory(1_000, 41);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.records, createKnowledgeHistory(1_000, 42).records);
  assert.deepEqual(first.answerKeys, createKnowledgeHistory(1_000, 42).answerKeys);
  assert.throws(() => first.answerKeys[0].acceptedIds.push("future"), TypeError);
  assert.throws(() => (first.transitions[0].claim.text = "changed"), TypeError);
});

test("fixture rejects invalid scale and seed rather than allocating unbounded histories", () => {
  for (const size of [0, 999, 100_001, 1_000.5, NaN, Infinity])
    assert.throws(() => createKnowledgeHistory(size, 7), /invalid_history_size/);
  for (const seed of [-1, 2 ** 32, 0.5, NaN, Infinity])
    assert.throws(() => createKnowledgeHistory(1_000, seed), /invalid_history_seed/);
});

for (const size of HISTORY_SIZES) {
  for (const seed of HISTORY_SEEDS) {
    test(`${size} events seed ${seed}: keys contain only source facts visible at each cutoff`, () => {
      const history = createKnowledgeHistory(size, seed);
      assert.equal(history.records.length, size);
      assert.equal(new Set(history.records.map((record) => record.sequence)).size, size);
      assert.equal(history.records.at(-1).sequence, size);
      for (const key of history.answerKeys) {
        const visible = history.transitions.filter(
          (transition) => transition.sequence <= key.cutoff,
        );
        const sources = new Set(visible.map((transition) => transition.claim.sourceId));
        for (const source of key.requiredSources) assert.ok(sources.has(source));
        const claims = new Set(visible.map((transition) => transition.claim.id));
        for (const id of [...key.proposedIds, ...key.acceptedIds, ...key.supersededIds])
          assert.ok(claims.has(id));
        for (const id of key.forbiddenIds) assert.ok(!claims.has(id));
      }
    });
  }
}
