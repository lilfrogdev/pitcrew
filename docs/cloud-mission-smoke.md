# Cloud mission smoke (competition path)

Branch: `feat/cloud-mission-smoke` (from `feat/integrate-mission-flow`). Does not
require merging PR #61. Privileged Cloudflare ops belong to the account owner
(frog); this document is the handoff runbook.

Target: Artifacts repo **`pitcrew-baseline`** (same greet fixture as local-agent).
Committed backend defaults stay **`EXECUTION_MODE=disabled`** and
**`INFRASTRUCTURE_ADMISSION_ENABLED=false`**. Flip those only after the no-model
container smoke, and flip them back after the competition capture.

## Preconditions

- Account `004227d2029c56b084ce15356768def3`, Workers Paid active.
- `pnpm cloudflare:preflight` fails closed until real image digest and
  `PROJECT_BASE_SHA` are pinned (expected).
- Local gate on this branch: `pnpm exec vp -C apps/worker test run src/local-execution.test.ts src/mission.test.ts src/probes.test.ts` green.
- Optional full UI gate: local-agent path in [local-development.md](local-development.md).

## 1. Authenticate Wrangler

```sh
pnpm exec wrangler whoami
```

Confirm the active account id is `004227d2029c56b084ce15356768def3`.

## 2. Build and register the sandbox image

Recipe: [apps/worker/Dockerfile](../apps/worker/Dockerfile) and
[config/cloudflare-sandbox-build.json](../config/cloudflare-sandbox-build.json).

```sh
# linux/amd64 digest-pinned build (owner machine with Docker/Colima)
docker build --platform linux/amd64 \
  -t pitcrew-sandbox:cloud-mission-smoke \
  -f apps/worker/Dockerfile \
  apps/worker
```

Push to the Cloudflare managed registry using the account’s approved Containers
flow. Record the exact reference:

`registry.cloudflare.com/<account-or-ns>/pitcrew-sandbox@sha256:<64-hex>`

Then:

1. Set both ChangeAgent and ReviewAgent `containers[].images.sandbox.image` in
   [apps/worker/wrangler.backend.json](../apps/worker/wrangler.backend.json) to that
   digest reference.
2. Set `config/cloudflare-sandbox-build.json` → `registeredCloudflareImage` to the
   same string.

`pnpm cloudflare:preflight` requires
`/^registry\.cloudflare\.com\/[a-zA-Z0-9_./-]+@sha256:[a-f0-9]{64}$/`.

## 3. Seed `pitcrew-baseline`

Local digest only (safe):

```sh
node --experimental-transform-types scripts/provision-baseline.mjs
```

Cloud write (owner only, after Artifacts binding works):

```sh
PITCREW_BASELINE_PROVISION=approve-cloud-write \
  node --experimental-transform-types scripts/provision-baseline.mjs
```

Pin the returned `baseSha` (40 hex chars) into
`vars.PROJECT_BASE_SHA` in `wrangler.backend.json`. Keep
`vars.ARTIFACT_REPOSITORY=pitcrew-baseline` and
`vars.CONFIGURATION_REVISION=cloud-mission-smoke-v1` (or bump deliberately).

Revoke any minted repo token immediately; do not commit tokens.

## 4. Deploy backend (still disabled)

```sh
WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy \
  --config apps/worker/wrangler.backend.json
```

Confirm `EXECUTION_MODE=disabled` and admission false on the deployed Worker.
Ingress / Access / password API remain as in [cloudflare-connection.md](cloudflare-connection.md)
and [auth-setup.md](auth-setup.md).

## 5. No-model container smoke

Policy: [config/cloudflare-rollout-policy.json](../config/cloudflare-rollout-policy.json)
`initialSmoke` — one attempt, one lite instance, ~60s main process, 10s command,
4KiB output, **no internet**, **no OpenRouter**.

Success: container starts, reports Node and Git versions, destroys cleanly.
Record timestamp and instance id in
[evidence/cloud-mission-smoke-record.md](evidence/cloud-mission-smoke-record.md).
Set `config/cloudflare-sandbox-build.json` → `cloudSmokeVerified` to `true` only
after destroy is verified.

## 6. Gate flip (live, temporary)

After step 5 only, on the deployed Worker (dashboard or `wrangler secret`/`vars`
workflow the owner uses):

| Var                                | Demo value | After demo |
| ---------------------------------- | ---------- | ---------- |
| `INFRASTRUCTURE_ADMISSION_ENABLED` | `true`     | `false`    |
| `EXECUTION_MODE`                   | `cloud`    | `disabled` |

Do **not** commit those live values as git defaults. Set Cloudflare budget alerts
at $50 / $75 / $90. Internal pause/stop estimates remain $75 / $90 (not a hard
account cap).

## 7. One cloud mission (competition capture)

Client (local UI → relays → deployed backend):

```sh
PITCREW_ACCOUNT_AUTH=true \
PITCREW_AUTH_MODE=password-only \
VITE_PITCREW_DEMO=false \
pnpm -C apps/web dev --port 5173 --strictPort
```

Open `http://127.0.0.1:5173`. Sign in with a password account. Store OpenRouter
in **Profile → Providers** (BYOK). Create a conversation and run the greet task
from [local-agent-status.md](local-agent-status.md):

```text
Change greet so it returns "hello, pitcrew" instead of "hello", and update the test to expect that exact string.
```

Approve the plan, start implementation, watch the **Flow** tab. Checkout must be
an Artifacts fork (not `.wrangler/local-workspaces`).

Fill [evidence/cloud-mission-smoke-record.md](evidence/cloud-mission-smoke-record.md):
thread id, run id, candidate SHA, Flow screenshot path, approximate cost.

## 8. Disable after capture

Set `EXECUTION_MODE=disabled` and `INFRASTRUCTURE_ADMISSION_ENABLED=false` again.
Redeploy or update vars so paid admission cannot start unsupervised.

## Success criteria

- [ ] Digest-pinned sandbox on ChangeAgent and ReviewAgent (`max_instances: 1`)
- [ ] `PROJECT_BASE_SHA` is the seeded Artifacts head
- [ ] No-model smoke destroyed cleanly; `cloudSmokeVerified: true`
- [ ] One cloud mission reaches review/evidence; Flow shows stage handoffs
- [ ] Gates returned to disabled in the live Worker
- [ ] Evidence record completed for the competition submission
