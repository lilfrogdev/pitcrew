# Cloud mission smoke — evidence record

Fill after owner ops and the competition capture. Leave fields as `pending` until
known.

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| Branch                       | `feat/cloud-mission-smoke`         |
| Account id                   | `004227d2029c56b084ce15356768def3` |
| Registered sandbox image     | `pending`                          |
| Artifacts repo               | `pitcrew-baseline`                 |
| `PROJECT_BASE_SHA`           | `pending`                          |
| `CONFIGURATION_REVISION`     | `cloud-mission-smoke-v1`           |
| No-model smoke at (UTC)      | `pending`                          |
| No-model destroy verified    | `pending`                          |
| Gate flip at (UTC)           | `pending`                          |
| Thread id                    | `pending`                          |
| Run id                       | `pending`                          |
| Candidate SHA                | `pending`                          |
| Flow screenshot              | `pending`                          |
| Approx infra cost            | `pending`                          |
| Approx model cost            | `pending`                          |
| Gates disabled after capture | `pending`                          |

## Notes

- Local gate (automated): `src/local-execution.test.ts`, `src/mission.test.ts`, `src/probes.test.ts` — 10/10 passed on branch tip.
- `pnpm cloudflare:preflight` fails closed until digest image + `PROJECT_BASE_SHA` (expected).
- `wrangler whoami` on the contributor machine: **not authenticated**. Live steps 2–7 in
  [cloud-mission-smoke.md](../cloud-mission-smoke.md) require the account owner (frog).
- Live cloud mission status: **blocked on owner ops** (image push, Artifacts seed, deploy,
  temporary `EXECUTION_MODE=cloud` + admission). After pins exist:

```sh
CLOUD_SANDBOX_IMAGE='registry.cloudflare.com/...@sha256:...' \
CLOUD_PROJECT_BASE_SHA='<40-hex>' \
pnpm cloudflare:apply-pins
```
