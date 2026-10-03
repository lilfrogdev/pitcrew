import type {
  Event,
  ExecutionAdapter,
  Message,
  Project,
  Review,
  Run,
  RunEvidence,
  SubmitResult,
  TestEvidence,
  Thread,
  RepositoryContext,
} from "@pitcrew/protocol";
export class AdmissionError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export interface State {
  project: Project;
  threads: Thread[];
  messages: Message[];
  runs: Run[];
  reviews: Review[];
  events: Event[];
  keys: Record<string, { body: string; result: unknown }>;
  evidence: Record<string, TestEvidence>;
}
export const initialState = (): State => ({
  project: {
    id: "pitcrew",
    name: "Pitcrew",
    repository: "https://github.com/lilfrogdev/pitcrew",
    baseSha: "851b619d31a4f1b769b8046a3d306122097ac036",
    configurationRevision: "poc-v1",
  },
  threads: [],
  messages: [],
  runs: [],
  reviews: [],
  events: [],
  keys: {},
  evidence: {},
});
export class Coordinator {
  constructor(
    public state: State,
    private persist: (state: State) => void,
    private now = () => new Date().toISOString(),
    private id: () => string = () => crypto.randomUUID(),
  ) {}
  private validateKey(key: unknown): asserts key is string {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
      throw new AdmissionError("invalid_idempotency_key");
  }
  private transaction<T>(key: string, body: unknown, operation: () => T): T {
    const serialized = JSON.stringify(body),
      previous = this.state.keys[key];
    if (previous) {
      if (previous.body !== serialized) throw new AdmissionError("idempotency_conflict", 409);
      return structuredClone(previous.result) as T;
    }
    if (Object.keys(this.state.keys).length >= 500) throw new AdmissionError("capacity", 429);
    const before = structuredClone(this.state);
    try {
      const result = operation();
      this.state.keys[key] = { body: serialized, result: structuredClone(result) };
      this.persist(this.state);
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
  private event(type: Event["type"], entityId: string) {
    this.state.events.push({
      sequence: this.state.events.length + 1,
      projectId: this.state.project.id,
      type,
      entityId,
      createdAt: this.now(),
    });
  }
  thread(threadId: string) {
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) throw new AdmissionError("not_found", 404);
    return thread;
  }
  createThread(title: string, key: string) {
    this.validateKey(key);
    return this.transaction(`thread_${key}`, { title }, () => {
      if (typeof title !== "string" || !title.trim() || title.length > 200)
        throw new AdmissionError("invalid_title");
      if (this.state.threads.length >= 50) throw new AdmissionError("capacity", 429);
      const thread = { id: this.id(), projectId: this.state.project.id, title: title.trim() };
      this.state.threads.push(thread);
      this.event("thread.created", thread.id);
      return thread;
    });
  }
  submit(threadId: string, content: string, key: string): SubmitResult {
    this.validateKey(key);
    return this.transaction(`message_${key}`, { threadId, content }, () => {
      this.thread(threadId);
      if (typeof content !== "string" || !content.trim() || content.length > 8000)
        throw new AdmissionError("invalid_content");
      if (
        this.state.messages.length >= 500 ||
        this.state.runs.filter((r) => ["queued", "running"].includes(r.status)).length >= 4
      )
        throw new AdmissionError("capacity", 429);
      const message: Message = {
        id: this.id(),
        threadId,
        role: "user",
        content: content.trim(),
        createdAt: this.now(),
      };
      const run: Run = {
        messageId: message.id,
        id: this.id(),
        threadId,
        status: "queued",
        baseSha: this.state.project.baseSha,
        configurationRevision: this.state.project.configurationRevision,
      };
      this.state.messages.push(message);
      this.state.runs.push(run);
      this.event("message.created", message.id);
      this.event("run.queued", run.id);
      return { message, run };
    });
  }
  evidence(runId: string): RunEvidence {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) throw new AdmissionError("not_found", 404);
    return {
      run,
      tests: this.state.evidence[runId],
      reviews: this.state.reviews.filter((r) => r.runId === runId),
    };
  }
  repositoryContext(): RepositoryContext {
    return {
      revision: `${this.state.project.baseSha}:${this.state.project.configurationRevision}`,
      baseSha: this.state.project.baseSha,
      configurationRevision: this.state.project.configurationRevision,
      acceptedDecisions: [
        {
          id: "delegation-boundary",
          text: "The repository coordinator delegates implementation and cannot edit source.",
          sourceRevision: this.state.project.configurationRevision,
        },
      ],
      activeWork: this.state.runs
        .filter((run) =>
          ["queued", "running", "waiting_user", "awaiting_review"].includes(run.status),
        )
        .map((run) => ({
          runId: run.id,
          threadId: run.threadId,
          title: this.thread(run.threadId).title,
          status: run.status,
          intent:
            this.state.messages
              .find((message) => message.id === run.messageId)
              ?.content.slice(0, 512) ?? "",
        })),
    };
  }
  recover() {
    for (const run of this.state.runs)
      if (run.status === "running" || run.status === "queued") {
        run.status = "waiting_user";
        run.error = "reconciliation_required";
      }
    this.persist(this.state);
  }
  async dispatch(runId: string, adapter: ExecutionAdapter) {
    const run = this.evidence(runId).run;
    if (run.status !== "queued") return;
    run.status = "running";
    this.event("run.started", run.id);
    this.persist(this.state);
    try {
      const result = await adapter.delegate({
        runId,
        projectId: this.state.project.id,
        threadId: run.threadId,
        repository: this.state.project.repository,
        baseSha: run.baseSha,
        configurationRevision: run.configurationRevision,
        repositoryContext: this.repositoryContext(),
        messages: structuredClone(this.state.messages.filter((m) => m.threadId === run.threadId)),
      });
      if (result.baseSha !== run.baseSha || !/^[a-f0-9]{40}$/.test(result.candidateSha))
        throw new Error("invalid evidence");
      for (const evidence of [result.tests, result.review].filter(Boolean)) {
        if (
          evidence!.baseSha !== run.baseSha ||
          evidence!.candidateSha !== result.candidateSha ||
          evidence!.configurationRevision !== run.configurationRevision
        )
          throw new Error("invalid evidence binding");
      }
      run.workerId = result.workerId;
      run.artifactId = result.artifactId;
      run.candidateSha = result.candidateSha;
      this.state.evidence[runId] = result.tests;
      run.status = "awaiting_review";
      this.event("run.awaiting_review", run.id);
      if (result.review) {
        const review: Review = {
          id: this.id(),
          runId,
          ...result.review,
          baseSha: run.baseSha,
          candidateSha: result.candidateSha,
          configurationRevision: run.configurationRevision,
        };
        this.state.reviews.push(review);
        this.event("review.created", review.id);
      }
    } catch {
      run.status = "failed";
      run.error = "execution_failed";
      this.event("run.failed", run.id);
    }
    this.persist(this.state);
  }
}
export const fakeExecution: ExecutionAdapter = {
  async delegate(input) {
    return {
      workerId: `fake-worker-${input.runId}`,
      artifactId: `fake-artifact-${input.runId}`,
      baseSha: input.baseSha,
      candidateSha: input.baseSha,
      summary: "Development fixture: no code executed.",
      tests: {
        baseSha: input.baseSha,
        candidateSha: input.baseSha,
        configurationRevision: input.configurationRevision,
        status: "not_run",
        argv: [],
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
      },
    };
  },
};
