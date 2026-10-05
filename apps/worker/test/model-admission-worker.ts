import { getAgentByName } from "agents";
import { ChangeAgent, ReviewAgent, type PiEnv, type TaskAdmission } from "../src/pi-agents";
import { resolveCatalog, resolveRunModels } from "../src/model-selection";
const context = {
  abortSignal: new AbortController().signal,
  value: () => undefined,
  toString: () => "synthetic model admission",
};
export class ModelChangeFixture extends ChangeAgent {
  async inspectModel() {
    await this.prompt();
    return (await (await this.harness.pi()).root(context)).agent(context);
  }
}
export class ModelReviewFixture extends ReviewAgent {
  async inspectModel() {
    await this.prompt();
    return (await (await this.harness.pi()).root(context)).agent(context);
  }
}
interface Env extends PiEnv {
  CHANGE: DurableObjectNamespace<ModelChangeFixture>;
  REVIEW: DurableObjectNamespace<ModelReviewFixture>;
}
export default {
  async fetch(request: Request, env: Env) {
    const catalog = resolveCatalog(env);
    const models = resolveRunModels(
      catalog,
      { modelId: "alternate", effort: "high" },
      {
        default: catalog.defaultSelection,
        roles: { reviewer: { modelId: "alternate", effort: "low" } },
      },
    );
    const role = new URL(request.url).pathname === "/review" ? "reviewer" : "implementer";
    const props: TaskAdmission = { runModels: models, role };
    const worker =
      role === "reviewer"
        ? await getAgentByName(env.REVIEW, "selected-review", { props })
        : await getAgentByName(env.CHANGE, "selected-change", { props });
    return Response.json(await worker.inspectModel());
  },
};
