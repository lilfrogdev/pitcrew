import { readRepositoryState, writeRepositoryState } from "../src/repository-state";
import { protectedFetch, type AccessEnv } from "../src/access";
import { RepositoryAgent } from "../src/index";
import { type State } from "../src/coordinator";
import { SqliteLandingStore } from "../../../packages/execution/src/landing-store";
import { assertConfigurationIdle } from "../src/landing-api";
const candidate = "b".repeat(40);
export class LandingFixtureAgent extends RepositoryAgent {
  async seed() {
    const core = this.getCoordinator();
    const thread = core.createThread("fixture intent", "thread");
    const { run } = core.submit(thread.id, "change fixture source", "message");
    core.begin(run.id);
    core.complete(run.id, {
      workerId: "fixture-worker",
      artifactId: "fixture-fork",
      baseSha: run.baseSha,
      candidateSha: candidate,
      summary: "fixture change",
      tests: {
        baseSha: run.baseSha,
        candidateSha: candidate,
        configurationRevision: run.configurationRevision,
        status: "passed",
        argv: ["fixture-test"],
        exitCode: 0,
        stdout: "fake passed",
        stderr: "",
        truncated: false,
      },
      review: {
        baseSha: run.baseSha,
        candidateSha: candidate,
        configurationRevision: run.configurationRevision,
        decision: "approve",
        actor: "fixture-independent-reviewer",
        summary: "fixture reviewed",
      },
    });
    this.ctx.storage.transactionSync(() =>
      writeRepositoryState(this.ctx.storage.sql, JSON.stringify(core.state)),
    );
    return {
      runId: run.id,
      expectedTargetSha: run.baseSha,
      candidateSha: candidate,
      configurationRevision: run.configurationRevision,
      idempotencyKey: "approval",
    };
  }
  async blockAndConfigure(authorizationId: string, runId: string) {
    const store = new SqliteLandingStore(this.ctx.storage);
    store.begin(authorizationId, "lilfrogdev", runId, Date.now());
    try {
      this.ctx.storage.transactionSync(() => {
        const stored = readRepositoryState(this.ctx.storage.sql);
        if (!stored) throw Error("fixture_state_missing");
        const state = JSON.parse(stored) as State,
          previous = structuredClone(state.project);
        state.project.configurationRevision = "changed";
        assertConfigurationIdle(store, previous, state.project);
        writeRepositoryState(this.ctx.storage.sql, JSON.stringify(state));
      });
      return { blocked: false };
    } catch {
      return { blocked: true };
    }
  }
}
export default {
  async fetch(
    request: Request,
    env: AccessEnv & { REPOSITORY: DurableObjectNamespace<LandingFixtureAgent> },
  ) {
    const stub = env.REPOSITORY.get(
      env.REPOSITORY.idFromName(new URL(request.url).searchParams.get("object") ?? "fixture"),
    );
    if (new URL(request.url).pathname === "/__seed") return Response.json(await stub.seed());
    if (new URL(request.url).pathname === "/__block-config") {
      const body = (await request.json()) as { authorizationId: string; runId: string };
      return Response.json(await stub.blockAndConfigure(body.authorizationId, body.runId));
    }
    return protectedFetch(request, env, (request) => stub.fetch(request));
  },
};
