import { resolveDisplayCatalog, type ModelEnv } from "./model-selection";
import { credentialStorageAvailable, userCredential, type CredentialEnv } from "./user-credentials";

/** Separate read-only catalog: no credential retrieval, work admission, or execution. */
export async function providerModelsRequest(
  request: Request,
  env: CredentialEnv & ModelEnv,
  actor: string,
) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers });
  if (request.method !== "GET") return reply({ error: "provider_method_not_allowed" }, 405);
  if (new URL(request.url).search) return reply({ error: "provider_request_invalid" }, 400);
  if (!credentialStorageAvailable(env)) return reply({ models: [], executionEnabled: false });
  try {
    if (!(await userCredential(env, actor).present(actor)))
      return reply({ models: [], executionEnabled: false });
  } catch {
    return reply({ error: "provider_storage_unavailable" }, 503);
  }
  try {
    const catalog = resolveDisplayCatalog(env);
    const models = catalog.choices.filter((choice) => choice.provider === "openrouter");
    const selected =
      models.find((choice) => choice.id === catalog.defaultSelection.modelId) ?? models[0];
    if (!selected) return reply({ models: [], executionEnabled: false });
    return reply({
      catalogRevision: catalog.revision,
      models,
      defaultSelection:
        selected.id === catalog.defaultSelection.modelId
          ? catalog.defaultSelection
          : { modelId: selected.id, effort: selected.defaultEffort ?? selected.efforts[0] },
      executionEnabled: false,
    });
  } catch {
    return reply({ error: "provider_catalog_unavailable" }, 503);
  }
}
