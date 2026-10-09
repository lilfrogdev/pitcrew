import backend from "../../src/index";
import type { Coordinator } from "../../src/coordinator";
import { PasswordRepositoryFixture, PasswordCredentialsFixture } from "../password-ingress-worker";
export { PasswordCredentialsFixture };

type FakeRepository = {
  id: string;
  name: string;
  readOnly: boolean;
  defaultBranch: string;
  tokens: { id: string; state: "active" | "revoked" }[];
};
type Behavior = {
  create?: "ambiguous" | "wrong_name" | "error" | "already_exists";
  infoError?: boolean;
  logError?: boolean;
  emptyHeadNotFound?: boolean;
  revokeFailure?: boolean;
  tokenCount?: number;
  deleteFailure?: boolean;
  deleteAmbiguous?: boolean;
  revokeNotFound?: boolean;
};

/** Fake only the external Artifacts transport. Sessions, authority gates, SQL
 * lifecycle records and project registration all use production code. */
export class RepositoryManagementFixture extends PasswordRepositoryFixture {
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
    const adoption = this.read<{ actor: string; name: string; repositoryId: string }>(
      "adoption_approval",
    );
    if (adoption) this.applyAdoption(adoption.actor, adoption.name, adoption.repositoryId);
    this.management(this.read<boolean>("management") ?? false);
    this.deletion(this.read<boolean | "disabled">("deletion_enabled") ?? false);
    const source = this.read<string>("configured_root_source");
    if (source) this.env.ARTIFACT_REPOSITORY = source;
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
        if (behavior.create === "already_exists") {
          this.write("repo:" + name, {
            id: "synthetic-foreign-existing_" + name,
            name,
            readOnly: false,
            defaultBranch: "main",
            tokens: [{ id: "foreign-sole-token", state: "active" }],
          } satisfies FakeRepository);
          throw Object.assign(Error("ALREADY_EXISTS: synthetic physical conflict"), {
            code: "ALREADY_EXISTS",
          });
        }
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
            if (this.behavior().revokeNotFound)
              throw Object.assign(Error("NOT_FOUND: synthetic missing credential"), {
                code: "NOT_FOUND",
              });
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
      delete: async (name: string) => {
        this.call("delete", name);
        await this.wait("delete");
        if (this.behavior().deleteFailure) throw Error("synthetic_delete_failed");
        if (!this.read<FakeRepository>("repo:" + name))
          throw Object.assign(Error("NOT_FOUND"), { code: "NOT_FOUND" });
        this.ctx.storage.sql.exec("DELETE FROM creation_fixture WHERE key=?", "repo:" + name);
        if (this.behavior().deleteAmbiguous) throw Error("synthetic_delete_response_lost");
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
  private applyAdoption(actor: string, name: string, repositoryId: string) {
    this.env.ADOPT_ACCOUNT_ACTOR = actor;
    this.env.ADOPT_REPOSITORY_NAME = name;
    this.env.ADOPT_REPOSITORY_ID = repositoryId;
  }
  approveAdoption(actor: string, name: string, repositoryId: string) {
    this.write("adoption_approval", { actor, name, repositoryId });
    this.applyAdoption(actor, name, repositoryId);
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
  management(enabled = true) {
    (
      this.env as typeof this.env & { ACCOUNT_REPOSITORY_MANAGEMENT?: string }
    ).ACCOUNT_REPOSITORY_MANAGEMENT = enabled ? "enabled" : "disabled";
    this.write("management", enabled);
  }
  deletion(enabled: boolean | "disabled" = false) {
    const env = this.env as typeof this.env & { ACCOUNT_REPOSITORY_DELETE?: string };
    if (enabled === true) env.ACCOUNT_REPOSITORY_DELETE = "enabled";
    else if (enabled === "disabled") env.ACCOUNT_REPOSITORY_DELETE = "disabled";
    else delete env.ACCOUNT_REPOSITORY_DELETE;
    this.write("deletion_enabled", enabled);
  }
  syntheticActiveWork(projectId: string, kind: "run" | "conversation", active: boolean) {
    const coordinator = (
      this as unknown as { projectCoordinator(id: string): Coordinator }
    ).projectCoordinator(projectId);
    coordinator.updateCollaboration((core) => {
      if (kind === "run")
        core.runs = active
          ? [{ id: "synthetic-active-run", status: "running" } as (typeof core.runs)[number]]
          : [];
      else
        core.conversationTurns = active
          ? [
              { id: "synthetic-active-conversation", status: "queued" } as NonNullable<
                typeof core.conversationTurns
              >[number],
            ]
          : [];
    });
  }
  registerAdoptedRepository(name: string, id: string, actor: string, email: string) {
    this.physicalRepository(name, id);
    return this.getCoordinator().addOwnedProject(name, id, actor, email);
  }
  configuredRootSource(name: string, mode: "binding" | "project") {
    if (mode === "binding") {
      this.env.ARTIFACT_REPOSITORY = name;
      this.write("configured_root_source", name);
    } else {
      this.getCoordinator().updateCollaboration((state) => {
        state.project.repository = "artifact:" + name;
      });
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
