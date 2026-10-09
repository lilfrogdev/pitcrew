import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

it("real scoped Worker isolates enrolled accounts, ACLs and credential namespaces without email or paid transport", async () => {
  const base = "https://fixture.pitcrew.test";
  const issuer = "https://fixture.cloudflareaccess.com";
  const emails = ["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"];
  const password = "synthetic-password-ingress-only";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "password-ingress" };
  const legacyToken = await new SignJWT({ email: emails[0] })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setSubject("legacy")
    .setIssuer(issuer)
    .setAudience("password-ingress")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const outbound: string[] = [];
  const bundle = await build({
    entryPoints: [new URL("../test/password-ingress-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    alias: { path: "node:path" },
  });
  const options = {
    d1Databases: { AUTH_DB: "synthetic-password-ingress" },
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      AUTH_MODE: "password-only",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "synthetic-password-ingress-secret-never-live-123456",
      ENVIRONMENT: "production",
      // Team notes never execute, even while explicit authenticated chat is enabled.
      EXECUTION_MODE: "cloud",
      INFRASTRUCTURE_ADMISSION_ENABLED: "true",
      CLOUD_CONVERSATION_ENABLED: "true",
      REPOSITORY_LIFECYCLE: "enabled",
      TRUSTED_PUBLISHER_ENABLED: "true",
      PROJECT_BASE_SHA: "1".repeat(40),
      CONFIGURATION_REVISION: "password-ingress-fixture",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      MODEL_CONFIGURATION: JSON.stringify({
        provider: "byok",
        providerId: "openrouter",
        model: "qwen/qwen3.8-flash",
        secretBinding: "OPENROUTER_API_KEY",
      }),
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "password-ingress",
      ACCESS_HOSTNAME: "fixture.pitcrew.test",
      ACCESS_EMAIL: emails[0],
      ACCESS_EMAILS: JSON.stringify(emails),
    },
    durableObjects: {
      REPOSITORY: { className: "PasswordRepositoryFixture", useSQLite: true },
      USER_CREDENTIALS: { className: "PasswordCredentialsFixture", useSQLite: true },
    },
    resourcePersistencePath: `/tmp/pitcrew-password-ingress-${crypto.randomUUID()}`,
    outboundService: (request: Request) => {
      outbound.push(request.url);
      if (request.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      throw Error("unexpected_external_transport");
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const db = await mf.getD1Database("AUTH_DB");
  const cookies = new Map<string, string>();
  const request = (
    path: string,
    email = emails[0],
    method = "GET",
    body?: object,
    headers: Record<string, string> = {},
  ) =>
    mf.dispatchFetch(base + path, {
      method,
      headers: {
        origin: base,
        "cf-connecting-ip": email === emails[0] ? "192.0.2.1" : "192.0.2.2",
        ...(cookies.get(email) ? { cookie: cookies.get(email)! } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const app = (
    path: string,
    email = emails[0],
    method = "GET",
    body?: object,
    headers?: Record<string, string>,
  ) => request("/app/api" + path, email, method, body, headers);
  const repoNS = await mf.getDurableObjectNamespace("REPOSITORY");
  let repository = repoNS.get(repoNS.idFromName("pitcrew")) as unknown as {
    seedProject(name: string, actor: string, email: string): Promise<{ id: string }>;
    seedLegacyBinding(): Promise<void>;
    seedVisualization(
      repositoryId: string,
      threadId: string,
      actor: string,
    ): Promise<{ id: string }>;
    holdAuthority(): Promise<void>;
    releaseAuthority(): Promise<void>;
    authorityPending(): Promise<number>;
    snapshot(): Promise<{
      runs: number;
      turns: number;
      bindings: object;
      members: Record<string, unknown>;
      profiles: unknown[];
      calls: string[];
    }>;
  };
  let credentialsNS = await mf.getDurableObjectNamespace("USER_CREDENTIALS");
  const credentials = (actor: string) =>
    credentialsNS.get(credentialsNS.idFromName("openrouter:" + actor)) as unknown as {
      save(actor: string, key: string): Promise<void>;
      read(actor: string): Promise<string>;
      ciphertext(): Promise<string>;
    };
  try {
    for (const file of (await readdir(new URL("../migrations/auth", import.meta.url)))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(`../migrations/auth/${file}`, import.meta.url), "utf8");
      for (const statement of sql
        .split(";")
        .map((s) => s.replace(/--> statement-breakpoint/g, "").trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
    expect((await request("/api/account")).status).toBe(403);
    expect((await app("/projects")).status).toBe(401);
    expect(outbound).toEqual([]);
    // Legacy ingress continues to require the signed Access token.
    expect(
      (
        await request("/api/account", emails[0], "GET", undefined, {
          "cf-access-jwt-assertion": legacyToken,
        })
      ).status,
    ).toBe(200);
    const legacyRequests = outbound.length;
    await repository.seedLegacyBinding();
    const legacyProject = await repository.seedProject(
      "legacy-project",
      "access:legacy",
      emails[0],
    );
    const legacyKey = "sk-or-v1-synthetic_old_access_never_live";
    await credentials("access:legacy").save("access:legacy", legacyKey);
    const legacyCiphertext = await credentials("access:legacy").ciphertext();
    const actors = new Map<string, string>();
    for (const [index, email] of emails.entries()) {
      const code = Buffer.alloc(32, index + 1).toString("base64url");
      await db
        .prepare(
          "INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at) VALUES(?,?,?,?)",
        )
        .bind(
          "grant-" + index,
          email,
          createHash("sha256").update(code).digest("hex"),
          Date.now() + 600000,
        )
        .run();
      const enrollment = await app("/auth/enroll", email, "POST", {
        code,
        password,
        name: "User " + index,
        username: "user_" + index,
        image: "/avatars/frog.svg",
      });
      expect(enrollment.status, await enrollment.clone().text()).toBe(200);
      expect((await app("/auth/sign-in/email", email, "POST", { email, password })).status).toBe(
        404,
      );
      expect(
        (await app("/auth/is-username-available", email, "POST", { username: "user_" + index }))
          .status,
      ).toBe(404);
      const login = await app("/auth/sign-in/username", email, "POST", {
        username: "USER_" + index,
        password,
      });
      expect(login.status, await login.clone().text()).toBe(200);
      cookies.set(
        email,
        login.headers
          .getSetCookie()
          .map((c) => c.split(";", 1)[0])
          .join("; "),
      );
      const account = (await (await app("/account", email)).json()) as {
        actor: string;
        email: string;
        username: string;
        displayName: string;
      };
      expect(account.actor.startsWith("account:")).toBe(true);
      expect(account.username).toBe("user_" + index);
      expect(account.displayName).toBe("User " + index);
      actors.set(email, account.actor);
      expect(await (await app("/projects", email)).json()).toEqual([]);
      expect(await (await app("/repositories", email)).json()).toEqual({
        repositories: [],
        cursor: null,
      });
      expect((await app(`/projects/${legacyProject.id}/context`, email)).status).toBe(404);
    }
    const stored = await db
      .prepare("SELECT email_verified,access_actor FROM user ORDER BY email")
      .all();
    expect(
      stored.results.every(
        (user) => user.email_verified === 0 && String(user.access_actor).startsWith("enrollment:"),
      ),
    ).toBe(true);
    const actor = (email: string) => actors.get(email)!;
    const project = await repository.seedProject("owner-project", actor(emails[0]), emails[0]);
    const privateProject = await repository.seedProject(
      "colleague-private",
      actor(emails[1]),
      emails[1],
    );
    expect((await app(`/projects/${privateProject.id}/context`)).status).toBe(404);
    const thread = (await (
      await app(`/projects/${project.id}/threads`, emails[0], "POST", {
        title: "shared account notes",
        idempotencyKey: "thread",
      })
    ).json()) as { id: string };
    const invitation = async (path: string) => {
      const response = await app(path, emails[0], "POST", { email: emails[1], role: "editor" });
      expect(response.status).toBe(201);
      return ((await response.json()) as { token: string }).token;
    };
    const projectInvite = await invitation(`/projects/${project.id}/invitations`);
    expect((await app(`/invitations/${projectInvite}/accept`, emails[1], "POST", {})).status).toBe(
      200,
    );
    expect((await app(`/threads/${thread.id}/messages`, emails[1])).status).toBe(404);
    expect((await app(`/threads/${thread.id}/source/tree`, emails[1])).status).toBe(404);
    expect((await app(`/threads/${thread.id}/presence`, emails[1])).status).toBe(404);
    const visualizationPath = `/projects/${project.id}/threads/${thread.id}/visualizations`;
    expect((await app(visualizationPath, emails[1])).status).toBe(404);
    const threadInvite = await invitation(`/threads/${thread.id}/invitations`);
    expect((await app(`/invitations/${threadInvite}/accept`, emails[1], "POST", {})).status).toBe(
      200,
    );
    const presencePath = `/threads/${thread.id}/presence`;
    const typing = {
      clientId: "00000000-0000-0000-0000-000000000001",
      sequence: 1,
      active: true,
    };
    expect((await app(presencePath, emails[1], "POST", typing)).status).toBe(200);
    const peers = await app(presencePath);
    expect(peers.status).toBe(200);
    expect(peers.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await peers.json()).toMatchObject({ typers: [{ username: "user_1" }] });
    expect(await (await app(presencePath, emails[1])).json()).toEqual({ typers: [] });
    expect(
      (await app(presencePath, emails[1], "POST", { ...typing, username: "forged" })).status,
    ).toBe(400);
    expect((await app(`${presencePath}?actor=access%3Alegacy`)).status).toBe(400);
    const storedVisualization = await repository.seedVisualization(
      project.id,
      thread.id,
      actor(emails[0]),
    );
    for (const email of emails) {
      const read = await app(visualizationPath, email);
      expect(read.status, await read.clone().text()).toBe(200);
      expect(read.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await read.json()).toMatchObject({
        accountId: actor(email),
        artifacts: [{ id: storedVisualization.id }],
      });
      expect((await app(`${visualizationPath}/${storedVisualization.id}`, email)).status).toBe(200);
    }
    expect((await app(`${visualizationPath}?actor=access%3Alegacy`)).status).toBe(400);
    expect((await app(visualizationPath, emails[0], "POST", {})).status).toBe(404);
    const notes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        app(
          `/threads/${thread.id}/messages`,
          emails[index % 2],
          "POST",
          {
            content: "shared note " + index,
            idempotencyKey: "note-" + index,
            author: { actor: "access:forged", username: "forged" },
            username: "forged",
          },
          { "cf-access-jwt-assertion": "forged", "x-pitcrew-actor": "access:forged" },
        ),
      ),
    );
    expect(notes.map((r) => r.status)).toEqual(Array(8).fill(201));
    const messages = (await (await app(`/threads/${thread.id}/messages`, emails[1])).json()) as {
      author: { actor: string; username: string; displayName: string };
    }[];
    expect(messages).toHaveLength(8);
    expect(messages.every((note) => [...actors.values()].includes(note.author.actor))).toBe(true);
    for (const [index, email] of emails.entries()) {
      expect(messages.filter((note) => note.author.actor === actor(email))).toHaveLength(4);
      expect(
        messages
          .filter((note) => note.author.actor === actor(email))
          .every(
            (note) =>
              note.author.username === "user_" + index &&
              note.author.displayName === "User " + index,
          ),
      ).toBe(true);
    }
    const beforeProfile = await repository.snapshot();
    const waitPending = async (count: number) => {
      for (let index = 0; index < 200 && (await repository.authorityPending()) !== count; index++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await repository.authorityPending()).toBe(count);
    };
    // The product request captures the old user outside the gate while the
    // earlier profile update is queued. Its admitted snapshot must be reread.
    await repository.holdAuthority();
    let rename: ReturnType<typeof app> | undefined;
    let profileRead: ReturnType<typeof app> | undefined;
    let profileNote: ReturnType<typeof app> | undefined;
    try {
      rename = app("/auth/update-user", emails[1], "POST", {
        username: "renamed_colleague",
        name: "",
      });
      await waitPending(2);
      profileRead = app(`/projects/${project.id}/members`, emails[1]);
      await waitPending(3);
      profileNote = app(`/threads/${thread.id}/messages`, emails[1], "POST", {
        content: "new verified label",
        idempotencyKey: "renamed-profile-note",
        author: { actor: "account:forged", username: "forged" },
      });
      await waitPending(4);
      expect((await repository.snapshot()).profiles).toEqual(beforeProfile.profiles);
    } finally {
      await repository.releaseAuthority();
    }
    expect((await rename!).status).toBe(200);
    expect(await (await profileRead!).json()).toContainEqual(
      expect.objectContaining({
        actor: actor(emails[1]),
        username: "renamed_colleague",
        displayName: "",
      }),
    );
    expect(await (await app("/account", emails[1])).json()).toMatchObject({
      actor: actor(emails[1]),
      username: "renamed_colleague",
      displayName: "",
    });
    for (const path of [`/projects/${project.id}/members`, `/threads/${thread.id}/members`]) {
      const members = (await (await app(path)).json()) as { actor: string; username: string }[];
      expect(members.find((member) => member.actor === actor(emails[1]))).toMatchObject({
        username: "renamed_colleague",
        displayName: "",
        role: "editor",
      });
    }
    expect((await profileNote!).status).toBe(201);
    const historical = (await (await app(`/threads/${thread.id}/messages`)).json()) as unknown[];
    expect(historical.slice(0, messages.length)).toEqual(messages);
    expect(await (await app(`/threads/${thread.id}/messages`)).json()).toMatchObject([
      ...messages,
      { author: { actor: actor(emails[1]), username: "renamed_colleague", displayName: "" } },
    ]);
    expect((await app(presencePath, emails[1], "POST", { ...typing, sequence: 2 })).status).toBe(
      200,
    );
    expect(await (await app(presencePath)).json()).toMatchObject({
      typers: [{ username: "renamed_colleague" }],
    });
    expect((await app(`/projects/${legacyProject.id}/context`, emails[1])).status).toBe(404);
    const afterProfile = await repository.snapshot();
    expect(afterProfile.bindings).toEqual(beforeProfile.bindings);
    expect(afterProfile.members).toEqual(beforeProfile.members);
    // Actual production ingress/account/session/DO path, synthetic bytes only.
    const upload = (id: string, bytes: Uint8Array, name: string, type: string, email = emails[0]) =>
      mf.dispatchFetch(`${base}/app/api/threads/${thread.id}/uploads/${id}`, {
        method: "PUT",
        body: bytes,
        headers: {
          origin: base,
          cookie: cookies.get(email)!,
          "content-type": type,
          "x-pitcrew-filename": encodeURIComponent(name),
          "x-user-id": "access:forged",
          "cf-access-jwt-assertion": "forged",
        },
      });
    const syntheticFiles = [
      {
        name: "synthetic.png",
        type: "image/png",
        bytes: Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
          ),
          (c) => c.charCodeAt(0),
        ),
      },
      {
        name: "synthetic.mp4",
        type: "video/mp4",
        bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]),
      },
      {
        name: "synthetic.pdf",
        type: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.4 synthetic fixture only"),
      },
      {
        name: "synthetic.txt",
        type: "text/plain",
        bytes: new TextEncoder().encode("Synthetic account uploads only."),
      },
    ].map((file) => ({ ...file, id: crypto.randomUUID() }));
    for (const file of syntheticFiles) {
      const staged = await upload(file.id, file.bytes, file.name, file.type);
      expect(staged.status, await staged.clone().text()).toBe(201);
      expect(await staged.json()).toMatchObject({
        uploadId: file.id,
        name: file.name,
        size: file.bytes.length,
      });
      expect((await app(`/threads/${thread.id}/uploads/${file.id}`, emails[1])).status).toBe(404);
      expect((await app(`/threads/${thread.id}/attachments/${file.id}`)).status).toBe(404);
    }
    expect(
      (
        await app(`/threads/${thread.id}/messages`, emails[1], "POST", {
          content: "Cannot adopt another account's staged file",
          idempotencyKey: "upload-steal",
          attachments: [{ uploadId: syntheticFiles[0].id, modelInput: "storage" }],
        })
      ).status,
    ).toBe(404);
    const uploadedNote = {
      content: "Four synthetic stored files",
      idempotencyKey: "four-upload-note",
      attachments: syntheticFiles.map((file) => ({ uploadId: file.id, modelInput: "storage" })),
    };
    expect(
      (await app(`/threads/${thread.id}/messages`, emails[0], "POST", uploadedNote)).status,
    ).toBe(201);
    expect(
      (await app(`/threads/${thread.id}/messages`, emails[0], "POST", uploadedNote)).status,
    ).toBe(201);
    for (const file of syntheticFiles) {
      const download = await app(`/threads/${thread.id}/attachments/${file.id}`, emails[1]);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("content-disposition")).toContain("attachment;");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(file.bytes);
    }
    const removedUpload = crypto.randomUUID();
    expect(
      (await upload(removedUpload, new Uint8Array([1]), "removed.bin", "application/octet-stream"))
        .status,
    ).toBe(201);
    expect(
      (await app(`/threads/${thread.id}/uploads/${removedUpload}`, emails[0], "DELETE")).status,
    ).toBe(200);
    expect(
      (await upload(removedUpload, new Uint8Array([1]), "removed.bin", "application/octet-stream"))
        .status,
    ).toBe(409);
    const capabilities = await (await app(`/capabilities?projectId=${project.id}`)).json();
    expect(capabilities).toMatchObject({ notesEnabled: true, landing: { enabled: false } });
    for (const path of [
      "/projects",
      "/repositories/create",
      "/repositories/import",
      "/repositories/reconcile",
      "/repositories/delete",
      `/projects/${project.id}/intake/dispatch`,
      "/changes/change/runs",
      "/runs/run/merge-approval",
      "/runs/run/landing",
      "/runs/run/landing/reconcile",
    ])
      expect((await app(path, emails[0], "POST", {})).status).toBe(404);
    const connection = () => app("/provider-connection/openrouter");
    expect(await (await connection()).json()).toMatchObject({
      configured: false,
      executionEnabled: false,
    });
    const newKey = "sk-or-v1-synthetic_new_account_never_live";
    const saved = await app("/provider-connection/openrouter", emails[0], "POST", {
      action: "store",
      key: newKey,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ configured: true, executionEnabled: true });
    expect(await credentials(actor(emails[0])).read(actor(emails[0]))).toBe(newKey);
    expect(await (await app("/provider-connection/openrouter", emails[1])).json()).toMatchObject({
      configured: false,
    });
    expect(await credentials("access:legacy").ciphertext()).toBe(legacyCiphertext);
    expect(await credentials("access:legacy").read("access:legacy")).toBe(legacyKey);
    const holdReadBeforeAuth = async (path: string, body: object, readStatus = 200) => {
      await repository.holdAuthority();
      const read = app(visualizationPath);
      let mutation: ReturnType<typeof app> | undefined;
      try {
        await waitPending(2);
        mutation = app(path, emails[0], "POST", body);
        await waitPending(3);
      } finally {
        await repository.releaseAuthority();
      }
      expect((await read).status).toBe(readStatus);
      const result = await mutation!;
      expect(result.status, await result.clone().text()).toBe(200);
      return result;
    };
    // Auth admission and private visualization disclosure share this exact
    // RepositoryAgent queue, including fresh checks and response construction.
    const racingLogin = await holdReadBeforeAuth("/auth/sign-in/username", {
      username: "user_0",
      password,
    });
    const extraCookie = racingLogin.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; ");
    const newPassword = password + "-changed";
    // Changing the password rotates this original session before the later
    // private disclosure gate; initial identity admission cannot revive it.
    const changed = await holdReadBeforeAuth(
      "/auth/change-password",
      { currentPassword: password, newPassword, revokeOtherSessions: false },
      401,
    );
    const changedCookie = changed.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; ");
    if (changedCookie) cookies.set(emails[0], changedCookie);
    expect(
      (await app(visualizationPath, emails[0], "GET", undefined, { cookie: extraCookie })).status,
    ).toBe(401);
    // Revocation admitted first must win against a read which passed the
    // outer account lookup but has not entered the private disclosure queue.
    // Deliberately make the captured D1 labels differ from the persisted member
    // labels. A revoked request must never project those unadmitted values.
    const beforeRevocationProfiles = (await repository.snapshot()).profiles;
    await db
      .prepare("UPDATE user SET username=?,name=? WHERE id=?")
      .bind("unprojected_owner", "Unadmitted Name", actor(emails[0]).slice("account:".length))
      .run();
    await repository.holdAuthority();
    const revocation = app("/auth/revoke-sessions", emails[0], "POST", {});
    let staleRead: ReturnType<typeof app> | undefined;
    let staleTyping: ReturnType<typeof app> | undefined;
    let stalePeers: ReturnType<typeof app> | undefined;
    let staleDownload: ReturnType<typeof app> | undefined;
    let staleUpload: ReturnType<typeof upload> | undefined;
    try {
      await waitPending(2);
      staleRead = app(visualizationPath);
      await waitPending(3);
      staleTyping = app(presencePath, emails[0], "POST", typing);
      await waitPending(4);
      stalePeers = app(presencePath);
      await waitPending(5);
      staleDownload = app(`/threads/${thread.id}/attachments/${syntheticFiles[0].id}`);
      await waitPending(6);
      staleUpload = upload(
        crypto.randomUUID(),
        new Uint8Array([2]),
        "revoked.bin",
        "application/octet-stream",
      );
      await waitPending(7);
      expect((await repository.snapshot()).profiles).toEqual(beforeRevocationProfiles);
    } finally {
      await repository.releaseAuthority();
    }
    expect((await revocation).status).toBe(200);
    expect((await staleRead!).status).toBe(401);
    expect((await staleTyping!).status).toBe(401);
    expect((await stalePeers!).status).toBe(401);
    expect((await staleDownload!).status).toBe(401);
    expect((await staleUpload!).status).toBe(401);
    expect((await repository.snapshot()).profiles).toEqual(beforeRevocationProfiles);
    expect((await app(visualizationPath)).status).toBe(401);
    await db
      .prepare("UPDATE user SET username=?,name=? WHERE id=?")
      .bind("user_0", "User 0", actor(emails[0]).slice("account:".length))
      .run();
    const replacement = await app("/auth/sign-in/username", emails[0], "POST", {
      username: "user_0",
      password: newPassword,
    });
    expect(replacement.status).toBe(200);
    cookies.set(
      emails[0],
      replacement.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0])
        .join("; "),
    );
    expect((await app(visualizationPath)).status).toBe(200);
    // Cold restart persists account ACLs and never implicitly migrates matching emails.
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// cold restart" }),
    );
    const reloadedNamespace = await mf.getDurableObjectNamespace("REPOSITORY");
    repository = reloadedNamespace.get(
      reloadedNamespace.idFromName("pitcrew"),
    ) as unknown as typeof repository;
    credentialsNS = await mf.getDurableObjectNamespace("USER_CREDENTIALS");
    expect(await (await app(presencePath)).json()).toEqual({ typers: [] });
    expect((await app(presencePath, emails[1], "POST", { ...typing, sequence: 2 })).status).toBe(
      200,
    );
    expect(await (await app(presencePath)).json()).toMatchObject({
      typers: [{ username: "renamed_colleague" }],
    });
    expect(await credentials("access:legacy").ciphertext()).toBe(legacyCiphertext);
    expect(await (await connection()).json()).toMatchObject({
      configured: true,
      executionEnabled: true,
    });
    expect(await (await app(`/threads/${thread.id}/messages`, emails[1])).json()).toHaveLength(10);
    for (const file of syntheticFiles) {
      const download = await app(`/threads/${thread.id}/attachments/${file.id}`);
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(file.bytes);
    }
    expect(
      (
        await app(
          `/threads/${thread.id}/members/${encodeURIComponent(actor(emails[1]))}`,
          emails[0],
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await app(`/threads/${thread.id}/messages`, emails[1])).status).toBe(404);
    expect((await app(presencePath, emails[1])).status).toBe(404);
    expect((await app(presencePath, emails[1], "POST", { ...typing, sequence: 3 })).status).toBe(
      404,
    );
    expect(await (await app(presencePath)).json()).toEqual({ typers: [] });
    expect((await app(visualizationPath, emails[1])).status).toBe(404);
    expect(
      (await app(`/threads/${thread.id}/attachments/${syntheticFiles[0].id}`, emails[1])).status,
    ).toBe(404);
    expect(
      (
        await upload(
          crypto.randomUUID(),
          new Uint8Array([1]),
          "denied.bin",
          "application/octet-stream",
          emails[1],
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app(`/threads/${thread.id}/messages`, emails[1], "POST", {
          content: "denied",
          idempotencyKey: "denied",
        })
      ).status,
    ).toBe(404);
    const snapshot = await repository.snapshot();
    expect(snapshot).toMatchObject({
      runs: 0,
      turns: 0,
      calls: [],
      bindings: { "access:legacy": { userId: "legacy-user", email: emails[0] } },
    });
    expect(Object.keys(snapshot.members)).toEqual(["access:legacy"]);
    expect(outbound).toHaveLength(legacyRequests);
    const loggedOut = await app("/auth/sign-out", emails[0], "POST", {});
    expect(loggedOut.status).toBe(200);
    expect((await app("/account")).status).toBe(401);
    expect((await app(presencePath)).status).toBe(401);
    expect((await app(`/threads/${thread.id}/attachments/${syntheticFiles[0].id}`)).status).toBe(
      401,
    );
    expect((await request("/api/account")).status).toBe(403);
  } finally {
    await mf.dispose();
  }
}, 60000);
