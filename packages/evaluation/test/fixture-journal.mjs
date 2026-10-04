// Test-only conversion of authored scenario facts into the canonical event wire format.
// It supplies inputs; it never derives the expected current view.
export function fixtureJournal(history) {
  return history.records.map((record) => {
    const transition = record.transition;
    const eventId = `fixture:${history.seed}:${record.sequence}`;
    const actor = transition
      ? transition.claim.sourceId.startsWith("pi-call:")
        ? { kind: "worker", id: record.runId }
        : { kind: "principal", id: "fixture-user" }
      : { kind: "application", id: "fixture-application" };
    const sourceRefs = [
      {
        kind: transition?.claim.sourceId.split(":")[0] ?? "report",
        id: record.sourceId,
        revision: transition?.claim.revision ?? record.revision,
      },
    ];
    return {
      sequence: record.sequence,
      projectId: record.projectId,
      type: transition ? "knowledge.changed" : "run.started",
      entityId: transition?.claim.id ?? record.runId,
      createdAt: new Date(Date.UTC(2026, 0, 1) + record.sequence * 1000).toISOString(),
      provenance: {
        actor,
        repository: record.repository,
        baseSha: record.revision,
        configurationRevision: "fixture-v1",
        threadId: record.threadId,
        runId: record.runId,
        sourceRefs,
      },
      ...(transition
        ? {
            knowledge: {
              id: transition.claim.id,
              status: { propose: "proposed", accept: "accepted", supersede: "superseded" }[
                transition.action
              ],
              version: { propose: 1, accept: 2, supersede: 3 }[transition.action],
              text: transition.claim.text,
              kind: "decision",
              sourceRefs,
              reason: transition.reason,
              eventId,
              actor,
              projectId: record.projectId,
              repository: record.repository,
              visibility: "repository",
              baseSha: record.revision,
              configurationRevision: "fixture-v1",
              threadId: record.threadId,
              runId: record.runId,
            },
          }
        : {}),
    };
  });
}

export function assertAnswerKey(assert, current, key) {
  assert.equal(current.complete, true);
  for (const [status, expected] of [
    ["proposed", key.proposedIds],
    ["accepted", key.acceptedIds],
    ["superseded", key.supersededIds],
  ]) {
    assert.deepEqual(
      current.entries
        .filter((entry) => entry.status === status)
        .map((entry) => entry.id)
        .sort(),
      [...expected].sort(),
      `${key.id}: ${status}`,
    );
  }
  const sourceIds = new Set(
    current.entries.flatMap((entry) => entry.sourceRefs.map((ref) => ref.id)),
  );
  for (const id of key.requiredSources) assert.ok(sourceIds.has(id), `${key.id}: source ${id}`);
  for (const id of key.forbiddenIds)
    assert.ok(!current.entries.some((entry) => entry.id === id), `${key.id}: future claim ${id}`);
}
