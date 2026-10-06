import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("allows selecting and reloading display models while Send and server execution preferences stay disabled", async () => {
  const api = createFixtureApi();
  const native = await api.capabilities();
  const models = [
    {
      id: "default",
      label: "Qwen display",
      provider: "openrouter",
      model: "qwen/qwen3.8-flash",
      efforts: ["off" as const],
      contextWindow: 1000000,
    },
    {
      id: "deepseek",
      label: "DeepSeek display",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      efforts: ["off" as const, "high" as const],
      contextWindow: 1048576,
    },
  ];
  api.capabilities = vi.fn(async () => ({
    ...native,
    composer: {
      models,
      conversation: false,
      displayOnly: true,
      executionEnabled: false,
      catalogRevision: "a".repeat(64),
      settings: { default: { modelId: "default", effort: "off" as const } },
    },
  }));
  api.send = vi.fn(api.send);
  api.setThreadModelSelection = vi.fn(api.setThreadModelSelection);
  const user = userEvent.setup();
  render(<App api={api} />);
  await user.click(await screen.findByRole("combobox", { name: "Repo agent model" }));
  await user.click(screen.getByRole("gridcell", { name: "DeepSeek display" }));
  await user.type(screen.getByLabelText("Message your crew"), "A retained draft");
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
  fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
  expect(api.send).not.toHaveBeenCalled();
  expect(api.setThreadModelSelection).not.toHaveBeenCalled();
  expect(screen.queryByText("Execution is disabled.")).toBeNull();
  expect(screen.getByRole("button", { name: "Permissions, Runs disabled" })).toBeTruthy();
  cleanup();
  render(<App api={api} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Repo agent model" })).toHaveProperty(
      "textContent",
      "DeepSeek display",
    ),
  );
  expect(api.send).not.toHaveBeenCalled();
});
it.each([
  "missing",
  "failed",
  "empty",
  "unsupported",
  "disabled",
  "fixture",
  "pitcrew-fixture",
] as const)(
  "requires setup for %s capabilities and guards direct submissions while retaining drafts",
  async (mode) => {
    const api = createFixtureApi();
    const capabilities = await api.capabilities();
    api.capabilities = vi.fn(async () => {
      if (mode === "failed") throw Error("Offline");
      return {
        ...capabilities,
        composer:
          mode === "missing"
            ? undefined
            : {
                ...capabilities.composer!,
                conversation: mode !== "disabled",
                models:
                  mode === "empty"
                    ? []
                    : mode === "unsupported"
                      ? capabilities.composer!.models.map((model) => ({ ...model, efforts: [] }))
                      : mode === "pitcrew-fixture"
                        ? capabilities.composer!.models.map((model) => ({
                            ...model,
                            provider: "pitcrew-fixture",
                          }))
                        : capabilities.composer!.models,
              },
      };
    });
    api.send = vi.fn(api.send);
    const user = userEvent.setup();
    render(<App api={api} demo={mode !== "fixture" && mode !== "pitcrew-fixture"} />);
    const setup = await screen.findByRole("button", { name: "Set up a provider" });
    await screen.findByRole("heading", { name: "Make agent work visible" });
    const composer = screen.getByLabelText("Message your crew") as HTMLTextAreaElement;
    await user.type(composer, "Retain this draft");
    expect(screen.queryByRole("combobox", { name: "Repo agent model" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    fireEvent.submit(composer.closest("form")!);
    expect(api.send).not.toHaveBeenCalled();
    setup.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Providers", level: 1 })).toBeTruthy();
    expect(document.activeElement?.id).toBe("workspace-content");
    expect(screen.queryByText("Stored in your Pitcrew Cloudflare Worker.")).toBeNull();
    expect(
      screen.queryByText("Saving is unavailable until local provider access is enabled."),
    ).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    for (let index = 0; index < 2; index++) {
      await user.click(within(rail).getByRole("button", { name: "Work" }));
      expect(screen.getByLabelText("Message your crew")).toBe(composer);
      expect(composer.value).toBe("Retain this draft");
      await user.click(screen.getByRole("button", { name: "Set up a provider" }));
      expect(screen.getByRole("heading", { name: "Providers", level: 1 })).toBeTruthy();
    }
    expect(api.send).not.toHaveBeenCalled();
  },
);
it("refreshes capabilities after setup and removal without treating a saved key as usable execution", async () => {
  const api = createFixtureApi();
  const connected = await api.capabilities();
  let available = false;
  const ready = {
    available: true,
    storageAvailable: true,
    configured: false,
    executionEnabled: false,
  };
  api.openrouter = {
    status: vi.fn(async () => ready),
    store: vi.fn(async () => ({ ...ready, configured: true })),
    remove: vi.fn(async () => {
      available = false;
      return ready;
    }),
  };
  api.capabilities = vi.fn(async () => (available ? connected : { landing: connected.landing }));
  const user = userEvent.setup();
  render(<App api={api} demo />);
  await user.click(await screen.findByRole("button", { name: "Set up a provider" }));
  const field = screen.getByLabelText("API key") as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  await user.type(field, "synthetic");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(field.value).toBe("");
  const rail = screen.getByRole("navigation", { name: "Workspace" });
  await user.click(within(rail).getByRole("button", { name: "Work" }));
  expect(await screen.findByRole("button", { name: "Set up a provider" })).toBeTruthy();
  // Only a subsequent server capability response enables the existing controls.
  available = true;
  await user.click(screen.getByRole("button", { name: "Set up a provider" }));
  await waitFor(() =>
    expect((screen.getByLabelText("API key") as HTMLInputElement).disabled).toBe(false),
  );
  await user.type(screen.getByLabelText("API key"), "synthetic");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  await user.click(within(rail).getByRole("button", { name: "Work" }));
  expect(await screen.findByRole("combobox", { name: "Repo agent model" })).toBeTruthy();
  await user.type(screen.getByLabelText("Message your crew"), "Draft after setup");
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false);
  await user.click(within(rail).getByRole("button", { name: "Profile" }));
  await waitFor(() =>
    expect((screen.getByLabelText("API key") as HTMLInputElement).disabled).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await screen.findByText("Removed");
  await user.click(within(rail).getByRole("button", { name: "Work" }));
  expect(await screen.findByRole("button", { name: "Set up a provider" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Message your crew")).toHaveProperty("value", "Draft after setup");
});
it.each(["store", "remove"] as const)(
  "refreshes capabilities when a delayed provider %s finishes after navigating to Work",
  async (action) => {
    const api = createFixtureApi();
    const connected = await api.capabilities();
    let available = action === "remove";
    const ready = {
      available: true,
      storageAvailable: true,
      configured: available,
      executionEnabled: false,
    };
    let finish!: () => void;
    const pending = () =>
      new Promise<typeof ready>((resolve) => {
        finish = () => {
          available = action === "store";
          resolve({ ...ready, configured: available });
        };
      });
    api.openrouter = {
      status: vi.fn(async () => ready),
      store: vi.fn(pending),
      remove: vi.fn(pending),
    };
    api.capabilities = vi.fn(async () => (available ? connected : { landing: connected.landing }));
    api.send = vi.fn(api.send);
    const user = userEvent.setup();
    render(<App api={api} demo />);
    await screen.findByRole("heading", { name: "Make agent work visible" });
    if (available) await screen.findByRole("combobox", { name: "Repo agent model" });
    else await screen.findByRole("button", { name: "Set up a provider" });
    await user.type(screen.getByLabelText("Message your crew"), "Pending provider draft");
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    await user.click(within(rail).getByRole("button", { name: "Profile" }));
    const field = screen.getByLabelText("API key") as HTMLInputElement;
    await waitFor(() => expect(field.disabled).toBe(false));
    if (action === "store") await user.type(field, "synthetic");
    await user.click(screen.getByRole("button", { name: action === "store" ? "Save" : "Remove" }));
    expect(api.openrouter[action]).toHaveBeenCalledOnce();
    await user.click(within(rail).getByRole("button", { name: "Work" }));
    expect(screen.queryByRole("heading", { name: "Providers", level: 1 })).toBeNull();
    expect(field.value).toBe("");
    const previousRequests = vi.mocked(api.capabilities).mock.calls.length;
    await act(async () => finish());
    await waitFor(() =>
      expect(vi.mocked(api.capabilities).mock.calls.length).toBeGreaterThan(previousRequests),
    );
    if (action === "store") {
      expect(await screen.findByRole("combobox", { name: "Repo agent model" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty(
        "disabled",
        false,
      );
    } else {
      expect(await screen.findByRole("button", { name: "Set up a provider" })).toBeTruthy();
      expect(screen.queryByRole("combobox", { name: "Repo agent model" })).toBeNull();
      expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
      fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
      expect(api.send).not.toHaveBeenCalled();
    }
    expect(screen.getByLabelText("Message your crew")).toHaveProperty(
      "value",
      "Pending provider draft",
    );
  },
);
it("blocks sends while capabilities are loading even with a restored selection", async () => {
  const api = createFixtureApi();
  const capabilities = await api.capabilities();
  let resolve!: (value: typeof capabilities) => void;
  api.capabilities = () =>
    new Promise((done) => {
      resolve = done;
    });
  api.send = vi.fn(api.send);
  render(<App api={api} demo />);
  await screen.findByRole("heading", { name: "Make agent work visible" });
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Waiting draft" },
  });
  fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
  expect(api.send).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox", { name: "Repo agent model" })).toBeNull();
  await act(async () => resolve(capabilities));
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false);
});
