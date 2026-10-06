import { configuredAuth, authRequest, authUser, type AuthEnv } from "../src/auth";
import { importJWK, jwtVerify } from "jose";
interface Env extends AuthEnv {
  TEST_PUBLIC_JWK: string;
  AUTH_DB: D1Database;
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const key = await importJWK(JSON.parse(env.TEST_PUBLIC_JWK), "RS256");
      const { payload } = await jwtVerify(
        request.headers.get("cf-access-jwt-assertion") ?? "",
        key,
        {
          issuer: "https://fixture.cloudflareaccess.com",
          audience: "fixture",
          algorithms: ["RS256"],
          requiredClaims: ["sub", "email", "exp", "iat"],
        },
      );
      const access = { actor: `access:${payload.sub}`, email: String(payload.email) };
      const auth = configuredAuth(
        {
          ...env,
          EMAIL: {
            async send(message) {
              const msg = message as EmailMessageBuilder;
              if (request.headers.has("x-test-mail-fail"))
                throw Error("synthetic provider error with token and recipient");
              await env.AUTH_DB.prepare(
                "INSERT INTO test_mail(recipient,subject,body) VALUES(?,?,?)",
              )
                .bind(msg.to, msg.subject, msg.text)
                .run();
              return { messageId: "synthetic-mail" };
            },
          },
        },
        request,
        (task) =>
          ctx.waitUntil(
            task.catch(async (error) => {
              // The test observes only the already-sanitized failure supplied by auth.
              await env.AUTH_DB.prepare("INSERT INTO test_mail_failure(error) VALUES(?)")
                .bind(error.message)
                .run();
            }),
          ),
        access,
      );
      if (!auth) return Response.json({ error: "auth_unconfigured" }, { status: 503 });
      if (new URL(request.url).pathname === "/api/test/principal") {
        const user = await authUser(auth, request, access);
        return user
          ? Response.json({ actor: `account:${user.id}`, credentialActor: access.actor })
          : new Response(null, { status: 401 });
      }
      return authRequest(auth, request, access);
    } catch {
      return new Response(null, { status: 403 });
    }
  },
};
