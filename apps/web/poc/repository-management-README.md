# Repository management browser QA

This development-only harness renders the actual `AccountRepositories` and
`RepositoryManagement` components, production styles, and `httpApi` client.
Its loopback API uses bounded synthetic accounts, repositories, invitations, and
failure responses. It never connects to a cloud provider or real account.

Run from the repository root after normal dependencies are available:

```sh
node apps/web/poc/repository-management-browser-check.mjs /tmp/pitcrew-repository-qa
```

The script bundles its fixture into a temporary directory, binds an ephemeral
loopback server, and starts headless Chromium with an empty temporary profile.
On macOS it defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
`PITCREW_QA_CHROME` can select another installed Chromium binary. The browser's
renderer request interception permits only that run's loopback origin.
The script removes the profile and temporary build when it finishes. No install
or dependency change is needed beyond the repository's existing esbuild and React.

Assertions use rendered DOM labels, native browser mouse/text/key input, clipboard,
the browser accessibility tree, and observed HTTP requests. No React internals,
human browser profile, credentials, cookies, or session extraction are used.
Clipboard permissions apply only to the synthetic origin and empty profile.

Coverage includes arbitrary create metadata and consent, owner/editor/external
controls, physical identity preservation during metadata edit, invitation
creation/copy/ephemeral cleanup and UUID revoke, selected editor revocation,
typed permanent deletion, HTTP 202 pending observation, explicit same-resource
recovery, mismatched-ID observation, generic failures, unknown mutation results,
capability gate-off, late private responses after account switch/unmount, mobile
overflow, keyboard activation, and accessible action names.

Evidence is written to the requested directory: `results.json`,
`accessible-names.json`, and four desktop/mobile PNG screenshots. Failure evidence
is written as `failure.json` and `failure.png` when applicable. A successful run
verifies the UI and real client contract against the synthetic transport; it does
not verify Codex in-app browser behavior, real authentication, live provider
behavior, or cloud persistence. No callable Codex in-app browser tool was exposed
in the execution environment used for this QA.
