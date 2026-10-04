import { ExecutionError, assertSha, assertCommand } from "./contracts.ts";
import type {
  PrepareInput,
  Workspace,
  Command,
  TestEvidence,
  ForkTransport,
  WorkspaceTransport,
  OperationJournal,
} from "./contracts.ts";

export class ExecutionCoordinator {
  constructor(
    private readonly forks: ForkTransport,
    private readonly transport: WorkspaceTransport,
    private readonly journal: OperationJournal,
  ) {}

  private async once<T>(key: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    const { claimed, record } = await this.journal.claim(key, fingerprint);
    if (record.fingerprint !== fingerprint) throw new ExecutionError("IDEMPOTENCY_CONFLICT");
    if (!claimed) {
      if (record.state !== "complete") throw new ExecutionError("UNCERTAIN_OPERATION");
      return record.result as T;
    }
    try {
      const result = await action();
      await this.journal.complete(key, fingerprint, result);
      return result;
    } catch {
      // Do not persist or expose raw platform errors; they may contain credentials.
      throw new ExecutionError("UNCERTAIN_OPERATION");
    }
  }

  async prepare(input: PrepareInput): Promise<Workspace> {
    assertSha(input.baseSha);
    if (
      ![input.runId, input.projectId].every((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id)) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.repository) ||
      !input.configurationRevision ||
      input.configurationRevision.length > 128
    )
      throw new ExecutionError("INVALID_WORKSPACE");
    input = {
      runId: input.runId,
      projectId: input.projectId,
      repository: input.repository,
      baseSha: input.baseSha,
      configurationRevision: input.configurationRevision,
    };
    const fingerprint = JSON.stringify(input);
    return this.once(`prepare:${input.projectId}:${input.runId}`, fingerprint, async () => {
      // Unambiguous lengths prevent collisions such as project=a-b/run=c vs a/run=b-c.
      const id = `pc-${input.projectId.length}-${input.projectId}-${input.runId}`;
      const workspace = { ...input, workerId: id, artifactId: id };
      await this.forks.fork(input.repository, id, input.baseSha);
      await this.transport.prepare(workspace);
      return workspace;
    });
  }

  async test(
    workspace: Workspace,
    candidateSha: string,
    command: Command,
    signal?: AbortSignal,
  ): Promise<TestEvidence> {
    assertSha(candidateSha);
    assertCommand(command);
    if (signal?.aborted) throw new ExecutionError("STOPPED");
    const fingerprint = JSON.stringify({ workspace, candidateSha, command });
    return this.once(`test:${workspace.workerId}:${command.commandId}`, fingerprint, async () => {
      await this.assertWorkspace(workspace);
      const before = await this.transport.inspect(workspace);
      if (before.sha !== candidateSha || !before.clean) throw new ExecutionError("STALE_CANDIDATE");
      const result = await this.transport.run(workspace, command, signal);
      if (result.status === "completed") {
        const after = await this.transport.inspect(workspace);
        if (after.sha !== candidateSha || !after.clean)
          throw new ExecutionError("CHANGED_DURING_TEST");
      }
      return {
        ...result,
        argv: [...command.argv],
        runId: workspace.runId,
        commandId: command.commandId,
        baseSha: workspace.baseSha,
        candidateSha,
        configurationRevision: workspace.configurationRevision,
      };
    });
  }

  async publish(workspace: Workspace, candidateSha: string): Promise<void> {
    assertSha(candidateSha);
    await this.assertWorkspace(workspace);
    await this.once(
      `publish:${workspace.workerId}:${candidateSha}`,
      JSON.stringify({ workspace, candidateSha }),
      async () => {
        const candidate = await this.transport.inspect(workspace);
        if (candidate.sha !== candidateSha || !candidate.clean)
          throw new ExecutionError("STALE_CANDIDATE");
        await this.transport.publish(workspace, candidateSha);
        return true;
      },
    );
  }

  private async assertWorkspace(workspace: Workspace): Promise<void> {
    const recovered = await this.prepare({
      runId: workspace.runId,
      projectId: workspace.projectId,
      repository: workspace.repository,
      baseSha: workspace.baseSha,
      configurationRevision: workspace.configurationRevision,
    });
    if (JSON.stringify(recovered) !== JSON.stringify(workspace))
      throw new ExecutionError("WORKSPACE_MISMATCH");
  }

  async stop(workspace: Workspace): Promise<void> {
    await this.assertWorkspace(workspace);
    await this.transport.stop(workspace);
  }
}

export interface ReviewedCandidate {
  workspace: Workspace;
  candidateSha: string;
  tests: TestEvidence[];
  review: {
    candidateSha: string;
    baseSha: string;
    configurationRevision: string;
    decision: "approve" | "changes_requested";
  };
}
// Application port only: Artifacts does not expose a merge or CAS binding method.
// A future trusted Git implementation must use a ref lease, never check-then-push.
export interface TrustedMergeTransport {
  compareAndSwap(input: {
    repository: string;
    expectedBaseSha: string;
    candidateSha: string;
  }): Promise<void>;
}
export function assertMergeEvidence(candidate: ReviewedCandidate, currentBaseSha: string): void {
  const { workspace, candidateSha, tests, review } = candidate;
  assertSha(candidateSha);
  assertSha(currentBaseSha);
  assertSha(workspace.baseSha);
  if (
    currentBaseSha !== workspace.baseSha ||
    review.baseSha !== workspace.baseSha ||
    review.candidateSha !== candidateSha ||
    review.configurationRevision !== workspace.configurationRevision ||
    review.decision !== "approve" ||
    tests.length === 0 ||
    tests.some(
      (t) =>
        t.runId !== workspace.runId ||
        t.baseSha !== workspace.baseSha ||
        t.candidateSha !== candidateSha ||
        t.configurationRevision !== workspace.configurationRevision ||
        t.status !== "completed" ||
        t.exitCode !== 0 ||
        t.truncated,
    )
  )
    throw new ExecutionError("MERGE_EVIDENCE_REJECTED");
}

export async function mergeCandidate(_candidate: ReviewedCandidate): Promise<never> {
  // Explicitly unavailable in this PoC, even with accepted review evidence.
  throw new ExecutionError("MERGE_DISABLED");
}
