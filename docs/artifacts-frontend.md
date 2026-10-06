# Reviewed Artifacts frontend integration

The isolated `codex/collaboration-integration` branch includes exactly the approved
execution sequence: `dd51851`, `8d9ad45`, `ca8bebf`, `5b74587`, `04205f0`,
`e70bb54`, `4f00e2a`, `67cf2fa`, `0517119`, `003c363`. Their cherry-picked heads
end at `e5658cb`. Existing account/auth commits were not duplicated.

## UI contract

- Project-scoped capabilities admit `fixture` or `artifacts`. Disabled, missing,
  failed or unknown capabilities disable source actions. Fixture copy remains
  explicitly a simulation.
- Approval submits exact base/candidate/configuration and one idempotency key.
  The response must match backend, run, hashes, configuration, valid expiry and
  authorization ID. Landing is a separate explicit action.
- The source result must match that authorization and exact candidate SHA.
  A landed authorization without a landed result cannot mark completion. Header,
  sidebar, evidence and diff-selector status do not trust a completed label alone.
  Successful source receipt removes the obsolete approval/action UI.
- Interrupted results require reconciliation; no source landing is automatically
  replayed. The original approval key and receipt are saved before requests under
  account/project/run-scoped browser storage. Consumed or interrupted records
  restore as uncertain, and cached success requires fresh server proof. A
  canonical landed receipt from the authenticated snapshot takes precedence.
- A crash before sending can leave the server permission unconsumed. If a user’s
  receipt check fails, the UI recovers the same original approval key and requires
  the same authorization ID and full binding. An authorized server response can
  re-enable a separate Land button; recovery never calls landing automatically.
  Browser storage failure blocks a new source action before it is sent.

## Verification

Combined backend verification passed 45 files / 219 tests; execution passed 104
tests; web passed 33 files / 221 tests; all 34 Node relay tests passed. Backend, execution and web TypeScript and
the production web build passed. Frontend tests cover exact source receipts,
backend/SHA/authorization mismatch, disabled capabilities, authorization-only
reload, interrupted reload with the actual server snapshot shape (no uncertain
`run.landing`), account isolation, pre-send interruption and storage failure.

After the separate repository formatter cleanup, the full `pnpm typecheck` and
`pnpm test` gates passed, including verification/evaluation packages. `vp check`
passed with zero errors and six pre-existing backend lint warnings. Both
`build:worker` and `build:backend` completed their explicit Wrangler dry runs.
Parsed auth migration JSON values were identical before/after formatting; active
backend settings were not modified. Local checks reused the existing dependency
trees with pnpm dependency verification set to warn, avoiding an automatic
replacement of the shared dependency directory.

Independent frontend review identified the two reload edges above; both were
fixed and re-reviewed with no actionable findings remaining.

User Chrome at 1440×1000 and 390×844 checked separate approval/land actions,
synthetic interrupted response, reload, original receipt reconciliation, completion
and concise final copy. No horizontal overflow occurred. These browser receipts
were isolated UI fixtures. Backend/execution tests exercised the actual reviewed
contracts locally; neither proves hosted Artifacts CAS behavior. Temporary QA
entrypoints were removed before delivery.

## Rollout status

The active backend keeps execution, infrastructure admission and cloud conversation
off. The example Artifacts configuration also keeps publisher, landing and CAS
conformance gates off. This integration does not configure or deploy them.

Live acceptance still requires approved source adoption/initialization, disposable
hosted Artifacts CAS conformance, sender/D1/private secrets and migrations, pinned
publisher image/bindings/key and resource envelope, deployment, independent local
installation, real invitations, the initiating user’s budgeted provider connection,
one task and one source merge. See [first shared task plan](first-shared-task-plan.md).
No managed runtime, production account settings, real mail/invitations, model calls,
repository source write, push, merge or deployment occurred.
