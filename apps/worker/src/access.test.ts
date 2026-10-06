import { describe, expect, it } from "vite-plus/test";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { principal, protectedFetch, type AccessEnv } from "./access";
const env: AccessEnv = {
  ENVIRONMENT: "production",
  ACCESS_ISSUER: "https://team.cloudflareaccess.com",
  ACCESS_AUDIENCE: "app-audience",
  ACCESS_EMAIL: "owner@example.com",
  ACCESS_HOSTNAME: "pitcrew.example.com",
};
async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fixture-key";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const token = (claims: Record<string, unknown> = {}) =>
    new SignJWT({ email: "owner@example.com", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setSubject(typeof claims.sub === "string" ? claims.sub : "owner-subject")
      .setIssuer(env.ACCESS_ISSUER!)
      .setAudience(env.ACCESS_AUDIENCE!)
      .setIssuedAt()
      .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
      .sign(privateKey);
  return { keys, token };
}
function request(token: string, path = "/api/projects", method = "GET", origin?: string) {
  return new Request(`https://pitcrew.example.com${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": token, ...(origin ? { origin } : {}) },
  });
}
describe("protected private cloud demo", () => {
  it("admits only the two configured exact email identities and denies malformed allowlists", async () => {
    const f = await fixture();
    const shared = {
      ...env,
      ACCESS_EMAILS: JSON.stringify(["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"]),
    };
    for (const [email, sub] of [
      ["dev@lilfrogdev.com", "owner-subject"],
      ["bryan.aldair.zamora@gmail.com", "bryan-subject"],
    ])
      expect(await principal(request(await f.token({ email, sub })), shared, f.keys)).toEqual({
        actor: `access:${sub}`,
        email,
      });
    for (const email of [
      "other@gmail.com",
      "bryan.aldair.zamora+other@gmail.com",
      "bryan.aldair.zamora@gmail.com.evil",
    ])
      expect(await principal(request(await f.token({ email })), shared, f.keys)).toBeUndefined();
    for (const ACCESS_EMAILS of ["invalid", "[]", '["*@gmail.com"]', "[null]"])
      expect(
        await principal(request(await f.token()), { ...env, ACCESS_EMAILS }, f.keys),
      ).toBeUndefined();
  });
  it("verifies a genuine locally signed JWT and routes both assets and API behind it", async () => {
    const f = await fixture(),
      jwt = await f.token();
    expect(await principal(request(jwt), env, f.keys)).toEqual({ actor: "access:owner-subject", email: "owner@example.com" });
    let assetCalls = 0,
      apiCalls = 0;
    const api = async () => {
      apiCalls++;
      return Response.json({ private: true });
    };
    const assets = {
      fetch: async () => {
        assetCalls++;
        return new Response("private browser UI");
      },
    };
    const result = await protectedFetch(request(jwt, "/"), env, api, assets, f.keys);
    expect(await result.text()).toBe("private browser UI");
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    const apiResponse = await protectedFetch(request(jwt), env, api, assets, f.keys);
    expect(apiResponse.status).toBe(200);
    expect(apiResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(assetCalls).toBe(1);
    expect(apiCalls).toBe(1);
  });
  it("rejects absent protection, invalid signatures, wrong identity/audience/issuer and expired tokens offline", async () => {
    const f = await fixture(),
      other = await fixture(),
      jwt = await f.token();
    expect(
      await principal(request(jwt), { ...env, ACCESS_AUDIENCE: undefined }, f.keys),
    ).toBeUndefined();
    expect(await principal(request(await other.token()), env, f.keys)).toBeUndefined();
    expect(
      await principal(request(await f.token({ email: "other@example.com" })), env, f.keys),
    ).toBeUndefined();
    expect(
      await principal(request(jwt), { ...env, ACCESS_AUDIENCE: "other-app" }, f.keys),
    ).toBeUndefined();
    expect(
      await principal(
        request(jwt),
        { ...env, ACCESS_ISSUER: "https://other.cloudflareaccess.com" },
        f.keys,
      ),
    ).toBeUndefined();
    expect(await principal(request(await f.token({ exp: 1 })), env, f.keys)).toBeUndefined();
  });
  it("requires same-origin browser mutations and rejects alternate hosts or fixture production bypass", async () => {
    const f = await fixture(),
      jwt = await f.token();
    expect(
      await principal(
        request(jwt, "/api/threads", "POST", "https://pitcrew.example.com"),
        env,
        f.keys,
      ),
    ).toBeDefined();
    expect(
      await principal(
        request(jwt, "/api/threads", "POST", "https://attacker.example"),
        env,
        f.keys,
      ),
    ).toBeUndefined();
    expect(await principal(request(jwt, "/api/threads", "POST"), env, f.keys)).toBeUndefined();
    expect(
      await principal(request(jwt), { ...env, ACCESS_HOSTNAME: "different.example.com" }, f.keys),
    ).toBeUndefined();
    expect(
      await principal(
        new Request("http://localhost/api/projects"),
        { ENVIRONMENT: "production", FIXTURE_IDENTITY: "lilfrogdev" },
        f.keys,
      ),
    ).toBeUndefined();
    expect(
      (
        await protectedFetch(
          new Request("https://pitcrew.example.com/"),
          env,
          async () => {
            throw Error("must not route");
          },
          {
            fetch: async () => {
              throw Error("must not serve assets");
            },
          },
          f.keys,
        )
      ).status,
    ).toBe(403);
  });
});
