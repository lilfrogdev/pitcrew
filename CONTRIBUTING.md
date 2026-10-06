# Contributing

Start with the [README](README.md) and [local development guide](docs/local-development.md).
Local development and CI do not require production credentials.

## Branch and review workflow

Coordinate the area you plan to change with the owner and other contributors, and check open
pull requests before starting. Keep each change focused so UI, infrastructure, and documentation
work can proceed independently.

From a clean checkout:

```sh
git fetch origin
git switch -c your-name/short-description origin/main
pnpm install --frozen-lockfile
```

If your checkout already has work in progress, preserve it and use a separate worktree:

```sh
git fetch origin
git worktree add -b your-name/short-description ../pitcrew-short-description origin/main
cd ../pitcrew-short-description
pnpm install --frozen-lockfile
```

Avoid force-pushing shared branches. Open a pull request against `main` with the behavior changed,
the checks run, and any unresolved limits. Include browser/keyboard verification for UI changes
and a focused regression test when behavior changes. Wait for review and passing CI before
merging; repository permissions and merge policy are managed by the owner.

## Before requesting review

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build:worker
pnpm build:backend
```

Use `pnpm exec vp fmt <changed-files>` to format a focused set of files. Update the relevant docs
when commands or configuration change. For dependency changes, commit `pnpm-lock.yaml` and
review any new install scripts in `pnpm-workspace.yaml`'s `allowBuilds` policy. The locked
esbuild/workerd installers are allowed; unnecessary transitive hooks are denied. Unreviewed
scripts fail installation by default ([pnpm build settings](https://pnpm.io/settings/build#allowbuilds)).

Keep keys, cookies, access tokens, and personal `.env.local`/`.dev.vars` files out of commits,
screenshots, and test output. Use synthetic credentials in tests. `VITE_*` values are visible
to the browser. Cloud deployment, paid execution, provider setup, and live access changes must
be coordinated separately with the owner; local build commands do not deploy.
