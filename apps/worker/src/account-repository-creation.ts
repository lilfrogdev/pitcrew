import {
  repositoryName,
  logicalRepositoryName,
  type LifecycleRecord,
} from "./repository-lifecycle";

export class RepositoryCreationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Deployment approval is separate from account-derived project ownership. */
export function approvedRepositoryCreation(
  env: {
    AUTH_MODE?: string;
    ENVIRONMENT?: string;
    ARTIFACTS?: unknown;
    CREATE_ACCOUNT_ACTOR?: string;
    CREATE_REPOSITORY_NAME?: string;
    ACCOUNT_REPOSITORY_MANAGEMENT?: string;
  },
  actor: string,
) {
  if (
    env.AUTH_MODE !== "password-only" ||
    env.ENVIRONMENT !== "production" ||
    !env.ARTIFACTS ||
    !/^account:[A-Za-z0-9_-]{1,128}$/.test(actor) ||
    env.CREATE_ACCOUNT_ACTOR !== actor
  )
    return;
  try {
    return { name: repositoryName(env.CREATE_REPOSITORY_NAME) };
  } catch {
    return;
  }
}

export function accountRepositoryManagement(
  env: {
    AUTH_MODE?: string;
    ENVIRONMENT?: string;
    ARTIFACTS?: unknown;
    ACCOUNT_REPOSITORY_MANAGEMENT?: string;
  },
  actor: string,
) {
  return (
    env.AUTH_MODE === "password-only" &&
    env.ENVIRONMENT === "production" &&
    !!env.ARTIFACTS &&
    env.ACCOUNT_REPOSITORY_MANAGEMENT === "enabled" &&
    /^account:[A-Za-z0-9_-]{1,128}$/.test(actor)
  );
}

/** Destructive rollout approval is independent from routine repository management. */
export function accountRepositoryDeletion(
  env: {
    AUTH_MODE?: string;
    ENVIRONMENT?: string;
    ARTIFACTS?: unknown;
    ACCOUNT_REPOSITORY_MANAGEMENT?: string;
    ACCOUNT_REPOSITORY_DELETE?: string;
  },
  actor: string,
) {
  return accountRepositoryManagement(env, actor) && env.ACCOUNT_REPOSITORY_DELETE === "enabled";
}

/** Strict object JSON, bounded before decoding or any authority/provider admission. */
export async function readRepositoryBody(request: Request, allowed: string[], limit = 8192) {
  if (
    request.headers.has("content-encoding") ||
    request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json"
  )
    throw new RepositoryCreationError("unsupported_media_type", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new RepositoryCreationError("body_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RepositoryCreationError("invalid_repository_request", 400);
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new RepositoryCreationError("body_too_large", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof RepositoryCreationError) throw error;
    throw new RepositoryCreationError("invalid_repository_request", 400);
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    throw new RepositoryCreationError("invalid_repository_request", 400);
  return body as Record<string, unknown>;
}
export function repositoryMetadata(displayName: unknown, description: unknown) {
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.trim().length > 80 ||
    // eslint-disable-next-line no-control-regex -- Local labels reject invisible controls.
    /[\u0000-\u001f\u007f]/.test(displayName) ||
    typeof description !== "string" ||
    description.trim().length > 1000 ||
    // eslint-disable-next-line no-control-regex -- Multiline text permits only LF and tab controls.
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(description)
  )
    throw new RepositoryCreationError("invalid_repository_metadata", 400);
  return { displayName: displayName.trim(), description: description.trim() };
}
export async function readRepositoryCreation(request: Request, broad = false) {
  const body = await readRepositoryBody(
    request,
    broad
      ? ["name", "credentialConsent", "displayName", "description"]
      : ["name", "credentialConsent"],
    broad ? 8192 : 2048,
  );
  if (body.credentialConsent !== true)
    throw new RepositoryCreationError("credential_consent_required", 400);
  let name: string;
  try {
    name = broad ? logicalRepositoryName(body.name) : repositoryName(body.name);
  } catch {
    throw new RepositoryCreationError("invalid_name", 400);
  }
  return {
    name,
    ...repositoryMetadata(
      body.displayName === undefined ? name : body.displayName,
      body.description === undefined ? "" : body.description,
    ),
  };
}

export function creationProjection(record: LifecycleRecord, projectId?: string) {
  const status =
    record.status === "ready"
      ? projectId
        ? "ready"
        : "registration_required"
      : record.status === "deleted" || record.status === "deleting"
        ? record.status
        : record.status === "cleanup_required"
          ? "cleanup_required"
          : "pending";
  return {
    name: record.logicalName ?? record.name,
    ...(record.logicalName ? { logicalName: record.logicalName, repositoryName: record.name } : {}),
    status,
    ...(record.id ? { repositoryId: record.id } : {}),
    ...(status === "ready" ? { projectId } : {}),
    ...(record.issue === "repository_exists" ? { issue: record.issue } : {}),
  };
}

export function creationError(error: unknown) {
  return error instanceof RepositoryCreationError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: "repository_operation_failed" }, { status: 503 });
}
