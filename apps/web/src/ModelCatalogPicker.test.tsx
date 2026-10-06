import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ModelChoice } from "@pitcrew/protocol";
import { ModelCatalogPicker } from "./ModelCatalogPicker";
import { ModelPicker } from "./ModelPicker";
import { PermissionsMenu } from "./PermissionsMenu";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const models: ModelChoice[] = [
  {
    id: "a",
    provider: "openrouter",
    model: "vendor/a",
    label: "Model A",
    efforts: ["low", "medium", "high"],
    contextWindow: 100000,
  },
  {
    id: "b",
    provider: "openrouter",
    model: "vendor/b",
    label: "Model B",
    efforts: ["off", "high"],
    contextWindow: 100000,
  },
  {
    id: "c",
    provider: "openai",
    model: "vendor/c",
    label: "Model C",
    efforts: ["medium"],
    contextWindow: 100000,
  },
  {
    id: "disabled",
    provider: "openrouter",
    model: "vendor/disabled",
    label: "Unavailable",
    efforts: [],
    contextWindow: 100000,
  },
];
function Controlled({ change = () => {} }: { change?: (model: ModelChoice) => void }) {
  const [value, setValue] = useState("a");
  return (
    <>
      <ModelCatalogPicker
        models={models}
        label="Model"
        value={value}
        disabled={false}
        onChange={(model) => {
          setValue(model.id);
          change(model);
        }}
      />
      <button>Outside</button>
    </>
  );
}
it("shows model identity on the trigger, retains routing-provider identity in the selector, and passes through catalog choices", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const catalog: ModelChoice[] = [
    { ...models[0], model: "anthropic/claude-sonnet-5", label: "Sonnet 5" },
    { ...models[1], model: "qwen/qwen3.8-flash", label: "Qwen Flash" },
  ];
  const view = render(
    <ModelCatalogPicker
      models={catalog}
      label="Model"
      value="a"
      disabled={false}
      onChange={change}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(within(trigger).getByRole("img", { name: "Claude model" })).toBeTruthy();
  expect(within(trigger).queryByRole("img", { name: "openrouter provider" })).toBeNull();
  await user.click(trigger);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getAllByRole("img", { name: "openrouter provider" })).toHaveLength(3);
  expect(within(dialog).queryByRole("img", { name: "Claude model" })).toBeNull();
  await user.type(screen.getByLabelText("Search models"), "qwen");
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenCalledExactlyOnceWith(catalog[1]);
  expect(document.activeElement).toBe(trigger);
  view.rerender(
    <ModelCatalogPicker
      models={catalog}
      label="Model"
      value="b"
      disabled={false}
      onChange={change}
    />,
  );
  expect(within(trigger).getByRole("img", { name: "Qwen model" })).toBeTruthy();
});
it("uses a neutral trigger for unknown or missing selections even when the label names a brand", () => {
  const catalog = [{ ...models[0], model: "unknown/unlisted", label: "Claude-like model" }];
  const view = render(
    <ModelCatalogPicker
      models={catalog}
      label="Model"
      value="a"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(within(trigger).getByRole("img", { name: "Model" }).querySelector("img")).toBeNull();
  expect(within(trigger).queryByRole("img", { name: "Claude model" })).toBeNull();
  view.rerender(
    <ModelCatalogPicker
      models={catalog}
      label="Model"
      value="removed"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(trigger.getAttribute("aria-invalid")).toBe("true");
  expect(within(trigger).getByRole("img", { name: "Model" })).toBeTruthy();
});
it("presents concise catalog names for search, keyboard selection, and favorites without changing identity", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const catalog: ModelChoice[] = [
    { ...models[0], model: "qwen/qwen3.8-flash", label: "Qwen: Qwen3.8 Flash" },
    {
      ...models[1],
      model: "deepseek/deepseek-v4-flash-0731",
      label: "DeepSeek: DeepSeek V4 Flash 0731",
    },
  ];
  const view = render(
    <ModelCatalogPicker
      models={catalog}
      label="Model"
      value="a"
      disabled={false}
      onChange={change}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(trigger.textContent).toBe("Qwen3.8 Flash");
  await user.click(trigger);
  expect(screen.getByRole("gridcell", { name: "Qwen3.8 Flash" })).toBeTruthy();
  expect(screen.queryByText("Qwen: Qwen3.8 Flash")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Add DeepSeek V4 Flash 0731 to favorites" }));
  await user.click(screen.getByRole("button", { name: "Favorites" }));
  expect(screen.getByRole("gridcell", { name: "DeepSeek V4 Flash 0731" })).toBeTruthy();
  await user.type(screen.getByLabelText("Search models"), "deepseek 0731");
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenCalledExactlyOnceWith(catalog[1]);
  expect(catalog[1].label).toBe("DeepSeek: DeepSeek V4 Flash 0731");
  expect(document.activeElement).toBe(trigger);
  view.rerender(
    <ModelCatalogPicker
      models={catalog}
      label="Model"
      value="b"
      disabled={false}
      onChange={change}
    />,
  );
  expect(trigger.textContent).toBe("DeepSeek V4 Flash 0731");
});
it("keeps favorite toggles keyboard-accessible and independent of model selection", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<Controlled change={change} />);
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const star = screen.getByRole("button", { name: "Add Model A to favorites" });
  await user.tab();
  expect(document.activeElement).toBe(star);
  await user.keyboard(" ");
  expect(star.getAttribute("aria-pressed")).toBe("true");
  expect(star.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  await user.keyboard("{Enter}");
  expect(star.getAttribute("aria-pressed")).toBe("false");
  expect(star.querySelector("svg")?.getAttribute("fill")).toBe("none");
  expect(document.activeElement).toBe(star);
  expect(change).not.toHaveBeenCalled();
});
it("searches the supplied catalog across providers and supports keyboard commit, Escape, and outside dismissal", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<Controlled change={change} />);
  const trigger = screen.getByRole("combobox", { name: "Model" });
  await user.click(trigger);
  const search = screen.getByRole("combobox", { name: "Search models" });
  expect(document.activeElement).toBe(search);
  expect(screen.queryByRole("gridcell", { name: "Model C" })).toBeNull();
  await user.type(search, "openai model c");
  expect(screen.getAllByRole("row")).toHaveLength(1);
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenCalledWith(models[2]);
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{ArrowUp}");
  await user.type(screen.getByLabelText("Search models"), "missing");
  expect(screen.getByRole("status").textContent).toBe("No models found");
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(trigger);
  expect(change).toHaveBeenCalledOnce();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("favorites persist across remounts, don't select models, and never reintroduce removed catalog models", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const view = render(<Controlled change={change} />);
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("button", { name: "Add Model B to favorites" }));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty("value", "a");
  view.unmount();
  const next = render(
    <ModelCatalogPicker
      models={models}
      label="Model"
      value="a"
      disabled={false}
      onChange={change}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("button", { name: "Favorites" }));
  expect(screen.getAllByRole("row")).toHaveLength(1);
  expect(screen.getByRole("gridcell", { name: "Model B" })).toBeTruthy();
  next.rerender(
    <ModelCatalogPicker
      models={[models[0]]}
      label="Model"
      value="a"
      disabled={false}
      onChange={change}
    />,
  );
  expect(screen.queryByRole("gridcell", { name: "Model B" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("No favorites yet");
  expect(change).not.toHaveBeenCalled();
});
it("keeps keyboard focus when removing a favorite and supports independent preference scopes", async () => {
  const user = userEvent.setup();
  const view = render(
    <ModelCatalogPicker
      models={models}
      label="Model"
      value="a"
      disabled={false}
      favoritesScope="first"
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("button", { name: "Add Model A to favorites" }));
  await user.click(screen.getByRole("button", { name: "Favorites" }));
  await user.click(screen.getByRole("button", { name: "Remove Model A from favorites" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Search models"));
  expect(screen.getByRole("status").textContent).toBe("No favorites yet");
  await user.click(screen.getByRole("button", { name: "OpenRouter" }));
  await user.click(screen.getByRole("button", { name: "Add Model B to favorites" }));
  view.rerender(
    <ModelCatalogPicker
      models={models}
      label="Model"
      value="a"
      disabled={false}
      favoritesScope="second"
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Favorites" }));
  expect(screen.queryByRole("row")).toBeNull();
});
it("never selects stale rows during loading/error/disconnection or unsupported efforts", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const view = render(
    <ModelCatalogPicker
      models={models}
      label="Model"
      value="a"
      disabled={false}
      onChange={change}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("gridcell", { name: "Unavailable" }));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Add Unavailable to favorites" })).toHaveProperty(
    "disabled",
    true,
  );
  for (const status of ["loading", "error", "disconnected"] as const) {
    view.rerender(
      <ModelCatalogPicker
        models={models}
        label="Model"
        value="a"
        disabled={false}
        status={status}
        onChange={change}
      />,
    );
    expect(screen.queryByRole("row")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(change).not.toHaveBeenCalled();
  }
  view.rerender(
    <ModelCatalogPicker models={models} label="Model" value="a" disabled onChange={change} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("keeps favorites usable when browser preference storage is unavailable", async () => {
  const user = userEvent.setup();
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("unavailable");
  });
  try {
    render(<Controlled />);
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(screen.getByRole("button", { name: "Add Model B to favorites" }));
    await user.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getByRole("gridcell", { name: "Model B" })).toBeTruthy();
  } finally {
    storage.mockRestore();
  }
});
it("keeps a supported effort when switching models and renders only the model's supported effort catalog", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <ModelPicker
      models={models}
      selection={{ modelId: "a", effort: "high" }}
      onSelection={change}
      disabled={false}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Repo agent model" }));
  await user.click(screen.getByRole("gridcell", { name: "Model B" }));
  expect(change).toHaveBeenCalledWith({ modelId: "b", effort: "high" });
  await user.click(screen.getByRole("combobox", { name: "Repo agent effort" }));
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  expect(screen.queryByRole("option", { name: "Ultra" })).toBeNull();
});
it("shows permissions as server status with no invented selectable modes and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const view = render(<PermissionsMenu executionEnabled={false} />);
  const trigger = screen.getByRole("button", { name: "Permissions, Runs disabled" });
  await user.click(trigger);
  expect(screen.getByRole("status").textContent).toContain("Runs disabled");
  expect(screen.queryByRole("row")).toBeNull();
  expect(screen.queryByText("Full access")).toBeNull();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  view.rerender(<PermissionsMenu executionEnabled={null} />);
  expect(screen.getByRole("button", { name: "Permissions, Permissions unavailable" })).toBe(
    trigger,
  );
  fireEvent.click(trigger);
  expect(screen.getByRole("status").textContent).toContain("Permissions unavailable");
  view.rerender(<PermissionsMenu executionEnabled={true} />);
  expect(screen.getByRole("button", { name: "Permissions, Runs enabled" })).toBe(trigger);
  expect(screen.getByRole("status").textContent).toContain("Runs enabled");
});
