import { validateMentions } from "./mentions";
import type { ConversationTurn, ConversationInput } from "./conversation";
import type { ModelCatalog } from "./model-selection";
import { validateSelection, resolveRunModels } from "./model-selection";
import { selectionAttachmentCapabilities } from "@pitcrew/protocol";
import type { ModelSettings } from "@pitcrew/protocol";
import type { AttachmentStore } from "./attachment-store";
import type { UploadStore } from "./uploads";
import { isStoredFile } from "@pitcrew/protocol";
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
  type VerificationProfile,
  type AcceptanceCriteria,
  type VerificationPlan,
} from "../../../packages/verification/src/index.ts";
import type { VerificationEvidence } from "@pitcrew/protocol";
import { AttachmentValidationError, validateMessageAttachments } from "@pitcrew/protocol";
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
  identityBindings?: Record<string, { userId: string; email: string }>;
  collaboration?: import("./collaboration").CollaborationState;
  ownedProjects?: Record<
    string,
    { state: State; sourceName: string; sourceId: string; ownerActor: string }
  >;
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
  runActors?: Record<string, string>;
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
  bindVerifiedAccount(accessActor: string, userId: string, email: string) {
    const bindings = this.state.identityBindings ?? {};
    const existing = bindings[accessActor];
    if (existing) {
      if (existing.userId !== userId || existing.email !== email)
        throw new AdmissionError("identity_binding_conflict", 403);
      return;
    }
    if (Object.values(bindings).some((item) => item.userId === userId))
      throw new AdmissionError("identity_binding_conflict", 403);
    this.durableUpdate(() => {
      (this.state.identityBindings ??= {})[accessActor] = { userId, email };
    });
  }
  addOwnedProject(
    sourceName: string,
    sourceId: string,
    actor: string,
    email: string,
    configuration?: Pick<Project, "baseSha" | "configurationRevision">,
    profile?: import("./collaboration").Identity,
  ) {
    return this.durableUpdate(() => {
      const directory = (this.state.ownedProjects ??= {});
      if (Object.values(directory).some((entry) => entry.sourceId === sourceId))
        throw new AdmissionError("repository_already_registered", 409);
      if (Object.keys(directory).length >= 20) throw new AdmissionError("capacity", 429);
      const id = this.id();
      const projectState = initialState({
        id,
        name: sourceName,
        repository: `artifact:${sourceName}`,
        // An empty source has no commit. Execution remains gated until an
        // independently verified initial commit supplies a real base SHA.
        baseSha: "0".repeat(40),
        configurationRevision: "uninitialized-v1",
        ...configuration,
      });
      projectState.collaboration = {
        projectMembers: {
          [actor]: {
            actor,
            email,
            role: "owner",
            ...(profile
              ? {
                  username: profile.username,
                  displayName: profile.displayName,
                  avatar: profile.avatar,
                }
              : {}),
          },
        },
        threadMembers: {},
        invitations: {},
      };
      directory[id] = { state: projectState, sourceName, sourceId, ownerActor: actor };
      return projectState.project;
    });
  }
  updateOwnedProject(id: string, state: State) {
    this.durableUpdate(() => {
      const entry = this.state.ownedProjects?.[id];
      if (!entry) throw new AdmissionError("not_found", 404);
      entry.state = structuredClone(state);
      if (new TextEncoder().encode(JSON.stringify(this.state)).byteLength > 16 * 1024 * 1024)
        throw new AdmissionError("repository_storage_limit", 413);
    });
  }
  updateCollaboration<T>(operation: (state: State) => T): T {
    return this.durableUpdate(() => operation(this.state));
  }
  constructor(
    public state: State,
    private persistState: (state: State) => void,
    private now = () => new Date().toISOString(),
    private id: () => string = () => crypto.randomUUID(),
    private attachments?: AttachmentStore,
    private atomic: <T>(operation: () => T) => T = (operation) => operation(),
    private uploads?: UploadStore,
  ) {
    const needsMigration =
      Object.keys(state.keys).some(
        (key) => key.startsWith("conversation_") && !key.startsWith("conversation_["),
      ) ||
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
          if (key.startsWith("conversation_") && !key.startsWith("conversation_[")) {
            const turn = (entry.result as { turn?: ConversationTurn })?.turn;
            if (turn?.actor) {
              const scoped = `conversation_${JSON.stringify([turn.actor, key.slice("conversation_".length)])}`;
              this.state.keys[scoped] ??= entry;
              delete this.state.keys[key];
            }
          }
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
      if (previous?.threadId && !this.actorAuthorized(actor, previous.threadId))
        throw new AdmissionError("not_found", 404);
      for (const ref of body.sourceRefs) {
        const message =
          ref.kind === "message" && this.state.messages.find((item) => item.id === ref.id);
        const review =
          ref.kind === "review" && this.state.reviews.find((item) => item.id === ref.id);
        const run =
          ref.kind === "artifact"
            ? this.state.runs.find((item) => item.artifactId === ref.id)
            : review
              ? this.state.runs.find((item) => item.id === review.runId)
              : undefined;
        const threadId = message ? message.threadId : run?.threadId;
        if (threadId && !this.actorAuthorized(actor, threadId))
          throw new AdmissionError("not_found", 404);
      }
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
      !this.runAuthorized(context.runId) ||
      ["failed", "stopped", "waiting_user"].includes(run.status) ||
      context.baseSha !== this.state.project.baseSha ||
      context.configurationRevision !== this.state.project.configurationRevision
    )
      return { status: "stale" };
    const currentKnowledge = this.repositoryContext(
      this.state.runActors?.[context.runId] ?? this.state.credentialActors?.[context.runId],
    ).currentKnowledge!;
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
    if (!this.runAuthorized(context.runId)) return { eventId, status: "stale" };
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
  async updateProfile(
    profile: VerificationProfile,
    expectedRevision: string,
    authorize = () => {},
  ) {
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
    authorize();
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
    membershipActor = actor,
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
      () => {
        if (this.state.collaboration && !this.state.collaboration.projectMembers[membershipActor])
          throw new AdmissionError("not_found", 404);
        return dispatchIntake(
          (this.state.intake ??= initialIntake()),
          this.intakeContext(actor),
          key,
          input,
          {
            verifyActive: (scope, link) => {
              if (!this.actorAuthorized(membershipActor, link.threadId))
                throw new AdmissionError("not_found", 404);
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
              if (this.state.collaboration) {
                const member = this.state.collaboration.projectMembers[membershipActor];
                if (!member) throw new AdmissionError("not_found", 404);
                this.state.collaboration.threadMembers[thread.id] = {
                  [membershipActor]: { ...member, role: "owner" },
                };
              }
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
              (this.state.runActors ??= {})[run.id] = membershipActor;
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
        );
      },
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
    if (reference && isStoredFile(reference)) {
      const message = this.state.messages.find(
        (item) => item.threadId === threadId && item.attachments?.includes(reference),
      );
      if (!message || !this.uploads) throw new AdmissionError("not_found", 404);
      return this.uploads.download(attachmentId, threadId, message.id);
    }
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
    const threadId =
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
          : type === "run.completed" && run?.landing
            ? run.landing.backend === "artifacts"
              ? "source_landed"
              : "fixture_landed"
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
  createThread(title: string, key: string, actor = "local-fixture", email?: string) {
    this.validateKey(key);
    return this.transaction(`thread_${JSON.stringify([actor, key])}`, { title }, () => {
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
      if (this.state.collaboration) {
        const member = this.state.collaboration.projectMembers[actor];
        if (!member || member.email !== email) throw new AdmissionError("not_found", 404);
        this.state.collaboration.threadMembers[thread.id] = {
          [actor]: { ...member, role: "owner" },
        };
      }
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
        Object.keys(input.roles).some((key) => !["implementer", "reviewer"].includes(key)))
    )
      throw new AdmissionError("invalid_model_settings");
    const normalized: ModelSettings = { default: validateSelection(catalog, input.default) };
    if (input.roles) {
      normalized.roles = {};
      for (const role of ["implementer", "reviewer"] as const)
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
    author?: Message["author"],
    mentions?: unknown,
  ) {
    this.validateKey(key);
    const storageKey = `conversation_${JSON.stringify([actor, key])}`;
    // Leave room for the bounded pending replies and terminal worker/event records.
    if (
      !this.state.keys[storageKey] &&
      new TextEncoder().encode(JSON.stringify(this.state)).byteLength > 15 * 1024 * 1024
    )
      throw new AdmissionError("repository_storage_limit", 413);
    const previous = this.state.keys[storageKey]?.result as
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
    const resolved = this.uploads?.resolve(
      attachments,
      author?.actor ?? actor,
      threadId,
      capabilities,
      previous?.message.id,
    );
    const accepted = resolved?.attachments ?? validateMessageAttachments(attachments, capabilities);
    // Replay compares bytes against immutable references, without storing user image bytes in keys.
    if (previous)
      accepted.forEach((item, index) => {
        if ("data" in item) {
          const ref = previous.message.attachments?.[index];
          if (
            !this.attachments ||
            !ref ||
            !("attachmentId" in ref) ||
            isStoredFile(ref) ||
            !this.attachments.matches(ref, item)
          )
            throw new AdmissionError("idempotency_conflict", 409);
        }
      });
    const descriptor = accepted.map((item) =>
      "data" in item ? { id: item.id, name: item.name, mediaType: item.mediaType } : item,
    );
    return this.transaction(
      storageKey,
      {
        threadId,
        content,
        actor,
        selection: chosen,
        attachments: descriptor,
        ...(Array.isArray(mentions) && !mentions.length
          ? {}
          : mentions === undefined
            ? {}
            : { mentions }),
      },
      () => {
        if (typeof content !== "string" || !content.trim() || content.length > 8000)
          throw new AdmissionError("invalid_content");
        const acceptedMentions = validateMentions(
          content,
          mentions,
          threadId,
          this.state.collaboration,
        );
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
          .map((item) =>
            isStoredFile(item) ? item : "attachmentId" in item ? this.attachments!.get(item) : item,
          );
        let imageBytes = 0,
          imageCount = 0,
          textBytes = 0;
        for (const item of [...historyAttachments, ...accepted]) {
          if ("kind" in item) continue;
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
          ...(acceptedMentions.length ? { mentions: acceptedMentions } : {}),
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
          ...(acceptedMentions.length ? { mentions: acceptedMentions } : {}),
          ...(author ? { author: structuredClone(author) } : {}),
          content: content.trim(),
          attachments: stored?.length ? stored : undefined,
          createdAt: this.now(),
        };
        if (resolved?.ids.length)
          this.uploads!.link(resolved.ids, author?.actor ?? actor, threadId, message.id);
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
          membershipActor: author?.actor ?? actor,
          contextBudgetBytes: contextLimit,
          baseSha: this.state.project.baseSha,
          configurationRevision: this.state.project.configurationRevision,
          createdAt: this.now(),
        };
        thread.modelSelection = structuredClone(chosen);
        this.state.messages.push(message);
        turns.push(turn);
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
        repositoryContext: this.repositoryContext(turn.membershipActor ?? turn.actor),
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
  appendNote(
    threadId: string,
    content: string,
    key: string,
    actor: string,
    author?: Message["author"],
    attachments?: unknown,
    mentions?: unknown,
  ): Message {
    this.validateKey(key);
    if (
      attachments !== undefined &&
      (!Array.isArray(attachments) ||
        attachments.some((item) => !item || typeof item !== "object" || !("uploadId" in item)))
    )
      throw new AdmissionError("note_attachments_unavailable");
    if (new TextEncoder().encode(JSON.stringify(this.state)).byteLength > 15 * 1024 * 1024)
      throw new AdmissionError("repository_storage_limit", 413);
    const storageKey = `note_${JSON.stringify([actor, key])}`;
    const previous = this.state.keys[storageKey]?.result as Message | undefined;
    const resolved = this.uploads?.resolve(
      attachments,
      author?.actor ?? actor,
      threadId,
      undefined,
      previous?.id,
    );
    if (!this.uploads && Array.isArray(attachments) && attachments.length)
      throw new AdmissionError("note_attachments_unavailable");
    return this.transaction(
      `note_${JSON.stringify([actor, key])}`,
      {
        threadId,
        content,
        ...(Array.isArray(mentions) && !mentions.length
          ? {}
          : mentions === undefined
            ? {}
            : { mentions }),
        ...(resolved?.attachments.length ? { attachments: resolved.attachments } : {}),
      },
      () => {
        this.thread(threadId);
        if (typeof content !== "string" || !content.trim() || content.length > 8000)
          throw new AdmissionError("invalid_content");
        if (this.state.messages.length >= 500) throw new AdmissionError("capacity", 429);
        const acceptedMentions = validateMentions(
          content,
          mentions,
          threadId,
          this.state.collaboration,
        );
        const message: Message = {
          id: this.id(),
          threadId,
          role: "user",
          ...(acceptedMentions.length ? { mentions: acceptedMentions } : {}),
          ...(resolved?.attachments.length
            ? {
                attachments: resolved.attachments.map((item) =>
                  "data" in item ? this.attachments!.put(item) : item,
                ),
              }
            : {}),
          content: content.trim(),
          createdAt: this.now(),
          ...(author ? { author: structuredClone(author) } : {}),
        };
        if (resolved?.ids.length)
          this.uploads!.link(resolved.ids, author?.actor ?? actor, threadId, message.id);
        this.state.messages.push(message);
        this.event("message.created", message.id, { kind: "principal", id: actor });
        return structuredClone(message);
      },
    );
  }
  delegateConversation(id: string) {
    const turn = this.conversationTurn(id);
    if (!this.actorAuthorized(turn.membershipActor ?? turn.actor, turn.threadId))
      throw new AdmissionError("not_found", 404);
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
      (this.state.runActors ??= {})[run.id] = turn.membershipActor ?? turn.actor;
      this.event("change.created", change.id);
      this.event("run.queued", run.id);
      return structuredClone(run);
    });
  }
  submit(
    threadId: string,
    content: string,
    key: string,
    actor = "local-fixture",
    attachments?: unknown,
    author?: Message["author"],
    mentions?: unknown,
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
        ...(Array.isArray(mentions) && !mentions.length
          ? {}
          : mentions === undefined
            ? {}
            : { mentions }),
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
        const acceptedMentions = validateMentions(
          content,
          mentions,
          threadId,
          this.state.collaboration,
        );
        const message: Message = {
          id: this.id(),
          threadId,
          role: "user",
          ...(acceptedMentions.length ? { mentions: acceptedMentions } : {}),
          ...(author ? { author: structuredClone(author) } : {}),
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
        (this.state.runActors ??= {})[run.id] = author?.actor ?? actor;
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
  retryChange(
    changeId: string,
    key: string,
    catalog?: ModelCatalog,
    actor = "local-fixture",
    membershipActor = actor,
  ): Run {
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
      (this.state.runActors ??= {})[run.id] = membershipActor;
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
  repositoryContext(actor?: string): RepositoryContext {
    const currentKnowledge = this.currentKnowledge();
    if (actor !== undefined)
      currentKnowledge.entries = currentKnowledge.entries.filter(
        (entry) => !entry.threadId || this.actorAuthorized(actor, entry.threadId),
      );
    const active = this.state.runs.filter(
      (run) =>
        ["queued", "running", "waiting_user", "awaiting_review"].includes(run.status) &&
        (actor === undefined || this.actorAuthorized(actor, run.threadId)),
    );
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
      activeWorkOmitted: Math.max(0, active.length - 20),
      activeWork: active.slice(0, 20).map((run) => ({
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
  actorAuthorized(actor: string | undefined, threadId: string) {
    const access = this.state.collaboration;
    return (
      !access ||
      !!(actor && access.projectMembers[actor] && access.threadMembers[threadId]?.[actor])
    );
  }
  runAuthorized(runId: string) {
    const run = this.state.runs.find((item) => item.id === runId);
    return (
      !!run &&
      this.actorAuthorized(
        this.state.runActors?.[runId] ?? this.state.credentialActors?.[runId],
        run.threadId,
      )
    );
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
        runId,
        changeId: run.changeId,
        projectId: this.state.project.id,
        threadId: run.threadId,
        repository: this.state.project.repository,
        baseSha: run.baseSha,
        configurationRevision: run.configurationRevision,
        repositoryContext: this.repositoryContext(
          this.state.runActors?.[runId] ?? this.state.credentialActors?.[runId],
        ),
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
  freezeArtifactAdmission(
    runId: string,
    admission: import("@pitcrew/protocol").ArtifactRunAdmission,
  ) {
    const run = this.evidence(runId).run;
    if (
      run.artifactAdmission &&
      JSON.stringify(run.artifactAdmission) !== JSON.stringify(admission)
    )
      throw Error("admission_identity_conflict");
    this.durableUpdate(() => {
      run.artifactAdmission = structuredClone(admission);
      if (this.state.requests?.[runId])
        this.state.requests[runId].artifactAdmission = structuredClone(admission);
    });
  }
  confirmFixtureLanding(runId: string, result: LandingResultReceipt) {
    this.confirmLanding(runId, result);
  }
  confirmLanding(runId: string, result: LandingResultReceipt) {
    if (result.status !== "landed") return;
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
