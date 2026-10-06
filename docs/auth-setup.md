# Local Pitcrew accounts on Cloudflare

Prepared implementation only. No D1 database, DNS records, Access policy, secret,
production account, mail delivery, or deployment was created by this change.
Both clients remain local; only the shared backend is deployed after approval.

## Tested contract

- `configuredAuth(env, request, waitUntil, access)` requires the fourth argument
  `{actor: 'access:<verified JWT sub>', email: '<verified JWT email>'}` from the
  existing signature/issuer/audience/expiry-checked Access gate.
- `authRequest(auth, request, access)` handles the exact `/api/auth` route set;
  `authUser(auth, request, access)` returns only a verified user bound to that
  immutable Access subject **and** email. Use `account:${user.id}` for repository
  membership/ACL. Keep `access:<sub>` for existing encrypted provider credentials.
  Do not re-encrypt, copy, fall back, or implicitly link credentials by email.
- Username is a distinct, unique field (3–32 ASCII letters, numbers, underscores).
  Profile image is null or an approved local `/avatars/<id>.svg`; name is 1–80
  characters. User responses contain `id,email,emailVerified,name,username,image`.
- Signup and sign-in accept email/password. Signup also needs name/username; image
  is optional. Email must equal the verified Access email and exactly match
  `dev@lilfrogdev.com` or `bryan.aldair.zamora@gmail.com`. Passwords are entered by
  the users and hashed by Better Auth. No OAuth providers or implicit linking.
- Signups do not create sessions until email is verified. Session lifetime is 30
  minutes with no cookie cache or automatic extension. Logout revokes the current
  session; `/revoke-sessions` revokes all; reset revokes all and consumes its token
  once. `/change-password` accepts `revokeOtherSessions:true` to revoke others.
- Verification and reset tokens expire after 15 minutes. Emails use the native
  `EMAIL.send({to,from,subject,text})` binding. Failures sent to `waitUntil` are
  sanitized as `auth_email_delivery_failed`; library logging is disabled.
- Atomic D1 Access-subject admission counts invalid bodies/tokens before validation.
  Better Auth independently enforces IP limits using Cloudflare's trusted
  `cf-connecting-ip`. Signup: 5/hour; login/reset/change-password: 5/5 minutes;
  resend/reset request: 3/hour; verify: 10/5 minutes; other auth routes: 60/minute.
  Do not forward browser-supplied client-IP headers from local relays.

## Local relay wiring

Create **one** `authRelayPlugin({enabled, userAccessSession, origin})` instance in
Vite. `enabled` and `userAccessSession` default false; `origin` must be exactly
`http://localhost:5173` or `http://127.0.0.1:5173`. Add the plugin before `/api` proxy
middleware. Pass its `sessionHeaders(req, accessToken)` callback to both existing
backend and provider relays. Those relays obtain/verify their Access token and
apply their own Host/loopback/origin/nonce admission first. The callback returns
only the server-held `Cookie` for the matching Access subject, or `{}`.

`createAuthRelayMiddleware(options)` exports a callable middleware with the same
`sessionHeaders` and `clearSessions` helpers for other local servers. The cloud
session cookie is never sent to browser JavaScript, browser storage, or response
headers. It is memory-only, cleared on server close/restart, signout, reset,
revocation, null session, Access identity change, Access redirect, or expiration.

Browser flow:

1. GET `/api/auth/local-session` to obtain `{nonce}` and an HttpOnly,
   SameSite=Strict, Path=/api relay cookie. Retain the nonce only in memory.
2. Send `x-pitcrew-auth-nonce` for every later auth request, including GETs.
3. GET `/api/auth/get-session` returns `null` or `{user:{...}}` without a raw
   session token. POST JSON to signup/signin/signout/profile/password routes.
4. Email opens local `/auth/verify#token=...` or `/auth/reset#token=...`. Strip the
   fragment immediately. Redeem verification via GET
   `/api/auth/verify-email?token=...` and reset via POST
   `/api/auth/reset-password` with `{token,newPassword}`. Always use the local
   relay; never render the token or write it to browser storage/logs.
5. No caller-controlled `callbackURL`, `redirectTo`, email change, actor,
   accessActor, or arbitrary auth/provider route is accepted.

## Exact approval bundle to prepare with the user

Before any of the following cloud actions, obtain approval for the concrete
resource/configuration diff and sender. Sender domain/address is still pending.
`apps/worker/auth-bindings.example.json` is a review snippet, not a deployable
configuration. Preserve all existing Worker bindings and migrations when merging.

1. Create one D1 database named `pitcrew-auth` in Cloudflare account
   `004227d2029c56b084ce15356768def3`; bind it as `AUTH_DB` on
   `pitcrew-backend`. Apply only `apps/worker/migrations/auth/*.sql` in filename
   order, with Wrangler's D1 migration ledger. These migrations assume a new empty
   DB; a populated auth DB requires a separately reviewed migration.
2. Onboard the user-approved sender domain into **Cloudflare Email Service**. It
   must use Cloudflare DNS. Review the exact DNS delta Cloudflare proposes (MX,
   SPF, DKIM, DMARC under its bounce/authentication setup) before approving it.
   Inspect existing DMARC/MX records; do not blindly overwrite them. No separate
   email-provider signup is needed. Bind native `EMAIL`; no SMTP/API token is
   required for Worker mail.
3. User privately enters an independently generated, high-entropy
   `BETTER_AUTH_SECRET` (at least 32 characters) into Wrangler's interactive
   `secret put BETTER_AUTH_SECRET --config apps/worker/wrangler.backend.json`.
   Do not put the value in this thread, command arguments, files, dotenv,
   frontend code, screenshots, or logs. Preserve `CREDENTIAL_ENCRYPTION_KEY`
   exactly. This change generates/transmits no secret.
4. Merge the approved D1 id/sender into the existing backend config. Set
   `AUTH_MODE=better-auth`, the existing exact backend origin as
   `BETTER_AUTH_URL`, the selected fixed local origin as `AUTH_CLIENT_ORIGIN`, and
   approved sender as `AUTH_EMAIL_FROM`. Keep the exact Access issuer/audience
   and two-address allowlist; keep hosted assets absent and paid execution gates
   disabled. This step does not authorize any Access policy change.
5. Review the integrated backend/frontend artifact, dry-run bundle and full test
   results, then obtain explicit deployment approval. After deployment, obtain
   approval to send verification/reset mail to the two users and verify actual
   inbox delivery, expiry, logout/reset/revocation, and cross-user isolation.
   Each user enters their own password locally. Never create passwords for them.

Any sender DNS onboarding, real D1 provisioning/migration, secret entry, real mail,
deployment, publishing, merging, or paid inference remains blocked until approved.
Cloudflare public-beta native Email Service account availability and real delivery
are not established by local fake-binding tests.

## Verification

Pinned Better Auth 1.7.7, Drizzle 0.45.2 and native Worker binding types are used.
`vp test run apps/worker/src/auth.test.ts` exercises the actual Better Auth and
Drizzle libraries inside workerd against real local D1 SQLite with synthetic
signed Access JWTs and a fake native mail binding. `node --test
scripts/auth-relay.test.mjs` covers loopback admission, duplicate/Unicode nonces,
server-only cookies, identity changes, logout, throttles, redirects and expiration.
Miniflare needs a local loopback listener; no production credentials or network
mail are needed. Independent read-only security review is required before handoff.

Official references:

- https://better-auth.com/docs/authentication/email-password
- https://better-auth.com/docs/adapters/drizzle
- https://better-auth.com/docs/concepts/rate-limit
- https://developers.cloudflare.com/email-service/get-started/send-emails/
