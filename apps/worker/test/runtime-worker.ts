import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Harness, createRegistry, defineTool } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { DurableJobs } from "../src/durable-jobs";
import { DurableChangePipeline, type PipelineState } from "../src/durable-pipeline";
import { applyChange } from "../src/pi-drivers";
import { configureModels } from "../src/pi-models";
const base = "a".repeat(40),
  candidate = "b".repeat(40);
interface Env {
  PAUSE_STAGE?: string;
  FIXTURE: DurableObjectNamespace<FixtureAgent>;
}
export class FixtureAgent extends Agent<Env> {
  readonly registry = createRegistry();
  readonly harness: PiHarness;
  readonly pipeline: DurableChangePipeline;
  readonly jobs: DurableJobs;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this
      .sql`CREATE TABLE IF NOT EXISTS fixture_state(id INTEGER PRIMARY KEY,value TEXT NOT NULL)`;
    void this
      .sql`CREATE TABLE IF NOT EXISTS fixture_edit(id INTEGER PRIMARY KEY,content TEXT NOT NULL,calls INTEGER NOT NULL)`;
    const faux = fauxProvider({ provider: "fixture", models: [{ id: "fixture" }] });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write_fixture", { content: "changed" }, { id: "fixture-write" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("committed fixture"),
    ]);
    const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
    this.registry.install({
      name: "fixture-worker",
      tools: [
        defineTool({
          name: "write_fixture",
          description: "Write fake sandbox source",
          parameters: Type.Object({ content: Type.String() }),
          replay: "unsafe",
          execute: async ({ content }) => {
            void this
              .sql`INSERT INTO fixture_edit VALUES(1,${content},1) ON CONFLICT(id) DO UPDATE SET content=excluded.content,calls=calls+1`;
            return { content: [{ type: "text", text: "written" }] };
          },
        }),
      ],
    });
    this.harness = new PiHarness({
      harness: ({ storage, context }) =>
        Harness.open(storage, { models, registry: this.registry }, context),
      defaults: { model },
    });
    this.lifecycle.use(this.harness);
    this.pipeline = new DurableChangePipeline({
      read: () => {
        const [row] = this.sql<{ value: string }>`SELECT value FROM fixture_state WHERE id=1`;
        return row ? (JSON.parse(row.value) as PipelineState) : undefined;
      },
      write: (state) => {
        void this
          .sql`INSERT INTO fixture_state VALUES(1,${JSON.stringify(state)}) ON CONFLICT(id) DO UPDATE SET value=excluded.value`;
      },
    });
    this.jobs = new DurableJobs(
      "fixture-pipeline",
      async (jobs) => {
        const s = this.pipeline.status();
        if (s && !["done", "blocked"].includes(s.stage)) await jobs.enqueue("pipeline", {});
      },
      async () => {
        if (this.env.PAUSE_STAGE === this.pipeline.status()?.stage)
          return { rescheduleAt: Date.now() + 1000 };
        const transport = {
          async prepare() {},
          async run() {
            return {
              status: "completed" as const,
              exitCode: 0,
              stdout: "fixture test passed",
              stderr: "",
              truncated: false,
            };
          },
          inspect: async () => ({
            sha: this.sql`SELECT id FROM fixture_edit`.length ? candidate : base,
            clean: true,
          }),
          async readFile() {
            return "changed";
          },
          async writeFile() {},
          async publish() {},
          async stop() {},
        };
        await this.pipeline.advance({
          prepare: async (input) => ({
            ...input,
            artifactId: "fixture-fork",
            workerId: "fixture-worker",
          }),
          change: async (workspace, input) => {
            const signal = AbortSignal.timeout(100);
            try {
              return await applyChange(this.harness, transport, workspace, input, signal);
            } catch (error) {
              if (signal.aborted) return undefined;
              throw error;
            }
          },
          publish: async () => {},
          test: async (workspace) => ({
            runId: workspace.runId,
            commandId: "fixture-test",
            baseSha: base,
            candidateSha: candidate,
            configurationRevision: "fixture-1",
            argv: ["fixture-test"],
            status: "completed",
            exitCode: 0,
            stdout: "passed",
            stderr: "",
            truncated: false,
          }),
          review: async () => ({
            baseSha: base,
            candidateSha: candidate,
            configurationRevision: "fixture-1",
            decision: "approve",
            actor: "fixture-reviewer",
            summary: "checked fixture",
          }),
          stop: async () => {},
        });
        return this.pipeline.status()?.stage === "done"
          ? undefined
          : { rescheduleAt: Date.now() + 50 };
      },
    );
    this.lifecycle.use(this.jobs);
  }
  async start() {
    await this.lifecycle.start();
    this.pipeline.start({
      runId: "fixture-run",
      threadId: "fixture-thread",
      projectId: "fixture-project",
      repository: "fixture-artifact",
      baseSha: base,
      configurationRevision: "fixture-1",
      messages: [],
    });
    await this.jobs.enqueue("pipeline", {});
    return { accepted: true };
  }
  async status() {
    await this.lifecycle.start();
    return {
      pipeline: this.pipeline.status(),
      edits: this.sql`SELECT content,calls FROM fixture_edit`,
    };
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const stub = env.FIXTURE.get(env.FIXTURE.idFromName("fixture"));
    return Response.json(
      new URL(request.url).pathname === "/start" ? await stub.start() : await stub.status(),
    );
  },
};
