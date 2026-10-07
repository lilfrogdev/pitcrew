# Local username/password accounts

Each person runs the frontend on localhost:5173. Cloudflare hosts only the shared
Worker, D1 account database and existing repository Durable Objects. The active
account design is username/password: no email delivery, domain, SSO, OAuth,
public signup or implicit provider/account linking. Earlier Access-bound email
verification code remains available only on the protected legacy surface.

## Identity and enrollment

Native enrollment admits exactly `dev@lilfrogdev.com`,
`bryan.aldair.zamora@gmail.com`, `john.cena@example.com` and
`lara.croft@example.com`. The current setup creates only the two ordinary personas
John Cena (`johncena`) and Lara Croft (`laracroft`); the personal identifiers retain
existing compatibility and are not being enrolled in this setup. The example.com
addresses are internal unverified identifiers, not deliverable mailbox claims.
No demo mode, special role or additional feature restriction is introduced.
An operator-issued 32-byte random capability is bound to one recipient
in `auth_enrollment`; only its SHA256 hash persists. The user opens their private
`/auth/enroll#code=...` link and personally chooses a password and username, with
an optional full name. Usernames contain 3–32 ASCII letters, digits or underscores
and are stored in lowercase. Case variants identify the same username. The full
name remains profile metadata and may be empty; messages and collaborator labels
prefer the actual verified username.
The fragment is immediately removed from browser history. Neither typed email
nor the allowlist alone establishes eligibility. The account's email remains
`emailVerified=false`; no mailbox verification is claimed.

Atomic consumption admits at most one redemption. Better Auth 1.7.7 performs
real signup and native password hashing; no automatic sign-in follows enrollment.
The immutable `enrollment:<grant-id>` provenance key occupies the existing
`access_actor` column in this mode and is explicitly distinct from Access proof.
The consumed grant must separately bind its exact recipient and `user.id` before
any session can authorize the account. Partial creation burns the grant and fails
closed; operators must inspect and deliberately resolve partial state. The issuer
cannot replace an existing account by email or revive a consumed capability.

Product ACLs and new provider credential records use `account:<user-id>`. Existing
`access:<sub>` credential ciphertext and repository ownership remain untouched;
password accounts cannot read, rebind or migrate them by matching email. Any
legacy linkage needs separate explicit proof and approval. Provider key entry is
not needed for account setup or notes, and paid execution remains disabled.

## First native project owner

A newly enrolled native account has zero memberships. Matching the operator's
email never bootstraps legacy/root ownership. To authorize adoption of one
existing repository, an operator must approve all three exact backend values:
`ADOPT_ACCOUNT_ACTOR=account:<native-user.id>`, `ADOPT_REPOSITORY_NAME`, and
`ADOPT_REPOSITORY_ID` (the immutable ID verified independently for that source).
Obtain the actor from the authenticated `/app/api/account` response and verify
that it belongs to the intended existing native account. This is a separate
operator authorization; enrollment alone cannot grant it. The example config
contains placeholders and grants no real account access.

`GET /app/api/project-adoptions` returns `[{name,repositoryId}]` only to the
approved native session, or `[]` when approval is missing, belongs to another
account, or the source is already registered. `POST /app/api/projects` accepts
exactly `{name,repositoryId}` and reads that existing source's metadata and real
head. The source ID must still match. The original session and exact approval
are rechecked through the shared authority queue after external awaits, and the
new project is registered atomically with only that stable account as owner.
Duplicate/concurrent claims fail. This route performs no physical repository
creation/import and enables no paid execution or infrastructure action.

The resulting project starts with new collaboration state. It does not copy,
rebind or expose any legacy `access:<sub>` ACL, identity binding, project state,
or provider ciphertext. Existing legacy projects remain inaccessible unless
separately authorized. The new owner may invite another eligible native account through the normal
project/thread invitation routes; another native account has no visibility
before accepting its specific invitation. All execution, conversation,
infrastructure, lifecycle and publisher flags stay disabled during onboarding.

## HTTP and local transport

The exact cloud origin is `https://pitcrew-backend.pitcrew-004.workers.dev`.
The password surface is `/app/api/*`, with a method/path allowlist in
`password-ingress.ts`. It revalidates the path in the singleton repository DO and
normalizes to `/api/*` only there. Unknown methods/routes, recovery/signup/OAuth,
paid dispatch, repository lifecycle and landing/publisher mutations are
unavailable on that surface. Explicitly approved adoption of an existing source
is available as described below. Membership checks still gate shared product routes.
Caller identity/Access headers never select a principal.

Password auth endpoints are POST `auth/enroll`, `auth/sign-in/username`,
`auth/sign-out`, `auth/revoke-sessions`, `auth/update-user`, `auth/change-password`,
and GET `auth/get-session`. Sign-in body is `{username,password}`. Enrollment body
is `{code,password,username,name?,image?}`; email comes from the grant and remains
immutable account metadata. Native email sign-in and username-availability routes
are closed. Unknown, ineligible and wrong-password sign-ins share the same public
error. Profile images are existing local avatar paths.
Password changes require the current password and revoke other sessions.
Verification, reset and email recovery routes are unavailable; there is no
password-reset promise in the UI. Recovery requires a separately reviewed
operator mechanism, not reissuing an enrollment for an existing email.

Cloud cookies are Secure and HttpOnly; a single local relay keeps them only in
server memory. The browser receives an unrelated HttpOnly, SameSite=Strict,
Path=/api local cookie and an in-memory nonce. The auth, product and provider
relays share one session instance. They require strict loopback sockets, Host,
Origin/fetch-site checks and request nonces, target a fixed cloud origin, reject
redirects and never acquire Cloudflare Access tokens in password mode. Logout
clears the local credential even when transport fails; generation fences reject
late sign-in/session responses after a newer revocation. Restart loses local
sessions. Sessions last at most 30 minutes; cookies do not cache authority.

Durable global/IP admission runs before body/token lookup, with additional
recipient-purpose enrollment limits and normalized username sign-in limits. Case
variants share one sign-in bucket. Atomic D1 counters survive a restart. Bounded indexed
cleanup removes admission rows older than 24 hours. JSON bodies are bounded to
8192 bytes before they enter the shared visualization authority queue. Session
creation, checks and revocation finish inside that queue; successful signout and
revoke-all require primary-store session deletion to be confirmed.
Typing presence reads and writes also recheck their original session in that
queue after bounded body admission. A revoked session cannot refresh or read
presence; current thread membership and the authenticated username govern the
ephemeral lease. Presence disappears on backend restart and never becomes a
stored message or draft.

## Username upgrade

Better Auth's supported username plugin supplies native password verification
while controlled enrollment remains the only account-creation path. The optional
display-username column is disabled. No dependency, secret, binding, Access policy
or client-origin change is required.

Apply the append-only `0004_username_identity.sql` migration before deploying this
version. It first builds a unique index on `lower(user.username)`, then lowercases
existing usernames. The index enforces case-insensitive uniqueness atomically for
concurrent enrollment and profile updates. Preflight existing rows with:

```sql
SELECT lower(username), count(*) FROM user
GROUP BY lower(username) HAVING count(*) > 1;
```

If collisions exist, stop and deliberately rename an affected account with its
owner. The migration fails before rewriting rows and never merges identities.
Existing IDs, email metadata, credential/password hashes, session and grant
bindings remain intact. Existing email-backed records sign in using their stored
username and current password after migration. Legacy Access-bound email auth is
unchanged and retains its exact two-person admission restriction.

Username changes never rename `account:<user.id>`, rekey credentials or change
memberships. Before any profile write, the original request's session is read
again from the primary store inside the shared authority queue and must retain
the same user ID. That fresh identity refreshes only its existing actor's member
profile metadata. Revoked requests and stale API instances cannot restore old
labels. Historical message author snapshots retain the username
verified when the message was admitted; client-supplied author fields are ignored.

The combined upgrade includes append-only
`0005_native_enrollment_recipients.sql`, after migration 0004. It rebuilds only
`auth_enrollment` with the exact four-recipient CHECK, copying every grant ID,
recipient, token hash, expiry, consumption timestamp and consumed user binding.
It retains uniqueness, hash-length, consumption and user foreign-key constraints.
Apply the entire file as a Wrangler migration transaction or a single D1 batch;
do not execute its table-rebuild statements individually. A failed transaction
must retain the original table and migration state. Previously deployed migration
0003 is unchanged.

One shared server-side recipient constant governs native Worker eligibility,
private issuer validation and the password relay's session projection. Legacy
`AUTH_EMAILS`, `BACKEND_ACCESS.emails`, `ACCESS_EMAIL`/`ACCESS_EMAILS` and the
whole-host Access policy continue admitting exactly the two existing personal
identities. Adding native identifiers does not add Access eligibility or prove
mailbox ownership. Native sessions keep `emailVerified=false`.

This combined source change needs publication/CI plus its own reviewed migrations,
backend deployment and sequential local client activation. It is separate from
the approved PR49/PR50 upload/session rollout. No live eligibility, enrollment
grants, accounts or passwords are changed while preparing that approval.

## Ordinary persona sharing

John Cena and Lara Croft both begin with zero repository memberships. To make an
existing source available, separately authorize John Cena's actual authenticated
`account:<user.id>` and that source's exact name/immutable repository ID through
the adoption gate above. Neither username nor internal identifier selects an
owner, imports a legacy ACL or inherits an existing provider credential.

The ordinary sharing form still targets an account's internal recipient email.
John Cena creates a repository invitation for `lara.croft@example.com` and privately
hands its code to Lara Croft. Lara signs in as `laracroft` and accepts that specific
code. Acceptance matches her grant-bound immutable identifier and records her
stable account actor; it does not claim that a mailbox was verified. Repository
acceptance grants the existing editor role. Private threads need a separate
thread invitation after repository membership. Invitations, acceptance, revocation
and member removal recheck the original session under the auth authority queue;
logout during body or token-hash awaits cannot admit a stale membership change.

No mail delivery or automatic invitation sending is used. Each reviewer runs the
ordinary local client; concurrent personas require separate clients or browser
profiles because tabs in one browser profile share its auth cookie. Private
passwords and enrollment links are handled personally by the user. Sharing an
account's credentials later is a human-owned handoff, not an agent action.
The identities use IANA's [reserved example domains](https://www.iana.org/help/example-domains)
without relying on an example.com mail or HTTP service.

## Proposed setup sequence

The user requested two ordinary personas with a local frontend. The combined
publication, migration/deployment and client-refresh proposal must be approved
before live changes. This sequence records the private handoff; it does not permit
unreviewed source, broader policy changes or agent-owned password/capability entry.

1. Publish the final independently reviewed source and complete GitHub CI. Formal
   security scanning remains reactive under the user's existing instruction.
2. Recheck the existing `pitcrew-auth` database and migration history in account
   `004227d2029c56b084ce15356768def3`, with exact database ID
   `2bddc1ef-cddd-47bb-b368-e8ad1bad0095`. No new database, OAuth consent or auth
   secret is needed for this upgrade. Run the username collision preflight and
   stop on unexpected migration state or conflicting usernames.
3. Apply only the pending reviewed migrations 0004 and 0005 through Wrangler's
   filename-ordered migration runner, preserving all prior data and bindings.
   Keep the table rebuild within its migration transaction. Verify its four
   recipient CHECK and all constraints after application.
4. Preserve the existing `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` and
   namespace bindings. Inspect binding names only; never read or copy values.
   Users personally handle later real passwords and enrollment capabilities.
5. Deploy the reviewed guarded Worker first, with the auth binding example merged
   into the complete existing backend config. `AUTH_MODE=password-only`, fixed
   `BETTER_AUTH_URL`; no EMAIL binding or hosted frontend assets. Preserve
   `EXECUTION_MODE=disabled`, `INFRASTRUCTURE_ADMISSION_ENABLED=false`,
   `CLOUD_CONVERSATION_ENABLED=false`, `REPOSITORY_LIFECYCLE=disabled`,
   `TRUSTED_PUBLISHER_ENABLED=false`, existing limits and disabled preview URLs.
6. After verifying guard failures, retain the existing more-specific Access app
   **Pitcrew password API** for
   `pitcrew-backend.pitcrew-004.workers.dev/app/api/*`, Bypass/Everyone policy scoped
   to that app. Keep the existing whole-host app
   `b8da5b4f-6783-4b88-b78c-0f0c381e7b9d` and its exact two-user allowlist unchanged.
   No Access policy change is part of this upgrade. Existing `/api` admin/legacy
   routes stay protected.
7. The sole runtime writer activates clients sequentially using
   `PITCREW_ACCOUNT_AUTH=true` and `PITCREW_AUTH_MODE=password-only`, preserving
   current overlays, local drafts/settings, fixture data, launcher and dependencies.
   No Access sign-in is requested. Verify closed signup/email routes, unauthenticated
   private-route denial, absence of SSO on the new prefix and continued Access on
   legacy routes before user-owned enrollment.
8. In the operator's own private terminal, run
   `node scripts/issue-account-enrollment.mjs <approved-config.json> john.cena@example.com`,
   then separately repeat for `lara.croft@example.com`.
   The reviewed script requires a real terminal, validates the exact account,
   Worker and D1 binding, writes only hash-bearing temporary SQL through Wrangler,
   removes its temporary files and releases the link only after D1 confirms the
   new grant. The user privately handles each recipient-bound link and personally
   enters each persona's password. No personal accounts are created by this setup
   and no automated sending occurs.
   After the user's private setup, verify username login/logout, wrong-password
   throttling, two-account ACL isolation and the separately authorized repository
   adoption/invitation flow. No agent submits or captures passwords or grant links.

Private invitation handoff and actual password entry are human-owned steps.
No agent executes the real invitation issuer or
captures its output. If a rollout check fails, disable only the new scoped Access
exemption and retain the prior protected Worker/runtime version. No paid task,
email delivery, DNS change, hosting or legacy migration belongs to acceptance.

Cloudflare's [path precedence documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
explains the more-specific app boundary. Better Auth's
[options reference](https://better-auth.com/docs/reference/options) describes
signup and email/password configuration. The normal library instance disables
signup; a separate private instance enables its real signup endpoint only after
atomic capability consumption and adds a grant-bound creation hook.
The [username plugin documentation](https://better-auth.com/docs/plugins/username)
describes username password sign-in, normalization and the disabled optional
display-username field. The implementation is checked against installed Better
Auth 1.7.7 in real workerd/D1 tests.
