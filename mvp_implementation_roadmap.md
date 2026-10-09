# Pitcrew implementation roadmap

Work continues on `feat/pitcrew-cloud-mvp` in this repository. Do not create another worktree.

## Now: interactive mission slice

- [x] Check out `feat/pitcrew-cloud-mvp` in the existing repository.
- [x] Align these planning documents with the coordinator, PiHarness, and approval loop.
- [x] Add durable mission states: clarifying, proposed, approved, running, awaiting review, and a terminal outcome.
- [x] Require an explicit approval before `delegate_change` or mission start can queue an implementer.
- [x] Show questions, the proposal, approval, candidate ref, tests, exploratory probes, review, and the Flow handoff graph in the Work GUI.
- [x] Materialize the approved contract as `.agent_context/ASSERTIONS.json` and reject a missing or edited copy.
- [x] Add the small baseline fixture and a credential-safe provisioning script.
- [x] Prepare the backend container and observability configuration without enabling paid execution.
- [x] Prove the loop locally, including a browser pass. Keep cloud execution disabled until image registration, protected ingress, and explicit approval.

## Implemented already

- Workers, Durable Objects, and the React app served with the Worker.
- PiHarness lifecycle integration and serial change/review agents.
- Artifacts fork, publish, verification profiles, and admission controls.
- Per-user OpenRouter credentials, model selection, and read-only repository listing.

## After the slice

1. Select an authorized repository instead of the fixed baseline.
2. Subscribe to `cf.artifacts.repo.pushed` and run an idempotent validation Workflow. Then add Workers Preview and Browser Rendering evidence.
3. Start a new rework iteration from failed evidence, with attempt, token, and time limits. Do not modify a reviewed candidate.
4. Stream existing project events and verification results into the mission view.
5. Land with a trusted compare-and-swap only after validation and source-ref concurrency are proven.
6. Add multiplayer permissions and parallel missions.

## Validation

- `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build:worker`, and `pnpm build:backend`.
- Offline `pnpm cloudflare:preflight` must keep failing closed while execution is disabled or the sandbox image is unregistered.
- Browser: request, unanswered question, proposal edit, stale approval, disabled execution, and the approved evidence view.
