import backend from "../src/index";
import { PasswordRepositoryFixture, PasswordCredentialsFixture } from "./password-ingress-worker";
export { PasswordCredentialsFixture };

type FakeRepository = {
  id: string;
  name: string;
  readOnly: boolean;
  defaultBranch: string;
  tokens: { id: string; state: "active" | "revoked" }[];
};
type Behavior = {
  create?: "ambiguous" | "wrong_name" | "error";
  infoError?: boolean;
  logError?: boolean;
  emptyHeadNotFound?: boolean;
  revokeFailure?: boolean;
  tokenCount?: number;
};

/** Fake only the external Artifacts transport. Sessions, authority gates, SQL
 * lifecycle records and project registration all use production code. */
export class AccountRepositoryCreationFixture extends PasswordRepositoryFixture {
  private paused?: { stage: string; entered: boolean; release(): void; wait: Promise<void> };
  constructor(
    ctx: DurableObjectState,
    env: ConstructorParameters<typeof PasswordRepositoryFixture>[1],
  ) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS creation_fixture(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    const approval = this.read<{ actor?: string; name?: string }>("approval");
    if (approval) this.applyApproval(approval.actor, approval.name);
    this.env.ARTIFACTS = {
      list: async (input: unknown) => {
        this.call("list", input);
        await this.wait("list");
        return { repos: this.repositories().map(({ id, name }) => ({ id, name })) };
      },
      create: async (name: string, options: { readOnly: boolean; setDefaultBranch: string }) => {
        this.call("create", { name, options });
        await this.wait("create");
        const behavior = this.behavior();
        if (behavior.create === "error") throw new Error("synthetic_create_failed");
        if (this.read<FakeRepository>("repo:" + name))
          throw Object.assign(new Error("ALREADY_EXISTS"), { code: "ALREADY_EXISTS" });
        const repo: FakeRepository = {
          id: "immutable-created_" + name,
          name,
          readOnly: options.readOnly,
          defaultBranch: options.setDefaultBranch,
          tokens: Array.from({ length: behavior.tokenCount ?? 1 }, (_, index) => ({
            id: `issued-${index + 1}`,
            state: "active",
          })),
        };
        this.write("repo:" + name, repo);
        // The marker models a creation credential returned by the provider. It
        // must never reach lifecycle storage, account responses, or project state.
        if (behavior.create === "ambiguous")
          throw new Error("synthetic_response_lost_after_creation");
        return {
          id: repo.id,
          name: behavior.create === "wrong_name" ? "wrong-created-name" : name,
          token: "synthetic-creation-token-never-retain",
        };
      },
      get: async (name: string) => {
        this.call("get", name);
        const current = () => {
          const repo = this.read<FakeRepository>("repo:" + name);
          if (!repo) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
          return repo;
        };
        current();
        return {
          info: async () => {
            this.call("info", name);
            await this.wait("info");
            if (this.behavior().infoError) throw new Error("synthetic_info_failed");
            const repo = current();
            return { id: repo.id, defaultBranch: repo.defaultBranch, name: repo.name };
          },
          log: async (input: unknown) => {
            this.call("log", input);
            await this.wait("log");
            if (this.behavior().logError) throw new Error("synthetic_log_failed");
            if (this.behavior().emptyHeadNotFound)
              throw Object.assign(new Error("NOT_FOUND: empty main"), { code: "NOT_FOUND" });
            return [];
          },
          listTokens: async () => {
            this.call("tokens", name);
            await this.wait("tokens");
            const tokens = current().tokens;
            return { total: tokens.length, tokens };
          },
          revokeToken: async (id: string) => {
            this.call("revoke", { name, id });
            await this.wait("revoke");
            if (this.behavior().revokeFailure) return false;
            const repo = current();
            const token = repo.tokens.find((entry) => entry.id === id);
            if (!token) return false;
            token.state = "revoked";
            this.write("repo:" + name, repo);
            return true;
          },
          [Symbol.dispose]() {},
        };
      },
      import: async () => {
        this.call("import");
        throw new Error("unexpected_import");
      },
      delete: async () => {
        this.call("delete");
        throw new Error("unexpected_delete");
      },
    } as unknown as Artifacts;
  }
  private read<T>(key: string): T | undefined {
    const row = [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        "SELECT value FROM creation_fixture WHERE key=?",
        key,
      ),
    ][0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private write(key: string, value: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO creation_fixture VALUES(?,?)",
      key,
      JSON.stringify(value),
    );
  }
  private behavior() {
    return this.read<Behavior>("behavior") ?? {};
  }
  configure(behavior: Behavior) {
    this.write("behavior", behavior);
  }
  private applyApproval(actor?: string, name?: string) {
    const env = this.env as typeof this.env & {
      CREATE_ACCOUNT_ACTOR?: string;
      CREATE_REPOSITORY_NAME?: string;
    };
    env.CREATE_ACCOUNT_ACTOR = actor;
    env.CREATE_REPOSITORY_NAME = name;
  }
  approve(actor?: string, name = "approved-new-repo") {
    this.write("approval", { actor, name });
    this.applyApproval(actor, name);
  }
  physicalRepository(name: string, id = "external-immutable-id") {
    this.write("repo:" + name, {
      id,
      name,
      readOnly: false,
      defaultBranch: "main",
      tokens: [],
    } satisfies FakeRepository);
  }
  replaceRepositoryId(name: string, id: string) {
    const repo = this.read<FakeRepository>("repo:" + name)!;
    this.write("repo:" + name, { ...repo, id });
  }
  replaceRepositoryWithToken(name: string, id: string) {
    this.write("repo:" + name, {
      id,
      name,
      readOnly: false,
      defaultBranch: "main",
      tokens: [{ id: "replacement-sole-credential", state: "active" }],
    } satisfies FakeRepository);
  }
  repositories() {
    return [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        "SELECT value FROM creation_fixture WHERE key LIKE 'repo:%' ORDER BY key",
      ),
    ].map((row) => JSON.parse(row.value) as FakeRepository);
  }
  private call(operation: string, input?: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT INTO password_calls VALUES(?)",
      operation + (input === undefined ? "" : ":" + JSON.stringify(input)),
    );
  }
  pause(stage: string) {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.paused = { stage, entered: false, release, wait };
  }
  pauseEntered() {
    return this.paused?.entered ?? false;
  }
  releaseTransport() {
    this.paused?.release();
    this.paused = undefined;
  }
  private async wait(stage: string) {
    if (this.paused?.stage === stage) {
      this.paused.entered = true;
      await this.paused.wait;
    }
  }
  storedState() {
    return structuredClone(this.getCoordinator().state);
  }
  removeSeededProject(id: string) {
    this.getCoordinator().updateCollaboration((state) => {
      delete state.ownedProjects?.[id];
    });
  }
  lifecycleRows() {
    if (
      ![
        ...this.ctx.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='repository_lifecycle'",
        ),
      ].length
    )
      return [];
    return [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        "SELECT value FROM repository_lifecycle ORDER BY name",
      ),
    ].map((row) => JSON.parse(row.value));
  }
}
export default backend;
