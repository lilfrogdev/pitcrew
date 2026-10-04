import { expect, it } from "vite-plus/test";
import { Coordinator, initialState, fakeExecution } from "./coordinator";
import { api } from "./api";
const acceptance = {
  revision: "accept-1",
  criteria: [
    { id: "behavior", text: "Related reports are retained", checkIds: ["tests", "types"] },
  ],
};
function fixture() {
  let n = 0;
  const core = new Coordinator(
    initialState(),
    () => {},
    () => "2026-10-04T00:00:00Z",
    () => `id-${++n}`,
  );
  return core;
}
it("collects and groups two originals, dispatches once atomically, and returns pinned blocked fixture evidence", async () => {
  const core = fixture();
  let wakes = 0;
  const app = api(
    core,
    async (id) => {
      wakes++;
      await core.dispatch(id, fakeExecution);
    },
    undefined,
    { actor: "trusted-owner" },
  );
  const post = async (path: string, body: unknown) =>
    app.request(`http://localhost/api/projects/pitcrew/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const one = {
    source: { system: "manual", id: "one" },
    occurredAt: "2026-10-03T00:00:00Z",
    content: "Save fails",
  };
  expect((await post("reports", one)).status).toBe(201);
  expect((await post("reports", one)).status).toBe(201);
  expect(
    (
      await post("reports", {
        ...one,
        source: { system: "manual", id: "two" },
        content: "Save also fails",
      })
    ).status,
  ).toBe(201);
  expect(core.state.runs).toHaveLength(0);
  expect(core.state.intake!.reports).toHaveLength(2);
  const [a, b] = core.groups();
  expect(
    (
      await post("intake/move", {
        idempotencyKey: "move",
        reportIds: [b.reports[0].id],
        targetGroupId: a.id,
        revisions: { [a.id]: a.revision, [b.id]: b.revision },
      })
    ).status,
  ).toBe(200);
  const group = core.groups().find((g) => g.id === a.id)!;
  const body = {
    idempotencyKey: "dispatch",
    groupId: group.id,
    revision: group.revision,
    profileRevision: core.profile().revision,
    acceptance,
  };
  expect((await post("intake/dispatch", body)).status).toBe(201);
  expect((await post("intake/dispatch", body)).status).toBe(201);
  expect(core.state.runs).toHaveLength(1);
  expect(core.state.changes).toHaveLength(1);
  expect(core.state.messages.map((m) => m.content)).toEqual(["Save fails", "Save also fails"]);
  expect(core.state.intake!.reports.every((r) => r.actor === "trusted-owner" && !!r.dispatch)).toBe(
    true,
  );
  const evidence = core.evidence(core.state.runs[0].id);
  expect(evidence.verification!.outcomes.map((o) => o.status)).toEqual(["blocked", "blocked"]);
  expect(evidence.verification!.plan.acceptance).toEqual(acceptance);
  expect(wakes).toBe(2);
  expect(
    (await post("intake/dispatch", { ...body, idempotencyKey: "stale", revision: 1 })).status,
  ).toBe(409);
  expect(
    (
      await post("intake/dispatch", {
        ...body,
        idempotencyKey: "old-profile",
        profileRevision: "obsolete",
      })
    ).status,
  ).toBe(409);
});
it("rolls back intake links, threads and changes on persistence failure", async () => {
  let fail = false,
    n = 0;
  const core = new Coordinator(
    initialState(),
    () => {
      if (fail) throw Error("storage failed");
    },
    () => "2026-10-04T00:00:00Z",
    () => `id-${++n}`,
  );
  core.receive("owner", {
    source: { system: "manual", id: "a" },
    occurredAt: "2026-10-03T00:00:00Z",
    content: "Issue",
  });
  const group = core.groups()[0];
  fail = true;
  await expect(
    core.dispatchGroup(
      "owner",
      "dispatch",
      { groupId: group.id, revision: group.revision },
      acceptance,
      core.profile().revision,
    ),
  ).rejects.toThrow("storage failed");
  expect(core.state.threads).toHaveLength(0);
  expect(core.state.runs).toHaveLength(0);
  expect(core.state.intake!.reports[0].dispatch).toBeUndefined();
});
it("replays committed dispatch across a newer profile and rejects silently attaching new sources", async () => {
  const core = fixture();
  core.receive("owner", {
    source: { system: "manual", id: "a" },
    occurredAt: "2026-10-03T00:00:00Z",
    content: "Issue",
  });
  const group = core.groups()[0],
    input = { groupId: group.id, revision: group.revision },
    revision = core.profile().revision;
  const receipt = await core.dispatchGroup("owner", "once", input, acceptance, revision);
  await core.updateProfile({ ...core.profile(), revision: "profile-v2" }, revision);
  expect(await core.dispatchGroup("owner", "once", input, acceptance, revision)).toEqual(receipt);
  core.receive("owner", {
    source: { system: "manual", id: "b" },
    occurredAt: "2026-10-03T00:00:00Z",
    content: "Later report",
  });
  const [a, b] = core.groups();
  core.move("owner", "move", {
    reportIds: [b.reports[0].id],
    targetGroupId: a.id,
    revisions: { [a.id]: a.revision, [b.id]: b.revision },
  });
  await expect(
    core.dispatchGroup(
      "owner",
      "new",
      { groupId: a.id, revision: core.groups()[0].revision },
      acceptance,
      core.profile().revision,
    ),
  ).rejects.toThrow("new_reports_require_new_change");
  expect(core.state.intake!.reports[1].dispatch).toBeUndefined();
});
it("keeps a failed check as failed and rejects stale or falsely passing evidence", async () => {
  const core = fixture();
  core.receive("owner", {
    source: { system: "manual", id: "a" },
    occurredAt: "2026-10-03T00:00:00Z",
    content: "Issue",
  });
  const group = core.groups()[0],
    receipt = await core.dispatchGroup(
      "owner",
      "once",
      { groupId: group.id, revision: group.revision },
      acceptance,
      core.profile().revision,
    );
  const input = core.begin(receipt.runId)!,
    result = await fakeExecution.delegate(input);
  result.verification!.outcomes[0] = {
    ...result.verification!.outcomes[0],
    status: "failed",
    result: {
      status: "completed",
      exitCode: 1,
      stdout: "",
      stderr: "failed assertion",
      truncated: false,
    },
  };
  const stale = structuredClone(result);
  stale.verification!.outcomes[0].checkedSha = "b".repeat(40);
  await expect(core.completeVerified(receipt.runId, stale)).rejects.toThrow(
    "invalid_verification_binding",
  );
  const falsePass = structuredClone(result);
  falsePass.verification!.outcomes[0].status = "passed";
  await expect(core.completeVerified(receipt.runId, falsePass)).rejects.toThrow(
    "invalid_verification_outcome",
  );
  await core.completeVerified(receipt.runId, result);
  expect(core.evidence(receipt.runId).verification!.outcomes[0].status).toBe("failed");
});
