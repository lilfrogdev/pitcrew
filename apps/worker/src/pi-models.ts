import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, type CredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createAI } from "agents/models/pi-ai";
import type { ModelConfiguration } from "@pitcrew/protocol";
export function configureModels(
  configuration: ModelConfiguration,
  bindings: { AI?: Ai; secrets?: Record<string, string> },
  fixture?: Provider,
) {
  const credentials: CredentialStore = {
    async read(providerId) {
      if (configuration.provider !== "byok" || providerId !== configuration.providerId)
        return undefined;
      const key = bindings.secrets?.[configuration.secretBinding];
      if (!key) throw Error("model_not_configured");
      return { type: "api_key", key };
    },
    async list() {
      return [];
    },
    async modify() {
      throw Error("credential_changes_disabled");
    },
    async delete() {
      throw Error("credential_changes_disabled");
    },
  };
  // Never use ambient environment variables, credential files, OAuth, or login flows.
  const models = createModels({
    credentials,
    authContext: {
      async env() {
        return undefined;
      },
      async fileExists() {
        return false;
      },
    },
  });
  if (configuration.provider === "fake") {
    const faux = fauxProvider({
      provider: "pitcrew-fixture",
      models: [{ id: "fixture", maxTokens: 1024 }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        '{"decision":"request_changes","summary":"Development fixture; no real model review."}',
      ),
    ]);
    const provider = fixture ?? faux.provider;
    models.setProvider(provider);
    const model = provider.getModels()[0];
    if (!model) throw Error("model_not_configured");
    return { models, model };
  }
  if (configuration.provider === "cloudflare") {
    if (!bindings.AI || !configuration.model.startsWith("@cf/"))
      throw Error("model_not_configured");
    const ai = createAI({ binding: bindings.AI });
    models.setProvider(ai.provider);
    return { models, model: ai(configuration.model) };
  }
  const factories: Record<string, () => Provider> = {
    openai: openaiProvider,
    anthropic: anthropicProvider,
  };
  const factory = factories[configuration.providerId];
  if (!factory || !bindings.secrets?.[configuration.secretBinding])
    throw Error("model_not_configured");
  const provider = factory();
  models.setProvider(provider);
  const model = models.getModel(provider.id, configuration.model);
  if (!model) throw Error("model_not_configured");
  return { models, model };
}
