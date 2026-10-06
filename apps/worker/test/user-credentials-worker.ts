import { createLocalJWKSet } from "jose";
import { principal, protectedFetch, type AccessEnv } from "../src/access";
import { UserCredentials } from "../src/user-credentials-agent";
import {
  providerConnectionRequest,
  userCredential,
  userModelEnv,
  type CredentialEnv,
} from "../src/user-credentials";
import { configureSelectedModels, type ModelEnv } from "../src/model-selection";
const configuredByActor = new Map<string, ReturnType<typeof configureSelectedModels>>();
export class CredentialFixture extends UserCredentials {
  stored() {
    return [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM credential")];
  }
  corrupt() {
    this.ctx.storage.sql.exec(
      "UPDATE credential SET value=?",
      '{"version":1,"iv":"AAAAAAAAAAAAAAAA","ciphertext":"AAAA"}',
    );
  }
}
interface Env extends CredentialEnv, AccessEnv, ModelEnv {
  TEST_PUBLIC_JWK: string;
  USER_CREDENTIALS: DurableObjectNamespace<CredentialFixture>;
}
export default {
  async fetch(request: Request, env: Env) {
    const keys = createLocalJWKSet({ keys: [JSON.parse(env.TEST_PUBLIC_JWK)] });
    return protectedFetch(
      request,
      env,
      async () => {
        const identity = (await principal(request, env, keys))!;
        const path = new URL(request.url).pathname;
        if (path === "/api/provider-connection/openrouter")
          return providerConnectionRequest(request, env, identity.actor);
        // Test-only observations; these paths do not exist in the production Worker.
        const credential = userCredential(
          env,
          identity.actor,
        ) as unknown as DurableObjectStub<CredentialFixture>;
        if (path === "/api/fixture/ciphertext") return Response.json(await credential.stored());
        if (path === "/api/fixture/corrupt") {
          await credential.corrupt();
          return Response.json({ ok: true });
        }
        if (path === "/api/fixture/foreign") {
          try {
            await credential.read("access:other-user");
            return Response.json({ denied: false });
          } catch {
            return Response.json({ denied: true });
          }
        }
        if (path === "/api/fixture/runtime") {
          try {
            const configured =
              configuredByActor.get(identity.actor) ??
              configureSelectedModels(userModelEnv(env, identity.actor));
            configuredByActor.set(identity.actor, configured);
            let called = false,
              fingerprint = "";
            const result = await configured.models.completeSimple(
              configured.model,
              {
                messages: [{ role: "user", content: "offline synthetic test", timestamp: 0 }],
              },
              {
                maxTokens: 16,
                fetch: async (_url, init) => {
                  called = true;
                  const auth = new Headers(init?.headers).get("authorization") ?? "";
                  fingerprint = Array.from(
                    new Uint8Array(
                      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth)),
                    ),
                    (b) => b.toString(16).padStart(2, "0"),
                  ).join("");
                  if (new URL(request.url).searchParams.has("fail"))
                    return Response.json({ error: { message: auth } }, { status: 401 });
                  return new Response(
                    'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"synthetic answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    { headers: { "Content-Type": "text/event-stream" } },
                  );
                },
              },
            );
            return Response.json({ called, fingerprint, result }, { status: called ? 200 : 409 });
          } catch {
            return Response.json({ error: "provider_credential_unavailable" }, { status: 409 });
          }
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
      undefined,
      keys,
    );
  },
};
