import { repositoryName, type LifecycleRecord } from "./repository-lifecycle";

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

export async function readRepositoryCreation(request: Request) {
  const limit = 2048;
  if (Number(request.headers.get("content-length") ?? 0) > limit)
    throw new RepositoryCreationError("body_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RepositoryCreationError("invalid_repository_creation", 400);
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
    throw new RepositoryCreationError("invalid_repository_creation", 400);
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    Object.keys(body).some((key) => !["name", "credentialConsent"].includes(key))
  )
    throw new RepositoryCreationError("invalid_repository_creation", 400);
  const input = body as { name?: unknown; credentialConsent?: unknown };
  if (input.credentialConsent !== true)
    throw new RepositoryCreationError("credential_consent_required", 400);
  try {
    return repositoryName(input.name);
  } catch {
    throw new RepositoryCreationError("invalid_name", 400);
  }
}

export function creationProjection(record: LifecycleRecord, projectId?: string) {
  const status =
    record.status === "ready"
      ? projectId
        ? "ready"
        : "registration_required"
      : record.status === "cleanup_required"
        ? "cleanup_required"
        : "pending";
  return {
    name: record.name,
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
