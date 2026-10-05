import { apiFetch } from "./api";
export type RepositoryEntry = {
  name: string;
  lifecycle: "external" | "pending" | "cleanup_required" | "ready" | "deleting" | "deleted";
  deletable: boolean;
  issue?: string;
};
export type RepositoryPage = { repositories: RepositoryEntry[]; cursor: string | null };
export interface RepositoryApi {
  list(cursor?: string): Promise<RepositoryPage>;
  provision(input: {
    name: string;
    operation: "create" | "import";
    url?: string;
    credentialConsent: true;
  }): Promise<{ name: string; status: string }>;
  reconcile(name: string): Promise<unknown>;
  remove(name: string, confirmation: string): Promise<unknown>;
}
export const repositoryError = (error: unknown) =>
  error instanceof Error ? error.message : "Repository operation failed.";
export const repositoryIssues: Record<string, string> = {
  repository_backend_unavailable:
    "Repository management is unavailable. Connect the protected cloud backend first.",
  repository_name_retired: "That name was retired after deletion. Choose a new repository name.",
  deletion_pending:
    "Deletion is unconfirmed. Refresh and reconcile its status before trying again.",
  import_source_authentication_required:
    "The source requires authentication. Only public repositories are supported. This operation needs owner investigation before retrying.",
  import_source_not_found:
    "The public source could not be found. Check its URL; this operation needs owner investigation before retrying.",
  import_limit_exceeded:
    "The import exceeded a platform limit. Use a smaller repository; this operation needs owner investigation before retrying.",
  repository_exists: "That repository already exists. Choose a new name.",
  repository_protected: "This repository is protected or requires reconciliation.",
  invalid_name: "Use 1–63 lowercase letters, numbers or hyphens; start with a letter or number.",
  invalid_public_url:
    "Enter a public GitHub repository HTTPS URL without credentials or query parameters.",
  reconciliation_unavailable: "This operation needs owner investigation before it can be retried.",
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/repositories${path}`, body, 45000);
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as { error?: string };
    throw Error(
      repositoryIssues[value.error ?? ""] ??
        (response.status === 403
          ? "Protected backend access is unavailable."
          : "Repository operation failed. Refresh to check its status before retrying."),
    );
  }
  return response.json() as Promise<T>;
}
export function createRepositoryApi(): RepositoryApi {
  return {
    list: (cursor) => request(cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
    provision: ({ operation, ...input }) => request(`/${operation}`, input),
    reconcile: (name) => request("/reconcile", { name }),
    remove: (name, confirmation) => request("/delete", { name, confirmation }),
  };
}
