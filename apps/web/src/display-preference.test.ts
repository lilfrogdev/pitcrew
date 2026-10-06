import { afterEach, expect, it } from "vite-plus/test";
import { readDisplayPreference, saveDisplayPreference } from "./display-preference";
const choice = {
  id: "default",
  label: "Qwen",
  provider: "openrouter",
  model: "qwen/qwen3.8-flash",
  efforts: ["off" as const],
  contextWindow: 1000000,
};
afterEach(() => localStorage.clear());
it("scopes display preferences by project/thread/revision and model identity, without reinterpreting colliding default ids", () => {
  const selection = { modelId: "default", effort: "off" as const };
  saveDisplayPreference("project", "thread", "revision", choice, selection);
  expect(readDisplayPreference("project", "thread", "revision", [choice])).toEqual(selection);
  expect(readDisplayPreference("other", "thread", "revision", [choice])).toBeUndefined();
  expect(readDisplayPreference("project", "other", "revision", [choice])).toBeUndefined();
  expect(readDisplayPreference("project", "thread", "changed", [choice])?.modelId).toBe("");
  expect(
    readDisplayPreference("project", "thread", "revision", [
      { ...choice, provider: "pitcrew-fixture", model: "fixture" },
    ])?.modelId,
  ).toBe("");
  const colliding = { ...choice, id: "unavailable", model: "other/model" };
  const stale = readDisplayPreference("project", "thread", "changed", [colliding]);
  expect(stale?.modelId).toBe("");
  expect([colliding].find((model) => model.id === stale?.modelId)).toBeUndefined();
});
