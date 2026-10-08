# Account-owned repository management

The account Repositories page manages the repositories the signed-in native account owns or has joined. Owners can create an empty repository, edit its Pitcrew display name and description, invite editors, revoke members or pending invitations, and request permanent deletion with typed confirmation. Editors can view the directory and use their existing collaboration permissions; they cannot manage repository ownership, metadata, deletion or invitations. Ownership comes from the verified immutable `account:<id>` principal. A request cannot select an owner by supplying an actor, username or email.

The frontend runs locally and uses the existing authenticated local relay to the shared Worker. No hosted frontend, provider linking, signup-policy expansion or paid agent execution is introduced. Existing Access restrictions and encrypted provider credential namespaces are unchanged.

## Deployment capability

Broad native creation, metadata editing and permanent deletion require all of:

- `AUTH_MODE=password-only`.
- `ENVIRONMENT=production`.
- The existing `ARTIFACTS` namespace binding.
- A verified native account session.
- The explicit `ACCOUNT_REPOSITORY_MANAGEMENT=enabled` deployment variable.

The new variable is absent by default, so this patch does not silently enable the broader lifecycle. The previous exact `CREATE_ACCOUNT_ACTOR` / `CREATE_REPOSITORY_NAME` approval remains compatible while the broad capability is disabled. This source change also makes the project owner the sole manager of invitations and membership, including threads created by editors; that tighter sharing policy applies independently of the broad lifecycle flag. Editors retain their existing collaboration and viewing permissions. Pending invitation listing and revocation by invitation ID do not expose stored token digests or recreate invitation links.

Live enablement is a separate reviewed source/configuration rollout. The proposed capability permits every eligible existing native account to create valid, user-selected empty repositories in the already-bound namespace and every registered owner to manage its own unprotected physical repository. It is not a namespace administrator API: no import, physical rename, arbitrary token issuance, owner reassignment or deletion of unrelated/legacy/root resources is provided. The configured static source remains protected from physical deletion. Deployment alone neither creates nor deletes a repository.

Preserve the complete existing configuration and all preexisting secret/binding metadata when preparing that rollout. `EXECUTION_MODE=disabled`, `INFRASTRUCTURE_ADMISSION_ENABLED=false`, `CLOUD_CONVERSATION_ENABLED=false`, `REPOSITORY_LIFECYCLE=disabled` and `TRUSTED_PUBLISHER_ENABLED=false` remain independent and unchanged. No AUTH_DB migration or real account/password/grant issuance is required for this feature. Local runtime activation must compose the existing ten cosmetic overlays and own-message photo property and preserve the frozen fixture Worker, launchers, dependencies, LaunchAgent, fixture state and browser preferences.

## Identity, labels and API

The Artifacts physical name and immutable repository ID remain the source identity. Editing changes only the locally persisted Pitcrew display name (`Project.name`) and description; it does not rename the physical Artifact or change source IDs, Git content, base commit or configuration revision. The Workers binding and REST API document create, inspect and name-based delete, but no repository rename/update endpoint. Physical rename is therefore outside this feature. [Cloudflare Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [Cloudflare REST API](https://developers.cloudflare.com/artifacts/api/rest-api/).

Display names are trimmed, nonempty and at most 80 UTF-16 code units. Descriptions are trimmed and at most 1,000 code units; line feeds and tabs are permitted, other ASCII controls are rejected. Physical names use lowercase letters, digits and hyphens, begin with a letter/digit and have at most 63 characters. Metadata updates use a revision to detect concurrent edits.

| Native route                                                     | Purpose                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/repositories`                                          | Account-scoped owned/shared directory with display and immutable physical identity  |
| `GET /api/repository-creations`                                  | Discover broad capabilities, legacy approval and only the caller's creation records |
| `POST /api/repositories/create`                                  | `{name, credentialConsent:true, displayName?, description?}`                        |
| `PATCH /api/projects/:projectId/repository`                      | `{displayName, description, expectedRevision?}`; owner metadata edit                |
| `GET /api/projects/:projectId/repository`                        | Owner status observation, including deletion quarantine/tombstone                   |
| `POST /api/projects/:projectId/repository/delete`                | `{confirmation:physicalName, repositoryId}`; explicit owner deletion/recovery       |
| `GET /api/projects/:projectId/invitations`                       | Owner safe invitation metadata; no plaintext tokens/digests                         |
| `POST /api/projects/:projectId/invitations/:invitationId/revoke` | Exact empty JSON body; owner revocation by ID                                       |

Existing invitation creation/acceptance and membership removal continue to use the same account-bound routes. Invitation links are shown only from the single creation response and remain in component memory for copying; they are not stored or sent by this feature. Revoke pending invitations by ID after the original link is no longer available. Removing an editor removes descendant thread membership and revokes related pending invitations; owners cannot remove themselves or another owner through this route.

All local native mutation consent is bound to the held account before reading the body, then checked again before forwarding. Native Worker operations recheck the original session and current ownership under the authority queue. Cross-origin requests, unknown routes/fields and inappropriate JSON/media types fail closed. Broad creation/edit bodies are bounded to 8 KiB, deletion to 2 KiB and ID revocation to 512 bytes; legacy exact creation retains its 2 KiB bound. Only known errors and bounded metadata are exposed through the relay.

## Creation and recovery

A durable account-owned intent precedes the one provider create call. Initial provider Git-token plaintext is discarded immediately; metadata token IDs are revoked before the repository is registered for access. Creation is empty: no code, commits, threads or invitations are generated. Ambiguous create outcomes are quarantined and never automatically resubmitted. The UI refreshes status through GET and offers only explicit recovery of the same recorded resource when cleanup/registration requires it.

Creation and physical deletion share the durable namespace serializer. An immutable ID is checked across asynchronous provider metadata/token steps, and retired names cannot be reused by cooperating application actors. Existing bounds remain: 20 registered project records (including retained deletion tombstones), 200 lifecycle intents and bounded root storage. Tombstones are not automatically pruned, so historical records count toward these limits.

## Permanent deletion semantics

Deletion requires current owner authority, an exact typed physical name and the expected immutable repository ID. Legacy/root/unrelated physical repositories and active work or landing/admission reservations are protected. The application freezes the project and revokes its invitations before cleanup/provider deletion. Descendant source, collaboration, upload, event and membership access is unavailable while deleting or deleted. Existing discussion/history is retained in inaccessible tombstoned state; it is not purged from storage by this action.

The provider's name-based delete is asynchronous. Acceptance is not proof of completion: the application records `deleting`, then requires a fresh provider `NOT_FOUND` for that exact resource before recording `deleted`. Provider failures, an unexpected replacement identity or uncertain token cleanup keep access frozen. GET status observes only; it does not retry a destructive provider call or restore access. Explicit recovery repeats the same typed physical name and immutable ID, preserving the deletion intent. The UI never automatically retries a create or delete POST.

Permanent deletion removes the physical Artifact and its Git data. There is no application restore/recycle-bin operation. Its namespace name remains retired in application metadata. A privileged operator's out-of-band namespace writes cannot be made atomic with the documented `delete(name)` API: neither binding nor REST documentation exposes an immutable-ID delete or compare-and-swap condition. All cooperating namespace mutations must use the application serializer and retirement rules; external administrative replacement between the final identity check and provider delete remains an operational limitation.

## Costs and verification limits

Cloudflare Artifacts repository operations and storage use the existing account plan; paid inference remains off. Official pricing states Artifacts billing starts October 14, 2026, with 10,000 monthly operations and 1 GB storage included, then $0.15 per 1,000 operations and $0.50 per GB-month. Aggregate usage determines actual charges. [Cloudflare Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/).

Local verification uses actual Better Auth, D1 and workerd with ephemeral synthetic accounts. Only external Artifacts transport is synthetic and outbound mail/network is blocked. Separate isolated Chromium UI QA uses a fresh temporary profile and synthetic API state. No callable Codex in-app browser tool is exposed in the current environment, so those checks do not claim IAB acceptance or a live user/provider flow. No live creation/deletion or broader lifecycle gate activation is part of implementation or draft-PR verification. The earlier requested `acme-website` repository remains uncreated until a separately executed supported user action confirms its actual immutable resource and owner.
