import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { OpenRouterConnection } from "./OpenRouterConnection";
afterEach(cleanup);
const ready = { available: true, configured: false, executionEnabled: false };
it("requires explicit storage approval, masks and clears synthetic input, and returns only status", async () => {
  const store = vi.fn().mockResolvedValue({ ...ready, configured: true });
  render(<OpenRouterConnection api={{ status: async () => ready, store }} />);
  fireEvent.click(screen.getByRole("button", { name: "OpenRouter · Connect" }));
  const field = await screen.findByLabelText("OpenRouter API key");
  expect(field.getAttribute("type")).toBe("password");
  fireEvent.change(field, { target: { value: "synthetic-not-a-credential" } });
  fireEvent.submit(field.closest("form")!);
  expect(store).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.submit(field.closest("form")!);
  expect((field as HTMLInputElement).value).toBe("");
  await waitFor(() => expect(store).toHaveBeenCalledOnce());
  expect(screen.getByText("Key stored. Cloud execution is awaiting backend setup.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("synthetic");
});
it("fails closed when the reviewed local controller is unavailable", async () => {
  const store = vi.fn();
  render(
    <OpenRouterConnection
      api={{
        status: async () => {
          throw Error("unavailable");
        },
        store,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "OpenRouter · Connect" }));
  expect(await screen.findByText(/Secure local setup is unavailable/)).toBeTruthy();
  expect(screen.queryByLabelText("OpenRouter API key")).toBeNull();
  expect(store).not.toHaveBeenCalled();
});
it("clears input and sanitizes controller errors without reflecting secrets", async () => {
  const store = vi.fn().mockRejectedValue(Error("synthetic-raw-command-error"));
  render(<OpenRouterConnection api={{ status: async () => ready, store }} />);
  fireEvent.click(screen.getByRole("button", { name: "OpenRouter · Connect" }));
  const field = await screen.findByLabelText("OpenRouter API key");
  fireEvent.change(field, { target: { value: "synthetic-not-a-credential" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.submit(field.closest("form")!);
  await screen.findByText("Could not store the key. Enter it again to retry.");
  expect((field as HTMLInputElement).value).toBe("");
  expect(document.body.textContent).not.toContain("synthetic");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
});
it("clears synthetic input when closed or unmounted", async () => {
  const api = { status: async () => ready, store: vi.fn() };
  const view = render(<OpenRouterConnection api={api} />);
  fireEvent.click(screen.getByRole("button", { name: "OpenRouter · Connect" }));
  const field = (await screen.findByLabelText("OpenRouter API key")) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(field.value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "OpenRouter · Connect" }));
  const reopened = screen.getByLabelText("OpenRouter API key") as HTMLInputElement;
  fireEvent.change(reopened, { target: { value: "synthetic" } });
  view.unmount();
  expect(reopened.value).toBe("");
  expect(api.store).not.toHaveBeenCalled();
});
