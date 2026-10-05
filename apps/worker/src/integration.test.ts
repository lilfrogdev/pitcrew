import { protectedFetch } from "./access";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { httpApi } from "../../web/src/api";
import { api } from "./api";
import { Coordinator, initialState } from "./coordinator";
import { applyChange, reviewCandidate, type DurablePrompt } from "./pi-drivers";
import {
  CloudflareExecutionAdapter,
  ExecutionCoordinator,
  type WorkspaceTransport,
  type OperationRecord,
  type Workspace,
} from "../../../packages/execution/src/index";
afterEach(() => vi.unstubAllGlobals());
it("browser API admits two concurrent isolated edits, tests and reviews exact evidence, then recovers idempotently", async () => {
  const state = initialState(),
    core = new Coordinator(state, () => {});
  const journalRecords = new Map<string, OperationRecord>();
  const journal = {
    async claim(key: string, fingerprint: string) {
      const previous = journalRecords.get(key);
      if (previous) return { claimed: false, record: previous };
      const record: OperationRecord = { fingerprint, state: "pending" };
      journalRecords.set(key, record);
      return { claimed: true, record };
    },
    async complete(key: string, fingerprint: string, result: unknown) {
      journalRecords.set(key, { fingerprint, state: "complete", result });
    },
  };
  const files = new Map<string, Map<string, string>>(),
    heads = new Map<string, string>(),
    stopped = new Set<string>();
  const published: string[] = [];
  const transport: WorkspaceTransport = {
    async prepare(workspace) {
      files.set(workspace.runId, new Map());
      heads.set(workspace.runId, workspace.baseSha);
    },
    async readFile(workspace, path) {
      return files.get(workspace.runId)!.get(path) ?? "";
    },
    async writeFile(workspace, path, content) {
      files.get(workspace.runId)!.set(path, content);
    },
    async run(workspace) {
      expect(await transport.readFile(workspace, "change.ts")).toBe(workspace.runId);
      return {
        status: "completed",
        exitCode: 0,
        stdout: "fake tests passed",
        stderr: "",
        truncated: false,
      };
    },
    async inspect(workspace) {
      return { sha: heads.get(workspace.runId)!, clean: true };
    },
    async publish(workspace, sha) {
      published.push(`${workspace.runId}:${sha}`);
    },
    async stop(workspace) {
      stopped.add(workspace.runId);
    },
  };
  let active = 0,
    peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const harness = (text: string, onSubmit?: () => Promise<void>): DurablePrompt => ({
    async submit() {
      await onSubmit?.();
      return {};
    },
    async wait() {
      return { status: "done", text };
    },
  });
  const worker = {
    async apply(
      workspace: Workspace,
      input: Parameters<CloudflareExecutionAdapter["delegate"]>[0],
    ) {
      active++;
      peak = Math.max(peak, active);
      if (active === 2) release();
      await barrier;
      await transport.writeFile(workspace, "change.ts", workspace.runId);
      heads.set(workspace.runId, workspace.runId.charCodeAt(0).toString(16).padStart(40, "0"));
      const result = await applyChange(
        harness("fixture edit committed"),
        transport,
        workspace,
        input,
      );
      active--;
      return result;
    },
  };
  const reviewer = {
    async review(workspace: Workspace, evidence: Parameters<typeof reviewCandidate>[2]) {
      expect(await transport.readFile(workspace, "change.ts")).toBe(workspace.runId);
      return reviewCandidate(
        harness('{"decision":"approve","summary":"Independent fixture review"}'),
        workspace,
        evidence,
      );
    },
  };
  const adapter = new CloudflareExecutionAdapter(
    new ExecutionCoordinator({ async fork() {} }, transport, journal),
    journal,
    worker,
    reviewer,
    { argv: ["fake-test"], timeoutMs: 1000, maxOutputBytes: 1024 },
  );
  const pending: Promise<void>[] = [];
  const router = api(core, (id) => {
    pending.push(
      core.dispatch(id, {
        delegate: (input) => adapter.delegate({ ...input, repository: "fixture-artifact" }),
      }),
    );
  });
  let cookie = "";
  vi.stubGlobal("fetch", async (path: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    headers.set("Cookie", cookie);
    if (options?.method === "POST") headers.set("Origin", "http://localhost");
    const response = await protectedFetch(
      new Request(`http://localhost${path}`, { ...options, headers }),
      { ENVIRONMENT: "development", FIXTURE_IDENTITY: "lilfrogdev" },
      async (request) => router.fetch(request),
    );
    cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
    return response;
  });
  const a = await httpApi.createThread("pitcrew", "Change A", "a"),
    b = await httpApi.createThread("pitcrew", "Change B", "b");
  await Promise.all([httpApi.send(a.id, "A only", "a"), httpApi.send(b.id, "B only", "b")]);
  await Promise.all(pending);
  const [as, bs] = await Promise.all([httpApi.snapshot(a.id), httpApi.snapshot(b.id)]);
  expect(peak).toBe(2);
  expect(as.messages.map((m) => m.content)).toEqual(["A only"]);
  expect(bs.messages.map((m) => m.content)).toEqual(["B only"]);
  for (const snapshot of [as, bs]) {
    expect(snapshot.evidence[0].tests?.status).toBe("passed");
    expect(snapshot.reviews[0].candidateSha).toBe(snapshot.runs[0].candidateSha);
    expect(snapshot.runs[0].status).toBe("awaiting_review");
  }
  expect(published).toHaveLength(2);
  expect(stopped.size).toBe(2);
  const recovered = new Coordinator(structuredClone(core.state), () => {});
  const replay = recovered.submit(a.id, "A only", "a");
  expect(replay.run.id).toBe(as.runs[0].id);
  expect(recovered.state.runs).toHaveLength(2);
  expect(
    (
      await router.request(`/api/runs/${as.runs[0].id}/merge-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(503);
});
