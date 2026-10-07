import { configuredAuth, authRequest, authUser, type AuthEnv } from "../src/auth";
import { VisualizationAuthorityGate } from "../src/visualization-authority-gate";
import { visualizationGrant, requireVisualizationSession } from "../src/visualization-auth";
import { DurableObject } from "cloudflare:workers";
export class PasswordAuthFixture extends DurableObject<AuthEnv> {
  private authority = new VisualizationAuthorityGate();
  private frozen: Awaited<ReturnType<typeof visualizationGrant>>;
  private verifyPaused = false;
  private releaseVerify: (() => void) | undefined;
  async fetch(request: Request) {
    const env = this.env,
      ctx = this.ctx;
    const auth = configuredAuth(env, request, (task) => ctx.waitUntil(task));
    if (!auth) return Response.json({ error: "auth_unconfigured" }, { status: 503 });
    const path = new URL(request.url).pathname;
    if (path === "/api/test/queue-state")
      return Response.json({ pending: this.authority.pending, verifyPaused: this.verifyPaused });
    if (path === "/api/test/release-verify") {
      this.releaseVerify?.();
      return Response.json({ status: true });
    }
    if (request.headers.has("x-test-pause-sign-in")) {
      // Only this synthetic fixture replaces the verifier to make a real
      // native-library race deterministic; production exposes no test hook.
      const context = await auth.$context;
      const verify = context.password.verify;
      context.password.verify = async (value) => {
        this.verifyPaused = true;
        await new Promise<void>((resolve) => {
          this.releaseVerify = resolve;
        });
        this.verifyPaused = false;
        return verify(value);
      };
    }
    if (path === "/api/test/visualization-grant")
      return this.authority.run(async () => {
        const grant = await visualizationGrant(auth, request);
        if (!grant) return new Response(null, { status: 401 });
        this.frozen ??= grant;
        return Response.json({ actor: grant.actor, mode: grant.mode, sessionId: grant.sessionId });
      });
    if (path === "/api/test/frozen-visualization")
      return this.authority.run(async () => {
        if (!this.frozen || !env.AUTH_DB) return new Response(null, { status: 401 });
        try {
          await requireVisualizationSession(env.AUTH_DB, this.frozen);
        } catch {
          return new Response(null, { status: 401 });
        }
        return Response.json({ actor: this.frozen.actor });
      });
    if (new URL(request.url).pathname === "/api/test/principal") {
      const user = await authUser(auth, request);
      return user
        ? Response.json({ actor: `account:${user.id}`, credentialActor: `account:${user.id}` })
        : new Response(null, { status: 401 });
    }
    return authRequest(auth, request, undefined, (operation) => this.authority.run(operation));
  }
}
export default {
  fetch(
    request: Request,
    env: AuthEnv & { AUTH_FIXTURE: DurableObjectNamespace<PasswordAuthFixture> },
  ) {
    return env.AUTH_FIXTURE.get(env.AUTH_FIXTURE.idFromName("synthetic")).fetch(request);
  },
};
