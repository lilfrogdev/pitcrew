import {
  initialIntake,
  receiveReport,
  intakeGroups,
  moveReports,
  dispatchIntake,
  type IntakeState,
  type IntakeReportInput,
  type MoveReports,
  type DispatchIntake,
} from "./intake";
import {
  pinPlan,
  assertPinned,
  pendingOutcomes,
  verificationMetrics,
  verificationGaps,
  type VerificationProfile,
  type AcceptanceCriteria,
  type VerificationPlan,
} from "../../../packages/verification/src/index.ts";
import type { VerificationEvidence } from "@pitcrew/protocol";
import type {
  Change,
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
  ExecutionInput,
  ExecutionResult,
  LandingResultReceipt,
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
  intake?: IntakeState;
  profile?: VerificationProfile;
  plans?: Record<string, VerificationPlan>;
  verification?: Record<string, VerificationEvidence>;
  project: Project;
  threads: Thread[];
  messages: Message[];
  runs: Run[];
  reviews: Review[];
  events: Event[];
  keys: Record<string, { body: string; result: unknown }>;
  evidence: Record<string, TestEvidence>;
  changes?: Change[];
  requests?: Record<string, ExecutionInput>;
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
  changes: [],
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
  ) {
    const needsMigration =
      state.threads.some((thread) => thread.archived === undefined) ||
      !state.changes ||
      state.runs.some(
        (run) => !run.changeId || !state.changes?.some((change) => change.id === run.changeId),
      );
    if (needsMigration)
      this.durableUpdate(() => {
        for (const thread of this.state.threads) thread.archived ??= false;
        this.state.changes ??= [];
        for (const run of this.state.runs) {
          if (run.changeId && this.state.changes.some((change) => change.id === run.changeId))
            continue;
          const change: Change = {
            id: run.changeId ?? `legacy:${run.id}`,
            threadId: run.threadId,
            originMessageIds:
              run.messageId &&
              this.state.messages.some(
                (message) => message.id === run.messageId && message.threadId === run.threadId,
              )
                ? [run.messageId]
                : [],
            contextRevision: `${run.baseSha}:${run.configurationRevision}`,
          };
          this.state.changes.push(change);
          run.changeId = change.id;
        }
        for (const [key, entry] of Object.entries(this.state.keys)) {
          if (!key.startsWith("message_")) continue;
          const result = entry.result as SubmitResult;
          const run = result?.run && this.state.runs.find((run) => run.id === result.run.id);
          if (run)
            entry.result = {
              ...result,
              run: structuredClone(run),
              change: structuredClone(
                this.state.changes.find((change) => change.id === run.changeId),
              ),
            };
        }
      });
  }
  private intakeContext(actor: string) {
    return { scope: this.state.project.id, actor, now: this.now, id: this.id };
  }
  groups() {
    return intakeGroups(this.state.intake ?? initialIntake(), this.state.project.id);
  }
  receive(actor: string, input: IntakeReportInput) {
    return this.durableUpdate(() =>
      receiveReport((this.state.intake ??= initialIntake()), this.intakeContext(actor), input),
    );
  }
  move(actor: string, key: string, input: MoveReports) {
    return this.durableUpdate(() =>
      moveReports((this.state.intake ??= initialIntake()), this.intakeContext(actor), key, input),
    );
  }
  profile(): VerificationProfile {
    return structuredClone(
      this.state.profile ?? {
        projectId: this.state.project.id,
        revision: "poc-checks-v1",
        checks: [
          {
            id: "tests",
            kind: "command",
            command: { argv: ["pnpm", "test"], timeoutMs: 60000, maxOutputBytes: 16384 },
          },
          {
            id: "types",
            kind: "command",
            command: { argv: ["pnpm", "typecheck"], timeoutMs: 60000, maxOutputBytes: 16384 },
          },
        ],
      },
    );
  }
  async updateProfile(profile: VerificationProfile, expectedRevision: string) {
    const old = this.profile();
    if (old.revision !== expectedRevision || profile.revision === old.revision)
      throw new AdmissionError("profile_revision_conflict", 409);
    await pinPlan({
      projectId: this.state.project.id,
      changeId: "profile-validation",
      baseSha: this.state.project.baseSha,
      candidateSha: this.state.project.baseSha,
      configurationRevision: this.state.project.configurationRevision,
      profile,
      acceptance: {
        revision: "validation",
        criteria: [
          {
            id: "all",
            text: "Validate configured checks",
            checkIds: profile.checks.map((c) => c.id),
          },
        ],
      },
      reproduceBaseline: false,
    });
    if (this.profile().revision !== expectedRevision)
      throw new AdmissionError("profile_revision_conflict", 409);
    this.durableUpdate(() => {
      this.state.profile = structuredClone(profile);
    });
    return this.profile();
  }
  metrics() {
    return verificationMetrics(
      this.state.events,
      this.state.reviews,
      Object.values(this.state.verification ?? {}).flatMap((e) => e.outcomes),
    );
  }
  async dispatchGroup(
    actor: string,
    key: string,
    input: DispatchIntake,
    acceptance: AcceptanceCriteria,
    profileRevision: string,
  ) {
    this.validateKey(key);
    const saved = this.state.keys[`intake_dispatch_${actor}_${key}`];
    if (saved) {
      if (saved.body !== JSON.stringify({ input, acceptance, profileRevision }))
        throw new AdmissionError("idempotency_conflict", 409);
      return structuredClone(saved.result) as {
        threadId: string;
        changeId: string;
        runId: string;
        groupId: string;
        revision: number;
        reportIds: string[];
      };
    }
    const profile = this.profile(),
      project = structuredClone(this.state.project);
    if (profile.revision !== profileRevision)
      throw new AdmissionError("profile_revision_conflict", 409);
    const provisional = await pinPlan({
      projectId: project.id,
      changeId: "pending",
      baseSha: project.baseSha,
      candidateSha: project.baseSha,
      configurationRevision: project.configurationRevision,
      profile,
      acceptance,
      reproduceBaseline: false,
    });
    if (
      JSON.stringify(project) !== JSON.stringify(this.state.project) ||
      JSON.stringify(profile) !== JSON.stringify(this.profile())
    )
      throw new AdmissionError("stale_plan", 409);
    // The fingerprint is computed before the synchronous aggregate mutation; identity is reserved locally.
    const changeId = this.id();
    const { fingerprint: _provisionalFingerprint, ...draftPlan } = provisional;
    const plan = await pinPlan({ ...draftPlan, changeId });
    if (
      JSON.stringify(project) !== JSON.stringify(this.state.project) ||
      JSON.stringify(profile) !== JSON.stringify(this.profile())
    )
      throw new AdmissionError("stale_plan", 409);
    return this.transaction(
      `intake_dispatch_${actor}_${key}`,
      { input, acceptance, profileRevision },
      () =>
        dispatchIntake(
          (this.state.intake ??= initialIntake()),
          this.intakeContext(actor),
          key,
          input,
          {
            verifyActive: (scope, link) => {
              if (
                this.state.intake!.reports.some(
                  (r) => r.scope === scope && r.groupId === input.groupId && !r.dispatch,
                )
              )
                throw new AdmissionError("new_reports_require_new_change", 409);
              const run = this.evidence(link.runId).run,
                change = this.change(link.changeId);
              if (
                scope !== this.state.project.id ||
                this.thread(link.threadId).projectId !== scope ||
                run.threadId !== link.threadId ||
                run.changeId !== change.id ||
                change.threadId !== link.threadId ||
                !["queued", "running", "awaiting_review", "waiting_user"].includes(run.status)
              )
                throw new AdmissionError("inactive_change", 409);
              const old = this.state.plans?.[run.id];
              if (
                !old ||
                JSON.stringify(old.acceptance) !== JSON.stringify(acceptance) ||
                JSON.stringify(old.profile) !== JSON.stringify(profile)
              )
                throw new AdmissionError("plan_conflict", 409);
            },
            create: (group, reports) => {
              if (
                this.state.threads.length >= 50 ||
                this.state.runs.length >= 500 ||
                this.state.messages.length + reports.length > 500 ||
                this.state.runs.filter((r) => ["queued", "running"].includes(r.status)).length >= 4
              )
                throw new AdmissionError("capacity", 429);
              const thread = {
                id: this.id(),
                projectId: project.id,
                title: group.title,
                archived: false,
              };
              this.state.threads.push(thread);
              const messages: Message[] = reports.map((report) => ({
                id: this.id(),
                threadId: thread.id,
                role: "user",
                content: report.content,
                createdAt: report.occurredAt,
              }));
              this.state.messages.push(...messages);
              const change: Change = {
                id: changeId,
                threadId: thread.id,
                originMessageIds: messages.map((m) => m.id),
                contextRevision: this.repositoryContext().revision,
              };
              this.state.changes!.push(change);
              const run: Run = {
                id: this.id(),
                changeId,
                messageId: messages[0].id,
                threadId: thread.id,
                status: "queued",
                baseSha: project.baseSha,
                configurationRevision: project.configurationRevision,
              };
              this.state.runs.push(run);
              (this.state.plans ??= {})[run.id] = plan;
              this.event("thread.created", thread.id);
              messages.forEach((m) => this.event("message.created", m.id));
              this.event("change.created", change.id);
              this.event("run.queued", run.id);
              return { threadId: thread.id, changeId, runId: run.id };
            },
          },
        ),
    );
  }
  async requireCurrentVerification(runId: string) {
    const spec = this.state.plans?.[runId];
    if (!spec) return;
    const actual = this.state.verification?.[runId];
    if (
      !actual ||
      JSON.stringify(spec.profile) !== JSON.stringify(this.profile()) ||
      (await verificationGaps(actual.plan, actual.outcomes)).length
    )
      throw new AdmissionError("verification_incomplete_or_stale", 409);
  }
  async completeVerified(runId: string, result: ExecutionResult) {
    const expected = this.state.plans?.[runId];
    if (expected) {
      const actual = result.verification;
      if (!actual) throw Error("verification_missing");
      await assertPinned(actual.plan);
      const { fingerprint: _expectedFingerprint, ...spec } = expected;
      const pinned = await pinPlan({ ...spec, candidateSha: result.candidateSha });
      if (actual.plan.fingerprint !== pinned.fingerprint) throw Error("stale_plan");
      if (
        actual.outcomes.some(
          (o) =>
            !["passed", "failed", "not_run", "blocked"].includes(o.status) ||
            (o.status === "passed" &&
              (o.result?.status !== "completed" || o.result.exitCode !== 0 || o.result.truncated)),
        )
      )
        throw Error("invalid_verification_outcome");
      if (
        result.review?.decision === "approve" &&
        (await verificationGaps(pinned, actual.outcomes)).length
      )
        throw Error("invalid_verification_approval");
      const slots = pendingOutcomes(pinned);
      if (
        slots.length !== actual.outcomes.length ||
        slots.some(
          (slot) =>
            actual.outcomes.filter(
              (o) =>
                o.phase === slot.phase &&
                o.checkId === slot.checkId &&
                o.checkedSha === slot.checkedSha &&
                o.planFingerprint === pinned.fingerprint &&
                o.runId === runId &&
                o.artifactId === result.artifactId,
            ).length !== 1,
        )
      )
        throw Error("invalid_verification_binding");
    }
    this.complete(runId, result);
  }
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
  private durableUpdate<T>(operation: () => T): T {
    const before = structuredClone(this.state);
    try {
      const result = operation();
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
  setThreadArchived(threadId: string, archived: unknown): Thread {
    const thread = this.thread(threadId);
    if (typeof archived !== "boolean") throw new AdmissionError("invalid_archived");
    // Desired-state writes are idempotent without growing the bounded key/event journals.
    if (thread.archived === archived) return structuredClone(thread);
    return this.durableUpdate(() => {
      thread.archived = archived;
      return structuredClone(thread);
    });
  }
  createThread(title: string, key: string) {
    this.validateKey(key);
    return this.transaction(`thread_${key}`, { title }, () => {
      if (typeof title !== "string" || !title.trim() || title.length > 200)
        throw new AdmissionError("invalid_title");
      if (this.state.threads.length >= 50) throw new AdmissionError("capacity", 429);
      const thread = {
        id: this.id(),
        projectId: this.state.project.id,
        title: title.trim(),
        archived: false,
      };
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
        this.state.runs.length >= 500 ||
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
      const change: Change = {
        id: this.id(),
        threadId,
        originMessageIds: [message.id],
        contextRevision: this.repositoryContext().revision,
      };
      this.state.changes!.push(change);
      const run: Run = {
        changeId: change.id,
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
      this.event("change.created", change.id);
      this.event("run.queued", run.id);
      return { message, run, change };
    });
  }
  change(changeId: string): Change {
    const change = this.state.changes!.find((change) => change.id === changeId);
    if (!change) throw new AdmissionError("not_found", 404);
    return change;
  }
  retryChange(changeId: string, key: string): Run {
    this.validateKey(key);
    return this.transaction(`retry_${key}`, { changeId }, () => {
      const change = this.change(changeId);
      const sourcePlan = this.state.runs
        .filter((r) => r.changeId === changeId)
        .map((r) => this.state.plans?.[r.id])
        .find(Boolean);
      if (
        sourcePlan &&
        (sourcePlan.baseSha !== this.state.project.baseSha ||
          sourcePlan.configurationRevision !== this.state.project.configurationRevision)
      )
        throw new AdmissionError("stale_plan", 409);
      if (!change.originMessageIds.length) throw new AdmissionError("origin_unavailable", 409);
      if (
        this.state.runs.length >= 500 ||
        this.state.runs.filter((run) => ["queued", "running"].includes(run.status)).length >= 4
      )
        throw new AdmissionError("capacity", 429);
      if (
        this.state.runs.some(
          (run) => run.changeId === changeId && ["queued", "running"].includes(run.status),
        )
      )
        throw new AdmissionError("change_busy", 409);
      const run: Run = {
        id: this.id(),
        changeId,
        messageId: change.originMessageIds[0],
        threadId: change.threadId,
        status: "queued",
        baseSha: this.state.project.baseSha,
        configurationRevision: this.state.project.configurationRevision,
      };
      this.state.runs.push(run);
      if (sourcePlan) (this.state.plans ??= {})[run.id] = structuredClone(sourcePlan);
      this.event("run.queued", run.id);
      return run;
    });
  }
  evidence(runId: string): RunEvidence {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) throw new AdmissionError("not_found", 404);
    return {
      run,
      tests: this.state.evidence[runId],
      verification: this.state.verification?.[runId],
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
  recover(durable = false) {
    if (durable) return;
    for (const run of this.state.runs)
      if (run.status === "running" || run.status === "queued") {
        run.status = "waiting_user";
        run.error = "reconciliation_required";
      }
    this.persist(this.state);
  }
  begin(runId: string): ExecutionInput | undefined {
    const run = this.evidence(runId).run;
    if (!["queued", "running"].includes(run.status)) return undefined;
    this.state.requests ??= {};
    const existing = this.state.requests[runId];
    if (existing) return structuredClone(existing);
    return this.durableUpdate(() => {
      run.status = "running";
      this.event("run.started", run.id);
      const request: ExecutionInput = {
        verificationPlan: this.state.plans?.[runId],
        runId,
        changeId: run.changeId,
        projectId: this.state.project.id,
        threadId: run.threadId,
        repository: this.state.project.repository,
        baseSha: run.baseSha,
        configurationRevision: run.configurationRevision,
        repositoryContext: this.repositoryContext(),
        messages: structuredClone(
          this.state.messages.filter((m) =>
            this.change(run.changeId!).originMessageIds.includes(m.id),
          ),
        ),
      };
      this.state.requests![runId] = request;
      return structuredClone(request);
    });
  }
  complete(runId: string, result: ExecutionResult) {
    const run = this.evidence(runId).run;
    if (run.candidateSha || !["queued", "running"].includes(run.status)) return;
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
    this.durableUpdate(() => {
      run.workerId = result.workerId;
      run.artifactId = result.artifactId;
      run.candidateSha = result.candidateSha;
      this.state.evidence[run.id] = structuredClone(result.tests);
      if (result.verification)
        (this.state.verification ??= {})[run.id] = structuredClone(result.verification);
      run.status = "awaiting_review";
      this.event("run.awaiting_review", run.id);
      if (result.review) {
        const review: Review = {
          id: this.id(),
          runId: run.id,
          ...structuredClone(result.review),
          baseSha: run.baseSha,
          candidateSha: result.candidateSha,
          configurationRevision: run.configurationRevision,
        };
        this.state.reviews.push(review);
        this.event("review.created", review.id);
      }
    });
  }
  confirmFixtureLanding(runId: string, result: LandingResultReceipt) {
    if (result.backend !== "fixture" || result.status !== "landed") return;
    const run = this.evidence(runId).run;
    if (result.landedSha !== run.candidateSha) throw Error("invalid_landing_evidence");
    if (run.landing?.authorizationId === result.authorizationId) return;
    this.durableUpdate(() => {
      // An old receipt cannot move the project backwards after later landings.
      if (this.state.project.baseSha === run.baseSha)
        this.state.project.baseSha = result.landedSha!;
      run.landing = structuredClone(result);
      run.status = "completed";
      this.event("run.completed", run.id);
    });
  }
  fail(runId: string, reconcile = false) {
    const run = this.evidence(runId).run;
    if (!["queued", "running"].includes(run.status)) return;
    this.durableUpdate(() => {
      run.status = reconcile ? "waiting_user" : "failed";
      run.error = reconcile ? "reconciliation_required" : "execution_failed";
      this.event("run.failed", run.id);
    });
  }
  async dispatch(runId: string, adapter: ExecutionAdapter) {
    const input = this.begin(runId);
    if (!input) return;
    try {
      await this.completeVerified(runId, await adapter.delegate(input));
    } catch {
      this.fail(runId);
    }
  }
}
export const fakeExecution: ExecutionAdapter = {
  async delegate(input) {
    const verification = input.verificationPlan
      ? {
          plan: input.verificationPlan,
          outcomes: pendingOutcomes(input.verificationPlan).map((o) => ({
            ...o,
            status: "blocked" as const,
            reason: "fixture_execution_unavailable",
            runId: input.runId,
            artifactId: `fake-artifact-${input.runId}`,
          })),
        }
      : undefined;
    return {
      verification,
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
