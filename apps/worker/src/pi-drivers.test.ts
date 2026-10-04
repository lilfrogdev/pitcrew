import { describe, expect, it } from "vite-plus/test";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { configureModels } from "./pi-models";
import {
  applyChange,
  reviewCandidate,
  guardedMutation,
  bootstrapDependencies,
  type DurablePrompt,
} from "./pi-drivers";
import type {
  Workspace,
  WorkspaceTransport,
  TestEvidence,
} from "../../../packages/execution/src/contracts";
import type { ExecutionInput } from "@pitcrew/protocol";
const base = "a".repeat(40),
  candidate = "b".repeat(40);
const workspace: Workspace = {
  runId: "r1",
  projectId: "p",
  repository: "artifact-name",
  baseSha: base,
  configurationRevision: "1",
  workerId: "worker-r1",
  artifactId: "fork-r1",
};
const input: ExecutionInput = {
  runId: "r1",
  projectId: "p",
  threadId: "t1",
  repository: "artifact-name",
  baseSha: base,
  configurationRevision: "1",
  messages: [{ id: "m", threadId: "t1", role: "user", content: "fix", createdAt: "now" }],
};
function prompt(text: string): DurablePrompt {
  const keys = new Map<string, string>();
  return {
    async submit(body, options) {
      const old = keys.get(options.operationId);
      if (old && old !== body) throw Error("conflict");
      keys.set(options.operationId, body);
      return {};
    },
    async wait() {
      return { status: "done", text };
    },
  };
}
const transport: WorkspaceTransport = {
  async prepare() {},
  async readFile() {
    return "source";
  },
  async writeFile() {},
  async run() {
    throw Error("unused");
  },
  async inspect() {
    return { sha: candidate, clean: true };
  },
  async publish() {},
  async stop() {},
};
const evidence: TestEvidence = {
  runId: "r1",
  commandId: "test",
  baseSha: base,
  candidateSha: candidate,
  configurationRevision: "1",
  argv: ["test"],
  exitCode: 0,
  stdout: "passed",
  stderr: "",
  truncated: false,
  status: "completed",
};
describe("independent durable Pi drivers", () => {
  it("prepares frozen dependencies only in the isolated base checkout and rejects source changes", async () => {
    let inspected = 0;
    const commands: unknown[] = [];
    const fixture = {
      ...transport,
      inspect: async () => ({ sha: base, clean: true }),
      run: async (_workspace: Workspace, command: unknown) => {
        commands.push(command);
        return {
          status: "completed" as const,
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        };
      },
    };
    expect(await bootstrapDependencies(fixture, workspace)).toEqual({ prepared: true });
    expect(commands).toMatchObject([
      {
        argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--reporter=silent"],
        timeoutMs: 180000,
      },
    ]);
    await expect(
      bootstrapDependencies(
        {
          ...fixture,
          inspect: async () => ({ sha: ++inspected === 1 ? base : candidate, clean: true }),
        },
        workspace,
      ),
    ).rejects.toThrow("bootstrap_changed_source");
  });
  it("takes exact candidate from sandbox inspection rather than model text", async () => {
    expect(await applyChange(prompt("candidate: invented"), transport, workspace, input)).toEqual({
      candidateSha: candidate,
      summary: "candidate: invented",
    });
  });
  it("requires actual changes and clean committed source", async () => {
    await expect(
      applyChange(
        prompt("done"),
        {
          ...transport,
          async inspect() {
            return { sha: base, clean: true };
          },
        },
        workspace,
        input,
      ),
    ).rejects.toThrow("invalid_candidate");
    await expect(
      applyChange(
        prompt("done"),
        {
          ...transport,
          async inspect() {
            return { sha: candidate, clean: false };
          },
        },
        workspace,
        input,
      ),
    ).rejects.toThrow("invalid_candidate");
  });
  it("attributes independent review to exact immutable evidence", async () => {
    expect(
      await reviewCandidate(
        prompt('{"decision":"approve","summary":"checked"}'),
        workspace,
        evidence,
      ),
    ).toMatchObject({
      decision: "approve",
      candidateSha: candidate,
      baseSha: base,
      configurationRevision: "1",
      actor: "pi-reviewer:r1",
    });
  });
  it("gives the independent reviewer the pinned requested intent and worker summary", async () => {
    let submitted = "";
    const harness = prompt('{"decision":"approve","summary":"checked"}');
    const brief = { messages: input.messages, implementationSummary: "implemented fix" };
    await reviewCandidate(
      {
        ...harness,
        async submit(body, options) {
          submitted = body;
          return harness.submit(body, options);
        },
      },
      workspace,
      evidence,
      undefined,
      brief,
    );
    expect(JSON.parse(submitted).requestedChange).toEqual(brief);
    expect(JSON.parse(submitted).candidateSha).toBe(candidate);
  });
  it("rejects stale review context and failing or truncated test approval", async () => {
    await expect(
      reviewCandidate(prompt('{"decision":"approve","summary":"checked"}'), workspace, {
        ...evidence,
        runId: "other",
      }),
    ).rejects.toThrow("context_mismatch");
    await expect(
      reviewCandidate(prompt('{"decision":"approve","summary":"checked"}'), workspace, {
        ...evidence,
        truncated: true,
      }),
    ).rejects.toThrow("invalid_approval");
  });
  it("uses an injected faux model without network or ambient credentials", async () => {
    const faux = fauxProvider({ provider: "fixture", models: [{ id: "fixture" }] });
    faux.setResponses([fauxAssistantMessage("local result")]);
    const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
    const result = await models.completeSimple(model, {
      messages: [{ role: "user", content: "test", timestamp: 1 }],
    });
    expect(result.content).toMatchObject([{ type: "text", text: "local result" }]);
    expect(faux.state.callCount).toBe(1);
  });
  it("resolves the concrete Workers AI demo model through the pinned provider catalog without calling it", () => {
    let calls = 0;
    const { models, model } = configureModels(
      { provider: "cloudflare", model: "@cf/qwen/qwen3-30b-a3b-fp8" },
      {
        AI: {
          run: () => {
            calls++;
            throw Error("no paid calls");
          },
        } as unknown as Ai,
      },
    );
    expect(model.id).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(models.getModel(model.provider, model.id)).toMatchObject({ id: model.id });
    expect(calls).toBe(0);
  });
  it("fails closed for absent explicit cloud/BYOK model configuration", () => {
    expect(() => configureModels({ provider: "cloudflare", model: "@cf/example" }, {})).toThrow(
      "model_not_configured",
    );
    expect(() =>
      configureModels(
        { provider: "byok", providerId: "openai", model: "gpt-x", secretBinding: "KEY" },
        {},
      ),
    ).toThrow("model_not_configured");
  });
  it("quarantines uncertain tool mutations across new model calls and replays completed acknowledgement", async () => {
    const rows = new Map<
      string,
      { body: string; state: "pending" | "complete"; result?: unknown }
    >();
    const store = {
      read: (id: string) => rows.get(id),
      hasPending: () => [...rows.values()].some((row) => row.state === "pending"),
      start: (id: string, body: string) => {
        rows.set(id, { body, state: "pending" });
      },
      finish: (id: string, result: unknown) => {
        rows.set(id, { body: rows.get(id)!.body, state: "complete", result });
      },
    };
    let edits = 0;
    expect(await guardedMutation(store, "one", "body", async () => ++edits)).toBe(1);
    expect(await guardedMutation(store, "one", "body", async () => ++edits)).toBe(1);
    await expect(
      guardedMutation(store, "two", "body", async () => {
        edits++;
        throw Error("lost outcome");
      }),
    ).rejects.toThrow("lost outcome");
    await expect(
      guardedMutation(store, "new-model-call", "retry", async () => ++edits),
    ).rejects.toThrow("reconciliation_required");
    expect(edits).toBe(2);
  });
});
it("gives acceptance to the worker and restricts independent verification review to gaps", async () => {
  const { pinPlan, pendingOutcomes } = await import("../../../packages/verification/src/index.ts");
  const plan = await pinPlan({
    projectId: "p",
    changeId: "c",
    baseSha: base,
    candidateSha: candidate,
    configurationRevision: "1",
    profile: {
      projectId: "p",
      revision: "v1",
      checks: [
        {
          id: "behavior",
          kind: "command",
          command: { argv: ["fixture"], timeoutMs: 1000, maxOutputBytes: 1024 },
        },
      ],
    },
    acceptance: {
      revision: "a1",
      criteria: [{ id: "accept", text: "Retain source traceability", checkIds: ["behavior"] }],
    },
    reproduceBaseline: false,
  });
  let captured = "";
  const worker = prompt("committed");
  worker.submit = async (body) => {
    captured = body;
  };
  await applyChange(worker, transport, workspace, { ...input, verificationPlan: plan });
  expect(JSON.parse(captured).verificationPlan.acceptance.criteria[0].text).toBe(
    "Retain source traceability",
  );
  const outcomes = pendingOutcomes(plan).map((o) => ({
    ...o,
    status: "failed" as const,
    artifactId: workspace.artifactId,
    runId: workspace.runId,
    result: {
      status: "completed" as const,
      exitCode: 1,
      stdout: "",
      stderr: "failed",
      truncated: false,
    },
  }));
  const reviewer = prompt(JSON.stringify({ gaps: [], summary: "No additional source gaps" }));
  reviewer.submit = async (body) => {
    captured = body;
  };
  const review = await reviewCandidate(reviewer, workspace, evidence, undefined, {
    messages: input.messages,
    implementationSummary: "done",
    verification: { plan, outcomes },
  });
  expect(JSON.parse(captured).task).toContain("gaps:string[]");
  expect(review.decision).toBe("request_changes");
  expect(review.verificationGaps).toEqual(["behavior"]);
  expect(outcomes[0].status).toBe("failed");
  await expect(
    reviewCandidate(
      prompt(JSON.stringify({ decision: "approve", summary: "Override failed checks" })),
      workspace,
      evidence,
      undefined,
      { messages: input.messages, implementationSummary: "done", verification: { plan, outcomes } },
    ),
  ).rejects.toThrow("invalid_review");
});
