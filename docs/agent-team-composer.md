# Agent and Team messages

The composer starts in **Team**. Click Team or Agent to choose a destination. With the
textarea focused, Tab changes the destination; an open mention picker consumes Tab first.
Escape then Tab moves to the next control, and Shift+Tab moves to the previous control.
Switching preserves the draft, attachments and selected mentions.

A Team send saves a human message without starting inference, compaction, a change or a run.
Selecting the reserved `@agent` item, or explicitly typing that token, invokes the main
repository agent from Team. Human mentions select current members and do not invoke an agent.
Pasted, escaped, quoted and code tokens remain literal. Multiple reserved mentions and an
Agent destination still admit one turn. Neither destination nor any mention grants access or
invites a person; sharing requires the existing explicit project/thread invitation flow.

The HTTP request carries `destination: "team" | "agent"` and optional `agentMentions` ranges
separately from human actor mentions. Omitted destination means Team. The server validates
the exact reserved token, current thread/project membership and invocation availability.
It freezes the original session, initiating actor and provider credential actor. Clients cannot
choose a payer. A shared durable admission receipt binds destination, mention ranges, content,
attachments and model selection to the actor/thread/idempotency key. Replays return the same
message and turn; changed intent conflicts. A failed send leaves the draft intact.

## Admission and memory

`CLOUD_CONVERSATION_ENABLED=true` admits configured cloud conversation independently of
`EXECUTION_MODE` and `INFRASTRUCTURE_ADMISSION_ENABLED`. The checked-in production flags
remain disabled. A configured account-bound provider and model catalog are required only for
invocation; Team notes work without them. Native password sessions use their own account
credential namespace. Existing Access credentials remain attributed to their Access actor.

Conversation activation does not authorize implementation or Git work. The main agent only
receives `delegate_change` when the existing coding gates permit it, and the server checks the
gate before creating a run. Worker start/recovery gates remain in force. All main turns have
durable model/tool budgets, fresh original-session and membership checks, and bounded output;
implementation and reviewer agents keep ordinary Pi compaction.

Team history is available to the next invocation under current audience ACLs. An active turn
uses its frozen message cutoff, so later human notes do not steer it. Enabled main-agent memory
keeps append-only raw history and requires the source audience to cover the destination audience
at retrieval and use. Memory cannot grant permission or override explicit repository rules.
No background summarization job is created by a Team send. See
[repository memory](repository-memory.md) for the OptChat-style implementation, licensing and
bounded compressor behavior.

## Local verification

```sh
pnpm exec vp test run apps/worker/src/agent-team-security.test.ts apps/worker/test/agent-team-integration.test.ts apps/worker/test/agent-team-security.test.ts --maxWorkers=1
pnpm exec vp -C apps/web test run src/Composer.destination.test.tsx
node --experimental-transform-types apps/web/poc/agent-team-browser-check.mjs /tmp/pitcrew-agent-team-evidence
```

The native fixtures use real Better Auth/D1, encrypted synthetic credentials, Durable Objects
and Pi with external model transport replaced by a deterministic faux response. They deny
outbound network. The browser starts empty Chromium profiles against production UI/adapters
and relays, using a checked ephemeral-origin adapter. It covers keyboard switching/focus,
attachment retention, Team no-call behavior, explicit agent invocation, restart and narrow UI.
It does not inspect a human session, enable a live gate or verify paid-provider availability.
Native provider replacement excludes production stream-option enforcement; separate budget and
source tests cover the production bounds.
