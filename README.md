# Pitcrew

Pitcrew is a conversation workspace for coordinating repository changes, isolated agent runs,
verification, and review. The React frontend talks to a Cloudflare Worker and Durable Objects.

## Start locally

Install **Node.js 24 or newer**, **pnpm 11.17.0** (pinned in `package.json`), and Git.
Node 24 is required for the `using` syntax in the execution tests; CI uses the Node 24 line.
If pnpm is missing, install it with `npm install --global pnpm@11.17.0`.

```sh
git clone https://github.com/lilfrogdev/pitcrew.git
cd pitcrew
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
pnpm -C apps/web dev --port 5173 --strictPort
```

Open <http://127.0.0.1:5173>. This starts development-only browser fixtures: synthetic projects,
conversations, and run evidence. It needs no Cloudflare login, provider key, Docker, or backend.
Fixture state resets when the page reloads; it does not execute repository changes.

For a persistent local Worker/API or frontend hot reload against it, see [local development](docs/local-development.md).

## Validate changes

Run these from the repository root:

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build:worker
pnpm build:backend
```

`check` verifies formatting and lint. `test` includes the controller, Worker/emulator, web,
execution, verification, and evaluation suites. `build:worker` builds the web app and bundles
the combined Worker; `build:backend` bundles the backend-only configuration. Both Worker
builds use Wrangler **dry runs**. These checks need no cloud credentials or live model calls.
`pnpm build:web` builds just the frontend.

GitHub [CI](.github/workflows/ci.yml) runs the same checks on pull requests and pushes to `main`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch and review workflow.

## Find the code

| Path                    | Responsibility                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `apps/web`              | React UI, HTTP client, and browser fixtures; entry point `src/main.tsx`                     |
| `apps/worker`           | Protected API, Durable Objects, coordination, and agent drivers; entry point `src/index.ts` |
| `packages/protocol`     | Shared request, model, attachment, and knowledge contracts                                  |
| `packages/execution`    | Isolated execution adapters, Git transport, and trusted landing                             |
| `packages/verification` | Pinned verification profiles and check evidence                                             |
| `packages/evaluation`   | Deterministic knowledge history/replay evaluation                                           |
| `scripts`               | Local cloud relay, provider setup controller, offline preflight, and their tests            |

## Cloud integration

Local fixtures and passing CI establish local behavior. Live use separately requires protected
Cloudflare ingress, authorized user identities, an authenticated local relay, and provisioned
services. The committed production configurations keep agent execution disabled. Production
builds ignore `VITE_PITCREW_DEMO`; the demo switch cannot provide production access.

The existing [Cloudflare notes](docs/cloudflare-connection.md),
[provider connection notes](docs/openrouter-connection.md), and
[repository lifecycle contract](docs/repository-lifecycle.md) describe those integrations.
They include dated setup history; verify current deployment state with the integration owner.
Repository access and shared app access are separate onboarding steps.

The opt-in [repository-agent memory integration](docs/repository-memory.md) keeps persistent
OptChat-style history for the main agent, with ordinary Pi compaction for implementation and
review agents. It is disabled by default and does not enable live execution.
