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
} from "./repository-lifecycle";
import { readRepositoryState, writeRepositoryState } from "./repository-state";
import { sameKnowledgeContext } from "./knowledge";
import { RepoConversationAgent } from "./repo-conversation-agent";
export { RepoConversationAgent };
import { PlanAgent } from "./plan-agent";
export { PlanAgent };
import { resolveCatalog, validateFrozenModels, requiresUserOpenRouter } from "./model-selection";
import { providerModelsRequest } from "./provider-models";
import { attachmentStore, type AttachmentStore } from "./attachment-store";
import {
  ATTACHMENT_LIMITS,
  type StoredImageAttachment,
  type ImageAttachment,
} from "@pitcrew/protocol";
import type { WorkerKnowledgeContext, KnowledgeReport } from "@pitcrew/protocol";
import { SqliteLandingStore } from "../../../packages/execution/src/landing-store";
import { fixtureLandingApi, assertConfigurationIdle, type LandingApi } from "./landing-api";
import { cloudInitialState } from "./cloud-configuration";
import { principal, protectedFetch, type AccessEnv } from "./access";
import { Agent, getAgentByName } from "agents";
import { ChangeAgent, ReviewAgent, TestAgent, type PiEnv } from "./pi-agents";
export { ChangeAgent, ReviewAgent, TestAgent };
import { DurableJobs } from "./durable-jobs";
import {
  InfrastructureAdmission,
  sqliteAdmission,
  boundedCleanupRpc,
} from "./infrastructure-admission";
import { api } from "./api";
import { Coordinator, fakeExecution, initialState, type State } from "./coordinator";
interface Env extends PiEnv, AccessEnv {
  ASSETS?: Fetcher;
  PROJECT_BASE_SHA?: string;
  LOCAL_FIXTURE_DIR?: string;
  LOCAL_WORKSPACE_ROOT?: string;
  OPENROUTER_API_KEY?: string;
  CHANGE: DurableObjectNamespace<ChangeAgent>;
  CONVERSATION?: DurableObjectNamespace<RepoConversationAgent>;
  PLAN?: DurableObjectNamespace<PlanAgent>;
  ARTIFACT_REPOSITORY?: string;
  REPOSITORY: DurableObjectNamespace<RepositoryAgent>;
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  LANDING_MODE?: string;
  EXECUTION_MODE: string;
  REPOSITORY_LIFECYCLE?: string;
  INFRASTRUCTURE_ADMISSION_ENABLED?: string;
  CLOUD_CONVERSATION_ENABLED?: string;
}
export class RepositoryAgent extends Agent<Env> {
  private coordinator?: Coordinator;
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
          name === this.env.ARTIFACT_REPOSITORY || name === "pitcrew" || name === "pitcrew-test",
      );
    }
    return this.repositoryLifecycle;
  }
  private conversationsEnabled() {
    return (
      this.env.EXECUTION_MODE === "fake" ||
      (this.env.EXECUTION_MODE === "local" && !!this.env.OPENROUTER_API_KEY) ||
      (this.env.EXECUTION_MODE === "cloud" &&
        this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true" &&
        this.env.CLOUD_CONVERSATION_ENABLED === "true")
    );
  }
  private landingStore?: SqliteLandingStore;
  private getLandingStore() {
    return (this.landingStore ??= new SqliteLandingStore(this.ctx.storage));
  }
  private landing(core: Coordinator): LandingApi | undefined {
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
    if (this.env.EXECUTION_MODE === "fake")
      this.ctx.waitUntil(this.getCoordinator().dispatch(id, fakeExecution));
    if (this.env.EXECUTION_MODE === "cloud" || this.env.EXECUTION_MODE === "local")
      await this.jobs.enqueue(id, { runId: id });
  }
  async delegateRepoTurn(turnId: string) {
    const run = await this.getCoordinator().delegateApprovedMission(turnId);
    await this.dispatchRun(run.id);
    return run;
  }
  askMission(turnId: string, prompts: string[]) {
    return this.getCoordinator().askMission(turnId, prompts);
  }
  proposeMission(
    turnId: string,
    input: { summary: string; affectedArea: string; criterion: string },
  ) {
    return this.getCoordinator().proposeMission(turnId, input);
  }
  planFromTurn(turnId: string) {
    return this.getCoordinator().ensureChatProposal(turnId);
  }
  async planMission(turnId: string) {
    if (!this.env.PLAN) return this.planFromTurn(turnId);
    const planner = await getAgentByName(this.env.PLAN, `plan:${turnId}`);
    return planner.start(turnId);
  }
  recordStage(input: Parameters<Coordinator["recordStage"]>[0]) {
    return this.getCoordinator().recordStage(input);
  }
  recordProbes(threadId: string, runId: string, probes: Parameters<Coordinator["recordProbes"]>[2]) {
    return this.getCoordinator().recordProbes(threadId, runId, probes);
  }
  async readConversationAttachment(turnId: string, reference: StoredImageAttachment) {
    const turn = this.getCoordinator().conversationTurn(turnId);
    if (
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
    const input = this.getCoordinator().state.requests?.[context.runId];
    if (
      !input?.knowledgeContext ||
      !sameKnowledgeContext(input.knowledgeContext, context) ||
      ![...input.messages, ...(input.conversationContext ?? [])].some((message) =>
        message.attachments?.some(
          (ref) => "attachmentId" in ref && JSON.stringify(ref) === JSON.stringify(reference),
        ),
      )
    )
      throw Error("attachment_not_admitted");
    return this.getImages().get(reference);
  }
  private readonly jobs: DurableJobs;
  private readonly budgetJobs: DurableJobs;
  private admission?: InfrastructureAdmission;
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
          if (
            !gate.stopRequired(
              reservation.runId,
              this.env.EXECUTION_MODE === "cloud" &&
                this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true",
            )
          )
            continue;
          if (!gate.beginCleanupAttempt(reservation.runId)) continue;
          // The singleton coordinator derives worker identity; no client controls the target.
          const core = this.getCoordinator();
          const run = core.state.runs.find((item) => item.id === reservation.runId);
          if (!run) continue; // Uncertain ownership retains its slot for reconciliation.
          const worker = this.env.CHANGE.get(
            this.env.CHANGE.idFromName(`change:${core.state.project.id}:${run.id}`),
          );
          try {
            await boundedCleanupRpc(worker.stop(run.id));
            const receipt = await boundedCleanupRpc(worker.result(run.id));
            if (receipt.cleanupVerified) gate.release(run.id, true);
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
        if (this.env.EXECUTION_MODE !== "cloud" && this.env.EXECUTION_MODE !== "local") return;
        const core = this.getCoordinator();
        for (const run of core.state.runs)
          if (["queued", "running", "awaiting_review"].includes(run.status))
            await jobs.enqueue(run.id, { runId: run.id });
      },
      async (payload) => {
        const runId = (payload as { runId: string }).runId;
        if (this.env.EXECUTION_MODE === "local") return this.finishLocalRun(runId);
        const core = this.getCoordinator();
        const run = core.evidence(runId).run;
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
        if (!this.env.ARTIFACT_REPOSITORY || !this.env.MODEL_CONFIGURATION) {
          core.fail(runId, true);
          return;
        }
        try {
          const request = { ...input, repository: this.env.ARTIFACT_REPOSITORY };
          const fingerprint = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(JSON.stringify(request)),
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
          try {
            admitted = gate.reserve(
              runId,
              fingerprint,
              this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true",
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
          await this.budgetJobs.enqueue("watchdog", {}, Date.now() + 5000);
          // getAgentByName activates lifecycle capabilities, including the harness.
          // Reserve first. Only synchronous control/observation RPCs may be used on denial.
          const worker = admitted.allowed
            ? await getAgentByName(this.env.CHANGE, `change:${input.projectId}:${input.runId}`, {
                props: {
                  runModels: input.runModels,
                  credentialActor: input.credentialActor,
                  role: "implementer",
                  deadline: admitted.reservation.deadline,
                },
              })
            : this.env.CHANGE.get(
                this.env.CHANGE.idFromName(`change:${input.projectId}:${input.runId}`),
              );
          // Dedicated cleanup job owns bounded stop retries; the result job only observes.
          const admission = admitted.allowed ? await worker.start(request) : { stage: "existing" };
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
            if (receipt.cleanupVerified) gate.release(runId, true);
            return;
          }
          if (receipt.stage === "blocked") {
            if (!receipt.cleanupVerified) return { rescheduleAt: Date.now() + 5000 };
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
        for (const turn of this.getCoordinator().state.conversationTurns ?? [])
          if (["queued", "running"].includes(turn.status))
            await jobs.enqueue(turn.id, { turnId: turn.id });
      },
      async (payload) => {
        const id = (payload as { turnId: string }).turnId;
        const core = this.getCoordinator();
        const turn = core.conversationTurn(id);
        if (["completed", "failed"].includes(turn.status)) return;
        if (!this.conversationsEnabled()) {
          core.completeConversation(id, undefined, "execution_unavailable");
          return;
        }
        const firstAdmission = turn.status === "queued";
        let input;
        try {
          input = core.beginConversation(id);
        } catch {
          core.completeConversation(id, undefined, "conversation_context_limit");
          return;
        }
        if (!input) return { rescheduleAt: Date.now() + 1000 };
        try {
          if (
            firstAdmission &&
            this.env.EXECUTION_MODE !== "local" &&
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
          const worker = await getAgentByName(
            this.env.CONVERSATION,
            `repo:${input.projectId}:${input.turnId}`,
            { props: input },
          );
          await worker.start(input);
          const receipt = await worker.result(id);
          if (receipt.status === "completed") {
            const mission = core.threadMission(turn.threadId);
            if (mission?.status === "clarifying" && !mission.proposal) await this.planMission(id);
            core.completeConversation(id, receipt.text);
            return;
          }
          if (receipt.status === "failed") {
            const mission = core.threadMission(turn.threadId);
            if (mission?.status === "proposed" && mission.proposal?.summary)
              core.completeConversation(id, mission.proposal.summary);
            else core.completeConversation(id, undefined, receipt.error);
            return;
          }
        } catch {
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
    return this.getCoordinator().refreshWorkerKnowledge(context);
  }
  async appendWorkerKnowledge(context: WorkerKnowledgeContext, report: KnowledgeReport) {
    return this.getCoordinator().appendWorkerKnowledge(context, report);
  }
  private async finishLocalRun(runId: string) {
    const core = this.getCoordinator();
    const run = core.evidence(runId).run;
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
    if (
      !this.env.OPENROUTER_API_KEY ||
      !this.env.MODEL_CONFIGURATION ||
      !this.env.LOCAL_FIXTURE_DIR
    ) {
      core.fail(runId, true);
      return;
    }
    const request = { ...input, repository: this.env.ARTIFACT_REPOSITORY ?? "pitcrew-baseline" };
    try {
      const worker = await getAgentByName(
        this.env.CHANGE,
        `change:${input.projectId}:${input.runId}`,
        {
          props: {
            runModels: input.runModels,
            credentialActor: input.credentialActor,
            role: "implementer",
            deadline: Date.now() + 10 * 60 * 1000,
          },
        },
      );
      const started = await worker.start(request);
      if (
        started.stage === "blocked" &&
        "error" in started &&
        started.error === "reconciliation_required"
      ) {
        core.fail(runId, true);
        return;
      }
      const receipt = await worker.result(runId);
      if (receipt.stage === "done" && receipt.result) {
        await core.completeVerified(runId, receipt.result);
        await worker.acknowledge(runId);
        return;
      }
      if (receipt.stage === "blocked") {
        core.fail(runId, false);
        return;
      }
      return { rescheduleAt: Date.now() + 1000 };
    } catch {
      return { rescheduleAt: Date.now() + 1000 };
    }
  }
  protected getCoordinator() {
    if (this.coordinator) return this.coordinator;
    const serialized = readRepositoryState(this.ctx.storage.sql);
    const state = serialized
      ? (JSON.parse(serialized) as State)
      : this.env.EXECUTION_MODE === "cloud" || this.env.EXECUTION_MODE === "local"
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
          writeRepositoryState(this.ctx.storage.sql, JSON.stringify(state));
        }),
      undefined,
      undefined,
      this.getImages(),
      (operation) => this.ctx.storage.transactionSync(operation),
    );
    this.coordinator.recover(
      this.env.EXECUTION_MODE === "cloud" || this.env.EXECUTION_MODE === "local",
    );
    return this.coordinator;
  }
  async onRequest(request: Request) {
    const identity = await principal(request, this.env);
    if (!identity) return Response.json({ error: "access_not_configured" }, { status: 403 });
    if (new URL(request.url).pathname === "/api/provider-connection/openrouter")
      return providerConnectionRequest(request, this.env, identity.actor);
    if (new URL(request.url).pathname === "/api/provider-connection/openrouter/models")
      return providerModelsRequest(request, this.env, identity.actor);
    if (
      this.env.EXECUTION_MODE === "disabled" &&
      request.method === "POST" &&
      (/^\/api\/threads\/[^/]+\/messages$/.test(new URL(request.url).pathname) ||
        /^\/api\/changes\/[^/]+\/runs$/.test(new URL(request.url).pathname) ||
        /^\/api\/projects\/[^/]+\/intake\/dispatch$/.test(new URL(request.url).pathname))
    )
      return Response.json({ error: "execution_disabled" }, { status: 503 });
    if (/^\/api\/repositories(?:\/|$)/.test(new URL(request.url).pathname))
      return lifecycleRequest(request, this.getRepositoryLifecycle(request), (task) =>
        this.ctx.waitUntil(task),
      );
    const bodyLimit = /^\/api\/threads\/[^/]+\/messages$/.test(new URL(request.url).pathname)
      ? ATTACHMENT_LIMITS.requestBytes
      : 16384;
    if (Number(request.headers.get("content-length") ?? 0) > bodyLimit)
      return Response.json({ error: "body_too_large" }, { status: 413 });
    const coordinator = this.getCoordinator();
    let providerReady =
      this.env.EXECUTION_MODE === "fake" ||
      (this.env.EXECUTION_MODE === "local" && !!this.env.OPENROUTER_API_KEY) ||
      !requiresUserOpenRouter(this.env);
    if (!providerReady && credentialStorageAvailable(this.env)) {
      try {
        providerReady = await userCredential(this.env, identity.actor).configured(identity.actor);
      } catch {
        /* Fail closed. */
      }
    }
    if (
      this.env.EXECUTION_MODE !== "fake" &&
      !providerReady &&
      request.method === "POST" &&
      (/^\/api\/threads\/[^/]+\/messages$/.test(new URL(request.url).pathname) ||
        /^\/api\/changes\/[^/]+\/runs$/.test(new URL(request.url).pathname) ||
        /^\/api\/projects\/[^/]+\/intake\/dispatch$/.test(new URL(request.url).pathname))
    )
      return Response.json({ error: "provider_credential_unavailable" }, { status: 409 });
    const app = api(
      coordinator,
      (id) => this.dispatchRun(id),
      this.landing(coordinator),
      identity,
      this.env.CONVERSATION &&
        providerReady &&
        this.conversationsEnabled() &&
        (this.env.EXECUTION_MODE === "fake" ||
          this.env.EXECUTION_MODE === "local" ||
          !!this.env.MODEL_CONFIGURATION)
        ? {
            catalog: resolveCatalog(
              this.env.EXECUTION_MODE === "local"
                ? this.env
                : userModelEnv(this.env, identity.actor),
            ),
            dispatch: (id) => this.conversationJobs.enqueue(id, { turnId: id }),
          }
        : undefined,
      this.env.EXECUTION_MODE === "local" && !!this.env.OPENROUTER_API_KEY,
    );
    return app.fetch(request);
  }
}
export default {
  fetch(request: Request, env: Env) {
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
