# Account and collaboration backend slice

Local branch `codex/accounts-membership-backend`, based on GitHub main
`921f4a3b43dc9570396bcf43c87420db37f15b94` verified by read-only GitHub API.
No managed runtime, deployment, live permissions, invitations, credentials, DNS,
email service or execution gate was changed.

## Identity and ownership

The native `/app/api/*` surface uses controlled Better Auth username/password
accounts, independently of the protected legacy Access-bound email surface.
Native email metadata comes from a consumed recipient-bound enrollment grant.
Application identity is `account:<Better Auth user id>`; membership is explicit.
Usernames are canonical lowercase and case-insensitively unique in D1. They are
display/login data and never select an authorization principal. A verified
session refreshes only its existing actor's member profile metadata, preserving
membership and historical author snapshots. Full name is optional metadata.
Cloudflare administration and the email allowlist do not grant repository access.
New accounts have no repositories. The old single-project state remains isolated
and can migrate only to the configured verified owner's identity. It is not listed
as an account-owned repository or automatically shared.

The existing physical `pitcrew` RepositoryAgent DO is a directory containing up to
20 account-owned projects. Each project has one cached coordinator and distinct
state, source identity, memberships, messages, events, tasks and idempotency keys.
Synchronous SQLite transactions persist changes; concurrent async requests share
that coordinator rather than stale independent snapshots. The aggregate directory
has a 16 MiB state ceiling. Attachment bytes remain separately stored and are read
only through admitted thread/run references. Reconnect loads persisted state.

Private thread data is filtered from API context, event pages, intake links,
worker knowledge and frozen model context. Project membership alone does not grant
access to a thread. Event cursors advance across scanned hidden events. Every
poll/reconnect checks current membership. No persistent unauthenticated stream or
websocket transport is introduced by this slice.

## API contract

- `GET /api/account`: `{actor,email,displayName?,username?,avatar?}`.
- `GET /api/projects`: existing `Project[]`, account owned or explicitly joined.
- `GET /api/repositories`: `{repositories:[{projectId,name,role,status:'present',lifecycle:'registered',deletable:false}],cursor:null}`.
- `GET /api/projects/:projectId/members`, `GET /api/threads/:threadId/members`:
  `{actor,email,role,displayName?,username?,avatar?}[]`.
- `POST /api/projects/:projectId/invitations`,
  `POST /api/threads/:threadId/invitations`: `{email,role:'editor'}` ->
  `{token,invitation:{id,projectId,scope,threadId?,email,role,invitedBy,expiresAt,...}}`.
  Only the scope owner can issue it. The token is returned once; only its SHA-256
  digest is stored. Default lifetime is 24 hours.
- `GET /api/invitations/:token`, `POST .../accept`, `POST .../revoke`:
  preview/accept is recipient-bound; revoke is owner-only. Native acceptance uses
  the immutable identifier from consumed controlled enrollment, without claiming
  mailbox verification. It requires a current session, live inviter,
  unused/unexpired/unrevoked token and project membership for thread invitations.
  Invitation and member operations recheck the original session under the shared
  auth authority queue through hashing and commit. Acceptance is non-replayable.
- `DELETE /api/projects/:projectId/members/:actor`,
  `DELETE /api/threads/:threadId/members/:actor`: revokes membership and matching
  pending invitations atomically. Project revocation cascades to threads.
- Existing project/thread/change/run APIs check their owning project and thread.
  Missing/inaccessible IDs return 404; an insufficient scope role returns 403.
- `GET /api/capabilities?projectId=<selected id>`: selected project's capabilities.
  Disabled execution exposes `notesEnabled:true` and permits durable human notes;
  retry/intake dispatch returns 503 after authorization. Notes do not create runs.
  Notes with attachments are rejected, not silently truncated.
- New user message `author` is a verified account snapshot. Client-supplied author,
  principal, membership or credential owner fields cannot change it. Messages,
  member lists and presence carry the verified username; labels prefer it over
  full name or email. A renamed username retains the same account actor.

Lifecycle create/import records freeze `ownerActor`; cross-account guessed names
and unowned legacy records cannot be reconciled or deleted. A ready cleaned-up
source is registered to that account after fresh metadata ID/head verification.
Registered sources are protected from lifecycle deletion. Lifecycle remains off.

Exact existing repository adoption is a separate gated `POST /api/projects`
`{name}` action. Both approved `ADOPT_REPOSITORY_NAME` and immutable
`ADOPT_REPOSITORY_ID` must be configured, the caller must be the configured owner,
and live metadata must match. Registration reads the default-branch commit; an
empty repository uses an uninitialized base and cannot start real change work.
The historical `pitcrew-test` metadata is not fresh authorization or ownership.

## Credentials and running work

OpenRouter AES-GCM storage remains keyed by the original verified `access:<sub>`;
no credential keys or ciphertext are renamed. The initiating request freezes its
own credential actor on the run/turn, independently of `account:<id>` membership.
Retry freezes the retrying caller's credential actor. Collaborators cannot select
another payer in request JSON or read another account's secret. The UI must say
that shared task execution uses the initiating user's provider connection.

Queued runs/turns recheck current membership before admission and after async
lookups/child activation. Running revoked work enters bounded cleanup. Cleanup and
existing receipts still reconcile; revocation does not discard durable resource
ownership. The watchdog is scheduled only for first admission, so frequent result
polling cannot keep postponing it. Conversation stop fences resume and disposes
its active harness.

## Local client integration

Instantiate one tested auth relay plugin, then pass its `sessionHeaders` callback
to backend and provider relay plugins. Set `sharedApi:true` with explicit opt-ins.
Both relays verify loopback sockets, exact Host/origin, Access identity and local
nonce; they rebuild headers and forward only the server-held cloud auth cookie.
Browser Cookie/Authorization/identity hints are not forwarded. Product paths are
explicitly allowlisted; unknown API paths cannot fall through to the fixture.

- Auth bootstrap: `/api/auth/local-session`; subsequent auth requests use
  `X-Pitcrew-Auth-Nonce`.
- Product mutation bootstrap: `/api/local-session`; writes use
  `X-Pitcrew-Local-Nonce`.
- Existing repository/provider helper nonce routes remain separate.
- Auth admits only configured `localhost:5173` or `127.0.0.1:5173`; use strict port.

The cached Access command now uses the current OS user's `homedir()` for both
helper path and HOME. Default macOS helper path is that user's
`Library/Application Support/Pitcrew/bin/cloudflared`. Another platform may supply
an absolute trusted `cloudflaredPath`/`homeDirectory` in local setup code. Each
person installs/signs in independently; never copy the owner's cache, auth relay
cookie, provider key or managed runtime to Bryan.

## Rollout approvals and remaining blockers

1. Approve the combined reviewed source patch and intended deployment target.
2. Approve D1 creation/binding and ordered auth migrations, private Better Auth
   secret provisioning, sender identity/domain, Cloudflare Email Service binding
   and any DNS/paid-plan work. See `auth-setup.md`. None is configured live here.
3. Freshly inspect the selected `pitcrew/pitcrew-test` source ID/default branch/
   tokens. Approve exact adoption and, because the historical source is empty,
   an initial commit write separately. No live repo was adopted or initialized.
4. Approve deployment, explicit local installation configuration, exact repo and
   thread recipient/role, and real invitation creation/delivery. No invitation has
   been issued to the colleague.
5. Execution and infrastructure gates remain OFF. Real end-to-end task completion
   still needs a separately reviewed execution rollout and own-user provider
   connection. Existing credentialed Git publishing from a mutable candidate
   sandbox and the Pi tool-budget stop behavior remain execution safety blockers.
   Passing ACL/notes tests is not proof that paid execution is ready.
6. Run two independent user-local client sessions against the deployed approved
   backend, then verify shared task execution, reviewed outcome and revocation.
   Synthetic workerd tests prove local logic, not live email or external Git runs.
