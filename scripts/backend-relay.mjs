import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { normalizePublicRepositoryImportUrl } from "../packages/protocol/src/repository-import-url.mjs";

const workerRequire = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { createRemoteJWKSet, jwtVerify } = await import(workerRequire.resolve("jose"));
export const BACKEND_ACCESS = Object.freeze({
  origin: "https://pitcrew-backend.pitcrew-004.workers.dev",
  issuer: "https://purple-mouse-ee03.cloudflareaccess.com",
  audience: "147a2e216894b65c6445fc8dec1a3347c6b1681e01089dd066f875a581e81683",
  email: "dev@lilfrogdev.com",
  emails: Object.freeze(["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"]),
});
const cookieName = "pitcrew-backend-nonce";
const lifetime = 30 * 60 * 1000;
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const statuses = new Set([
  "external",
  "pending",
  "cleanup_required",
  "ready",
  "deleting",
  "deleted",
]);
const safeErrors = new Set([
  "invalid_upload",
  "invalid_upload_id",
  "invalid_upload_name",
  "invalid_upload_type",
  "upload_unavailable",
  "upload_capacity",
  "upload_conflict",
  "upload_cancelled",
  "upload_too_large",
  "upload_timeout",
  "uploads_unavailable",
  "repository_backend_unavailable",
  "repository_name_retired",
  "deletion_pending",
  "import_source_authentication_required",
  "import_source_not_found",
  "import_limit_exceeded",
  "repository_exists",
  "repository_protected",
  "invalid_name",
  "invalid_repository_creation",
  "invalid_public_url",
  "reconciliation_unavailable",
  "invalid_cursor",
  "credential_consent_required",
  "namespace_limit",
  "lifecycle_limit",
  "confirmation_required",
  "delete_not_confirmed",
  "repository_operation_failed",
  "body_too_large",
  "method_not_allowed",
  "not_found",
  "unauthorized",
  "execution_disabled",
  "forbidden",
  "invitation_unavailable",
  "invalid_email",
  "invalid_role",
  "invalid_member",
  "invalid_mentions",
  "already_member",
  "capacity",
  "idempotency_conflict",
  "provider_credential_unavailable",
  "stale_configuration",
  "repository_adoption_unavailable",
  "repository_identity_changed",
  "repository_already_registered",
  "repository_verification_failed",
  "repository_uninitialized",
  "repository_management_unavailable",
  "invalid_repository_metadata",
  "invalid_repository_deletion",
  "repository_metadata_conflict",
  "repository_revision_conflict",
  "repository_active",
  "repository_deleting",
  "repository_busy",
  "revision_conflict",
  "repository_storage_limit",
  "invalid_event_cursor",
  "source_unavailable",
  "source_stale",
  "source_limit_exceeded",
  "source_timeout",
  "source_capacity",
  "invalid_source_request",
]);
// Explicit product API routes. Authentication and credentials have separate
// relays; unknown paths never become a cloud proxy.
function sharedRoute(path, method, passwordMode = false) {
  const id = "[A-Za-z0-9:_-]{1,128}";
  const routes = {
    GET: [
      "account",
      "projects",
      "project-adoptions",
      "repository-creations",
      "capabilities",
      `projects/${id}/(?:context|threads|members|events|intake|verification-metrics)`,
      `threads/${id}/source/(?:tree|file|diff)`,
      `projects/${id}/threads/${id}/visualizations(?:/${id})?`,
      `threads/${id}/uploads/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}`,
      `threads/${id}/(?:members|messages|changes|runs|turns|presence|attachments/${id})`,
      `changes/${id}(?:/runs)?`,
      `runs/${id}/(?:evidence|reviews)`,
      "invitations/[a-f0-9]{64}",
    ],
    POST: [
      "projects",
      `projects/${id}/(?:threads|invitations|knowledge|verification-profile|reports|intake/(?:move|dispatch)|threads/${id}/(?:archive|model-selection)|model-settings)`,
      `threads/${id}/(?:messages|invitations|model-selection|presence)`,
      `changes/${id}/runs`,
      `runs/${id}/(?:merge-approval|landing(?:/reconcile)?)`,
      "invitations/[a-f0-9]{64}/(?:accept|revoke)",
    ],
    PUT: [`threads/${id}/uploads/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}`],
    DELETE: [
      `threads/${id}/uploads/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}`,
      `(?:projects|threads)/${id}/members/[A-Za-z0-9:@._%+-]{1,256}`,
    ],
  };
  if (passwordMode)
    routes.POST = [
      "projects",
      "repositories/create",
      `projects/${id}/repository/delete`,
      `projects/${id}/invitations/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/revoke`,
      `projects/${id}/(?:threads|invitations|knowledge|verification-profile|reports|intake/move|threads/${id}/archive)`,
      `threads/${id}/(?:messages|invitations|presence)`,
      "invitations/[a-f0-9]{64}/(?:accept|revoke)",
    ];
  if (passwordMode) {
    routes.GET.push(`projects/${id}/(?:repository|invitations)`);
    routes.PATCH = [`projects/${id}/repository`];
  }
  return (routes[method] ?? []).some((route) => new RegExp(`^/api/${route}$`).test(path));
}
const loopback = (value) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(value);
const equal = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

// This command reads an existing application cache. It never runs access login.
// Activation and the user-owned login/cache scope are separate runtime gates.
export function readCachedAccessToken({
  spawnProcess = spawn,
  homeDirectory = homedir(),
  cloudflaredPath = join(
    homeDirectory,
    "Library",
    "Application Support",
    "Pitcrew",
    "bin",
    "cloudflared",
  ),
} = {}) {
  return new Promise((resolve, reject) => {
    if (
      !isAbsolute(homeDirectory) ||
      !isAbsolute(cloudflaredPath) ||
      /[\r\n\0]/.test(homeDirectory + cloudflaredPath)
    ) {
      reject(Error("backend_sign_in_required"));
      return;
    }
    let child;
    try {
      child = spawnProcess(cloudflaredPath, ["access", "token", `--app=${BACKEND_ACCESS.origin}`], {
        shell: false,
        env: { HOME: homeDirectory, PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      reject(Error("backend_sign_in_required"));
      return;
    }
    let output = "",
      failed = false;
    const stop = () => {
      if (failed) return;
      failed = true;
      output = "";
      try {
        child.kill("SIGKILL");
      } catch {
        /* Await close before resolving. */
      }
    };
    const timer = setTimeout(stop, 10000);
    child.stdout.on("data", (bytes) => {
      if (failed) return;
      output += bytes.toString("utf8");
      if (Buffer.byteLength(output) > 16384) stop();
    });
    child.once("error", stop);
    child.stdout.once("error", stop);
    child.once("close", (code) => {
      clearTimeout(timer);
      const token = output.trim();
      output = "";
      if (failed || code !== 0 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        reject(Error("backend_sign_in_required"));
      else resolve(token);
    });
  });
}
const keys = createRemoteJWKSet(new URL(`${BACKEND_ACCESS.issuer}/cdn-cgi/access/certs`), {
  timeoutDuration: 5000,
});
export async function verifyUserAccessToken(token, resolver = keys) {
  if (typeof token !== "string" || token.length > 16384) throw Error("backend_sign_in_required");
  const { payload } = await jwtVerify(token, resolver, {
    issuer: BACKEND_ACCESS.issuer,
    audience: BACKEND_ACCESS.audience,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "email", "iat", "exp"],
  });
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !BACKEND_ACCESS.emails.includes(payload.email.toLowerCase()) ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.iat > now ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 1800
  )
    throw Error("backend_sign_in_required");
  return payload.exp;
}
function reply(res, status, value, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(JSON.stringify(value));
}
function admitted(req, origin) {
  const expected = new URL(origin);
  const header = req.headers.origin;
  const singles = [
    "host",
    "origin",
    "content-type",
    "x-pitcrew-filename",
    "x-pitcrew-backend-nonce",
    "x-pitcrew-local-nonce",
    "x-pitcrew-connection-nonce",
    "cookie",
  ];
  const counts = new Map();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (
    singles.every((name) => (counts.get(name) ?? 0) <= 1) &&
    loopback(req.socket?.localAddress) &&
    loopback(req.socket?.remoteAddress) &&
    req.headers.host === expected.host &&
    (!header || header === origin) &&
    !["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])
  );
}
function cookie(req) {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  return values.length === 1 && /^[a-f0-9]{64}$/.test(values[0].slice(cookieName.length + 1))
    ? values[0].slice(cookieName.length + 1)
    : undefined;
}
async function body(req, limit = 8192, binary = false) {
  if (
    !binary &&
    req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
  )
    throw Object.assign(Error(), { status: 415 });
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(Object.assign(Error(), { status: 408 })), 5000);
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > limit) throw Object.assign(Error(), { status: 413 });
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  if (binary) return Buffer.concat(chunks);
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
  return parsed;
}
function normalizeMutation(path, value) {
  const action = path.slice(path.lastIndexOf("/") + 1);
  const allowed =
    action === "import"
      ? ["name", "url", "credentialConsent"]
      : action === "create"
        ? ["name", "credentialConsent"]
        : action === "delete"
          ? ["name", "confirmation"]
          : ["name"];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.name !== "string" ||
    !namePattern.test(value.name)
  )
    return false;
  if (action === "create" || action === "import") {
    if (value.credentialConsent !== true) return false;
    if (action === "import") {
      try {
        value.url = normalizePublicRepositoryImportUrl(value.url);
      } catch {
        return false;
      }
    }
  }
  return action !== "delete" || value.confirmation === value.name;
}
const nativeProjectRepository = /^\/api\/projects\/[A-Za-z0-9:_-]{1,128}\/repository(?:\/delete)?$/;
const nativeProjectInvitations =
  /^\/api\/projects\/[A-Za-z0-9:_-]{1,128}\/invitations(?:\/[a-f0-9-]{36}\/revoke)?$/;
const safeText = (value, limit, multiline = false) =>
  typeof value === "string" &&
  value.length <= limit &&
  // eslint-disable-next-line no-control-regex -- Plain labels reject controls; descriptions permit LF and tab.
  !(multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value);
const resourceId = /^[A-Za-z0-9:_-]{1,128}$/;
const validLogicalName = (value) =>
  typeof value === "string" &&
  /^[\t\n\r\f\v ]*[A-Za-z0-9][A-Za-z0-9-]{0,62}[\t\n\r\f\v ]*$/.test(value);
function normalizeNativeManagement(path, method, value) {
  const keys = Object.keys(value);
  if (path === "/api/repositories/create") {
    if (
      !keys.includes("displayName") &&
      !keys.includes("description") &&
      Buffer.byteLength(JSON.stringify(value)) > 2048
    )
      throw Object.assign(Error(), { status: 413 });
    return (
      keys.every((key) =>
        ["name", "credentialConsent", "displayName", "description"].includes(key),
      ) &&
      validLogicalName(value.name) &&
      value.credentialConsent === true &&
      (value.displayName === undefined ||
        (safeText(value.displayName, 80) && value.displayName.trim().length > 0)) &&
      (value.description === undefined || safeText(value.description, 1000, true))
    );
  }
  if (nativeProjectRepository.test(path)) {
    if (method === "PATCH")
      return (
        keys.every((key) =>
          ["displayName", "description", "expectedRevision", "logicalName"].includes(key),
        ) &&
        (value.logicalName === undefined || validLogicalName(value.logicalName)) &&
        safeText(value.displayName, 80) &&
        value.displayName.trim().length > 0 &&
        safeText(value.description, 1000, true) &&
        (value.expectedRevision === undefined ||
          (Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0))
      );
    return (
      keys.length === 2 &&
      keys.includes("confirmation") &&
      keys.includes("repositoryId") &&
      typeof value.confirmation === "string" &&
      namePattern.test(value.confirmation) &&
      typeof value.repositoryId === "string" &&
      resourceId.test(value.repositoryId)
    );
  }
  if (nativeProjectInvitations.test(path)) {
    if (path.endsWith("/revoke")) return keys.length === 0;
    return (
      keys.length === 2 &&
      keys.includes("email") &&
      keys.includes("role") &&
      typeof value.email === "string" &&
      value.email.length <= 254 &&
      /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(value.email) &&
      value.role === "editor"
    );
  }
  return false;
}
async function boundedJson(response, limit = 262144) {
  if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json")
    throw Error();
  const reader = response.body?.getReader();
  if (!reader) throw Error();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error();
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw Error();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function nativeInvitationProjection(item) {
  if (
    !item ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.id ?? "") ||
    !["project", "thread"].includes(item.scope) ||
    !resourceId.test(item.projectId ?? "") ||
    (item.scope === "thread" && !resourceId.test(item.threadId ?? "")) ||
    !safeText(item.email, 254) ||
    !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(item.email) ||
    item.role !== "editor" ||
    !safeText(item.invitedBy, 256) ||
    !item.invitedBy.length ||
    typeof item.expiresAt !== "string" ||
    item.expiresAt.length > 30 ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    (item.acceptedBy !== undefined &&
      (!safeText(item.acceptedBy, 256) || !item.acceptedBy.length)) ||
    (item.revokedAt !== undefined &&
      (typeof item.revokedAt !== "string" ||
        item.revokedAt.length > 30 ||
        !Number.isFinite(Date.parse(item.revokedAt))))
  )
    throw Error();
  return {
    id: item.id,
    scope: item.scope,
    projectId: item.projectId,
    ...(item.scope === "thread" ? { threadId: item.threadId } : {}),
    email: item.email,
    role: item.role,
    invitedBy: item.invitedBy,
    expiresAt: item.expiresAt,
    ...(item.acceptedBy !== undefined ? { acceptedBy: item.acceptedBy } : {}),
    ...(item.revokedAt !== undefined ? { revokedAt: item.revokedAt } : {}),
  };
}
function nativeRepositoryProjection(item) {
  if (
    !item ||
    !resourceId.test(item.projectId ?? "") ||
    !resourceId.test(item.repositoryId ?? "") ||
    !namePattern.test(item.repositoryName ?? "") ||
    (item.logicalName !== undefined && !namePattern.test(item.logicalName)) ||
    !safeText(item.name, 80) ||
    !item.name.trim().length ||
    !safeText(item.description ?? "", 1000, true) ||
    !Number.isSafeInteger(item.metadataRevision ?? 0) ||
    (item.metadataRevision ?? 0) < 0 ||
    item.role !== "owner" ||
    !["present", "deleting", "deleted"].includes(item.status) ||
    !["registered", "deleting", "deleted"].includes(item.lifecycle) ||
    (item.status === "present"
      ? item.lifecycle !== "registered"
      : item.status !== item.lifecycle) ||
    typeof item.deletable !== "boolean"
  )
    throw Error();
  return {
    projectId: item.projectId,
    name: item.name,
    repositoryName: item.repositoryName,
    ...(item.logicalName !== undefined ? { logicalName: item.logicalName } : {}),
    repositoryId: item.repositoryId,
    description: item.description ?? "",
    metadataRevision: item.metadataRevision ?? 0,
    role: "owner",
    status: item.status,
    lifecycle: item.lifecycle,
    deletable: item.status === "present" && item.deletable,
  };
}
function cleanResponse(path, value, passwordMode = false, method = "GET", mutation) {
  if (
    passwordMode &&
    nativeProjectInvitations.test(path) &&
    (method === "GET" || path.endsWith("/revoke"))
  ) {
    const projectId = path.split("/")[3];
    if (path.endsWith("/revoke")) {
      const projected = nativeInvitationProjection(value);
      if (projected.projectId !== projectId || projected.id !== path.split("/")[5]) throw Error();
      return projected;
    }
    if (!Array.isArray(value) || value.length > 100) throw Error();
    return value.map((item) => {
      const projected = nativeInvitationProjection(item);
      if (projected.projectId !== projectId) throw Error();
      return projected;
    });
  }
  if (passwordMode && nativeProjectRepository.test(path)) {
    const projectId = path.split("/")[3];
    if (method !== "PATCH") {
      const projected = nativeRepositoryProjection(value);
      if (
        projected.projectId !== projectId ||
        (mutation &&
          (projected.repositoryId !== mutation.repositoryId ||
            projected.repositoryName !== mutation.confirmation))
      )
        throw Error();
      return projected;
    }
    if (
      !value ||
      !resourceId.test(value.id ?? "") ||
      value.id !== projectId ||
      !safeText(value.name, 80) ||
      (value.logicalName !== undefined && !namePattern.test(value.logicalName)) ||
      !value.name.trim().length ||
      typeof value.repository !== "string" ||
      !namePattern.test(value.repository.replace(/^artifact:/, "")) ||
      !value.repository.startsWith("artifact:") ||
      !/^[a-f0-9]{40}$/.test(value.baseSha ?? "") ||
      !safeText(value.configurationRevision, 128) ||
      !safeText(value.description ?? "", 1000, true) ||
      !Number.isSafeInteger(value.metadataRevision ?? 0) ||
      (value.metadataRevision ?? 0) < 0
    )
      throw Error();
    return {
      id: value.id,
      name: value.name,
      ...(value.logicalName !== undefined ? { logicalName: value.logicalName } : {}),
      repository: value.repository,
      baseSha: value.baseSha,
      configurationRevision: value.configurationRevision,
      description: value.description ?? "",
      metadataRevision: value.metadataRevision ?? 0,
      ...(value.modelSettings !== undefined ? { modelSettings: value.modelSettings } : {}),
    };
  }
  if (
    path === "/api/repository-creations" ||
    (passwordMode && path === "/api/repositories/create")
  ) {
    const projectId = /^[A-Za-z0-9_-]{1,128}$/;
    const creation = (item) => {
      if (
        !item ||
        typeof item.name !== "string" ||
        !namePattern.test(item.name) ||
        (item.logicalName !== undefined &&
          (!namePattern.test(item.logicalName) || item.logicalName !== item.name)) ||
        (item.repositoryName !== undefined && !namePattern.test(item.repositoryName)) ||
        ![
          "pending",
          "cleanup_required",
          "registration_required",
          "ready",
          "deleting",
          "deleted",
        ].includes(item.status) ||
        (item.repositoryId !== undefined && !projectId.test(item.repositoryId)) ||
        (item.status === "ready" &&
          (!projectId.test(item.repositoryId ?? "") || !projectId.test(item.projectId ?? "")))
      )
        throw Error();
      return {
        name: item.name,
        ...(item.logicalName !== undefined ? { logicalName: item.logicalName } : {}),
        ...(item.repositoryName !== undefined ? { repositoryName: item.repositoryName } : {}),
        status: item.status,
        ...(item.repositoryId !== undefined ? { repositoryId: item.repositoryId } : {}),
        ...(item.status === "ready" ? { projectId: item.projectId } : {}),
        ...(item.issue === "repository_exists" ? { issue: item.issue } : {}),
      };
    };
    if (path === "/api/repositories/create") return creation(value);
    if (
      !value ||
      !Array.isArray(value.creations) ||
      value.creations.length > 200 ||
      !(
        value.approval === null ||
        (typeof value.approval?.name === "string" && namePattern.test(value.approval.name))
      )
    )
      throw Error();
    return {
      approval: value.approval ? { name: value.approval.name } : null,
      ...(value.capabilities !== undefined
        ? (() => {
            if (
              typeof value.capabilities?.create !== "boolean" ||
              typeof value.capabilities?.manage !== "boolean" ||
              (value.capabilities.delete !== undefined &&
                typeof value.capabilities.delete !== "boolean") ||
              (value.capabilities.delete === true && !value.capabilities.manage)
            )
              throw Error();
            return {
              capabilities: {
                create: value.capabilities.create,
                manage: value.capabilities.manage,
                delete: value.capabilities.delete === true,
              },
            };
          })()
        : {}),
      creations: value.creations.map(creation),
    };
  }
  if (path === "/api/provider-connection/openrouter/models") {
    if (!Array.isArray(value?.models) || value.models.length > 33) throw Error();
    if (!value.models.length) return { models: [], executionEnabled: false };
    if (!/^[a-f0-9]{64}$/.test(value.catalogRevision ?? "")) throw Error();
    const efforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const ids = new Set();
    const models = value.models.map((model) => {
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(model?.id ?? "") ||
        ids.has(model.id) ||
        typeof model.label !== "string" ||
        !model.label.length ||
        model.label.length > 100 ||
        model.provider !== "openrouter" ||
        !/^[a-zA-Z0-9._/-]{1,256}$/.test(model.model ?? "") ||
        !Array.isArray(model.efforts) ||
        !model.efforts.length ||
        model.efforts.length > 7 ||
        model.efforts.some((effort) => !efforts.has(effort)) ||
        !Number.isSafeInteger(model.contextWindow) ||
        model.contextWindow <= 0 ||
        model.contextWindow > 1e9 ||
        (model.defaultEffort !== undefined && !model.efforts.includes(model.defaultEffort))
      )
        throw Error();
      ids.add(model.id);
      return {
        id: model.id,
        label: model.label,
        provider: model.provider,
        model: model.model,
        efforts: model.efforts,
        contextWindow: model.contextWindow,
        ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
      };
    });
    const selected = models.find((model) => model.id === value.defaultSelection?.modelId);
    if (!selected || !selected.efforts.includes(value.defaultSelection.effort)) throw Error();
    return {
      catalogRevision: value.catalogRevision,
      models,
      defaultSelection: { modelId: selected.id, effort: value.defaultSelection.effort },
      executionEnabled: false,
    };
  }
  if (path === "/api/provider-connection/openrouter") {
    const fields = ["available", "storageAvailable", "configured", "executionEnabled"];
    if (fields.some((field) => typeof value?.[field] !== "boolean")) throw Error();
    return Object.fromEntries(fields.map((field) => [field, value[field]]));
  }
  if (path === "/api/repositories") {
    if (
      !value ||
      !Array.isArray(value.repositories) ||
      value.repositories.length > 250 ||
      !(value.cursor === null || (typeof value.cursor === "string" && value.cursor.length <= 1024))
    )
      throw Error();
    return {
      repositories: value.repositories.map((item) => {
        const registered = passwordMode && ["registered", "deleting"].includes(item?.lifecycle);
        if (
          typeof item?.name !== "string" ||
          !(registered
            ? safeText(item.name, 80) && item.name.trim().length > 0
            : namePattern.test(item.name)) ||
          !(statuses.has(item.lifecycle) || item.lifecycle === "registered") ||
          typeof item.deletable !== "boolean" ||
          (registered &&
            (!resourceId.test(item.projectId ?? "") ||
              !["owner", "editor"].includes(item.role) ||
              (item.repositoryName !== undefined && !namePattern.test(item.repositoryName)) ||
              (item.logicalName !== undefined && !namePattern.test(item.logicalName)) ||
              (item.repositoryId !== undefined && !resourceId.test(item.repositoryId)) ||
              (item.description !== undefined && !safeText(item.description, 1000, true)) ||
              (item.metadataRevision !== undefined &&
                (!Number.isSafeInteger(item.metadataRevision) || item.metadataRevision < 0))))
        )
          throw Error();
        return {
          name: item.name,
          lifecycle: item.lifecycle,
          deletable: item.deletable,
          ...(["registered", ...(passwordMode ? ["deleting"] : [])].includes(item.lifecycle) &&
          /^[a-zA-Z0-9_-]{1,128}$/.test(item.projectId ?? "") &&
          ["owner", "editor"].includes(item.role)
            ? {
                projectId: item.projectId,
                role: item.role,
                status: item.lifecycle === "deleting" ? "deleting" : "present",
                ...(passwordMode && item.repositoryName !== undefined
                  ? { repositoryName: item.repositoryName }
                  : {}),
                ...(passwordMode && item.logicalName !== undefined
                  ? { logicalName: item.logicalName }
                  : {}),
                ...(passwordMode && item.repositoryId !== undefined
                  ? { repositoryId: item.repositoryId }
                  : {}),
                ...(passwordMode && item.description !== undefined
                  ? { description: item.description }
                  : {}),
                ...(passwordMode && item.metadataRevision !== undefined
                  ? { metadataRevision: item.metadataRevision }
                  : {}),
              }
            : {}),
          ...(safeErrors.has(item.issue) ? { issue: item.issue } : {}),
        };
      }),
      cursor: value.cursor,
    };
  }
  if (
    typeof value?.name !== "string" ||
    !namePattern.test(value.name) ||
    !statuses.has(value.status)
  )
    throw Error();
  return {
    name: value.name,
    status: value.status,
    ...(safeErrors.has(value.issue) ? { issue: value.issue } : {}),
  };
}

/** Fixed cloud origin, explicit routes, per-local-session authentication. */
export function createBackendRelayMiddleware({
  enabled = false,
  userAccessSession = false,
  origin = "http://127.0.0.1:5173",
  fetchImpl = fetch,
  tokenProvider = readCachedAccessToken,
  verifyToken = verifyUserAccessToken,
  providerOnly = false,
  sharedApi = false,
  passwordMode = false,
  sessionHeaders,
} = {}) {
  if (typeof passwordMode !== "boolean") throw Error("invalid_relay_mode");
  const configuredOrigin = origin;
  const validOrigin = (value) => {
    try {
      const local = new URL(value);
      return (
        local.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(local.hostname) &&
        local.origin === value
      );
    } catch {
      return false;
    }
  };
  if (typeof configuredOrigin !== "function" && !validOrigin(configuredOrigin))
    throw Error("invalid_relay_origin");
  const sessions = new Map();
  let busy = false,
    active = 0,
    edgeAt = 0,
    cached,
    acquiring;
  async function token() {
    const now = Date.now();
    if (now - edgeAt > 30000) {
      const response = await fetchImpl(`${BACKEND_ACCESS.origin}/api/local-session`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      });
      const location = response.headers.get("location");
      const login = location && new URL(location);
      await response.body?.cancel();
      if (
        ![302, 303].includes(response.status) ||
        login?.origin !== BACKEND_ACCESS.issuer ||
        !login.pathname.startsWith("/cdn-cgi/access/login/")
      )
        throw Error("backend_access_unverified");
      edgeAt = now;
    }
    if (cached && cached.exp * 1000 > now + 15000) return cached.token;
    acquiring ??= (async () => {
      const value = await tokenProvider();
      const exp = await verifyToken(value);
      cached = { token: value, exp };
      return value;
    })().finally(() => {
      acquiring = undefined;
    });
    return acquiring;
  }
  return async (req, res, next) => {
    const origin = typeof configuredOrigin === "function" ? configuredOrigin() : configuredOrigin;
    const raw = req.url ?? "";
    if (!validOrigin(origin)) {
      if (
        (providerOnly && raw.startsWith("/api/provider-connection/openrouter")) ||
        raw.startsWith("/api/repositories") ||
        (enabled &&
          (passwordMode || userAccessSession) &&
          raw.startsWith("/api/backend-session")) ||
        (sharedApi && raw.startsWith("/api/"))
      )
        return reply(res, 403, { error: "backend_relay_forbidden" });
      return next();
    }
    if (!raw.startsWith("/") || raw.startsWith("//")) return next();
    let url;
    try {
      url = new URL(raw, origin);
    } catch {
      return reply(res, 400, { error: "invalid_repository_request" });
    }
    const provider = providerOnly && url.pathname === "/api/provider-connection/openrouter";
    const models = providerOnly && url.pathname === "/api/provider-connection/openrouter/models";
    let decodedPath;
    try {
      decodedPath = decodeURI(url.pathname).replace(/%3A/gi, ":");
    } catch {
      return reply(res, 400, { error: "invalid_repository_request" });
    }
    const shared = !providerOnly && sharedApi && sharedRoute(decodedPath, req.method, passwordMode);
    const metadata =
      !providerOnly &&
      (url.pathname === "/api/repositories" ||
        (!passwordMode && url.pathname.startsWith("/api/repositories/")));
    const session = providerOnly
      ? url.pathname === "/api/provider-connection/openrouter/session"
      : url.pathname === "/api/backend-session" ||
        (sharedApi && url.pathname === "/api/local-session");
    if (
      !metadata &&
      !shared &&
      !provider &&
      !models &&
      !(session && enabled && (passwordMode || userAccessSession))
    )
      return (sharedApi || passwordMode) &&
        !providerOnly &&
        url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/api/auth/") &&
        !url.pathname.startsWith("/api/provider-connection/")
        ? reply(res, 404, { error: "not_found" })
        : next();
    if (!admitted(req, origin)) return reply(res, 403, { error: "backend_relay_forbidden" });
    if (!enabled || (!passwordMode && !userAccessSession))
      return reply(res, 503, { error: "repository_backend_unavailable" });
    if (session) {
      if (req.method !== "GET" || url.search)
        return reply(res, 405, { error: "method_not_allowed" });
      const now = Date.now();
      for (const [value, expires] of sessions) if (expires <= now) sessions.delete(value);
      let nonce = cookie(req);
      if (!nonce || !sessions.has(nonce)) {
        if (sessions.size >= 32) return reply(res, 429, { error: "backend_relay_capacity" });
        nonce = randomBytes(32).toString("hex");
        sessions.set(nonce, now + lifetime);
      }
      return reply(
        res,
        200,
        { nonce },
        {
          "Set-Cookie": `${cookieName}=${nonce}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=1800`,
        },
      );
    }
    const read =
      req.method === "GET" &&
      (shared || provider || models || url.pathname === "/api/repositories");
    const write =
      (shared && ["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) ||
      (req.method === "POST" &&
        (provider || /^\/api\/repositories\/(create|import|reconcile|delete)$/.test(url.pathname)));
    const uploadCancel = shared && req.method === "DELETE" && /\/uploads\//.test(url.pathname);
    const uploadWrite = shared && req.method === "PUT" && /\/uploads\//.test(url.pathname);
    const creationWrite =
      passwordMode && shared && req.method === "POST" && decodedPath === "/api/repositories/create";
    const nativeManagementWrite =
      passwordMode &&
      shared &&
      write &&
      (nativeProjectRepository.test(decodedPath) || nativeProjectInvitations.test(decodedPath));
    const accountBoundWrite = uploadWrite || (passwordMode && shared && write);
    const presenceWrite = shared && write && url.pathname.endsWith("/presence");
    if (!read && !write) return reply(res, 405, { error: "method_not_allowed" });
    if (
      ((provider || models) && url.search) ||
      (write && url.search) ||
      [...url.searchParams.keys()].some(
        (key) =>
          !(
            shared
              ? /\/source\/(tree|file|diff)$/.test(url.pathname)
                ? ["path", "version", "cursor", "runId"]
                : url.pathname === "/api/capabilities"
                  ? ["projectId"]
                  : url.pathname.endsWith("/events")
                    ? ["after"]
                    : []
              : ["cursor"]
          ).includes(key),
      ) ||
      ["path", "version", "runId"].some(
        (key) =>
          url.searchParams.getAll(key).length > 1 ||
          (url.searchParams.get(key)?.length ?? 0) > 1024,
      ) ||
      url.searchParams.getAll("cursor").length > 1 ||
      url.searchParams.getAll("after").length > 1 ||
      url.searchParams.getAll("projectId").length > 1 ||
      (url.searchParams.get("projectId")?.length ?? 0) > 128 ||
      (url.searchParams.has("after") && !/^\d{1,15}$/.test(url.searchParams.get("after"))) ||
      (url.searchParams.get("cursor")?.length ?? 0) > 1024
    )
      return reply(res, 400, { error: "invalid_cursor" });
    let content;
    let uploadAccess;
    let uploadAccountCookie;
    if (write) {
      const nonce = cookie(req);
      if (
        req.headers.origin !== origin ||
        !nonce ||
        (sessions.get(nonce) ?? 0) <= Date.now() ||
        !equal(
          nonce,
          req.headers[
            provider
              ? "x-pitcrew-connection-nonce"
              : shared
                ? "x-pitcrew-local-nonce"
                : "x-pitcrew-backend-nonce"
          ],
        )
      )
        return reply(res, 403, { error: "backend_session_required" });
      if (accountBoundWrite) {
        // Bind mutation consent to the account present before reading its bytes.
        // Another tab may replace this local vault while the stream is pending.
        uploadAccess = passwordMode ? "" : await token();
        const captured = sessionHeaders ? await sessionHeaders(req, uploadAccess) : {};
        uploadAccountCookie = captured.Cookie;
        if (!uploadAccountCookie) return reply(res, 401, { error: "unauthorized" });
      }
      try {
        content =
          req.method === "DELETE"
            ? undefined
            : await body(
                req,
                uploadWrite
                  ? 8388608
                  : shared && url.pathname.endsWith("/presence")
                    ? 512
                    : shared && url.pathname.endsWith("/messages")
                      ? 2097152
                      : shared
                        ? creationWrite
                          ? 8192
                          : nativeManagementWrite
                            ? decodedPath.endsWith("/repository/delete")
                              ? 2048
                              : nativeProjectInvitations.test(decodedPath)
                                ? 512
                                : 8192
                            : 16384
                        : 8192,
                uploadWrite,
              );
        if (
          uploadWrite &&
          (typeof req.headers["x-pitcrew-filename"] !== "string" ||
            req.headers["x-pitcrew-filename"].length > 1536 ||
            typeof req.headers["content-type"] !== "string" ||
            req.headers["content-type"].length > 128)
        )
          throw Error();
        if (provider) {
          const fields = Object.keys(content).sort().join(",");
          if (
            !(
              (fields === "action" && content.action === "remove") ||
              (fields === "action,key" &&
                content.action === "store" &&
                typeof content.key === "string" &&
                /^sk-or-v1-[a-zA-Z0-9_-]{16,4000}$/.test(content.key))
            )
          )
            throw Error();
        } else if (creationWrite || nativeManagementWrite) {
          if (!normalizeNativeManagement(decodedPath, req.method, content)) throw Error();
        } else if (shared && url.pathname.endsWith("/presence")) {
          if (
            Object.keys(content).sort().join(",") !== "active,clientId,sequence" ||
            typeof content.active !== "boolean" ||
            typeof content.clientId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(content.clientId) ||
            !Number.isSafeInteger(content.sequence) ||
            content.sequence < 1
          )
            throw Error();
        } else if (!shared && !normalizeMutation(url.pathname, content)) throw Error();
      } catch (error) {
        return reply(res, error.status ?? 400, { error: "invalid_repository_request" });
      }
      if (busy && !presenceWrite && !uploadCancel && !uploadWrite)
        return reply(res, 409, { error: "backend_relay_busy" });
    }
    // Ephemeral writes do not lock message/approval writes, and leave their last slot free.
    if (active >= (presenceWrite || uploadWrite ? 3 : 4))
      return reply(res, 429, { error: "backend_relay_capacity" });
    active++;
    if (write && !presenceWrite && !uploadCancel && !uploadWrite) busy = true;
    try {
      // This explicit mode never probes Access or touches a cloudflared cache.
      const access = uploadAccess ?? (passwordMode ? "" : await token());
      const authHeaders = sessionHeaders ? await sessionHeaders(req, access) : {};
      if ((passwordMode || sharedApi) && !authHeaders.Cookie)
        return reply(res, 401, { error: "unauthorized" });
      if (accountBoundWrite && authHeaders.Cookie !== uploadAccountCookie)
        return reply(res, 409, { error: "backend_account_changed" });
      // Rebuild headers. Never forward browser Cookie/Authorization/identity, nonce or hints.
      const response = await fetchImpl(
        `${BACKEND_ACCESS.origin}${passwordMode ? "/app" : ""}${url.pathname}${url.search}`,
        {
          method: req.method,
          redirect: "manual",
          signal: AbortSignal.timeout(uploadWrite ? 45000 : 10000),
          headers: {
            Accept: "application/json",
            ...(!passwordMode ? { "Cf-Access-Token": access } : {}),
            ...(authHeaders.Cookie
              ? { Cookie: accountBoundWrite ? uploadAccountCookie : authHeaders.Cookie }
              : {}),
            ...(write
              ? {
                  Origin: BACKEND_ACCESS.origin,
                  "Content-Type": uploadWrite ? req.headers["content-type"] : "application/json",
                }
              : {}),
            ...(uploadWrite ? { "X-Pitcrew-Filename": req.headers["x-pitcrew-filename"] } : {}),
          },
          ...(write && content !== undefined
            ? { body: uploadWrite ? content : JSON.stringify(content) }
            : {}),
        },
      );
      if (
        [301, 302, 303, 307, 308].includes(response.status) ||
        (!passwordMode && !sharedApi && [401, 403].includes(response.status))
      ) {
        cached = undefined;
        await response.body?.cancel();
        return reply(res, 403, {
          error: passwordMode ? "unauthorized" : "backend_sign_in_required",
        });
      }
      if (shared && response.ok && /\/attachments\//.test(url.pathname)) {
        const mediaType = response.headers.get("content-type");
        if (
          ![
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "application/octet-stream",
          ].includes(mediaType)
        )
          throw Error();
        const reader = response.body?.getReader();
        if (!reader) throw Error();
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > (mediaType === "application/octet-stream" ? 8388608 : 1048576))
              throw Error();
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        res.writeHead(response.status, {
          "Content-Type": mediaType,
          ...(mediaType === "application/octet-stream"
            ? {
                "Content-Disposition":
                  /^attachment; filename="download"; filename\*=UTF-8\x27\x27[A-Za-z0-9%_.~-]{1,1536}$/.test(
                    response.headers.get("content-disposition") ?? "",
                  )
                    ? response.headers.get("content-disposition")
                    : "attachment; filename=download",
              }
            : {}),
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        res.end(Buffer.concat(chunks));
        return;
      }
      const visualization =
        /^\/api\/projects\/[A-Za-z0-9_-]{1,128}\/threads\/[A-Za-z0-9_-]{1,128}\/visualizations(?:\/[A-Za-z0-9_-]{1,128})?$/.test(
          url.pathname,
        );
      const value = await boundedJson(
        response,
        visualization ? 524288 + 4096 : shared ? 2097152 : 262144,
      );
      if (!response.ok)
        return reply(res, response.status, {
          error:
            passwordMode && [401, 403].includes(response.status)
              ? "unauthorized"
              : provider || models
                ? "provider_operation_failed"
                : safeErrors.has(value?.error)
                  ? value.error
                  : "repository_operation_failed",
        });
      const nextSequence = response.headers.get("x-next-sequence");
      return reply(
        res,
        response.status,
        shared &&
          !(
            ["/api/repository-creations", "/api/repositories/create"].includes(decodedPath) ||
            (passwordMode &&
              (nativeProjectRepository.test(decodedPath) ||
                (nativeProjectInvitations.test(decodedPath) &&
                  (req.method === "GET" || decodedPath.endsWith("/revoke")))))
          )
          ? value
          : cleanResponse(
              decodedPath,
              passwordMode && provider ? { ...value, executionEnabled: false } : value,
              passwordMode,
              req.method,
              nativeManagementWrite ? content : undefined,
            ),
        shared && /^\d{1,15}$/.test(nextSequence ?? "") ? { "X-Next-Sequence": nextSequence } : {},
      );
    } catch {
      cached = undefined;
      return reply(res, 503, { error: "repository_backend_unavailable" });
    } finally {
      active--;
      if (write && !presenceWrite && !uploadCancel && !uploadWrite) busy = false;
    }
  };
}
export function backendRelayPlugin(options = {}) {
  return {
    name: "pitcrew-backend-relay",
    configureServer(server) {
      const address = server.config.server;
      if (options.enabled && address.host !== "127.0.0.1") throw Error("relay_requires_loopback");
      server.middlewares.use(
        createBackendRelayMiddleware({
          ...options,
          origin: () => {
            const listening = server.httpServer?.address();
            return listening && typeof listening !== "string" && listening.address === "127.0.0.1"
              ? `http://127.0.0.1:${listening.port}`
              : undefined;
          },
        }),
      );
    },
  };
}
