# Account and collaboration frontend

Based on verified GitHub main `921f4a3b43dc9570396bcf43c87420db37f15b94`.
The isolated integration branch combines account auth, durable collaboration and
the frontend; it has not been pushed, merged or deployed.

## Delivered UI

- Native username/password sign-in, private controlled enrollment, sign out and
  username editing with optional full name. Usernames are case-insensitive;
  enrollment/profile requests normalize to lowercase. Native recovery and public
  signup remain unavailable. Earlier verification/reset support is legacy-only.
  Passwords are not retained in component state. Verification/reset tokens are
  removed from the location immediately. Auth changes remount private app state.
- Account-scoped repository directory, with honest empty and interrupted states.
- Separate repository and thread invitations. Recipient-specific codes work on
  another person's local Pitcrew. A repository invitation does not grant access
  to private threads. The owner can revoke codes and remove members.
- Server participant identity and shared messages, with reconnect polling,
  visibility refresh and access-loss cleanup. Disabled execution permits human
  notes and creates no agent run. Attachments require execution.
- Messages for self and other participants prefer the actual verified author
  username. Account/member labels prefer usernames too. Full name and email are
  fallbacks for historical records without usernames. Stable account IDs select
  authorization and the local viewer picture; mutable usernames never do.
- A shared Avatar renderer for account navigation and transcript authors. It uses
  the approved account image when present and a neutral fallback when absent.
  The two supplied reference images were inspected: transcript username/initial
  and generic account icon. No personal photograph was supplied. Photo upload is
  outside the backend's current approved static-avatar contract.
- Existing T3 model selector, gold favorites, brand assets and read-only
  Permissions status are preserved. No invented enforcement controls were added.

## Local integration

`apps/web/vite.config.ts` creates one auth relay instance and passes its server
session callback to the backend and provider relays. `PITCREW_ACCOUNT_AUTH=true`
selects shared APIs; `PITCREW_ACCESS_SESSION=user-cache` requires the local user's
own Access session. Provider setup retains its separate opt-in. Defaults remain
off. The loopback server uses strict port 5173 and the admitted origin
`http://127.0.0.1:5173`; the email callback configuration must match that origin.
Each person runs a client on their own Mac. Never copy another user's session,
credentials, cache or managed runtime.

Product reads admit at most three simultaneous requests to leave one local relay
slot for writes. Their 45-second deadline includes the relay's bounded admission
and upstream work. Separate tabs have separate read budgets, so several active
tabs can still receive transient capacity errors; the UI exposes refresh/retry.

## Verification on 2026-10-06

- Web: 31 files / 192 tests; root and web TypeScript; production web build.
- Node relay checks: 34 tests, covering fixed origin, nonces, server-held cookies,
  explicit routes, sanitized failures and portable current-user Access lookup.
- Independent frontend review: account switch, stale sidebar data, late mutation,
  read deadline and refresh handoff findings fixed; no actionable findings remain.
- Actual frontend adapters, two isolated relay instances, Better Auth/Drizzle and
  local workerd D1/SQLite Durable Object: enrollment, verification, distinct user
  IDs, account-owned lists, repository/thread invitation acceptance, concurrent
  authored notes, reconnect and revocation. No fixture API backed the frontend.
- User Chrome, two isolated local origins: initial empty account; repository join
  with no private thread; separate thread join; notes sent from each account and
  visible after reload; thread removal clears the transcript; repository removal
  returns an empty directory. At 390×844 the sharing panel has no horizontal
  overflow; Escape returns focus to Share. Empty workspace avoids provider setup.

The combined probe is retained at the task workspace's
`collaboration-adapter-probe.mjs`; the auth-only probe is
`auth-adapter-probe.mjs`. They use synthetic signed Access, fake native mail and
disposable local state. The browser probe's test-only virtual-Mac bridge maps its
two loopback ports to the production relay's admitted 5173 origin; production
origin enforcement is independently covered by the Node tests.

These are local integration results, not live account acceptance. Real sender/D1
configuration, deployment approval, shared repository selection and live Bryan
onboarding remain parent integration steps. Execution remains off. No managed
runtime, production auth, real invitations, mail, model calls or deployment changed.

The reviewed execution checkpoint has now been integrated through the ten exact
approved commits ending at `003c363`. The frontend accepts project-scoped
`artifacts` capabilities and exact approval/landing receipts. Proposal or patch
status alone cannot mark a task completed. Approval uses exact target, candidate,
configuration and idempotency bindings; landing and reconciliation use the
authorization ID. See [Artifacts frontend integration](artifacts-frontend.md)
for completion and interrupted-receipt recovery checks, and
[layout/sidebar QA](frontend-layout-qa.md) for the subsequent visual refinements.
