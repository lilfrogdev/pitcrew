import type { ConversationTurn, ConversationInput } from "./conversation";
import type { ModelCatalog } from "./model-selection";
import { validateSelection, resolveRunModels } from "./model-selection";
import { selectionAttachmentCapabilities } from "@pitcrew/protocol";
import type { ModelSettings } from "@pitcrew/protocol";
import type { AttachmentStore } from "./attachment-store";
import {
  applyKnowledgePage,
  projectKnowledge,
  sameKnowledgeContext,
  validKnowledge,
} from "./knowledge";
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
  pinContract,
  fingerprint,
  type VerificationProfile,
  type AcceptanceCriteria,
  type VerificationPlan,
  type Check,
} from "../../../packages/verification/src/index.ts";
import type { VerificationEvidence } from "@pitcrew/protocol";
import { AttachmentValidationError, validateMessageAttachments } from "@pitcrew/protocol";
import type {
  Change,
  CrewRole,
  Event,
  Mission,
  MissionProposal,
  MissionStatus,
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
  OrchestrationTrace,
  ProbeEvidence,
  TraceEdge,
  TraceNode,
  TraceStatus,
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
  conversationTurns?: ConversationTurn[];
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
  credentialActors?: Record<string, string>;
  missions?: Mission[];
  orchestration?: { nodes: TraceNode[]; edges: TraceEdge[]; probes: ProbeEvidence[] };
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
    private persistState: (state: State) => void,
    private now = () => new Date().toISOString(),
    private id: () => string = () => crypto.randomUUID(),
    private attachments?: AttachmentStore,
    private atomic: <T>(operation: () => T) => T = (operation) => operation(),
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
      !sameKnowledgeContext(context, request.knowledgeContext) ||
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
    if (!request?.knowledgeContext || !sameKnowledgeContext(context, request.knowledgeContext))
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
    catalog?: ModelCatalog,
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
                runModels: catalog
                  ? resolveRunModels(catalog, undefined, project.modelSettings)
                  : undefined,
                messageId: messages[0].id,
                threadId: thread.id,
                status: "queued",
                baseSha: project.baseSha,
                configurationRevision: project.configurationRevision,
              };
              this.state.runs.push(run);
              (this.state.credentialActors ??= {})[run.id] = actor;
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
  private persist(state: State) {
    // Bound aggregate in-memory snapshots as well as SQLite rows. Durable Objects have
    // a 128 MiB heap; updates clone state and encode several temporary copies.
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 16 * 1024 * 1024)
      throw new AdmissionError("repository_storage_limit", 413);
    this.persistState(state);
  }
  private validateKey(key: unknown): asserts key is string {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
      throw new AdmissionError("invalid_idempotency_key");
  }
  readThreadAttachment(threadId: string, attachmentId: string) {
    this.thread(threadId);
    const reference = this.state.messages
      .filter((message) => message.threadId === threadId)
      .flatMap((message) => message.attachments ?? [])
      .find(
        (attachment) => "attachmentId" in attachment && attachment.attachmentId === attachmentId,
      );
    if (!reference || !("attachmentId" in reference) || !this.attachments)
      throw new AdmissionError("not_found", 404);
    return this.attachments.get(reference);
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
      return this.atomic(() => {
        const result = operation();
        this.state.keys[key] = { body: serialized, result: structuredClone(result) };
        this.persist(this.state);
        return result;
      });
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
  private durableUpdate<T>(operation: () => T): T {
    const before = structuredClone(this.state);
    try {
      return this.atomic(() => {
        const result = operation();
        this.persist(this.state);
        return result;
      });
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
    const conversation = type.startsWith("conversation.")
      ? this.state.conversationTurns?.find((item) => item.id === entityId)
      : undefined;
    const mission =
      type === "mission.updated"
        ? this.state.missions?.find((item) => item.id === entityId)
        : undefined;
    if (mission)
      console.log(
        JSON.stringify({ event: "mission.stage", missionId: mission.id, status: mission.status }),
      );
    const threadId =
      mission?.threadId ??
      conversation?.threadId ??
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
        baseSha: run?.baseSha ?? conversation?.baseSha ?? this.state.project.baseSha,
        candidateSha: run?.candidateSha,
        configurationRevision:
          run?.configurationRevision ??
          conversation?.configurationRevision ??
          this.state.project.configurationRevision,
        threadId,
        changeId: change?.id,
        runId: run?.id,
        sourceRefs: review
          ? [{ kind: "review", id: review.id, revision: review.candidateSha }]
          : run?.artifactId
            ? [{ kind: "artifact", id: run.artifactId, revision: run.candidateSha }]
            : (
                change?.originMessageIds ??
                (message ? [message.id] : conversation ? [conversation.messageId] : [])
              ).map((id) => ({
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
  setThreadModelSelection(threadId: string, catalog: ModelCatalog, value: unknown) {
    const chosen = validateSelection(catalog, value);
    return this.durableUpdate(() => {
      const thread = this.thread(threadId);
      thread.modelSelection = chosen;
      return structuredClone(thread);
    });
  }
  updateModelSettings(catalog: ModelCatalog, settings: unknown) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new AdmissionError("invalid_model_settings");
    const input = settings as ModelSettings;
    if (Object.keys(input).some((key) => !["default", "roles"].includes(key)))
      throw new AdmissionError("invalid_model_settings");
    if (
      input.roles &&
      (typeof input.roles !== "object" ||
        Array.isArray(input.roles) ||
        Object.keys(input.roles).some(
          (key) => !["implementer", "reviewer", "planner", "testAgent"].includes(key),
        ))
    )
      throw new AdmissionError("invalid_model_settings");
    const normalized: ModelSettings = { default: validateSelection(catalog, input.default) };
    if (input.roles) {
      normalized.roles = {};
      for (const role of ["implementer", "reviewer", "planner", "testAgent"] as const)
        if (input.roles[role])
          normalized.roles[role] = validateSelection(catalog, input.roles[role]);
    }
    return this.durableUpdate(() => {
      this.state.project.modelSettings = normalized;
      return structuredClone(normalized);
    });
  }
  queueTurn(
    threadId: string,
    content: string,
    key: string,
    actor: string,
    catalog: ModelCatalog,
    selection?: unknown,
    attachments?: unknown,
  ) {
    this.validateKey(key);
    // Leave room for the bounded pending replies and terminal worker/event records.
    if (
      !this.state.keys[`conversation_${key}`] &&
      new TextEncoder().encode(JSON.stringify(this.state)).byteLength > 15 * 1024 * 1024
    )
      throw new AdmissionError("repository_storage_limit", 413);
    const previous = this.state.keys[`conversation_${key}`]?.result as
      | { message: Message; turn: ConversationTurn }
      | undefined;
    const thread = this.thread(threadId);
    const chosen = validateSelection(
      catalog,
      selection ??
        previous?.turn.models.repoAgent ??
        thread.modelSelection ??
        this.state.project.modelSettings?.default ??
        catalog.defaultSelection,
    );
    const models =
      previous?.turn.models ?? resolveRunModels(catalog, chosen, this.state.project.modelSettings);
    const capabilities = selectionAttachmentCapabilities(catalog.choices, models);
    const accepted = validateMessageAttachments(attachments, capabilities);
    // Replay compares bytes against immutable references, without storing user image bytes in keys.
    if (previous)
      accepted.forEach((item, index) => {
        if ("data" in item) {
          const ref = previous.message.attachments?.[index];
          if (
            !this.attachments ||
            !ref ||
            !("attachmentId" in ref) ||
            !this.attachments.matches(ref, item)
          )
            throw new AdmissionError("idempotency_conflict", 409);
        }
      });
    const descriptor = accepted.map((item) =>
      "data" in item ? { id: item.id, name: item.name, mediaType: item.mediaType } : item,
    );
    return this.transaction(
      `conversation_${key}`,
      { threadId, content, actor, selection: chosen, attachments: descriptor },
      () => {
        if (typeof content !== "string" || !content.trim() || content.length > 8000)
          throw new AdmissionError("invalid_content");
        const turns = (this.state.conversationTurns ??= []);
        if (
          this.state.messages.length >= 500 ||
          turns.length >= 500 ||
          turns.filter((turn) => ["queued", "running"].includes(turn.status)).length >= 16
        )
          throw new AdmissionError("capacity", 429);
        // Admit the complete preserved history against the new selection. Nothing is silently dropped.
        const historyAttachments = this.state.messages
          .filter((m) => m.threadId === threadId)
          .flatMap((m) => m.attachments ?? [])
          .map((item) => ("attachmentId" in item ? this.attachments!.get(item) : item));
        let imageBytes = 0,
          imageCount = 0,
          textBytes = 0;
        for (const item of [...historyAttachments, ...accepted]) {
          validateMessageAttachments([item], capabilities);
          if ("data" in item) {
            imageBytes += atob(item.data).length;
            imageCount++;
          } else textBytes += new TextEncoder().encode(item.text).byteLength;
        }
        if (
          imageCount > capabilities.maxImages ||
          imageBytes > capabilities.imageTotalBytes ||
          textBytes > capabilities.textTotalBytes
        )
          throw new AdmissionError("conversation_attachment_context_limit", 413);

        const provisional: Message = {
          id: "$pending",
          threadId,
          role: "user",
          content: content.trim(),
          attachments: accepted.map((item) =>
            "data" in item
              ? {
                  id: item.id,
                  name: item.name,
                  mediaType: item.mediaType,
                  attachmentId: "$pending",
                }
              : item,
          ),
          createdAt: this.now(),
        };
        const contextBytes = new TextEncoder().encode(
          JSON.stringify({
            repositoryContext: this.repositoryContext(),
            messages: [...this.state.messages.filter((m) => m.threadId === threadId), provisional],
          }),
        ).byteLength;
        const contextLimit = Math.min(
          196608,
          ...[models.repoAgent, models.implementer, models.reviewer].map((selection) =>
            Math.floor(
              catalog.choices.find((choice) => choice.id === selection.modelId)!.contextWindow / 2,
            ),
          ),
        );
        if (
          contextBytes +
            16384 *
              turns.filter(
                (item) => item.threadId === threadId && ["queued", "running"].includes(item.status),
              ).length >
          contextLimit
        )
          throw new AdmissionError("conversation_context_limit", 413);
        const stored = accepted.map((item) => {
          if (!("data" in item)) return item;
          if (!this.attachments) throw new AdmissionError("image_storage_unavailable", 503);
          return this.attachments.put(item);
        });
        const message: Message = {
          id: this.id(),
          threadId,
          role: "user",
          content: content.trim(),
          attachments: stored?.length ? stored : undefined,
          createdAt: this.now(),
        };
        const history = [...this.state.messages.filter((m) => m.threadId === threadId), message];
        if (new TextEncoder().encode(JSON.stringify(history)).byteLength > 196608)
          throw new AdmissionError("conversation_context_limit", 413);
        const turn: ConversationTurn = {
          id: this.id(),
          threadId,
          messageId: message.id,
          status: "queued",
          models,
          actor,
          contextBudgetBytes: contextLimit,
          baseSha: this.state.project.baseSha,
          configurationRevision: this.state.project.configurationRevision,
          createdAt: this.now(),
        };
        thread.modelSelection = structuredClone(chosen);
        this.state.messages.push(message);
        turns.push(turn);
        this.openChatMission(threadId, message.id, content.trim(), actor);
        this.event("message.created", message.id, { kind: "principal", id: actor });
        this.event("conversation.queued", turn.id);
        return { message: structuredClone(message), turn: structuredClone(turn) };
      },
    );
  }
  conversationTurn(id: string) {
    const turn = this.state.conversationTurns?.find((turn) => turn.id === id);
    if (!turn) throw new AdmissionError("not_found", 404);
    return turn;
  }
  beginConversation(id: string): ConversationInput | undefined {
    const turn = this.conversationTurn(id);
    if (!["queued", "running"].includes(turn.status)) return;
    if (
      this.state.conversationTurns!.some(
        (other) =>
          other.threadId === turn.threadId &&
          other.id !== turn.id &&
          ["queued", "running"].includes(other.status) &&
          this.state.conversationTurns!.indexOf(other) <
            this.state.conversationTurns!.indexOf(turn),
      )
    )
      return;
    if (turn.input) return structuredClone(turn.input);
    return this.durableUpdate(() => {
      const origin = this.state.messages.findIndex((message) => message.id === turn.messageId);
      // Earlier assistant answers are appended after queued user inputs; collect by earlier turn id.
      const laterIds = new Set(
        this.state
          .conversationTurns!.slice(this.state.conversationTurns!.indexOf(turn) + 1)
          .map((item) => item.messageId),
      );
      const messages = this.state.messages.filter(
        (m, index) =>
          m.threadId === turn.threadId &&
          !laterIds.has(m.id) &&
          (m.role !== "user" || index <= origin),
      );
      const order = new Map<string, number>();
      this.state
        .conversationTurns!.filter((item) => item.threadId === turn.threadId)
        .forEach((item, index) => {
          order.set(item.messageId, index * 2);
          if (item.replyMessageId) order.set(item.replyMessageId, index * 2 + 1);
        });
      messages.sort((left, right) => (order.get(left.id) ?? -1) - (order.get(right.id) ?? -1));
      if (
        new TextEncoder().encode(
          JSON.stringify({ messages, repositoryContext: this.repositoryContext() }),
        ).byteLength > (turn.contextBudgetBytes ?? 196608)
      )
        throw new AdmissionError("conversation_context_limit", 413);
      turn.status = "running";
      turn.input = {
        credentialActor: turn.actor,
        turnId: id,
        threadId: turn.threadId,
        projectId: this.state.project.id,
        messageId: turn.messageId,
        models: structuredClone(turn.models),
        baseSha: turn.baseSha,
        configurationRevision: turn.configurationRevision,
        repositoryContext: this.repositoryContext(),
        messages: structuredClone(messages),
      };
      this.event("conversation.started", id);
      return structuredClone(turn.input);
    });
  }
  completeConversation(id: string, text?: string, error?: string) {
    const turn = this.conversationTurn(id);
    if (["completed", "failed"].includes(turn.status)) return;
    if (!error && (typeof text !== "string" || !text.trim() || text.length > 16384))
      error = "conversation_response_limit";
    this.durableUpdate(() => {
      turn.status = error ? "failed" : "completed";
      turn.error = error;
      const message: Message = {
        id: this.id(),
        threadId: turn.threadId,
        role: "coordinator",
        content: error
          ? `Repository agent could not answer: ${error}. You can send a new message to retry.`
          : text!,
        createdAt: this.now(),
      };
      turn.replyMessageId = message.id;
      this.state.messages.push(message);
      this.event("message.created", message.id);
      this.event(error ? "conversation.failed" : "conversation.completed", id);
    });
  }
  delegateConversation(id: string) {
    const turn = this.conversationTurn(id);
    if (turn.runId) return structuredClone(this.evidence(turn.runId).run);
    if (turn.status !== "running" || !turn.input)
      throw new AdmissionError("conversation_not_running", 409);
    if (
      turn.baseSha !== this.state.project.baseSha ||
      turn.configurationRevision !== this.state.project.configurationRevision
    )
      throw new AdmissionError("stale_configuration", 409);
    return this.durableUpdate(() => {
      if (this.state.runs.filter((r) => ["queued", "running"].includes(r.status)).length >= 4)
        throw new AdmissionError("capacity", 429);
      const change: Change = {
        id: this.id(),
        threadId: turn.threadId,
        originMessageIds: [turn.messageId],
        conversationContext: structuredClone(
          turn.input!.messages.filter((m) => m.id !== turn.messageId),
        ),
        contextRevision: turn.input!.repositoryContext.revision,
      };
      const run: Run = {
        id: this.id(),
        threadId: turn.threadId,
        messageId: turn.messageId,
        changeId: change.id,
        status: "queued",
        baseSha: turn.baseSha,
        configurationRevision: turn.configurationRevision,
        runModels: structuredClone(turn.models),
      };
      this.state.changes!.push(change);
      this.state.runs.push(run);
      turn.runId = run.id;
      (this.state.credentialActors ??= {})[run.id] = turn.actor;
      this.event("change.created", change.id);
      this.event("run.queued", run.id);
      return structuredClone(run);
    });
  }
  mission(missionId: string): Mission {
    const mission = this.state.missions?.find((item) => item.id === missionId);
    if (!mission) throw new AdmissionError("not_found", 404);
    return mission;
  }
  threadMission(threadId: string): Mission | undefined {
    this.thread(threadId);
    const items = (this.state.missions ?? []).filter((item) => item.threadId === threadId);
    const latest = items.at(-1);
    if (!latest || latest.proposal) return latest;
    return [...items].reverse().find((item) => item.proposal) ?? latest;
  }
  private crewNote(
    threadId: string,
    id: string,
    role: Message["role"],
    content: string,
    crew?: CrewRole,
  ) {
    if (this.state.messages.some((message) => message.id === id)) return;
    this.state.messages.push({
      id,
      threadId,
      role,
      ...(crew ? { crew } : {}),
      content: content.slice(0, 4000),
      createdAt: this.now(),
    });
    this.event("message.created", id);
  }
  threadTrace(threadId: string, after = 0): OrchestrationTrace {
    this.thread(threadId);
    const book = this.state.orchestration ?? { nodes: [], edges: [], probes: [] };
    return {
      nodes: book.nodes.filter((node) => node.threadId === threadId && node.sequence > after),
      edges: book.edges.filter((edge) => edge.threadId === threadId && edge.sequence > after),
      probes: book.probes.filter((probe) => probe.threadId === threadId),
      sequence: this.state.events.at(-1)?.sequence ?? 0,
    };
  }
  recordStage(input: {
    threadId: string;
    runId?: string;
    missionId?: string;
    role: CrewRole;
    stage: string;
    status: TraceStatus;
    title: string;
    summary: string;
    parentStage?: string;
    parentId?: string;
    edgeLabel?: string;
    revision?: string;
    candidateSha?: string;
    note?: { id: string; role: Message["role"]; crew: CrewRole; content: string };
  }): TraceNode {
    this.thread(input.threadId);
    return this.durableUpdate(() => {
      const book = (this.state.orchestration ??= { nodes: [], edges: [], probes: [] });
      const scope = input.runId ?? input.missionId ?? "thread";
      const id = `${input.threadId}:${scope}:${input.stage}`;
      const now = this.now();
      let node = book.nodes.find((item) => item.id === id);
      if (!node) {
        node = {
          id,
          threadId: input.threadId,
          runId: input.runId,
          missionId: input.missionId,
          role: input.role,
          stage: input.stage,
          status: input.status,
          title: input.title.slice(0, 120),
          summary: "",
          sequence: this.state.events.length + 1,
          createdAt: now,
          updatedAt: now,
        };
        book.nodes.push(node);
      }
      node.status = input.status;
      node.summary = input.summary.slice(0, 2000);
      node.title = input.title.slice(0, 120);
      node.updatedAt = now;
      node.revision = input.revision ?? node.revision;
      node.candidateSha = input.candidateSha ?? node.candidateSha;
      node.sequence = this.state.events.length + 1;
      if (input.parentId || input.parentStage) {
        const from = input.parentId ?? `${input.threadId}:${scope}:${input.parentStage}`;
        const edgeId = `${from}->${id}`;
        if (!book.edges.some((edge) => edge.id === edgeId) && book.nodes.some((item) => item.id === from))
          book.edges.push({
            id: edgeId,
            threadId: input.threadId,
            runId: input.runId,
            from,
            to: id,
            label: (input.edgeLabel ?? "handoff").slice(0, 80),
            sequence: node.sequence,
            createdAt: now,
          });
      }
      if (input.note)
        this.crewNote(input.threadId, input.note.id, input.note.role, input.note.content, input.note.crew);
      this.event("orchestration.updated", id);
      return structuredClone(node);
    });
  }
  recordProbes(threadId: string, runId: string, probes: ProbeEvidence[]) {
    this.thread(threadId);
    return this.durableUpdate(() => {
      const book = (this.state.orchestration ??= { nodes: [], edges: [], probes: [] });
      for (const probe of probes) {
        if (probe.threadId !== threadId || probe.runId !== runId) throw new AdmissionError("invalid_probe");
        if (probe.command.join(" ").length > 500 || probe.purpose.length > 500)
          throw new AdmissionError("invalid_probe");
        const clean = {
          ...probe,
          stdout: probe.stdout.slice(0, 4000),
          stderr: probe.stderr.slice(0, 4000),
        };
        const index = book.probes.findIndex((item) => item.id === clean.id);
        if (index >= 0) book.probes[index] = clean;
        else book.probes.push(clean);
      }
      this.event("orchestration.updated", runId);
      return book.probes.filter((probe) => probe.runId === runId);
    });
  }
  private openChatMission(threadId: string, messageId: string, request: string, actor: string) {
    const open = this.threadActive(threadId);
    if (open?.status === "clarifying") {
      const pending = open.questions.filter((item) => !item.answer && /^q\d+$/.test(item.id));
      if (!pending.length) return;
      for (const question of pending) question.answer = request;
      this.event("mission.updated", open.id, { kind: "principal", id: actor });
      return;
    }
    if (open) return;
    const latest = this.threadMission(threadId);
    if (latest?.status === "failed" && latest.proposal) return;
    const mission: Mission = {
      id: this.id(),
      projectId: this.state.project.id,
      threadId,
      messageId,
      status: "clarifying",
      request,
      questions: [],
    };
    (this.state.missions ??= []).push(mission);
    this.event("mission.updated", mission.id, { kind: "principal", id: actor });
  }
  private threadActive(threadId: string): Mission | undefined {
    return [...(this.state.missions ?? [])].reverse().find(
      (item) =>
        item.threadId === threadId &&
        ["clarifying", "proposed", "approved", "running", "awaiting_review"].includes(item.status),
    );
  }
  private missionForTurn(threadId: string): Mission | undefined {
    return this.threadActive(threadId) ?? this.failedPlan(threadId);
  }
  private failedPlan(threadId: string): Mission | undefined {
    const latest = [...(this.state.missions ?? [])].reverse().find((item) => item.threadId === threadId);
    return latest?.status === "failed" && latest.proposal ? latest : undefined;
  }
  private activeMission(): Mission | undefined {
    return this.state.missions?.find((item) =>
      ["clarifying", "proposed", "approved", "running", "awaiting_review"].includes(item.status),
    );
  }
  private syncMission(runId: string, status: MissionStatus) {
    const mission = this.state.missions?.find((item) => item.runId === runId);
    if (!mission || mission.status === status) return;
    mission.status = status;
    this.event("mission.updated", mission.id);
  }
  private requireText(value: unknown, code: string, max: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new AdmissionError(code);
    return value.trim();
  }
  private async draftProposal(
    mission: Mission,
    summary: string,
    affectedArea: string,
    criterion: string,
  ) {
    const checks: Check[] = this.profile().checks.filter((check) => check.kind === "command");
    if (!checks.length) throw new AdmissionError("invalid_proposal");
    const acceptance: AcceptanceCriteria = {
      revision: "mission",
      criteria: [{ id: "behavior", text: criterion, checkIds: checks.map((check) => check.id) }],
    };
    const proposalRevision = await fingerprint({ summary, affectedArea, acceptance, checks });
    const contract = await pinContract({
      projectId: this.state.project.id,
      missionId: mission.id,
      baseSha: this.state.project.baseSha,
      configurationRevision: this.state.project.configurationRevision,
      proposalRevision,
      checks,
      acceptance,
    });
    const proposal: MissionProposal = {
      revision: contract.digest,
      digest: contract.digest,
      summary,
      affectedArea,
      acceptance,
      checks,
    };
    return { proposal, contract };
  }
  createMission(threadId: string, request: string, key: string, actor = "local-fixture"): Mission {
    this.validateKey(key);
    const content = this.requireText(request, "invalid_content", 8000);
    return this.transaction(
      `mission_${JSON.stringify([actor, key])}`,
      { threadId, request: content },
      () => {
        this.thread(threadId);
        if (this.activeMission()) throw new AdmissionError("mission_busy", 409);
        const message: Message = {
          id: this.id(),
          threadId,
          role: "user",
          content,
          createdAt: this.now(),
        };
        const mission: Mission = {
          id: this.id(),
          projectId: this.state.project.id,
          threadId,
          messageId: message.id,
          status: "clarifying",
          request: content,
          questions: [
            {
              id: "observable-behavior",
              prompt: "What observable behavior should the tests assert?",
            },
          ],
        };
        this.state.messages.push(message);
        (this.state.missions ??= []).push(mission);
        this.event("message.created", message.id, { kind: "principal", id: actor });
        this.event("mission.updated", mission.id, { kind: "principal", id: actor });
        return structuredClone(mission);
      },
    );
  }
  async answerMission(
    missionId: string,
    questionId: string,
    answer: string,
    key: string,
    actor = "local-fixture",
  ): Promise<Mission> {
    this.validateKey(key);
    const content = this.requireText(answer, "invalid_content", 2000);
    const body = { missionId, questionId, answer: content };
    const storageKey = `mission_answer_${JSON.stringify([actor, key])}`;
    const saved = this.state.keys[storageKey];
    if (saved) {
      if (saved.body !== JSON.stringify(body))
        throw new AdmissionError("idempotency_conflict", 409);
      return structuredClone(saved.result) as Mission;
    }
    const mission = this.mission(missionId);
    if (mission.status !== "clarifying") throw new AdmissionError("mission_state", 409);
    const question = mission.questions.find((item) => item.id === questionId);
    if (!question || question.answer) throw new AdmissionError("invalid_question");
    const questions = mission.questions.map((item) =>
      item.id === questionId ? { ...item, answer: content } : item,
    );
    const drafted = questions.every((item) => item.answer)
      ? await this.draftProposal(mission, mission.request, "src", content)
      : undefined;
    if (this.mission(missionId).status !== "clarifying")
      throw new AdmissionError("mission_state", 409);
    return this.transaction(storageKey, body, () => {
      const current = this.mission(missionId);
      if (current.status !== "clarifying") throw new AdmissionError("mission_state", 409);
      current.questions = structuredClone(questions);
      if (drafted) {
        current.proposal = drafted.proposal;
        current.contract = drafted.contract;
        current.status = "proposed";
      }
      this.event("mission.updated", current.id, { kind: "principal", id: actor });
      return structuredClone(current);
    });
  }
  async reviseMission(
    missionId: string,
    input: { summary: string; affectedArea: string; criterion: string },
    key: string,
    actor = "local-fixture",
  ): Promise<Mission> {
    this.validateKey(key);
    const summary = this.requireText(input.summary, "invalid_proposal", 4000);
    const affectedArea = this.requireText(input.affectedArea, "invalid_proposal", 200);
    const criterion = this.requireText(input.criterion, "invalid_proposal", 2000);
    const body = { missionId, summary, affectedArea, criterion };
    const storageKey = `mission_revise_${JSON.stringify([actor, key])}`;
    const saved = this.state.keys[storageKey];
    if (saved) {
      if (saved.body !== JSON.stringify(body))
        throw new AdmissionError("idempotency_conflict", 409);
      return structuredClone(saved.result) as Mission;
    }
    const mission = this.mission(missionId);
    if (!["proposed", "approved"].includes(mission.status))
      throw new AdmissionError("mission_state", 409);
    const drafted = await this.draftProposal(mission, summary, affectedArea, criterion);
    return this.transaction(storageKey, body, () => {
      const current = this.mission(missionId);
      if (!["proposed", "approved"].includes(current.status))
        throw new AdmissionError("mission_state", 409);
      current.proposal = drafted.proposal;
      current.contract = drafted.contract;
      current.approvedRevision = undefined;
      current.status = "proposed";
      this.event("mission.updated", current.id, { kind: "principal", id: actor });
      return structuredClone(current);
    });
  }
  approveMission(
    missionId: string,
    revision: string,
    key: string,
    actor = "local-fixture",
  ): Mission {
    this.validateKey(key);
    const approved = this.requireText(revision, "stale_approval", 128);
    return this.transaction(
      `mission_approve_${JSON.stringify([actor, key])}`,
      { missionId, revision: approved },
      () => {
        const mission = this.mission(missionId);
        if (mission.status !== "proposed" || !mission.proposal || !mission.contract)
          throw new AdmissionError("mission_state", 409);
        if (approved !== mission.proposal.revision || approved !== mission.contract.digest)
          throw new AdmissionError("stale_approval", 409);
        if (
          mission.contract.baseSha !== this.state.project.baseSha ||
          mission.contract.configurationRevision !== this.state.project.configurationRevision
        )
          throw new AdmissionError("stale_configuration", 409);
        mission.approvedRevision = approved;
        mission.status = "approved";
        this.event("mission.updated", mission.id, { kind: "principal", id: actor });
        return structuredClone(mission);
      },
    );
  }
  async activateMission(missionId: string, actor: string): Promise<Run> {
    const mission = this.mission(missionId);
    if (mission.runId) return structuredClone(this.evidence(mission.runId).run);
    if (
      mission.status !== "approved" ||
      !mission.proposal ||
      !mission.contract ||
      mission.approvedRevision !== mission.proposal.revision ||
      mission.approvedRevision !== mission.contract.digest
    )
      throw new AdmissionError("mission_approval_required", 409);
    if (
      mission.contract.baseSha !== this.state.project.baseSha ||
      mission.contract.configurationRevision !== this.state.project.configurationRevision
    )
      throw new AdmissionError("stale_configuration", 409);
    if (this.state.runs.some((run) => ["queued", "running"].includes(run.status)))
      throw new AdmissionError("mission_busy", 409);
    const changeId = this.id();
    const runId = this.id();
    const plan = await pinPlan({
      projectId: this.state.project.id,
      changeId,
      baseSha: this.state.project.baseSha,
      candidateSha: this.state.project.baseSha,
      configurationRevision: this.state.project.configurationRevision,
      profile: {
        projectId: this.state.project.id,
        revision: mission.approvedRevision,
        checks: mission.proposal.checks,
      },
      acceptance: mission.proposal.acceptance,
      reproduceBaseline: false,
    });
    const run = this.durableUpdate(() => {
      const current = this.mission(missionId);
      if (current.runId) return structuredClone(this.evidence(current.runId).run);
      if (current.status !== "approved" || current.approvedRevision !== mission.approvedRevision)
        throw new AdmissionError("mission_approval_required", 409);
      if (this.state.runs.some((run) => ["queued", "running"].includes(run.status)))
        throw new AdmissionError("mission_busy", 409);
      const change: Change = {
        id: changeId,
        threadId: current.threadId,
        originMessageIds: [current.messageId],
        contextRevision: this.repositoryContext().revision,
      };
      const run: Run = {
        id: runId,
        threadId: current.threadId,
        messageId: current.messageId,
        changeId,
        status: "queued",
        baseSha: this.state.project.baseSha,
        configurationRevision: this.state.project.configurationRevision,
      };
      this.state.changes!.push(change);
      this.state.runs.push(run);
      (this.state.plans ??= {})[run.id] = plan;
      (this.state.credentialActors ??= {})[run.id] = actor;
      current.changeId = change.id;
      current.runId = run.id;
      current.status = "running";
      this.crewNote(
        current.threadId,
        `note:${run.id}:worker-started`,
        "worker",
        "I'm implementing the approved plan in an isolated checkout.",
        "implementer",
      );
      this.event("change.created", change.id, { kind: "principal", id: actor });
      this.event("run.queued", run.id);
      this.event("mission.updated", current.id, { kind: "principal", id: actor });
      return structuredClone(run);
    });
    this.recordStage({
      threadId: run.threadId,
      runId: run.id,
      missionId,
      role: "coordinator",
      stage: "assign",
      status: "passed",
      title: "Coordinator",
      summary: "Coordinator assigned the approved plan to the change worker.",
      parentId: `${run.threadId}:${missionId}:plan`,
      edgeLabel: "Approved",
      note: {
        id: `note:${run.id}:assigned`,
        role: "coordinator",
        crew: "coordinator",
        content: "Coordinator sent the approved plan to the change worker.",
      },
    });
    return run;
  }
  startMission(missionId: string, key: string, actor = "local-fixture"): Promise<Run> {
    this.validateKey(key);
    const saved = this.state.keys[`mission_start_${JSON.stringify([actor, key])}`];
    if (saved) {
      if (saved.body !== JSON.stringify({ missionId }))
        throw new AdmissionError("idempotency_conflict", 409);
      return Promise.resolve(structuredClone(saved.result) as Run);
    }
    return this.activateMission(missionId, actor).then((run) =>
      this.transaction(`mission_start_${JSON.stringify([actor, key])}`, { missionId }, () => run),
    );
  }
  async delegateApprovedMission(turnId: string): Promise<Run> {
    const turn = this.conversationTurn(turnId);
    if (turn.status !== "running" || !turn.input)
      throw new AdmissionError("conversation_not_running", 409);
    const mission = this.missionForTurn(turn.threadId);
    if (
      !mission?.proposal ||
      !mission.contract ||
      mission.approvedRevision !== mission.proposal.revision ||
      mission.approvedRevision !== mission.contract.digest
    )
      throw new AdmissionError("mission_approval_required", 409);
    if (mission.runId) {
      const existing = this.evidence(mission.runId).run;
      if (["queued", "running"].includes(existing.status)) return structuredClone(existing);
    }
    if (mission.status === "failed") {
      this.durableUpdate(() => {
        mission.status = "approved";
        mission.runId = undefined;
        this.event("mission.updated", mission.id);
      });
    }
    return this.activateMission(mission.id, turn.actor);
  }
  askMission(turnId: string, prompts: string[]): Mission {
    const turn = this.conversationTurn(turnId);
    const mission = this.threadActive(turn.threadId);
    if (!mission) throw new AdmissionError("mission_required", 409);
    if (mission.status !== "clarifying") throw new AdmissionError("mission_state", 409);
    if (mission.questions.some((item) => item.answer)) return structuredClone(mission);
    if (
      !Array.isArray(prompts) ||
      prompts.length < 1 ||
      prompts.length > 5 ||
      prompts.some((prompt) => typeof prompt !== "string" || !prompt.trim() || prompt.length > 500)
    )
      throw new AdmissionError("invalid_question");
    return this.durableUpdate(() => {
      mission.questions = prompts.map((prompt, index) => ({
        id: `q${index + 1}`,
        prompt: prompt.trim(),
      }));
      this.event("mission.updated", mission.id);
      return structuredClone(mission);
    });
  }
  async proposeMission(
    turnId: string,
    input: { summary: string; affectedArea: string; criterion: string },
  ): Promise<Mission> {
    const turn = this.conversationTurn(turnId);
    const mission = this.threadActive(turn.threadId);
    if (!mission) throw new AdmissionError("mission_required", 409);
    if (mission.status === "clarifying" && mission.questions.some((item) => !item.answer)) {
      const answered = mission.questions.find((item) => item.answer)?.answer;
      if (!answered) throw new AdmissionError("questions_pending", 409);
      for (const question of mission.questions) question.answer ??= answered;
    }
    if (!["clarifying", "proposed", "approved"].includes(mission.status))
      throw new AdmissionError("mission_state", 409);
    const summary = this.requireText(input.summary, "invalid_proposal", 4000);
    const affectedArea = this.requireText(input.affectedArea, "invalid_proposal", 200);
    const criterion = this.requireText(input.criterion, "invalid_proposal", 2000);
    const drafted = await this.draftProposal(mission, summary, affectedArea, criterion);
    return this.durableUpdate(() => {
      if (!["clarifying", "proposed", "approved"].includes(mission.status))
        throw new AdmissionError("mission_state", 409);
      mission.proposal = drafted.proposal;
      mission.contract = drafted.contract;
      mission.approvedRevision = undefined;
      mission.status = "proposed";
      this.event("mission.updated", mission.id);
      return structuredClone(mission);
    });
  }
  async ensureChatProposal(turnId: string): Promise<Mission | undefined> {
    const turn = this.conversationTurn(turnId);
    const mission = this.threadActive(turn.threadId);
    if (!mission || mission.status !== "clarifying" || mission.proposal) return;
    if (mission.questions.some((item) => !item.answer)) return;
    const request = this.state.messages.find((message) => message.id === turn.messageId)?.content;
    if (!request?.trim()) return;
    this.recordStage({
      threadId: turn.threadId,
      missionId: mission.id,
      role: "repository",
      stage: "request",
      status: "passed",
      title: "Repository agent",
      summary: "Scoped the request for planning.",
    });
    const proposed = await this.proposeMission(turnId, {
      summary: request.trim().slice(0, 4000),
      affectedArea: "the code named in the request",
      criterion: request.trim().slice(0, 2000),
    });
    this.recordStage({
      threadId: turn.threadId,
      missionId: proposed.id,
      role: "planner",
      stage: "plan",
      status: "passed",
      title: "Planner",
      summary: proposed.proposal?.summary ?? request.trim(),
      parentStage: "request",
      edgeLabel: "Draft plan",
      revision: proposed.proposal?.revision,
      note: {
        id: `note:${proposed.id}:planner`,
        role: "coordinator",
        crew: "planner",
        content: `Planner drafted revision ${proposed.proposal?.revision.slice(0, 12) ?? ""}. It is ready for approval.`,
      },
    });
    return proposed;
  }
  submit(
    threadId: string,
    content: string,
    key: string,
    actor = "local-fixture",
    attachments?: unknown,
  ): SubmitResult {
    this.validateKey(key);
    let acceptedAttachments;
    try {
      acceptedAttachments = validateMessageAttachments(attachments).map((item) => {
        if ("data" in item) throw new AdmissionError("conversation_required");
        return item;
      });
    } catch (error) {
      if (error instanceof AttachmentValidationError) throw new AdmissionError(error.code);
      throw error;
    }
    return this.transaction(
      `message_${JSON.stringify([actor, key])}`,
      {
        threadId,
        content,
        ...(acceptedAttachments.length ? { attachments: acceptedAttachments } : {}),
      },
      () => {
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
          ...(acceptedAttachments.length ? { attachments: acceptedAttachments } : {}),
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
        (this.state.credentialActors ??= {})[run.id] = actor;
        this.event("message.created", message.id, { kind: "principal", id: actor });
        this.event("change.created", change.id, { kind: "principal", id: actor });
        this.event("run.queued", run.id);
        return { message: structuredClone(message), run, change };
      },
    );
  }
  change(changeId: string): Change {
    const change = this.state.changes!.find((change) => change.id === changeId);
    if (!change) throw new AdmissionError("not_found", 404);
    return change;
  }
  retryChange(changeId: string, key: string, catalog?: ModelCatalog, actor = "local-fixture"): Run {
    this.validateKey(key);
    return this.transaction(`retry_${JSON.stringify([actor, key])}`, { changeId, actor }, () => {
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
        runModels: catalog
          ? resolveRunModels(
              catalog,
              this.thread(change.threadId).modelSelection,
              this.state.project.modelSettings,
            )
          : this.state.runs.find((r) => r.changeId === changeId)?.runModels,
        messageId: change.originMessageIds[0],
        threadId: change.threadId,
        status: "queued",
        baseSha: this.state.project.baseSha,
        configurationRevision: this.state.project.configurationRevision,
      };
      this.state.runs.push(run);
      (this.state.credentialActors ??= {})[run.id] = actor;
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
        credentialActor: this.state.credentialActors?.[runId],
        runModels: run.runModels,
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
        contractSnapshot: structuredClone(
          this.state.missions?.find((mission) => mission.runId === runId)?.contract,
        ),
        runId,
        changeId: run.changeId,
        projectId: this.state.project.id,
        threadId: run.threadId,
        repository: this.state.project.repository,
        baseSha: run.baseSha,
        configurationRevision: run.configurationRevision,
        repositoryContext: this.repositoryContext(),
        conversationContext: structuredClone(this.change(run.changeId!).conversationContext),
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
      this.crewNote(
        run.threadId,
        `note:${run.id}:worker-result`,
        "worker",
        result.summary?.trim() || "Implementation finished and is ready for review.",
        "implementer",
      );
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
        this.crewNote(
          run.threadId,
          `note:${run.id}:reviewer`,
          "reviewer",
          `${review.decision === "approve" ? "Approved." : "Changes requested."} ${review.summary}`,
          "reviewer",
        );
        this.event("review.created", review.id);
      }
      this.syncMission(run.id, "awaiting_review");
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
      this.syncMission(run.id, "completed");
    });
  }
  blockModelConfiguration(runId: string) {
    const run = this.evidence(runId).run;
    if (!["queued", "running", "awaiting_review"].includes(run.status)) return;
    this.durableUpdate(() => {
      run.status = "waiting_user";
      run.error = "model_configuration_changed";
      this.event("run.failed", run.id);
    });
  }
  fail(runId: string, reconcile = false) {
    const run = this.evidence(runId).run;
    if (!["queued", "running"].includes(run.status)) return;
    this.durableUpdate(() => {
      run.status = reconcile ? "waiting_user" : "failed";
      run.error = reconcile ? "reconciliation_required" : "execution_failed";
      this.crewNote(
        run.threadId,
        `note:${run.id}:worker-failed`,
        "worker",
        reconcile
          ? "Implementation paused and needs another look before it can continue."
          : "The change worker stopped before it finished. No review was started.",
      );
      this.event("run.failed", run.id);
      this.syncMission(run.id, "failed");
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
