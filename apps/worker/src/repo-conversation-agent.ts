import { userModelEnv } from "./user-credentials";
import { Agent } from "agents";
import { LifecycleCapability, type CapabilityStartContext } from "agents/lifecycle";
import type { PiHarness } from "agents/harness/pi";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { repositoryConversationTools } from "./repo-conversation-tools";
import { configureSelectedModels, configureConversation } from "./model-selection";
import { DurableJobs } from "./durable-jobs";
import { AdmittedPiHarness, type PiEnv } from "./pi-agents";
import type { ConversationInput, ConversationReceipt } from "./conversation";
import type { RepositoryAgent } from "./index";
import { repositoryPrompt } from "./repo-conversation-driver";

class ConversationAdmission extends LifecycleCapability<ConversationInput> {
  constructor(private bind: (input: ConversationInput) => void) {
    super("conversation-admission");
  }
  onStart(context: CapabilityStartContext<ConversationInput>) {
    if (context.props) this.bind(context.props);
  }
}
/** One isolated durable Pi session per frozen turn. It has no code or landing tools. */
export class RepoConversationAgent extends Agent<PiEnv, unknown, ConversationInput> {
  private readonly registry = createRegistry();
  protected readonly harness: PiHarness;
  private readonly jobs: DurableJobs;
  constructor(ctx: DurableObjectState, env: PiEnv) {
    super(ctx, env);
    void this
      .sql`CREATE TABLE IF NOT EXISTS conversation_input(id INTEGER PRIMARY KEY,value TEXT NOT NULL)`;
    void this
      .sql`CREATE TABLE IF NOT EXISTS conversation_receipt(id INTEGER PRIMARY KEY,status TEXT NOT NULL,value TEXT NOT NULL)`;
    this.lifecycle.use(new ConversationAdmission((input) => this.bind(input)));
    this.harness = new AdmittedPiHarness(
      {
        harness: async ({ storage, context }) => {
          this.assertConversationAllowed();
          const input = this.input();
          const configured = configureSelectedModels(
            env.EXECUTION_MODE === "local" ? env : userModelEnv(env, input.credentialActor),
            input.models.repoAgent,
            input.models.catalogRevision,
          );
          if (env.EXECUTION_MODE === "fake") {
            const fixture = fauxProvider({
              provider: configured.model.provider,
              models: [{ id: configured.model.id, maxTokens: 1024 }],
            });
            fixture.setResponses([
              fauxAssistantMessage(
                "Development fixture: your message and attachments were received. No real model service or change worker was called.",
              ),
            ]);
            configured.models.setProvider(fixture.provider);
          }

          this.registry.install(
            repositoryConversationTools(
              () => {
                this.assertConversationAllowed();
                return this.repository().delegateRepoTurn(this.input().turnId);
              },
              {
                ask: (prompts) => {
                  this.assertConversationAllowed();
                  return this.repository().askMission(this.input().turnId, prompts);
                },
                propose: (input) => {
                  this.assertConversationAllowed();
                  return this.repository().proposeMission(this.input().turnId, input);
                },
              },
            ),
          );
          const harness = await this.openHarness(
            storage,
            {
              models: configured.models,
              registry: this.registry,
              settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 } },
            },
            context,
          );
          if (!this.conversationAllowed()) {
            await harness.close(context);
            throw Error("execution_disabled");
          }
          await configureConversation(harness, configured.model, configured.selection, context);
          if (!this.conversationAllowed()) {
            await harness.close(context);
            throw Error("execution_disabled");
          }
          // The SDK awaits root() after this factory before resuming durable tasks.
          const resume = harness.resume.bind(harness);
          harness.resume = () => {
            if (this.conversationAllowed()) resume();
          };
          return harness;
        },
      },
      () => this.conversationAllowed(),
    );
    this.lifecycle.use(this.harness);
    this.jobs = new DurableJobs(
      "repo-conversation",
      async (jobs) => {
        if (!this.conversationAllowed()) return;
        const row = this.sql<{
          status: string;
        }>`SELECT status FROM conversation_receipt WHERE id=1`[0];
        if (row?.status === "running") await jobs.enqueue("turn", {});
      },
      async () => {
        const row = this.receipt();
        if (row.status !== "running") return;
        try {
          this.assertConversationAllowed();
          const input = this.input();
          const prompt = await repositoryPrompt(input, (ref) => {
            this.assertConversationAllowed();
            return this.repository().readConversationAttachment(input.turnId, ref);
          });
          this.assertConversationAllowed();
          await this.harness.submit(prompt, { operationId: `repo:${input.turnId}` });
          this.assertConversationAllowed();
          const result = await this.harness.wait(`repo:${input.turnId}`);
          if (result.status !== "done" || !result.text?.trim() || result.text.length > 16384)
            throw Error("conversation_unanswered");
          this.finish({ status: "completed", text: result.text });
        } catch {
          // Error details can include provider responses; expose only a stable code.
          this.finish({ status: "failed", error: "conversation_failed" });
        }
      },
    );
    void this
      .sql`CREATE TABLE IF NOT EXISTS conversation_input(id INTEGER PRIMARY KEY,value TEXT NOT NULL)`;
    void this
      .sql`CREATE TABLE IF NOT EXISTS conversation_receipt(id INTEGER PRIMARY KEY,status TEXT NOT NULL,value TEXT NOT NULL)`;
    this.lifecycle.use(this.jobs);
  }
  protected openHarness(...args: Parameters<typeof Harness.open>) {
    return Harness.open(...args);
  }
  protected conversationAllowed() {
    return (
      this.env.EXECUTION_MODE === "fake" ||
      (this.env.EXECUTION_MODE === "local" && !!this.env.OPENROUTER_API_KEY) ||
      (this.env.EXECUTION_MODE === "cloud" &&
        this.env.INFRASTRUCTURE_ADMISSION_ENABLED === "true" &&
        this.env.CLOUD_CONVERSATION_ENABLED === "true")
    );
  }
  private assertConversationAllowed() {
    if (!this.conversationAllowed()) throw Error("execution_disabled");
  }
  private repository(): DurableObjectStub<RepositoryAgent> {
    return this.env.REPOSITORY.get(this.env.REPOSITORY.idFromName("pitcrew"));
  }
  private input(): ConversationInput {
    const row = this.sql<{ value: string }>`SELECT value FROM conversation_input WHERE id=1`[0];
    if (!row) throw Error("conversation_unconfigured");
    return JSON.parse(row.value) as ConversationInput;
  }
  private receipt(): ConversationReceipt {
    const row = this.sql<{ value: string }>`SELECT value FROM conversation_receipt WHERE id=1`[0];
    return row
      ? (JSON.parse(row.value) as ConversationReceipt)
      : { status: "failed", error: "conversation_unconfigured" };
  }
  private finish(receipt: ConversationReceipt) {
    void this
      .sql`UPDATE conversation_receipt SET status=${receipt.status},value=${JSON.stringify(receipt)} WHERE id=1`;
  }
  private bind(input: ConversationInput) {
    this.ctx.storage.transactionSync(() => {
      const serialized = JSON.stringify(input);
      const row = this.sql<{ value: string }>`SELECT value FROM conversation_input WHERE id=1`[0];
      if (row && row.value !== serialized) throw Error("conversation_conflict");
      void this.sql`INSERT OR IGNORE INTO conversation_input VALUES(1,${serialized})`;
      void this
        .sql`INSERT OR IGNORE INTO conversation_receipt VALUES(1,'running',${JSON.stringify({ status: "running" })})`;
    });
  }
  async start(input: ConversationInput) {
    this.bind(input);
    if (!this.conversationAllowed()) {
      if (this.receipt().status === "running")
        this.finish({ status: "failed", error: "conversation_configuration_unavailable" });
      return this.receipt();
    }
    try {
      await this.lifecycle.start();
    } catch {
      this.finish({ status: "failed", error: "conversation_configuration_unavailable" });
      return this.receipt();
    }
    if (this.receipt().status === "running") await this.jobs.enqueue("turn", {});
    return this.receipt();
  }
  result(turnId: string) {
    if (this.input().turnId !== turnId) throw Error("conversation_conflict");
    return this.receipt();
  }
}
