import backend from "../../src/index";
import type { Coordinator } from "../../src/coordinator";
import { resolveCatalog } from "../../src/model-selection";
import { RepositorySharingFixture } from "./repository-management-sharing-worker";
export { PasswordCredentialsFixture } from "./repository-management-sharing-worker";

/** Trusted synthetic main-turn setup. Native accounts, invitations and membership
 * are established through production HTTP; memory uses production SQLite/RPC. */
export class RepositoryMemorySharingFixture extends RepositorySharingFixture {
  async beginMemoryTurn(projectId: string, threadId: string, actor: string) {
    const core = (
      this as unknown as { projectCoordinator(id: string): Coordinator }
    ).projectCoordinator(projectId);
    const queued = core.queueTurn(
      threadId,
      "Recall prior incidents and preferences for this destination",
      crypto.randomUUID(),
      actor,
      resolveCatalog(this.env),
    );
    const input = core.beginConversation(queued.turn.id)!;
    if (input.memoryEnabled) await this.prepareRepoMemory(core, input.turnId);
    return this.freshConversationMemory(input.turnId);
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
  async memoryOperation(
    turnId: string,
    operation: "fresh" | "search" | "authorize",
    callId = "test-search",
    query = "",
  ) {
    try {
      const value =
        operation === "fresh"
          ? await this.freshConversationMemory(turnId)
          : operation === "search"
            ? await this.readRepoMemory(turnId, callId, "search", { query })
            : await this.authorizeConversationModel(turnId);
      return { ok: true, value };
    } catch (error) {
      // Return the genuine production rejection across Miniflare RPC as data.
      return { ok: false, error: error instanceof Error ? error.message : "memory_rejected" };
    }
  }
}
export default backend;
