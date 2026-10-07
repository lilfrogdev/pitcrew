import { expect, it } from "vite-plus/test";
import { visualizationSession } from "./visualization-auth";
import type { Auth } from "./auth";
const access = { actor: "access:verified", email: "dev@lilfrogdev.com" };
const request = new Request(
  "https://pitcrew.test/api/projects/pitcrew/threads/thread/visualizations",
);
const current = {
  user: { id: "viewer", email: access.email, emailVerified: true, accessActor: access.actor },
  session: { id: "opaque-session-id", expiresAt: new Date(Date.now() + 60000) },
};
const auth = (getSession: () => Promise<unknown>) => ({ api: { getSession } }) as unknown as Auth;
it("binds verified email/Access identity and returns only a non-secret account-session epoch", async () => {
  const result = await visualizationSession(
    auth(async () => current),
    request,
    access,
  );
  expect(result).toMatchObject({
    actor: "account:viewer",
    expiresAt: current.session.expiresAt.getTime(),
  });
  expect(result?.accessEpoch).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain(current.session.id);
  for (const value of [
    null,
    { ...current, user: { ...current.user, emailVerified: false } },
    { ...current, user: { ...current.user, accessActor: "access:other" } },
    { ...current, user: { ...current.user, email: "other@example.com" } },
    { ...current, session: { ...current.session, expiresAt: new Date(0) } },
  ])
    expect(
      await visualizationSession(
        auth(async () => value),
        request,
        access,
      ),
    ).toBeUndefined();
});
it("fails closed if the live session is revoked or replaced during resolution", async () => {
  for (const replacement of [null, { ...current, user: { ...current.user, id: "other" } }]) {
    let calls = 0;
    expect(
      await visualizationSession(
        auth(async () => (++calls === 1 ? current : replacement)),
        request,
        access,
      ),
    ).toBeUndefined();
  }
});
