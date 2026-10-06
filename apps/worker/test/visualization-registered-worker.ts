import backend, { RepositoryAgent } from "../src/index";
import { visualizationRpcTools } from "../src/visualization-tools";
// Only this test class holds job dispatch and invokes the real registered tool
// without a model. Production has no fixture RPCs or this override.
export class RegisteredVisualizationFixture extends RepositoryAgent {
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof RepositoryAgent>[1]) {
    super(ctx, {
      ...env,
      EMAIL: {
        async send(message) {
          const mail = message as EmailMessageBuilder;
          await env
            .AUTH_DB!.prepare("INSERT INTO test_mail(recipient,body) VALUES(?,?)")
            .bind(mail.to, mail.text)
            .run();
          return { messageId: "fixture-mail" };
        },
      },
    });
  }
  protected async enqueueConversation(_id: string) {}
  async tool(turnId: string, callId: string, content: unknown) {
    try {
      this.getCoordinator().beginConversation(turnId);
      const tool = visualizationRpcTools((invocationId, value) =>
        this.publishConversationVisualization(turnId, invocationId, value),
      ).tools[0];
      return await tool.execute({ content }, { callId } as never, {} as never);
    } catch (error) {
      return { denied: true, code: error instanceof Error ? error.message : "denied" };
    }
  }
  finish(turnId: string) {
    this.getCoordinator().completeConversation(turnId, "Fixture answer");
  }
}
export default backend;
