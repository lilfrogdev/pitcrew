import { IconBrandOpenai, IconCpu } from "@tabler/icons-react";
import openRouterLogo from "./assets/openrouter.svg";

export const providerName = (provider: string) =>
  provider === "openrouter"
    ? "OpenRouter"
    : provider === "openai"
      ? "OpenAI"
      : provider === "fixture"
        ? "Fixture"
        : provider;
export function ProviderIcon({ provider, size = 18 }: { provider: string; size?: number }) {
  return (
    <span
      role="img"
      aria-label={`${provider} provider`}
      style={{
        display: "inline-flex",
        flexShrink: 0,
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {provider === "openrouter" ? (
        <img src={openRouterLogo} alt="" width={size} />
      ) : provider === "openai" ? (
        <IconBrandOpenai size={size} stroke={1.5} color="#000" aria-hidden="true" />
      ) : (
        <IconCpu size={size} stroke={1.5} aria-hidden="true" />
      )}
    </span>
  );
}
