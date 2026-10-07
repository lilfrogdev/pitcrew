import backend, { RepositoryAgent } from "../src/index";
import { UserCredentials } from "../src/user-credentials-agent";
import { VisualizationStore } from "../src/visualization-store";

export class PasswordRepositoryFixture extends RepositoryAgent {
  private authorityHold?: { release(): void; done: Promise<void> };
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof RepositoryAgent>[1]) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS password_calls(operation TEXT)");
    const forbidden = (operation: string) => async () => {
      ctx.storage.sql.exec("INSERT INTO password_calls VALUES(?)", operation);
      throw Error("unexpected_transport");
    };
    super(ctx, {
      ...env,
      EMAIL: { send: forbidden("email") } as unknown as SendEmail,
      ARTIFACTS: {
        list: forbidden("list"),
        create: forbidden("create"),
        import: forbidden("import"),
        get: forbidden("get"),
        delete: forbidden("delete"),
      } as unknown as Artifacts,
    });
  }
  seedProject(name: string, actor: string, email: string) {
    return this.getCoordinator().addOwnedProject(name, `fixture:${name}`, actor, email);
  }
  seedLegacyBinding() {
    this.getCoordinator().bindVerifiedAccount("access:legacy", "legacy-user", "dev@lilfrogdev.com");
  }
  seedVisualization(repositoryId: string, threadId: string, creatorActor: string) {
    // Trusted fixture setup only. Production exposes no creation HTTP route.
    const store = new VisualizationStore(this.ctx.storage.sql, (work) =>
      this.ctx.storage.transactionSync(work),
    );
    return store.put(
      {
        id: crypto.randomUUID(),
        version: 1,
        repositoryId,
        threadId,
        creatorActor,
        turnId: "fixture-turn",
        invocationId: "fixture-read",
        createdAt: Date.now(),
        revision: 1,
        digest: "1".repeat(64),
        content: {
          kind: "bars",
          title: "Stored account chart",
          summary: "Private account chart",
          height: 320,
          points: [{ label: "A", value: 1 }],
        },
      },
      "fixture-read",
      () => {},
    );
  }
  async holdAuthority() {
    if (this.authorityHold) throw Error("authority_already_held");
    let release!: () => void, entered!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const done = this.visualizationAuthority.run(async () => {
      entered();
      await released;
    });
    this.authorityHold = { release, done };
    await reached;
  }
  releaseAuthority() {
    const held = this.authorityHold!;
    this.authorityHold = undefined;
    held.release();
    return held.done;
  }
  authorityPending() {
    return this.visualizationAuthority.pending;
  }
  snapshot() {
    const state = this.getCoordinator().state;
    const states = [state, ...Object.values(state.ownedProjects ?? {}).map((entry) => entry.state)];
    return {
      runs: states.reduce((count, entry) => count + entry.runs.length, 0),
      turns: states.reduce((count, entry) => count + (entry.conversationTurns?.length ?? 0), 0),
      bindings: state.identityBindings,
      members: state.collaboration?.projectMembers,
      profiles: states.map((entry) => ({
        projectId: entry.project.id,
        projectMembers: entry.collaboration?.projectMembers,
        threadMembers: entry.collaboration?.threadMembers,
      })),
      calls: [
        ...this.ctx.storage.sql.exec<{ operation: string }>("SELECT operation FROM password_calls"),
      ].map((row) => row.operation),
    };
  }
}

export class PasswordCredentialsFixture extends UserCredentials {
  ciphertext() {
    return [
      ...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM credential WHERE id=1"),
    ][0]?.value;
  }
}

export default backend;
