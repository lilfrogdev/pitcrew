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

  it("lets one chat reply answer every open question so the plan can be recorded", async () => {
    const f = fixture();
    const first = f.core.queueTurn(f.thread.id, "Change greet", "one", "alice", catalog);
    f.core.beginConversation(first.turn.id);
    f.core.askMission(first.turn.id, [
      "What should the tests assert?",
      "Which files change?",
      "Anything else?",
    ]);
    const followUp = f.core.queueTurn(
      f.thread.id,
      'greet() returns exactly "hello, pitcrew".',
      "two",
      "alice",
      catalog,
    );
    expect(f.core.askMission(followUp.turn.id, ["Ask again"]).questions).toHaveLength(3);
    const proposed = await f.core.proposeMission(first.turn.id, {
      summary: "Change greet",
      affectedArea: "src",
      criterion: 'greet() returns exactly "hello, pitcrew".',
    });
    expect(proposed.status).toBe("proposed");
    expect(proposed.questions.every((question) => question.answer)).toBe(true);
  });

  it("records a plan from the user request when the agent replies without one", async () => {
    const f = fixture();
    const turn = f.core.queueTurn(
      f.thread.id,
      'Change greet so it returns "hello, pitcrew".',
      "chat",
      "alice",
      catalog,
    );
    f.core.beginConversation(turn.turn.id);
    const proposed = await f.core.ensureChatProposal(turn.turn.id);
    expect(proposed?.status).toBe("proposed");
    expect(proposed?.proposal?.summary).toContain("hello, pitcrew");
    const trace = f.core.threadTrace(f.thread.id);
    expect(trace.nodes.map((node) => node.role)).toEqual(["repository", "planner"]);
    expect(trace.edges.map((edge) => edge.label)).toEqual(["Draft plan"]);
    expect(f.core.state.messages.some((message) => message.crew === "planner")).toBe(true);
    expect(await f.core.ensureChatProposal(turn.turn.id)).toBeUndefined();
    expect(f.core.threadTrace(f.thread.id).nodes).toHaveLength(2);
  });

  it("gives a new thread its own mission while another thread is still clarifying", async () => {
    const f = fixture();
    const first = f.core.createThread("First", "first");
    const second = f.core.createThread("Second", "second");
    const older = f.core.queueTurn(first.id, "Older request", "old", "alice", catalog);
    f.core.beginConversation(older.turn.id);
    f.core.askMission(older.turn.id, ["What should the tests assert?"]);
    const next = f.core.queueTurn(second.id, "Change greet to hello, pitcrew", "new", "alice", catalog);
    f.core.beginConversation(next.turn.id);
    const proposed = await f.core.proposeMission(next.turn.id, {
      summary: "Change greet",
      affectedArea: "src",
      criterion: 'greet() returns exactly "hello, pitcrew".',
    });
    expect(proposed.threadId).toBe(second.id);
    expect(proposed.status).toBe("proposed");
    expect(f.core.threadMission(first.id)?.status).toBe("clarifying");
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
    f.core.fail(run.id);
    f.core.completeConversation(turn.turn.id, "The run stopped.");
    const retry = f.core.queueTurn(f.thread.id, "Can we retry?", "retry", "alice", catalog);
    f.core.beginConversation(retry.turn.id);
    const again = await f.core.delegateApprovedMission(retry.turn.id);
    expect(again.id).not.toBe(run.id);
    expect(again.status).toBe("queued");
    expect(f.core.state.missions?.filter((item) => item.threadId === f.thread.id)).toHaveLength(1);
    expect(f.core.state.runs).toHaveLength(2);
    f.core.fail(again.id);
    f.core.completeConversation(retry.turn.id, "Stopped again.");
    f.core.queueTurn(f.thread.id, "Something else", "other", "alice", catalog);
    expect(f.core.threadMission(f.thread.id)?.proposal?.revision).toBe(proposed.proposal!.revision);
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
