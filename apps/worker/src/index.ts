import { resolveInvitationRecipient } from "./invitation-recipient";
import {
  credentialStorageAvailable,
  providerConnectionRequest,
  userCredential,
  userModelEnv,
} from "./user-credentials";
export { UserCredentials } from "./user-credentials-agent";
import {
  RepositoryLifecycle,
  lifecycleRequest,
  type LifecycleRecord,
  logicalRepositoryName,
} from "./repository-lifecycle";
import {
  approvedRepositoryCreation,
  accountRepositoryManagement,
  accountRepositoryDeletion,
  readRepositoryBody,
  repositoryMetadata,
  readRepositoryCreation,
  creationProjection,
  creationError,
  RepositoryCreationError,
} from "./account-repository-creation";
import { SourceReader } from "./source-reader";
import { readRepositoryState, writeRepositoryState } from "./repository-state";
import { sameKnowledgeContext } from "./knowledge";
import { RepoMemory, type RepoMemoryCompression, type RepoMemoryPage } from "./repo-memory";
import {
  memoryAccess,
  memoryAuthorizer,
  memoryBrief,
  messageMemorySources,
  memoryCompressionSystem,
  coalesceMemoryReferences,
} from "./repo-memory-orchestration";
import type { ConversationInput } from "./conversation";
import type { RepositoryMemoryBrief, RepositoryMemoryReference } from "@pitcrew/protocol";
import type { MemoryToolArguments } from "./repo-memory-tools";
import { configureSelectedModels } from "./model-selection";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { RepoConversationAgent } from "./repo-conversation-agent";
export { RepoConversationAgent };
import { resolveCatalog, validateFrozenModels, requiresUserOpenRouter } from "./model-selection";
import { providerModelsRequest } from "./provider-models";
import { attachmentStore, type AttachmentStore } from "./attachment-store";
import { sqlUploadStore, type UploadStore } from "./uploads";
import { VisualizationStore } from "./visualization-store";
import { VisualizationTurnGrants } from "./visualization-turn-grants";
import { VisualizationAuthorityGate } from "./visualization-authority-gate";
import {
  visualizationGrant,
  visualizationSession,
  requireVisualizationSession,
} from "./visualization-auth";
import { publishVisualization, visualizationRequest } from "./visualization-api";
import {
  VisualizationError,
  readVisualizationContent,
  documentFragment,
} from "../../../packages/protocol/src/visualizations";
import {
  ATTACHMENT_LIMITS,
  UPLOAD_LIMITS,
  type StoredImageAttachment,
  type ImageAttachment,
} from "@pitcrew/protocol";
import type { WorkerKnowledgeContext, KnowledgeReport } from "@pitcrew/protocol";
import { TrustedPublisherAgent } from "./trusted-publisher-agent";
export { TrustedPublisherAgent };
import {
  signPublisherAuthorization,
  publisherBundleDigest,
  MAX_PUBLISHER_LIFETIME_MS,
  type PublisherIdentity,
  type PublisherInput,
  type PublisherLandingInput,
  type PublisherResult,
} from "../../../packages/execution/src/trusted-publisher";
import { assertSha, ExecutionError } from "../../../packages/execution/src/contracts";
import {
  assertLandingEvidence,
  type LandingAuthorization,
  type LandingResult,
} from "../../../packages/execution/src/landing";
import {
  artifactLandingApi,
  assertArtifactSource,
  assertCandidateArtifact,
  type ArtifactSource,
} from "./cloud-landing-api";
import { SqliteLandingStore } from "../../../packages/execution/src/landing-store";
import { fixtureLandingApi, assertConfigurationIdle, type LandingApi } from "./landing-api";
import { cloudInitialState } from "./cloud-configuration";
import { principal, protectedFetch, type AccessEnv } from "./access";
import { Collaboration } from "./collaboration";
import { ThreadPresence } from "./thread-presence";
import { configuredAuth, authRequest, authUser, type AuthEnv } from "./auth";
import {
  isPasswordIngress,
  passwordIngressRequest,
  privateIngressResponse,
} from "./password-ingress";
import { Agent, getAgentByName } from "agents";
import { ChangeAgent, ReviewAgent, type PiEnv } from "./pi-agents";
export { ChangeAgent, ReviewAgent };
import { DurableJobs } from "./durable-jobs";
import {
  InfrastructureAdmission,
  sqliteAdmission,
  boundedCleanupRpc,
} from "./infrastructure-admission";
import { api } from "./api";
import {
  AdmissionError,
  Coordinator,
  fakeExecution,
  initialState,
  type State,
} from "./coordinator";
interface Env extends PiEnv, AccessEnv, AuthEnv {
  ASSETS?: Fetcher;
  PROJECT_BASE_SHA?: string;
  CHANGE: DurableObjectNamespace<ChangeAgent>;
  CONVERSATION?: DurableObjectNamespace<RepoConversationAgent>;
  ARTIFACT_REPOSITORY?: string;
  ARTIFACT_REPOSITORY_ID?: string;
  REPOSITORY: DurableObjectNamespace<RepositoryAgent>;
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  LANDING_MODE?: string;
  ARTIFACTS_CAS_CONFORMANCE_VERIFIED?: string;
  EXECUTION_MODE: string;
  REPOSITORY_LIFECYCLE?: string;
  INFRASTRUCTURE_ADMISSION_ENABLED?: string;
  CLOUD_CONVERSATION_ENABLED?: string;
  ADOPT_REPOSITORY_NAME?: string;
  ADOPT_REPOSITORY_ID?: string;
  ADOPT_ACCOUNT_ACTOR?: string;
  CREATE_ACCOUNT_ACTOR?: string;
  CREATE_REPOSITORY_NAME?: string;
  ACCOUNT_REPOSITORY_MANAGEMENT?: string;
  ACCOUNT_REPOSITORY_DELETE?: string;
}
export class RepositoryAgent extends Agent<Env> {
  private repoMemory?: RepoMemory;
  private getRepoMemory() {
    if (this.env.REPO_MEMORY_ENABLED !== "true") throw Error("repo_memory_disabled");
    return (this.repoMemory ??= new RepoMemory(this.ctx.storage.sql, (work) =>
      this.ctx.storage.transactionSync(work),
    ));
  }
  private memoryTurn(turnId: string) {
    const core = this.turnCoordinator(turnId);
    if (!core || !this.conversationsEnabled()) throw Error("memory_access_revoked");
    const turn = core.conversationTurn(turnId);
    if (
      turn.status !== "running" ||
      !turn.input ||
      !turn.input.memoryEnabled ||
      turn.baseSha !== core.state.project.baseSha ||
      turn.configurationRevision !== core.state.project.configurationRevision
    )
      throw Error("memory_access_revoked");
    const access = memoryAccess(core, turn.membershipActor ?? turn.actor, turn.threadId);
    const eligible = new Set((turn.input.memoryMessageIds ?? []).map((id) => `message:${id}:`));
    for (const review of core.state.reviews) {
      const event = core.state.events.find(
        (item) => item.type === "review.created" && item.entityId === review.id,
      );
      if (event && event.sequence <= (turn.input.memoryEventSequence ?? 0))
        eligible.add(`message:review:${review.id}:`);
    }
    for (const event of core.state.events)
      if (
        ["run.completed", "run.failed"].includes(event.type) &&
        event.sequence <= (turn.input.memoryEventSequence ?? 0)
      )
        eligible.add(`message:run:${event.entityId}:${event.sequence}:`);
    const authorizeBase = memoryAuthorizer(core);
    const authorize: ReturnType<typeof memoryAuthorizer> = (source, current) =>
      authorizeBase(source, current) &&
      [...eligible].some((prefix) => source.sourceId.startsWith(prefix));
    return { core, turn, access, authorize, store: this.getRepoMemory() };
  }
  private memoryContextTable() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_memory_model_requests(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,reserved INTEGER NOT NULL,state TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_memory_turn_context(turn_id TEXT PRIMARY KEY,brief TEXT NOT NULL,disclosures TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,input_bytes INTEGER NOT NULL DEFAULT 0,output_bytes INTEGER NOT NULL DEFAULT 0,native_input_bytes INTEGER NOT NULL DEFAULT 0)",
    );
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(repo_memory_turn_context)")
      .toArray();
    if (!columns.some((column) => column.name === "native_input_bytes"))
      this.ctx.storage.sql.exec(
        "ALTER TABLE repo_memory_turn_context ADD COLUMN native_input_bytes INTEGER NOT NULL DEFAULT 0",
      );
  }
  private memoryContext(turnId: string) {
    this.memoryContextTable();
    const row = this.ctx.storage.sql
      .exec<{
        brief: string;
        disclosures: string;
        calls: number;
        input_bytes: number;
        output_bytes: number;
        native_input_bytes: number;
      }>("SELECT * FROM repo_memory_turn_context WHERE turn_id=?", turnId)
      .toArray()[0];
    return row
      ? {
          ...row,
          brief: JSON.parse(row.brief) as RepositoryMemoryBrief,
          disclosures: JSON.parse(row.disclosures) as RepositoryMemoryReference[],
        }
      : undefined;
  }
  protected async compressRepoMemory(input: ConversationInput, job: RepoMemoryCompression) {
    const { models, model, selection } = configureSelectedModels(
      userModelEnv(this.env, input.credentialActor),
      input.models.repoAgent,
      input.models.catalogRevision,
    );
    if (this.env.EXECUTION_MODE === "fake") {
      const faux = fauxProvider({
        provider: model.provider,
        models: [{ id: model.id, maxTokens: 256 }],
      });
      faux.setResponses([
        fauxAssistantMessage(
          '{"summary":"Development fixture memory; original source journal remains available through memory_zoom."}',
        ),
      ]);
      models.setProvider(faux.provider);
    }
    const provider = models.getProvider(model.provider);
    if (!provider) throw Error("model_not_configured");
    models.setProvider({
      ...provider,
      streamSimple: (selected, context, options) => {
        const fresh = this.memoryTurn(input.turnId);
        fresh.store.assertTurnReferences(
          input.turnId,
          fresh.access,
          fresh.authorize,
          job.sourceRefs,
        );
        return provider.streamSimple(selected, context, options);
      },
    });
    const prompt = JSON.stringify({ merge: job.merge, source: job.source });
    if (
      new TextEncoder().encode(prompt + memoryCompressionSystem).byteLength >
      Math.min(196608, Math.floor(model.contextWindow / 2)) - 8192
    )
      throw Error("memory_compression_context_limit");
    const result = await models.completeSimple(
      model,
      {
        systemPrompt: memoryCompressionSystem,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        maxTokens: 256,
        reasoning: selection.effort === "off" ? undefined : selection.effort,
        signal: AbortSignal.timeout(20000),
        maxRetries: 0,
      },
    );
    if (result.stopReason !== "stop" || result.content.some((part) => part.type !== "text"))
      throw Error("invalid_memory_summary");
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    if (new TextEncoder().encode(text).byteLength > 2048) throw Error("invalid_memory_summary");
    const parsed: unknown = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      typeof (parsed as { summary?: unknown }).summary !== "string"
    )
      throw Error("invalid_memory_summary");
    return (parsed as { summary: string }).summary;
  }
  protected async prepareRepoMemory(core: Coordinator, turnId: string) {
    const { turn, access, authorize, store } = this.memoryTurn(turnId);
    if (core !== this.turnCoordinator(turnId)) throw Error("memory_context_mismatch");
    if (this.memoryContext(turnId)) {
      await this.freshConversationMemory(turnId);
      const message = core.state.messages.find((item) => item.id === turn.messageId);
      if (message)
        for (const source of messageMemorySources(access.projectId, access.repository, message))
          store.append(source);
      return;
    }
    // Bounded source state is retained independently of admitted model context.
    for (const message of core.state.messages.filter((message) =>
      turn.input!.memoryMessageIds?.includes(message.id),
    ))
      for (const source of messageMemorySources(access.projectId, access.repository, message))
        store.append(source);
    for (const review of core.state.reviews) {
      const run = core.state.runs.find((candidate) => candidate.id === review.runId);
      const reviewEvent = core.state.events.find(
        (event) => event.type === "review.created" && event.entityId === review.id,
      );
      if (!run || !reviewEvent || reviewEvent.sequence > (turn.input!.memoryEventSequence ?? 0))
        continue;
      for (const source of messageMemorySources(access.projectId, access.repository, {
        id: `review:${review.id}`,
        threadId: run.threadId,
        role: "reviewer",
        content: JSON.stringify(review),
        createdAt: reviewEvent.createdAt,
      }))
        store.append(source);
    }
    for (const run of core.state.runs.filter((candidate) =>
      ["completed", "failed", "stopped"].includes(candidate.status),
    )) {
      const terminal = [...core.state.events]
        .reverse()
        .find(
          (event) =>
            event.entityId === run.id &&
            ["run.completed", "run.failed"].includes(event.type) &&
            event.sequence <= (turn.input!.memoryEventSequence ?? 0),
        );
      if (!terminal) continue;
      for (const source of messageMemorySources(access.projectId, access.repository, {
        id: `run:${run.id}:${terminal.sequence}`,
        threadId: run.threadId,
        role: "worker",
        content: JSON.stringify({
          event: terminal,
          runId: run.id,
          threadId: run.threadId,
          baseSha: run.baseSha,
          configurationRevision: run.configurationRevision,
          candidateSha: run.candidateSha,
          error: run.error,
          tests: core.state.evidence[run.id],
        }),
        createdAt: terminal.createdAt,
      }))
        store.append(source);
    }
    store.beginTurn(turnId, access, {
      maxToolCalls: 24,
      maxCompressions: 4,
      maxInputBytes: 131072,
      maxOutputBytes: 32768,
    });
    for (let index = 0; index < 4; index++) {
      const callId = `proactive:compression:${index}`;
      const job = await store.nextCompression(turnId, callId, access, authorize);
      this.memoryTurn(turnId);
      if (!job) continue;
      try {
        const summary = await this.compressRepoMemory(turn.input!, job);
        const fresh = this.memoryTurn(turnId);
        fresh.store.acceptSummary(turnId, callId, fresh.access, fresh.authorize, {
          nodeId: job.nodeId,
          inputId: job.inputId,
          text: summary,
        });
      } catch {
        // Dispatch is durably spent; malformed or unavailable compression leaves originals pending.
        this.memoryTurn(turnId);
      }
    }
    const fresh = this.memoryTurn(turnId);
    const pages = [
      fresh.store.view(turnId, "proactive:view", fresh.access, fresh.authorize, { limit: 4 }),
    ];
    for (const category of ["incident", "impact", "prefer", "design"]) {
      const current = this.memoryTurn(turnId);
      pages.push(
        current.store.search(turnId, `proactive:${category}`, current.access, current.authorize, {
          query: category,
          limit: 2,
        }),
      );
    }
    const brief = memoryBrief(fresh.access, pages),
      disclosures = coalesceMemoryReferences(brief.items.flatMap((item) => item.sourceRefs));
    fresh.store.assertTurnReferences(turnId, fresh.access, fresh.authorize, disclosures);
    this.ctx.storage.transactionSync(() => {
      this.memoryContextTable();
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO repo_memory_turn_context(turn_id,brief,disclosures) VALUES(?,?,?)",
        turnId,
        JSON.stringify(brief),
        JSON.stringify(disclosures),
      );
      core.updateCollaboration(() => {
        turn.input!.memoryBrief = structuredClone(brief);
      });
    });
    const currentMessage = core.state.messages.find((message) => message.id === turn.messageId);
    if (currentMessage)
      for (const source of messageMemorySources(
        access.projectId,
        access.repository,
        currentMessage,
      ))
        store.append(source);
  }
  private assertConversationMemory(turnId: string): ConversationInput {
    const core = this.turnCoordinator(turnId);
    if (!core || !this.conversationsEnabled()) throw Error("conversation_access_revoked");
    const turn = core.conversationTurn(turnId);
    if (
      turn.status !== "running" ||
      !turn.input ||
      !core.actorAuthorized(turn.membershipActor ?? turn.actor, turn.threadId) ||
      turn.baseSha !== core.state.project.baseSha ||
      turn.configurationRevision !== core.state.project.configurationRevision
    )
      throw Error("conversation_access_revoked");
    if (turn.input.memoryEnabled) {
      const fresh = this.memoryTurn(turnId),
        context = this.memoryContext(turnId);
      if (!context) throw Error("memory_context_unavailable");
      fresh.store.assertTurnReferences(turnId, fresh.access, fresh.authorize, context.disclosures);
      if (JSON.stringify(turn.input.memoryBrief) !== JSON.stringify(context.brief))
        throw Error("memory_context_mismatch");
    }
    return structuredClone(turn.input);
  }
  async freshConversationMemory(turnId: string): Promise<ConversationInput> {
    return this.assertConversationMemory(turnId);
  }
  private assertRunMemory(core: Coordinator, runId: string) {
    const run = core.state.runs.find((candidate) => candidate.id === runId);
    if (!run?.changeId) return;
    const brief =
      core.state.requests?.[runId]?.memoryBrief ??
      core.state.changes?.find((change) => change.id === run.changeId)?.memoryBrief;
    if (!brief) return;
    const origin = core.memoryConversationOrigin(run.changeId);
    const saved = this.memoryContext(origin.id);
    if (
      !saved ||
      JSON.stringify(saved.brief) !== JSON.stringify(brief) ||
      brief.projectId !== core.state.project.id ||
      brief.repository !== core.state.project.repository ||
      brief.destinationThreadId !== run.threadId ||
      run.baseSha !== core.state.project.baseSha ||
      run.configurationRevision !== core.state.project.configurationRevision
    )
      throw Error("memory_access_revoked");
    const access = memoryAccess(
      core,
      core.state.runActors?.[runId] ?? core.state.credentialActors?.[runId] ?? "",
      run.threadId,
    );
    this.getRepoMemory().assertSnapshotReferences(
      origin.id,
      access,
      memoryAuthorizer(core),
      coalesceMemoryReferences(brief.items.flatMap((item) => item.sourceRefs)),
    );
  }
  private bindMemoryFences(core: Coordinator) {
    core.repoMemoryEnabled = this.env.REPO_MEMORY_ENABLED === "true";
    core.memoryRunFence = (runId) => this.assertRunMemory(core, runId);
    core.memoryConversationFence = (turnId) => {
      if (core.conversationTurn(turnId).input?.memoryEnabled) this.assertConversationMemory(turnId);
    };
  }
  async readRepoMemory(
    turnId: string,
    callId: string,
    operation: "view" | "search" | "zoom",
    args: MemoryToolArguments,
  ): Promise<RepoMemoryPage> {
    await this.freshConversationMemory(turnId);
    const current = this.memoryTurn(turnId);
    const page =
      operation === "view"
        ? current.store.view(turnId, callId, current.access, current.authorize, args)
        : operation === "search"
          ? current.store.search(turnId, callId, current.access, current.authorize, {
              ...args,
              query: args.query ?? "",
            })
          : operation === "zoom"
            ? current.store.zoom(turnId, callId, current.access, current.authorize, {
                ...args,
                nodeId: args.nodeId ?? "",
              })
            : undefined;
    if (!page) throw Error("invalid_memory_operation");
    const context = this.memoryContext(turnId)!;
    const refs = [...context.disclosures, ...page.items.flatMap((item) => item.sourceRefs)];
    const unique = coalesceMemoryReferences(refs);
    if (unique.length > 32) throw Error("memory_reference_limit");
    current.store.assertTurnReferences(turnId, current.access, current.authorize, unique);
    this.ctx.storage.sql.exec(
      "UPDATE repo_memory_turn_context SET disclosures=? WHERE turn_id=?",
      JSON.stringify(unique),
      turnId,
    );
    return page;
  }
  async authorizeConversationModel(
    turnId: string,
    inputBytes = 0,
    outputBytes = 0,
    response = false,
    requestId?: string,
    nativeInputBytes = 0,
  ) {
    await this.freshConversationMemory(turnId);
    const core = this.turnCoordinator(turnId)!;
    if (!core.conversationTurn(turnId).input!.memoryEnabled) return;
    const maximumInput = Math.max(
      0,
      Math.min(core.conversationTurn(turnId).contextBudgetBytes ?? 196608, 196608) - 8192,
    );
    if (
      ![inputBytes, outputBytes, nativeInputBytes].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      inputBytes > maximumInput ||
      inputBytes + nativeInputBytes > ATTACHMENT_LIMITS.nativeInputBytes ||
      outputBytes > 16384 ||
      (requestId !== undefined && !/^[a-f0-9-]{36}$/.test(requestId))
    )
      throw Error("conversation_budget_exhausted");
    this.ctx.storage.transactionSync(() => {
      this.assertConversationMemory(turnId);
      const current = this.memoryContext(turnId)!;
      const reservation =
        requestId && response
          ? this.ctx.storage.sql
              .exec<{ reserved: number; state: string }>(
                "SELECT reserved,state FROM repo_memory_model_requests WHERE id=? AND turn_id=?",
                requestId,
                turnId,
              )
              .toArray()[0]
          : undefined;
      const reserve = !response && requestId ? 16384 : 0;
      const nextOutput =
        current.output_bytes +
        outputBytes +
        reserve -
        (reservation?.state === "pending" ? reservation.reserved : 0);
      if (
        (!response && current.calls >= 16) ||
        current.input_bytes + inputBytes > 1048576 ||
        current.native_input_bytes + nativeInputBytes > 16777216 ||
        nextOutput > 65536 ||
        (response && requestId && reservation?.state !== "pending")
      )
        throw Error("conversation_budget_exhausted");
      if (!response && requestId)
        this.ctx.storage.sql.exec(
          "INSERT INTO repo_memory_model_requests VALUES(?,?,?,'pending')",
          requestId,
          turnId,
          reserve,
        );
      if (response && requestId)
        this.ctx.storage.sql.exec(
          "UPDATE repo_memory_model_requests SET state='complete' WHERE id=?",
          requestId,
        );
      this.ctx.storage.sql.exec(
        "UPDATE repo_memory_turn_context SET calls=calls+?,input_bytes=input_bytes+?,output_bytes=?,native_input_bytes=native_input_bytes+? WHERE turn_id=?",
        response ? 0 : 1,
        inputBytes,
        nextOutput,
        nativeInputBytes,
        turnId,
      );
    });
  }

  assertWorkerMemory(context: WorkerKnowledgeContext, brief: RepositoryMemoryBrief) {
    const core = this.projectCoordinator(context.projectId),
      input = core?.state.requests?.[context.runId];
    if (
      !core?.runAuthorized(context.runId) ||
      !input?.knowledgeContext ||
      !sameKnowledgeContext(input.knowledgeContext, context) ||
      JSON.stringify(input.memoryBrief) !== JSON.stringify(brief) ||
      brief.projectId !== core.state.project.id ||
      brief.repository !== core.state.project.repository ||
      brief.destinationThreadId !== context.threadId ||
      context.configurationRevision !== core.state.project.configurationRevision ||
      context.baseSha !== core.state.project.baseSha
    )
      throw Error("memory_access_revoked");
    const access = memoryAccess(
      core,
      core.state.runActors?.[context.runId] ?? core.state.credentialActors?.[context.runId] ?? "",
      context.threadId,
    );
    const run = core.state.runs.find((candidate) => candidate.id === context.runId);
    if (!run?.changeId || run.changeId !== context.changeId)
      throw Error("memory_context_unavailable");
    const origin = core.memoryConversationOrigin(run.changeId);
    const saved = this.memoryContext(origin.id);
    if (!saved || JSON.stringify(saved.brief) !== JSON.stringify(brief))
      throw Error("memory_context_unavailable");
    this.getRepoMemory().assertSnapshotReferences(
      origin.id,
      access,
      memoryAuthorizer(core),
      coalesceMemoryReferences(brief.items.flatMap((item) => item.sourceRefs)),
    );
  }
  protected readonly visualizationAuthority = new VisualizationAuthorityGate();
  private visualizations?: VisualizationStore;
  private visualizationGrants?: VisualizationTurnGrants;
  private getVisualizations() {
    return (this.visualizations ??= new VisualizationStore(this.ctx.storage.sql, (work) =>
      this.ctx.storage.transactionSync(work),
    ));
  }
  private getVisualizationGrants() {
    return (this.visualizationGrants ??= new VisualizationTurnGrants(this.ctx.storage.sql));
  }
  protected enqueueConversation(id: string) {
    return this.conversationJobs.enqueue(id, { turnId: id });
  }
  async publishConversationVisualization(turnId: string, invocationId: string, content: unknown) {
    // Bound and copy pending payloads before retaining them in the FIFO.
    const bounded = readVisualizationContent(content);
    if (bounded.kind === "document") documentFragment(bounded);
    return this.visualizationAuthority.run(() =>
      this.publishVisualizationExclusive(turnId, invocationId, bounded),
    );
  }
  private async publishVisualizationExclusive(
    turnId: string,
    invocationId: string,
    content: unknown,
  ) {
    const core = this.turnCoordinator(turnId),
      grant = this.getVisualizationGrants().get(turnId);
    if (
      !core ||
      !grant ||
      this.env.AUTH_MODE !== (grant.mode === "password-only" ? "password-only" : "better-auth") ||
      !this.env.AUTH_DB ||
      !this.conversationsEnabled()
    )
      throw new VisualizationError("visualization_authority_revoked", 403);
    const fence = () => {
      this.assertConversationMemory(turnId);
      const turn = core.conversationTurn(turnId),
        membershipActor = turn.membershipActor ?? turn.actor;
      if (
        turn.status !== "running" ||
        !turn.input ||
        turn.input.turnId !== turnId ||
        turn.input.projectId !== grant.repositoryId ||
        turn.input.threadId !== grant.threadId ||
        core.state.project.id !== grant.repositoryId ||
        turn.threadId !== grant.threadId ||
        membershipActor !== grant.actor ||
        turn.actor !== grant.accessActor ||
        grant.expiresAt <= Date.now()
      )
        throw new VisualizationError("visualization_authority_revoked", 403);
      const access = new Collaboration(
        core,
        { actor: grant.actor, email: grant.email },
        this.env.ACCESS_EMAIL?.toLowerCase() ?? "",
      );
      access.requireProject(grant.repositoryId);
      access.requireThread(grant.threadId);
    };
    const fresh = async () => {
      await requireVisualizationSession(this.env.AUTH_DB!, grant);
      await this.freshConversationMemory(turnId);
      fence();
    };
    const record = await publishVisualization(
      this.getVisualizations(),
      {
        actor: grant.actor,
        repositoryId: grant.repositoryId,
        threadId: grant.threadId,
        turnId,
        invocationId,
      },
      content,
      fresh,
      fence,
    );
    await fresh();
    fence();
    return {
      id: record.id,
      repositoryId: record.repositoryId,
      threadId: record.threadId,
      turnId,
      invocationId: record.invocationId,
      revision: record.revision,
    };
  }
  private readonly typingPresence = new ThreadPresence();
  private coordinator?: Coordinator;
  private readonly projectCoordinators = new Map<string, Coordinator>();
  private projectCoordinator(id: string): Coordinator | undefined {
    const root = this.getCoordinator();
    if (id === root.state.project.id) return root;
    const entry = root.state.ownedProjects?.[id];
    if (!entry) return;
    let core = this.projectCoordinators.get(id);
    if (!core) {
      core = new Coordinator(
        structuredClone(entry.state),
        (state) => root.updateOwnedProject(id, state),
        undefined,
        undefined,
        this.getImages(),
        (operation) => this.ctx.storage.transactionSync(operation),
        this.getUploads(),
      );
      this.projectCoordinators.set(id, core);
      core.recover(this.env.EXECUTION_MODE === "cloud");
    }
    this.bindMemoryFences(core);
    return core;
  }
  private coordinators() {
    const root = this.getCoordinator();
    return [
      root,
      ...Object.keys(root.state.ownedProjects ?? {}).map((id) => this.projectCoordinator(id)!),
    ];
  }
  private runCoordinator(id: string) {
    return this.coordinators().find((core) => core.state.runs.some((run) => run.id === id));
  }
  private turnCoordinator(id: string) {
    return this.coordinators().find((core) =>
      core.state.conversationTurns?.some((turn) => turn.id === id),
    );
  }
  private async requestCoordinator(
    path: string,
    projectId?: string | null,
  ): Promise<Coordinator | undefined> {
    const parts = path.split("/").slice(1);
    if (parts[0] !== "api") return;
    if (parts[1] === "projects" && parts[2]) return this.projectCoordinator(parts[2]);
    if (parts[1] === "capabilities" && projectId) return this.projectCoordinator(projectId);
    const root = this.getCoordinator();
    const candidates = this.coordinators();
    if (parts[1] === "threads")
      return candidates.find((core) => core.state.threads.some((t) => t.id === parts[2]));
    if (parts[1] === "changes")
      return candidates.find((core) => core.state.changes?.some((item) => item.id === parts[2]));
    if (parts[1] === "runs")
      return candidates.find((core) => core.state.runs.some((item) => item.id === parts[2]));
    if (parts[1] === "invitations") {
      if (!/^[a-f0-9]{64}$/.test(parts[2] ?? "")) return;
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts[2]))),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return candidates.find((core) =>
        Object.values(core.state.collaboration?.invitations ?? {}).some(
          (invite) => invite.digest === digest,
        ),
      );
    }
    return root;
  }
  private protectedNativeSource(name: string) {
    const root = this.getCoordinator();
    return (
      name === this.env.ARTIFACT_REPOSITORY ||
      root.state.project.repository === `artifact:${name}` ||
      this.artifactSource(root)?.name === name
    );
  }
  private repositoryProjection(core: Coordinator, identity: { actor: string }) {
    const entry = this.getCoordinator().state.ownedProjects?.[core.state.project.id];
    const role = core.state.collaboration?.projectMembers[identity.actor]?.role;
    const status = core.state.repositoryLifecycle ?? "present";
    const protectedSource = !entry || this.protectedNativeSource(entry.sourceName);
    return {
      projectId: core.state.project.id,
      name: core.state.project.name,
      description: core.state.project.description ?? "",
      metadataRevision: core.state.project.metadataRevision ?? 0,
      ...(entry
        ? { logicalName: core.state.project.logicalName ?? logicalRepositoryName(entry.sourceName) }
        : {}),
      ...(entry ? { repositoryName: entry.sourceName, repositoryId: entry.sourceId } : {}),
      role,
      status,
      lifecycle: status === "present" ? "registered" : status,
      deletable:
        status === "present" &&
        role === "owner" &&
        entry?.ownerActor === identity.actor &&
        !protectedSource &&
        accountRepositoryDeletion(this.env, identity.actor),
    };
  }
  private repositoryLifecycle?: RepositoryLifecycle;
  private getRepositoryLifecycle(request: Request) {
    const listing =
      request.method === "GET" && new URL(request.url).pathname === "/api/repositories";
    if (
      (!listing && this.env.REPOSITORY_LIFECYCLE !== "enabled") ||
      !this.env.ARTIFACTS ||
      this.env.ENVIRONMENT !== "production"
    )
      return;
    return this.getLifecycle();
  }
  /** Internal store reuse does not enable the generic lifecycle HTTP surface. */
  private getLifecycle() {
    if (!this.env.ARTIFACTS || this.env.ENVIRONMENT !== "production") return;
    if (!this.repositoryLifecycle) {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS repository_lifecycle(name TEXT PRIMARY KEY,value TEXT NOT NULL)",
      );
      this.repositoryLifecycle = new RepositoryLifecycle(
        this.env.ARTIFACTS,
        {
          get: (name) => {
            const row = [
              ...sql.exec<{ value: string }>(
                "SELECT value FROM repository_lifecycle WHERE name=?",
                name,
              ),
            ][0];
            return row ? (JSON.parse(row.value) as LifecycleRecord) : undefined;
          },
          list: () =>
            [
              ...sql.exec<{ value: string }>("SELECT value FROM repository_lifecycle LIMIT 200"),
            ].map((row) => JSON.parse(row.value) as LifecycleRecord),
          put: (record) => {
            sql.exec(
              "INSERT OR REPLACE INTO repository_lifecycle VALUES(?,?)",
              record.name,
              JSON.stringify(record),
            );
          },
        },
        (name) =>
          name === this.env.ARTIFACT_REPOSITORY ||
          name === "pitcrew" ||
          name === "pitcrew-test" ||
          Object.values(this.getCoordinator().state.ownedProjects ?? {}).some(
            (entry) => entry.sourceName === name,
          ),
        () =>
          Object.values(this.getCoordinator().state.ownedProjects ?? {}).map((entry) => ({
            ownerActor: entry.ownerActor,
            name: entry.sourceName,
            projectId: entry.state.project.id,
            logicalName: entry.state.project.logicalName ?? logicalRepositoryName(entry.sourceName),
            deleted: entry.state.repositoryLifecycle === "deleted",
          })),
      );
    }
    return this.repositoryLifecycle;
  }
  private conversationsEnabled() {
    return (
      this.env.EXECUTION_MODE === "fake" ||
      (this.env.EXECUTION_MODE === "cloud" &&
        this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true" &&
        this.env.CLOUD_CONVERSATION_ENABLED === "true")
    );
  }
  private landingStore?: SqliteLandingStore;
  private getLandingStore() {
    return (this.landingStore ??= new SqliteLandingStore(this.ctx.storage));
  }
  private artifactSource(core: Coordinator): ArtifactSource | undefined {
    const owned = this.getCoordinator().state.ownedProjects?.[core.state.project.id];
    if (owned) return { name: owned.sourceName, repositoryId: owned.sourceId };
    if (this.env.ARTIFACT_REPOSITORY && this.env.ARTIFACT_REPOSITORY_ID)
      return { name: this.env.ARTIFACT_REPOSITORY, repositoryId: this.env.ARTIFACT_REPOSITORY_ID };
  }
  private publisherEnabled() {
    return (
      this.env.ENVIRONMENT === "production" &&
      this.env.EXECUTION_MODE === "cloud" &&
      this.env.TRUSTED_PUBLISHER_ENABLED === "true" &&
      !!this.env.TRUSTED_PUBLISHER &&
      !!this.env.TRUSTED_PUBLISHER_AUTH_KEY &&
      !!this.env.ARTIFACTS &&
      this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true"
    );
  }
  protected landing(core: Coordinator, actor: string): LandingApi | undefined {
    if (
      this.env.LANDING_MODE === "artifacts" &&
      this.env.ARTIFACTS_CAS_CONFORMANCE_VERIFIED === "true" &&
      this.publisherEnabled() &&
      this.artifactSource(core)
    ) {
      const context = artifactLandingApi(
        core,
        this.getLandingStore(),
        this.env.ARTIFACTS!,
        actor,
        () => this.artifactSource(core),
        (authorization) => this.landArtifact(authorization),
      );
      context.reconcile = async (input) => {
        const record = context.store.get(input.authorizationId, input.actor, input.runId);
        const run = core.evidence(input.runId).run,
          current = this.artifactSource(core);
        if (
          !core.actorAuthorized(input.actor, run.threadId) ||
          !core.runAuthorized(run.id) ||
          !current ||
          current.name !== record.authorization.repository ||
          current.repositoryId !== run.artifactAdmission?.sourceRepositoryId
        )
          throw new ExecutionError("LANDING_AUTHORITY_REVOKED");
        if (record.state === "authorized") throw new ExecutionError("LANDING_NOT_STARTED");
        if (record.state === "landed" || record.state === "rejected") return record.result!;
        const operationId = `land:${input.authorizationId}`;
        const stored = this.publisherAuthority(operationId);
        if (stored) {
          const publisher = this.publisher(operationId);
          const observed = await boundedCleanupRpc(publisher.reconcile(operationId));
          if (!observed.cleanupVerified)
            return {
              authorizationId: input.authorizationId,
              status: "uncertain",
              code: "PUBLISHER_CLEANUP_REQUIRED",
            };
          this.getAdmission().release(operationId, true);
        }
        return context.service.reconcile(input);
      };
      return context;
    }
    if (
      this.env.ENVIRONMENT !== "development" ||
      this.env.LANDING_MODE !== "fixture" ||
      this.env.FIXTURE_IDENTITY !== "lilfrogdev"
    )
      return;
    void this
      .sql`CREATE TABLE IF NOT EXISTS fixture_target(id INTEGER PRIMARY KEY,sha TEXT NOT NULL)`;
    void this.sql`INSERT OR IGNORE INTO fixture_target VALUES(1,${core.state.project.baseSha})`;
    return fixtureLandingApi(
      core,
      this.getLandingStore(),
      {
        targetHead: async () =>
          this.sql<{ sha: string }>`SELECT sha FROM fixture_target WHERE id=1`[0].sha,
        land: async (authorization) =>
          this.ctx.storage.transactionSync(() => {
            const [target] = this.sql<{ sha: string }>`SELECT sha FROM fixture_target WHERE id=1`;
            if (target.sha !== authorization.expectedTargetSha)
              return { status: "rejected", code: "STALE_TARGET" };
            void this.sql`UPDATE fixture_target SET sha=${authorization.candidateSha} WHERE id=1`;
            return { status: "landed" };
          }),
      },
      this.env.FIXTURE_IDENTITY,
    );
  }
  private imageStore?: AttachmentStore;
  private uploadStore?: UploadStore;
  private uploadCleanupScheduling?: Promise<void>;
  private ensureUploadCleanup() {
    return (this.uploadCleanupScheduling ??= (async () => {
      const expiry = this.getUploads().nextExpiry();
      if (
        expiry !== undefined &&
        !this.getSchedules().some((task) => task.callback === "cleanupUploads")
      )
        await this.schedule(new Date(Math.max(Date.now() + 1000, expiry)), "cleanupUploads");
    })().finally(() => {
      this.uploadCleanupScheduling = undefined;
    }));
  }
  async cleanupUploads() {
    this.getUploads().cleanup();
    const expiry = this.getUploads().nextExpiry();
    if (expiry !== undefined)
      await this.schedule(new Date(Math.max(Date.now() + 1000, expiry)), "cleanupUploads");
  }
  private getUploads() {
    return (this.uploadStore ??= sqlUploadStore(this.ctx.storage.sql, (operation) =>
      this.ctx.storage.transactionSync(operation),
    ));
  }
  private getImages() {
    if (this.imageStore) return this.imageStore;
    void this
      .sql`CREATE TABLE IF NOT EXISTS repository_attachments(id TEXT PRIMARY KEY,value TEXT NOT NULL)`;
    return (this.imageStore = attachmentStore(
      (id) => {
        const row = this.sql<{
          value: string;
        }>`SELECT value FROM repository_attachments WHERE id=${id}`[0];
        return row ? (JSON.parse(row.value) as ImageAttachment) : undefined;
      },
      (id, value) => {
        void this.sql`INSERT INTO repository_attachments VALUES(${id},${JSON.stringify(value)})`;
      },
    ));
  }
  private readonly conversationJobs: DurableJobs;
  private async dispatchRun(id: string) {
    const core = this.runCoordinator(id);
    if (!core) throw Error("run_not_found");
    if (this.env.EXECUTION_MODE === "fake") this.ctx.waitUntil(core.dispatch(id, fakeExecution));
    if (this.env.EXECUTION_MODE === "cloud") await this.jobs.enqueue(id, { runId: id });
  }
  async delegateRepoTurn(turnId: string) {
    const core = this.turnCoordinator(turnId);
    if (!core) throw Error("turn_not_found");
    await this.freshConversationMemory(turnId);
    const run = core.delegateConversation(turnId);
    await this.dispatchRun(run.id);
    return run;
  }
  async readConversationAttachment(turnId: string, reference: StoredImageAttachment) {
    const core = this.turnCoordinator(turnId);
    if (!core) throw Error("turn_not_found");
    await this.freshConversationMemory(turnId);
    const turn = core.conversationTurn(turnId);
    if (
      !core.actorAuthorized(turn.membershipActor ?? turn.actor, turn.threadId) ||
      !turn.input ||
      !turn.input.messages.some((message) =>
        message.attachments?.some(
          (ref) => "attachmentId" in ref && JSON.stringify(ref) === JSON.stringify(reference),
        ),
      )
    )
      throw Error("attachment_not_admitted");
    return this.getImages().get(reference);
  }
  async readWorkerAttachment(context: WorkerKnowledgeContext, reference: StoredImageAttachment) {
    const core = this.projectCoordinator(context.projectId);
    const input = core?.state.requests?.[context.runId];
    if (
      !core?.runAuthorized(context.runId) ||
      !input?.knowledgeContext ||
      !sameKnowledgeContext(input.knowledgeContext, context) ||
      ![...input.messages, ...(input.conversationContext ?? [])].some((message) =>
        message.attachments?.some(
          (ref) => "attachmentId" in ref && JSON.stringify(ref) === JSON.stringify(reference),
        ),
      )
    )
      throw Error("attachment_not_admitted");
    if (input.memoryBrief) this.assertWorkerMemory(context, input.memoryBrief);
    return this.getImages().get(reference);
  }
  private readonly jobs: DurableJobs;
  private readonly budgetJobs: DurableJobs;
  private admission?: InfrastructureAdmission;
  assertRunAdmission(
    runId: string,
    frozen: import("@pitcrew/protocol").ArtifactRunAdmission,
  ): void {
    const core = this.runCoordinator(runId),
      run = core?.evidence(runId).run;
    if (
      !core ||
      !run ||
      !core.runAuthorized(runId) ||
      !["running", "awaiting_review"].includes(run.status) ||
      JSON.stringify(run.artifactAdmission) !== JSON.stringify(frozen) ||
      run.configurationRevision !== core.state.project.configurationRevision
    )
      throw new ExecutionError("PUBLISHER_ADMISSION_REVOKED");
    const input = core.state.requests?.[runId];
    if (input?.memoryBrief && input.knowledgeContext)
      this.assertWorkerMemory(input.knowledgeContext, input.memoryBrief);
    this.getAdmission().assertActive(runId, frozen.fingerprint, frozen.deadline);
  }
  cleanupCandidatePublisher(runId: string) {
    return this.cleanupPublishers(runId);
  }
  private publisher(operationId: string) {
    if (!this.env.TRUSTED_PUBLISHER) throw new ExecutionError("TRUSTED_PUBLISHER_REQUIRED");
    return this.env.TRUSTED_PUBLISHER.get(
      this.env.TRUSTED_PUBLISHER.idFromName(`publisher:${operationId}`),
    );
  }
  private publisherAuthorities() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS repository_publisher_authority(operation_id TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    return this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM repository_publisher_authority")
      .toArray()
      .map((row) => JSON.parse(row.value) as { input: PublisherIdentity; actor: string });
  }
  private publisherAuthority(operationId: string) {
    return this.publisherAuthorities().find((item) => item.input.operationId === operationId);
  }
  private publisherTuple(input: PublisherIdentity | PublisherInput | PublisherLandingInput) {
    return JSON.stringify(
      Object.entries(input)
        .filter(([key]) => !["bundleBase64", "authorization"].includes(key))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  private savePublisherAuthority(input: PublisherIdentity, actor: string) {
    this.ctx.storage.transactionSync(() => {
      const prior = this.publisherAuthority(input.operationId);
      if (
        prior &&
        (prior.actor !== actor || this.publisherTuple(prior.input) !== this.publisherTuple(input))
      )
        throw new ExecutionError("PUBLISHER_REPLAY_CONFLICT");
      if (!prior)
        this.ctx.storage.sql.exec(
          "INSERT INTO repository_publisher_authority VALUES(?,?)",
          input.operationId,
          JSON.stringify({ input, actor }),
        );
    });
  }
  // Native internal RPC only. Requests cannot select a physical repository DO, source,
  // actor, credential, remote or destination. Every async publisher stage calls this.
  assertPublisherAdmission(input: PublisherIdentity): void {
    if (!this.publisherEnabled() || input.repositoryAgentName !== "pitcrew")
      throw new ExecutionError("PUBLISHER_ADMISSION_REVOKED");
    const stored = this.publisherAuthority(input.operationId),
      core = this.runCoordinator(input.runId);
    if (!stored || !core || this.publisherTuple(stored.input) !== this.publisherTuple(input))
      throw new ExecutionError("PUBLISHER_IDENTITY_MISMATCH");
    const run = core.evidence(input.runId).run,
      source = this.artifactSource(core),
      frozen = run.artifactAdmission;
    if (
      !frozen ||
      !source ||
      source.name !== input.sourceId ||
      source.repositoryId !== input.sourceRepositoryId ||
      frozen.sourceName !== input.sourceId ||
      frozen.sourceRepositoryId !== input.sourceRepositoryId ||
      input.baseSha !== run.baseSha ||
      input.configurationRevision !== run.configurationRevision ||
      core.state.project.configurationRevision !== run.configurationRevision ||
      !core.runAuthorized(run.id) ||
      !core.actorAuthorized(stored.actor, run.threadId) ||
      Date.now() >= input.deadline
    )
      throw new ExecutionError("PUBLISHER_ADMISSION_REVOKED");
    if (input.kind === "publish") {
      this.getAdmission().assertActive(run.id, frozen.fingerprint, frozen.deadline);
      if (
        input.admissionFingerprint !== frozen.fingerprint ||
        input.deadline > frozen.deadline ||
        run.status !== "running" ||
        input.artifactId !== `pc-${core.state.project.id.length}-${core.state.project.id}-${run.id}`
      )
        throw new ExecutionError("PUBLISHER_ADMISSION_REVOKED");
    } else {
      if (
        this.env.LANDING_MODE !== "artifacts" ||
        this.env.ARTIFACTS_CAS_CONFORMANCE_VERIFIED !== "true"
      )
        throw new ExecutionError("LANDING_UNCONFIGURED");
      const reservation = this.getAdmission().get(input.operationId);
      if (
        !reservation ||
        reservation.kind !== "landing" ||
        reservation.owningRunId !== run.id ||
        reservation.authorizationId !== input.authorizationId ||
        reservation.actor !== stored.actor
      )
        throw new ExecutionError("PUBLISHER_ADMISSION_REVOKED");
      this.getAdmission().assertActive(
        input.operationId,
        input.admissionFingerprint,
        reservation.deadline,
      );
      const record = this.getLandingStore().get(input.authorizationId, stored.actor, run.id),
        a = record.authorization;
      const evidence = core.evidence(run.id),
        review = evidence.reviews.at(-1);
      const plan = core.state.plans?.[run.id];
      if (plan && JSON.stringify(plan.profile) !== JSON.stringify(core.profile()))
        throw new ExecutionError("LANDING_EVIDENCE_REJECTED");
      if (
        !["pending", "uncertain"].includes(record.state) ||
        a.expiresAt <= Date.now() ||
        input.deadline > a.expiresAt ||
        input.targetRef !== "refs/heads/main" ||
        a.repository !== source.name ||
        a.projectId !== core.state.project.id ||
        a.artifactId !== input.artifactId ||
        a.expectedTargetSha !== input.expectedTargetSha ||
        a.candidateSha !== input.candidateSha ||
        !evidence.tests ||
        !review ||
        !["awaiting_review", "completed"].includes(run.status)
      )
        throw new ExecutionError("LANDING_EVIDENCE_REJECTED");
      assertLandingEvidence(
        {
          runId: run.id,
          projectId: core.state.project.id,
          repository: source.name,
          artifactId: run.artifactId!,
          targetRef: "refs/heads/main",
          baseSha: run.baseSha,
          candidateSha: run.candidateSha!,
          configurationRevision: run.configurationRevision,
          currentConfigurationRevision: core.state.project.configurationRevision,
          tests: [evidence.tests],
          review,
        },
        a,
      );
    }
  }
  async authorizePublisherCandidate(
    runId: string,
    candidateSha: string,
    bundleDigest: string,
  ): Promise<Omit<PublisherInput, "bundleBase64">> {
    assertSha(candidateSha);
    if (!/^[a-f0-9]{64}$/.test(bundleDigest)) throw new ExecutionError("INVALID_BUNDLE");
    const core = this.runCoordinator(runId),
      operationId = `publish:${runId}`;
    if (!core || !this.publisherEnabled()) throw new ExecutionError("TRUSTED_PUBLISHER_REQUIRED");
    const run = core.evidence(runId).run,
      pinned = run.artifactAdmission,
      source = this.artifactSource(core);
    const actor = core.state.runActors?.[runId] ?? core.state.credentialActors?.[runId];
    const fence = () => {
      if (
        !actor ||
        !pinned ||
        !source ||
        run.status !== "running" ||
        !core.runAuthorized(runId) ||
        pinned.sourceName !== source.name ||
        pinned.sourceRepositoryId !== source.repositoryId ||
        core.state.project.configurationRevision !== run.configurationRevision
      )
        throw new ExecutionError("PUBLISHER_ADMISSION_REVOKED");
      this.getAdmission().assertActive(runId, pinned.fingerprint, pinned.deadline);
    };
    fence();
    const prior = this.publisherAuthority(operationId);
    if (prior) {
      if (
        prior.input.kind !== "publish" ||
        prior.input.candidateSha !== candidateSha ||
        prior.input.bundleDigest !== bundleDigest
      )
        throw new ExecutionError("PUBLISHER_REPLAY_CONFLICT");
      this.assertPublisherAdmission(prior.input);
      const { kind: _kind, ...original } = prior.input;
      return original;
    }
    const artifactId = `pc-${core.state.project.id.length}-${core.state.project.id}-${runId}`;
    using target = await this.env.ARTIFACTS!.get(source!.name);
    fence();
    using fork = await this.env.ARTIFACTS!.get(artifactId);
    fence();
    const sourceInfo = await target.info();
    fence();
    const artifactInfo = await fork.info();
    fence();
    assertCandidateArtifact(source!, sourceInfo, artifactId, artifactInfo);
    const identity = {
      kind: "publish" as const,
      operationId,
      runId,
      repositoryAgentName: "pitcrew",
      admissionFingerprint: pinned!.fingerprint,
      artifactId,
      artifactRepositoryId: artifactInfo.id,
      artifactRemote: artifactInfo.remote,
      sourceId: source!.name,
      sourceRepositoryId: source!.repositoryId,
      sourceRemote: sourceInfo.remote,
      baseSha: run.baseSha,
      candidateSha,
      configurationRevision: run.configurationRevision,
      deadline: Math.min(pinned!.deadline, Date.now() + MAX_PUBLISHER_LIFETIME_MS),
      bundleDigest,
    };
    const authorization = await signPublisherAuthorization(
      identity,
      this.env.TRUSTED_PUBLISHER_AUTH_KEY!,
    );
    fence();
    const input = { ...identity, authorization };
    this.savePublisherAuthority(input, actor!);
    this.assertPublisherAdmission(input);
    const { kind: _kind, ...signed } = input;
    return signed;
  }
  private async cleanupPublishers(runId: string) {
    const records = this.publisherAuthorities().filter(
      (item) => item.input.runId === runId && item.input.kind === "publish",
    );
    for (const record of records) {
      const cleaned = await boundedCleanupRpc(
        this.publisher(record.input.operationId).cleanup(record.input.operationId),
      );
      if (!cleaned) return false;
    }
    return true;
  }
  private async landArtifact(
    a: LandingAuthorization,
  ): Promise<{ status: "landed" | "rejected" | "uncertain"; code?: string }> {
    const core = this.runCoordinator(a.runId),
      published = this.publisherAuthority(`publish:${a.runId}`);
    if (!core || !published || published.input.kind !== "publish")
      throw new ExecutionError("PUBLISHED_BUNDLE_UNAVAILABLE");
    const run = core.evidence(a.runId).run,
      source = this.artifactSource(core);
    const operationId = `land:${a.authorizationId}`;
    const fence = () => {
      if (
        !this.publisherEnabled() ||
        this.env.LANDING_MODE !== "artifacts" ||
        this.env.ARTIFACTS_CAS_CONFORMANCE_VERIFIED !== "true" ||
        !source ||
        !core.runAuthorized(run.id) ||
        !core.actorAuthorized(a.actor, run.threadId) ||
        !["awaiting_review", "completed"].includes(run.status) ||
        a.expiresAt <= Date.now() ||
        source.name !== a.repository ||
        source.repositoryId !== published.input.sourceRepositoryId ||
        a.artifactId !== run.artifactId ||
        a.candidateSha !== run.candidateSha ||
        a.expectedTargetSha !== run.baseSha ||
        a.configurationRevision !== core.state.project.configurationRevision
      )
        throw new ExecutionError("LANDING_AUTHORITY_REVOKED");
    };
    fence();
    // The bundle is read from the independently verified publication journal, never from a task or HTTP body.
    const bundle = await this.publisher(published.input.operationId).publishedBundle(
      published.input.operationId,
      {
        runId: run.id,
        artifactId: run.artifactId!,
        baseSha: run.baseSha,
        candidateSha: run.candidateSha!,
        bundleDigest: published.input.bundleDigest,
        configurationRevision: run.configurationRevision,
      },
    );
    fence();
    using target = await this.env.ARTIFACTS!.get(source!.name);
    fence();
    using fork = await this.env.ARTIFACTS!.get(run.artifactId!);
    fence();
    const sourceInfo = await target.info();
    fence();
    const artifactInfo = await fork.info();
    fence();
    assertCandidateArtifact(source!, sourceInfo, run.artifactId!, artifactInfo);
    if (
      sourceInfo.remote !== published.input.sourceRemote ||
      artifactInfo.id !== published.input.artifactRepositoryId ||
      artifactInfo.remote !== published.input.artifactRemote
    )
      throw new ExecutionError("DESTINATION_IDENTITY_MISMATCH");
    const fingerprint = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([
              a.authorizationId,
              a.runId,
              a.actor,
              a.repository,
              a.artifactId,
              a.expectedTargetSha,
              a.candidateSha,
              a.configurationRevision,
              published.input.bundleDigest,
            ]),
          ),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    fence();
    const admitted = this.getAdmission().reserveLanding(operationId, fingerprint, true, {
      owningRunId: run.id,
      authorizationId: a.authorizationId,
      actor: a.actor,
    });
    if (!admitted.allowed) throw new ExecutionError("LANDING_ADMISSION_REJECTED");
    const identity = {
      ...published.input,
      kind: "land" as const,
      operationId,
      authorizationId: a.authorizationId,
      targetRef: "refs/heads/main",
      expectedTargetSha: a.expectedTargetSha,
      admissionFingerprint: fingerprint,
      deadline: Math.min(
        a.expiresAt,
        admitted.reservation.deadline,
        Date.now() + MAX_PUBLISHER_LIFETIME_MS,
      ),
    };
    const authorization = await signPublisherAuthorization(
      identity,
      this.env.TRUSTED_PUBLISHER_AUTH_KEY!,
    );
    fence();
    const signed = { ...identity, authorization };
    this.savePublisherAuthority(signed, a.actor);
    await this.budgetJobs.enqueue("watchdog", {});
    this.assertPublisherAdmission(signed);
    let result: PublisherResult;
    try {
      result = await this.publisher(operationId).land({
        ...signed,
        bundleBase64: bundle.bundleBase64,
      });
    } catch {
      return { status: "uncertain", code: "RECONCILIATION_REQUIRED" };
    }
    if (result.cleanupVerified) this.getAdmission().release(operationId, true);
    if (!result.cleanupVerified) return { status: "uncertain", code: "PUBLISHER_CLEANUP_REQUIRED" };
    return {
      status:
        result.status === "landed"
          ? "landed"
          : result.status === "rejected"
            ? "rejected"
            : "uncertain",
      code: result.code,
    };
  }
  private getAdmission() {
    if (this.admission) return this.admission;
    return (this.admission = sqliteAdmission(this.ctx.storage));
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.budgetJobs = new DurableJobs(
      "infrastructure-cleanup",
      async (jobs) => {
        if (this.getAdmission().monitored().length) await jobs.enqueue("watchdog", {});
      },
      async () => {
        const gate = this.getAdmission();
        for (const reservation of gate.monitored()) {
          const core = this.runCoordinator(reservation.owningRunId ?? reservation.runId);
          if (
            !gate.stopRequired(
              reservation.runId,
              this.env.EXECUTION_MODE === "cloud" &&
                this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true" &&
                !!core?.runAuthorized(reservation.owningRunId ?? reservation.runId),
            )
          )
            continue;
          if (!gate.beginCleanupAttempt(reservation.runId)) continue;
          if (reservation.kind === "landing") {
            try {
              const authority = this.publisherAuthority(reservation.runId);
              if (
                authority &&
                (await boundedCleanupRpc(
                  this.publisher(reservation.runId).cleanup(reservation.runId),
                ))
              )
                gate.release(reservation.runId, true);
            } catch {
              /* Unknown cleanup continues to hold this durable reservation. */
            }
            continue;
          }
          const run = core?.state.runs.find((item) => item.id === reservation.runId);
          if (!core || !run) continue; // Uncertain ownership retains its slot for reconciliation.
          const worker = this.env.CHANGE.get(
            this.env.CHANGE.idFromName(`change:${core.state.project.id}:${run.id}`),
          );
          try {
            await boundedCleanupRpc(worker.stop(run.id));
            const receipt = await boundedCleanupRpc(worker.result(run.id));
            if (receipt.cleanupVerified && (await this.cleanupPublishers(run.id)))
              gate.release(run.id, true);
          } catch {
            /* Durable slot and cleanup job remain; never release on transport failure. */
          }
        }
        return gate.monitored().length ? { rescheduleAt: Date.now() + 5000 } : undefined;
      },
    );
    this.lifecycle.use(this.budgetJobs);
    this.jobs = new DurableJobs(
      "repository-results",
      async (jobs) => {
        if (this.env.EXECUTION_MODE !== "cloud") return;
        for (const core of this.coordinators())
          for (const run of core.state.runs)
            if (["queued", "running", "awaiting_review"].includes(run.status))
              await jobs.enqueue(run.id, { runId: run.id });
      },
      async (payload) => {
        const runId = (payload as { runId: string }).runId;
        const core = this.runCoordinator(runId);
        if (!core) return;
        const run = core.evidence(runId).run;
        if (!core.runAuthorized(runId) && !this.getAdmission().hasReservation(runId)) {
          core.fail(runId, true);
          return;
        }
        const input =
          core.begin(runId) ??
          (run.status === "awaiting_review" ? core.state.requests?.[runId] : undefined);
        if (!input) return;
        try {
          validateFrozenModels(this.env, input.runModels);
        } catch {
          core.blockModelConfiguration(runId);
          return;
        }
        const source = this.artifactSource(core);
        const repository = source?.name ?? this.env.ARTIFACT_REPOSITORY;
        if (
          (!source && this.env.ENVIRONMENT === "production") ||
          !repository ||
          !this.env.MODEL_CONFIGURATION ||
          /^0{40}$/.test(input.baseSha)
        ) {
          core.fail(runId, true);
          return;
        }
        try {
          if (source && !this.getAdmission().hasReservation(runId)) {
            if (!this.env.ARTIFACTS) throw Error("repository_backend_unavailable");
            using repo = await this.env.ARTIFACTS.get(source.name);
            if ((await repo.info()).id !== source.repositoryId) {
              core.fail(runId, true);
              return;
            }
          }
          const { artifactAdmission: _priorAdmission, ...unadmitted } = input;
          const request = { ...unadmitted, repository };
          const fingerprint = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(
                  JSON.stringify({ request, sourceRepositoryId: source?.repositoryId }),
                ),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          const gate = this.getAdmission();
          // Revocation fences first admission only. Existing receipts and cleanup must still reconcile.
          if (!gate.hasReservation(runId) && requiresUserOpenRouter(this.env)) {
            try {
              if (
                !(await userCredential(this.env, input.credentialActor).configured(
                  input.credentialActor!,
                ))
              )
                throw Error();
            } catch {
              core.blockModelConfiguration(runId);
              return;
            }
          }
          if (gate.active().some((item) => item.runId === runId && item.state === "quarantined")) {
            core.fail(runId, true);
            return;
          }
          let admitted: ReturnType<InfrastructureAdmission["reserve"]>;
          const firstReservation = !gate.hasReservation(runId);
          try {
            admitted = gate.reserve(
              runId,
              fingerprint,
              this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true" && core.runAuthorized(runId),
            );
          } catch (error) {
            if (
              error instanceof Error &&
              ["admission_identity_conflict", "invalid_admission_identity"].includes(error.message)
            ) {
              core.fail(runId, true);
              return;
            }
            throw error;
          }
          if (!admitted.allowed && admitted.reason === "busy")
            return { rescheduleAt: Date.now() + 5000 };
          if (
            !admitted.allowed &&
            !["stop_required", "already_finished"].includes(admitted.reason)
          ) {
            core.fail(runId, true);
            return;
          }
          // Only a new reservation schedules the watchdog. Result polling must
          // not continuously postpone an existing cleanup deadline.
          if (admitted.allowed && firstReservation) await this.budgetJobs.enqueue("watchdog", {});
          // getAgentByName activates lifecycle capabilities, including the harness.
          // Reserve first. Only synchronous control/observation RPCs may be used on denial.
          if (admitted.allowed && source) {
            core.freezeArtifactAdmission(runId, {
              sourceName: source.name,
              sourceRepositoryId: source.repositoryId,
              fingerprint,
              deadline: admitted.reservation.deadline,
            });
            input.artifactAdmission = core.evidence(runId).run.artifactAdmission;
          }
          const admittedRequest = { ...request, artifactAdmission: input.artifactAdmission };
          const worker = admitted.allowed
            ? await getAgentByName(this.env.CHANGE, `change:${input.projectId}:${input.runId}`, {
                props: {
                  runModels: input.runModels,
                  credentialActor: input.credentialActor,
                  role: "implementer",
                  deadline: admitted.reservation.deadline,
                  artifactAdmission: input.artifactAdmission,
                  runId: input.runId,
                },
              })
            : this.env.CHANGE.get(
                this.env.CHANGE.idFromName(`change:${input.projectId}:${input.runId}`),
              );
          if (admitted.allowed && !core.runAuthorized(runId)) {
            gate.stopRequired(runId, false);
            return { rescheduleAt: Date.now() + 1000 };
          }
          // Dedicated cleanup job owns bounded stop retries; the result job only observes.
          const admission = admitted.allowed
            ? await worker.start(admittedRequest)
            : { stage: "existing" };
          if (
            admission.stage === "blocked" &&
            "error" in admission &&
            admission.error === "reconciliation_required"
          ) {
            core.fail(runId, true);
            return;
          }
          const receipt = await worker.result(runId);
          if (receipt.stage === "done" && receipt.result) {
            await core.completeVerified(runId, receipt.result);
            await worker.acknowledge(runId);
            if (receipt.cleanupVerified && (await this.cleanupPublishers(runId)))
              gate.release(runId, true);
            return;
          }
          if (receipt.stage === "blocked") {
            if (!receipt.cleanupVerified) return { rescheduleAt: Date.now() + 5000 };
            if (!(await this.cleanupPublishers(runId))) return { rescheduleAt: Date.now() + 5000 };
            gate.release(runId, true);
            core.fail(runId, receipt.error === "reconciliation_required");
            return;
          }
          return { rescheduleAt: Date.now() + 1000 };
        } catch {
          // A transport/storage error is not acknowledgement or supersession.
          // Unsafe effects are quarantined by the child journal, not replayed here.
          return { rescheduleAt: Date.now() + 1000 };
        }
      },
    );
    this.lifecycle.use(this.jobs);
    this.conversationJobs = new DurableJobs(
      "repository-conversation-results",
      async (jobs) => {
        for (const core of this.coordinators())
          for (const turn of core.state.conversationTurns ?? [])
            if (["queued", "running"].includes(turn.status))
              await jobs.enqueue(turn.id, { turnId: turn.id });
      },
      async (payload) => {
        const id = (payload as { turnId: string }).turnId;
        const core = this.turnCoordinator(id);
        if (!core) return;
        const turn = core.conversationTurn(id);
        if (["completed", "failed"].includes(turn.status)) return;
        if (!core.actorAuthorized(turn.membershipActor ?? turn.actor, turn.threadId)) {
          if (turn.status === "running" && this.env.CONVERSATION) {
            try {
              await boundedCleanupRpc(
                this.env.CONVERSATION.get(
                  this.env.CONVERSATION.idFromName(`repo:${core.state.project.id}:${id}`),
                ).stop(id),
              );
            } catch {
              return { rescheduleAt: Date.now() + 1000 };
            }
          }
          core.completeConversation(id, undefined, "membership_revoked");
          return;
        }
        if (!this.conversationsEnabled()) {
          core.completeConversation(id, undefined, "execution_unavailable");
          return;
        }
        const firstAdmission = turn.status === "queued";
        let input;
        try {
          input = core.beginConversation(id);
          if (input?.memoryEnabled) {
            await this.prepareRepoMemory(core, id);
            input = await this.freshConversationMemory(id);
          }
        } catch {
          core.completeConversation(id, undefined, "conversation_context_limit");
          return;
        }
        if (!input) return { rescheduleAt: Date.now() + 1000 };
        try {
          if (
            firstAdmission &&
            requiresUserOpenRouter(this.env) &&
            !(await userCredential(this.env, input.credentialActor).configured(
              input.credentialActor!,
            ))
          )
            throw Error("provider_credential_unavailable");
          validateFrozenModels(this.env, input.models);
        } catch {
          core.completeConversation(id, undefined, "model_configuration_changed");
          return;
        }
        try {
          if (!this.env.CONVERSATION) {
            core.completeConversation(id, undefined, "conversation_unavailable");
            return;
          }
          // Credential/catalog lookups yield; revocation must fence child startup too.
          if (!core.actorAuthorized(turn.membershipActor ?? turn.actor, turn.threadId))
            return { rescheduleAt: Date.now() };
          const worker = await getAgentByName(
            this.env.CONVERSATION,
            `repo:${input.projectId}:${input.turnId}`,
            { props: input },
          );
          if (!core.actorAuthorized(turn.membershipActor ?? turn.actor, turn.threadId))
            return { rescheduleAt: Date.now() };
          await worker.start(input);
          const receipt = await worker.result(id);
          if (receipt.status === "completed") {
            await this.freshConversationMemory(id);
            core.completeConversation(id, receipt.text);
            if (input.memoryEnabled) {
              const reply = core.state.messages.find(
                (message) => message.id === turn.replyMessageId,
              );
              if (reply)
                for (const source of messageMemorySources(
                  input.projectId,
                  core.state.project.repository,
                  reply,
                ))
                  this.getRepoMemory().append(source);
            }
            return;
          }
          if (receipt.status === "failed") {
            core.completeConversation(id, undefined, receipt.error);
            return;
          }
        } catch {
          if (turn.input?.memoryEnabled) {
            try {
              this.assertConversationMemory(id);
            } catch {
              core.completeConversation(id, undefined, "memory_access_revoked");
              return;
            }
          }
          // Frozen child operations reconcile through Pi durable storage; transport retries don't resubmit a new turn.
        }
        return { rescheduleAt: Date.now() + 1000 };
      },
    );
    this.lifecycle.use(this.conversationJobs);
  }

  // Internal DO RPC only. The coordinator verifies this against its own frozen
  // request; worker-supplied principals/statuses cannot grant acceptance.
  async refreshWorkerKnowledge(context: WorkerKnowledgeContext) {
    const core = this.projectCoordinator(context.projectId);
    if (!core) throw Error("project_not_found");
    const input = core.state.requests?.[context.runId];
    if (input?.memoryBrief) this.assertWorkerMemory(context, input.memoryBrief);
    return core.refreshWorkerKnowledge(context);
  }
  async appendWorkerKnowledge(context: WorkerKnowledgeContext, report: KnowledgeReport) {
    const core = this.projectCoordinator(context.projectId);
    if (!core) throw Error("project_not_found");
    const input = core.state.requests?.[context.runId];
    if (input?.memoryBrief) this.assertWorkerMemory(context, input.memoryBrief);
    return core.appendWorkerKnowledge(context, report);
  }
  protected getCoordinator() {
    if (this.coordinator) {
      this.bindMemoryFences(this.coordinator);
      return this.coordinator;
    }
    const serialized = readRepositoryState(this.ctx.storage.sql);
    const state = serialized
      ? (JSON.parse(serialized) as State)
      : this.env.EXECUTION_MODE === "cloud"
        ? cloudInitialState(this.env)
        : initialState();
    this.coordinator = new Coordinator(
      state,
      (state) =>
        this.ctx.storage.transactionSync(() => {
          const previous = readRepositoryState(this.ctx.storage.sql);
          if (previous)
            assertConfigurationIdle(
              this.getLandingStore(),
              (JSON.parse(previous) as State).project,
              state.project,
            );
          if (previous) {
            const prior = JSON.parse(previous) as State;
            const configuration = (entry: State) =>
              JSON.stringify([
                entry.project.id,
                entry.project.repository,
                entry.project.baseSha,
                entry.project.configurationRevision,
                entry.profile,
              ]);
            if (this.env.ARTIFACT_REPOSITORY && configuration(prior) !== configuration(state))
              this.getLandingStore().assertRepositoryIdle(this.env.ARTIFACT_REPOSITORY);
            for (const [id, entry] of Object.entries(prior.ownedProjects ?? {})) {
              const next = state.ownedProjects?.[id];
              if (
                next &&
                (configuration(entry.state) !== configuration(next.state) ||
                  entry.sourceName !== next.sourceName ||
                  entry.sourceId !== next.sourceId)
              ) {
                this.getLandingStore().assertRepositoryIdle(entry.sourceName);
                this.getLandingStore().assertRepositoryIdle(next.sourceName);
              }
              if (next)
                assertConfigurationIdle(
                  this.getLandingStore(),
                  entry.state.project,
                  next.state.project,
                );
              else this.getLandingStore().assertRepositoryIdle(entry.sourceName);
            }
          }
          writeRepositoryState(this.ctx.storage.sql, JSON.stringify(state));
        }),
      undefined,
      undefined,
      this.getImages(),
      (operation) => this.ctx.storage.transactionSync(operation),
      this.getUploads(),
    );
    this.bindMemoryFences(this.coordinator);
    this.coordinator.recover(this.env.EXECUTION_MODE === "cloud");
    return this.coordinator;
  }
  async onRequest(request: Request) {
    const passwordMode = isPasswordIngress(request);
    if (passwordMode) {
      const normalized = passwordIngressRequest(request, this.env);
      if (normalized instanceof Response) return normalized;
      request = normalized;
    }
    const accessIdentity = passwordMode ? undefined : await principal(request, this.env);
    if (!passwordMode && !accessIdentity)
      return Response.json({ error: "access_not_configured" }, { status: 403 });
    const auth =
      passwordMode || this.env.AUTH_MODE === "better-auth"
        ? configuredAuth(this.env, request, (task) => this.ctx.waitUntil(task), accessIdentity)
        : undefined;
    if ((passwordMode || this.env.AUTH_MODE === "better-auth") && !auth)
      return Response.json({ error: "auth_unavailable" }, { status: 503 });
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/auth/"))
      return auth
        ? authRequest(auth, request, accessIdentity, (operation) =>
            this.visualizationAuthority.run(operation),
          ).catch(() =>
            Response.json(
              { error: "auth_unavailable" },
              {
                status: 503,
                headers: { "Cache-Control": "private, no-store" },
              },
            ),
          )
        : Response.json({ error: "not_found" }, { status: 404 });
    const originalUser = auth ? await authUser(auth, request, accessIdentity) : undefined;
    if (auth && !originalUser) return Response.json({ error: "unauthorized" }, { status: 401 });
    const invitationPath = /\/invitations(?:\/|$)/.test(path);
    // Capture the ORIGINAL session before streaming the bounded body. Rechecking
    // its immutable session ID prevents a later replacement login from adopting work.
    const invitationGrant =
      auth && originalUser && invitationPath
        ? await visualizationGrant(auth, request, accessIdentity)
        : undefined;
    if (auth && invitationPath && (!invitationGrant || invitationGrant.userId !== originalUser?.id))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const requireInvitationSession = async () => {
      if (!invitationGrant || !this.env.AUTH_DB) throw new AdmissionError("unauthorized", 401);
      try {
        await requireVisualizationSession(this.env.AUTH_DB, invitationGrant);
      } catch {
        throw new AdmissionError("unauthorized", 401);
      }
    };
    const ownerEmail =
      this.env.ACCESS_EMAIL?.toLowerCase() ??
      (this.env.ENVIRONMENT === "development" && this.env.FIXTURE_IDENTITY === "lilfrogdev"
        ? "dev@lilfrogdev.com"
        : "");
    const root = this.getCoordinator();
    const admitIdentity = (user: typeof originalUser, legacyCoordinator?: Coordinator) => {
      const identity = user
        ? {
            actor: `account:${user.id}`,
            email: user.email.toLowerCase(),
            displayName: user.name,
            username: user.username,
            avatar: user.image,
          }
        : accessIdentity!;
      if (user && !passwordMode)
        root.bindVerifiedAccount(accessIdentity!.actor, user.id, identity.email);
      const rootAccess = new Collaboration(root, identity, ownerEmail);
      if (!passwordMode) {
        if (user) rootAccess.rebindLegacy(accessIdentity!.actor);
        rootAccess.bootstrap();
      }
      if (user && !passwordMode && legacyCoordinator && legacyCoordinator !== root)
        new Collaboration(legacyCoordinator, identity, ownerEmail).rebindLegacy(
          accessIdentity!.actor,
        );
      if (user) {
        rootAccess.refreshProfile();
        for (const id of Object.keys(root.state.ownedProjects ?? {})) {
          const core = this.projectCoordinator(id);
          if (core) new Collaboration(core, identity, ownerEmail).refreshProfile();
        }
      }
      return { user, identity, rootAccess };
    };
    let admitted: ReturnType<typeof admitIdentity> | undefined;
    if (auth && originalUser) {
      try {
        admitted = await this.visualizationAuthority.run(async () => {
          // The first session read can overlap profile updates and revocation.
          // Read the same request's original cookie again under their authority
          // queue before persisting labels or admitting its identity snapshot.
          const current = await authUser(auth, request, accessIdentity);
          if (!current || current.id !== originalUser.id) return;
          const legacyCoordinator = passwordMode
            ? undefined
            : await this.requestCoordinator(
                path,
                new URL(request.url).searchParams.get("projectId"),
              );
          return admitIdentity(current, legacyCoordinator);
        });
      } catch {
        return Response.json({ error: "auth_unavailable" }, { status: 503 });
      }
      if (!admitted) return Response.json({ error: "unauthorized" }, { status: 401 });
    } else {
      admitted = admitIdentity(undefined);
    }
    const { user, identity, rootAccess } = admitted;
    const credentialActor = passwordMode ? identity.actor : accessIdentity!.actor;
    if (request.method === "GET" && ["/api/projects", "/api/repositories"].includes(path)) {
      const listing = () => {
        const fixture =
          this.env.ENVIRONMENT === "development" &&
          !passwordMode &&
          this.env.AUTH_MODE !== "better-auth" &&
          this.env.FIXTURE_IDENTITY === "lilfrogdev";
        const projects = [
          ...(fixture ? [root] : []),
          ...Object.keys(root.state.ownedProjects ?? {}).map((id) => this.projectCoordinator(id)!),
        ].filter((core) => {
          const role = core.state.collaboration?.projectMembers[identity.actor]?.role;
          return (
            !!new Collaboration(core, identity, ownerEmail).projectRole() ||
            (path === "/api/repositories" &&
              core.state.repositoryLifecycle === "deleting" &&
              role === "owner" &&
              root.state.ownedProjects?.[core.state.project.id]?.ownerActor === identity.actor)
          );
        });
        return Response.json(
          path === "/api/projects"
            ? projects.map((core) => core.state.project)
            : {
                repositories: projects.map((core) => this.repositoryProjection(core, identity)),
                cursor: null,
              },
        );
      };
      if (!auth || !user) return listing();
      return this.visualizationAuthority.run(async () => {
        const current = await authUser(auth!, request, accessIdentity);
        if (!current || current.id !== user.id)
          return Response.json({ error: "unauthorized" }, { status: 401 });
        return listing();
      });
    }
    if (request.method === "GET" && path === "/api/account")
      return Response.json({
        actor: identity.actor,
        email: identity.email,
        displayName: "displayName" in identity ? identity.displayName : undefined,
        username: "username" in identity ? identity.username : undefined,
        avatar: "avatar" in identity ? identity.avatar : undefined,
      });
    const management = path.match(
      /^\/api\/projects\/([A-Za-z0-9:_-]{1,128})\/repository(\/delete)?$/,
    );
    if (passwordMode && management) {
      if (
        !accountRepositoryManagement(this.env, identity.actor) ||
        (management[2] && !accountRepositoryDeletion(this.env, identity.actor))
      )
        return Response.json({ error: "not_found" }, { status: 404 });
      const projectId = management[1];
      const core = this.projectCoordinator(projectId);
      const lifecycle = this.getLifecycle();
      const owned = () => root.state.ownedProjects?.[projectId];
      const owner = () => {
        const entry = owned();
        if (
          !core ||
          !entry ||
          entry.ownerActor !== identity.actor ||
          entry.state.collaboration?.projectMembers[identity.actor]?.role !== "owner"
        )
          throw new RepositoryCreationError("not_found", 404);
        return entry;
      };
      const authorize = async () => {
        const current = await authUser(auth!, request);
        if (!current || current.id !== user?.id || `account:${current.id}` !== identity.actor)
          throw new RepositoryCreationError("unauthorized", 401);
        if (
          !accountRepositoryManagement(this.env, identity.actor) ||
          (management[2] && !accountRepositoryDeletion(this.env, identity.actor))
        )
          throw new RepositoryCreationError("not_found", 404);
        return owner();
      };
      const fresh = () =>
        this.visualizationAuthority.run(async () => {
          await authorize();
        });
      try {
        if (!lifecycle) throw new RepositoryCreationError("repository_backend_unavailable", 503);
        // Check ownership before admitting any caller-selected body or provider read.
        owner();
        if (request.method === "GET" && !management[2]) {
          const entry = await this.visualizationAuthority.run(authorize);
          if (core!.state.repositoryLifecycle === "deleting") {
            const saved = lifecycle.ownedRecord(entry.sourceName, identity.actor);
            if (saved) {
              const observed = await lifecycle.observeDeletion(
                entry.sourceName,
                entry.sourceId,
                identity.actor,
                fresh,
              );
              await this.visualizationAuthority.run(async () => {
                await authorize();
                if (observed.status === "deleted") core!.freezeRepository("deleted");
              });
            }
          }
          return await this.visualizationAuthority.run(async () => {
            await authorize();
            return Response.json(this.repositoryProjection(core!, identity));
          });
        }
        if (request.method === "PATCH" && !management[2]) {
          const body = await readRepositoryBody(request, [
            "displayName",
            "description",
            "expectedRevision",
            "logicalName",
          ]);
          const metadata = repositoryMetadata(body.displayName, body.description);
          let logicalName: string | undefined;
          if (body.logicalName !== undefined) {
            try {
              logicalName = logicalRepositoryName(body.logicalName);
            } catch {
              throw new RepositoryCreationError("invalid_name", 400);
            }
          }
          if (
            body.expectedRevision !== undefined &&
            (typeof body.expectedRevision !== "number" ||
              !Number.isSafeInteger(body.expectedRevision) ||
              body.expectedRevision < 0)
          )
            throw new RepositoryCreationError("invalid_repository_metadata", 400);
          const target = owner();
          const expectedSourceName = target.sourceName,
            expectedSourceId = target.sourceId;
          const update = async (reservation?: () => void) =>
            this.visualizationAuthority.run(async () => {
              const current = await authorize();
              if (
                current.sourceName !== expectedSourceName ||
                current.sourceId !== expectedSourceId
              )
                throw new RepositoryCreationError("repository_identity_changed", 409);
              return this.ctx.storage.transactionSync(() => {
                reservation?.();
                return Response.json(
                  core!.updateRepositoryMetadata(
                    metadata.displayName,
                    metadata.description,
                    body.expectedRevision as number | undefined,
                    logicalName,
                  ),
                );
              });
            });
          if (logicalName !== undefined) {
            const entry = owner();
            return await lifecycle.renameLogical(
              entry.sourceName,
              entry.sourceId,
              identity.actor,
              logicalName,
              update,
            );
          }
          return await update();
        }
        if (request.method === "POST" && management[2]) {
          const body = await readRepositoryBody(request, ["confirmation", "repositoryId"], 2048);
          if (
            Object.keys(body).length !== 2 ||
            typeof body.repositoryId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(body.repositoryId) ||
            typeof body.confirmation !== "string"
          )
            throw new RepositoryCreationError("invalid_repository_request", 400);
          const entry = owner();
          if (this.protectedNativeSource(entry.sourceName))
            throw new RepositoryCreationError("repository_protected", 409);
          if (body.repositoryId !== entry.sourceId)
            throw new RepositoryCreationError("repository_identity_changed", 409);
          if (body.confirmation !== entry.sourceName)
            throw new RepositoryCreationError("confirmation_required", 400);
          const expectedName = entry.sourceName,
            expectedId = entry.sourceId;
          const pinned = async () => {
            const current = await authorize();
            if (this.protectedNativeSource(current.sourceName))
              throw new RepositoryCreationError("repository_protected", 409);
            if (current.sourceName !== expectedName || current.sourceId !== expectedId)
              throw new RepositoryCreationError("repository_identity_changed", 409);
          };
          const fence = () => this.visualizationAuthority.run(pinned);
          const record = await lifecycle.removeOwned(
            expectedName,
            expectedId,
            body.confirmation,
            identity.actor,
            () =>
              this.visualizationAuthority.run(async () => {
                await pinned();
                this.getLandingStore().assertRepositoryIdle(expectedName);
                const runIds = new Set(core!.state.runs.map((run) => run.id));
                if (
                  this.getAdmission()
                    .monitored()
                    .some((reservation) =>
                      runIds.has(reservation.owningRunId ?? reservation.runId),
                    ) ||
                  core!.state.runs.some((run) => ["queued", "running"].includes(run.status)) ||
                  core!.state.conversationTurns?.some((turn) =>
                    ["queued", "running"].includes(turn.status),
                  )
                )
                  throw new RepositoryCreationError("repository_busy", 409);
                core!.freezeRepository("deleting");
              }),
            fence,
          );
          return await this.visualizationAuthority.run(async () => {
            await pinned();
            if (record.status === "deleted") core!.freezeRepository("deleted");
            return Response.json(this.repositoryProjection(core!, identity), {
              status: record.status === "deleted" ? 200 : 202,
            });
          });
        }
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      } catch (error) {
        if (error instanceof AdmissionError)
          return creationError(new RepositoryCreationError(error.message, error.status));
        if (
          error instanceof Error &&
          [
            "repository_identity_changed",
            "repository_protected",
            "repository_exists",
            "lifecycle_limit",
          ].includes(error.message)
        )
          return creationError(new RepositoryCreationError(error.message, 409));
        return creationError(error);
      }
    }
    if (passwordMode && ["/api/repository-creations", "/api/repositories/create"].includes(path)) {
      const broad = () => accountRepositoryManagement(this.env, identity.actor);
      const approved = () => approvedRepositoryCreation(this.env, identity.actor);
      const lifecycle = this.getLifecycle();
      const projectFor = (record: LifecycleRecord) =>
        record.id && record.status === "ready" && record.ownerActor === identity.actor
          ? Object.values(root.state.ownedProjects ?? {}).find(
              (entry) =>
                entry.sourceId === record.id &&
                entry.sourceName === record.name &&
                (!record.projectId || entry.state.project.id === record.projectId) &&
                entry.ownerActor === identity.actor &&
                !entry.state.repositoryLifecycle,
            )?.state.project
          : undefined;
      if (request.method === "GET" && path === "/api/repository-creations") {
        return this.visualizationAuthority.run(async () => {
          const grant = await visualizationGrant(auth!, request);
          if (grant?.actor !== identity.actor)
            return Response.json({ error: "unauthorized" }, { status: 401 });
          const records = lifecycle?.ownedCreations(identity.actor) ?? [];
          const target = approved();
          return Response.json({
            approval:
              target && !records.some((record) => record.name === target.name && projectFor(record))
                ? target
                : null,
            capabilities: {
              create: broad(),
              manage: broad(),
              delete: accountRepositoryDeletion(this.env, identity.actor),
            },
            creations: records.map((record) => creationProjection(record, projectFor(record)?.id)),
          });
        });
      }
      if (request.method !== "POST" || path !== "/api/repositories/create")
        return Response.json({ error: "not_found" }, { status: 404 });
      const target = approved();
      if ((!target && !broad()) || !lifecycle)
        return Response.json({ error: "not_found" }, { status: 404 });
      try {
        const broadRequest = broad();
        const { name, displayName, description } = await readRepositoryCreation(
          request,
          broadRequest,
        );
        if (!broadRequest && name !== target?.name)
          throw new RepositoryCreationError("not_found", 404);
        const grant = await this.visualizationAuthority.run(() =>
          visualizationGrant(auth!, request),
        );
        if (!grant || grant.actor !== identity.actor)
          throw new RepositoryCreationError("unauthorized", 401);
        const fresh = async () => {
          try {
            await requireVisualizationSession(this.env.AUTH_DB!, grant);
          } catch {
            throw new RepositoryCreationError("unauthorized", 401);
          }
          if (broadRequest ? !broad() : approved()?.name !== name)
            throw new RepositoryCreationError("not_found", 404);
        };
        const task = (async () => {
          await this.visualizationAuthority.run(fresh);
          const previous = broadRequest
            ? lifecycle.logicalCreation(identity.actor, name)
            : lifecycle.ownedCreations(identity.actor).find((record) => record.name === name);
          const admit = (commit: () => void) =>
            this.visualizationAuthority.run(async () => {
              await fresh();
              const currentIntent = broadRequest
                ? lifecycle.logicalCreation(identity.actor, name)
                : lifecycle.ownedRecord(name, identity.actor);
              if (Object.keys(root.state.ownedProjects ?? {}).length >= 20 && !currentIntent)
                throw new RepositoryCreationError("capacity", 429);
              this.ctx.storage.transactionSync(commit);
            });
          let record =
            previous?.status === "cleanup_required"
              ? await lifecycle.reconcile(previous.name, identity.actor)
              : broadRequest
                ? await lifecycle.provisionLogical(
                    name,
                    identity.actor,
                    { displayName, description },
                    admit,
                  )
                : await lifecycle.provision(name, "create", undefined, identity.actor, () =>
                    admit(() => {}),
                  );
          if (record.status !== "ready") return creationProjection(record);
          if (
            !record.id ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) ||
            record.ownerActor !== identity.actor
          )
            throw new RepositoryCreationError("repository_identity_changed", 409);
          const existing = projectFor(record);
          if (existing) {
            return this.visualizationAuthority.run(async () => {
              await fresh();
              const current = lifecycle.ownedRecord(record.name, identity.actor);
              if (!current || current.id !== record.id || current.status !== "ready")
                throw new RepositoryCreationError("repository_identity_changed", 409);
              return creationProjection(current, existing.id);
            });
          }
          // Token cleanup continues after revocation, but ownership never does.
          try {
            using repo = await this.env.ARTIFACTS!.get(record.name);
            const info = await repo.info();
            if (info.id !== record.id)
              throw new RepositoryCreationError("repository_identity_changed", 409);
            // The binding returns an empty history for an unresolved empty ref.
            const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
            if (head && !/^[a-f0-9]{40}$/.test(head.hash)) throw Error("invalid_head");
            if ((await repo.info()).id !== record.id)
              throw new RepositoryCreationError("repository_identity_changed", 409);
            return await this.visualizationAuthority.run(async () => {
              await fresh();
              const saved = lifecycle
                .ownedCreations(identity.actor)
                .find((item) => item.name === record.name);
              if (!saved || saved.id !== record.id || saved.status !== "ready")
                throw new RepositoryCreationError("repository_identity_changed", 409);
              record = saved;
              const registered = projectFor(record);
              if (registered) return creationProjection(record, registered.id);
              if (
                Object.values(root.state.ownedProjects ?? {}).some(
                  (entry) => entry.sourceId === record.id || entry.sourceName === record.name,
                )
              )
                throw new RepositoryCreationError("repository_identity_changed", 409);
              try {
                // Use the current verified profile, never a typed owner or email.
                const current = await authUser(auth!, request);
                if (!current || `account:${current.id}` !== grant.actor)
                  throw new RepositoryCreationError("unauthorized", 401);
                await fresh();
                lifecycle.assertLogicalNameAvailable(
                  grant.actor,
                  record.logicalName ?? logicalRepositoryName(record.name),
                  record.name,
                );
                const project = root.addOwnedProject(
                  record.name,
                  record.id!,
                  grant.actor,
                  grant.email,
                  head
                    ? {
                        baseSha: head.hash,
                        configurationRevision: this.env.CONFIGURATION_REVISION ?? "unconfigured-v1",
                      }
                    : undefined,
                  {
                    actor: grant.actor,
                    email: grant.email,
                    displayName: current.name,
                    username: current.username,
                    avatar: current.image,
                  },
                  record.displayName !== undefined
                    ? {
                        displayName: record.displayName,
                        description: record.description ?? "",
                        logicalName: record.logicalName,
                      }
                    : undefined,
                  record.projectId,
                );
                return creationProjection(record, project.id);
              } catch (error) {
                if (error instanceof AdmissionError) return creationProjection(record);
                throw error;
              }
            });
          } catch (error) {
            if (error instanceof RepositoryCreationError) throw error;
            // The exact created resource remains recorded. Metadata/registration
            // failure is recoverable, never permission to provision another one.
            return creationProjection(record);
          }
        })();
        this.ctx.waitUntil(task.catch(() => {}));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          task,
          new Promise<ReturnType<typeof creationProjection>>((resolve) => {
            timer = setTimeout(() => {
              const saved = broadRequest
                ? lifecycle.logicalCreation(identity.actor, name)
                : lifecycle.ownedCreations(identity.actor).find((item) => item.name === name);
              resolve(
                saved
                  ? creationProjection(saved, projectFor(saved)?.id)
                  : { name, status: "pending" },
              );
            }, 5000);
          }),
        ]).finally(() => clearTimeout(timer));
        return Response.json(result, { status: result.status === "ready" ? 200 : 202 });
      } catch (error) {
        const safe = [
          "repository_exists",
          "repository_identity_changed",
          "repository_name_retired",
          "deletion_pending",
          "namespace_limit",
          "lifecycle_limit",
          "repository_protected",
          "not_found",
        ];
        if (error instanceof Error && safe.includes(error.message))
          return creationError(
            new RepositoryCreationError(error.message, error.message === "not_found" ? 404 : 409),
          );
        return creationError(error);
      }
    }
    // Native accounts never acquire a legacy/root membership. An operator may
    // approve one exact stable account and immutable existing source instead.
    if (passwordMode && ["/api/project-adoptions", "/api/projects"].includes(path)) {
      const approved = () => {
        const name = this.env.ADOPT_REPOSITORY_NAME,
          repositoryId = this.env.ADOPT_REPOSITORY_ID;
        return this.env.AUTH_MODE === "password-only" &&
          this.env.ADOPT_ACCOUNT_ACTOR === identity.actor &&
          name &&
          repositoryId &&
          this.env.ARTIFACTS
          ? { name, repositoryId }
          : undefined;
      };
      const registered = (target: { name: string; repositoryId: string }) =>
        Object.values(root.state.ownedProjects ?? {}).some(
          (entry) => entry.sourceId === target.repositoryId || entry.sourceName === target.name,
        );
      if (request.method === "GET" && path === "/api/project-adoptions") {
        return this.visualizationAuthority.run(async () => {
          const grant = await visualizationGrant(auth!, request);
          const target = approved();
          return Response.json(
            grant?.actor === identity.actor && target && !registered(target) ? [target] : [],
          );
        });
      }
      if (request.method === "POST" && path === "/api/projects") {
        const target = approved();
        if (!target) return Response.json({ error: "not_found" }, { status: 404 });
        let body: unknown;
        try {
          if (Number(request.headers.get("content-length") ?? 0) > 2048) throw Error();
          const reader = request.body?.getReader();
          if (!reader) throw Error();
          const chunks: Uint8Array[] = [];
          let length = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > 2048) {
              await reader.cancel();
              throw Error();
            }
            chunks.push(next.value);
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 2 ||
          Object.keys(body).some((key) => !["name", "repositoryId"].includes(key))
        )
          return Response.json({ error: "invalid_adoption" }, { status: 400 });
        const input = body as { name?: unknown; repositoryId?: unknown };
        if (input.name !== target.name || input.repositoryId !== target.repositoryId)
          return Response.json({ error: "not_found" }, { status: 404 });
        // Freeze the original session before external metadata awaits; a later
        // sign-in cannot replace a revoked session's adoption authority.
        const grant = await this.visualizationAuthority.run(() =>
          visualizationGrant(auth!, request),
        );
        if (!grant || grant.actor !== identity.actor)
          return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          using repo = await this.env.ARTIFACTS!.get(target.name);
          const info = await repo.info();
          if (info.id !== target.repositoryId)
            return Response.json({ error: "repository_identity_changed" }, { status: 409 });
          const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
          if (head && !/^[a-f0-9]{40}$/.test(head.hash)) throw Error("invalid_head");
          // Do not assume get(name) pins an immutable source across awaits.
          // Revalidate after the head read before committing account ownership.
          if ((await repo.info()).id !== target.repositoryId)
            return Response.json({ error: "repository_identity_changed" }, { status: 409 });
          return await this.visualizationAuthority.run(async () => {
            try {
              await requireVisualizationSession(this.env.AUTH_DB!, grant);
            } catch {
              return Response.json({ error: "unauthorized" }, { status: 401 });
            }
            const current = approved();
            if (
              !current ||
              current.name !== target.name ||
              current.repositoryId !== target.repositoryId
            )
              return Response.json({ error: "not_found" }, { status: 404 });
            if (registered(target))
              return Response.json({ error: "repository_already_registered" }, { status: 409 });
            if (this.getLifecycle()?.ownedRecord(target.name, identity.actor)?.projectId)
              throw new AdmissionError("repository_already_registered", 409);
            this.getLifecycle()?.assertLogicalNameAvailable(
              identity.actor,
              logicalRepositoryName(target.name),
              target.name,
            );
            const project = root.addOwnedProject(
              target.name,
              target.repositoryId,
              grant.actor,
              grant.email,
              head
                ? {
                    baseSha: head.hash,
                    configurationRevision: this.env.CONFIGURATION_REVISION ?? "unconfigured-v1",
                  }
                : undefined,
              identity,
            );
            return Response.json(project, { status: 201 });
          });
        } catch (error) {
          if (error instanceof Error && error.message === "repository_exists")
            return Response.json({ error: "repository_exists" }, { status: 409 });
          return Response.json(
            {
              error:
                error instanceof AdmissionError ? error.message : "repository_verification_failed",
            },
            { status: error instanceof AdmissionError ? error.status : 503 },
          );
        }
      }
    }
    if (request.method === "POST" && path === "/api/projects") {
      if (
        identity.email !== ownerEmail ||
        !rootAccess.projectRole() ||
        !this.env.ARTIFACTS ||
        !this.env.ADOPT_REPOSITORY_NAME ||
        !this.env.ADOPT_REPOSITORY_ID
      )
        return Response.json({ error: "repository_adoption_unavailable" }, { status: 503 });
      let name: unknown;
      try {
        if (Number(request.headers.get("content-length") ?? 0) > 2048) throw Error();
        const reader = request.body?.getReader();
        if (!reader) throw Error();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 2048) {
            await reader.cancel();
            throw Error();
          }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        name = (
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { name?: unknown }
        ).name;
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      if (name !== this.env.ADOPT_REPOSITORY_NAME)
        return Response.json({ error: "not_found" }, { status: 404 });
      try {
        using repo = await this.env.ARTIFACTS.get(name);
        const info = await repo.info();
        if (info.id !== this.env.ADOPT_REPOSITORY_ID)
          return Response.json({ error: "repository_identity_changed" }, { status: 409 });
        if (rootAccess.projectRole() !== "owner")
          return Response.json({ error: "not_found" }, { status: 404 });
        const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
        if (head && !/^[a-f0-9]{40}$/.test(head.hash)) throw Error("invalid_head");
        if (rootAccess.projectRole() !== "owner")
          return Response.json({ error: "not_found" }, { status: 404 });
        this.getLifecycle()?.assertLogicalNameAvailable(
          identity.actor,
          logicalRepositoryName(name),
          name,
        );
        const project = root.addOwnedProject(
          name,
          info.id,
          identity.actor,
          identity.email,
          head
            ? {
                baseSha: head.hash,
                configurationRevision: this.env.CONFIGURATION_REVISION ?? "unconfigured-v1",
              }
            : undefined,
          identity,
        );
        return Response.json(project, { status: 201 });
      } catch {
        return Response.json({ error: "repository_verification_failed" }, { status: 503 });
      }
    }
    const coordinator = await this.requestCoordinator(
      path,
      new URL(request.url).searchParams.get("projectId"),
    );
    if (!coordinator) return Response.json({ error: "not_found" }, { status: 404 });
    const access = new Collaboration(
      coordinator,
      identity,
      ownerEmail,
      invitationGrant && this.env.AUTH_DB
        ? {
            requireSession: requireInvitationSession,
            resolveRecipient: async (input) => {
              // The caller's current owner role is checked by Collaboration before this
              // bounded account lookup; failed lookups count too, limiting enumeration.
              await requireInvitationSession();
              const now = Date.now();
              const admitted = await this.env
                .AUTH_DB!.prepare(`INSERT INTO auth_admission(key,count,started_at)
            VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
            count=CASE WHEN started_at<=? THEN 1 ELSE count+1 END,
            started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END
            WHERE started_at<=? OR count<20 RETURNING count`)
                .bind(
                  JSON.stringify([identity.actor, "invitation-recipient"]),
                  now,
                  now - 60000,
                  now - 60000,
                  now - 60000,
                )
                .first();
              if (!admitted) throw new AdmissionError("capacity", 429);
              await requireInvitationSession();
              try {
                return await resolveInvitationRecipient(this.env.AUTH_DB!, input, passwordMode);
              } finally {
                await requireInvitationSession();
              }
            },
          }
        : undefined,
    );
    // Password credentials occupy new account namespaces. Existing Access AES
    // records remain in their original namespace and are never rebound here.
    const credentialEnv = passwordMode
      ? {
          ...this.env,
          EXECUTION_MODE: "disabled",
          INFRASTRUCTURE_ADMISSION_ENABLED: "false",
          CLOUD_CONVERSATION_ENABLED: "false",
        }
      : this.env;
    if (/^\/api\/projects\/[^/]+\/threads\/[^/]+\/visualizations(?:\/[^/]+)?$/.test(path)) {
      if (!auth || !user)
        return Response.json(
          { error: "unauthorized" },
          { status: 401, headers: { "Cache-Control": "private, no-store" } },
        );
      return this.visualizationAuthority
        .run(
          async () =>
            (await visualizationRequest(request, this.getVisualizations(), {
              session: (r) => visualizationSession(auth, r, accessIdentity),
              requireThread: (context) => {
                if (context.actor !== identity.actor)
                  throw new VisualizationError("unauthorized", 401);
                access.requireProject(context.repositoryId);
                access.requireThread(context.threadId);
              },
            }))!,
        )
        .catch(() =>
          Response.json(
            { error: "visualization_unavailable" },
            {
              status: 503,
              headers: { "Cache-Control": "private, no-store" },
            },
          ),
        );
    }
    if (new URL(request.url).pathname === "/api/provider-connection/openrouter")
      return providerConnectionRequest(request, credentialEnv, credentialActor);
    if (new URL(request.url).pathname === "/api/provider-connection/openrouter/models")
      return providerModelsRequest(request, credentialEnv, credentialActor);
    if (/^\/api\/repositories(?:\/|$)/.test(path)) {
      if (!user && identity.email !== ownerEmail)
        return Response.json({ error: "not_found" }, { status: 404 });
      return lifecycleRequest(
        request,
        this.getRepositoryLifecycle(request),
        (task) => this.ctx.waitUntil(task),
        identity.actor,
        async (record) => {
          if (!record.id || record.ownerActor !== identity.actor || !this.env.ARTIFACTS)
            throw Error("repository_identity_changed");
          const existing = Object.values(root.state.ownedProjects ?? {}).find(
            (entry) => entry.sourceId === record.id,
          );
          if (existing) {
            if (existing.ownerActor !== identity.actor) throw Error("repository_identity_changed");
            return;
          }
          using repo = await this.env.ARTIFACTS.get(record.name);
          const info = await repo.info();
          if (info.id !== record.id) throw Error("repository_identity_changed");
          const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
          if (head && !/^[a-f0-9]{40}$/.test(head.hash)) throw Error("invalid_head");
          this.getLifecycle()?.assertLogicalNameAvailable(
            identity.actor,
            record.logicalName ?? logicalRepositoryName(record.name),
            record.name,
          );
          root.addOwnedProject(
            record.name,
            info.id,
            identity.actor,
            identity.email,
            head
              ? {
                  baseSha: head.hash,
                  configurationRevision: this.env.CONFIGURATION_REVISION ?? "unconfigured-v1",
                }
              : undefined,
            identity,
          );
        },
      );
    }
    const bodyLimit =
      request.method === "PUT" && /\/uploads\/[^/]+$/.test(path)
        ? UPLOAD_LIMITS.fileBytes
        : /^\/api\/threads\/[^/]+\/messages$/.test(new URL(request.url).pathname)
          ? ATTACHMENT_LIMITS.requestBytes
          : 16384;
    if (Number(request.headers.get("content-length") ?? 0) > bodyLimit)
      return Response.json({ error: "body_too_large" }, { status: 413 });
    let providerReady =
      !passwordMode && (this.env.EXECUTION_MODE === "fake" || !requiresUserOpenRouter(this.env));
    if (!passwordMode && !providerReady && credentialStorageAvailable(this.env)) {
      try {
        providerReady = await userCredential(this.env, credentialActor).configured(credentialActor);
      } catch {
        /* Fail closed. */
      }
    }
    if (
      !passwordMode &&
      this.env.EXECUTION_MODE === "cloud" &&
      !providerReady &&
      request.method === "POST" &&
      (/^\/api\/threads\/[^/]+\/messages$/.test(new URL(request.url).pathname) ||
        /^\/api\/changes\/[^/]+\/runs$/.test(new URL(request.url).pathname) ||
        /^\/api\/projects\/[^/]+\/intake\/dispatch$/.test(new URL(request.url).pathname))
    ) {
      try {
        if (path.startsWith("/api/threads/")) access.requireThread(path.split("/")[3]);
        else if (path.startsWith("/api/changes/"))
          access.requireThread(coordinator.change(path.split("/")[3]).threadId);
        else access.requireProject(coordinator.state.project.id);
      } catch {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ error: "provider_credential_unavailable" }, { status: 409 });
    }
    const app = api(
      coordinator,
      (id) =>
        this.env.EXECUTION_MODE === "fake"
          ? coordinator.dispatch(id, fakeExecution)
          : this.dispatchRun(id),
      passwordMode ? undefined : this.landing(coordinator, credentialActor),
      passwordMode ? identity : accessIdentity!,
      !passwordMode &&
        this.env.CONVERSATION &&
        providerReady &&
        this.conversationsEnabled() &&
        (this.env.EXECUTION_MODE === "fake" || !!this.env.MODEL_CONFIGURATION)
        ? {
            catalog: resolveCatalog(userModelEnv(this.env, credentialActor)),
            dispatch: async (id) => {
              if (auth && user) {
                await this.visualizationAuthority.run(async () => {
                  const grant = await visualizationGrant(auth, request, accessIdentity),
                    turn = coordinator.conversationTurn(id);
                  if (!grant || grant.actor !== identity.actor)
                    throw new VisualizationError("unauthorized", 401);
                  await requireVisualizationSession(this.env.AUTH_DB!, grant);
                  access.requireProject(coordinator.state.project.id);
                  access.requireThread(turn.threadId);
                  if (
                    (turn.membershipActor ?? turn.actor) !== grant.actor ||
                    turn.actor !== grant.accessActor
                  )
                    throw new VisualizationError("visualization_authority_revoked", 403);
                  this.ctx.storage.transactionSync(() =>
                    this.getVisualizationGrants().bind({
                      ...grant,
                      repositoryId: coordinator.state.project.id,
                      threadId: turn.threadId,
                      turnId: id,
                    }),
                  );
                });
              }
              return this.enqueueConversation(id);
            },
          }
        : undefined,
      access,
      passwordMode || this.env.EXECUTION_MODE === "disabled",
      this.env.ARTIFACTS
        ? new SourceReader(
            this.env.ARTIFACTS,
            coordinator,
            access,
            () =>
              coordinator === this.getCoordinator() ||
              this.getCoordinator().state.ownedProjects?.[coordinator.state.project.id]
                ? this.artifactSource(coordinator)
                : undefined,
            (id) => this.publisherAuthority(`publish:${id}`)?.input,
          )
        : undefined,
      this.typingPresence,
      auth && user
        ? (operation) =>
            this.visualizationAuthority
              .run(async () => {
                // The API admits bounded bodies before this queue. Recheck the
                // original session before synchronous ACL/lease/response work so
                // logout cannot be followed by a stale typing read or refresh.
                const current = await visualizationSession(auth, request, accessIdentity);
                if (!current || current.actor !== identity.actor)
                  throw new AdmissionError("unauthorized", 401);
                return operation();
              })
              .catch((error) => {
                if (error instanceof VisualizationError)
                  throw new AdmissionError("presence_unavailable", 503);
                throw error;
              })
        : undefined,
      this.getUploads(),
      (operation) =>
        this.visualizationAuthority
          .run(async () => {
            if (auth && user) {
              // Recheck original session eligibility inside the same queue as logout
              // and membership changes, immediately before byte/state work.
              const current = await visualizationSession(auth, request, accessIdentity);
              if (!current || current.actor !== identity.actor)
                throw new AdmissionError("unauthorized", 401);
            }
            return operation();
          })
          .catch((error) => {
            if (error instanceof VisualizationError)
              throw new AdmissionError("uploads_unavailable", 503);
            throw error;
          }),
      auth && user
        ? (operation) =>
            this.visualizationAuthority
              .run(async () => {
                // Invitation hashing and membership commits stay in the same
                // queue as logout/revocation, after the bounded body is read.
                const current = await authUser(auth, request, accessIdentity);
                if (!current || current.id !== user.id)
                  throw new AdmissionError("unauthorized", 401);
                if (invitationPath) await requireInvitationSession();
                return operation({
                  actor: `account:${current.id}`,
                  email: current.email.toLowerCase(),
                  username: current.username,
                  displayName: current.name,
                  avatar: current.image,
                });
              })
              .catch((error) => {
                if (error instanceof VisualizationError)
                  throw new AdmissionError("collaboration_unavailable", 503);
                throw error;
              })
        : undefined,
    );
    const response = await app.fetch(request);
    if (/\/uploads\//.test(path) && ["PUT", "DELETE"].includes(request.method) && response.ok)
      await this.ensureUploadCleanup();
    return response;
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (isPasswordIngress(request)) {
      const normalized = passwordIngressRequest(request, env);
      if (normalized instanceof Response) return normalized;
      const stub = env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew"));
      // Preserve the scoped URL for DO revalidation; only the DO normalizes it.
      const scoped = new Request(request.url, normalized);
      return privateIngressResponse(await stub.fetch(scoped));
    }
    return protectedFetch(
      request,
      env,
      (request) => {
        const stub = env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew"));
        return stub.fetch(request);
      },
      env.ASSETS,
    );
  },
} satisfies ExportedHandler<Env>;
