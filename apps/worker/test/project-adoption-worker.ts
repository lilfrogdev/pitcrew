import { PasswordRepositoryFixture, PasswordCredentialsFixture } from "./password-ingress-worker";
import backend from "../src/index";
export { PasswordCredentialsFixture };

/** Only the external repository read transport is synthetic; HTTP/session/DO
 * authority and registration execute the production implementations. */
export class ProjectAdoptionFixture extends PasswordRepositoryFixture {
  private metadataId = "immutable-repository-id";
  private paused?: { stage: string; entered: boolean; release(): void; wait: Promise<void> };
  constructor(
    ctx: DurableObjectState,
    env: ConstructorParameters<typeof PasswordRepositoryFixture>[1],
  ) {
    super(ctx, env);
    this.env.ARTIFACTS = {
      get: async (name: string) => {
        this.ctx.storage.sql.exec("INSERT INTO password_calls VALUES(?)", "get:" + name);
        return {
          info: async () => {
            await this.wait("info");
            return { id: this.metadataId, defaultBranch: "main" };
          },
          log: async (input: { ref: string; limit: number }) => {
            this.ctx.storage.sql.exec(
              "INSERT INTO password_calls VALUES(?)",
              "log:" + JSON.stringify(input),
            );
            await this.wait("log");
            return [{ hash: "2".repeat(40) }];
          },
          [Symbol.dispose]() {},
        };
      },
    } as unknown as Artifacts;
  }
  approve(
    actor?: string,
    name = "approved-existing-repo",
    repositoryId = "immutable-repository-id",
  ) {
    this.env.ADOPT_ACCOUNT_ACTOR = actor;
    this.env.ADOPT_REPOSITORY_NAME = name;
    this.env.ADOPT_REPOSITORY_ID = repositoryId;
  }
  replaceMetadataId(id: string) {
    this.metadataId = id;
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
  releaseMetadata() {
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
}
export default backend;
