# Normal native-account conversation scope

`CLOUD_CONVERSATION_SCOPE` is optional strict JSON with exactly `id`, `actor`, and
`projectId`. `actor` is the immutable native `account:<user-id>` principal. The
initial activation proposal supplies the approved Lara account and acme-website
project IDs; this source does not look up accounts or activate a deployment.

This normal profile permits user-initiated chat and memory in any currently
authorized thread of that project. It adds no lifetime turn quota, deadline,
forced model, text-only constraint, or provider-key spending requirement. The
existing server model catalog supplies choices and defaults. Repository storage
capacity and per-response budgets remain unchanged: 16 main model requests,
32 root tool calls, existing byte/token limits, timeouts, and 4 memory
compressions. These remain runaway protections, not a USD billing guarantee.

Normal scope and `CLOUD_CONVERSATION_CANARY` are mutually exclusive. Empty,
invalid, or unknown fields fail closed. Both modes deliberately use the existing
per-RepositoryAgent DO SQLite policy latch and original-turn receipts. After a
valid policy is inspected, removal, retargeting, ID changes, or mode changes
cannot silently restore global admission or reset the finite profile. There is
no reset API. Separate never-inspected DOs and erased storage do not inherit a
latch, so the approved complete deployment profile must keep the scope present.
Use an empty normal scope in the disabled profile, and omit the finite config
from the approved normal profile rather than setting both.

Receipts bind the original native account, payer, project, thread, and frozen
model selections. Current membership, the original session, and server gates
are rechecked at startup, resume, model/tool dispatch, and memory compression.
Other accounts and projects are rejected before provider status/key reads.
Failed turns, replay, and restart do not add a normal lifetime quota. Coding,
delegation, and visualization publication tools/RPCs remain unavailable under
the scoped read-only profile; memory tools remain read-only.

Authenticated `POST /api/threads/:threadId/turns/:turnId/stop` accepts exactly
empty JSON `{}`. Current thread access, the Stop POST's captured request session, and the
immutable initiating account are required. It durably marks an active turn
`status: "failed", error: "conversation_cancelled"` before bounded child cleanup,
so racing answers, later model/tool requests, and queued/resumed jobs cannot
restore the turn. An already dispatched provider request retains its timeout;
Stop does not claim a provider refund. Repeated Stop returns the terminal turn.
GET turns and Stop responses expose a server-computed `canStop` boolean without
exposing original session or payer identifiers. A new login can cancel the same
account's old turn, while paid execution still requires that turn's original
session. Stop remains available when
the chat admission gate is disabled.

All checked-in live gates remain unchanged. This patch performs no inference,
account/provider reads, credential changes, migration, deployment, or publish.
Tests use temporary native Better Auth/D1/SQLite/workerd state and synthetic
provider responses with external transport denied.
