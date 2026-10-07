import { ApiError } from "../src/api";
import { createFixtureApi } from "../src/fixtures";
import type { AuthUser } from "../src/auth-api";

// Synthetic account/membership authority for the actual App polling regression.
export function createVisualizationPollingFixture() {
  const api = createFixtureApi();
  const viewer: AuthUser = {
    id: "polling-viewer",
    name: "Polling viewer",
    username: "polling_viewer",
    email: "viewer@fixture.invalid",
    emailVerified: true,
  };
  const counts = { projects: 0, threads: 0, visualizations: 0 };
  let permitted = true;
  let failNextRead = false;
  let epoch = "fixture-session-1";
  const projects = api.projects;
  const threads = api.threads;
  api.projects = async () => {
    counts.projects++;
    return structuredClone(await projects());
  };
  api.threads = async (projectId) => {
    if (projectId === "pitcrew") counts.threads++;
    return permitted ? structuredClone(await threads(projectId)) : [];
  };
  const unsupported = async () => {
    throw Error("Fixture mutation is disabled");
  };
  api.collaboration = {
    account: async () => ({ actor: `account:${viewer.id}`, email: viewer.email }),
    repositories: async () => [],
    projectMembers: async () => [],
    threadMembers: async () => [],
    inviteProject: unsupported,
    inviteThread: unsupported,
    invitation: unsupported,
    acceptInvitation: unsupported,
    revokeInvitation: unsupported,
    removeProjectMember: unsupported,
    removeThreadMember: unsupported,
  };
  api.visualizations = async (projectId, threadId) => {
    counts.visualizations++;
    if (!permitted) throw new ApiError(404);
    if (failNextRead) {
      failNextRead = false;
      throw new ApiError(503);
    }
    return {
      accountId: `account:${viewer.id}`,
      repositoryId: projectId,
      threadId,
      accessEpoch: epoch,
      leaseMs: 5000,
      artifacts: Array.from({ length: 3 }, (_, index) => ({
        id: `polling-chart-${index}`,
        version: 1,
        repositoryId: projectId,
        threadId,
        creatorActor: `account:${viewer.id}`,
        turnId: "fixture-turn",
        invocationId: `fixture-call-${index}`,
        createdAt: index + 1,
        revision: 1,
        digest: "a".repeat(64),
        content: {
          kind: "bars",
          title: `Polling chart ${index + 1}`,
          summary: `Private polling description ${index + 1}`,
          height: 320,
          points: [
            { label: "One", value: 10 },
            { label: "Two", value: 20 },
          ],
        },
      })),
    };
  };
  return {
    api,
    viewer,
    counts,
    failNextRead: () => {
      failNextRead = true;
    },
    revoke: () => {
      permitted = false;
    },
    rotateSession: () => {
      epoch = "fixture-session-2";
    },
  };
}
