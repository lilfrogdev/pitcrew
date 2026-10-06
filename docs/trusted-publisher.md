# Isolated Artifacts publisher

`TrustedPublisherAgent` is a separate SQLite Durable Object with its own native
container. It must never be bound to a ChangeWorker container or resolve through
the candidate worker's `ctx.container`. Its RPC methods accept signed frozen
publication and landing tuples; there is no production fetch route, shell runner,
TCP proxy, model harness, checkout, task mount, or snapshot restore.

The execution profile remains disabled until the backend's authoritative admission
gate, resource reservations, cleanup owner, image registration and private signing
key are configured. Source landing additionally needs separately authorized
Cloudflare receive-pack conformance evidence. Local Git tests establish the intended
client semantics; they do not establish the provider's old-ref comparison behavior.

## Transfer and validation

The task container exports a **complete Git bundle**, without receiving a publication
credential. The bounded command port returns strict base64. The first version accepts
at most 750 KiB of binary bundle data (1,024,000 base64 characters), including the
candidate's reachable history. Repositories whose complete bundle exceeds this limit
fail before a publisher starts or a token is issued. Incremental bundles and their
external prerequisites are deliberately rejected. A later larger-history transport
needs a separately bounded trusted implementation.

The publisher accepts only a version 2 header containing the exact candidate SHA
and `HEAD`, with no prerequisites or extra refs. It imports the pack into a fresh
bare SHA-1 repository using `index-pack --strict`, checks exact commit types, runs
`fsck --strict --full`, and checks base/candidate ancestry. Candidate hooks, Git
configuration, alternates and executable files never become local publisher
configuration or executable code.

Source and fork names, immutable metadata IDs, HTTPS remotes, fork provenance and
the source's `main` default branch are rechecked using the Artifacts binding.
System/global Git configuration and attributes are disabled for every process;
hooks and credential helpers are disabled; replacement objects, file/ext protocols
and HTTP redirects are disabled. Only fixed server-owned Git argv execute.

Only after these checks may the publisher issue a 60-second fork write lease or
an independently authorized source write lease. The credential is supplied only to
the push process, as a remote-specific HTTP header. Candidate publication writes
the exact SHA to `refs/heads/candidate`; source landing writes the approved SHA to
`refs/heads/main`, with an explicit expected old SHA and an ancestry check. The
operation records its intent before pushing, requires a successful update receipt,
and confirms the exact ref through the binding. It never blindly retries an uncertain
push.

## RPC contract and ownership

The binding is `TRUSTED_PUBLISHER: DurableObjectNamespace<TrustedPublisherAgent>`.
Backend integration provides `RepositoryAgent.assertPublisherAdmission(input)` on
the fixed `pitcrew` repository DO. The gate checks the current reservation, Stop,
pause, membership, configuration, deadline and immutable source approval. It runs
before and after awaited stages. The dedicated `TRUSTED_PUBLISHER_AUTH_KEY` is at
least 32 bytes and remains a Worker secret; do not reuse the authentication secret
or put this key in a task container. `signPublisherAuthorization` and
`verifyPublisherAuthorization` bind the complete tuple and the SHA-256 bundle digest.

`publish(PublisherInput)` and `land(PublisherLandingInput)` return a sanitized receipt
with `status`, `fingerprint`, `cleanupVerified` and an optional code. All input fields
are snapshotted before awaiting work. SQLite records preserve pending operations,
cancellation tombstones, container ownership, token issuance/revocation state and
uncertain write receipts. Replays return an existing receipt or request reconciliation;
changed fingerprints fail. Pending or uncertain operations block another operation
on the same publisher object. Each publisher DO is single-use, even after a clean
terminal result. Backend names are `publisher:publish:<runId>` and
`publisher:land:<authorizationId>`, preventing delayed cleanup of an old operation
from destroying a new owner's container. Bundle storage and alarm changes occur
only after input validation and the atomic ownership claim.

Successful publication stores the inert bundle in 64 KiB SQLite chunks. The private
`publishedBundle(operationId, exactTuple)` accessor checks all run, fork, SHA, digest
and configuration fields. Verified worker cleanup preserves this data so source
landing can reuse the identical reviewed candidate after obtaining a separate
reservation and approval.

The container's PID 1 is `/bin/sleep 120`; each Git process uses GNU `timeout` with
a maximum of 30 seconds. Host waits have the frozen operation deadline. Cleanup
revokes known leases, awaits container destruction, and checks `inspect() === null`
and `running === false`. An unknown lease issuance, failed revocation, destruction or
inspection retains uncertainty and its owner's reservation. A durable
`executionSettled` barrier keeps cleanup unverified while an execution continuation
may still act. Finalization requires every observed lease to be explicitly revoked;
an uncertain lease without an ID never counts as cleanup proof. A crashed pending
execution without settlement evidence stays quarantined for reconciliation.
Unknown cleanup does
not claim success. `reconcile` performs read-only ref observation plus cleanup and
does not convert an uncertain guarded push into a successful receipt.

## Example provisioning fragment

This is a configuration example, not an active deployment profile. The production
Worker must export the class before provisioning it. Its image must contain trusted
`/usr/bin/git`, GNU `/usr/bin/timeout` and `/bin/sleep`, have no account secrets, and
be resolved through `ctx.container.images.publisher` to the reviewed digest.

```json
{
  "durable_objects": {
    "bindings": [
      { "name": "TRUSTED_PUBLISHER", "class_name": "TrustedPublisherAgent" }
    ]
  },
  "migrations": [
    { "tag": "publisher-v1", "new_sqlite_classes": ["TrustedPublisherAgent"] }
  ],
  "containers": [
    {
      "name": "pitcrew-trusted-publisher",
      "class_name": "TrustedPublisherAgent",
      "scheduling_policy": "durable_object",
      "max_instances": 1,
      "images": {
        "publisher": {
          "image": "registry.cloudflare.com/ACCOUNT/publisher@sha256:REVIEWED_DIGEST"
        }
      },
      "observability": { "logs": { "enabled": false } }
    }
  ],
  "vars": { "TRUSTED_PUBLISHER_ENABLED": "false" }
}
```

The task container and publisher are separate applications and may overlap during
candidate publication. The durable budget owner must reserve both instances and
hold its resource slot until cleanup is independently verified. Source landing uses
a new reservation after task cleanup. An application instance cap is a resource
guard, not a billing measurement or spending cap.

Contracts were checked against installed `@cloudflare/workers-types` version
`5.20261003.1` and Wrangler's local configuration schema. Relevant primary references:
[native Container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[Artifacts binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[Git bundle](https://git-scm.com/docs/git-bundle),
[Git push](https://git-scm.com/docs/git-push).
