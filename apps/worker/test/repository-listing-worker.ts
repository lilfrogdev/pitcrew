import backend, { RepositoryAgent } from "../src/index";

type Env = ConstructorParameters<typeof RepositoryAgent>[1] & {
  TEST_ARTIFACTS_AVAILABLE?: string;
};

export class RepositoryListingFixture extends RepositoryAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS listing_calls(operation TEXT)");
    const called = (operation: string) =>
      ctx.storage.sql.exec("INSERT INTO listing_calls VALUES(?)", operation);
    const forbidden = (operation: string) => async () => {
      called(operation);
      throw Error("unexpected_repository_mutation");
    };
    const artifacts = {
      list: async (options: { limit: number; cursor?: string }) => {
        called(`list:${options.limit}:${options.cursor ?? ""}`);
        if (options.cursor === "fail") throw Error("SECRET_BINDING_ERROR");
        return {
          repos: [{ name: "existing-repo", id: "private-id", token: "SECRET_MUST_NOT_ESCAPE" }],
          cursor: options.cursor ? undefined : "next-page",
        };
      },
      create: forbidden("create"),
      import: forbidden("import"),
      get: forbidden("get"),
      delete: forbidden("delete"),
    } as unknown as Artifacts;
    super(ctx, {
      ...env,
      ARTIFACTS: env.TEST_ARTIFACTS_AVAILABLE === "true" ? artifacts : undefined,
      EMAIL: env.AUTH_DB ? { async send(message) {
        const msg = message as EmailMessageBuilder;
        await env.AUTH_DB!.prepare("INSERT INTO test_mail(recipient,subject,body) VALUES(?,?,?)")
          .bind(msg.to, msg.subject, msg.text).run();
        return { messageId: "synthetic-mail" };
      } } : undefined,
    });
  }
  calls() {
    return [
      ...this.ctx.storage.sql.exec<{ operation: string }>("SELECT operation FROM listing_calls"),
    ].map((row) => row.operation);
  }
  executionCounts() {
    const state = this.getCoordinator().state;
    return {
      runs: state.runs.length,
      messages: state.messages.length,
      turns: state.conversationTurns?.length ?? 0,
      keys: Object.keys(state.keys).length,
    };
  }
  seedProject(name: string, actor: string, email: string) {
    return this.getCoordinator().addOwnedProject(name, `fixture:${name}`, actor, email);
  }
}

// Exercise the real top-level protected fetch and real RepositoryAgent.onRequest.
export default backend;
