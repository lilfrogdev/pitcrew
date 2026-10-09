import { invitationSelector } from "../../../packages/protocol/src/invitations";
import { canonicalRepositoryName } from "./repository-names";
import { createUploadApi, type UploadApi } from "./uploads/api";
import type { UploadSubmission } from "@pitcrew/protocol";
import { createRepositoryApi, type RepositoryApi } from "./repository-api";
import type { PresenceApi, TypingSnapshot } from "./thread-presence";
import type {
  Project,
  Thread,
  Message,
  Mission,
  Run,
  Review,
  RunEvidence,
  LandingAuthorizationReceipt,
  LandingResultReceipt,
  SubmittedAttachment,
  AttachmentCapabilities,
  AgentMention,
  MessageDestination,
  ModelChoice,
  ModelSelection,
  ModelSettings,
  OrchestrationTrace,
} from "@pitcrew/protocol";
import type { SourceApi } from "@pitcrew/protocol";
import type { OpenRouterConnectionApi, OpenRouterStatus } from "./openrouter-types";
import { loadVisualizationJson } from "./visualizations/controller";
export type { Project, Thread, Message, Run, Review } from "@pitcrew/protocol";
export type SharedMessage = Message & {
  author?: Account;
};
export type ConversationTurn = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  /** Computed by the authenticated server for the initiating account. */
  canStop?: boolean;
  error?: string;
};
export type Snapshot = {
  messages: SharedMessage[];
  runs: Run[];
  reviews: Review[];
  evidence: RunEvidence[];
  turns?: ConversationTurn[];
};
export type LandingCapabilities = {
  landing: { enabled: boolean; backend: LandingAuthorizationReceipt["backend"] | null };
  /** Enables durable human messages without claiming agent execution. */
  notesEnabled?: boolean;
  uploads?: { fileBytes: number; totalBytes: number; count: number };
  composer?: {
    models: ModelChoice[];
    settings: ModelSettings;
    conversation: boolean;
    /** Display metadata never authorizes this API's Work transport. */
    displayOnly?: boolean;
    catalogRevision?: string;
    executionEnabled?: boolean;
    attachments?: AttachmentCapabilities;
  };
};
export type ApprovalInput = {
  expectedTargetSha: string;
  candidateSha: string;
  configurationRevision: string;
  idempotencyKey: string;
};
export type Authorization = LandingAuthorizationReceipt;
export type LandingResult = LandingResultReceipt;
export type Account = {
  actor: string;
  email: string;
  displayName?: string;
  username?: string;
  avatar?: string | null;
};
export type Member = Account & { role: "owner" | "editor" };
export type SharedRepository = {
  projectId: string;
  name: string;
  role: "owner" | "editor";
  logicalName?: string;
  repositoryName?: string;
  repositoryId?: string;
  description?: string;
  metadataRevision?: number;
  status: "present" | "deleting";
  lifecycle: "registered" | "deleting";
  deletable: boolean;
};
export type ApprovedProjectAdoption = {
  name: string;
  repositoryId: string;
};
export type RepositoryCreation = {
  name: string;
  logicalName?: string;
  repositoryName?: string;
  repositoryId?: string;
  status:
    | "pending"
    | "cleanup_required"
    | "registration_required"
    | "ready"
    | "deleting"
    | "deleted";
  projectId?: string;
};
export type RepositoryCreations = {
  approval: { name: string } | null;
  creations: RepositoryCreation[];
  capabilities?: { create: boolean; manage: boolean; delete: boolean };
};
export type RepositoryMetadata = {
  logicalName?: string;
  displayName: string;
  description: string;
  expectedRevision?: number;
};
export type RepositoryDeletion = { confirmation: string; repositoryId: string };
export type RepositoryStatus = {
  logicalName?: string;
  projectId: string;
  name: string;
  repositoryName: string;
  repositoryId: string;
  description: string;
  metadataRevision: number;
  role: "owner";
  status: "present" | "deleting" | "deleted";
  lifecycle: "registered" | "deleting" | "deleted";
  deletable: boolean;
};
export type Invitation = {
  id: string;
  recipient?: string;
  email?: string;
  role: "editor";
  expiresAt: string;
  scope: "project" | "thread";
  projectId: string;
  threadId?: string;
  acceptedBy?: string;
  revokedAt?: string;
};
export type InvitationPreview = Invitation;
export type CreatedInvitation = { token: string; invitation: Invitation };
export const invitationRecipient = (invitation: Invitation) =>
  invitation.recipient ?? invitation.email ?? "recipient";
export interface CollaborationApi {
  account(): Promise<Account>;
  repositories(): Promise<SharedRepository[]>;
  approvedProjectAdoptions?(): Promise<ApprovedProjectAdoption[]>;
  adoptProject?(name: string, repositoryId: string): Promise<Project>;
  repositoryCreations?(): Promise<RepositoryCreations>;
  createRepository?(
    name: string,
    credentialConsent: true,
    metadata?: { displayName: string; description: string },
  ): Promise<RepositoryCreation>;
  updateRepository?(projectId: string, metadata: RepositoryMetadata): Promise<Project>;
  deleteRepository?(projectId: string, target: RepositoryDeletion): Promise<RepositoryStatus>;
  repositoryStatus?(projectId: string): Promise<RepositoryStatus>;
  projectInvitations?(projectId: string): Promise<Invitation[]>;
  revokeProjectInvitation?(projectId: string, invitationId: string): Promise<Invitation>;
  projectMembers(projectId: string): Promise<Member[]>;
  threadMembers(threadId: string): Promise<Member[]>;
  inviteProject(projectId: string, recipient: string): Promise<CreatedInvitation>;
  inviteThread(threadId: string, recipient: string): Promise<CreatedInvitation>;
  invitation(token: string): Promise<InvitationPreview>;
  acceptInvitation(token: string): Promise<InvitationPreview>;
  revokeInvitation(token: string): Promise<unknown>;
  removeProjectMember(projectId: string, actor: string): Promise<unknown>;
  removeThreadMember(threadId: string, actor: string): Promise<unknown>;
}
export interface Api {
  uploads?: UploadApi;
  source?: SourceApi;
  visualizations?(projectId: string, threadId: string, signal: AbortSignal): Promise<unknown>;
  presence?: PresenceApi;
  openrouter?: OpenRouterConnectionApi;
  repositories?: RepositoryApi;
  collaboration?: CollaborationApi;
  capabilities(projectId?: string): Promise<LandingCapabilities>;
  approve(runId: string, input: ApprovalInput): Promise<Authorization>;
  land(runId: string, authorizationId: string): Promise<LandingResult>;
  reconcile(runId: string, authorizationId: string): Promise<LandingResult>;
  projects(): Promise<Project[]>;
  threads(projectId: string): Promise<Thread[]>;
  setThreadArchived?(projectId: string, threadId: string, archived: boolean): Promise<Thread>;
  snapshot(threadId: string): Promise<Snapshot>;
  stopTurn?(threadId: string, turnId: string): Promise<ConversationTurn>;
  latestRun?(threadId: string): Promise<Run | undefined>;
  createThread(projectId: string, title: string, key: string): Promise<Thread>;
  setThreadModelSelection?(
    projectId: string,
    threadId: string,
    selection: ModelSelection,
  ): Promise<Thread>;
  setModelSettings?(projectId: string, settings: ModelSettings): Promise<ModelSettings>;
  attachmentUrl?(threadId: string, attachmentId: string): string;
  trace(threadId: string, after?: number): Promise<OrchestrationTrace>;
  missions: {
    current(threadId: string): Promise<Mission | null>;
    create(projectId: string, threadId: string, request: string, key: string): Promise<Mission>;
    answer(missionId: string, questionId: string, answer: string, key: string): Promise<Mission>;
    revise(
      missionId: string,
      input: { summary: string; affectedArea: string; criterion: string },
      key: string,
    ): Promise<Mission>;
    approve(missionId: string, revision: string, key: string): Promise<Mission>;
    start(missionId: string, key: string): Promise<{ mission: Mission; run: Run }>;
  };
  send(
    threadId: string,
    content: string,
    key: string,
    attachments?: (SubmittedAttachment | UploadSubmission)[],
    selection?: ModelSelection,
    mentions?: import("@pitcrew/protocol").SubmittedMention[],
    destination?: MessageDestination,
    agentMentions?: AgentMention[],
  ): Promise<unknown>;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code?:
      | "repository_exists"
      | "revision_conflict"
      | "repository_name_retired"
      | "invalid_recipient"
      | "recipient_unavailable"
      | "already_member"
      | "invitation_unavailable",
  ) {
    super(
      code === "invalid_recipient"
        ? "Enter a username or email address."
        : code === "recipient_unavailable"
          ? "That recipient is unavailable for this invitation. Check the username or email; thread recipients must already have repository access."
          : code === "already_member"
            ? "That account already has access."
            : code === "invitation_unavailable"
              ? "This invitation is no longer usable. Ask a repository owner to revoke it and create a new invitation."
              : status === 403 || status === 401
                ? "Access is unavailable. Ask the project owner to enable protected access."
                : status === 404
                  ? "This shared item is no longer available. Refresh your workspace."
                  : status === 410
                    ? "This invitation has expired or was already used. Ask for a new code."
                    : status === 409
                      ? "The thread changed. Refresh before trying again."
                      : status === 413
                        ? "This message is too large. Shorten it and try again."
                        : status === 429
                          ? "The crew is at capacity. Wait for an active change to finish, then try again."
                          : "Could not reach Pitcrew. Your draft is saved here; try again.",
    );
  }
}
let sessionRequest: Promise<string | null> | undefined;
let activeReads = 0;
const waitingReads: (() => void)[] = [];
async function readWithBudget<T>(read: () => Promise<T>): Promise<T> {
  // The local relay admits four product requests. Leave one slot for a write.
  if (activeReads >= 3) await new Promise<void>((resolve) => waitingReads.push(resolve));
  else activeReads++;
  try {
    return await read();
  } finally {
    const next = waitingReads.shift();
    if (next) next();
    else activeReads--;
  }
}
async function sessionNonce(): Promise<string | null> {
  const response = await fetch("/api/local-session", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("pitcrew-auth-required"));
    throw new ApiError(response.status);
  }
  const { nonce } = (await response.json()) as { nonce: string | null };
  if (nonce !== null && (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)))
    throw new ApiError(0);
  return nonce;
}
export async function mutationHeaders(): Promise<Record<string, string>> {
  // Share only in-flight bootstrap, so simultaneous first mutations use one cookie.
  sessionRequest ??= sessionNonce().finally(() => {
    sessionRequest = undefined;
  });
  const nonce = await sessionRequest;
  return {
    "Content-Type": "application/json",
    ...(nonce ? { "X-Pitcrew-Local-Nonce": nonce } : {}),
  };
}
export async function apiFetch(path: string, body?: unknown): Promise<Response> {
  const repositoryCreation = path === "/repositories/create";
  const repositoryDeletion = path.endsWith("/repository/delete");
  const send = async () => {
    const headers = body ? await mutationHeaders() : undefined;
    const perform = () =>
      fetch(`/api${path}`, {
        method: body ? "POST" : "GET",
        // Reads include edge admission, cached-token/JWKS checks and the relay's
        // own upstream deadline. Don't free a client slot before that work ends.
        signal: AbortSignal.timeout(
          body && !repositoryCreation && !repositoryDeletion ? 10000 : 45000,
        ),
        headers,
        ...(path.includes("/source/") ||
        path === "/project-adoptions" ||
        path === "/repository-creations" ||
        repositoryCreation ||
        repositoryDeletion ||
        path.endsWith("/stop") ||
        path.endsWith("/repository") ||
        path.endsWith("/invitations")
          ? { cache: "no-store" as const }
          : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    const response = body ? await perform() : await readWithBudget(perform);
    return { response, local: !!headers?.["X-Pitcrew-Local-Nonce"] };
  };
  const first = await send();
  // A rejected local admission has no side effects. Another tab may have
  // established the session cookie while our initial bootstrap was in flight.
  if (!repositoryCreation && !repositoryDeletion && first.local && first.response.status === 403)
    return (await send()).response;
  return first.response;
}

const publicIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
function repositoryCapabilities(value: unknown): {
  create: boolean;
  manage: boolean;
  delete: boolean;
} {
  if (
    !value ||
    typeof value !== "object" ||
    !("create" in value) ||
    !("manage" in value) ||
    typeof value.create !== "boolean" ||
    typeof value.manage !== "boolean" ||
    ("delete" in value && typeof value.delete !== "boolean")
  )
    throw new ApiError(0);
  return {
    create: value.create,
    manage: value.manage,
    delete: "delete" in value ? (value.delete as boolean) : false,
  };
}
async function repositoryFailure(response: Response): Promise<ApiError> {
  if (response.status !== 409) return new ApiError(response.status);
  const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const code = value?.error;
  return new ApiError(
    409,
    ["repository_exists", "revision_conflict", "repository_name_retired"].includes(code as string)
      ? (code as ApiError["code"])
      : undefined,
  );
}
function repositoryStatus(value: unknown): RepositoryStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(0);
  const item = value as Record<string, unknown>;
  if (
    (item.logicalName !== undefined &&
      (typeof item.logicalName !== "string" ||
        canonicalRepositoryName(item.logicalName) !== item.logicalName)) ||
    !publicIdentifier(item.projectId) ||
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.length > 80 ||
    // eslint-disable-next-line no-control-regex -- Repository display labels reject hidden controls.
    /[\x00-\x1f\x7f]/.test(item.name) ||
    typeof item.repositoryName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.repositoryName) ||
    !publicIdentifier(item.repositoryId) ||
    typeof item.description !== "string" ||
    item.description.length > 1000 ||
    // eslint-disable-next-line no-control-regex -- Descriptions permit LF and tab, but reject other controls.
    /[\x00-\x08\x0b-\x1f\x7f]/.test(item.description) ||
    !Number.isSafeInteger(item.metadataRevision) ||
    (item.metadataRevision as number) < 0 ||
    item.role !== "owner" ||
    !["present", "deleting", "deleted"].includes(item.status as string) ||
    item.lifecycle !== (item.status === "present" ? "registered" : item.status) ||
    typeof item.deletable !== "boolean" ||
    (item.status !== "present" && item.deletable !== false)
  )
    throw new ApiError(0);
  return {
    ...(item.logicalName === undefined ? {} : { logicalName: item.logicalName as string }),
    projectId: item.projectId,
    name: item.name,
    repositoryName: item.repositoryName,
    repositoryId: item.repositoryId,
    description: item.description,
    metadataRevision: item.metadataRevision as number,
    role: "owner",
    status: item.status as RepositoryStatus["status"],
    lifecycle: item.lifecycle as RepositoryStatus["lifecycle"],
    deletable: item.deletable,
  };
}
function canonicalInvitationLabel(item: {
  recipient?: unknown;
  email?: unknown;
}): string | undefined {
  if ((item.recipient === undefined) === (item.email === undefined)) return;
  const label = item.recipient ?? item.email;
  if (typeof label !== "string" || /[\x00-\x1f\x7f]/.test(label)) return;
  const selector = invitationSelector(label);
  if (!selector || (item.email !== undefined && selector.kind !== "email")) return;
  const canonical = selector.kind === "username" ? `@${selector.value}` : selector.value;
  return label === canonical ? canonical : undefined;
}
/** Bind only a newly created invitation to the submitted selector, never to profile metadata. */
export function invitationMatchesRecipient(invitation: Invitation, recipient: string): boolean {
  const selector = invitationSelector(recipient);
  if (!selector) return false;
  const expected = selector.kind === "username" ? `@${selector.value}` : selector.value;
  return canonicalInvitationLabel(invitation) === expected;
}
function safeInvitation(value: unknown): Invitation {
  if (!value || typeof value !== "object") throw new ApiError(0);
  const item = value as Record<string, unknown>;
  if (
    !publicIdentifier(item.id) ||
    !canonicalInvitationLabel(item) ||
    item.role !== "editor" ||
    !["project", "thread"].includes(item.scope as string) ||
    !publicIdentifier(item.projectId) ||
    typeof item.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    ["threadId", "acceptedBy", "revokedAt"].some(
      (key) => item[key] !== undefined && !publicIdentifier(item[key]),
    )
  )
    throw new ApiError(0);
  return {
    id: item.id,
    ...(item.recipient === undefined ? {} : { recipient: item.recipient as string }),
    ...(item.email === undefined ? {} : { email: item.email as string }),
    role: "editor",
    scope: item.scope as Invitation["scope"],
    projectId: item.projectId,
    expiresAt: item.expiresAt,
    ...(item.threadId === undefined ? {} : { threadId: item.threadId as string }),
    ...(item.acceptedBy === undefined ? {} : { acceptedBy: item.acceptedBy as string }),
    ...(item.revokedAt === undefined ? {} : { revokedAt: item.revokedAt as string }),
  };
}
async function invitationRequest<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, body);
  } catch {
    throw new ApiError(0);
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("pitcrew-auth-required"));
    const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const code = value?.error;
    const known =
      (response.status === 400 &&
        ["invalid_recipient", "recipient_unavailable"].includes(code as string)) ||
      (response.status === 409 && code === "already_member") ||
      (response.status === 410 && code === "invitation_unavailable")
        ? (code as ApiError["code"])
        : undefined;
    throw new ApiError(response.status, known);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(0);
  }
}
async function createInvitation(
  scope: "project" | "thread",
  id: string,
  recipient: string,
): Promise<CreatedInvitation> {
  const selector = invitationSelector(recipient);
  if (!selector || /[\x00-\x1f\x7f]/.test(selector.value))
    throw new ApiError(400, "invalid_recipient");
  const value = await invitationRequest<unknown>(
    `/${scope === "project" ? "projects" : "threads"}/${encodeURIComponent(id)}/invitations`,
    { recipient: recipient.trim(), role: "editor" },
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !("invitation" in value)
  )
    throw new ApiError(0);
  const invitation = safeInvitation(value.invitation);
  if (
    !invitationMatchesRecipient(invitation, recipient) ||
    invitation.scope !== scope ||
    (scope === "project" ? invitation.projectId !== id : invitation.threadId !== id)
  )
    throw new ApiError(0);
  return { token: value.token, invitation };
}

async function repositoryMutation(
  path: string,
  body: unknown,
  method: "POST" | "PATCH",
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: await mutationHeaders(),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new ApiError(0);
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("pitcrew-auth-required"));
    throw await repositoryFailure(response);
  }
  try {
    const value: unknown = await response.json();
    const status =
      value && typeof value === "object" ? (value as Record<string, unknown>).status : undefined;
    if (
      path.endsWith("/repository/delete") &&
      response.status !== (status === "deleted" ? 200 : status === "deleting" ? 202 : -1)
    )
      throw new ApiError(0);
    return value;
  } catch {
    throw new ApiError(0);
  }
}

function repositoryCreation(value: unknown): RepositoryCreation {
  if (!value || typeof value !== "object") throw new ApiError(0);
  const item = value as Record<string, unknown>;
  const identifier = (value: unknown) => typeof value === "string" && value.length > 0;
  if (
    typeof item.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.name) ||
    typeof item.status !== "string" ||
    ![
      "pending",
      "cleanup_required",
      "registration_required",
      "ready",
      "deleting",
      "deleted",
    ].includes(item.status) ||
    (item.logicalName !== undefined &&
      (typeof item.logicalName !== "string" ||
        item.logicalName !== item.name ||
        canonicalRepositoryName(item.logicalName) !== item.logicalName ||
        typeof item.repositoryName !== "string")) ||
    (item.repositoryName !== undefined &&
      (typeof item.repositoryName !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.repositoryName))) ||
    (item.repositoryId !== undefined && !identifier(item.repositoryId)) ||
    (item.projectId !== undefined && !identifier(item.projectId)) ||
    (item.status === "ready" && (!identifier(item.repositoryId) || !identifier(item.projectId))) ||
    (["deleting", "deleted"].includes(item.status) && !identifier(item.repositoryId))
  )
    throw new ApiError(0);
  // Keep only public identifiers and lifecycle state; provider diagnostics and credentials stay out.
  return {
    name: item.name as string,
    ...(item.logicalName === undefined ? {} : { logicalName: item.logicalName as string }),
    ...(item.repositoryName === undefined ? {} : { repositoryName: item.repositoryName as string }),
    status: item.status as RepositoryCreation["status"],
    ...(item.repositoryId === undefined ? {} : { repositoryId: item.repositoryId as string }),
    ...(item.projectId === undefined ? {} : { projectId: item.projectId as string }),
  };
}
async function createAccountRepository(
  name: string,
  credentialConsent: true,
  metadata?: { displayName: string; description: string },
): Promise<RepositoryCreation> {
  if (typeof name !== "string" || !name || credentialConsent !== true) throw new ApiError(0);
  if (metadata) {
    const canonical = canonicalRepositoryName(name);
    if (!canonical) throw new ApiError(400);
    name = canonical;
  }
  let response: Response;
  try {
    response = await apiFetch("/repositories/create", { name, credentialConsent, ...metadata });
  } catch (cause) {
    throw cause instanceof ApiError ? cause : new ApiError(0);
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("pitcrew-auth-required"));
    throw await repositoryFailure(response);
  }
  let result: RepositoryCreation;
  try {
    result = repositoryCreation(await response.json());
  } catch {
    throw new ApiError(0);
  }
  if (
    result.name !== name ||
    ["deleting", "deleted"].includes(result.status) ||
    response.status !== (result.status === "ready" ? 200 : 202)
  )
    throw new ApiError(0);
  return result;
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, body);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0);
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("pitcrew-auth-required"));
    if (
      response.status === 400 &&
      ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error ===
        "invalid_mentions"
    )
      throw new Error(
        "A mentioned member changed or is unavailable. Reselect the @username before sending.",
      );
    throw new ApiError(response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(0);
  }
}
async function removeRequest(path: string): Promise<void> {
  const send = async () => {
    const headers = await mutationHeaders();
    const response = await fetch(`/api${path}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    return { response, local: !!headers["X-Pitcrew-Local-Nonce"] };
  };
  let result = await send();
  if (result.local && result.response.status === 403) result = await send();
  if (!result.response.ok) {
    if (result.response.status === 401) window.dispatchEvent(new Event("pitcrew-auth-required"));
    throw new ApiError(result.response.status);
  }
}
async function connectionRequest(path: string, init?: RequestInit): Promise<OpenRouterStatus> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new ApiError(0);
  const value = (await response.json()) as OpenRouterStatus;
  if (
    !value ||
    [value.available, value.configured, value.executionEnabled].some(
      (flag) => typeof flag !== "boolean",
    )
  )
    throw new ApiError(0);
  return {
    available: value.available,
    configured: value.configured,
    executionEnabled: value.executionEnabled,
    storageAvailable: value.storageAvailable === true,
  };
}
async function connectionMutation(
  body: { action: "store"; key: string } | { action: "remove" },
): Promise<OpenRouterStatus> {
  const session = await fetch("/api/provider-connection/openrouter/session", {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!session.ok) throw new ApiError(0);
  const { nonce } = (await session.json()) as { nonce?: unknown };
  if (nonce !== null && (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)))
    throw new ApiError(0);
  return connectionRequest("/api/provider-connection/openrouter", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(nonce ? { "X-Pitcrew-Connection-Nonce": nonce } : {}),
    },
    body: JSON.stringify(body),
  });
}
const sourceQuery = (values: Record<string, string | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, value);
  return query.toString();
};
export const httpApi: Api = {
  uploads: createUploadApi(mutationHeaders),
  source: {
    tree: (id, path = "", version, cursor) =>
      request(
        `/threads/${encodeURIComponent(id)}/source/tree?${sourceQuery({ path, version, cursor })}`,
      ),
    file: (id, path, version) =>
      request(`/threads/${encodeURIComponent(id)}/source/file?${sourceQuery({ path, version })}`),
    diff: (id, runId, version, cursor) =>
      request(
        `/threads/${encodeURIComponent(id)}/source/diff?${sourceQuery({ runId, version, cursor })}`,
      ),
    patch: (id, runId, path, version) =>
      request(
        `/threads/${encodeURIComponent(id)}/source/diff?${sourceQuery({ runId, path, version })}`,
      ),
  },
  presence: {
    read: (threadId) =>
      request<TypingSnapshot>(`/threads/${encodeURIComponent(threadId)}/presence`),
    write: (threadId, signal) =>
      request(`/threads/${encodeURIComponent(threadId)}/presence`, signal),
  },
  collaboration: {
    account: () => request("/account"),
    repositoryCreations: async () => {
      const value = await request<unknown>("/repository-creations");
      if (!value || typeof value !== "object") throw new ApiError(0);
      const envelope = value as Record<string, unknown>;
      const approval = envelope.approval;
      if (
        (approval !== null &&
          (!approval ||
            typeof approval !== "object" ||
            !("name" in approval) ||
            typeof approval.name !== "string" ||
            !approval.name)) ||
        !Array.isArray(envelope.creations)
      )
        throw new ApiError(0);
      const creations = envelope.creations.map(repositoryCreation);
      if (
        new Set(creations.map((item) => item.repositoryName ?? item.name)).size !== creations.length
      )
        throw new ApiError(0);
      return {
        approval: approval === null ? null : { name: (approval as { name: string }).name },
        creations,
        ...(envelope.capabilities === undefined
          ? {}
          : { capabilities: repositoryCapabilities(envelope.capabilities) }),
      };
    },
    createRepository: createAccountRepository,
    approvedProjectAdoptions: async () => {
      const value = await request<unknown>("/project-adoptions");
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            !item ||
            typeof item.name !== "string" ||
            !item.name ||
            typeof item.repositoryId !== "string" ||
            !item.repositoryId,
        )
      )
        throw new ApiError(0);
      return value.map(({ name, repositoryId }) => ({ name, repositoryId }));
    },
    adoptProject: (name, repositoryId) => request("/projects", { name, repositoryId }),
    repositories: async () => {
      const value = await request<unknown>("/repositories");
      if (
        !value ||
        typeof value !== "object" ||
        !("repositories" in value) ||
        !Array.isArray(value.repositories) ||
        value.repositories.some(
          (item) =>
            !item ||
            typeof item.projectId !== "string" ||
            typeof item.name !== "string" ||
            !["owner", "editor"].includes(item.role) ||
            !["present", "deleting"].includes(item.status) ||
            !["registered", "deleting"].includes(item.lifecycle) ||
            typeof item.deletable !== "boolean" ||
            (item.logicalName !== undefined &&
              (typeof item.logicalName !== "string" ||
                canonicalRepositoryName(item.logicalName) !== item.logicalName)) ||
            (item.repositoryName !== undefined && !publicIdentifier(item.repositoryName)) ||
            (item.repositoryId !== undefined && !publicIdentifier(item.repositoryId)) ||
            (item.description !== undefined && typeof item.description !== "string") ||
            (item.metadataRevision !== undefined &&
              (!Number.isSafeInteger(item.metadataRevision) || item.metadataRevision < 0)),
        )
      )
        throw new ApiError(0);
      return value.repositories.map((item) => ({
        projectId: item.projectId,
        name: item.name,
        role: item.role,
        status: item.status,
        lifecycle: item.lifecycle,
        deletable: item.deletable,
        ...(item.logicalName === undefined ? {} : { logicalName: item.logicalName }),
        ...(item.repositoryName === undefined ? {} : { repositoryName: item.repositoryName }),
        ...(item.repositoryId === undefined ? {} : { repositoryId: item.repositoryId }),
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.metadataRevision === undefined ? {} : { metadataRevision: item.metadataRevision }),
      })) as SharedRepository[];
    },
    updateRepository: async (id, metadata) => {
      let input = metadata;
      if (metadata.logicalName !== undefined) {
        const logicalName = canonicalRepositoryName(metadata.logicalName);
        if (!logicalName) throw new ApiError(400);
        input = { ...metadata, logicalName };
      }
      return (await repositoryMutation(
        `/projects/${encodeURIComponent(id)}/repository`,
        input,
        "PATCH",
      )) as Project;
    },
    deleteRepository: async (id, target) =>
      repositoryStatus(
        await repositoryMutation(
          `/projects/${encodeURIComponent(id)}/repository/delete`,
          target,
          "POST",
        ),
      ),
    repositoryStatus: async (id) =>
      repositoryStatus(await request(`/projects/${encodeURIComponent(id)}/repository`)),
    projectInvitations: async (id) => {
      const value = await request<unknown>(`/projects/${encodeURIComponent(id)}/invitations`);
      if (!Array.isArray(value)) throw new ApiError(0);
      return value.map(safeInvitation);
    },
    revokeProjectInvitation: async (id, invitationId) =>
      safeInvitation(
        await request(
          `/projects/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
          {},
        ),
      ),
    projectMembers: (id) => request(`/projects/${encodeURIComponent(id)}/members`),
    threadMembers: (id) => request(`/threads/${encodeURIComponent(id)}/members`),
    inviteProject: (id, recipient) => createInvitation("project", id, recipient),
    inviteThread: (id, recipient) => createInvitation("thread", id, recipient),
    invitation: async (token) =>
      safeInvitation(await invitationRequest(`/invitations/${encodeURIComponent(token)}`)),
    acceptInvitation: async (token) =>
      safeInvitation(
        await invitationRequest(`/invitations/${encodeURIComponent(token)}/accept`, {}),
      ),
    revokeInvitation: (token) => request(`/invitations/${encodeURIComponent(token)}/revoke`, {}),
    removeProjectMember: (id, actor) =>
      removeRequest(`/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(actor)}`),
    removeThreadMember: (id, actor) =>
      removeRequest(`/threads/${encodeURIComponent(id)}/members/${encodeURIComponent(actor)}`),
  },
  repositories: createRepositoryApi(),
  openrouter: {
    async status() {
      return connectionRequest("/api/provider-connection/openrouter");
    },
    store: (key) => connectionMutation({ action: "store", key }),
    remove: () => connectionMutation({ action: "remove" }),
  },
  attachmentUrl: (threadId, attachmentId) =>
    `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`,
  async capabilities(projectId) {
    const capabilities = await request<LandingCapabilities>(
      `/capabilities${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    );
    if (
      capabilities.composer?.conversation &&
      capabilities.composer.models.some(
        (model) => !["fixture", "pitcrew-fixture"].includes(model.provider),
      )
    )
      return capabilities;
    try {
      const display = await request<{
        models: ModelChoice[];
        catalogRevision?: string;
        defaultSelection?: ModelSelection;
      }>("/provider-connection/openrouter/models");
      if (
        !display.models?.length ||
        !/^[a-f0-9]{64}$/.test(display.catalogRevision ?? "") ||
        !display.defaultSelection
      )
        return capabilities;
      return {
        ...capabilities,
        composer: {
          models: display.models,
          settings: { default: display.defaultSelection },
          catalogRevision: display.catalogRevision,
          conversation: false,
          displayOnly: true,
          executionEnabled: false,
        },
      };
    } catch {
      return capabilities;
    }
  },
  approve: (id, input) => request(`/runs/${encodeURIComponent(id)}/merge-approval`, input),
  land: (id, authorizationId) =>
    request(`/runs/${encodeURIComponent(id)}/landing`, { authorizationId }),
  reconcile: (id, authorizationId) =>
    request(`/runs/${encodeURIComponent(id)}/landing/reconcile`, { authorizationId }),
  projects: () => request("/projects"),
  visualizations: (projectId, threadId, signal) =>
    readWithBudget(() =>
      loadVisualizationJson(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/visualizations`,
        signal,
      ),
    ),
  threads: (id) => request(`/projects/${encodeURIComponent(id)}/threads`),
  setThreadArchived: (projectId, id, archived) =>
    request(
      `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(id)}/archive`,
      { archived },
    ),
  latestRun: async (id) => (await request<Run[]>(`/threads/${encodeURIComponent(id)}/runs`)).at(-1),
  trace: (id, after = 0) =>
    request(`/threads/${encodeURIComponent(id)}/trace?after=${encodeURIComponent(String(after))}`),
  missions: {
    current: async (threadId) =>
      (
        await request<{ mission: Mission | null }>(
          `/threads/${encodeURIComponent(threadId)}/mission`,
        )
      ).mission,
    create: (projectId, threadId, featureRequest, idempotencyKey) =>
      request(`/projects/${encodeURIComponent(projectId)}/missions`, {
        threadId,
        request: featureRequest,
        idempotencyKey,
      }),
    answer: (missionId, questionId, answer, idempotencyKey) =>
      request(`/missions/${encodeURIComponent(missionId)}/answers`, {
        questionId,
        answer,
        idempotencyKey,
      }),
    revise: (missionId, input, idempotencyKey) =>
      request(`/missions/${encodeURIComponent(missionId)}/proposal`, { ...input, idempotencyKey }),
    approve: (missionId, revision, idempotencyKey) =>
      request(`/missions/${encodeURIComponent(missionId)}/approval`, { revision, idempotencyKey }),
    start: (missionId, idempotencyKey) =>
      request(`/missions/${encodeURIComponent(missionId)}/start`, { idempotencyKey }),
  },
  snapshot: async (id) => {
    const path = `/threads/${encodeURIComponent(id)}`;
    const [messages, runs, turns] = await Promise.all([
      request<SharedMessage[]>(`${path}/messages`),
      request<Run[]>(`${path}/runs`),
      request<NonNullable<Snapshot["turns"]>>(`${path}/turns`),
    ]);
    const evidence = await Promise.all(
      runs.map((run) => request<RunEvidence>(`/runs/${encodeURIComponent(run.id)}/evidence`)),
    );
    return {
      messages,
      turns,
      runs: evidence.map((item) => item.run),
      reviews: evidence.flatMap((item) => item.reviews),
      evidence,
    };
  },
  stopTurn: async (threadId, turnId) => {
    const value = await request<ConversationTurn>(
      `/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/stop`,
      {},
    );
    if (
      !value ||
      value.id !== turnId ||
      !["completed", "failed"].includes(value.status) ||
      value.canStop !== false ||
      (value.error !== undefined && typeof value.error !== "string")
    )
      throw new ApiError(0);
    return value;
  },
  createThread: (id, title, idempotencyKey) =>
    request(`/projects/${encodeURIComponent(id)}/threads`, { title, idempotencyKey }),
  setThreadModelSelection: (projectId, id, modelSelection) =>
    request(
      `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(id)}/model-selection`,
      { modelSelection },
    ),
  setModelSettings: (projectId, settings) =>
    request(`/projects/${encodeURIComponent(projectId)}/model-settings`, { settings }),
  send: (
    id,
    content,
    idempotencyKey,
    attachments,
    modelSelection,
    mentions,
    destination = "team",
    agentMentions,
  ) =>
    request(`/threads/${encodeURIComponent(id)}/messages`, {
      content,
      idempotencyKey,
      attachments,
      modelSelection,
      mentions,
      destination,
      agentMentions,
    }),
};
