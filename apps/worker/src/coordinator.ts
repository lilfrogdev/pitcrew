import { applyKnowledgePage, projectKnowledge, validKnowledge } from "./knowledge";
import type {
  CurrentKnowledge,
  KnowledgeMutation,
  KnowledgeRecord,
  KnowledgeReport,
  WorkerKnowledgeContext,
  KnowledgeAck,
  KnowledgeCheckpoint,
} from "@pitcrew/protocol";
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
  // Latest explicit checkpoint per run; never a per-note causal watermark.
  knowledgeObservations?: Record<string, number>;
  knowledgeProjection?: { projectId: string; repository: string; current: CurrentKnowledge };
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
export const initialState = (overrides: Partial<Project> = {}): State => {
  const project: Project = {
    id: "pitcrew",
    name: "Pitcrew",
    repository: "https://github.com/lilfrogdev/pitcrew",
    baseSha: "851b619d31a4f1b769b8046a3d306122097ac036",
    configurationRevision: "poc-v1",
    ...overrides,
  };
  const record = delegationPolicy(project);
  const event: Event = {
    sequence: 1,
    projectId: project.id,
    type: "knowledge.changed",
    entityId: record.id,
    createdAt: new Date().toISOString(),
    knowledge: record,
  };
  return {
    project,
    threads: [],
    messages: [],
    runs: [],
    changes: [],
    reviews: [],
    events: [event],
    keys: {},
    evidence: {},
    knowledgeProjection: {
      projectId: project.id,
      repository: project.repository,
      current: applyKnowledgePage(
        { revision: 0, complete: true, entries: [] },
        [event],
        project.id,
        project.repository,
      ),
    },
  };
};
function delegationPolicy(project: Project): KnowledgeRecord {
  return {
    id: "delegation-boundary",
    version: 1,
    status: "accepted",
    kind: "constraint",
    text: "The repository coordinator delegates implementation and cannot edit source.",
    sourceRefs: [
      { kind: "policy", id: "coordinator-delegation", revision: project.configurationRevision },
    ],
    reason: "Existing application policy; no inferred user decision.",
    eventId: "application:delegation-boundary",
    actor: { kind: "application", id: "coordinator" },
    projectId: project.id,
    repository: project.repository,
    visibility: "repository",
    baseSha: project.baseSha,
    configurationRevision: project.configurationRevision,
  };
}
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
    if (
      !this.state.knowledgeProjection ||
      this.state.knowledgeProjection.projectId !== this.state.project.id ||
      this.state.knowledgeProjection.repository !== this.state.project.repository
    )
      this.durableUpdate(() => {
        this.state.knowledgeProjection = {
          projectId: this.state.project.id,
          repository: this.state.project.repository,
          current: projectKnowledge(
            this.state.events,
            this.state.project.id,
            this.state.project.repository,
          ),
        };
        if (!this.currentKnowledge().entries.some((entry) => entry.id === "delegation-boundary"))
          this.recordKnowledge(delegationPolicy(this.state.project));
      });
  }
  private currentKnowledge(): CurrentKnowledge {
    const cached = this.state.knowledgeProjection;
    if (
      cached?.projectId === this.state.project.id &&
      cached.repository === this.state.project.repository
    )
      return structuredClone(cached.current);
    return projectKnowledge(
      this.state.events,
      this.state.project.id,
      this.state.project.repository,
    );
  }
  private recordKnowledge(record: KnowledgeRecord) {
    const event: Event = {
      sequence: this.state.events.length + 1,
      projectId: this.state.project.id,
      type: "knowledge.changed",
      entityId: record.id,
      createdAt: this.now(),
      knowledge: structuredClone(record),
    };
    let current: CurrentKnowledge;
    try {
      current = applyKnowledgePage(
        this.currentKnowledge(),
        [event],
        this.state.project.id,
        this.state.project.repository,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "knowledge_projection_capacity")
        throw new AdmissionError("knowledge_projection_capacity", 429);
      throw error;
    }
    this.state.events.push(event);
    this.state.knowledgeProjection = {
      projectId: this.state.project.id,
      repository: this.state.project.repository,
      current,
    };
    return structuredClone(record);
  }
  // Only an explicit authenticated operation invokes this method. Message text
  // and model output never supply this principal or acceptance authority.
  appendKnowledge(actor: string, key: string, input: KnowledgeMutation): KnowledgeRecord {
    this.validateKey(key);
    if (!actor || !validKnowledge(input)) throw new AdmissionError("invalid_knowledge");
    const body = {
      id: input.id,
      expectedVersion: input.expectedVersion,
      status: input.status,
      text: input.text,
      kind: input.kind,
      sourceRefs: input.sourceRefs.map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        ...(ref.revision !== undefined ? { revision: ref.revision } : {}),
        ...(ref.path !== undefined ? { path: ref.path } : {}),
      })),
      reason: input.reason,
    };
    return this.transaction(`knowledge_${actor}_${key}`, body, () => {
      const previous = this.currentKnowledge().entries.find((entry) => entry.id === body.id);
      if ((previous?.version ?? 0) !== body.expectedVersion)
        throw new AdmissionError("knowledge_version_conflict", 409);
      if (
        (!previous && body.status === "superseded") ||
        (previous?.status === "accepted" && body.status === "proposed") ||
        previous?.status === "superseded"
      )
        throw new AdmissionError("knowledge_transition_conflict", 409);
      const { expectedVersion, ...value } = body;
      return this.recordKnowledge({
        ...value,
        version: expectedVersion + 1,
        eventId: `principal:${actor}:${key}`,
        actor: { kind: "principal", id: actor },
        projectId: this.state.project.id,
        repository: this.state.project.repository,
        visibility: "repository",
        baseSha: this.state.project.baseSha,
        configurationRevision: this.state.project.configurationRevision,
        threadId: previous?.threadId,
        changeId: previous?.changeId,
        runId: previous?.runId,
      });
    });
  }
  refreshWorkerKnowledge(context: WorkerKnowledgeContext): KnowledgeCheckpoint {
    const request = context && this.state.requests?.[context.runId];
    const run = context && this.state.runs.find((run) => run.id === context.runId);
    if (
      !request?.knowledgeContext ||
      JSON.stringify(context) !== JSON.stringify(request.knowledgeContext) ||
      !run ||
      ["failed", "stopped", "waiting_user"].includes(run.status) ||
      context.baseSha !== this.state.project.baseSha ||
      context.configurationRevision !== this.state.project.configurationRevision
    )
      return { status: "stale" };
    const currentKnowledge = this.currentKnowledge();
    this.durableUpdate(() => {
      (this.state.knowledgeObservations ??= {})[context.runId] = currentKnowledge.revision;
    });
    return {
      status: "current",
      observedKnowledgeRevision: currentKnowledge.revision,
      currentKnowledge,
    };
  }
  appendWorkerKnowledge(context: WorkerKnowledgeContext, report: KnowledgeReport): KnowledgeAck {
    const eventId = `worker:${context?.runId}:${report?.key}`;
    if (
      !context ||
      !report ||
      typeof report.key !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(report.key)
    )
      return { eventId, status: "rejected" };
    const input: KnowledgeMutation = {
      id: eventId,
      expectedVersion: 0,
      status: "proposed",
      text: report.text,
      kind: report.kind,
      sourceRefs: Array.isArray(report.sourceRefs)
        ? report.sourceRefs.map((ref) => ({
            kind: ref?.kind,
            id: ref?.id,
            ...(ref?.revision !== undefined ? { revision: ref.revision } : {}),
            ...(ref?.path !== undefined ? { path: ref.path } : {}),
          }))
        : report.sourceRefs,
      reason: "Worker discovery; acceptance required.",
    };
    if (!validKnowledge(input)) return { eventId, status: "rejected" };
    const request = this.state.requests?.[context.runId];
    if (
      !request?.knowledgeContext ||
      JSON.stringify(context) !== JSON.stringify(request.knowledgeContext)
    )
      return { eventId, status: "stale" };
    const run = this.evidence(context.runId).run;
    const previous = this.state.keys[`worker_knowledge_${context.runId}_${report.key}`];
    const body = { context: request.knowledgeContext, input };
    if (previous) {
      if (previous.body !== JSON.stringify(body))
        throw new AdmissionError("idempotency_conflict", 409);
      return { eventId, status: "duplicate" };
    }
    if (
      ["failed", "stopped", "waiting_user"].includes(run.status) ||
      context.baseSha !== this.state.project.baseSha ||
      context.configurationRevision !== this.state.project.configurationRevision
    )
      return { eventId, status: "stale" };
    return this.transaction(`worker_knowledge_${context.runId}_${report.key}`, body, () => {
      const { expectedVersion: _expectedVersion, ...value } = input;
      this.recordKnowledge({
        ...value,
        version: 1,
        eventId,
        actor: { kind: "worker", id: context.attemptId },
        projectId: context.projectId,
        repository: context.repository,
        visibility: "repository",
        baseSha: context.baseSha,
        configurationRevision: context.configurationRevision,
        threadId: context.threadId,
        changeId: context.changeId,
        runId: context.runId,
        contextRevision: context.contextRevision,
      });
      return { eventId, status: "recorded" as const };
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
              messages.forEach((m) =>
                this.event("message.created", m.id, { kind: "principal", id: actor }),
              );
              this.event("change.created", change.id, { kind: "principal", id: actor });
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
  private event(
    type: Event["type"],
    entityId: string,
    actor: KnowledgeRecord["actor"] = { kind: "application", id: "coordinator" },
  ) {
    const review =
      type === "review.created"
        ? this.state.reviews.find((item) => item.id === entityId)
        : undefined;
    const run = review
      ? this.state.runs.find((item) => item.id === review.runId)
      : type.startsWith("run.")
        ? this.state.runs.find((item) => item.id === entityId)
        : undefined;
    const change = this.state.changes?.find(
      (item) => item.id === (run?.changeId ?? (type === "change.created" ? entityId : undefined)),
    );
    const message =
      type === "message.created"
        ? this.state.messages.find((item) => item.id === entityId)
        : undefined;
    const threadId =
      run?.threadId ??
      change?.threadId ??
      message?.threadId ??
      (type === "thread.created" || type.startsWith("thread.") ? entityId : undefined);
    const outcome =
      type === "run.awaiting_review"
        ? "candidate_recorded"
        : review
          ? review.decision === "approve"
            ? "review_approved"
            : "review_changes_requested"
          : type === "run.completed" && run?.landing?.backend === "fixture"
            ? "fixture_landed"
            : undefined;
    this.state.events.push({
      sequence: this.state.events.length + 1,
      projectId: this.state.project.id,
      type,
      entityId,
      createdAt: this.now(),
      provenance: {
        actor: review ? { kind: "worker", id: `review:${review.runId}` } : actor,
        repository: this.state.project.repository,
        baseSha: run?.baseSha ?? this.state.project.baseSha,
        candidateSha: run?.candidateSha,
        configurationRevision:
          run?.configurationRevision ?? this.state.project.configurationRevision,
        threadId,
        changeId: change?.id,
        runId: run?.id,
        sourceRefs: review
          ? [{ kind: "review", id: review.id, revision: review.candidateSha }]
          : run?.artifactId
            ? [{ kind: "artifact", id: run.artifactId, revision: run.candidateSha }]
            : (change?.originMessageIds ?? (message ? [message.id] : [])).map((id) => ({
                kind: "message" as const,
                id,
              })),
        outcome,
      },
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
  submit(threadId: string, content: string, key: string, actor = "local-fixture"): SubmitResult {
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
      this.event("message.created", message.id, { kind: "principal", id: actor });
      this.event("change.created", change.id, { kind: "principal", id: actor });
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
  eventsAfter(sequence: number): Event[] {
    let low = 0,
      high = this.state.events.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.state.events[middle].sequence <= sequence) low = middle + 1;
      else high = middle;
    }
    return structuredClone(this.state.events.slice(low, low + 256));
  }
  repositoryContext(): RepositoryContext {
    const currentKnowledge = this.currentKnowledge();
    return {
      revision: `${this.state.project.baseSha}:${this.state.project.configurationRevision}:${currentKnowledge.revision}`,
      baseSha: this.state.project.baseSha,
      configurationRevision: this.state.project.configurationRevision,
      currentKnowledge,
      acceptedDecisions: currentKnowledge.entries
        .filter((entry) => entry.status === "accepted")
        .map((entry) => ({
          id: entry.id,
          text: entry.text,
          sourceRevision: entry.configurationRevision,
        })),
      activeWorkOmitted: Math.max(
        0,
        this.state.runs.filter((run) =>
          ["queued", "running", "waiting_user", "awaiting_review"].includes(run.status),
        ).length - 20,
      ),
      activeWork: this.state.runs
        .filter((run) =>
          ["queued", "running", "waiting_user", "awaiting_review"].includes(run.status),
        )
        .slice(0, 20)
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
        knowledgeContext: {
          attemptId: runId,
          projectId: this.state.project.id,
          repository: this.state.project.repository,
          threadId: run.threadId,
          changeId: run.changeId!,
          runId,
          baseSha: run.baseSha,
          configurationRevision: run.configurationRevision,
          contextRevision: this.repositoryContext().revision,
        },
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
