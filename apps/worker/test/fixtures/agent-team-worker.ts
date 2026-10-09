import backend from "../../src/index";
import { RepoConversationAgent } from "../../src/repo-conversation-agent";
import type { ConversationInput } from "../../src/conversation";
import type { Coordinator } from "../../src/coordinator";
import type { KnowledgeRecord } from "@pitcrew/protocol";
import type { configureSelectedModels } from "../../src/model-selection";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { UserCredentials } from "../../src/user-credentials-agent";
import { RepositoryMemorySharingFixture } from "./repository-management-memory-sharing-worker";

/** Production native auth, encrypted synthetic credentials, SQLite and Pi. Only
 * the external model response is replaced; outbound network is forbidden. */
export class AgentTeamRepositoryFixture extends RepositoryMemorySharingFixture {
  canary(policy: string | undefined) {
    this.env.CLOUD_CONVERSATION_CANARY = policy;
  }
  canarySnapshot() {
    return {
      scopes: this.ctx.storage.sql.exec("SELECT * FROM conversation_canary_scope").toArray(),
      receipts: this.ctx.storage.sql.exec("SELECT * FROM conversation_canary_receipt").toArray(),
    };
  }
  async oldQueuedTurn(projectId: string, threadId: string, actor: string) {
    const { resolveCatalog, conversationModelEnv } = await import("../../src/model-selection");
    return this.projectCore(projectId).queueTurn(
      threadId,
      "Old global queued turn",
      crypto.randomUUID(),
      actor,
      resolveCatalog(conversationModelEnv(this.env)),
    ).turn.id;
  }
  async historicalImage(projectId: string, threadId: string, actor: string) {
    const { resolveCatalog, conversationModelEnv } = await import("../../src/model-selection");
    const core = this.projectCore(projectId);
    const { turn } = core.queueTurn(
      threadId,
      "Synthetic native image history",
      crypto.randomUUID(),
      actor,
      resolveCatalog(conversationModelEnv(this.env)),
      undefined,
      [
        {
          id: "synthetic-image",
          name: "synthetic.png",
          mediaType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        },
      ],
    );
    core.beginConversation(turn.id);
    core.completeConversation(turn.id, "Synthetic history only; no inference occurred.");
  }
  async resumeFixtureTurn(turnId: string) {
    await this.enqueueConversation(turnId);
  }
  async compressionFence(turnId: string) {
    try {
      await (
        this as unknown as { freshConversationCanary(id: string): Promise<void> }
      ).freshConversationCanary(turnId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "denied" };
    }
  }
  async settleFixtureModel(turnId: string, requestId: string) {
    return this.authorizeConversationModel(turnId, 0, 1, true, requestId);
  }
  async nativeImageFence(turnId: string) {
    try {
      await this.authorizeConversationModel(turnId, 1, 0, false, crypto.randomUUID(), 1);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "denied" };
    }
  }
  async forbiddenVisualization(turnId: string) {
    try {
      await this.publishConversationVisualization(turnId, "synthetic-publication", null);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "denied" };
    }
  }
  async blockedCompression(turnId: string, projectId: string) {
    try {
      const input = this.projectCore(projectId).conversationTurn(turnId).input!;
      await this.compressRepoMemory(
        input,
        {} as Parameters<AgentTeamRepositoryFixture["compressRepoMemory"]>[1],
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "denied" };
    }
  }
  async seedScopedContext(projectId: string, threadId: string, actor: string, marker: string) {
    try {
      const core = this.projectCore(projectId);
      const record = core.appendKnowledge(actor, crypto.randomUUID(), {
        id: crypto.randomUUID(),
        expectedVersion: 0,
        status: "accepted",
        text: marker + "_KNOWLEDGE",
        kind: "decision",
        sourceRefs: [{ kind: "policy", id: "synthetic-context-fixture" }],
        reason: "Synthetic privacy fixture",
      });
      (core as unknown as { recordKnowledge(record: KnowledgeRecord): unknown }).recordKnowledge({
        ...record,
        version: 2,
        eventId: crypto.randomUUID(),
        threadId,
      });
      core.submit(threadId, marker + "_ACTIVE_INTENT", crypto.randomUUID(), actor);
      return { ok: true, context: core.repositoryContext(actor) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "denied" };
    }
  }
  private modelHold?: { entered: boolean; wait: Promise<void>; release(): void };
  private projectCore(projectId: string) {
    return (this as unknown as { projectCoordinator(id: string): Coordinator }).projectCoordinator(
      projectId,
    );
  }
  async recordModelRequest(turnId: string, messages: unknown, options: unknown) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invocation_calls(turn_id TEXT,messages TEXT,options TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO invocation_calls VALUES(?,?,?)",
      turnId,
      JSON.stringify(messages),
      JSON.stringify(options),
    );
    if (this.modelHold) {
      this.modelHold.entered = true;
      await this.modelHold.wait;
    }
  }
  holdModel() {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.modelHold = { entered: false, wait, release };
  }
  modelEntered() {
    return this.modelHold?.entered ?? false;
  }
  releaseModel() {
    this.modelHold?.release();
    this.modelHold = undefined;
  }
  invocationSnapshot(projectId: string) {
    const state = this.projectCore(projectId).state;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invocation_calls(turn_id TEXT,messages TEXT,options TEXT)",
    );
    return {
      messages: state.messages,
      turns: state.conversationTurns ?? [],
      runs: state.runs,
      modelCalls: this.ctx.storage.sql
        .exec<{ turn_id: string; messages: string; options: string }>(
          "SELECT * FROM invocation_calls",
        )
        .toArray()
        .map((row) => ({
          turnId: row.turn_id,
          messages: JSON.parse(row.messages),
          options: JSON.parse(row.options),
        })),
    };
  }
  async tryDelegate(turnId: string) {
    try {
      return { ok: true, value: await this.delegateRepoTurn(turnId) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "denied" };
    }
  }
  async conversationOperation(
    turnId: string,
    kind: "model" | "tool" | "fresh",
    callId: string = crypto.randomUUID(),
  ) {
    try {
      const value =
        kind === "model"
          ? await this.authorizeConversationModel(turnId, 1, 0, false, callId)
          : kind === "tool"
            ? await this.authorizeConversationTool(turnId, callId)
            : await this.freshConversationMemory(turnId);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "denied" };
    }
  }
}

export class AgentTeamCredentialsFixture extends UserCredentials {
  delayConfigured(milliseconds: number) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS configured_delay(id INTEGER PRIMARY KEY,milliseconds INTEGER)",
    );
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO configured_delay VALUES(1,?)", milliseconds);
  }
  private count(operation: string, actor: string) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS credential_fixture_calls(operation TEXT,actor TEXT)",
    );
    this.ctx.storage.sql.exec("INSERT INTO credential_fixture_calls VALUES(?,?)", operation, actor);
  }
  async read(actor: string) {
    this.count("read", actor);
    return super.read(actor);
  }
  async configured(actor: string) {
    this.count("configured", actor);
    const exists = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='configured_delay'")
      .toArray().length;
    const delay = exists
      ? this.ctx.storage.sql
          .exec<{ milliseconds: number }>("SELECT milliseconds FROM configured_delay WHERE id=1")
          .toArray()[0]?.milliseconds
      : 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return super.configured(actor);
  }
  fixtureCalls() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS credential_fixture_calls(operation TEXT,actor TEXT)",
    );
    return this.ctx.storage.sql.exec("SELECT * FROM credential_fixture_calls").toArray();
  }
}

export class AgentTeamConversationFixture extends RepoConversationAgent {
  savedInput() {
    return (
      this.ctx.storage.sql.exec("SELECT value FROM conversation_input WHERE id=1").toArray()
        .length > 0
    );
  }
  protected openHarness(...args: Parameters<RepoConversationAgent["openHarness"]>) {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM conversation_input WHERE id=1")
      .toArray()[0];
    const input = JSON.parse(row.value) as ConversationInput;
    const models = args[1].models! as ReturnType<typeof configureSelectedModels>["models"];
    const selected = models.getModel(
      "openrouter",
      JSON.parse(this.env.MODEL_CONFIGURATION!).model,
    )!;
    const provider = models.getProvider(selected.provider)!;
    const faux = fauxProvider({
      provider: provider.id,
      models: [{ id: selected.id, maxTokens: selected.maxTokens }],
    });
    faux.setResponses([
      async (context, options) => {
        const repository = this.env.REPOSITORY.get(
          this.env.REPOSITORY.idFromName("pitcrew"),
        ) as unknown as DurableObjectStub<AgentTeamRepositoryFixture>;
        await repository.recordModelRequest(input.turnId, context.messages, {
          tools: context.messages.flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
          ),
          maxTokens: options?.maxTokens,
          maxRetries: options?.maxRetries,
        });
        return fauxAssistantMessage(
          "Synthetic Agent answer. No external model or implementation worker was called.",
        );
      },
    ]);
    models.setProvider({ ...provider, streamSimple: faux.provider.streamSimple });
    return super.openHarness(...args);
  }
}
export default backend;
