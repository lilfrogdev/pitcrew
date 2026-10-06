import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { readFile, readdir } from "node:fs/promises";
it("registered JWT/Better Auth/thread/tool/RPC/read path enforces session and membership revocation", async () => {
  const base = "https://fixture.pitcrew.test",
    issuer = "https://visualizations.cloudflareaccess.com",
    emails = ["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"];
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    jwk = await exportJWK(publicKey);
  const tokens = await Promise.all(
    [...emails, "outsider@example.com"].map((email, i) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject(`viewer-${i}`)
        .setIssuer(issuer)
        .setAudience("visualizations")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(privateKey),
    ),
  );
  const bundle = await build({
    entryPoints: [new URL("../test/visualization-registered-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    alias: { path: "node:path" },
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      telemetry: { enabled: false },
      cf: false,
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-03",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { AUTH_DB: "fixture-visualization-auth" },
      durableObjects: {
        REPOSITORY: { className: "RegisteredVisualizationFixture", useSQLite: true },
        CONVERSATION: { className: "RegisteredVisualizationFixture", useSQLite: true },
      },
      bindings: {
        AUTH_MODE: "better-auth",
        BETTER_AUTH_URL: base,
        BETTER_AUTH_SECRET: "synthetic-visualization-auth-secret-never-live-123456",
        AUTH_EMAIL_FROM: "auth@fixture.example",
        ENVIRONMENT: "production",
        EXECUTION_MODE: "fake",
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: "visualizations",
        ACCESS_HOSTNAME: "fixture.pitcrew.test",
        ACCESS_EMAIL: emails[0],
        ACCESS_EMAILS: JSON.stringify(emails),
      },
      outboundService: (request: Request) => {
        if (request.url !== `${issuer}/cdn-cgi/access/certs`)
          throw Error("unexpected_external_request");
        return Response.json({ keys: [jwk] });
      },
    }),
  );
  const db = await mf.getD1Database("AUTH_DB"),
    cookies = new Map<number, string>();
  const request = (path: string, viewer = 0, method = "GET", body?: unknown) =>
    mf.dispatchFetch(base + path, {
      method,
      headers: {
        "cf-access-jwt-assertion": tokens[viewer],
        origin: base,
        ...(cookies.get(viewer) ? { cookie: cookies.get(viewer)! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const password = "synthetic-visualization-password-only";
  const login = async (viewer: number) => {
    const result = await request("/api/auth/sign-in/email", viewer, "POST", {
      email: emails[viewer],
      password,
    });
    expect(result.status).toBe(200);
    cookies.set(
      viewer,
      result.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0])
        .join("; "),
    );
  };
  try {
    for (const file of (await readdir(new URL("../migrations/auth", import.meta.url)))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const source = await readFile(new URL(`../migrations/auth/${file}`, import.meta.url), "utf8");
      for (const sql of source
        .split(";")
        .map((s) => s.replace(/--> statement-breakpoint/g, "").trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    }
    await db.prepare("CREATE TABLE test_mail(recipient TEXT,body TEXT)").run();
    expect((await request("/api/projects/pitcrew/threads/unknown/visualizations")).status).toBe(
      401,
    );
    for (let viewer = 0; viewer < 2; viewer++) {
      expect(
        (
          await request("/api/auth/sign-up/email", viewer, "POST", {
            email: emails[viewer],
            name: `Viewer ${viewer}`,
            username: `viewer${viewer}`,
            password,
          })
        ).status,
      ).toBe(200);
      const mail = await db
        .prepare("SELECT body FROM test_mail WHERE recipient=? ORDER BY rowid DESC LIMIT 1")
        .bind(emails[viewer])
        .first<{ body: string }>();
      const token = new URL(mail!.body.slice(mail!.body.indexOf("http://"))).hash.slice(
        "#token=".length,
      );
      expect((await request(`/api/auth/verify-email?token=${token}`, viewer)).status).toBe(200);
      await login(viewer);
    }
    const threadResponse = await request("/api/projects/pitcrew/threads", 0, "POST", {
      title: "Private visual reply",
      idempotencyKey: "thread",
    });
    expect(threadResponse.status).toBe(201);
    const thread = (await threadResponse.json()) as { id: string },
      path = `/api/projects/pitcrew/threads/${thread.id}/visualizations`;
    const queued = await request(`/api/threads/${thread.id}/messages`, 0, "POST", {
      content: "Show a chart",
      idempotencyKey: "message",
    });
    expect(queued.status).toBe(201);
    const turn = ((await queued.json()) as { turn: { id: string } }).turn;
    const ns = await mf.getDurableObjectNamespace("REPOSITORY"),
      stub = ns.get(ns.idFromName("pitcrew")) as unknown as {
        tool(
          turn: string,
          call: string,
          content: unknown,
        ): Promise<{ content: { text: string }[] }>;
        finish(turn: string): Promise<void>;
      };
    const content = {
      kind: "bars",
      title: "Private chart",
      summary: "Private fallback",
      height: 320,
      points: [{ label: "A", value: 1 }],
    };
    const tool = await stub.tool(turn.id, "sdk-call", content),
      receipt = JSON.parse(tool.content[0].text);
    expect(receipt).toMatchObject({
      turnId: turn.id,
      invocationId: "sdk-call",
      threadId: thread.id,
      repositoryId: "pitcrew",
    });
    expect(await stub.tool(turn.id, "sdk-call", content)).toEqual(tool);
    const read = await request(path);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      artifacts: [{ id: receipt.id, turnId: turn.id, invocationId: "sdk-call" }],
    });
    expect((await request(path, 0, "POST", { content, key: "manual" })).status).toBe(405);
    expect((await request(path, 1)).status).toBe(404);
    expect((await request(path, 2)).status).toBe(403);
    const projectInvite = (await (
      await request("/api/projects/pitcrew/invitations", 0, "POST", {
        email: emails[1],
        role: "editor",
      })
    ).json()) as { token: string };
    expect(
      (await request(`/api/invitations/${projectInvite.token}/accept`, 1, "POST", {})).status,
    ).toBe(200);
    expect((await request(path, 1)).status).toBe(404);
    const invite = (await (
      await request(`/api/threads/${thread.id}/invitations`, 0, "POST", {
        email: emails[1],
        role: "editor",
      })
    ).json()) as { token: string };
    expect((await request(`/api/invitations/${invite.token}/accept`, 1, "POST", {})).status).toBe(
      200,
    );
    expect((await request(path, 1)).status).toBe(200);
    await stub.finish(turn.id);
    expect(await stub.tool(turn.id, "completed-turn", content)).toMatchObject({ denied: true });
    const colleagueQueued = await request(`/api/threads/${thread.id}/messages`, 1, "POST", {
      content: "Show another chart",
      idempotencyKey: "colleague-message",
    });
    expect(colleagueQueued.status).toBe(201);
    const colleagueTurn = ((await colleagueQueued.json()) as { turn: { id: string } }).turn;
    expect((await stub.tool(colleagueTurn.id, "colleague-call", content)).content).toBeDefined();
    const colleague = (await (await request("/api/account", 1)).json()) as { actor: string };
    expect(
      (
        await request(
          `/api/threads/${thread.id}/members/${encodeURIComponent(colleague.actor)}`,
          0,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await request(path, 1)).status).toBe(404);
    expect(await stub.tool(colleagueTurn.id, "after-member-removal", content)).toMatchObject({
      denied: true,
    });
    await stub.finish(colleagueTurn.id);
    const revocationQueued = await request(`/api/threads/${thread.id}/messages`, 0, "POST", {
      content: "Check revocation",
      idempotencyKey: "revocation-message",
    });
    expect(revocationQueued.status).toBe(201);
    const revocationTurn = ((await revocationQueued.json()) as { turn: { id: string } }).turn;
    expect((await stub.tool(revocationTurn.id, "before-signout", content)).content).toBeDefined();
    expect(
      await stub.tool(turn.id, "spoof", { ...content, threadId: "other", actor: colleague.actor }),
    ).toMatchObject({ denied: true });
    expect((await request("/api/auth/sign-out", 0, "POST", {})).status).toBe(200);
    expect(await stub.tool(revocationTurn.id, "after-signout", content)).toMatchObject({
      denied: true,
      code: "visualization_session_revoked",
    });
    expect((await request(path)).status).toBe(401);
    await login(0);
    expect(await stub.tool(revocationTurn.id, "replacement-session", content)).toMatchObject({
      denied: true,
      code: "visualization_session_revoked",
    });
    // Existing artifacts remain available to a newly verified same-account session,
    // while old admitted publisher authority cannot be revived by signing in again.
    expect((await request(path)).status).toBe(200);
    await stub.finish(turn.id);
    expect(await stub.tool(turn.id, "completed-turn", content)).toMatchObject({ denied: true });
  } finally {
    await mf.dispose();
  }
}, 30000);
