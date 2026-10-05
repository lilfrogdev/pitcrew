import { createHash } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type {
  FrozenRunModels,
  ModelChoice,
  ModelConfiguration,
  ModelSelection,
  ModelSettings,
} from "@pitcrew/protocol";
import { configureModels } from "./pi-models";
import { OPENROUTER_SNAPSHOT } from "./openrouter-models";
export interface ModelEnv {
  MODEL_CONFIGURATION?: string;
  MODELS_CONFIGURATION?: string;
  EXECUTION_MODE?: string;
  AI?: unknown;
}
interface ServerModelEntry {
  choice: ModelChoice;
  configuration: ModelConfiguration;
}
export interface ModelCatalog {
  revision: string;
  choices: ModelChoice[];
  defaultSelection: ModelSelection;
  /** Server-only. Never serialize this object as an API response. */
  entries: ServerModelEntry[];
}
function configuration(value: unknown): ModelConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("model_not_configured");
  const v = value as Record<string, unknown>;
  if (v.provider === "fake") return { provider: "fake" };
  if (v.provider === "cloudflare" && typeof v.model === "string")
    return { provider: "cloudflare", model: v.model };
  if (
    v.provider === "byok" &&
    [v.providerId, v.model, v.secretBinding].every((x) => typeof x === "string" && x.length > 0)
  )
    return {
      provider: "byok",
      providerId: v.providerId as string,
      model: v.model as string,
      secretBinding: v.secretBinding as string,
    };
  throw Error("model_not_configured");
}
function bindings(env: ModelEnv, config: ModelConfiguration) {
  const values = env as unknown as Record<string, unknown>;
  return {
    AI: env.AI,
    secrets:
      config.provider === "byok"
        ? {
            [config.secretBinding]:
              typeof values[config.secretBinding] === "string"
                ? (values[config.secretBinding] as string)
                : "",
          }
        : undefined,
  };
}
export function resolveCatalog(env: ModelEnv): ModelCatalog {
  if (env.EXECUTION_MODE === "cloud" && !env.MODEL_CONFIGURATION)
    throw Error("model_not_configured");
  const defaultConfig = configuration(JSON.parse(env.MODEL_CONFIGURATION ?? '{"provider":"fake"}'));
  const optional: unknown = JSON.parse(env.MODELS_CONFIGURATION ?? "[]");
  if (!Array.isArray(optional) || optional.length > 32) throw Error("model_not_configured");
  const configured = [{ id: "default", configuration: defaultConfig }, ...optional];
  const ids = new Set<string>();
  const entries: ServerModelEntry[] = configured.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("model_not_configured");
    const value = raw as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) ||
      ids.has(value.id)
    )
      throw Error("model_not_configured");
    ids.add(value.id);
    const config = configuration(value.configuration);
    if (config.provider !== "fake" && env.EXECUTION_MODE !== "cloud")
      throw Error("model_not_enabled");
    const { model } = configureModels(config, bindings(env, config));
    const limits = model.inputLimits;
    const snapshot =
      model.provider === "openrouter"
        ? OPENROUTER_SNAPSHOT[model.id as keyof typeof OPENROUTER_SNAPSHOT]
        : undefined;
    const choice: ModelChoice = {
      id: value.id,
      label:
        typeof value.label === "string" && value.label.length > 0 && value.label.length <= 100
          ? value.label
          : model.name,
      provider: model.provider,
      model: model.id,
      efforts: getSupportedThinkingLevels(model),
      ...(snapshot
        ? {
            defaultEffort: model.id === "qwen/qwen3.8-flash" ? ("off" as const) : ("high" as const),
            pricing: {
              input: snapshot.input,
              output: snapshot.output,
              currency: "USD" as const,
              per: "million_tokens" as const,
              asOf: "2026-10-05",
            },
          }
        : {}),
      contextWindow: model.contextWindow,
      // Keep a native Pi submission's base64 payload below the SQLite 2 MiB row ceiling.
      imageLimits: model.input.includes("image")
        ? {
            maxBytes: Math.min(
              1024 * 1024,
              Math.floor(((limits?.images?.resize?.maxBytes ?? Infinity) * 3) / 4),
            ),
            maxPerMessage: Math.min(2, limits?.images?.maxPerMessage ?? 2),
            maxPerRequest: limits?.images?.maxPerRequest ?? 2,
            maxRequestBytes: limits?.maxRequestBytes,
          }
        : undefined,
    };
    if (!choice.efforts.length) throw Error("model_not_configured");
    return { choice, configuration: config };
  });
  const choice = entries[0].choice;
  return {
    revision: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
    choices: entries.map((e) => e.choice),
    defaultSelection: {
      modelId: choice.id,
      effort:
        choice.defaultEffort ?? (choice.efforts.includes("medium") ? "medium" : choice.efforts[0]),
    },
  };
}
export function validateSelection(catalog: ModelCatalog, value: unknown): ModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid_model_selection");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["modelId", "effort"].includes(key)))
    throw Error("invalid_model_selection");
  const choice = catalog.choices.find((c) => c.id === v.modelId);
  if (!choice || !choice.efforts.includes(v.effort as ModelSelection["effort"]))
    throw Error("invalid_model_selection");
  return { modelId: choice.id, effort: v.effort as ModelSelection["effort"] };
}
export function resolveRunModels(
  catalog: ModelCatalog,
  selection?: ModelSelection,
  settings?: ModelSettings,
): FrozenRunModels {
  if (settings) validateSelection(catalog, settings.default);
  const repoAgent = validateSelection(
    catalog,
    selection ?? settings?.default ?? catalog.defaultSelection,
  );
  if (
    settings?.roles &&
    Object.keys(settings.roles).some((role) => !["implementer", "reviewer"].includes(role))
  )
    throw Error("invalid_model_selection");
  return Object.freeze({
    catalogRevision: catalog.revision,
    repoAgent: Object.freeze(repoAgent),
    implementer: Object.freeze(
      validateSelection(catalog, settings?.roles?.implementer ?? repoAgent),
    ),
    reviewer: Object.freeze(validateSelection(catalog, settings?.roles?.reviewer ?? repoAgent)),
  });
}
export function configureSelectedModels(
  env: ModelEnv,
  selection?: ModelSelection,
  expectedRevision?: string,
) {
  const catalog = resolveCatalog(env);
  if (expectedRevision && expectedRevision !== catalog.revision)
    throw Error("model_configuration_changed");
  const selected = validateSelection(catalog, selection ?? catalog.defaultSelection);
  const entry = catalog.entries.find((e) => e.choice.id === selected.modelId)!;
  return {
    ...configureModels(entry.configuration, bindings(env, entry.configuration)),
    selection: selected,
  };
}

/** Configure the durable conversation before submitting any input. */
export async function configureConversation(
  harness: import("@earendil-works/pi-durable").Harness,
  model: { provider: string; id: string },
  selection: ModelSelection,
  context: Parameters<import("@earendil-works/pi-durable").Harness["close"]>[0],
) {
  const conversation = await harness.root(context);
  await conversation.configure(
    { model: { provider: model.provider, modelId: model.id }, thinkingLevel: selection.effort },
    context,
  );
  return conversation;
}

export function validateFrozenModels(env: ModelEnv, models?: FrozenRunModels) {
  if (!models) return; // Legacy runs retain their original environment-only configuration fence.
  const catalog = resolveCatalog(env);
  if (models.catalogRevision && models.catalogRevision !== catalog.revision)
    throw Error("model_configuration_changed");
  validateSelection(catalog, models.repoAgent);
  validateSelection(catalog, models.implementer);
  validateSelection(catalog, models.reviewer);
}
