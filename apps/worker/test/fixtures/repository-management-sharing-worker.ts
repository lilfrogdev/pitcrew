import backend from "../../src/index";
import type { Coordinator } from "../../src/coordinator";
import {
  RepositoryManagementFixture,
  PasswordCredentialsFixture,
} from "./repository-management-worker";
export { PasswordCredentialsFixture };

/** These trusted setup hooks operate on temporary, synthetic local state. Auth,
 * sessions, lookups, invitation hashing and admission still run production code. */
export class RepositorySharingFixture extends RepositoryManagementFixture {
  private recipientLookupHold?: { entered: boolean; wait: Promise<void>; release(): void };
  constructor(
    ctx: DurableObjectState,
    env: ConstructorParameters<typeof RepositoryManagementFixture>[1],
  ) {
    super(ctx, env);
    const db = this.env.AUTH_DB!;
    const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement =>
      new Proxy(statement, {
        get: (target, key) => {
          if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), query);
          if (key === "all")
            return async () => {
              const result = await target.all(); // Genuine workerd D1 rows, never substituted.
              if (
                query.includes("FROM user u") &&
                query.includes("provenance") &&
                this.recipientLookupHold
              ) {
                this.recipientLookupHold.entered = true;
                await this.recipientLookupHold.wait;
              }
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    this.env.AUTH_DB = new Proxy(db, {
      get: (target, key) => {
        if (key === "prepare") return (query: string) => wrap(target.prepare(query), query);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  holdRecipientLookup() {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.recipientLookupHold = { entered: false, wait, release };
  }
  recipientLookupEntered() {
    return this.recipientLookupHold?.entered ?? false;
  }
  releaseRecipientLookup() {
    this.recipientLookupHold?.release();
    this.recipientLookupHold = undefined;
  }

  private project(projectId: string) {
    return (this as unknown as { projectCoordinator(id: string): Coordinator }).projectCoordinator(
      projectId,
    );
  }
  async seedLegacyInvitation(
    projectId: string,
    issuerActor: string,
    email: string,
    threadId?: string,
  ) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const digest = Array.from(new Uint8Array(hash), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const id = crypto.randomUUID();
    this.project(projectId).updateCollaboration((state) => {
      state.collaboration!.invitations[id] = {
        id,
        digest,
        scope: threadId ? "thread" : "project",
        ...(threadId ? { threadId } : {}),
        email,
        role: "editor",
        invitedBy: issuerActor,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
    });
    return { id, token };
  }
  revokeIssuerThread(projectId: string, threadId: string, actor: string) {
    this.project(projectId).updateCollaboration((state) => {
      delete state.collaboration!.threadMembers[threadId]?.[actor];
    });
  }
  demoteIssuer(projectId: string, actor: string) {
    this.project(projectId).updateCollaboration((state) => {
      state.collaboration!.projectMembers[actor].role = "editor";
    });
  }
}
export default backend;
