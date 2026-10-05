import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ModelChoice, ModelSettings } from "@pitcrew/protocol";
import { ModelPicker, WorkerModelSettings } from "./ModelPicker";
afterEach(cleanup);
const models: ModelChoice[] = [
  {
    id: "a",
    label: "Model A",
    provider: "fixture",
    model: "a",
    efforts: ["low", "medium", "high"],
    contextWindow: 100000,
  },
  {
    id: "b",
    label: "Model B",
    provider: "fixture",
    model: "b",
    efforts: ["off"],
    contextWindow: 100000,
  },
];
it("shows supported efforts and chooses a supported default on model change", () => {
  const onSelection = vi.fn();
  const { rerender } = render(
    <ModelPicker
      models={models}
      selection={{ modelId: "a", effort: "high" }}
      onSelection={onSelection}
      disabled={false}
    />,
  );
  expect(screen.queryByRole("option", { name: "Max effort" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Repo agent model"), { target: { value: "b" } });
  expect(onSelection).toHaveBeenCalledWith({ modelId: "b", effort: "off" });
  rerender(
    <ModelPicker
      models={models}
      selection={{ modelId: "b", effort: "off" }}
      onSelection={onSelection}
      disabled={false}
    />,
  );
  expect(screen.getByLabelText("Repo agent effort")).toHaveProperty("value", "off");
  expect(screen.queryByRole("option", { name: "High effort" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Repo agent model"), { target: { value: "a" } });
  expect(onSelection).toHaveBeenLastCalledWith({ modelId: "a", effort: "medium" });
});
it("keeps unavailable preferences explicit without silently routing", () => {
  const onSelection = vi.fn();
  const { rerender } = render(
    <ModelPicker
      models={models}
      selection={{ modelId: "removed", effort: "high" }}
      onSelection={onSelection}
      disabled={false}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("Selected model is unavailable");
  expect(screen.getByLabelText("Repo agent model")).toHaveProperty("value", "");
  expect(onSelection).not.toHaveBeenCalled();
  rerender(
    <ModelPicker
      models={models}
      selection={{ modelId: "b", effort: "high" }}
      onSelection={onSelection}
      disabled={false}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("Selected effort is unavailable");
  expect(screen.getByLabelText("Repo agent effort")).toHaveProperty("value", "");
  expect(onSelection).not.toHaveBeenCalled();
});
it("removes inherited overrides and saves supported role selections", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const settings: ModelSettings = {
    default: { modelId: "a", effort: "medium" },
    roles: { implementer: { modelId: "b", effort: "off" } },
  };
  render(
    <WorkerModelSettings models={models} settings={settings} onSave={onSave} disabled={false} />,
  );
  fireEvent.click(screen.getByText("Repository model defaults"));
  fireEvent.change(screen.getByLabelText("Implementer model source"), {
    target: { value: "inherit" },
  });
  expect(screen.queryByLabelText("Implementer model")).toBeNull();
  fireEvent.change(screen.getByLabelText("Reviewer model source"), {
    target: { value: "override" },
  });
  fireEvent.change(screen.getByLabelText("Reviewer model"), { target: { value: "b" } });
  fireEvent.click(screen.getByRole("button", { name: "Save repository model defaults" }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({
      default: settings.default,
      roles: { reviewer: { modelId: "b", effort: "off" } },
    }),
  );
  expect(screen.getByText(/Researcher overrides are unavailable/)).toBeTruthy();
});
it("prevents duplicate saves and preserves preferences for retry after errors", async () => {
  let reject!: (error: Error) => void;
  const onSave = vi.fn().mockImplementation(
    () =>
      new Promise((_, rejection) => {
        reject = rejection;
      }),
  );
  render(
    <WorkerModelSettings
      models={models}
      settings={{ default: { modelId: "a", effort: "medium" } }}
      onSave={onSave}
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByText("Repository model defaults"));
  fireEvent.click(screen.getByRole("button", { name: "Save repository model defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
  expect(onSave).toHaveBeenCalledTimes(1);
  reject(Error("Fixture save failed"));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("Fixture save failed");
  expect(screen.getByLabelText("Repository default effort")).toHaveProperty("value", "medium");
});
it("blocks saving an unavailable worker override until removed or corrected", () => {
  render(
    <WorkerModelSettings
      models={models}
      settings={{
        default: { modelId: "a", effort: "medium" },
        roles: { reviewer: { modelId: "removed", effort: "high" } },
      }}
      onSave={vi.fn()}
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByText("Repository model defaults"));
  expect(screen.getByRole("button", { name: "Save repository model defaults" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.change(screen.getByLabelText("Reviewer model source"), {
    target: { value: "inherit" },
  });
  expect(screen.getByRole("button", { name: "Save repository model defaults" })).toHaveProperty(
    "disabled",
    false,
  );
});
