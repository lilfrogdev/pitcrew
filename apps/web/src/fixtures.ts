import type { Api, Message, Run, Snapshot, Thread, Authorization } from "./api";
import {
  validateMessageAttachments,
  selectionAttachmentCapabilities,
  type ModelChoice,
  type ModelSettings,
  type MessageAttachment,
  type Mission,
  type CrewRole,
} from "@pitcrew/protocol";
const baseSha = "851b619d31a4f1b769b8046a3d306122097ac036";
const candidateSha = "2a456c88e1d6489d17c1684bfb7f9e0e2a915a04";
const node = (stage: string, role: CrewRole, title: string, status: "passed", sequence: number) => ({
  id: `welcome:thread:${stage}`,
  threadId: "welcome",
  role,
  stage,
  status,
  title,
  summary: `${title} finished ${stage}.`,
  sequence,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
});
const edge = (from: string, to: string, label: string, sequence: number) => ({
  id: `welcome:thread:${from}->welcome:thread:${to}`,
  threadId: "welcome",
  from: `welcome:thread:${from}`,
  to: `welcome:thread:${to}`,
  label,
  sequence,
  createdAt: "2026-10-07T00:00:00.000Z",
});
export function createFixtureApi(): Api {
  const models: ModelChoice[] = [
    {
      id: "fixture",
      label: "Fixture vision (synthetic)",
      provider: "fixture",
      model: "fixture",
      efforts: ["off", "low", "medium", "high"],
      contextWindow: 524288,
      imageLimits: { maxBytes: 1048576, maxPerMessage: 4, maxPerRequest: 4 },
    },
    {
      id: "fixture-text",
      label: "Fixture text (synthetic)",
      provider: "fixture",
      model: "fixture-text",
      efforts: ["off"],
      contextWindow: 524288,
    },
  ];
  let settings: ModelSettings = { default: { modelId: "fixture", effort: "medium" } };
  const images = new Map<string, string>();
  const threads: Thread[] = [
    { id: "welcome", projectId: "pitcrew", title: "Make agent work visible" },
    { id: "recovery", projectId: "pitcrew", title: "Recover interrupted work" },
    { id: "sandbox", projectId: "playground", title: "Explore an isolated change" },
  ];
  const data: Record<string, Snapshot> = {
    welcome: {
      evidence: [
        {
          run: {
            id: "run-demo",
            threadId: "welcome",
            status: "waiting_user",
            baseSha,
            candidateSha,
            configurationRevision: "fixture-v1",
          },
          tests: {
            baseSha,
            candidateSha,
            configurationRevision: "fixture-v1",
            status: "passed",
            argv: ["synthetic-test", "--all"],
            exitCode: 0,
            stdout: "8 synthetic checks passed. 3 files changed. No live execution.",
            stderr: "",
            truncated: false,
          },
          reviews: [],
        },
      ],
      messages: [
        {
          id: "m1",
          threadId: "welcome",
          role: "user",
          content: "Show the work behind a change, from delegation to review.",
          createdAt: "2026-10-03T16:00:00Z",
        },
        {
          id: "m2",
          threadId: "welcome",
          role: "coordinator",
          content:
            "I assigned this change to worker ember in an isolated Artifacts fork. I will coordinate the work and retain repository context.",
          createdAt: "2026-10-03T16:00:03Z",
        },
        {
          id: "m3",
          threadId: "welcome",
          role: "worker",
          content:
            "Changed the conversation layout. Tool: test runner · 8 checks passed. Tool: diff inspection · 3 files changed. Synthetic evidence for this preview only.",
          createdAt: "2026-10-03T16:02:00Z",
        },
        {
          id: "m4",
          threadId: "welcome",
          role: "reviewer",
          content:
            "Reviewed the candidate against the requested behavior. The change is ready for human inspection. This is a synthetic review.",
          createdAt: "2026-10-03T16:03:00Z",
        },
      ],
      runs: [
        {
          id: "run-demo",
          threadId: "welcome",
          status: "waiting_user",
          baseSha,
          candidateSha,
          configurationRevision: "fixture-v1",
          workerId: "ember",
          artifactId: "fork-demo",
        },
      ],
      reviews: [
        {
          id: "review-demo",
          runId: "run-demo",
          decision: "approve",
          summary: "Synthetic review: layout and tests match the candidate.",
          actor: "reviewer-ash",
          baseSha,
          candidateSha,
          configurationRevision: "fixture-v1",
        },
      ],
    },
    recovery: {
      messages: [
        {
          id: "m5",
          threadId: "recovery",
          role: "coordinator",
          content:
            "Worker execution stopped. You can discuss a follow-up here without losing the previous evidence.",
          createdAt: "2026-10-03T15:30:00Z",
        },
      ],
      runs: [
        {
          id: "run-stopped",
          threadId: "recovery",
          status: "stopped",
          baseSha,
          configurationRevision: "fixture-v1",
        },
      ],
      reviews: [],
      evidence: [],
    },
    sandbox: { messages: [], runs: [], reviews: [], evidence: [] },
  };
  const sent = new Set<string>();
  const authorizations = new Map<string, Authorization>();
  const missions: Mission[] = [];
  const active = () =>
    missions.find((item) =>
      ["clarifying", "proposed", "approved", "running", "awaiting_review"].includes(item.status),
    );
  const proposalFor = (
    mission: Mission,
    summary: string,
    affectedArea: string,
    criterion: string,
  ) => {
    const revision = `rev-${summary.length}-${affectedArea}-${criterion.length}`;
    mission.proposal = {
      revision,
      digest: revision,
      summary,
      affectedArea,
      acceptance: {
        revision: "mission",
        criteria: [{ id: "behavior", text: criterion, checkIds: ["tests"] }],
      },
      checks: [
        {
          id: "tests",
          kind: "command",
          command: { argv: ["pnpm", "test"], timeoutMs: 60000, maxOutputBytes: 16384 },
        },
      ],
    };
    mission.contract = {
      version: 1,
      digest: revision,
      projectId: mission.projectId,
      missionId: mission.id,
      baseSha,
      configurationRevision: "fixture-v1",
      proposalRevision: revision,
      checks: mission.proposal.checks,
      acceptance: mission.proposal.acceptance,
    };
    mission.approvedRevision = undefined;
    mission.status = "proposed";
  };
  return {
    capabilities: async () => ({
      landing: { enabled: true, backend: "fixture" },
      composer: {
        models: structuredClone(models),
        settings: structuredClone(settings),
        conversation: true,
      },
    }),
    attachmentUrl: (_threadId, id) => images.get(id) ?? "",
    setThreadModelSelection: async (projectId, id, modelSelection) => {
      const thread = threads.find((item) => item.projectId === projectId && item.id === id);
      if (!thread) throw Error("Conversation not found.");
      thread.modelSelection = structuredClone(modelSelection);
      return structuredClone(thread);
    },
    setModelSettings: async (_projectId, next) => {
      settings = structuredClone(next);
      return structuredClone(settings);
    },
    approve: async (runId, input) => {
      const existing = authorizations.get(input.idempotencyKey);
      if (existing) return existing;
      const authorization: Authorization = {
        ...input,
        authorizationId: `fixture-${input.idempotencyKey}`,
        runId,
        expiresAt: Date.now() + 300000,
        state: "authorized",
        backend: "fixture",
      };
      authorizations.set(input.idempotencyKey, authorization);
      return authorization;
    },
    land: async (_runId, authorizationId) => {
      const authorization = [...authorizations.values()].find(
        (item) => item.authorizationId === authorizationId,
      );
      if (!authorization) throw new Error("Unknown fixture receipt");
      authorization.state = "landed";
      return {
        authorizationId,
        status: "landed",
        landedSha: authorization.candidateSha,
        backend: "fixture",
      };
    },
    reconcile: async (_runId, authorizationId) => {
      const authorization = [...authorizations.values()].find(
        (item) => item.authorizationId === authorizationId,
      );
      return {
        authorizationId,
        status: authorization?.state === "landed" ? "landed" : "uncertain",
        landedSha: authorization?.state === "landed" ? authorization.candidateSha : undefined,
        backend: "fixture",
      };
    },
    projects: async () => [
      {
        id: "pitcrew",
        name: "Pitcrew",
        repository: "lilfrogdev/pitcrew",
        baseSha,
        configurationRevision: "fixture-v1",
      },
      {
        id: "playground",
        name: "Playground",
        repository: "synthetic/example",
        baseSha,
        configurationRevision: "fixture-v1",
      },
    ],
    threads: async (id) => threads.filter((thread) => thread.projectId === id),
    setThreadArchived: async (projectId, id, archived) => {
      const thread = threads.find((item) => item.projectId === projectId && item.id === id);
      if (!thread) throw Error("Conversation not found.");
      thread.archived = archived;
      return structuredClone(thread);
    },
    latestRun: async (id) => structuredClone(data[id]?.runs.at(-1)),
    snapshot: async (id) =>
      structuredClone(data[id] ?? { messages: [], runs: [], reviews: [], evidence: [] }),
    trace: async (id) =>
      structuredClone(
        id === "welcome"
          ? {
              sequence: 4,
              probes: [],
              nodes: [
                node("request", "repository", "Repository agent", "passed", 1),
                node("plan", "planner", "Planner", "passed", 2),
                node("implement", "implementer", "Change worker", "passed", 3),
                node("review", "reviewer", "Reviewer", "passed", 4),
              ],
              edges: [
                edge("request", "plan", "Draft plan", 2),
                edge("plan", "implement", "Approved", 3),
                edge("implement", "review", "Review", 4),
              ],
            }
          : { nodes: [], edges: [], probes: [], sequence: 0 },
      ),
    createThread: async (projectId, title, key) => {
      const existing = threads.find((thread) => thread.id === key);
      if (existing) return existing;
      const thread = { id: key, projectId, title };
      threads.push(thread);
      data[key] = { messages: [], runs: [], reviews: [], evidence: [] };
      return thread;
    },
    missions: {
      current: async (threadId) =>
        [...missions].reverse().find((item) => item.threadId === threadId) ?? null,
      create: async (projectId, threadId, request) => {
        if (active()) throw Error("A mission is already active.");
        const mission: Mission = {
          id: crypto.randomUUID(),
          projectId,
          threadId,
          messageId: crypto.randomUUID(),
          status: "clarifying",
          request,
          questions: [
            {
              id: "observable-behavior",
              prompt: "What observable behavior should the tests assert?",
            },
          ],
        };
        missions.push(mission);
        return structuredClone(mission);
      },
      answer: async (missionId, questionId, reply) => {
        const mission = missions.find((item) => item.id === missionId);
        if (!mission || mission.status !== "clarifying") throw Error("Answer the question first.");
        const question = mission.questions.find((item) => item.id === questionId);
        if (!question) throw Error("Question not found.");
        question.answer = reply;
        proposalFor(mission, mission.request, "src", reply);
        return structuredClone(mission);
      },
      revise: async (missionId, input) => {
        const mission = missions.find((item) => item.id === missionId);
        if (!mission?.proposal) throw Error("Proposal not found.");
        proposalFor(mission, input.summary, input.affectedArea, input.criterion);
        return structuredClone(mission);
      },
      approve: async (missionId, revision) => {
        const mission = missions.find((item) => item.id === missionId);
        if (!mission?.proposal || mission.proposal.revision !== revision)
          throw Error("This approval is stale. Review the updated proposal.");
        mission.approvedRevision = revision;
        mission.status = "approved";
        return structuredClone(mission);
      },
      start: async (missionId) => {
        const mission = missions.find((item) => item.id === missionId);
        if (!mission || mission.status !== "approved") throw Error("Approve the plan first.");
        const run = {
          id: `run-${mission.id}`,
          threadId: mission.threadId,
          status: "awaiting_review" as const,
          baseSha,
          candidateSha,
          configurationRevision: "fixture-v1",
        };
        mission.status = "awaiting_review";
        mission.runId = run.id;
        data[mission.threadId].runs.push(run);
        data[mission.threadId].evidence.push({
          run,
          tests: {
            baseSha,
            candidateSha,
            configurationRevision: "fixture-v1",
            status: "passed",
            argv: ["pnpm", "test"],
            exitCode: 0,
            stdout: "baseline tests passed",
            stderr: "",
            truncated: false,
          },
          reviews: [
            {
              id: `review-${mission.id}`,
              runId: run.id,
              decision: "approve",
              summary: "The candidate matches the approved mission.",
              actor: "reviewer",
              baseSha,
              candidateSha,
              configurationRevision: "fixture-v1",
            },
          ],
        });
        return { mission: structuredClone(mission), run };
      },
    },
    send: async (threadId, content, key, attachments, selection = settings.default) => {
      if (sent.has(key)) return;
      const validated = validateMessageAttachments(
        attachments,
        selectionAttachmentCapabilities(models, {
          repoAgent: selection,
          implementer: settings.roles?.implementer ?? selection,
          reviewer: settings.roles?.reviewer ?? selection,
        }),
      );
      const stored: MessageAttachment[] = validated.map((attachment) => {
        if (attachment.mediaType === "text/plain") return attachment;
        const attachmentId = crypto.randomUUID();
        images.set(attachmentId, `data:${attachment.mediaType};base64,${attachment.data}`);
        return {
          id: attachment.id,
          name: attachment.name,
          mediaType: attachment.mediaType,
          attachmentId,
        };
      });
      sent.add(key);
      const message: Message = {
        id: key,
        threadId,
        role: "user",
        content,
        ...(stored.length ? { attachments: structuredClone(stored) } : {}),
        createdAt: new Date().toISOString(),
      };
      const run: Run = {
        id: `run-${key}`,
        threadId,
        status: "queued",
        baseSha,
        configurationRevision: "fixture-v1",
      };
      data[threadId].messages.push(message, {
        ...message,
        id: `agent-${key}`,
        role: "coordinator",
        attachments: undefined,
        content:
          "Your change is queued. This preview uses synthetic data; no cloud worker or model was called.",
      });
      data[threadId].runs.push(run);
    },
  };
}
