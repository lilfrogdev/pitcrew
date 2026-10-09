import worker, { RepositoryAgent, RepoConversationAgent } from "../src/index";
import { initialState } from "../src/coordinator";
import { resolveCatalog } from "../src/model-selection";
import type { Member } from "../src/collaboration";
import { DurableObject } from "cloudflare:workers";

export { RepoConversationAgent };

/** Holds authority-test turns open; the actual-flow test uses RepoConversationAgent. */
export class HeldMemoryConversation extends DurableObject {
  start() {
    return { status: "running" as const };
  }
  result() {
    return { status: "running" as const };
  }
  stop() {
    return { status: "failed" as const, error: "membership_revoked" };
  }
}

const alice: Member = { actor: "alice", email: "alice@example.test", role: "owner" };
const bob: Member = { actor: "bob", email: "bob@example.test", role: "editor" };

/** Synthetic setup only. All memory operations below use production authority methods. */
export class MemoryRepositoryFixture extends RepositoryAgent {
  async seedMemory(shared = false, queuedFuture = false) {
    const core = this.getCoordinator();
    Object.assign(
      core.state,
      initialState({ baseSha: "a".repeat(40), configurationRevision: "memory-fixture" }),
    );
    const source = core.createThread("Private source", "source");
    const destination = core.createThread("Destination", "destination");
    core.appendNote(
      source.id,
      "Preference: use explicit Save changes and Cancel labels. Incident: an import retry duplicated records; impact was duplicate billing. Decision: use an idempotency receipt before dispatch.",
      "past",
      alice.actor,
    );
    core.appendNote(
      destination.id,
      "Destination history is safe for both members.",
      "local",
      alice.actor,
    );
    core.updateCollaboration((state) => {
      state.collaboration = {
        projectMembers: { alice, bob },
        threadMembers: {
          [source.id]: shared ? { alice, bob } : { alice },
          [destination.id]: { alice, bob },
        },
        invitations: {},
      };
    });
    const receipt = core.queueTurn(
      destination.id,
      "Implement an import retry. Recall past incidents, impact, preferences and design decisions.",
      "current",
      alice.actor,
      resolveCatalog(this.env),
    );
    if (queuedFuture)
      core.queueTurn(
        destination.id,
        "FUTURE_ONLY_B_COMMAND: implement removal of the source database.",
        "future",
        alice.actor,
        resolveCatalog(this.env),
      );
    const input = core.beginConversation(receipt.turn.id, true)!;
    await this.prepareRepoMemory(core, input.turnId);
    return { sourceId: source.id, destinationId: destination.id, turnId: input.turnId };
  }

  memorySnapshot() {
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'repo_memory_%' ORDER BY name",
      )
      .toArray();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        this.ctx.storage.sql.exec(`SELECT * FROM ${name}`).toArray(),
      ]),
    );
  }

  setMemoryMembership(sourceId: string, bobCanRead: boolean, aliceCanRead = true) {
    this.getCoordinator().updateCollaboration((state) => {
      state.collaboration!.threadMembers[sourceId] = {
        ...(aliceCanRead ? { alice } : {}),
        ...(bobCanRead ? { bob } : {}),
      };
    });
  }

  async syncMemory(turnId: string) {
    await this.prepareRepoMemory(this.getCoordinator(), turnId);
    return this.memorySnapshot();
  }

  async frozenWorkerBrief(turnId: string) {
    const core = this.getCoordinator();
    const run = core.delegateConversation(turnId);
    const input = core.begin(run.id)!;
    return input;
  }

  async verifyFrozenWorkerBrief(turnId: string) {
    const input = await this.frozenWorkerBrief(turnId);
    if (input.memoryBrief)
      await this.assertWorkerMemory(input.knowledgeContext!, input.memoryBrief);
    return input;
  }

  async retryFrozenWorkerBrief(turnId: string, key: string, actor: "alice" | "bob" = "alice") {
    const core = this.getCoordinator();
    const original = core.conversationTurn(turnId);
    const initialRun = original.runId
      ? core.evidence(original.runId).run
      : core.delegateConversation(turnId);
    for (const run of core.state.runs.filter((item) => item.changeId === initialRun.changeId))
      core.fail(run.id);
    const retry = core.retryChange(
      initialRun.changeId!,
      key,
      resolveCatalog(this.env),
      actor,
      actor,
    );
    const input = core.begin(retry.id);
    if (!input) throw Error("memory_retry_denied");
    if (input.memoryBrief)
      await this.assertWorkerMemory(input.knowledgeContext!, input.memoryBrief);
    return input;
  }

  seedLongHistory() {
    const core = this.getCoordinator();
    Object.assign(
      core.state,
      initialState({ baseSha: "a".repeat(40), configurationRevision: "memory-fixture" }),
    );
    const thread = core.createThread("Long history", "long-history");
    for (let index = 0; index < 40; index++) {
      const fact = `Incident ${index}: a retry duplicated records; preserve raw evidence and check idempotency before dispatch. `;
      core.appendNote(thread.id, fact.repeat(70), `history-${index}`, "lilfrogdev");
    }
    return { threadId: thread.id };
  }

  admittedTurn(turnId: string) {
    return this.getCoordinator().conversationTurn(turnId).input;
  }
}

type Env = Omit<Parameters<typeof worker.fetch>[1], "REPOSITORY"> & {
  REPOSITORY: DurableObjectNamespace<MemoryRepositoryFixture>;
};

export default {
  async fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith("/fixture/")) return worker.fetch(request, env);
    const body = (await request.json()) as {
      operation: string;
      turnId: string;
      sourceId: string;
      shared?: boolean;
      queuedFuture?: boolean;
      aliceCanRead?: boolean;
      bobCanRead?: boolean;
      callId?: string;
      query?: string;
      nodeId?: string;
      retryActor?: "alice" | "bob";
    };
    const repository = env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew"));
    try {
      let result: unknown;
      switch (body.operation) {
        case "seed":
          result = await repository.seedMemory(body.shared, body.queuedFuture);
          break;
        case "long-history":
          result = await repository.seedLongHistory();
          break;
        case "snapshot":
          result = await repository.memorySnapshot();
          break;
        case "admitted":
          result = await repository.admittedTurn(body.turnId);
          break;
        case "membership":
          await repository.setMemoryMembership(body.sourceId, !!body.bobCanRead, body.aliceCanRead);
          result = { updated: true };
          break;
        case "fresh":
          result = await repository.freshConversationMemory(body.turnId);
          break;
        case "sync":
          result = await repository.syncMemory(body.turnId);
          break;
        case "search":
          result = await repository.readRepoMemory(body.turnId, body.callId!, "search", {
            query: body.query,
          });
          break;
        case "view":
          result = await repository.readRepoMemory(body.turnId, body.callId!, "view", {});
          break;
        case "zoom":
          result = await repository.readRepoMemory(body.turnId, body.callId!, "zoom", {
            nodeId: body.nodeId,
          });
          break;
        case "authorize":
          result = await repository.authorizeConversationModel(body.turnId);
          break;
        case "brief":
          result = await repository.verifyFrozenWorkerBrief(body.turnId);
          break;
        case "retry":
          result = await repository.retryFrozenWorkerBrief(
            body.turnId,
            body.callId!,
            body.retryActor,
          );
          break;
        default:
          throw Error("unknown_fixture_operation");
      }
      return Response.json({ result });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "fixture_failed" },
        { status: 409 },
      );
    }
  },
};
