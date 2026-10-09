# Local recipient invitation browser QA

Run from the repository root using its existing dependencies and Node with type
transformation support:

```sh
node --experimental-transform-types apps/web/poc/recipient-invitations-browser-check.mjs /tmp/pitcrew-recipient-qa
```

This development-only checker bundles actual AuthGate, AccountSummary,
AccountRepositories, RepositoryManagement, Collaborators, InvitationGate, styles,
and HTTP adapters. It starts temporary real Miniflare/workerd, Better Auth 1.7.7,
D1, and the production auth/backend relay handlers. Two isolated Chromium contexts
sign in through actual controls using newly enrolled synthetic accounts. Only the
Artifacts provider is replaced with a bounded fixture; unexpected external Worker
transport throws, and Chromium renderer requests are confined to this run's origin.
Passwords, cookies, session material, and invitation tokens are excluded from the
request ledger. No human profiles, accounts, credentials, or cloud access are used.

The listener uses IPv4 loopback and an ephemeral port distinct from 5173. It checks
the actual incoming Host/Origin, then a QA-only adapter maps these to the auth
relay's fixed development origin. Outbound relay URLs are checked against the
configured backend origin and dispatched directly to the local Worker. There is
no server or request at the real developer origin, no Access credential lookup,
and no provider/network transport. This browser check proves relay/session/body
handling and UI-to-Worker behavior **after** that adapter. Exact production
incoming-origin admission requires separate relay tests.

Scenarios cover one canonical creation/settings name, optional description,
explicit Create sending consent, immutable physical UUID identity after rename,
deletion off, username repository links, email thread codes, recipient URL/manual
preview and acceptance, immutable-account grants, target-thread isolation,
unavailable recipients, ephemeral token storage, resource/unmount late responses,
signout/account switching, acceptance callback fencing, and mobile DOM bounds.
Resource/unmount races pause genuine D1 recipient lookup results. Account-switch
and acceptance races delay delivery of completed genuine Worker responses at the
fixture transport, allowing real logout to complete independently of the
Worker's authority queue. Fixture controls never substitute production authority.

The browser uses native mouse/text events and rendered accessible labels; it
does not inspect React internals. It removes its new profile and build directory
and disposes Miniflare. `PITCREW_QA_CHROME` can select an installed Chromium binary;
`PITCREW_QA_SHARING_HARNESS` can select another isolated checkout's local test
harness. No dependency installs are performed.

The evidence directory contains a safe request/scenario ledger (`results.json`)
and captured desktop/mobile PNGs. Failure evidence includes the owner DOM text.
These are isolated Chromium results, not Codex IAB, human-session, live-provider,
mail-delivery, or production persistence verification. Screenshot files are
captured evidence; Library's 403 blocks any claimed inspection through Library.
The independent repository checker remains synthetic HTTP transport and reports
its own 27-case ledger separately.

Validation on the invitation/backend/fixture checkpoints `6081748` + `cb3e82b`,
`e707372`, and `693acf5`: 11 real local-backend browser scenarios passed; the
updated repository checker passed 27 synthetic-transport browser scenarios.
Both runs reported zero renderer exceptions. Five invitation and eight repository
PNG captures were produced, with no claimed pixel inspection.
