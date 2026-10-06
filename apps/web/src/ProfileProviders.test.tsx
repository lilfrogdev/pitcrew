import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ProfileProviders } from "./ProfileProviders";
afterEach(cleanup);
const ready = {
  available: true,
  storageAvailable: true,
  configured: false,
  executionEnabled: false,
};
const fixture = () => ({
  status: vi.fn(async () => ready),
  store: vi.fn().mockResolvedValue({ ...ready, configured: true }),
  remove: vi.fn().mockResolvedValue(ready),
});
it("saves and replaces a masked key with an ordinary Save action and no redundant consent", async () => {
  const api = fixture();
  render(<ProfileProviders api={api} />);
  const field = screen.getByLabelText("API key") as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  expect(field.type).toBe("password");
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.change(field, { target: { value: "synthetic-not-a-credential" } });
  fireEvent.submit(field.closest("form")!);
  expect(field.value).toBe("");
  await screen.findByText("Saved");
  expect(api.store).toHaveBeenCalledWith("synthetic-not-a-credential");
  expect(field.placeholder).toBe("Replace API key");
  expect(document.body.textContent).not.toContain("synthetic");
});
it("removes through an explicit ordinary action without transmitting typed text", async () => {
  const api = fixture();
  render(<ProfileProviders api={api} />);
  const field = screen.getByLabelText("API key") as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: "synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(field.value).toBe("");
  await screen.findByText("Removed");
  expect(api.remove).toHaveBeenCalledWith();
  expect(api.store).not.toHaveBeenCalled();
});
it("does not claim saving works merely because the route is available", async () => {
  const api = { ...fixture(), status: vi.fn(async () => ({ ...ready, storageAvailable: false })) };
  render(<ProfileProviders api={api} />);
  await waitFor(() => expect(api.status).toHaveBeenCalled());
  expect(screen.queryByText("Stored in your Pitcrew Cloudflare Worker.")).toBeNull();
  expect(
    screen.queryByText("Saving is unavailable until local provider access is enabled."),
  ).toBeNull();
  expect((screen.getByLabelText("API key") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
  expect(api.store).not.toHaveBeenCalled();
});
it("clears synthetic input on failure and unmount without reflecting diagnostics", async () => {
  const api = {
    ...fixture(),
    store: vi.fn().mockRejectedValue(Error("synthetic-sensitive-diagnostic")),
  };
  const view = render(<ProfileProviders api={api} />);
  const field = screen.getByLabelText("API key") as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: "synthetic" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByText("Could not save API key. Try again.");
  expect(field.value).toBe("");
  expect(document.body.textContent).not.toContain("synthetic");
  fireEvent.change(field, { target: { value: "synthetic" } });
  view.unmount();
  expect(field.value).toBe("");
});
