import { readRepositoryState, writeRepositoryState } from "./repository-state";
import { sameKnowledgeContext } from "./knowledge";
import { RepoConversationAgent } from "./repo-conversation-agent";
export { RepoConversationAgent };
import { resolveCatalog, validateFrozenModels } from "./model-selection";
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
import { ChangeAgent, ReviewAgent, type PiEnv } from "./pi-agents";
export { ChangeAgent, ReviewAgent };
import { DurableJobs } from "./durable-jobs";
import { api } from "./api";
import { Coordinator, fakeExecution, initialState, type State } from "./coordinator";
interface Env extends PiEnv, AccessEnv {
  ASSETS?: Fetcher;
  PROJECT_BASE_SHA?: string;
  CHANGE: DurableObjectNamespace<ChangeAgent>;
  CONVERSATION?: DurableObjectNamespace<RepoConversationAgent>;
  ARTIFACT_REPOSITORY?: string;
  REPOSITORY: DurableObjectNamespace<RepositoryAgent>;
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  LANDING_MODE?: string;
  EXECUTION_MODE: string;
}
export class RepositoryAgent extends Agent<Env> {
  private coordinator?: Coordinator;
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
    if (this.env.EXECUTION_MODE === "cloud") await this.jobs.enqueue(id, { runId: id });
  }
  async delegateRepoTurn(turnId: string) {
    const run = this.getCoordinator().delegateConversation(turnId);
    await this.dispatchRun(run.id);
    return run;
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.jobs = new DurableJobs(
      "repository-results",
      async (jobs) => {
        if (this.env.EXECUTION_MODE !== "cloud") return;
        const core = this.getCoordinator();
        for (const run of core.state.runs)
          if (["queued", "running", "awaiting_review"].includes(run.status))
            await jobs.enqueue(run.id, { runId: run.id });
      },
      async (payload) => {
        const runId = (payload as { runId: string }).runId,
          core = this.getCoordinator();
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
          const worker = await getAgentByName(
            this.env.CHANGE,
            `change:${input.projectId}:${input.runId}`,
            { props: { runModels: input.runModels, role: "implementer" } },
          );
          const admission = await worker.start({
            ...input,
            repository: this.env.ARTIFACT_REPOSITORY,
          });
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
            return;
          }
          if (receipt.stage === "blocked") {
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
        if (!["cloud", "fake"].includes(this.env.EXECUTION_MODE)) {
          core.completeConversation(id, undefined, "execution_unavailable");
          return;
        }
        let input;
        try {
          input = core.beginConversation(id);
        } catch {
          core.completeConversation(id, undefined, "conversation_context_limit");
          return;
        }
        if (!input) return { rescheduleAt: Date.now() + 1000 };
        try {
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
            core.completeConversation(id, receipt.text);
            return;
          }
          if (receipt.status === "failed") {
            core.completeConversation(id, undefined, receipt.error);
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
  protected getCoordinator() {
    if (this.coordinator) return this.coordinator;
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
          writeRepositoryState(this.ctx.storage.sql, JSON.stringify(state));
        }),
      undefined,
      undefined,
      this.getImages(),
      (operation) => this.ctx.storage.transactionSync(operation),
    );
    this.coordinator.recover(this.env.EXECUTION_MODE === "cloud");
    return this.coordinator;
  }
  async onRequest(request: Request) {
    if (!(await principal(request, this.env)))
      return Response.json({ error: "access_not_configured" }, { status: 403 });
    const bodyLimit = /^\/api\/threads\/[^/]+\/messages$/.test(new URL(request.url).pathname)
      ? ATTACHMENT_LIMITS.requestBytes
      : 16384;
    if (Number(request.headers.get("content-length") ?? 0) > bodyLimit)
      return Response.json({ error: "body_too_large" }, { status: 413 });
    const coordinator = this.getCoordinator();
    const app = api(
      coordinator,
      (id) => this.dispatchRun(id),
      this.landing(coordinator),
      (await principal(request, this.env))!,
      this.env.CONVERSATION &&
        ["fake", "cloud"].includes(this.env.EXECUTION_MODE) &&
        (this.env.EXECUTION_MODE === "fake" || !!this.env.MODEL_CONFIGURATION)
        ? {
            catalog: resolveCatalog(this.env),
            dispatch: (id) => this.conversationJobs.enqueue(id, { turnId: id }),
          }
        : undefined,
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
