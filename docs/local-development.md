# Local development

Use Node.js >=24.0.0 and pnpm 11.17.0. Run commands from the repository root unless stated
otherwise. Install once with `pnpm install --frozen-lockfile`; the repo supplies its development
tools, including Vite+ and Wrangler.

## Browser fixtures

```sh
cp apps/web/.env.example apps/web/.env.local
pnpm -C apps/web dev --port 5173 --strictPort
```

Open <http://127.0.0.1:5173>. Vite reads `apps/web/.env.local`, where
`VITE_PITCREW_DEMO=true` selects the in-memory API in `src/fixtures.ts`. This mode is for UI
development with synthetic data; it does not call the Worker or run agents. Restart Vite after
changing the env file. Production builds always select the HTTP API.

## Local Worker and API

To exercise the real API routes and persisted Durable Object state with fake execution:

```sh
pnpm build:web
WRANGLER_SEND_METRICS=false pnpm exec wrangler dev --local --env development --config apps/worker/wrangler.jsonc --ip 127.0.0.1 --port 8787
```

Open <http://127.0.0.1:8787>. The compiled frontend uses the Worker API even if `.env.local`
still selects browser fixtures for Vite development. The `development` environment supplies
`ENVIRONMENT=development`, `FIXTURE_IDENTITY=lilfrogdev`, `EXECUTION_MODE=fake`, and
`LANDING_MODE=fixture`; no secrets or additional vars file are needed. The fixture identity is
one synthetic actor for all local developers. Fake execution reports that no code was executed,
and fixture landing updates local state only.

Wrangler may warn that `containers` is not inherited by `development`; this local fake mode
does not configure or start cloud containers.

Wrangler persists emulator state under `.wrangler` (ignored by Git). Stop the local Worker
before clearing that directory to reset this checkout's emulator. Stop servers with Ctrl-C.

For frontend hot reload against the same Worker, start a second terminal:

```sh
VITE_PITCREW_DEMO=false pnpm -C apps/web dev --port 5173 --strictPort
```

Use <http://127.0.0.1:5173>. Vite proxies `/api` to `127.0.0.1:8787`. Mutations require the
local session cookie and nonce supplied by the HTTP client, and either the Worker's own origin
or the fixed `localhost`/`127.0.0.1:5173` origin. Keep the documented port for this mode.

## Configuration boundaries

| Configuration                                                 | Purpose                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/web/.env.local`                                         | Ignored Vite env file; `VITE_PITCREW_DEMO` is the only quickstart setting |
| `apps/worker/wrangler.jsonc`                                  | Combined web/Worker build and local `development` environment             |
| `apps/worker/wrangler.backend.json`                           | Production backend-only target with execution disabled                    |
| `PITCREW_REPOSITORY_RELAY`, `PITCREW_ACCESS_SESSION`          | Opt-in cloud relay and saved Access session                               |
| `PITCREW_OPENROUTER_SETUP`, `PITCREW_OPENROUTER_AUTH_CONTEXT` | Opt-in provider controller and saved Wrangler auth                        |

The helper switches are read from the **process environment** by `apps/web/vite.config.ts`,
not from `.env.local`. Leave them unset for local onboarding. Their targets and auth contracts
are described in the existing [Cloudflare](cloudflare-connection.md) and
[OpenRouter](openrouter-connection.md) notes; enabling them can use saved user credentials.
Keep provider keys server-side and out of all `VITE_*` values.

`pnpm cloudflare:preflight` reads configuration offline and intentionally exits nonzero while
live rollout blockers remain. It is not part of CI or proof of a live connection. Local
contributors do not need a Cloudflare account, Docker, or cloud configuration to run the checks.

If startup fails, check the Node/pnpm versions, install from the root, and ensure the required
ports are free. `--strictPort` prevents silently moving to a port the API will reject. If the
HTTP UI has no data, confirm Wrangler uses `--env development` and the fixture override is
`false` for the hot-reload mode. Browser fixtures and the Worker have separate state.
