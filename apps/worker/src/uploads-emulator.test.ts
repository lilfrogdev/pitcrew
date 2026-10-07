import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vite-plus/test";
it("persists exact upload bytes, links atomically, scopes owners/threads, survives restart and cleans stages", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/uploads-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
  });
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { UPLOAD: { className: "UploadFixture", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-uploads-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  // Drain native emulator responses before restart/disposal; retain detached bytes
  // for assertions without leaving its keep-alive streams open.
  const drain = async (response: Awaited<ReturnType<Miniflare["dispatchFetch"]>>) =>
    new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    actor = "alice",
    conversation = false,
  ) =>
    mf
      .dispatchFetch(`http://localhost${path}`, {
        method,
        headers: {
          "x-test-actor": actor,
          ...(conversation ? { "x-test-conversation": "true" } : {}),
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      .then(drain);
  const put = (
    thread: string,
    id: string,
    bytes: Uint8Array,
    name = "synthetic.bin",
    actor = "alice",
  ) =>
    mf
      .dispatchFetch(`http://localhost/api/threads/${thread}/uploads/${id}`, {
        method: "PUT",
        headers: {
          "x-test-actor": actor,
          "content-type": "application/octet-stream",
          "x-pitcrew-filename": encodeURIComponent(name),
        },
        body: bytes,
      })
      .then(drain);
  try {
    const thread = (await (
      await request("/api/projects/pitcrew/threads", "POST", {
        title: "Synthetic",
        idempotencyKey: "thread",
      })
    ).json()) as any;
    const other = (await (
      await request("/api/projects/pitcrew/threads", "POST", {
        title: "Other",
        idempotencyKey: "other",
      })
    ).json()) as any;
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(1024 * 1024 + 123);
    bytes.fill(73);
    bytes[0] = 0;
    bytes[bytes.length - 1] = 255;
    expect((await put(thread.id, id, bytes)).status).toBe(201);
    expect((await put(thread.id, id, bytes)).status).toBe(201);
    expect((await request(`/api/threads/${thread.id}/attachments/${id}`)).status).toBe(404);
    expect((await request(`/api/threads/${other.id}/uploads/${id}`)).status).toBe(404);
    expect(
      (await request(`/api/threads/${thread.id}/uploads/${id}`, "GET", undefined, "bob")).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/threads/${thread.id}/messages`, "POST", {
          content: "reject",
          idempotencyKey: "forge",
          attachments: [{ kind: "file", attachmentId: id }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/threads/${other.id}/messages`, "POST", {
          content: "reject",
          idempotencyKey: "wrong",
          attachments: [{ uploadId: id }],
        })
      ).status,
    ).toBe(404);
    const body = {
      content: "Synthetic bytes only",
      idempotencyKey: "send",
      attachments: [{ uploadId: id, modelInput: "storage" }],
    };
    const message = await request(`/api/threads/${thread.id}/messages`, "POST", body);
    expect(message.status).toBe(201);
    expect((await request(`/api/threads/${thread.id}/messages`, "POST", body)).status).toBe(201);
    expect((await request(`/api/threads/${thread.id}/uploads/${id}`, "DELETE")).status).toBe(404);
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        script: bundle.outputFiles[0].text + "\n// restart",
      }),
    );
    const downloaded = await request(`/api/threads/${thread.id}/attachments/${id}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain("attachment;");
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    const cancelled = crypto.randomUUID();
    expect((await request(`/api/threads/${thread.id}/uploads/${cancelled}`, "DELETE")).status).toBe(
      200,
    );
    expect((await put(thread.id, cancelled, new Uint8Array([1]))).status).toBe(409);
    expect((await request(`/api/threads/${thread.id}/uploads/${cancelled}`, "DELETE")).status).toBe(
      200,
    );
    const staged = crypto.randomUUID();
    expect((await put(thread.id, staged, new Uint8Array([1]))).status).toBe(201);
    const rollback = crypto.randomUUID();
    expect((await put(thread.id, rollback, new Uint8Array([8, 9]))).status).toBe(201);
    await request("/test/fail-next-send", "POST");
    const rollbackBody = {
      content: "Atomic synthetic failure",
      idempotencyKey: "rollback",
      attachments: [{ uploadId: rollback, modelInput: "storage" }],
    };
    expect((await request(`/api/threads/${thread.id}/messages`, "POST", rollbackBody)).status).toBe(
      500,
    );
    expect((await request(`/api/threads/${thread.id}/uploads/${rollback}`)).status).toBe(200);
    expect((await request(`/api/threads/${thread.id}/attachments/${rollback}`)).status).toBe(404);
    expect((await request(`/api/threads/${thread.id}/messages`, "POST", rollbackBody)).status).toBe(
      201,
    );
    expect(
      new Uint8Array(
        await (await request(`/api/threads/${thread.id}/attachments/${rollback}`)).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array([8, 9]));
    expect(
      (await put(thread.id, crypto.randomUUID(), new Uint8Array([1]), "../secret.txt")).status,
    ).toBe(400);
    expect(
      (await put(thread.id, crypto.randomUUID(), new Uint8Array(8 * 1024 * 1024 + 1))).status,
    ).toBe(413);
    await request("/test/expire", "POST");
    expect((await request(`/api/threads/${thread.id}/uploads/${staged}`)).status).toBe(404);
    expect((await request(`/api/threads/${thread.id}/attachments/${id}`)).status).toBe(200);
    await request("/test/revoke", "POST");
    expect((await request(`/api/threads/${thread.id}/attachments/${id}`)).status).toBe(401);
    expect((await put(thread.id, crypto.randomUUID(), new Uint8Array([1]))).status).toBe(401);
  } finally {
    await mf.dispose();
  }
}, 60000);
