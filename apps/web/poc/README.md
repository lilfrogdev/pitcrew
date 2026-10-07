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
pnpm exec esbuild apps/web/poc/visualizations.tsx apps/web/poc/security.tsx apps/web/poc/polling.tsx --bundle --format=esm --jsx=automatic --loader:.svg=dataurl --outdir=apps/web/poc/dist
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
The actual App polling fixture retains page two and a changed chart control across three
real 15-second membership polls, then revokes synthetic membership and checks disposal.
It also checks a temporary read failure, keyboard Retry with a fresh authorization read,
and failed recovery after membership revocation.
This adds roughly 45 seconds to the browser check; the polling cadence is unchanged.

The frontend `authorized` flag is a presentation guard. Server adapters require current
verified session plus project and thread membership. Collaborators can read artifacts created
by other members. Storage assigns immutable ownership/provenance and enforces 64 KiB content,
512 nodes/depth 12, 32 points, 10 artifacts/512 KiB per thread and 100 artifacts/4 MiB per
repository. The client mounts two frames maximum, retains one thread in memory, expires
leases within five seconds, and removes frames and private fallback on known access loss,
hidden/offline state or replaced scope/transport. Unobserved remote revocation is bounded by
revalidation/lease expiry; it is not instantaneous for bytes already delivered. Server access
has a separate boundary: all supported auth routes, scoped reads, grant binding and publication
share one bounded FIFO in the singleton RepositoryAgent. Publication commit and read response
construction finish before a queued revocation proceeds, or successful revocation completes
before those operations can resolve live session authority. Old sessions and grants cannot
start new accepted reads/publications after that boundary. Sign-out verifies the deleted
session instead of trusting the library's success response. Session and coordinator SQL remain
separate stores: this ordering covers app-supported auth routes, not out-of-band D1 changes or
future callers that bypass the shared gate, and is not a distributed atomic transaction.

The isolated branch also registers the actual verified-session adapter, current Collaboration
membership, admitted-turn tool RPC, bounded relay read route and one App/Workspace mount.
Tab switching and collapse unmount the private surface. The registered Worker integration
test uses actual Better Auth/D1 and Collaboration code with disposable local accounts and
held model jobs; the browser harness uses synthetic account authority. No fixture identity
fallback is installed in production registration. Safari/Firefox, a real model invocation
and deployed account checks remain unverified. Nothing in this harness deploys the feature.
