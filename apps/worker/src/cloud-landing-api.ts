import { ExecutionError } from "../../../packages/execution/src/contracts";
import {
  TrustedLandingService,
  type LandingAuthorization,
  type LandingStore,
  type LandingTransport,
} from "../../../packages/execution/src/landing";
import type { ArtifactsBinding } from "../../../packages/execution/src/cloudflare";
import type { Coordinator } from "./coordinator";
import type { LandingApi } from "./landing-api";

export interface ArtifactSource {
  name: string;
  repositoryId: string;
}
export function artifactRemote(remote: string): URL {
  const url = new URL(remote);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !/^[a-zA-Z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname) ||
    !/^\/git\/[^/]+\/[^/]+\.git$/.test(url.pathname)
  )
    throw new ExecutionError("INVALID_ARTIFACT_REMOTE");
  return url;
}
export function assertArtifactSource(source: ArtifactSource, info: ArtifactsRepoInfo) {
  const remote = artifactRemote(info.remote);
  if (
    info.name !== source.name ||
    info.id !== source.repositoryId ||
    info.readOnly ||
    info.defaultBranch !== "main" ||
    decodeURIComponent(remote.pathname.split("/")[3]) !== `${source.name}.git`
  )
    throw new ExecutionError("ARTIFACT_SOURCE_MISMATCH");
}
export function assertCandidateArtifact(
  source: ArtifactSource,
  sourceInfo: ArtifactsRepoInfo,
  artifactId: string,
  candidateInfo: ArtifactsRepoInfo,
) {
  assertArtifactSource(source, sourceInfo);
  const sourceRemote = artifactRemote(sourceInfo.remote),
    candidateRemote = artifactRemote(candidateInfo.remote);
  const namespace = sourceRemote.pathname.split("/")[2];
  if (
    candidateInfo.name !== artifactId ||
    candidateInfo.readOnly ||
    candidateInfo.defaultBranch !== "main" ||
    candidateInfo.id === sourceInfo.id ||
    candidateInfo.source !== `artifacts:${namespace}/${source.name}` ||
    candidateRemote.hostname !== sourceRemote.hostname ||
    candidateRemote.pathname.split("/")[2] !== namespace ||
    decodeURIComponent(candidateRemote.pathname.split("/")[3]) !== `${artifactId}.git`
  )
    throw new ExecutionError("CANDIDATE_ARTIFACT_MISMATCH");
}
export function artifactLandingApi(
  core: Coordinator,
  store: LandingStore,
  artifacts: ArtifactsBinding,
  actor: string,
  source: () => ArtifactSource | undefined,
  land: LandingTransport["land"],
): LandingApi {
  const fence = (runId: string) => {
    const run = core.evidence(runId).run;
    const pinned = run.artifactAdmission,
      current = source();
    if (
      !core.actorAuthorized(actor, run.threadId) ||
      !core.runAuthorized(runId) ||
      !["awaiting_review", "completed"].includes(run.status) ||
      !pinned ||
      !current ||
      pinned.sourceName !== current.name ||
      pinned.sourceRepositoryId !== current.repositoryId ||
      run.configurationRevision !== core.state.project.configurationRevision
    )
      throw new ExecutionError("LANDING_AUTHORITY_REVOKED");
    return { run, current };
  };
  const targetHead = async (authorization: LandingAuthorization) => {
    const { run, current } = fence(authorization.runId);
    if (
      authorization.targetRef !== "refs/heads/main" ||
      authorization.repository !== current.name ||
      authorization.projectId !== core.state.project.id ||
      authorization.artifactId !== run.artifactId ||
      authorization.expectedTargetSha !== run.baseSha ||
      authorization.candidateSha !== run.candidateSha ||
      authorization.configurationRevision !== run.configurationRevision
    )
      throw new ExecutionError("LANDING_EVIDENCE_REJECTED");
    using target = await artifacts.get(current.name);
    fence(authorization.runId);
    const info = await target.info();
    fence(authorization.runId);
    assertArtifactSource(current, info);
    const [head] = await target.log({ ref: "refs/heads/main", limit: 1 });
    fence(authorization.runId);
    if (!head) throw new ExecutionError("TARGET_UNAVAILABLE");
    return head.hash;
  };
  const service = new TrustedLandingService(
    {
      read: async (runId) => {
        const { run, current } = fence(runId),
          evidence = core.evidence(runId),
          review = evidence.reviews.at(-1);
        if (!run.candidateSha || !run.artifactId || !evidence.tests || !review)
          throw new ExecutionError("LANDING_EVIDENCE_REJECTED");
        // Current verification evaluates immutable test/review bindings. Recheck access
        // after its await before returning any authority to the landing service.
        await core.requireCurrentVerification(runId);
        fence(runId);
        return {
          runId,
          projectId: core.state.project.id,
          repository: current.name,
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
    { targetHead, land },
  );
  return { service, store, actor, backend: "artifacts" };
}
