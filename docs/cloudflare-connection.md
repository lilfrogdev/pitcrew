# Cloudflare connection preparation

Verified on 2026-10-05 from local checkout `7678dbf` and the user's Mac Google Chrome, profile `Your Chrome`. This branch is `codex/cloudflare-connection` in an isolated clone; it does not change the managed UI/runtime on port 5173.

## Verified update: 2026-10-05 04:44 UTC

The sections below record earlier inspection. The latest state is in "Paid plan and disabled backend provisioned" at the end; it supersedes earlier pending/free-plan statements.

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

## Paid plan and disabled backend provisioned

The user completed the Workers checkout themselves. Read-only inspection in Mac Chrome verifies Pitcrew's **Paid** card marked **Current plan**, at $5/month plus usage. Payment details were not read. Tax or actual invoice total has not been verified.

Cloudflare accepted `pitcrew-backend`, deployed at 2026-10-05T04:53:28.850Z, version `8504fc89-9a3f-4d7c-8a4c-56430cba15d2`, serving 100% in `wrangler deployments list`. It has three SQLite Durable Object bindings and `ARTIFACTS` bound to namespace `pitcrew`. **No targets deployed**: no workers.dev, preview URL, custom route, or frontend. `EXECUTION_MODE=disabled`. Worker limits are CPU 1000ms/invocation and 20 subrequests. This verifies the control plane deployment, not the functional execution path.

The binding alone did not create a namespace: `namespaces get pitcrew` initially returned 10200, and list returned empty. Namespace was subsequently created through the official dashboard without any credential or agreement form. Repository import remains pending. Do not run `wrangler artifacts repos create` casually: installed CLI prints the returned repo token, and the create API cannot select its expiry. Repo creation/import/fork mint a repo token. Before this step, obtain approval for its exact scope/lifetime/revocation design and use a secret-safe official flow. No repo token was minted in this task.

Docker is installed but its configured Colima engine socket is absent. No VM was started, image built/pushed, or container application created. An approved digest-pinned Node image, linux/amd64 build, registry digest, and container configuration are still required.

### Verified limits and local safeguards

- Worker `limits.cpu_ms` limits CPU work, not HTTP wall time, DO duration, model calls, or total requests. HTTP wall time has no hard platform duration limit while connected. `subrequests` is per invocation, not monthly admission.
- Containers Wrangler supports `max_instances` per application. Initial target is one for each of ChangeAgent and ReviewAgent; this can still mean two simultaneous instances. It does not bound total lifetime or restart count. With `durable_object` scheduling, instance size belongs in `ctx.container.start`, not `instance_type`.
- Local transport now explicitly starts `lite` and uses main process `sleep 600`; Dockerfile default matches it. Main-process exit stops an instance independently of a lost JS timer. This is a bounded normal lifecycle, **not a proven hard ceiling against sandbox code able to interfere with its main process**. An independent durable deadline and verified destruction are still required. Existing command timeouts/output caps and stop/revocation logic remain. The existing 30-minute pipeline deadline is checked between stages and does not interrupt a hung model call.
- Native `setInactivityTimeout` resets when DO activity resumes, needs resetting after DO restart, and does not bound an active run's wall time. SDK `sleepAfter` is not a configured guarantee in this native API implementation.
- `config/cloudflare-rollout-policy.json` records rollout targets and missing controls. It is **preparation only**, not consumed by runtime. Offline preflight now fails closed on missing aggregate budget/concurrency/deadline controls. Do not change the blocker until implementation and live verification exist.
- A conservative smoke should be one attempt, one lite instance, 60-second main-process lifetime, 10-second command, 4KiB output, no Internet, no inference, followed by verified destruction. It has not run. No autonomous workload is enabled.

There is **no verified hard account billing cap**. Budget alerts only notify. Internal admission/stop thresholds ($75/$90) need implementation; delayed usage, other actors, tax, persistent storage and a stuck workload can exceed them. The $100 infrastructure budget includes subscription and tax. Do not enable unbounded runs or describe alerts as a cap.

### OpenRouter coordination

Provider owner `01a10a67-bcd7-7017-bdb5-2d13534510f8` will extend the explicit Pi byok provider contract. No Workers AI binding/model was added, no inference credits purchased, and no provider calls are authorized for this agent.

Proposed user-driven secret lifecycle: same-origin loopback controller requires CSRF/origin checks, bounded input, and action-time explicit disclosure/confirmation that the entered existing OpenRouter key is sent to **Pitcrew account / pitcrew-backend**, stored as persistent encrypted Worker secret `OPENROUTER_API_KEY` until replaced/removed. Controller invokes only fixed `wrangler secret put` with stdin and existing OAuth; never key in args/env/history/logs/localStorage/responses, discard command output, return sanitized configured status, clear field. Runtime owner implements controller; provider owner implements UI/adapter. No local inference fallback. Model variable deployment must happen after merging with this backend configuration and enabling guards; stale clone deployment is unsafe.

`MODEL_CONFIGURATION` target: `{"provider":"byok","providerId":"openrouter","model":"<verified-selected-model>","secretBinding":"OPENROUTER_API_KEY"}`. Existing schema/provider supports only openai/anthropic until that owner's change lands. Authenticated Access ingress and local relay remain unresolved. Dynamic user secret submission is not currently functional.

File ownership: this branch owns backend config/preflight/docs and finite sandbox lifecycle. No Pi model/protocol/UI/controller edits. Other owners control OpenRouter and managed runtime5173.

Validation: execution package 64/64 tests pass and typecheck passes. These are local tests, not live sandbox evidence.

Sources:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/containers/configuration/wrangler/
- https://developers.cloudflare.com/containers/concepts/architecture/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/artifacts/api/rest-api/
- https://developers.cloudflare.com/billing/manage/budget-alerts/

## Continued local implementation: durable admission and sandbox preparation

This update supersedes the earlier statement that the admission ledger is unimplemented. It remains **local and disabled**, not deployed or verified on Cloudflare.

`InfrastructureAdmission` uses the singleton RepositoryAgent's SQLite transaction to reserve $5 per run, refuses new reservations above $75 per UTC month, and allows one active run across projects/threads. Completion frees concurrency only after verified cleanup; it never refunds the monetary reservation. A matching run replay preserves the original deadline/reservation, changed identity is rejected, and uncertain work owns its slot across month rollover. Paused, disabled or expired runs are stopped by a separate lifecycle job, recovered from SQLite after restart. Cleanup observation has a 5-second timeout; timing out does not prove remote cancellation. After twelve cleanup attempts, ownership is quarantined, polling ends and new work is rejected until reconciliation. Child pipeline cleanup is likewise bounded to twelve attempts and parked rather than replaying paid effects.

`INFRASTRUCTURE_ADMISSION_ENABLED=false` and `EXECUTION_MODE=disabled` are preserved. The $75 ledger is a conservative **reservation allowance**, not measured spend: $25 remains outside it for subscription/tax/reporting delay. No account-wide billing cap, egress cap, artifact retention policy or provider spending bound is established. Long-lived remote operations or other account actors remain risks. No paid workload is enabled by passing local tests.

Validation includes actual disposable local SQLite concurrent admission and reload, pure admission rollover/exhaustion/replay/quarantine checks, bounded cleanup RPC observation, pipeline cleanup retry parking, existing Pi lifecycle recovery, and coordinator tests. Live deadline/destruction behavior remains unverified.

Built a 145,305,557-byte `linux/amd64` sandbox locally from Docker's verified official `node:24-bookworm-slim` platform digest `sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7`. Local image `pitcrew-sandbox:connection-prep`, image ID `sha256:75f7fd8a36cb03a0acb248d8800f6cafcb04fbf0d4efeb252e2c43ae5d98c8a3`; this is not a registered Cloudflare image. Dockerfile default now pins this base. Probe had no network or secrets/source mounts. Lite-size 256MiB/1⁄16 CPU probe reached Node/Git but timed out before pnpm within ten seconds. Basic-size 1GiB/¼ CPU probe completed in its 30-second limit: Node24.21.0, Git2.39.5, pnpm11.17.0, Python3.11.2. This establishes tool availability only, not project-build viability or native Cloudflare sizing equivalence; Mac executes amd64 through emulation.

The isolated Colima profile `pitcrew-build` was created with 2 CPUs,4GiB,20GiB disk for local preparation, then stopped. The original default profile remains untouched/stopped and Docker context restored to `colima`. The stopped profile retains the image for future setup; no registry push, cloud container app or paid smoke run occurred. Recipe/probe metadata is in `config/cloudflare-sandbox-build.json`.

### Smallest remaining repository action and approval boundary

Read-only GitHub CLI confirms **PUBLIC** repository `lilfrogdev/pitcrew`, default branch `main`. Proposed source is `https://github.com/lilfrogdev/pitcrew.git`, `main`, depth1. Proposed destination is account `004227d2029c56b084ce15356768def3`, namespace `pitcrew`, new immutable baseline repo `pitcrew-source`, `readOnly:true`. Import through the configured Artifacts service binding; no GitHub credential or new Cloudflare account API token is needed. After import, read metadata/head through the binding and pin that actual commit before execution; never assume local checkout HEAD equals remote import HEAD.

Import automatically issues an initial **repo-scoped Git token**. `read` permits clone/fetch/pull; `write` also permits push. The import request has no token-scope or TTL option, and published/generated API docs do not establish its default scope/lifetime. The returned token embeds expiry, but learning it requires the credential creation that needs approval. Do not claim this is a chosen 300-second lease or assume the explicit `/tokens` endpoint's 24-hour default applies to import.

Preferred disposal: token exists only in the provisioning Worker's memory, never returned, logged, stored on Mac, or placed in a Git URL. Once the repository is ready, use binding `get(target).revokeToken(initialToken)`; confirm revocation and check token metadata only. **Immediate revocation is not yet guaranteed**: `get()` explicitly throws `IMPORT_IN_PROGRESS` while import is incomplete. A bounded readiness wait can fail before revocation, or a Worker can restart; a robust cleanup path needs design/approval before minting. Do not silently persist the token to solve this. The alternative is user-owned dashboard creation/import plus user revocation of the initial token, followed by our binding-only metadata verification.

Action-time approval is therefore needed for this precise import + automatic initial-token lifecycle, including the platform-selected scope/expiry uncertainty and revocation behavior. It has not occurred. Future run forks similarly mint initial tokens; the existing adapter revokes them and only then creates explicit read/write leases lasting300seconds. Approval of that separate runtime delegation must precede enabling runs; leases stay only in Worker/container process memory, with revocation after the Git operation and destruction on failure.

Read-only inspection of the Mac Chrome dashboard's Create repository/Import from Git dialogs also exposes no initial token-scope or TTL control. The import dialog offers only Git repository and destination repository name; unlike new-repository creation, it does not expose the read-only switch. No form was submitted; the namespace remains empty. Do not use the simpler dashboard import as if it guaranteed the planned read-only baseline or five-minute token.

Sources: https://developers.cloudflare.com/artifacts/api/workers-binding/ ; https://developers.cloudflare.com/artifacts/guides/import-repositories/ ; https://developers.cloudflare.com/artifacts/api/rest-api/ .

### Relay coordination status

OpenRouter owner supplied reviewed candidate `c00d629fb321db848fa4ac65001920ef7f6cdbf7` with Qwen default `qwen/qwen3.8-flash` and static Worker secret contract. Model configuration will be merged only after parent integration/review. Secret UI always reports execution disabled/awaiting backend setup. No provider invocation occurred here.

Both runtime and provider owners received the ingress blocker: the current Worker has no public target, while `principal()` needs Cloudflare Access issuer/audience/hostname/email and a backend Origin. Existing OAuth grant has no Access or DNS scopes. Do not silently broaden it or create an Access application/policy/service credential. A future authenticated Mac relay may use a backend-only Access-protected endpoint and a user session managed by official authentication tools, but the exact Access setup must be approved. A secret upload controller alone is not a functional cloud execution bridge.

Current official Workers Access documentation confirms a `workers.dev` hostname can be protected without onboarding a custom DNS domain. Zero Trust setup and permission to manage Access applications are prerequisites. Protect only the backend hostname with an exact-email policy matching current backend authorization, then establish the user's session securely; no service token is needed for this proposed per-user path. Worker-level Access currently rejects WebSocket upgrades, so hostname protection is the appropriate route if the later multiplayer transport uses WebSockets. Apply Access protection before enabling any endpoint. Zero Trust plan/terms and exact hostname/application policy still need review and action-time approval, and no setup was performed. Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/ .

Final local verification: all117 Worker tests across23 files pass, root TypeScript check passes, changed-file format/lint checks pass and backend deployment dry run succeeds. Forty focused tests include guard/SQLite/lifecycle/coordinator checks; the five delivery recovery tests explicitly opt into the admission fixture and attest its synthetic cleanup. None of these counts prove a live connection. Backend bundle5423.45KiB/gzip965.10KiB includes both admission and execution disabled. Current deployed version remains the earlier disabled version; these changes await parent review/merge.
