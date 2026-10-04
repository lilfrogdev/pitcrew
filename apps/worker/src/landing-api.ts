import { ExecutionError } from "../../../packages/execution/src/contracts";
import {
  TrustedLandingService,
  type LandingStore,
  type LandingTransport,
} from "../../../packages/execution/src/landing";
import type { Coordinator } from "./coordinator";
export interface LandingApi {
  service: TrustedLandingService;
  store: LandingStore;
  actor: string;
  backend: "fixture";
}
// This source reads only server-persisted execution evidence. Browser claims,
// artifact IDs, actors, target refs, and repository URLs never enter this port.
export function fixtureLandingApi(
  core: Coordinator,
  store: LandingStore,
  transport: LandingTransport,
  actor: string,
): LandingApi {
  const service = new TrustedLandingService(
    {
      read: async (runId) => {
        const evidence = core.evidence(runId),
          run = evidence.run;
        const review = evidence.reviews.at(-1);
        if (!run.candidateSha || !run.artifactId || !evidence.tests || !review)
          throw new ExecutionError("LANDING_EVIDENCE_REJECTED");
        return {
          runId,
          projectId: core.state.project.id,
          repository: core.state.project.repository,
          artifactId: run.artifactId,
          targetRef: "refs/heads/main",
          baseSha: run.baseSha,
          candidateSha: run.candidateSha,
          configurationRevision: run.configurationRevision,
          currentConfigurationRevision: core.state.project.configurationRevision,
          tests: [evidence.tests],
          review,
        };
      },
    },
    store,
    transport,
  );
  return { service, store, actor, backend: "fixture" };
}
export function assertConfigurationIdle(
  store: LandingStore,
  previous: Coordinator["state"]["project"],
  next: Coordinator["state"]["project"],
) {
  if (
    previous.baseSha !== next.baseSha ||
    previous.configurationRevision !== next.configurationRevision ||
    previous.repository !== next.repository
  ) {
    store.assertRepositoryIdle(previous.repository);
    if (previous.repository !== next.repository) store.assertRepositoryIdle(next.repository);
  }
}
