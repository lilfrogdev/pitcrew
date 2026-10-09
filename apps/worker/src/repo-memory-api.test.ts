import { expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration } from "./collaboration";
import { Coordinator, initialState } from "./coordinator";

it("keeps frozen source-scoped briefs out of both public change projections after revocation, recipient changes and restart", async () => {
  const alice = { actor: "alice", email: "alice@example.test", role: "owner" as const };
  const bob = { actor: "bob", email: "bob@example.test", role: "editor" as const };
  let core = new Coordinator(initialState(), () => {});
  const source = core.createThread("Source", "source");
  const destination = core.createThread("Destination", "destination");
  core.state.collaboration = {
    projectMembers: { alice, bob },
    threadMembers: { [source.id]: { alice, bob }, [destination.id]: { alice, bob } },
    invitations: {},
  };
  const submitted = core.submit(
    destination.id,
    "Implement the current request",
    "request",
    alice.actor,
  );
  const change = core.change(submitted.run.changeId!);
  change.memoryBrief = {
    projectId: core.state.project.id,
    repository: core.state.project.repository,
    destinationThreadId: destination.id,
    items: [
      {
        nodeId: "private-node",
        text: "PRIVATE_SOURCE_INCIDENT_AFTER_REVOCATION",
        pending: false,
        sourceRefs: [{ scopeId: "private-scope", first: 0, last: 1 }],
      },
    ],
  };
  const paths = [`/api/threads/${destination.id}/changes`, `/api/changes/${change.id}`];
  const assertPublic = async () => {
    const app = api(
      core,
      () => {},
      undefined,
      bob,
      undefined,
      new Collaboration(core, bob, alice.email),
    );
    for (const path of paths) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const value = await response.json();
      expect(JSON.stringify(value)).not.toContain("PRIVATE_SOURCE_INCIDENT_AFTER_REVOCATION");
      expect(Array.isArray(value) ? value[0] : value).toMatchObject({
        id: change.id,
        threadId: destination.id,
      });
      expect(Array.isArray(value) ? value[0] : value).not.toHaveProperty("memoryBrief");
    }
    expect(core.change(change.id).memoryBrief).toEqual(change.memoryBrief);
  };
  await assertPublic();
  delete core.state.collaboration.threadMembers[source.id].bob;
  await assertPublic();
  // A recipient added after the brief was frozen is equally unable to read its source.
  delete core.state.collaboration.threadMembers[destination.id].bob;
  core.state.collaboration.threadMembers[destination.id].bob = bob;
  core = new Coordinator(structuredClone(core.state), () => {});
  await assertPublic();
});
