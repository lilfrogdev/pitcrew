import backend from "../../src/index";
import type { Coordinator } from "../../src/coordinator";
import { resolveCatalog } from "../../src/model-selection";
import { VisualizationTurnGrants } from "../../src/visualization-turn-grants";
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
    // This trusted setup still uses a genuine enrolled native account/session.
    // Production freshness now fences ordinary as well as memory-enabled turns.
    const userId = actor.slice("account:".length);
    const session = await this.env
      .AUTH_DB!.prepare(`SELECT s.id AS sessionId,s.expires_at AS expiresAt,u.email,e.id AS enrollmentId
      FROM session s JOIN user u ON u.id=s.user_id JOIN auth_enrollment e ON e.consumed_user_id=u.id
      WHERE s.user_id=? AND s.expires_at>? AND e.consumed_at IS NOT NULL ORDER BY s.created_at DESC LIMIT 1`)
      .bind(userId, Date.now())
      .first<{ sessionId: string; expiresAt: number; email: string; enrollmentId: string }>();
    if (!session) throw Error("synthetic_native_session_required");
    new VisualizationTurnGrants(this.ctx.storage.sql).bind({
      ...session,
      mode: "password-only",
      actor,
      userId,
      accessActor: actor,
      repositoryId: core.state.project.id,
      threadId,
      turnId: queued.turn.id,
    });
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
