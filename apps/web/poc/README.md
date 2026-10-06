# Visual replies: isolated local prototype

This isolated harness exercises the renderer plus the new protocol, private SQL store,
read-only API and client disposal modules. Account/session authorities are synthetic;
it never calls real accounts, repositories or models. Generated JavaScript is unsupported:
only the fixed chart runtime runs. Structured documents use native controls and an empty
sandbox. Public HTTP writes return 405. Publication requires a trusted admitted turn and
the durable tool runtime's invocation ID; neither is a model argument.

After the repository's normal dependency installation, run from the repository root:

```sh
pnpm exec tsc -p apps/web/poc/tsconfig.json
pnpm -C apps/web exec vp test run --config poc/vite.config.ts
pnpm exec esbuild apps/web/poc/visualizations.tsx apps/web/poc/security.tsx --bundle --format=esm --jsx=automatic --outdir=apps/web/poc/dist
pnpm exec esbuild apps/web/poc/security-service.ts --bundle --platform=node --format=esm --outfile=apps/web/poc/dist/security-service.mjs
cp apps/web/poc/index.html apps/web/poc/dist/index.html
python3 -m http.server 5196 --bind 127.0.0.1 --directory apps/web/poc/dist
```

Open `http://127.0.0.1:5196` for the local fixture. Theme changes remount the preview and
reset its controls. The host still owns the title and accessible text description.
The prototype accepts only six-digit hex theme colors from the explicit token allowlist.

For the isolated Chromium boundary check, stop the fixture server and run:

```sh
node apps/web/poc/browser-check.mjs <prepared-security-artifact-temporary-directory>/browser
```

The script starts its own ephemeral loopback server and a headless Chrome process with an
empty temporary profile, closes that browser, and saves evidence in the directory explicitly
provided by the security artifact manager. It uses the macOS Google Chrome application path.
It tests only fixtures, including a separate intentionally unsafe local counterexample
that demonstrates why arbitrary generated scripts must remain disabled.

The frontend `authorized` flag is a presentation guard. Server adapters require current
verified session plus project and thread membership. Collaborators can read artifacts created
by other members. Storage assigns immutable ownership/provenance and enforces 64 KiB content,
512 nodes/depth 12, 32 points, 10 artifacts/512 KiB per thread and 100 artifacts/4 MiB per
repository. The client mounts two frames maximum, retains one thread in memory, expires
leases within five seconds, and removes frames and private fallback on known access loss,
hidden/offline state or replaced scope/transport. Unobserved remote revocation is bounded by
revalidation/lease expiry; it is not instantaneous. Session and coordinator SQL are separate
stores, so publication/session revocation cannot be advertised as a distributed atomic write.

Production registration is a separate follow-up. It must wire the actual verified-session
adapter, current Collaboration membership, trusted active-turn RPC/tool factory, bounded
local relay read route and App access-loss/collapse disposal. No fixture identity fallback
may be copied into registration. Safari/Firefox and deployed account checks remain required
before enabling the feature.
