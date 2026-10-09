# Repository-agent memory

Pitcrew's main repository agent can use a persistent, source-backed history view across
conversation turns. Implementation and review agents keep their ordinary Pi sessions and
compaction. They receive a bounded brief from the repository agent; they do not receive
memory tools or their own persistent repository-memory profiles.

The integration is opt-in through `REPO_MEMORY_ENABLED=true`. The committed production
configuration does not enable it. Enabling it does not enable cloud conversation or execution;
those retain their existing admission gates and per-user credential attribution.

## Design and authority

The repository Durable Object owns an append-only raw source journal and derived binary
summary nodes. Adjacent sources within a thread form leaves; pairs of nodes form progressively
coarser history. Raw source text remains authoritative history. A summary is a reference to
its covered sources and can be opened with zoom or located with bounded search. Invalid,
oversized, or non-shrinking compression output cannot replace source history.

Memory is untrusted reference data. It can help recall incidents, their impact, preferences,
and design decisions. It cannot authorize implementation, change accepted knowledge, override
explicit user requests or repository/runtime rules, accept a candidate, merge, or grant access.
Historical preferences and decisions require their source and date; current explicit rules
and accepted knowledge remain authoritative.

The turn snapshot excludes its current message and later queued requests. The current user
message is separately appended after the historical brief is frozen, and the final reply is
appended on completion. Stable message/part receipts make replays idempotent. Long message
JSON, including attachment references, is segmented losslessly at Unicode scalar boundaries
into at most 8,192 UTF-8 bytes per source part. Memory does not archive image bytes or hidden
reasoning. Stored file references retain their existing attachment policy.

Every retrieval uses current project/repository identity and thread membership. A source from
another thread is eligible only when the requesting actor and every current destination-thread
member can read that source thread. Frozen references are checked again when resuming a turn,
delegating a change, or preparing a worker/reviewer prompt. A removed member must not keep
access through a previously frozen brief or summary. Derived nodes remain within their source
thread scope. Change retries use the original frozen brief and history cutoff, with the current
retrying user's source access and credential attribution. They cannot admit newer history or
reuse the original user's memory tools or budgets. Public change responses omit internal memory briefs, including after membership
changes; destination-thread access alone cannot disclose a saved source brief.

## Bounds and failure behavior

These are explicit Pitcrew limits, not the author's unchanged runtime settings:

| Boundary                   | Limit                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| Generated node             | 512 UTF-8 bytes; one nonempty line; valid Unicode; shrinking                     |
| Raw source record          | 131,072 UTF-8 bytes; append-only; 4,096 parts per scope                          |
| Saved view                 | At most 32 binary ranges per thread scope                                        |
| Main turn disclosures      | At most 32 coalesced source ranges                                               |
| Retrieved scopes           | At most 32 eligible threads; 128 stored scopes overall                           |
| Search work                | 128 source parts per cursor page                                                 |
| Source authorization work  | At most 4,096 descendants per check                                              |
| Memory operations per turn | 24 total, including proactive retrieval/compression                              |
| Compression dispatches     | 4 per turn; 2 total per node across turns/restarts                               |
| Memory byte budget         | 131,072 input bytes and 32,768 output bytes per turn                             |
| Main model dispatches      | 16 attempts per turn, including uncertain dispatches                             |
| Main model text budget     | 1,048,576 input bytes and 65,536 output bytes per turn                           |
| Native model input         | 1,835,008 combined text/image bytes per request; 16,777,216 image bytes per turn |
| Main model response        | 4,096 output tokens; no provider/SDK retry; 20-second timeout                    |
| Compression response       | 256 output tokens; no transport retry; 20-second timeout                         |

The main model reserves 16,384 output bytes before dispatch. A lost response keeps its
reservation. The selected model's admitted context limit also applies, with 8,192 bytes
reserved for system/tool framing. Compressor input is separately capped at 16,384 bytes.
The existing application capacities, including 500 messages and 500 turns per project,
remain in force. This change does not promise unlimited retention or context.
Only actual native image blocks use the separate image allowance. Text and tool arguments,
including JSON that resembles an image, remain charged to the text budget. Image bytes remain
in the existing immutable attachment store, under its current admission and access checks.

Compression claims and attempt counts are committed before a provider is called. Crashes
consume the claim; replay cannot call the provider again for that claim. A future turn may
use the remaining node attempt. After both attempts are spent, the raw source remains
available and the range stays explicitly pending. No invalid response is truncated, flattened,
or accepted as the shortest fallback. Pending ranges can be expanded or searched; they are
not invented summaries. Budget/capacity exhaustion fails explicitly.
An acknowledged final reply remains in the original repository message history if its journal
append reaches capacity. The next source synchronization retries any missing journal parts
and blocks memory admission while capacity remains exhausted; it never truncates that reply.

SQLite transactions keep raw append, derived-node updates, and saved layouts consistent.
On reopen, source positions and saved coverage are validated; missing, overlapping, or
malformed layouts fail without rewriting history. Views retain their saved ranges, including
explicitly pending ranges, rather than being retiled from whichever summaries finish first.
Memory-mode main sessions use this bounded adapter and disable automatic Pi compaction.
Implementation/review sessions retain SDK defaults and their normal tool registries.

## Provenance

This is an original Pitcrew integration of the OptChat approach: persistent raw history, a
binary summary tree, a bounded history view, and source retrieval. It is informed by the MIT
licensed original implementation in
[`pi-optchat` v0.7.2 at `d692f03`](https://github.com/jonaslsaa/pi-optchat/tree/d692f03d863af7f0244643b4015f721c68784170).
Its filesystem/Pi-extension runtime is not directly imported into the Worker. See
[the retained license and notice](../THIRD_PARTY_NOTICES.md).

The community MIT grant explicitly excludes attributed upstream prompt text. No redistribution
license was established for Victor Taelin's recipe, including revision
`3c190e06f34aba0c69f49042c526093269604935`. Pitcrew does not copy that recipe or its prompts.
The compression and orchestration instructions here are original. This implementation does
not claim author-runtime parity or measured real-model recall quality.

The inspected pinned original `src/memory.ts` has SHA-256
`e08f5ebcbc5dea0c60133faccdac49aa2af7e979ae9db80d26c4f11d6163c9b8`;
the pinned `LICENSE` has SHA-256
`ba10808b4d9ada6f9bd26e58445431c64129258eebaab67d794d8a3cd1553984`.

## Rollout

Local tests use synthetic sources and canned/faux model responses. They establish storage,
budget, access, retry, and restart behavior, not recall quality from a live model. A separate
owner-approved rollout must review provider compatibility, costs, retention/deletion policy,
operational capacity, and the current infrastructure/conversation gates before enabling memory.
No paid comparison, live gate change, new cloud resource, deployment, push, or merge is part
of this implementation phase.
