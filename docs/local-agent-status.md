# Local agent status

Handoff written 2026-10-06. Branch: `feat/pitcrew-cloud-mvp`. Not merged and not pushed.

## What this product does

Pitcrew is a governed agent-Git loop. In the Work UI you describe a feature, answer one clarifying question, and approve that exact plan. Only then may an agent edit code. The coordinator owns the plan. The approved contract is written to `.agent_context/ASSERTIONS.json` in an isolated checkout. A missing or edited copy is rejected.

## Commits on this branch

- `a342870` — mission approval flow, contract snapshot, baseline fixture, dashboard wiring.
- `4608491` — `local-agent` execution: OpenRouter plus a temporary Git checkout, no Cloudflare container or Artifacts.

Uncommitted follow-up fixes after the first live test:

- The page can enable **Start implementation** when `EXECUTION_MODE=local` and `OPENROUTER_API_KEY` is set.
- Fixture and workspace paths are resolved by walking up from the Worker directory, because Wrangler runs in `apps/worker`.
- A restarted local run keeps its original model deadline instead of throwing `context_conflict`.
- A blocked local run is marked failed instead of showing "candidate pending" forever.
- The Mission card shows the run status when no candidate SHA exists yet.

## Three ways to run

| Address | What it is |
| --- | --- |
| `http://127.0.0.1:5173` with `VITE_PITCREW_DEMO=true` | Browser demo. Scripted data. No model and no Git. Contract ids look like `rev-42-src-2`. |
| `http://127.0.0.1:8787` with `--env development` | Real Worker, fake execution. No model. |
| `http://127.0.0.1:8787` with `--env local-agent` | Real Worker, OpenRouter `qwen/qwen3.8-flash`, Git checkout on disk. This is the test to use. |

The OpenRouter key lives in `apps/worker/.dev.vars` as `OPENROUTER_API_KEY`. Git ignores that file. It is not in the repo and it is not the Profile "Set up a provider" button. Cloud runs still use the encrypted per-user credential in Cloudflare.

Start the local agent from the repo root:

```sh
pnpm build:web
WRANGLER_SEND_METRICS=false pnpm exec wrangler dev --local --env local-agent --config apps/worker/wrangler.jsonc --ip 127.0.0.1 --port 8787
```

`pnpm build:web` has to come first. The Worker serves `apps/web/dist`. Restart Wrangler after Worker or UI code changes, then reload the page.

## Where to click

The Work home ("A place for every change") does nothing until a conversation exists. Click **+** next to **Pitcrew**, name the conversation, and create it.

The box that matters is **Mission**: describe the feature, answer the question, approve that revision, then **Start implementation**.

Ignore these existing controls for this test:

- **Collect and group reports** — older intake.
- Bottom chat and **Set up a provider** — not the local key.
- **Browser / Files / Diffs / Review** — empty until a run finishes. "Repository source is not connected" is expected before that.

## Test prompt

Feature:

```text
Change greet so it returns "hello, pitcrew" instead of "hello", and update the test to expect that exact string.
```

Answer to "What observable behavior should the tests assert?":

```text
greet() returns exactly "hello, pitcrew".
```

`hello` is not on screen. It is the current return value in `fixtures/baseline/src/greet.js`. The test is `fixtures/baseline/test/greet.test.mjs`. A good result is a new commit in `.wrangler/local-workspaces`, `pnpm test` passing, and a review on the Mission card. The baseline commit is `aeb3fcc59a29905910e225d6379ab12ed32f8e09`.

## First live attempt, 2026-10-06

Conversation **Test Workflow Zam 1**, thread `037a33a7-dfd8-4b9f-8f29-a1cb53a12b3f`, run `13a03ef7-b80e-4fa2-b59c-828f563fa7e0`.

The plan was approved on port 8787. The contract prefix was `93a5811c38ef`. **Start implementation** was disabled with "Runs are disabled by the server." After that gate was opened, the run stayed on "candidate pending".

The ChangeAgent pipeline is `blocked` / `reconciliation_required` with `preparePending` set and no workspace. Wrangler’s working directory is `apps/worker`, so `fixtures/baseline` was not found and no checkout was created. Retries then called `bindModelAdmission` with a new deadline and threw `context_conflict` in a loop (`pi-agents.ts`).

After the fail-fast reload, the UI shows **Failed** / **Run failed**. The run record is `execution_failed`. Evidence has no reviews and no candidate SHA. Pi has one empty conversation and zero entries, tasks, or tool runs. No directory exists under `.wrangler/local-workspaces`. The model was never called. The Mission card text is the approved plan, not an agent transcript.

A second conversation, thread `2f525224-edef-43a5-93e5-fbe3153fce65`, failed the same way in about 17ms. Inside the Worker, `process.cwd()` is `/bundle`, `node:fs` cannot see the real fixture, and `child_process` is not implemented. No model call can start until Git runs outside the Worker.

`scripts/local-executor.mjs` is that Node process. Start it before Wrangler. It listens on `127.0.0.1:8791`. The local-agent env sets `LOCAL_EXECUTOR_URL` to that address.

Later runs did call the model. One committed `greet()` as `"hello, pitcrew"` and then failed `invalid_candidate` because `.agent_context/ASSERTIONS.json` was still untracked. The change stage now commits that system file when it is the only leftover. Leave the failed threads alone and create a new one with **+** after both processes are up.

## Not done yet

- One successful local mission from a fresh conversation.
- Cloud smoke: register the sandbox image, seed Artifacts repo `pitcrew-baseline`, then one bounded cloud run. Do that only after the local loop works. It is the check for containers, Artifacts tokens, and Durable Object restarts.
