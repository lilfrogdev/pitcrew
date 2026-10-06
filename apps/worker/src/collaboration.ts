import { AdmissionError, type Coordinator } from "./coordinator";

export type Member = { actor: string; email: string; role: "owner" | "editor" };
export type Invitation = {
  id: string;
  digest: string;
  scope: "project" | "thread";
  threadId?: string;
  email: string;
  role: "editor";
  invitedBy: string;
  expiresAt: string;
  acceptedBy?: string;
  revokedAt?: string;
};
export type CollaborationState = {
  projectMembers: Record<string, Member>;
  threadMembers: Record<string, Record<string, Member>>;
  invitations: Record<string, Invitation>;
};
export type Identity = { actor: string; email: string; displayName?: string; avatar?: string | null };
const emailPattern = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/;
const missing = (): never => { throw new AdmissionError("not_found", 404); };
const forbidden = (): never => { throw new AdmissionError("forbidden", 403); };
const normalizedEmail = (value: unknown) => {
  if (typeof value !== "string" || value.length > 254 || !emailPattern.test(value))
    throw new AdmissionError("invalid_email");
  return value.toLowerCase();
};
async function digest(token: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function tokenString() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export class Collaboration {
  constructor(
    private core: Coordinator,
    readonly identity: Identity,
    private ownerEmail: string,
  ) {}
  // Old single-user state belongs only to the configured, verified owner. An
  // allowlisted colleague cannot claim it by being the first request after deploy.
  bootstrap() {
    if (this.core.state.collaboration || this.identity.email !== this.ownerEmail) return;
    this.core.updateCollaboration((state) => {
      if (state.collaboration) return;
      const owner: Member = { ...this.identity, role: "owner" };
      state.collaboration = {
        projectMembers: { [owner.actor]: owner },
        threadMembers: Object.fromEntries(state.threads.map((thread) => [
          thread.id, { [owner.actor]: owner },
        ])),
        invitations: {},
      };
    });
  }
  private state() { return this.core.state.collaboration; }
  account() { return { ...this.identity }; }
  rebindLegacy(accessActor: string) {
    if (accessActor === this.identity.actor || !this.core.state.collaboration) return;
    const project = this.core.state.collaboration.projectMembers[accessActor];
    if (!project || project.email !== this.identity.email) return;
    this.core.updateCollaboration((state) => {
      const access = state.collaboration!;
      const old = access.projectMembers[accessActor];
      if (!old || old.email !== this.identity.email || access.projectMembers[this.identity.actor])
        throw new AdmissionError("identity_binding_conflict", 403);
      access.projectMembers[this.identity.actor] = { ...old, actor: this.identity.actor };
      delete access.projectMembers[accessActor];
      for (const members of Object.values(access.threadMembers)) {
        const previous = members[accessActor];
        if (!previous) continue;
        members[this.identity.actor] = { ...previous, actor: this.identity.actor };
        delete members[accessActor];
      }
    });
  }
  projectRole() { return this.state()?.projectMembers[this.identity.actor]?.role; }
  threadRole(threadId: string) {
    return this.projectRole() && this.state()?.threadMembers[threadId]?.[this.identity.actor]?.role;
  }
  requireProject(projectId: string, owner = false) {
    if (projectId !== this.core.state.project.id || !this.projectRole()) missing();
    if (owner && this.projectRole() !== "owner") forbidden();
  }
  requireThread(threadId: string, owner = false) {
    if (!this.core.state.threads.some((thread) => thread.id === threadId) || !this.threadRole(threadId))
      missing();
    if (owner && this.threadRole(threadId) !== "owner" && this.projectRole() !== "owner")
      forbidden();
  }
  visibleThread(threadId: string) { return !!this.threadRole(threadId); }
  projectMembers(projectId: string) {
    this.requireProject(projectId);
    return Object.values(this.state()!.projectMembers);
  }
  threadMembers(threadId: string) {
    this.requireThread(threadId);
    return Object.values(this.state()!.threadMembers[threadId] ?? {});
  }
  async invite(scope: "project" | "thread", scopeId: string, emailValue: unknown, role: unknown) {
    if (scope === "project") this.requireProject(scopeId, true);
    else this.requireThread(scopeId, true);
    if (role !== "editor") throw new AdmissionError("invalid_role");
    const email = normalizedEmail(emailValue);
    if (email === this.identity.email) throw new AdmissionError("already_member", 409);
    const token = tokenString(), id = crypto.randomUUID(), hashed = await digest(token);
    const invitation: Invitation = {
      id, digest: hashed, scope, ...(scope === "thread" ? { threadId: scopeId } : {}),
      email, role, invitedBy: this.identity.actor,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.core.updateCollaboration((state) => {
      const access = state.collaboration!;
      if (scope === "project") {
        if (access.projectMembers[this.identity.actor]?.role !== "owner") forbidden();
      } else if (!access.threadMembers[scopeId]?.[this.identity.actor] &&
                 access.projectMembers[this.identity.actor]?.role !== "owner") missing();
      if (Object.keys(access.invitations).length >= 100) throw new AdmissionError("capacity", 429);
      access.invitations[id] = invitation;
    });
    return { token, invitation: this.publicInvitation(invitation) };
  }
  private publicInvitation(invitation: Invitation) {
    const { digest: _digest, ...publicValue } = invitation;
    return publicValue;
  }
  private async find(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) missing();
    const hashed = await digest(token);
    const invitation = Object.values(this.state()?.invitations ?? {}).find((item) => item.digest === hashed);
    return invitation ?? missing();
  }
  async preview(token: string) {
    const invite = await this.find(token);
    if (invite.email !== this.identity.email && this.projectRole() !== "owner") missing();
    return this.publicInvitation(invite);
  }
  async accept(token: string) {
    const invite = await this.find(token);
    if (invite.email !== this.identity.email) missing();
    return this.core.updateCollaboration((state) => {
      const current = state.collaboration?.invitations[invite.id];
      if (!current || current.digest !== invite.digest || current.revokedAt || current.acceptedBy ||
          Date.parse(current.expiresAt) <= Date.now()) throw new AdmissionError("invitation_unavailable", 410);
      const member: Member = { ...this.identity, role: current.role };
      if (current.scope === "thread") {
        if (!state.collaboration?.projectMembers[this.identity.actor] ||
            !state.threads.some((thread) => thread.id === current.threadId)) missing();
        (state.collaboration!.threadMembers[current.threadId!] ??= {})[member.actor] = member;
      } else {
        state.collaboration!.projectMembers[member.actor] = member;
      }
      current.acceptedBy = member.actor;
      return this.publicInvitation(current);
    });
  }
  async revoke(token: string) {
    const invite = await this.find(token);
    if (this.projectRole() !== "owner" &&
        (invite.scope !== "thread" || this.threadRole(invite.threadId!) !== "owner")) forbidden();
    return this.core.updateCollaboration((state) => {
      const current = state.collaboration?.invitations[invite.id] ?? missing();
      if (current.digest !== invite.digest) missing();
      current.revokedAt ??= new Date().toISOString();
      return this.publicInvitation(current);
    });
  }
  remove(scope: "project" | "thread", scopeId: string, actor: string) {
    if (scope === "project") this.requireProject(scopeId, true);
    else this.requireThread(scopeId, true);
    if (actor === this.identity.actor || actor.length > 256) throw new AdmissionError("invalid_member");
    return this.core.updateCollaboration((state) => {
      const access = state.collaboration!;
      const members = scope === "project" ? access.projectMembers : access.threadMembers[scopeId];
      const target = members?.[actor];
      if (!target) missing();
      if (target.role === "owner") forbidden();
      delete members[actor];
      if (scope === "project") {
        for (const threadMembers of Object.values(access.threadMembers)) delete threadMembers[actor];
        for (const invite of Object.values(access.invitations))
          if (invite.email === target.email && !invite.acceptedBy) invite.revokedAt ??= new Date().toISOString();
      }
      return { removed: actor };
    });
  }
}
