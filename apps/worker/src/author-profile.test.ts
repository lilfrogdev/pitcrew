import { describe, expect, it } from "vite-plus/test";
import { api } from "./api";
import { Collaboration, type Identity } from "./collaboration";
import { Coordinator, initialState } from "./coordinator";
import { resolveCatalog } from "./model-selection";

const owner: Identity = {
  actor: "account:stable-owner",
  email: "owner@example.com",
  username: "actual_owner",
  displayName: "Optional Full Name",
  avatar: "/avatars/frog.svg",
};
const colleague: Identity = {
  actor: "account:stable-colleague",
  email: "colleague@example.com",
  username: "actual_colleague",
};
function fixture() {
  let saves = 0;
  const core = new Coordinator(initialState(), () => saves++);
  const access = (identity: Identity) => new Collaboration(core, identity, owner.email);
  access(owner).bootstrap();
  const thread = core.createThread("Shared", "thread", owner.actor, owner.email);
  core.updateCollaboration((state) => {
    state.collaboration!.projectMembers[colleague.actor] = { ...colleague, role: "editor" };
    state.collaboration!.threadMembers[thread.id][colleague.actor] = {
      ...colleague,
      role: "editor",
    };
  });
  return { core, access, thread, saves: () => saves };
}

describe("verified username projections", () => {
  for (const mode of ["note", "execution", "conversation"] as const)
    it(`freezes the verified author for both accounts in ${mode} messages`, async () => {
      const f = fixture();
      const catalog = resolveCatalog({ MODEL_CONFIGURATION: '{"provider":"fake"}' });
      for (const identity of [owner, colleague]) {
        // Provider credentials retain their original namespace independently of authorship.
        const app = api(
          f.core,
          () => {},
          undefined,
          { actor: `access:provider-${identity.actor}` },
          mode === "conversation" ? { catalog, dispatch: () => {} } : undefined,
          f.access(identity),
          mode === "note",
        );
        const response = await app.request(`/api/threads/${f.thread.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: "shared work",
            idempotencyKey: identity.username,
            username: "forged",
            author: { ...owner, username: "forged", actor: "account:forged" },
          }),
        });
        expect(response.status, await response.clone().text()).toBe(201);
        expect(f.core.state.messages.at(-1)?.author).toEqual(identity);
      }
      for (const identity of [owner, colleague]) {
        const response = await api(
          f.core,
          () => {},
          undefined,
          identity,
          undefined,
          f.access(identity),
        ).request(`/api/threads/${f.thread.id}/messages`);
        expect(((await response.json()) as { author: Identity }[]).map((m) => m.author)).toEqual([
          owner,
          colleague,
        ]);
      }
    });

  it("refreshes only profile metadata and keeps membership, keys, providers and historical authors", () => {
    const f = fixture();
    const historical = f.core.appendNote(f.thread.id, "old label", "old", owner.actor, owner);
    const legacy = f.core.appendNote(f.thread.id, "legacy label", "legacy", colleague.actor, {
      actor: colleague.actor,
      email: colleague.email,
      displayName: "Legacy Name",
    });
    f.core.state.collaboration!.projectMembers["access:legacy"] = {
      actor: "access:legacy",
      email: owner.email,
      role: "editor",
    };
    f.core.state.runActors = { "existing-run": owner.actor };
    f.core.state.credentialActors = { "existing-run": "access:original-provider" };
    const before = structuredClone(f.core.state);
    const renamed: Identity = {
      ...owner,
      username: "renamed_owner",
      displayName: "",
      avatar: null,
    };
    f.access(renamed).refreshProfile();
    const member = f.core.state.collaboration!.projectMembers[owner.actor];
    expect(member).toEqual({ ...renamed, role: "owner" });
    expect(f.core.state.collaboration!.threadMembers[f.thread.id][owner.actor]).toEqual(member);
    expect(Object.keys(f.core.state.collaboration!.projectMembers)).toEqual(
      Object.keys(before.collaboration!.projectMembers),
    );
    expect(f.core.state.collaboration!.projectMembers["access:legacy"]).toEqual(
      before.collaboration!.projectMembers["access:legacy"],
    );
    expect(f.core.state.collaboration!.projectMembers[colleague.actor]).toEqual(
      before.collaboration!.projectMembers[colleague.actor],
    );
    expect(f.core.state.keys).toEqual(before.keys);
    expect(f.core.state.runActors).toEqual(before.runActors);
    expect(f.core.state.credentialActors).toEqual(before.credentialActors);
    expect(f.core.state.messages).toEqual([historical, legacy]);
    const saves = f.saves();
    f.access(renamed).refreshProfile();
    expect(f.saves()).toBe(saves);
    // A same-email account cannot acquire or update someone else's membership.
    f.access({ ...renamed, actor: "account:unrelated" }).refreshProfile();
    expect(f.saves()).toBe(saves);
    const reloaded = new Coordinator(structuredClone(f.core.state), () => {});
    expect(new Collaboration(reloaded, renamed, owner.email).threadRole(f.thread.id)).toBe("owner");
    expect(reloaded.state.messages[1].author?.username).toBeUndefined();
  });

  it("projects actual username and optional full name for new repository owners and threads", async () => {
    const f = fixture();
    const project = f.core.addOwnedProject(
      "isolated-source",
      "immutable-source-id",
      owner.actor,
      owner.email,
      undefined,
      owner,
    );
    const repo = new Coordinator(f.core.state.ownedProjects![project.id].state, () => {});
    const access = new Collaboration(repo, owner, owner.email);
    const thread = repo.createThread("Plan", "plan", owner.actor, owner.email);
    expect(access.projectMembers(project.id)).toEqual([{ ...owner, role: "owner" }]);
    expect(access.threadMembers(thread.id)).toEqual([{ ...owner, role: "owner" }]);
    const request = api(repo, () => {}, undefined, owner, undefined, access);
    expect(await (await request.request("/api/account")).json()).toEqual(owner);
    expect(await (await request.request(`/api/projects/${project.id}/members`)).json()).toEqual([
      { ...owner, role: "owner" },
    ]);
    expect(await (await request.request(`/api/threads/${thread.id}/members`)).json()).toEqual([
      { ...owner, role: "owner" },
    ]);
  });
});
