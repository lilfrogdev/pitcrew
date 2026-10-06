import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
afterEach(() => {
  cleanup();
  localStorage.clear();
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
