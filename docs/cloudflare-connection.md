# Cloudflare connection preparation

Verified on 2026-10-05 from local checkout `7678dbf` and the user's Mac Google Chrome, profile `Your Chrome`. This branch is `codex/cloudflare-connection` in an isolated clone; it does not change the managed UI/runtime on port 5173.

## Verified update: 2026-10-05 04:44 UTC

The user approved the exact proposed OAuth grant and a **$100 USD/month total Pitcrew Cloudflare budget**, with subscription details to be confirmed before purchase. The user then requested a separate Cloudflare account.

- Wrangler OAuth callback completed successfully. `wrangler whoami` confirms OAuth authentication and exactly `user:read`, `offline_access`, `account:read`, `workers_scripts:write`, `artifacts:write`, `containers:write`, `cloudchamber:write`, `ai:write`. No raw credential values were read or transmitted manually.
- Refreshable credentials are stored by Wrangler at `/Users/lilfrogdev/Library/Preferences/.wrangler/config/default.toml`. The default-scope warning is expected for the intentionally narrowed grant; do not run a default login to expand it.
- Created a separate account **Pitcrew**, ID `004227d2029c56b084ce15356768def3`, at `2026-10-05T04:41:52.035760Z`. Existing OAuth can see it in `whoami --json`; no second authorization was started. Browser consent was completed by the user.
- Creation UI explicitly said free-tier defaults, with no inherited payment methods, plans, subscriptions or entitlements. There was no new agreement on the creation form. The browser initially kept showing progress; both a read-only account API result and the Pitcrew dashboard verify creation. Do not retry account creation.
- `wrangler.backend.json` is now pinned to **Pitcrew's account_id**. No resources or paid execution belong in the other accounts.
- Worker/model/Artifacts/Container provisioning remains pending. $100 is an authorized operating budget, not a Cloudflare-enforced hard cap. Subscription purchase remains pending explicit checkout review/confirmation.

## Initial inspection (before approved OAuth and account creation)

- Browser: signed in to account `lilfrogdev`, account ID `f0c2450b36acc78da326d2bfbd84346b`, Workers subdomain `lilfrogdev.workers.dev`.
- Workers dashboard: no projects, zero requests. Containers dashboard explicitly shows "Enable Containers" and requires purchase of Workers Paid. Workers plan: **Free**. Dashboard says Zero Trust must be set up before requiring Access sign-in.
- Wrangler 4.147.0 `whoami`: **not authenticated**. No expected Wrangler OAuth config file or Cloudflare token/key/account environment variable is present. Credential values were not read.
- Repository production config: execution disabled, no Artifacts binding, AI binding, model configuration, named registered image, project base SHA, or access configuration. Development runs use fake execution. Emulator passes do not establish any live connection.
- No Cloudflare resource, subscription, credential, public route, domain, or model invocation was created by this task.

## Safe local configuration

`apps/worker/wrangler.backend.json` packages only the backend and its three SQLite Durable Object classes. It has no assets binding, disables workers.dev and preview URLs, and keeps execution disabled. The existing development config remains unchanged.

`pnpm build:backend` is a **dry run**, with no frontend build/upload or deployment. It succeeded: 5414.09 KiB bundle, gzip 963.22 KiB, with only REPOSITORY, CHANGE, REVIEW and disabled execution bindings.

`pnpm cloudflare:preflight` is an offline blocker report. Exit 1 is expected until configured. It never reads credentials, calls Cloudflare, or proves live authentication. Even exit 0 only means configuration is ready for live verification.

## Minimal live services

1. One backend Worker and three SQLite Durable Objects: RepositoryAgent for shared coordinator state, ChangeAgent for execution, ReviewAgent for independent review.
2. One Artifacts namespace (proposed `pitcrew`) containing the imported repository, and a pinned base commit. No R2 bucket is needed for the current Git-based adapters.
3. Container applications for **both ChangeAgent and ReviewAgent**: both use `ctx.container.images`. Bind a named sandbox image pinned to its managed-registry SHA-256 digest. The existing Dockerfile requires an approved digest-pinned Node >=22.18 Debian base image. No image build, registry upload, or application provisioning has happened.
4. Workers AI via an `AI` binding and explicit real `MODEL_CONFIGURATION`, or separately approved OpenAI/Anthropic BYOK secret. Workers AI avoids distributing a model-provider key. Web Search/AI Gateway is optional later and is not a core connection prerequisite.
5. Authenticated API ingress and a local relay. UI stays on the Mac. Keep Cloudflare control-plane and model credentials out of browser JavaScript. Do not enable fixture identity on the deployed backend.

After approval, the backend configuration needs an `artifacts` array with `binding: ARTIFACTS`, `namespace: pitcrew`; `ai: {binding: AI}` for Workers AI; `containers` entries for both classes with `scheduling_policy: durable_object` and `images.sandbox.image` set to the approved `registry.cloudflare.com/...@sha256:...`; and vars `SANDBOX_IMAGE: sandbox`, `PROJECT_BASE_SHA`, `ARTIFACT_REPOSITORY`, `CONFIGURATION_REVISION`, `MODEL_CONFIGURATION`. Set `EXECUTION_MODE: cloud` only after service/auth/budget checks.

## Access and local runtime contract

The current `principal()` verifies Cloudflare Access issuer, audience, hostname, and exactly one `ACCESS_EMAIL`. Mutating requests require the remote URL's own Origin. The local UI's `/api` proxy therefore needs an authenticated Mac relay that supplies the correct backend request context, or a separately designed user identity flow. A direct cross-origin browser URL alone will not work. Cloudflare browser sign-in does not provide this application session.

The current singleton RepositoryAgent key is `pitcrew`; actor authorization is single-email. Product direction is multiplayer by default. Preserve per-person identities and thread membership when the integration owner designs auth; do not deploy shared service credentials to invited people's browsers. Invitations/ACL changes are outside this connection preparation.

Runtime owner task: `01a1092c-e9ba-77ae-a9ae-32af249660ff`. This branch changes no web files, ports, composer behavior, or managed runtime. Proposed contract is local `/api` -> authenticated Mac relay -> private Cloudflare backend. Relay/auth integration remains outstanding.

## Credential approval

The user completed the approved narrowed Wrangler OAuth consent. The verified grant uses exactly:

- `account:read`, `user:read`: account details/membership and user info.
- `workers_scripts:write`: Workers scripts, Durable Objects, subdomains, triggers and tail data.
- `artifacts:write`: Artifacts data/registries.
- `containers:write`, `cloudchamber:write`: Workers container/platform management.
- `ai:write`: Workers AI catalog/assets.
- `offline_access`: Wrangler adds this automatically; a refreshable credential is stored locally until revoked.

Wrangler scope names/descriptions were checked with `wrangler login --scopes-list`; automatic offline_access was confirmed in the installed CLI. OAuth is potentially broad across accounts the user can access, unlike an account-scoped API token. No Pages, DNS/routes, KV, R2, or billing permission is requested. The action-time user approval for this grant was received; no broader grant is authorized. If an account-scoped custom token is preferred, the user must create and store it through the official dashboard/secret manager; never paste it in chat. Do not inspect or copy browser cookies/tokens.

Account credentials must not enter sandboxes. Existing transport mints 300-second repo-scoped read/write Artifacts leases for Git operations; approval of that runtime delegation is part of enabling live execution. Do not manually transmit raw lease tokens. Repository import needs separate approval for any new GitHub access or private source transfer.

## Budget needed before live execution

Pitcrew is currently Free. Containers and Artifacts require **Workers Paid at $5/month plus usage**. The user approved a $100/month total operating budget; do not purchase the subscription until the actual checkout agreements and final total are confirmed.

- Containers: monthly includes 25 GiB-hours RAM, 375 vCPU-minutes CPU, 200 GB-hours disk; overages are $0.0000025/GiB-second, $0.000020/vCPU-second, $0.00000007/GB-second. Default `lite` is 256 MiB RAM, 1/16 vCPU and 2 GB disk. Ten active minutes at full CPU would cost roughly $0.001284 beyond included allowances, excluding DO/Worker/model/network/log charges. This is a small validation workload estimate, not proof that lite can run project builds. Run size and concurrency still need measured limits.
- Artifacts: Paid only; operations/storage billing begins October 14, 2026. Includes 10,000 operations/month and 1 GB; overages $0.15/1,000 operations and $0.50/GB-month.
- Workers AI: 10,000 neurons/day included; on Paid, overage $0.011/1,000 neurons. An economical candidate already covered by the repo's model tests is `@cf/qwen/qwen3-30b-a3b-fp8`: $0.051/million input and $0.335/million output tokens. Capability/quality for coding still needs live validation.

Worker, Durable Object, egress and logging usage are separate. A billing alert is not a hard spending cap. A strict approved budget requires bounded run duration, concurrency, model tokens and an execution kill switch before autonomous operation; the operating budget is authorized by the user, while purchase confirmation and live execution controls remain pending.

## Required live evidence after approvals

Confirm authenticated `whoami` with the selected account, Paid/service entitlement, deployed bindings and pinned image. Probe Artifacts repository metadata without returning tokens. Then run one approved bounded sandbox smoke test (start, Node/Git version, destroy), one bounded real model call, and a local UI API round-trip through authenticated ingress. Record actual Cloudflare IDs, deployment version, timestamps and costs. Only then call the backend connected. A dry run, fixture test or browser session alone is insufficient.

Sources checked on 2026-10-05:

- https://developers.cloudflare.com/containers/platform/pricing/
- https://developers.cloudflare.com/artifacts/platform/pricing/
- https://developers.cloudflare.com/artifacts/guides/authentication/
- https://developers.cloudflare.com/artifacts/get-started/workers/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/workers-ai/platform/pricing/

## Budget controls proposal after subscription approval

Official Cloudflare budget alerts only send email; they **do not pause or cap usage**. They cover usage-based charges, so the $5 base subscription and applicable tax also need room inside the $100 total budget. No hard $100 account cap has been verified.

Proposed initial limits, to implement and verify before autonomous paid runs:

- One active change run, one independent reviewer, smallest measured viable instance size; at most one live container per class initially.
- Ten-minute wall-clock sandbox lifetime with durable destruction/cleanup, bounded command duration, no idle `sleep infinity` surviving a completed run.
- Explicit model/token ceilings, bounded retry count, per-run reservation and monthly admission ledger. Refuse new paid work when the conservative reservation reaches the operating threshold.
- Usage alerts at $50, $75 and $90; pause new admission at the $75 internal estimate, destroy active sandbox workloads by the $90 internal threshold, reserve remaining budget for subscription, tax, delayed accounting, storage, and other services. These controls mitigate overspend but do not guarantee a total cap while Cloudflare's reporting is delayed or other actors can use the account.
- Keep execution disabled until the controls and bounded live probes are reviewed. Do not schedule automatic paid activity just because credentials exist.

These are proposals, not controls already active on Cloudflare. Subscription checkout in the new account still must establish exact total/tax, payment type, recurring terms and agreement links before purchase. General cancellation documentation says cancellation/downgrade takes effect at the end of the current billing period, with no refund for unused time; use the actual Workers checkout for account-specific confirmation.

Additional sources:

- https://developers.cloudflare.com/billing/manage/budget-alerts/
- https://developers.cloudflare.com/billing/manage/cancel-subscription/

## Actual Pitcrew Workers checkout inspected

Checkout: https://dash.cloudflare.com/004227d2029c56b084ce15356768def3/workers/checkout/payment

- Current plan remains Free. No upgrade was confirmed.
- Workers Paid order summary: **$5/month**, base fee charged today; usage above included allowances billed monthly.
- New account has no saved payment method. Form offers credit-card billing details and PayPal. No card, address, VAT/GST, or other payment details were entered or copied. User must enter billing information securely in the browser.
- Taxes: no exact tax or final tax-inclusive total is displayed before billing address entry. Do not call the $5 display a verified tax-inclusive total.
- Two unchecked agreements: Terms of Service/Privacy Policy, and authorization to charge the card for usage beyond free limits each month until cancellation. Checkout explicitly says cancellation is effective at the end of the current billing period.
- Actual agreement links: https://www.cloudflare.com/terms and https://www.cloudflare.com/privacypolicy ; usage rates link https://www.cloudflare.com/plans ; cancellation link https://dash.cloudflare.com/?to=/:account/billing/subscriptions . No checkboxes were checked.
- Final action is **Confirm upgrade**. It was not clicked. Obtain action-time confirmation for these agreements/purchase after user enters payment details and the final total/tax is available.
- Browser tab `2120546198` in the user's Mac Google Chrome is kept open for secure handoff. Visual evidence: `/Users/lilfrogdev/Documents/Codex/2026-10-04/task-19/evidence/pitcrew-workers-checkout.png`. Account creation evidence: `/Users/lilfrogdev/Documents/Codex/2026-10-04/task-19/evidence/pitcrew-account-created.png`.

Authentication is live and verified, account creation is verified, but backend execution is not connected: no Worker, DO migration, Artifacts repository, sandbox image/application, model call or local authenticated API ingress has been provisioned or exercised.
