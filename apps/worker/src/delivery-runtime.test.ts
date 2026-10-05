import { localHeaders } from "../test/local-session";
import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { RunEvidence, Event, SubmitResult } from "@pitcrew/protocol";
async function fixtureOptions() {
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
  return {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ENVIRONMENT: "development",
      EXECUTION_MODE: "cloud",
      INFRASTRUCTURE_ADMISSION_ENABLED: "true",
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
}
it("denies disabled infrastructure before activating the child lifecycle", async () => {
  const base = await fixtureOptions();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      ...base,
      bindings: { ...base.bindings, INFRASTRUCTURE_ADMISSION_ENABLED: "false" },
    }),
  );
  const post = async (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: await localHeaders(mf),
      body: JSON.stringify(body),
    });
  try {
    const thread = (await (
      await post("/projects/pitcrew/threads", { title: "Denied", idempotencyKey: "denied-thread" })
    ).json()) as { id: string };
    const submission = (await (
      await post(`/threads/${thread.id}/messages`, {
        content: "Denied change",
        idempotencyKey: "denied-message",
      })
    ).json()) as SubmitResult;
    let status: string | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const evidence = (await (
        await mf.dispatchFetch(`http://localhost/api/runs/${submission.run.id}/evidence`)
      ).json()) as RunEvidence;
      status = evidence.run.status;
      if (status === "waiting_user") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe("waiting_user");
    expect(await (await mf.dispatchFetch("http://localhost/fixture/activations")).json()).toBe(0);
  } finally {
    await mf.dispose();
  }
}, 15000);
it("redelivers a committed RepositoryAgent result after lost child acknowledgement and restart", async () => {
  const options = await fixtureOptions();
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const get = async <T>(path: string) =>
    (await (await mf.dispatchFetch(`http://localhost${path}`)).json()) as T;
  const post = async (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: await localHeaders(mf),
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

for (const [reason, overrides] of [
  ["configuration_mismatch", { CHILD_REVISION: "changed" }],
  ["execution_not_configured", {}],
] as const) {
  it(`quarantines terminal child preflight ${reason} without retrying on restart`, async () => {
    const source = await fixtureOptions();
    const options = {
      ...source,
      bindings: { ...source.bindings, ...overrides },
      durableObjects: {
        ...source.durableObjects,
        CHANGE: { className: "PreflightChangeAgent", useSQLite: true },
      },
    };
    const mf = new Miniflare(convertV4MiniflareOptions(options));
    try {
      const run = await submitFixture(mf);
      await waitForFixture(mf, run.id, (value) => value.calls > 0);
      await new Promise((resolve) => setTimeout(resolve, 1250));
      const evidence = await readFixture<RunEvidence>(mf, `/api/runs/${run.id}/evidence`);
      expect(evidence.run).toMatchObject({
        status: "waiting_user",
        error: "reconciliation_required",
      });
      const child = await readFixture<{ calls: number; pipeline: unknown }>(
        mf,
        `/fixture/delivery?runId=${run.id}`,
      );
      expect(child).toEqual({ calls: 1, pipeline: null });
      expect(evidence.reviews).toEqual([]);
      await mf.setOptions(
        convertV4MiniflareOptions({
          ...options,
          script: options.script + "\n// terminal preflight restart",
        }),
      );
      await readFixture(mf, `/api/runs/${run.id}/evidence`);
      await new Promise((resolve) => setTimeout(resolve, 1250));
      expect(await readFixture(mf, `/fixture/delivery?runId=${run.id}`)).toEqual(child);
      expect(await readFixture(mf, `/api/runs/${run.id}/evidence`)).toEqual(evidence);
    } finally {
      await mf.dispose();
    }
  }, 15000);
}
for (const message of ["fixture_transport_unavailable", "configuration_mismatch"]) {
  it(`retries a thrown start error ${message} and recovers a single durable result`, async () => {
    const source = await fixtureOptions();
    const { PAUSE_ACK: _pause, ...bindings } = source.bindings;
    const mf = new Miniflare(
      convertV4MiniflareOptions({ ...source, bindings: { ...bindings, FAIL_START_ONCE: message } }),
    );
    try {
      const run = await submitFixture(mf);
      const child = await waitForFixture(mf, run.id, (value) => value.acknowledged === 1);
      expect(child).toMatchObject({ effects: 1, acknowledged: 1, observed_commit: 1 });
      expect(child.calls).toBeGreaterThan(1);
      const evidence = await readFixture<RunEvidence>(mf, `/api/runs/${run.id}/evidence`);
      expect(evidence.run.status).toBe("awaiting_review");
      expect(evidence.reviews).toHaveLength(1);
    } finally {
      await mf.dispose();
    }
  }, 15000);
}
async function readFixture<T>(mf: Miniflare, path: string): Promise<T> {
  return (await (await mf.dispatchFetch(`http://localhost${path}`)).json()) as T;
}
async function submitFixture(mf: Miniflare) {
  const post = async <T>(path: string, body: unknown) => {
    const response = await mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: await localHeaders(mf),
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as T;
  };
  const thread = await post<{ id: string }>("/projects/pitcrew/threads", {
    title: "preflight",
    idempotencyKey: "thread",
  });
  return (
    await post<SubmitResult>(`/threads/${thread.id}/messages`, {
      content: "fixture",
      idempotencyKey: "message",
    })
  ).run;
}
async function waitForFixture(
  mf: Miniflare,
  runId: string,
  accepted: (value: { calls: number; acknowledged: number }) => boolean,
) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await readFixture<{ calls: number; acknowledged: number }>(
      mf,
      `/fixture/delivery?runId=${runId}`,
    );
    if (value && accepted(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("fixture_timeout");
}
