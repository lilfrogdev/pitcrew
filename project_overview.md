# Pitcrew

Pitcrew is a governed agent-Git control plane on Cloudflare. A person describes a change in the Work GUI, answers clarifying questions, and approves one exact plan. Only then does a Pi agent implement that plan in an isolated Artifacts fork. Tests and an independent reviewer produce evidence before anyone treats the change as ready.

The coordinator is the source of truth for workflow state, approvals, and verification. Files written into a fork are immutable snapshots of that decision. They are not a second place to edit the contract.

## What exists today

Implemented:

- React Work GUI, repository listing, model catalog, and per-user encrypted OpenRouter credentials.
- `RepositoryAgent` coordinator with threads, intake, knowledge, verification profiles, and run evidence.
- `RepoConversationAgent`, `ChangeAgent`, and `ReviewAgent` using the Agents SDK `PiHarness` lifecycle and Pi Durable.
- Artifacts fork and candidate publish through the execution transport.
- One-run infrastructure admission, pinned verification plans, and command checks.
- Cloudflare Access on the backend. Execution, cloud conversation, and repository writes stay disabled until explicitly enabled.

Gated off in the committed backend configuration:

- `EXECUTION_MODE=disabled`
- `INFRASTRUCTURE_ADMISSION_ENABLED=false`
- `CLOUD_CONVERSATION_ENABLED=false`
- `REPOSITORY_LIFECYCLE=disabled`
- No registered sandbox image and no pinned baseline SHA.

Not built yet, and not required for the first usable loop:

- Push-triggered Workflows and Browser Rendering.
- Automatic rework, trusted production merge, user-selected repositories, and multiplayer permissions.

## First product loop

1. Choose the fixed baseline repository.
2. Describe the feature.
3. Answer the clarifying question.
4. Review the proposed summary, affected area, acceptance criterion, and command checks.
5. Approve that exact revision. Editing the proposal cancels the approval.
6. Start implementation. PiHarness edits an Artifacts fork, commits, and publishes a candidate ref.
7. Read the candidate SHA, command results, contract digest, and reviewer decision in the GUI.

Questions and proposal edits do not start a sandbox. One implementation is active per project.

## Later expansion

After this loop is proven:

1. Let a person select an authorized repository.
2. Add an idempotent Artifacts push Workflow, then Workers Preview and browser evidence.
3. Allow a budget-bounded rework iteration from failed evidence.
4. Show live mission events in the GUI.
5. Add trusted compare-and-swap landing.
6. Add multiplayer permissions and parallel missions.

## PiHarness

`PiHarness` and Pi Durable are beta. Pitcrew already registers the harness as a lifecycle capability inside `ChangeAgent`, `ReviewAgent`, and `RepoConversationAgent`. The first validation pass runs inside the change pipeline. A later push-triggered Workflow is an independent check, not a replacement for that evidence.
