import backend, { RepositoryAgent } from "../src/index";
import { visualizationRpcTools } from "../src/visualization-tools";
// Only this test class holds job dispatch and invokes the real registered tool
// without a model. Production has no fixture RPCs or this override.
export class RegisteredVisualizationFixture extends RepositoryAgent {
  private readonly controls: {
    pause?: {
      kind: "publisher" | "read" | "delete";
      skip: number;
      reached: Promise<void>;
      ready(): void;
      released: Promise<void>;
      release(): void;
    };
    failDelete: boolean;
  };
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof RepositoryAgent>[1]) {
    const controls: RegisteredVisualizationFixture["controls"] = { failDelete: false };
    const db = new Proxy(env.AUTH_DB!, {
      get(target, key) {
        if (key === "prepare")
          return (query: string) => {
            if (controls.failDelete && /^delete from ["`]session["`]/i.test(query)) {
              controls.failDelete = false;
              throw Error("synthetic_session_delete_failure");
            }
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(value, method) {
                  if (method === "bind") return (...args: unknown[]) => wrap(value.bind(...args));
                  if (["first", "all", "raw", "run"].includes(String(method)))
                    return async (...args: unknown[]) => {
                      const execute = Reflect.get(value, method);
                      const result = await execute.apply(value, args);
                      const pause = controls.pause;
                      const matches =
                        pause?.kind === "publisher"
                          ? query.startsWith("SELECT s.expires_at AS expiresAt")
                          : pause?.kind === "delete"
                            ? /^delete from ["`]session["`]/i.test(query)
                            : /^select .*from ["`]session["`]/i.test(query);
                      if (pause && matches && pause.skip-- === 0) {
                        pause.ready();
                        await pause.released;
                      }
                      return result;
                    };
                  const property = Reflect.get(value, method);
                  return typeof property === "function" ? property.bind(value) : property;
                },
              });
            return wrap(target.prepare(query));
          };
        const property = Reflect.get(target, key);
        return typeof property === "function" ? property.bind(target) : property;
      },
    });
    super(ctx, {
      ...env,
      AUTH_DB: db,
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
    this.controls = controls;
  }
  armSessionPause(skip: number, kind: "publisher" | "read" | "delete" = "publisher") {
    let ready!: () => void, release!: () => void;
    this.controls.pause = {
      skip,
      kind,
      reached: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      released: new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready: () => ready(),
      release: () => release(),
    };
  }
  async waitForSessionPause() {
    await this.controls.pause!.reached;
  }
  releaseSessionPause() {
    const pause = this.controls.pause!;
    this.controls.pause = undefined;
    pause.release();
  }
  failSessionDelete() {
    this.controls.failDelete = true;
  }
  authorityPending() {
    return this.visualizationAuthority.pending;
  }
  artifactCount() {
    return [
      ...this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM visualization_artifacts",
      ),
    ][0].count;
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
