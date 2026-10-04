import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { RunEvidence, Event, SubmitResult } from "@pitcrew/protocol";
it("redelivers a committed RepositoryAgent result after lost child acknowledgement and restart", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/delivery-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "node-path",
        setup(build) {
          build.onResolve({ filter: /^path$/ }, () => ({
            path: "path",
            namespace: "node-builtins",
          }));
          build.onLoad({ filter: /.*/, namespace: "node-builtins" }, () => ({
            contents: "export * from 'node:path';",
          }));
        },
      },
    ],
  });
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ENVIRONMENT: "development",
      EXECUTION_MODE: "cloud",
      FIXTURE_IDENTITY: "lilfrogdev",
      MODEL_CONFIGURATION: '{"provider":"fake"}',
      PROJECT_BASE_SHA: "a".repeat(40),
      CONFIGURATION_REVISION: "fixture-1",
      ARTIFACT_REPOSITORY: "fixture-artifact",
      PAUSE_ACK: "1",
    },
    durableObjects: {
      REPOSITORY: { className: "DeliveryRepositoryAgent", useSQLite: true },
      CHANGE: { className: "DeliveryChangeAgent", useSQLite: true },
    },
    resourcePersistencePath: `/tmp/pitcrew-delivery-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const get = async <T>(path: string) =>
    (await (await mf.dispatchFetch(`http://localhost${path}`)).json()) as T;
  const post = (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  type Delivery = {
    effects: number;
    ack_attempts: number;
    acknowledged: number;
    observed_commit: number;
  };
  const waitForDelivery = async (runId: string, accepted: (delivery: Delivery) => boolean) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const delivery = await get<Delivery>(`/fixture/delivery?runId=${runId}`);
      if (delivery && accepted(delivery)) return delivery;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error("delivery_fixture_timeout");
  };
  try {
    const threadResponse = await post("/projects/pitcrew/threads", {
      title: "fixture delivery",
      idempotencyKey: "thread",
    });
    expect(threadResponse.status).toBe(201);
    const thread = (await threadResponse.json()) as { id: string };
    const submission = await post(`/threads/${thread.id}/messages`, {
      content: "fixture change",
      idempotencyKey: "message",
    });
    expect(submission.status).toBe(201);
    const { run } = (await submission.json()) as SubmitResult;
    const pending = await waitForDelivery(run.id, (delivery) => delivery.ack_attempts > 0);
    expect(pending).toMatchObject({ effects: 1, acknowledged: 0, observed_commit: 1 });
    const committed = await get<RunEvidence>(`/api/runs/${run.id}/evidence`);
    const events = await get<Event[]>("/api/projects/pitcrew/events");
    expect(committed.run.status).toBe("awaiting_review");
    expect(committed.reviews).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.awaiting_review")).toHaveLength(1);
    expect(events.filter((event) => event.type === "review.created")).toHaveLength(1);
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        script: options.script + "\n// lost acknowledgement restart",
      }),
    );
    const resumed = await waitForDelivery(
      run.id,
      (delivery) => delivery.ack_attempts > pending.ack_attempts,
    );
    expect(resumed).toMatchObject({ effects: 1, acknowledged: 0, observed_commit: 1 });
    expect(await get<RunEvidence>(`/api/runs/${run.id}/evidence`)).toEqual(committed);
    expect(await get<Event[]>("/api/projects/pitcrew/events")).toEqual(events);
    const { PAUSE_ACK: _pause, ...bindings } = options.bindings;
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings,
        script: options.script + "\n// acknowledgement released",
      }),
    );
    const acknowledged = await waitForDelivery(run.id, (delivery) => delivery.acknowledged === 1);
    expect(acknowledged).toMatchObject({ effects: 1, observed_commit: 1 });
    expect(await get<RunEvidence>(`/api/runs/${run.id}/evidence`)).toEqual(committed);
    expect(await get<Event[]>("/api/projects/pitcrew/events")).toEqual(events);
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings,
        script: options.script + "\n// accepted delivery restart",
      }),
    );
    const recovered = await waitForDelivery(run.id, (delivery) => delivery.acknowledged === 1);
    expect(recovered).toMatchObject({ effects: 1, observed_commit: 1 });
    expect(await get<RunEvidence>(`/api/runs/${run.id}/evidence`)).toEqual(committed);
    expect(await get<Event[]>("/api/projects/pitcrew/events")).toEqual(events);
  } finally {
    await mf.dispose();
  }
}, 25000);
