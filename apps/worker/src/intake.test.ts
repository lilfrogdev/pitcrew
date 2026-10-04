import { describe, expect, it } from "vite-plus/test";
import {
  associationSuggestion,
  dispatchIntake,
  initialIntake,
  intakeGroups,
  moveReports,
  receiveReport,
  type IntakeContext,
  type IntakeLink,
  type IntakeReportInput,
} from "./intake";
function fixture() {
  let serial = 0;
  let state = { intake: initialIntake(), changes: [] as (IntakeLink & { scope: string })[] };
  const c: IntakeContext = {
    scope: "private:project",
    actor: "reporter",
    now: () => "2026-10-04T00:00:00.000Z",
    id: () => `id-${++serial}`,
  };
  const input = (id: string, content = "Button broken"): IntakeReportInput => ({
    source: { system: "synthetic", id, url: "https://example.test/report" },
    content,
    occurredAt: "2026-10-03T20:00:00Z",
  });
  const adapter = {
    verifyActive: (scope: string, link: IntakeLink) => {
      if (
        !state.changes.some(
          (l) =>
            l.scope === scope &&
            l.threadId === link.threadId &&
            l.changeId === link.changeId &&
            l.runId === link.runId,
        )
      )
        throw Error("inactive_change");
    },
    create: () => {
      const link = {
        threadId: `thread-${++serial}`,
        changeId: `change-${++serial}`,
        runId: `run-${++serial}`,
      };
      state.changes.push({ ...link, scope: c.scope });
      return link;
    },
  };
  // Models the coordinator aggregate boundary, including rollback of callback writes.
  const transaction = <T>(apply: () => T, persist = () => {}) => {
    const before = structuredClone(state);
    try {
      const result = apply();
      persist();
      return result;
    } catch (error) {
      state = before;
      throw error;
    }
  };
  return { c, input, adapter, transaction, state: () => state };
}
describe("source preserving intake", () => {
  it("deduplicates redelivery across reconstruction and object property order, preserving original fields", () => {
    const f = fixture();
    const report = receiveReport(f.state().intake, f.c, f.input("delivery"));
    const copy = structuredClone(f.state().intake);
    const replay = receiveReport(
      copy,
      { ...f.c, now: () => "later" },
      {
        content: report.content,
        occurredAt: report.occurredAt,
        source: { url: report.source.url, id: report.source.id, system: report.source.system },
      },
    );
    expect(replay).toEqual(report);
    expect(copy.reports).toHaveLength(1);
    expect(copy.groups).toHaveLength(1);
    expect(() => receiveReport(copy, f.c, f.input("delivery", "changed"))).toThrow(
      "source_delivery_conflict",
    );
    expect(() => receiveReport(copy, { ...f.c, actor: "another" }, f.input("delivery"))).toThrow(
      "source_delivery_conflict",
    );
    expect(copy.reports[0]).toEqual(report);
    expect(f.state().changes).toHaveLength(0);
  });
  it("keeps concurrent distinct reporters and unrelated observations separate without execution", async () => {
    const f = fixture();
    const reports = await Promise.all(
      ["a", "b", "c"].map(async (id) =>
        f.transaction(() =>
          receiveReport(
            f.state().intake,
            { ...f.c, actor: id },
            f.input(id, id === "c" ? "Different problem" : "Button broken"),
          ),
        ),
      ),
    );
    expect(new Set(reports.map((r) => r.groupId)).size).toBe(3);
    expect(f.state().intake.reports.map((r) => r.actor)).toEqual(["a", "b", "c"]);
    expect(f.state().changes).toHaveLength(0);
  });
  it("returns evidence-backed suggestions without collapsing reports", () => {
    const f = fixture();
    const a = receiveReport(f.state().intake, f.c, f.input("a"));
    const b = receiveReport(f.state().intake, f.c, f.input("b"));
    const before = structuredClone(f.state());
    expect(
      associationSuggestion(f.state().intake, f.c.scope, {
        groupId: a.groupId,
        reportIds: [b.id],
        evidence: "Both reference the same synthetic button",
      }).reportIds,
    ).toEqual([b.id]);
    expect(f.state()).toEqual(before);
  });
  it("groups and splits explicitly with optimistic concurrency, preserving every original", () => {
    const f = fixture();
    const a = receiveReport(f.state().intake, f.c, f.input("a"));
    const b = receiveReport(f.state().intake, f.c, f.input("b"));
    const input = {
      reportIds: [b.id],
      revisions: { [a.groupId]: 1, [b.groupId]: 1 },
      targetGroupId: a.groupId,
    };
    const joined = f.transaction(() => moveReports(f.state().intake, f.c, "join", input));
    expect(f.transaction(() => moveReports(f.state().intake, f.c, "join", input))).toEqual(joined);
    expect(() => f.transaction(() => moveReports(f.state().intake, f.c, "stale", input))).toThrow(
      "group_revision_conflict",
    );
    const split = f.transaction(() =>
      moveReports(f.state().intake, f.c, "split", {
        reportIds: [b.id],
        revisions: { [a.groupId]: 2 },
        title: "Separate observation",
      }),
    );
    expect(split.id).not.toBe(a.groupId);
    for (const original of [a, b]) {
      const current = f.state().intake.reports.find((r) => r.id === original.id)!;
      expect({ ...current, groupId: original.groupId }).toEqual(original);
    }
  });
  it("dispatches once for concurrent commands and retries exact persisted receipt", async () => {
    const f = fixture();
    const a = receiveReport(f.state().intake, f.c, f.input("a"));
    const input = { groupId: a.groupId, revision: 1 };
    const results = await Promise.all(
      ["first", "second", "first"].map(async (key) =>
        f.transaction(() => dispatchIntake(f.state().intake, f.c, key, input, f.adapter)),
      ),
    );
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(f.state().changes).toHaveLength(1);
    f.state().changes.length = 0;
    expect(
      f.transaction(() => dispatchIntake(f.state().intake, f.c, "first", input, f.adapter)),
    ).toEqual(results[0]);
    expect(() =>
      f.transaction(() => dispatchIntake(f.state().intake, f.c, "new", input, f.adapter)),
    ).toThrow("inactive_change");
    expect(() =>
      f.transaction(() =>
        dispatchIntake(f.state().intake, f.c, "first", { ...input, revision: 2 }, f.adapter),
      ),
    ).toThrow("idempotency_conflict");
  });
  it("reuses a validated active change and retains its link after split", () => {
    const f = fixture();
    const a = receiveReport(f.state().intake, f.c, f.input("a"));
    const active = f.adapter.create();
    const result = f.transaction(() =>
      dispatchIntake(
        f.state().intake,
        f.c,
        "dispatch",
        { groupId: a.groupId, revision: 1, activeChange: active },
        f.adapter,
      ),
    );
    expect(result.changeId).toBe(active.changeId);
    const split = f.transaction(() =>
      moveReports(f.state().intake, f.c, "split", {
        reportIds: [a.id],
        revisions: { [a.groupId]: 1 },
        title: "Split",
      }),
    );
    const again = f.transaction(() =>
      dispatchIntake(
        f.state().intake,
        f.c,
        "redispatch",
        { groupId: split.id, revision: 1 },
        f.adapter,
      ),
    );
    expect(again.changeId).toBe(active.changeId);
    expect(f.state().changes).toHaveLength(1);
    expect(intakeGroups(f.state().intake, f.c.scope).find((g) => g.id === split.id)?.status).toBe(
      "linked",
    );
  });
  it("refuses to dispatch a changed grouping or combine different linked changes", () => {
    const f = fixture();
    const a = receiveReport(f.state().intake, f.c, f.input("a"));
    const b = receiveReport(f.state().intake, f.c, f.input("b"));
    for (const [key, report] of [
      ["a", a],
      ["b", b],
    ] as const)
      f.transaction(() =>
        dispatchIntake(
          f.state().intake,
          f.c,
          key,
          { groupId: report.groupId, revision: 1 },
          f.adapter,
        ),
      );
    f.transaction(() =>
      moveReports(f.state().intake, f.c, "join", {
        reportIds: [b.id],
        targetGroupId: a.groupId,
        revisions: { [a.groupId]: 1, [b.groupId]: 1 },
      }),
    );
    expect(() =>
      f.transaction(() =>
        dispatchIntake(
          f.state().intake,
          f.c,
          "stale",
          { groupId: a.groupId, revision: 1 },
          f.adapter,
        ),
      ),
    ).toThrow("group_revision_conflict");
    expect(() =>
      f.transaction(() =>
        dispatchIntake(
          f.state().intake,
          f.c,
          "conflict",
          { groupId: a.groupId, revision: 2 },
          f.adapter,
        ),
      ),
    ).toThrow("multiple_changes");
    expect(f.state().changes).toHaveLength(2);
  });
  it("rolls back dispatch and linkage together on failed persistence, then safely retries", () => {
    const f = fixture();
    const a = receiveReport(f.state().intake, f.c, f.input("a"));
    const apply = () =>
      dispatchIntake(
        f.state().intake,
        f.c,
        "dispatch",
        { groupId: a.groupId, revision: 1 },
        f.adapter,
      );
    expect(() =>
      f.transaction(apply, () => {
        throw Error("storage failure");
      }),
    ).toThrow("storage failure");
    expect(f.state().changes).toHaveLength(0);
    expect(f.state().intake.reports[0].dispatch).toBeUndefined();
    expect(Object.keys(f.state().intake.keys)).toHaveLength(0);
    f.transaction(apply);
    expect(f.state().changes).toHaveLength(1);
  });
  it("isolates all reads, suggestions, moves, and dispatch by trusted visibility scope", () => {
    const f = fixture();
    const a = receiveReport(f.state().intake, f.c, f.input("same"));
    const other = { ...f.c, scope: "other:private" };
    const b = receiveReport(f.state().intake, other, f.input("same"));
    expect(b.id).not.toBe(a.id);
    expect(
      intakeGroups(f.state().intake, other.scope).flatMap((g) => g.reports.map((r) => r.id)),
    ).toEqual([b.id]);
    expect(() =>
      associationSuggestion(f.state().intake, other.scope, {
        groupId: b.groupId,
        reportIds: [a.id],
        evidence: "guess",
      }),
    ).toThrow("not_found");
    expect(() =>
      f.transaction(() =>
        moveReports(f.state().intake, other, "move", {
          reportIds: [a.id],
          revisions: { [a.groupId]: 1 },
          targetGroupId: b.groupId,
        }),
      ),
    ).toThrow("not_found");
    expect(() =>
      f.transaction(() =>
        dispatchIntake(
          f.state().intake,
          other,
          "dispatch",
          { groupId: a.groupId, revision: 1 },
          f.adapter,
        ),
      ),
    ).toThrow("not_found");
  });
  it("rejects foreign-scope active links even when the change exists", () => {
    const f = fixture();
    const other = { ...f.c, scope: "other:private" };
    const report = receiveReport(f.state().intake, other, f.input("other"));
    const active = f.adapter.create();
    expect(() =>
      f.transaction(() =>
        dispatchIntake(
          f.state().intake,
          other,
          "foreign",
          { groupId: report.groupId, revision: 1, activeChange: active },
          f.adapter,
        ),
      ),
    ).toThrow("inactive_change");
    expect(f.state().intake.reports[0].dispatch).toBeUndefined();
    expect(Object.keys(f.state().intake.keys)).toHaveLength(0);
  });
  it("rejects invalid source evidence and returns detached copies", () => {
    const f = fixture();
    expect(() =>
      receiveReport(f.state().intake, f.c, { ...f.input("a"), occurredAt: "unknown" }),
    ).toThrow("invalid_timestamp");
    expect(() =>
      receiveReport(f.state().intake, f.c, {
        ...f.input("a"),
        source: { system: "test", id: "a", url: "javascript:alert(1)" },
      }),
    ).toThrow("invalid_source_url");
    const report = receiveReport(f.state().intake, f.c, f.input("a"));
    report.content = "mutated";
    const listing = intakeGroups(f.state().intake, f.c.scope);
    listing[0].reports[0].source.id = "mutated";
    expect(f.state().intake.reports[0].content).toBe("Button broken");
    expect(f.state().intake.reports[0].source.id).toBe("a");
  });
});
