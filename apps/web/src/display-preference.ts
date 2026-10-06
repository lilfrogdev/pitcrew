import type { ModelChoice, ModelSelection } from "@pitcrew/protocol";
const key = (project: string, thread: string) => `pitcrew.display-model:${project}:${thread}`;

/** A local display preference, separate from server execution settings. */
export function readDisplayPreference(
  project: string,
  thread: string,
  revision: string,
  models: ModelChoice[],
): ModelSelection | undefined {
  try {
    const text = localStorage.getItem(key(project, thread));
    if (!text || text.length > 2048) return;
    const value = JSON.parse(text);
    if (typeof value.modelId !== "string" || typeof value.effort !== "string") return;
    const choice = models.find((model) => model.id === value.modelId);
    if (
      value.revision !== revision ||
      choice?.provider !== value.provider ||
      choice?.model !== value.model ||
      !choice?.efforts.includes(value.effort)
    )
      return { modelId: "", effort: "off" };
    return { modelId: choice.id, effort: value.effort };
  } catch {
    return;
  }
}
export function saveDisplayPreference(
  project: string,
  thread: string,
  revision: string,
  choice: ModelChoice,
  selection: ModelSelection,
) {
  localStorage.setItem(
    key(project, thread),
    JSON.stringify({
      revision,
      provider: choice.provider,
      model: choice.model,
      modelId: selection.modelId,
      effort: selection.effort,
    }),
  );
}
