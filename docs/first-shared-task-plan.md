# First shared Artifacts task: proposed acceptance plan

This is a reviewable rollout plan. It does not authorize provisioning, paid work,
repository writes, invitations, deployment, email/DNS changes or gate activation.

## Exact target and task

Use the owner-selected existing Cloudflare Artifacts `pitcrew/pitcrew-test` only
after fresh metadata confirms its immutable ID (historically
`b6ljpouyr0i72xku`), default branch and token state. The historical repository was
empty. Registering it does not initialize it: an approved initial commit is
required before execution can use a real base SHA.

First task proposal: add a short `README.md` describing the test repository and
one collaborator workflow. No dependencies, network tools, executable files,
secrets, production configuration or source outside that test repo are needed.
Acceptance: the agreed README text is in the final reviewed commit; `git diff
--check` passes; independent reviewer approves that exact SHA; main repository
agent accepts the proposal; trusted server applies it to the exact Artifacts main
ref using a compare-and-swap expected base; source metadata/readback matches the
approved SHA; the UI marks completed only after this receipt.

## Two-person session

1. Owner and Bryan install locally and independently pass Cloudflare Access,
   email verification and Better Auth sign-in. Each has their own relay/cache and
   provider connection. No owner credential/session/runtime is copied.
2. Owner explicitly grants Bryan editor membership on this selected project, then
   on a new thread. Bryan accepts each recipient-bound, expiring invitation.
3. Both clients exchange distinct messages and observe authored updates after
   reload/reconnect. Bryan cannot read an owner's other private thread.
4. One named initiating participant sends the approved task. Its frozen credential
   actor is that participant's own Access subject. The other participant cannot
   select or silently charge a different connection in JSON.
5. Worker changes run only in its own Artifacts fork/branch. Credential-free bundle
   export feeds an isolated trusted publisher; no task scripts or mutable Git
   configuration enter that publisher. The validated candidate becomes an
   immutable proposal to the main repo agent and independent reviewer.
6. After exact review/verification and a separate one-use source-merge permission,
   trusted landing applies the approved SHA to the selected source. It rechecks
   current membership, target/configuration, immutable source identity, expiry and
   durable admission. No participant-supplied remote/ref/artifact overrides apply.
7. Revoke Bryan's thread membership and verify that reads, writes and subsequent
   polls/reconnect fail. Running revoked work stops and retains ownership until
   cleanup is verified.

## Proposed spend and resource envelope

Ask for explicit approval of one small task, no automatic task retries and a
maximum **$1 model budget on the initiating user's dedicated OpenRouter key**.
Use a lifetime key credit limit, not a daily/weekly/monthly resetting limit. Check
its remaining limit before admission without exposing the key to another user or
client. OpenRouter documents rejection after a key reaches its credit limit:
[OpenRouter authentication](https://openrouter.ai/docs/api_reference/authentication).
This key provisioning/check has not been performed, and source admission currently
checks configured credentials rather than enforcing this rollout-specific budget.

Infrastructure is separately proposed as one active run, ten-minute task deadline,
32 tool calls per implementation/review loop, and one bounded isolated publisher
container overlapping the candidate. A later source landing owns its own bounded
reservation and cleanup. The existing $5/run and $75/month values are **internal
reservations**, not measured billing or an account spending cap. The publisher
must be included in the resource envelope before any paid run is enabled.

For scale only: using current published rates, two `lite` containers at full CPU
for ten minutes each have about **$0.0024 compute/memory/disk cost** before included
allowances. This excludes Workers, Durable Objects, logs, network and model costs;
it is an estimate, not a billing guarantee or monetary stop. See
[Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).
Actual account plan, image instance type, bounded entrypoints, resource ownership,
cleanup and provider key limit must be verified at approved rollout time.

## Code versus rollout readiness

The reviewed account slice `ad1e178` has two-account real-library D1/workerd tests
and independent security review. Native trusted publisher, source landing and
execution cleanup are separate work in progress. They need combined tests and
independent review, then an approved disposable Artifacts old-ref/CAS conformance
probe before real landing is configured. Local Git conformance proves local Git
semantics; it does not prove the hosted Artifacts provider's behavior.

Required approvals remain: exact sender/domain and email binding/DNS; auth D1 and
migrations/private secrets; publisher binding/pinned image/private authorization
key and infrastructure envelope; exact test repo adoption/initialization;
deployment and independent local installation; real recipient/project/thread
invitation; explicit own-provider connection with hard key budget; one task and
one source merge. No real action on this list occurred in this phase.
