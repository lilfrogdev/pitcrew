import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
export class DurableJobs extends LifecycleCapability {
  constructor(
    id: string,
    private recover: (jobs: DurableJobs) => Promise<void>,
    private drive: (payload: unknown) => Promise<LifecycleJobOutcome>,
  ) {
    super(id);
  }
  async onStart() {
    await this.lifecycle.runInHostContext(() => this.recover(this));
  }
  async enqueue(id: string, payload: unknown, time = Date.now()) {
    await this.lifecycle.ready();
    await this.lifecycle.jobs.push({
      id,
      fn: "advance",
      payload,
      time,
      singleflight: true,
      recoveryLoop: true,
      retry: { maxAttempts: 2 },
    });
  }
  async onJob(context: LifecycleJobContext) {
    if (context.job.fn !== "advance") return;
    return (await this.lifecycle.runInHostContext(() =>
      this.drive(context.job.payload),
    )) as LifecycleJobOutcome;
  }
}
