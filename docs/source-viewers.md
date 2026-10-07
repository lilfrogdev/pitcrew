# Repository Files and Diffs

The right-hand Files panel reads the registered Cloudflare Artifacts source through
Pitcrew's authenticated local relay. The Diffs panel compares the exact admitted
base and candidate commits in the source and worker fork. Conversation attachments
remain a separate section. Fixture-only connections explicitly report that source
content is unavailable; they do not manufacture source files or patch receipts.

## Read contract

All routes are GET-only under `/api/threads/:threadId/source/`:

| Endpoint | Selectors                                           | Result                                                        |
| -------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `tree`   | `path` (default root), optional `version`, `cursor` | Immediate children, pinned source SHA and opaque version      |
| `file`   | `path`, required `version`                          | Text or explicit unsupported/large status                     |
| `diff`   | `runId`, optional `version`, `cursor`               | Changed-file manifest with exact base/candidate/configuration |
| `diff`   | `runId`, `path`, required `version`                 | Unified text patch and before/after Git modes                 |

Pagination requires the prior version; cursors are bounded offsets within that
immutable listing. Unknown/duplicate selectors are rejected. No browser-supplied
repository, URL, branch/ref, raw Git object ID or credential is accepted. Pathnames
are validated repository-relative names, resolved one component at a time through
Git trees; traversal, backslashes, controls, empty components and `.git` paths are
rejected. Symbolic links and submodules are listed but never followed.

Current project **and** thread membership is checked before and after every awaited
provider operation and before delivery. Inaccessible thread/run IDs return 404.
The existing verified account/Access boundary and server-held local relay session
remain in force. Successful responses are JSON, private/no-store and nosniff;
the browser also requests source responses without caching. Source failures are
allowlisted; provider messages, repository remotes and publisher authorization
credentials never reach the viewer.

Files binds a fresh `info().id` to the project's server-owned source ID, resolves
the configured default branch once to a SHA and reads that immutable commit. Source
ID, name, default branch, remote/provenance metadata and head are rechecked before
delivery. A changed head or metadata returns 409; Refresh files opens the new view.
A removed owned project cannot fall back to the root project's repository.

Diffs requires the stored trusted publisher record `publish:<runId>`, the run's
Artifact admission, the exact source ID/name, fork ID/name/provenance/namespace,
base/candidate SHA and configuration revision. Older or unpublished runs without
this binding are unavailable. Reading historic admitted diffs does not grant
publication, approval or landing authority. All checks remain current during reads.
The frontend verifies response scope, version and commit identities, drops late
responses after navigation, and clears source contents on stale, revoked or
mismatched results. Changing account remounts the app; changing the complete diff
identity remounts its panel. Source content is never persisted in browser storage.

## Provider capabilities and limits

The implementation uses the supported Workers binding methods `get`, `info`,
`log`, `readCommit`, `readTree` and `readBlob`, checked against installed
`@cloudflare/workers-types` 5.20261003.1 and the
[Cloudflare binding reference](https://developers.cloudflare.com/artifacts/api/workers-binding/).
No read token, Git process, worker filesystem, container or new service is needed.
The binding has no native diff method; the trusted server compares Git trees,
skips equal trees and generates a bounded linear replacement hunk with context.
Empty file additions/deletions have valid Git metadata patches. Permission changes
also carry before/after modes. Renames are explicit additions/deletions.

Per request: 128 awaited read operations, 8 seconds, 6,000 visited entries,
2,048 immediate children per tree, 512 KiB of names, 32 path components, 100 entries
per page, 64 KiB/4,000 lines per file, 4,000 combined patch input lines and 192 KiB
per patch. Three concurrent source requests are admitted per project coordinator.
UTF-8 is decoded strictly; binary/control-bearing content is withheld. React text
nodes render source and patches; CSS colors only patch markers, never HTML.
Long code scrolls within its panel and paths wrap. Client line/size limits also
bound rendering work.

`readTree` has no native pagination, so the provider's immediate tree response
must arrive before its entry budget can be checked. Oversized trees/comparisons
fail explicitly rather than return a misleading partial diff. The binding does
not provide RPC cancellation or byte-range blob reads; the response deadline
bounds client waiting, not provider internals. Acquired capabilities are disposed
on normal completion, post-acquisition revocation and late acquisition after a
timeout. These limits intentionally refuse large content instead of acquiring a
Git credential or starting a container as a fallback.

## Local verification and release boundary

Implementation began at reviewed `f0f08fd` in its own local checkout/branch and was
fast-forwarded to merged main `ca8c558437be78563f52f402990db459afa91ec7`, including
the reviewed dependency-hook repair `2908f27`. It does not include the separate
visualization branch. Its only Workspace overlaps are the viewer import, thread ID
prop, Files child and Diffs child; App passes one `threadId` prop.

Independent security/correctness and UI reviews found and verified fixes for
newline-heavy rendering, empty-file patch metadata, source metadata staleness and
capability disposal. Reader tests also cover access revocation at each read stage,
traversal/selectors, immutable fork replacement/provenance, changed run tuples,
source heads, binary/large files, pagination and directory/file replacements.
Frontend tests cover safe text, matching versions, stale/revoked/mismatched replies,
late thread responses and fixture unavailability. Local relay tests cover the new
explicit authenticated read routes. Full gates passed: 46 backend files / 231 tests, 34 web files / 227 tests,
104 execution tests, 9 verification tests, 44 evaluation Node tests plus its
8-test coordinator suite, and 31 relay Node tests. The empty-file regression
passes generated patches through Git's actual parser. TypeScript, formatting
(0 errors; 4 pre-existing lint warnings), production web build, and both explicit
Worker/backend Wrangler dry-run builds passed. Local commands used pnpm
`verify-deps-before-run=warn` because the sandbox and host differ in their global
virtual-store setting; the exact frozen lockfile installation with merged main's
build-hook policy also completed successfully. No lockfile or policy changes
were added by this feature.

User Chrome QA at 1440×1000 and 390×844 used the **production SourceReader and API**
with an explicitly labelled disposable synthetic Artifacts binding, over loopback
HTTP. Tree/file/patch pagination and navigation, escaped script-like text,
binary/large/link states, stale clearing followed by refresh and zero horizontal
page overflow passed. Chrome found a row-layout problem that was corrected and
rechecked. Temporary QA entrypoints and loopback servers were removed/stopped.
These receipts prove the local flow, not hosted Artifacts access:

- [Desktop Files](evidence/files-desktop-synthetic.png)
- [Desktop Diffs](evidence/diffs-desktop-synthetic.png)
- [Phone Files](evidence/files-mobile-synthetic.png)
- [Phone Diffs](evidence/diffs-mobile-synthetic.png)

No live repository source write, token creation, provisioned resource, paid run,
deployment, publication or merge was performed for this feature. Hosted acceptance
still needs the separately authorized backend release with its existing account-
and namespace-bound Artifacts binding, registered source IDs, and a published
admitted run with its trusted fork record. No additional read-token grant is
required by this design; unavailable bindings or missing IDs fail closed.
