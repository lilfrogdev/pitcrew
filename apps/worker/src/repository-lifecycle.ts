import { normalizePublicRepositoryImportUrl } from "../../../packages/protocol/src/repository-import-url.mjs";

/** Metadata only. No creation token is stored, returned, or used for Git. */
export type LifecycleRecord = {
  ownerActor?: string;
  name: string;
  operation: "create" | "import";
  id?: string;
  source?: string;
  issue?: string;
  status: "pending" | "cleanup_required" | "ready" | "deleting" | "deleted";
};
export type LifecycleStore = {
  get(name: string): LifecycleRecord | undefined;
  put(record: LifecycleRecord): void;
  list(): LifecycleRecord[];
};
type Binding = Pick<Artifacts, "create" | "import" | "get" | "list" | "delete">;
function serviceCode(error: unknown): string | undefined {
  const allowed = ["NOT_FOUND", "REMOTE_AUTH_REQUIRED", "MEMORY_LIMIT", "ALREADY_EXISTS"];
  const value = error as { code?: unknown; message?: unknown } | undefined;
  if (typeof value?.code === "string" && allowed.includes(value.code)) return value.code;
  if (typeof value?.message === "string")
    return allowed.find(
      (code) => value.message === code || (value.message as string).startsWith(`${code}:`),
    );
}
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function repositoryName(value: unknown): string {
  if (typeof value !== "string" || !namePattern.test(value)) throw Error("invalid_name");
  return value;
}
export const publicImportUrl = normalizePublicRepositoryImportUrl;
export class RepositoryLifecycle {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private binding: Binding,
    private store: LifecycleStore,
    private referenced: (name: string) => boolean,
  ) {}
  // DO storage is durable; serialize requests through cleanup and destructive checks.
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  async list(cursor?: string) {
    const page = await this.binding.list({ limit: 50, cursor });
    const entries = page.repos.map((repo) => {
      const saved = this.store.get(repo.name);
      const owned = saved?.id && saved.id !== repo.id ? undefined : saved;
      return {
        name: repo.name,
        status: "present",
        lifecycle: owned?.status ?? "external",
        issue: owned?.issue,
        deletable: owned?.status === "ready" && !this.referenced(repo.name),
      };
    });
    if (!cursor)
      for (const record of this.store.list())
        if (
          ["pending", "cleanup_required", "deleting"].includes(record.status) &&
          !entries.some((entry) => entry.name === record.name)
        )
          entries.push({
            name: record.name,
            status: "unconfirmed",
            lifecycle: record.status,
            issue: record.issue,
            deletable: false,
          });
    return { repositories: entries, cursor: page.cursor ?? null };
  }
  private async cleanup(record: LifecycleRecord) {
    try {
      if (this.referenced(record.name)) throw Error();
      using repo = await this.binding.get(record.name);
      if (!record.id || (await repo.info()).id !== record.id) throw Error();
      const tokens = await repo.listTokens();
      // A managed repository is quarantined until cleanup. No Pitcrew execution
      // or token issuance can reference it. The initial issuance is the only token expected. Multiple tokens require
      // owner investigation; do not revoke unrelated credentials.
      if (tokens.total > 1 || tokens.tokens.length !== tokens.total) throw Error();
      for (const token of tokens.tokens)
        if (token.state === "active" && !(await repo.revokeToken(token.id))) throw Error();
      const check = await repo.listTokens();
      if (
        check.total > 1 ||
        check.tokens.length !== check.total ||
        check.tokens.some((token) => token.state === "active")
      )
        throw Error();
      record = { ...record, status: "ready" };
    } catch {
      record = { ...record, status: "cleanup_required" };
    }
    this.store.put(record);
    return record;
  }
  provision(name: string, operation: "create" | "import", source?: string, ownerActor?: string) {
    return this.exclusive(async () => {
      const existing = this.store.get(name);
      if (existing && existing.ownerActor !== ownerActor) throw Error("not_found");
      // Never retry an ambiguous creation or replace a deleted/existing name.
      if (existing) {
        if (existing.status === "deleted") throw Error("repository_name_retired");
        if (existing.status === "deleting") throw Error("deletion_pending");
        if (existing.operation !== operation || existing.source !== source)
          throw Error("repository_exists");
        return existing;
      }
      if (this.referenced(name)) throw Error("repository_protected");
      if (this.store.list().length >= 200) throw Error("lifecycle_limit");
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const listed = await this.binding.list({ limit: 200, cursor });
        if (listed.repos.some((repo) => repo.name === name)) throw Error("repository_exists");
        cursor = listed.cursor;
        if (!cursor) break;
      }
      if (cursor) throw Error("namespace_limit");
      const record: LifecycleRecord = {
        name,
        operation,
        ...(ownerActor ? { ownerActor } : {}),
        ...(source ? { source } : {}),
        status: "pending",
      };
      this.store.put(record);
      try {
        let created: ArtifactsCreateRepoResult;
        if (operation === "import") {
          // Public GitHub URL only, depth one, read-only; no credentials accepted.
          created = await this.binding.import({
            source: { url: source!, depth: 1 },
            target: { name, opts: { readOnly: true } },
          });
        } else {
          created = await this.binding.create(name, { readOnly: true, setDefaultBranch: "main" });
        }
        if (created.name !== name) throw Error();
        record.id = created.id;
        record.status = "cleanup_required";
        this.store.put(record);
      } catch (error) {
        const code = serviceCode(error);
        const issue =
          code === "ALREADY_EXISTS"
            ? "repository_exists"
            : operation === "import"
              ? (
                  {
                    REMOTE_AUTH_REQUIRED: "import_source_authentication_required",
                    NOT_FOUND: "import_source_not_found",
                    MEMORY_LIMIT: "import_limit_exceeded",
                  } as Record<string, string>
                )[code ?? ""]
              : undefined;
        // Even a recognized error may follow partial provisioning. Preserve
        // quarantine and require investigation; do not resubmit or infer ownership.
        if (issue) record.issue = issue;
        // Outcome may be ambiguous. Do not clean up an existing external repo.
        this.store.put({ ...record, status: "pending" });
        return { ...record, status: "pending" as const };
      }
      return this.cleanup(record);
    });
  }
  reconcile(name: string, ownerActor?: string) {
    return this.exclusive(async () => {
      const record = this.store.get(name);
      if (record && record.ownerActor !== ownerActor) throw Error("not_found");
      if (record?.status === "deleting") {
        try {
          using repo = await this.binding.get(name);
          if ((await repo.info()).id !== record.id) throw Error("repository_protected");
          const ready = { ...record, status: "ready" as const };
          this.store.put(ready);
          return ready;
        } catch (error) {
          if (serviceCode(error) !== "NOT_FOUND") throw Error("deletion_pending");
          const deleted = { ...record, status: "deleted" as const };
          this.store.put(deleted);
          return deleted;
        }
      }
      if (!record || record.status !== "cleanup_required")
        throw Error("reconciliation_unavailable");
      return this.cleanup(record);
    });
  }
  remove(name: string, confirmation: string, ownerActor?: string) {
    return this.exclusive(async () => {
      const record = this.store.get(name);
      if (record && record.ownerActor !== ownerActor) throw Error("not_found");
      if (confirmation !== name) throw Error("confirmation_required");
      if (record?.status === "deleted") return { name, status: "deleted" };
      if (!record || record.status !== "ready" || this.referenced(name))
        throw Error("repository_protected");
      using repo = await this.binding.get(name);
      if (!record.id || (await repo.info()).id !== record.id) throw Error("repository_protected");
      this.store.put({ ...record, status: "deleting" });
      if (!(await this.binding.delete(name))) throw Error("delete_not_confirmed");
      this.store.put({ ...record, status: "deleted" });
      return { name, status: "deleted" };
    });
  }
}
export async function lifecycleRequest(
  request: Request,
  lifecycle?: RepositoryLifecycle,
  waitUntil?: (task: Promise<unknown>) => void,
  ownerActor?: string,
  registered?: (record: LifecycleRecord) => Promise<void>,
) {
  if (!lifecycle)
    return Response.json({ error: "repository_backend_unavailable" }, { status: 503 });
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/repositories") {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (cursor && cursor.length > 1024) throw Error("invalid_cursor");
      return Response.json(await lifecycle.list(cursor));
    }
    if (request.method !== "POST")
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const reader = request.body?.getReader();
    if (!reader) throw Error();
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      if (bytes > 2048) {
        await reader.cancel();
        return Response.json({ error: "body_too_large" }, { status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text);
    const name = repositoryName(body.name);
    if (
      url.pathname === "/api/repositories/create" ||
      url.pathname === "/api/repositories/import"
    ) {
      if (body.credentialConsent !== true) throw Error("credential_consent_required");
      const importing = url.pathname.endsWith("/import");
      const source = importing ? publicImportUrl(body.url) : undefined;
      const task = lifecycle.provision(name, importing ? "import" : "create", source, ownerActor)
        .then(async (record) => { if (record.status === "ready") await registered?.(record); return record; });
      waitUntil?.(task.catch(() => {}));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        task,
        new Promise<LifecycleRecord>((resolve) => {
          timer = setTimeout(
            () => resolve({ name, operation: importing ? "import" : "create", status: "pending" }),
            5000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.issue) return Response.json({ error: result.issue }, { status: 422 });
      return Response.json(result, { status: result.status === "ready" ? 200 : 202 });
    }
    if (url.pathname === "/api/repositories/reconcile") {
      const record = await lifecycle.reconcile(name, ownerActor);
      if (record.status === "ready") await registered?.(record);
      return Response.json(record);
    }
    if (url.pathname === "/api/repositories/delete")
      return Response.json(await lifecycle.remove(name, body.confirmation, ownerActor));
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    const safe = [
      "invalid_name",
      "invalid_public_url",
      "invalid_cursor",
      "credential_consent_required",
      "repository_exists",
      "repository_name_retired",
      "deletion_pending",
      "namespace_limit",
      "lifecycle_limit",
      "confirmation_required",
      "repository_protected",
      "reconciliation_unavailable",
      "delete_not_confirmed",
      "not_found",
    ];
    const message =
      error instanceof Error && safe.includes(error.message)
        ? error.message
        : "repository_operation_failed";
    return Response.json(
      { error: message },
      { status: message === "not_found" ? 404 : message === "repository_protected" ? 409 : 400 },
    );
  }
}
