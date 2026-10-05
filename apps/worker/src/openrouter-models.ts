import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { Provider } from "@earendil-works/pi-ai/models";

/** Public catalog snapshot from https://openrouter.ai/api/v1/models, 2026-10-05.
 * Keep Pi's native API/compatibility contracts; correct stale bundled metadata.
 * No refresh, credentials, provider request, or automatic alias switching.
 */
export const OPENROUTER_SNAPSHOT = {
  "qwen/qwen3.8-flash": {
    input: 0.15,
    output: 0.47,
    cacheRead: 0.016,
    contextWindow: 1000000,
    maxTokens: 131072,
  },
  "deepseek/deepseek-v4-flash": {
    input: 0.027,
    output: 1.28,
    cacheRead: 0.027,
    contextWindow: 1048576,
    maxTokens: 943718,
  },
  "deepseek/deepseek-v4-flash-0731": {
    input: 0.0152,
    output: 1.28,
    cacheRead: 0.0152,
    contextWindow: 1048576,
    maxTokens: 943718,
  },
  "deepseek/deepseek-v4-flash-vision-exp": {
    input: 0.2156,
    output: 0.6468,
    cacheRead: 0.00686,
    contextWindow: 1048576,
    maxTokens: 262144,
  },
} as const;

export function pitcrewOpenrouterProvider(): Provider {
  const provider: Provider = openrouterProvider();
  const models = provider.getModels().map((model) => {
    const snapshot = OPENROUTER_SNAPSHOT[model.id as keyof typeof OPENROUTER_SNAPSHOT];
    const corrected = snapshot
      ? {
          ...model,
          contextWindow: snapshot.contextWindow,
          maxTokens: snapshot.maxTokens,
          cost: {
            ...model.cost,
            input: snapshot.input,
            output: snapshot.output,
            cacheRead: snapshot.cacheRead,
          },
        }
      : model;
    // Gateway catalog exposes token budgets, not named efforts, for this model.
    // Until budget constraints are verified, expose only explicit reasoning off.
    return model.id === "qwen/qwen3.8-flash"
      ? {
          ...corrected,
          thinkingLevelMap: {
            off: "none",
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: null,
          },
        }
      : corrected;
  });
  const prepare: NonNullable<Parameters<Provider["streamSimple"]>[2]>["onPayload"] = async (
    payload,
    model,
  ) => {
    if (model.id !== "qwen/qwen3.8-flash") return payload;
    return qwenPayload(payload);
  };
  return {
    ...provider,
    getModels: () => models,
    getAllModels: () => models,
    stream(model, context, options) {
      const updated: NonNullable<typeof options> = {
        ...options,
        onPayload: async (payload, selected) =>
          prepare?.((await options?.onPayload?.(payload, selected)) ?? payload, selected),
      } as NonNullable<typeof options>;
      return provider.stream(model, context, updated);
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, selected) =>
          prepare?.((await options?.onPayload?.(payload, selected)) ?? payload, selected),
      });
    },
  };
}

export function qwenPayload(payload: unknown) {
  const value = payload as Record<string, unknown>;
  if (value.tool_choice && !["auto", "none"].includes(value.tool_choice as string))
    throw Error("unsupported_tool_choice");
  const reasoning = value.reasoning as { effort?: string } | undefined;
  if (reasoning?.effort === "none") return { ...value, reasoning: { enabled: false } };
  throw Error("unsupported_reasoning_preset");
}
