import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Repositories } from "./Repositories";
import type { RepositoryApi } from "./repository-api";
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);
function fixture(): RepositoryApi {
  return {
    list: vi.fn(async () => ({
      repositories: [
        { name: "pitcrew", lifecycle: "external" as const, deletable: false },
        { name: "sandbox", lifecycle: "ready" as const, deletable: true },
      ],
      cursor: null,
    })),
    provision: vi.fn(async ({ name }) => ({ name, status: "ready" })),
    reconcile: vi.fn(),
    remove: vi.fn(),
  };
}
it("shows backend unavailability without fabricated repositories", async () => {
  render(<Repositories />);
  expect(screen.getByRole("alert").textContent).toContain("unavailable");
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("No cloud repositories found.")).toBeNull();
});
it("requires explicit credential consent before creating and preserves empty/read-only disclosure", async () => {
  const api = fixture(),
    user = userEvent.setup();
  render(<Repositories api={api} />);
  await screen.findByText("sandbox");
  await user.click(screen.getByRole("button", { name: "Create" }));
  await user.type(screen.getByLabelText("Repository name"), "new-repo");
  const submit = screen.getByRole("button", { name: "Create repository" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(screen.getByText(/platform-defined scope and expiry/).textContent).toContain("read-only");
  await user.click(screen.getByRole("checkbox"));
  await user.click(submit);
  await waitFor(() =>
    expect(api.provision).toHaveBeenCalledWith({
      name: "new-repo",
      operation: "create",
      credentialConsent: true,
    }),
  );
  expect(screen.getByRole("status").textContent).toContain("new-repo: ready");
});
it("never deletes on opening/cancel and requires the exact selected name", async () => {
  const api = fixture(),
    user = userEvent.setup();
  render(<Repositories api={api} />);
  await screen.findByText("sandbox");
  expect(
    (screen.getByRole("button", { name: "Delete pitcrew" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Delete sandbox" }));
  expect(api.remove).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("permanently deletes");
  const input = screen.getByLabelText("Type sandbox to confirm");
  const remove = screen.getByRole("button", { name: "Delete repository" }) as HTMLButtonElement;
  await user.type(input, "Sandbox");
  expect(remove.disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete sandbox" }));
  await user.type(screen.getByLabelText("Type sandbox to confirm"), "sandbox");
  await user.click(screen.getByRole("button", { name: "Delete repository" }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledExactlyOnceWith("sandbox", "sandbox"));
});
it("shows failed deletion inside the confirmation dialog and keeps its selected target", async () => {
  const api = fixture(),
    user = userEvent.setup();
  api.remove = vi.fn(async () => {
    throw Error("Deletion failed");
  });
  render(<Repositories api={api} />);
  await screen.findByText("sandbox");
  await user.click(screen.getByRole("button", { name: "Delete sandbox" }));
  await user.type(screen.getByLabelText("Type sandbox to confirm"), "sandbox");
  await user.click(screen.getByRole("button", { name: "Delete repository" }));
  await screen.findByText("Deletion failed");
  expect(screen.getByRole("dialog").textContent).toContain("sandbox");
});
it("retries the initial list failure without remounting or enabling mutations prematurely", async () => {
  const api = fixture(),
    user = userEvent.setup();
  const list = vi.fn(api.list).mockRejectedValueOnce(Error("Temporary outage"));
  api.list = list;
  render(<Repositories api={api} />);
  await screen.findByText("Temporary outage");
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  const refresh = screen.getByRole("button", { name: "Refresh repositories" }) as HTMLButtonElement;
  expect(refresh.disabled).toBe(false);
  await user.click(refresh);
  await screen.findByText("sandbox");
  expect(list).toHaveBeenCalledTimes(2);
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
it("shows an actionable import failure and refreshes its quarantined metadata", async () => {
  const api = fixture(),
    user = userEvent.setup();
  api.provision = vi.fn(async () => {
    throw Error("Only public repositories are supported");
  });
  render(<Repositories api={api} />);
  await screen.findByText("sandbox");
  await user.click(screen.getByRole("button", { name: "Import" }));
  await user.type(screen.getByLabelText("Repository name"), "failed-import");
  await user.type(screen.getByLabelText("Public GitHub HTTPS URL"), "https://github.com/a/b");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Import repository" }));
  await screen.findByText("Only public repositories are supported");
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("Repository name").getAttribute("value")).toBe("failed-import");
});
