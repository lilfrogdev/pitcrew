import { IconCpu } from "@tabler/icons-react";
import type { ModelChoice } from "@pitcrew/protocol";
import { modelBrand, type ModelBrand } from "./model-brand";
import claude from "./assets/models/claude.svg";
import qwen from "./assets/models/qwen.svg";
import deepseek from "./assets/models/deepseek.svg";
import gemini from "./assets/models/gemini.svg";
import google from "./assets/models/google.svg";
import openai from "./assets/models/openai.svg";
import grok from "./assets/models/grok.svg";
import meta from "./assets/models/meta.svg";
import mistral from "./assets/models/mistral.svg";
import kimi from "./assets/models/kimi.svg";
import glm from "./assets/models/zhipu.svg";
import minimax from "./assets/models/minimax.svg";
import nvidia from "./assets/models/nvidia.svg";
import cohere from "./assets/models/cohere.svg";

const brands: Record<ModelBrand, { name: string; src: string }> = {
  claude: { name: "Claude", src: claude },
  qwen: { name: "Qwen", src: qwen },
  deepseek: { name: "DeepSeek", src: deepseek },
  gemini: { name: "Gemini", src: gemini },
  google: { name: "Google", src: google },
  openai: { name: "OpenAI", src: openai },
  grok: { name: "Grok", src: grok },
  meta: { name: "Meta", src: meta },
  mistral: { name: "Mistral", src: mistral },
  kimi: { name: "Kimi", src: kimi },
  glm: { name: "GLM", src: glm },
  minimax: { name: "MiniMax", src: minimax },
  nvidia: { name: "NVIDIA", src: nvidia },
  cohere: { name: "Cohere", src: cohere },
};

export function ModelIcon({ model, size = 18 }: { model?: ModelChoice; size?: number }) {
  const brand = modelBrand(model);
  const icon = brand ? brands[brand] : undefined;
  return (
    <span
      role="img"
      aria-label={icon ? `${icon.name} model` : "Model"}
      style={{
        display: "inline-flex",
        flexShrink: 0,
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon ? (
        <img src={icon.src} alt="" width={size} height={size} />
      ) : (
        <IconCpu size={size} stroke={1.5} aria-hidden="true" />
      )}
    </span>
  );
}
