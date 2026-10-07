# Composer status and thread typing

The compact strip above the composer shows one status at a time: an actionable
pending landing approval, recovery after a connection failure, then other people
typing. Review opens the existing Review / PR controls and focuses the pending
approval; it grants no permission. Approval eligibility uses the same exact
candidate, test, review and capability checks as the existing landing control.
Ordinary successful snapshot polling does not show Reconnecting. The strip appears
only while a status is active, keeps a fixed 32px height when switching active
statuses, and reserves no space when idle. An invisible live region stays outside
the layout for polite announcements. Long names are abbreviated visually.

`GET /api/threads/:threadId/presence` returns only other active accounts' trusted
usernames and remaining lease durations. `POST` accepts exactly `clientId`,
`sequence` and `active`. Both requests pass the existing Access/account admission,
local relay nonce/origin protections and current project/thread membership checks.
Membership is checked again after reading a mutation body, and each returned
typer is checked against current membership. Neither endpoint returns a roster,
email, actor identifier, tab identifier, draft text or another thread's presence.

Presence lives only in the RepositoryAgent's memory. It creates no database rows,
chat messages, events or persisted coordinator state. A restart forgets all
presence. Each active tab expires after six seconds unless refreshed. The UI
refreshes activity at most every two seconds, stops after four seconds without
input, and stops on submission, input blur, window blur, hidden visibility,
pagehide, leaving Work, thread change and disconnect. Unload/disconnect stops are
best effort; the short server lease and local display expiry bound stale status.
Visibility/focus/reconnect resumes reads and requires new input to resume typing.
IME composition is activity; composing Enter does not send a message.

Reads poll only the selected thread every two seconds while visible/foreground.
The client subtracts response latency from each remaining lease, expires names
independently of later reads, and ignores responses from an obsolete lifecycle.
Multiple tabs combine by authenticated account. Ordered, coalesced writes and
sequence fences prevent delayed starts from reviving stopped typing. Stop retries
on relay contention are bounded. No failed durable message is replayed.

The server admits at most eight active tabs and 64 recent leases per account,
2,048 leases and 1,024 rate buckets per RepositoryAgent. Per account it admits
120 writes and 240 reads per minute, and refreshes a tab at most once per second.
Inactive sequence fences and rate buckets are pruned after one minute. Presence
bodies are limited to 512 bytes and five seconds; responses are private/no-store.
Ephemeral writes leave the relay's final request slot for durable mutations and
do not acquire or release its durable-write lock.

The tests use independent synthetic clients against real API routes, synthetic
one/two/three-person counts, deduplication, expiry, privacy/revocation, a membership
change during body receipt, request ordering/contention, IME and window/thread
lifecycle. Live shared presence requires this backend and frontend version to be
deployed together with the already configured authenticated collaboration setup.
