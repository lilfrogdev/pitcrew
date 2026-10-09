# Finite native-account conversation canary

This source adds an optional `CLOUD_CONVERSATION_CANARY` policy. No checked-in
deployment flag enables the trial. Activation requires separate approval with
the actual immutable native account actor, project ID, existing thread ID, and
explicit UTC deadline. Do not use an email, username, or a newly invented expiry.

The policy is strict JSON with exactly these fields:

```json
{
  "id": "approval-specific-trial-id",
  "actor": "account:immutable-native-user-id",
  "projectId": "immutable-project-id",
  "threadId": "existing-approved-thread-id",
  "expiresAt": "REPLACE_WITH_EXPLICIT_UTC_ISO_TIMESTAMP_WITH_MILLISECONDS",
  "maxTurns": 2
}
```

The placeholder deadline intentionally fails validation. `maxTurns` must be 1
or 2. The actual default model configuration must be BYOK OpenRouter
`qwen/qwen3.8-flash` with `OPENROUTER_API_KEY`; all frozen role selections must
be `default`/`off`. Native image inputs, including historical images, are denied
at the model dispatch fence. This is a text-only trial.

First inspection of a syntactically valid policy pins its ID and full policy fingerprint in a
singleton SQLite record, including when the requesting actor, thread, or model configuration is
rejected. Removing the policy, changing its ID, scope, quota, or deadline cannot
reopen global chat or replenish quota. There is no reset operation. Legacy
global behavior remains available only where a canary has never been inspected and
the configuration is absent. Empty or invalid configuration fails closed.

The latch belongs to each RepositoryAgent Durable Object, not the whole deployment
or each logical project. Current routing shares the named `pitcrew` DO across
logical projects. A separate never-inspected DO or erased storage cannot inherit
that latch. The complete approved deployment profile must keep this policy
present and prohibit storage reset or policy removal; no universal removal
protection is claimed.

A turn receipt consumes quota in the same synchronous SQLite transaction as
the message, turn, idempotency receipt, and original native-session grant. A
failed, interrupted, or uncertain provider admission stays charged. Concurrent
requests cannot admit a third turn. Replaying an unchanged original message
returns the original turn without a second charge. Restart does not reset
policy or receipts. Non-target and exhausted new admissions do not read
provider status. Existing global queued turns have no receipt and cannot run
under the trial.

Every main request, tool request, memory compression, and queued/resumed turn
checks its original durable receipt, immutable account/project/thread/model,
current membership, original session, and deadline. Logout followed by a new
sign-in cannot restore an old turn's session. Exhaustion automatically stops
new admissions while the two accepted turns may finish until the pinned
deadline. Expiry denies further dispatch rather than refunding quota.

The frozen trial profile offers no coding/delegation or visualization publication
tools; the root RPC also rejects direct publication and delegation. Read-only
`memory_view`, `memory_search`, and `memory_zoom` are available only when the
separately approved memory flag is enabled. Team notes and existing human
mentions remain unchanged and do not grant inference authority. Ordinary
memory-off conversation context is also destination-scoped, excluding private
sibling-thread knowledge and active intent from a shared destination.

Existing per-turn ceilings remain 16 main model requests and 4 memory
compressions: at most 40 application model dispatches across a two-turn trial
with memory. Memory-off has at most 32. These counts and existing token/byte
budgets are not a USD billing cap or a guarantee about gateway fallback or
provider billing. Any provider-key spending limit is a separate control.

Keep execution, infrastructure/coding, Git, delegation, intake, retry, worker,
publication, lifecycle, and deletion gates disabled. This patch does not change
deployment flags, accounts, memberships, migrations, credentials, or provider
limits. Tests use temporary native Better Auth/D1/SQLite/workerd state and a
synthetic model transport; they establish no live provider behavior.
