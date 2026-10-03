import type { Api, Message, Run, Snapshot, Thread } from "./api";
const baseSha = "851b619d31a4f1b769b8046a3d306122097ac036";
const candidateSha = "2a456c88e1d6489d17c1684bfb7f9e0e2a915a04";
export function createFixtureApi(): Api {
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
  return {
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
    snapshot: async (id) =>
      structuredClone(data[id] ?? { messages: [], runs: [], reviews: [], evidence: [] }),
    createThread: async (projectId, title, key) => {
      const existing = threads.find((thread) => thread.id === key);
      if (existing) return existing;
      const thread = { id: key, projectId, title };
      threads.push(thread);
      data[key] = { messages: [], runs: [], reviews: [], evidence: [] };
      return thread;
    },
    send: async (threadId, content, key) => {
      if (sent.has(key)) return;
      sent.add(key);
      const message: Message = {
        id: key,
        threadId,
        role: "user",
        content,
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
        content:
          "Your change is queued. This preview uses synthetic data; no cloud worker or model was called.",
      });
      data[threadId].runs.push(run);
    },
  };
}
