import { describe, expect, it } from "vite-plus/test";
import { Coordinator, initialState, type State } from "./coordinator";
import { api } from "./api";
import { resolveCatalog } from "./model-selection";
import {
  assertContractDocument,
  contractDocument,
} from "../../../packages/verification/src/index.ts";
const catalog = resolveCatalog({ EXECUTION_MODE: "fake" });

function fixture() {
  let persisted: State = initialState(),
    id = 0;
  const core = new Coordinator(
    persisted,
    (state) => {
      persisted = structuredClone(state);
    },
    () => "2026-10-06T00:00:00Z",
    () => `id${++id}`,
  );
  const thread = core.createThread("Mission", "thread");
  return {
    core,
    thread,
    reload: () =>
      new Coordinator(
        structuredClone(persisted),
        (state) => {
          persisted = structuredClone(state);
        },
        () => "2026-10-06T00:00:00Z",
        () => `id${++id}`,
      ),
  };
}

describe("mission approval", () => {
  it("requires an answer, an exact approval, and one implementation", async () => {
    const f = fixture();
    const mission = f.core.createMission(f.thread.id, "Add a greeting", "create", "alice");
    expect(f.core.state.runs).toHaveLength(0);
    expect(() => f.core.approveMission(mission.id, "missing", "approve", "alice")).toThrow(
      "mission_state",
    );
    const proposed = await f.core.answerMission(
      mission.id,
      "observable-behavior",
      "greet returns hello, pitcrew",
      "answer",
      "alice",
    );
    expect(proposed.status).toBe("proposed");
    expect(proposed.contract?.digest).toBe(proposed.proposal?.revision);
    expect(JSON.stringify(proposed.contract)).not.toContain("candidateSha");
    expect(() => f.core.approveMission(mission.id, "stale", "approve", "alice")).toThrow(
      "stale_approval",
    );
    const approved = f.core.approveMission(
      mission.id,
      proposed.proposal!.revision,
      "approve",
      "alice",
    );
    const revised = await f.core.reviseMission(
      mission.id,
      { summary: "Add a named greeting", affectedArea: "src", criterion: "returns the name" },
      "revise",
      "alice",
    );
    expect(revised.status).toBe("proposed");
    expect(revised.approvedRevision).toBeUndefined();
    expect(revised.proposal?.revision).not.toBe(approved.proposal?.revision);
    const again = f.core.approveMission(
      mission.id,
      revised.proposal!.revision,
      "approve-2",
      "alice",
    );
    const run = await f.core.startMission(mission.id, "start", "alice");
    expect(run.status).toBe("queued");
    expect(f.core.state.runs).toHaveLength(1);
    expect(await f.core.startMission(mission.id, "start", "alice")).toMatchObject({ id: run.id });
    const reloaded = f.reload();
    expect(reloaded.mission(mission.id).status).toBe("running");
    expect(reloaded.begin(run.id)?.contractSnapshot?.digest).toBe(again.contract?.digest);
    await assertContractDocument(again.contract!, contractDocument(again.contract!));
    expect(() => f.core.createMission(f.thread.id, "Another", "other", "alice")).toThrow(
      "mission_busy",
    );
  });

  it("refuses conversation delegation until the exact revision is approved", async () => {
    const f = fixture();
    const mission = f.core.createMission(f.thread.id, "Implement the button", "create", "alice");
    const turn = f.core.queueTurn(f.thread.id, "Please implement it", "turn", "alice", catalog);
    expect(turn.turn.status).toBe("queued");
    f.core.beginConversation(turn.turn.id);
    await expect(f.core.delegateApprovedMission(turn.turn.id)).rejects.toThrow(
      "mission_approval_required",
    );
    expect(f.core.state.runs).toHaveLength(0);
    const proposed = await f.core.answerMission(
      mission.id,
      mission.questions[0].id,
      "The button is reachable by keyboard",
      "answer",
      "alice",
    );
    f.core.approveMission(mission.id, proposed.proposal!.revision, "approve", "alice");
    const run = await f.core.delegateApprovedMission(turn.turn.id);
    expect(run.status).toBe("queued");
    expect(await f.core.delegateApprovedMission(turn.turn.id)).toMatchObject({ id: run.id });
    expect(f.core.state.runs).toHaveLength(1);
  });
});

it("serves the mission API without starting work before approval", async () => {
  const f = fixture();
  const app = api(f.core, () => {}, undefined, { actor: "alice" });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const created = await post("/api/projects/pitcrew/missions", {
    threadId: f.thread.id,
    request: "Add a greeting",
    idempotencyKey: "create",
  });
  expect(created.status).toBe(201);
  const mission = (await created.json()) as { id: string; questions: { id: string }[] };
  const started = await post(`/api/missions/${mission.id}/start`, { idempotencyKey: "early" });
  expect(started.status).toBe(409);
  expect(f.core.state.runs).toHaveLength(0);
});
