import { UserCredentials } from "../src/user-credentials-agent";
import { userCredential } from "../src/user-credentials";
export { UserCredentials };
import { getAgentByName } from "agents";
import { ChangeAgent, ReviewAgent, type PiEnv, type TaskAdmission } from "../src/pi-agents";
import { resolveCatalog, resolveRunModels } from "../src/model-selection";
const context = {
  abortSignal: new AbortController().signal,
  value: () => undefined,
  toString: () => "synthetic model admission",
};
export class ModelChangeFixture extends ChangeAgent {
  protected async openHarness(
    ...args: Parameters<typeof import("@earendil-works/pi-durable").Harness.open>
  ) {
    if ((this.env as Env).TEST_CREDENTIAL_ACTOR) {
      const auth = await args[1].models.getAuth("openrouter");
      if (!auth?.auth.apiKey) throw Error("provider_credential_unavailable");
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.auth.apiKey)),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS auth_observation(value TEXT NOT NULL)");
      this.ctx.storage.sql.exec("DELETE FROM auth_observation");
      this.ctx.storage.sql.exec("INSERT INTO auth_observation VALUES(?)", digest);
    }
    return super.openHarness(...args);
  }

  async inspectModel() {
    await this.prompt();
    return {
      ...(await (await (await this.harness.pi()).root(context)).agent(context)),
      ...((this.env as Env).TEST_CREDENTIAL_ACTOR
        ? {
            fingerprint: [
              ...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM auth_observation"),
            ][0].value,
          }
        : {}),
    };
  }
}
export class ModelReviewFixture extends ReviewAgent {
  protected async openHarness(
    ...args: Parameters<typeof import("@earendil-works/pi-durable").Harness.open>
  ) {
    if ((this.env as Env).TEST_CREDENTIAL_ACTOR) {
      const auth = await args[1].models.getAuth("openrouter");
      if (!auth?.auth.apiKey) throw Error("provider_credential_unavailable");
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.auth.apiKey)),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS auth_observation(value TEXT NOT NULL)");
      this.ctx.storage.sql.exec("DELETE FROM auth_observation");
      this.ctx.storage.sql.exec("INSERT INTO auth_observation VALUES(?)", digest);
    }
    return super.openHarness(...args);
  }

  async inspectModel() {
    await this.prompt();
    return {
      ...(await (await (await this.harness.pi()).root(context)).agent(context)),
      ...((this.env as Env).TEST_CREDENTIAL_ACTOR
        ? {
            fingerprint: [
              ...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM auth_observation"),
            ][0].value,
          }
        : {}),
    };
  }
}
interface Env extends PiEnv {
  TEST_ADMISSION_DEADLINE: string;
  TEST_CREDENTIAL_ACTOR?: string;
  CHANGE: DurableObjectNamespace<ModelChangeFixture>;
  REVIEW: DurableObjectNamespace<ModelReviewFixture>;
}
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/save") {
      const actor = env.TEST_CREDENTIAL_ACTOR!;
      await userCredential(env, actor).save(actor, "sk-or-v1-synthetic_alice_never_live");
      return Response.json({ ok: true });
    }
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
    const props: TaskAdmission = {
      runModels: models,
      role,
      deadline: Number(env.TEST_ADMISSION_DEADLINE),
      credentialActor: env.TEST_CREDENTIAL_ACTOR,
    };
    const worker =
      role === "reviewer"
        ? await getAgentByName(env.REVIEW, "selected-review", { props })
        : await getAgentByName(env.CHANGE, "selected-change", { props });
    return Response.json(await worker.inspectModel());
  },
};
