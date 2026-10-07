import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Message } from "@pitcrew/protocol";
import type { State } from "./coordinator";

const base = "https://synthetic-demo.pitcrew.test";
const john = { email: "john.cena@example.com", username: "johncena", name: "John Cena" };
const lara = { email: "lara.croft@example.com", username: "laracroft", name: "Lara Croft" };
const password = "synthetic-demo-fixture-password-never-live";
const target = { name: "approved-existing-repo", repositoryId: "immutable-repository-id" };
type RepositoryFixture = {
  approve(actor?: string, name?: string, repositoryId?: string): Promise<void>;
  seedProject(name: string, actor: string, email: string): Promise<{ id: string }>;
  storedState(): Promise<State>;
  snapshot(): Promise<{ calls: string[] }>;
  holdAuthority(): Promise<void>;
  releaseAuthority(): Promise<void>;
  authorityPending(): Promise<number>;
  expireAccountSessions(actor: string): Promise<void>;
};
async function fixture() {
  const bundle = await build({
    entryPoints: [new URL("../test/project-adoption-worker.ts", import.meta.url).pathname],
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
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { AUTH_DB: "synthetic-demo-collaboration" },
    resourcePersistencePath: `/tmp/pitcrew-demo-collaboration-${crypto.randomUUID()}`,
    durableObjects: {
      REPOSITORY: { className: "ProjectAdoptionFixture", useSQLite: true },
      USER_CREDENTIALS: { className: "PasswordCredentialsFixture", useSQLite: true },
    },
    bindings: {
      AUTH_MODE: "password-only",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "synthetic-demo-collaboration-secret-never-live-123456",
      ENVIRONMENT: "production",
      EXECUTION_MODE: "disabled",
      INFRASTRUCTURE_ADMISSION_ENABLED: "false",
      CLOUD_CONVERSATION_ENABLED: "false",
      REPOSITORY_LIFECYCLE: "disabled",
      TRUSTED_PUBLISHER_ENABLED: "false",
      // Neither demo persona is a configured legacy owner.
      ACCESS_EMAIL: "unrelated-legacy-operator@example.test",
      CONFIGURATION_REVISION: "synthetic-demo-fixture",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    outboundService: () => {
      throw Error("unexpected_external_transport");
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const db = await mf.getD1Database("AUTH_DB");
  for (const file of (await readdir(new URL("../migrations/auth", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new URL(`../migrations/auth/${file}`, import.meta.url), "utf8");
    const statements = sql
      .split(";")
      .map((s) => s.replace(/--> statement-breakpoint/g, "").trim())
      .filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  const getRepository = async () => {
    const ns = await mf.getDurableObjectNamespace("REPOSITORY");
    return ns.get(ns.idFromName("pitcrew")) as unknown as RepositoryFixture;
  };
  let repository = await getRepository();
  const cookies = new Map<string, string>();
  let sequence = 0;
  const request = (path: string, email = john.email, body?: unknown, method?: string) =>
    mf.dispatchFetch(base + "/app/api" + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        origin: base,
        "cf-connecting-ip": `192.0.2.${(++sequence % 200) + 1}`,
        ...(cookies.has(email) ? { cookie: cookies.get(email)! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (persona: typeof john) => {
    const response = await request("/auth/sign-in/username", persona.email, {
      username: persona.username,
      password,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    cookies.set(
      persona.email,
      response.headers
        .getSetCookie()
        .map((c) => c.split(";", 1)[0])
        .join("; "),
    );
    return ((await (await request("/account", persona.email)).json()) as { actor: string }).actor;
  };
  const enroll = async (persona: typeof john) => {
    // Only disposable synthetic D1 receives these operator-issued grants.
    const code = Buffer.from(randomBytes(32)).toString("base64url");
    await db
      .prepare(
        "INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at) VALUES(?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        persona.email,
        createHash("sha256").update(code).digest("hex"),
        Date.now() + 600000,
      )
      .run();
    const response = await request("/auth/enroll", persona.email, {
      code,
      password,
      username: persona.username,
      name: persona.name,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return login(persona);
  };
  const restart = async () => {
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        script: options.script + "\n// synthetic cold restart " + crypto.randomUUID(),
      }),
    );
    repository = await getRepository();
  };
  const waitPending = async (count: number) => {
    for (let i = 0; i < 200 && (await repository.authorityPending()) !== count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await repository.authorityPending()).toBe(count);
  };
  return {
    mf,
    db,
    request,
    enroll,
    login,
    restart,
    waitPending,
    get repository() {
      return repository;
    },
  };
}

it("grant-backed JohnCena and LaraCroft share only explicitly invited native work and retain revocation across reloads", async () => {
  const f = await fixture();
  try {
    const johnActor = await f.enroll(john),
      laraActor = await f.enroll(lara);
    expect(johnActor).toMatch(/^account:/);
    expect(laraActor).toMatch(/^account:/);
    expect(laraActor).not.toBe(johnActor);
    const users = await f.db
      .prepare("SELECT id,email,email_verified,username FROM user ORDER BY email")
      .all();
    expect(users.results).toEqual([
      { id: johnActor.slice(8), email: john.email, email_verified: 0, username: "johncena" },
      { id: laraActor.slice(8), email: lara.email, email_verified: 0, username: "laracroft" },
    ]);
    const grants = await f.db
      .prepare(
        "SELECT recipient_email,consumed_user_id FROM auth_enrollment ORDER BY recipient_email",
      )
      .all();
    expect(grants.results).toEqual([
      { recipient_email: john.email, consumed_user_id: johnActor.slice(8) },
      { recipient_email: lara.email, consumed_user_id: laraActor.slice(8) },
    ]);
    for (const persona of [john, lara]) {
      expect(await (await f.request("/projects", persona.email)).json()).toEqual([]);
      expect(await (await f.request("/account", persona.email)).json()).toMatchObject({
        actor: persona === john ? johnActor : laraActor,
        email: persona.email,
        username: persona.username.toLowerCase(),
        displayName: persona.name,
      });
    }
    const { id: legacyProjectId } = await f.repository.seedProject(
      "unrelated-legacy-repository",
      "access:legacy-fixture",
      john.email,
    );
    const credentialsNS = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
    const legacyCredentials = credentialsNS.get(
      credentialsNS.idFromName("openrouter:access:legacy-fixture"),
    ) as unknown as {
      save(actor: string, key: string): Promise<void>;
      ciphertext(): Promise<string>;
    };
    await legacyCredentials.save(
      "access:legacy-fixture",
      "sk-or-v1-synthetic-demo-legacy-never-live",
    );
    const ciphertext = await legacyCredentials.ciphertext();
    // Materialize RPC values before cold restarts invalidate runtime proxies.
    const before = JSON.parse(JSON.stringify(await f.repository.storedState())) as State;
    for (const persona of [john, lara])
      expect((await f.request(`/projects/${legacyProjectId}/context`, persona.email)).status).toBe(
        404,
      );
    expect((await f.request("/projects", john.email, target)).status).toBe(404);
    await f.repository.approve(johnActor, target.name, target.repositoryId);
    expect((await f.request("/projects", lara.email, target)).status).toBe(404);
    const adoption = await f.request("/projects", john.email, target);
    expect(adoption.status, await adoption.clone().text()).toBe(201);
    const project = (await adoption.json()) as { id: string };
    expect((await f.request(`/projects/${project.id}/context`, lara.email)).status).toBe(404);
    const createThread = async (key: string) => {
      const response = await f.request(`/projects/${project.id}/threads`, john.email, {
        title: key,
        idempotencyKey: key,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const shared = await createThread("shared-demo-work"),
      privateThread = await createThread("john-private-work");
    const invite = async (path: string) => {
      const response = await f.request(path, john.email, { email: lara.email, role: "editor" });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { token: string }).token;
    };
    const projectToken = await invite(`/projects/${project.id}/invitations`);
    expect((await f.request(`/invitations/${projectToken}/accept`, john.email, {})).status).toBe(
      404,
    );
    expect((await f.request(`/threads/${shared.id}/messages`, lara.email)).status).toBe(404);
    expect(
      (
        await f.request(`/invitations/${projectToken}/accept`, lara.email, {
          actor: johnActor,
          email: john.email,
        })
      ).status,
    ).toBe(200);
    expect((await f.request(`/invitations/${projectToken}/accept`, lara.email, {})).status).toBe(
      410,
    );
    expect((await f.request(`/projects/${project.id}/context`, lara.email)).status).toBe(200);
    expect(await (await f.request(`/projects/${project.id}/threads`, lara.email)).json()).toEqual(
      [],
    );
    expect((await f.request(`/threads/${shared.id}/messages`, lara.email)).status).toBe(404);
    expect(
      (
        await f.request(`/projects/${project.id}/invitations`, lara.email, {
          email: john.email,
          role: "editor",
        })
      ).status,
    ).toBe(403);
    const threadToken = await invite(`/threads/${shared.id}/invitations`);
    expect((await f.request(`/invitations/${threadToken}/accept`, lara.email, {})).status).toBe(
      200,
    );
    expect((await f.request(`/threads/${privateThread.id}/messages`, lara.email)).status).toBe(404);
    expect(
      (
        await f.request(`/threads/${shared.id}/invitations`, lara.email, {
          email: john.email,
          role: "editor",
        })
      ).status,
    ).toBe(403);
    const notes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        f.request(`/threads/${shared.id}/messages`, i % 2 ? lara.email : john.email, {
          content: "parallel synthetic note " + i,
          idempotencyKey: "synthetic-note-" + i,
          author: { actor: "account:forged", username: "forged" },
        }),
      ),
    );
    expect(notes.map((note) => note.status)).toEqual(Array(8).fill(201));
    const messages = (await (
      await f.request(`/threads/${shared.id}/messages`, lara.email)
    ).json()) as Message[];
    expect(messages).toHaveLength(8);
    for (const message of messages) {
      const expectedPersona = Number(message.content.split(" ").at(-1)) % 2 ? lara : john;
      expect(message.author?.actor).toBe(expectedPersona === john ? johnActor : laraActor);
      expect(message.author?.username).toBe(
        message.author?.actor === johnActor ? "johncena" : "laracroft",
      );
      expect(message.author?.displayName).toBe(expectedPersona.name);
    }
    const duplicateThreadToken = await invite(`/threads/${shared.id}/invitations`);
    expect(
      (
        await f.request(
          `/threads/${shared.id}/members/${encodeURIComponent(laraActor)}`,
          john.email,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await f.request(`/threads/${shared.id}/messages`, lara.email)).status).toBe(404);
    expect(
      (await f.request(`/invitations/${duplicateThreadToken}/accept`, lara.email, {})).status,
    ).toBe(410);
    expect((await f.request(`/projects/${project.id}/context`, lara.email)).status).toBe(200);
    await f.restart();
    expect((await f.request(`/threads/${shared.id}/messages`, lara.email)).status).toBe(404);
    expect((await f.request(`/projects/${project.id}/context`, lara.email)).status).toBe(200);
    expect(await (await f.request(`/threads/${shared.id}/messages`)).json()).toEqual(messages);
    const renewed = await invite(`/threads/${shared.id}/invitations`);
    expect((await f.request(`/invitations/${renewed}/accept`, lara.email, {})).status).toBe(200);
    expect((await f.request(`/threads/${shared.id}/messages`, lara.email)).status).toBe(200);
    expect(
      (
        await f.request(
          `/projects/${project.id}/members/${encodeURIComponent(laraActor)}`,
          john.email,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await f.restart();
    expect(await (await f.request("/projects", lara.email)).json()).toEqual([]);
    expect((await f.request(`/threads/${shared.id}/messages`, lara.email)).status).toBe(404);
    const after = JSON.parse(JSON.stringify(await f.repository.storedState())) as State;
    expect(after.collaboration).toEqual(before.collaboration);
    expect(after.identityBindings).toEqual(before.identityBindings);
    expect(after.ownedProjects![legacyProjectId]).toEqual(before.ownedProjects![legacyProjectId]);
    expect(after.ownedProjects![project.id].ownerActor).toBe(johnActor);
    const reloadedCredentialsNS = await f.mf.getDurableObjectNamespace("USER_CREDENTIALS");
    const reloadedLegacy = reloadedCredentialsNS.get(
      reloadedCredentialsNS.idFromName("openrouter:access:legacy-fixture"),
    ) as unknown as { ciphertext(): Promise<string> };
    expect(await reloadedLegacy.ciphertext()).toBe(ciphertext);
    expect(
      (await f.repository.snapshot()).calls.every(
        (call) => call.startsWith("get:") || call.startsWith("log:"),
      ),
    ).toBe(true);
  } finally {
    await f.mf.dispose();
  }
}, 15000);

for (const mutation of ["sign-out", "revoke-sessions", "expiry", "update-user"] as const)
  it(`demo invitation acceptance observes ${mutation} after identity admission and before its membership commit`, async () => {
    const f = await fixture();
    try {
      const johnActor = await f.enroll(john),
        laraActor = await f.enroll(lara);
      await f.repository.approve(johnActor, target.name, target.repositoryId);
      const adopted = await f.request("/projects", john.email, target);
      expect(adopted.status).toBe(201);
      const project = (await adopted.json()) as { id: string };
      const invited = await f.request(`/projects/${project.id}/invitations`, john.email, {
        email: lara.email,
        role: "editor",
      });
      expect(invited.status).toBe(201);
      const { token } = (await invited.json()) as { token: string };
      await f.repository.holdAuthority();
      let acceptance: ReturnType<typeof f.request> | undefined,
        authMutation: ReturnType<typeof f.request> | undefined,
        expiry: Promise<void> | undefined;
      try {
        // Identity admission is ahead of revocation; the later membership commit
        // must independently check that same original session, after body reads.
        acceptance = f.request(`/invitations/${token}/accept`, lara.email, {});
        await f.waitPending(2);
        if (mutation === "expiry") expiry = f.repository.expireAccountSessions(laraActor);
        else
          authMutation = f.request(
            `/auth/${mutation}`,
            lara.email,
            mutation === "update-user" ? { image: "/avatars/frog.svg" } : {},
          );
        await f.waitPending(3);
      } finally {
        await f.repository.releaseAuthority();
      }
      if (expiry) await expiry;
      if (authMutation) expect((await authMutation).status).toBe(200);
      expect((await acceptance!).status).toBe(mutation === "update-user" ? 200 : 401);
      const access = (await f.repository.storedState()).ownedProjects![project.id].state
        .collaboration!;
      if (mutation === "update-user") {
        expect(access.projectMembers[laraActor]).toMatchObject({
          actor: laraActor,
          email: lara.email,
          username: lara.username,
          displayName: lara.name,
          avatar: "/avatars/frog.svg",
          role: "editor",
        });
        expect(Object.values(access.invitations)[0].acceptedBy).toBe(laraActor);
      } else {
        expect(access.projectMembers[laraActor]).toBeUndefined();
        expect(Object.values(access.invitations)[0].acceptedBy).toBeUndefined();
        expect(await f.login(lara)).toBe(laraActor);
        expect((await f.request(`/invitations/${token}/accept`, lara.email, {})).status).toBe(200);
      }
    } finally {
      await f.mf.dispose();
    }
  }, 15000);
