import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { LandingCapabilities } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
async function mount() {
  const api = createFixtureApi();
  api.send = vi.fn(api.send);
  render(<App api={api} demo />);
  await screen.findByText("Show the work behind a change, from delegation to review.");
  return api;
}
it("sends Enter once, preserves Shift+Enter and ignores IME composition", async () => {
  const api = await mount();
  const textarea = screen.getByLabelText("Message your crew");
  fireEvent.change(textarea, { target: { value: "Keyboard change" } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
  expect(api.send).not.toHaveBeenCalled();
  fireEvent.keyDown(textarea, { key: "Enter" });
  fireEvent.keyDown(textarea, { key: "Enter" });
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
});
it("keeps over-limit prompt text intact and blocks send", async () => {
  const api = await mount();
  const textarea = screen.getByLabelText("Message your crew") as HTMLTextAreaElement;
  const text = "x".repeat(8001);
  fireEvent.change(textarea, { target: { value: text } });
  expect(textarea.value).toBe(text);
  expect(screen.getByRole("alert").textContent).toContain("nothing has been truncated");
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(api.send).not.toHaveBeenCalled();
});
it("preserves removable attachment previews across threads and sends exact text", async () => {
  const api = await mount();
  const user = userEvent.setup();
  const file = new File(["Synthetic attachment\n<script>untrusted</script>"], "design.md", {
    type: "text/plain",
  });
  await user.upload(screen.getByLabelText("Choose attachments"), file);
  await screen.findByRole("button", { name: "Remove design.md" });
  await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  expect(screen.queryByRole("button", { name: "Remove design.md" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Make agent work visible" }));
  await screen.findByRole("button", { name: "Remove design.md" });
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Use reference" },
  });
  fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.send).mock.calls[0][3]?.[0]).toMatchObject({
    name: "design.md",
    text: "Synthetic attachment\n<script>untrusted</script>",
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Remove design.md" })).toBeNull(),
  );
});
it("retains failed attachments and retry identity until bytes change", async () => {
  const api = await mount();
  api.send = vi.fn().mockRejectedValue(Error("Offline fixture"));
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["Original"], "notes.txt"),
  );
  await screen.findByRole("button", { name: "Remove notes.txt" });
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Submit files" },
  });
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Offline fixture");
  const first = vi.mocked(api.send).mock.calls[0];
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[1][2]).toBe(first[2]);
  await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[2][2]).not.toBe(first[2]);
});
it("rejects binary/invalid UTF-8 data visibly without silently sending it", async () => {
  const api = await mount();
  fireEvent.change(screen.getByLabelText("Choose attachments"), {
    target: { files: [new File([new Uint8Array([0xff, 0x00])], "bad.txt")] },
  });
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Try invalid" },
  });
  fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
  expect(api.send).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove bad.txt" })));
});
it("retains image previews when a model becomes incompatible and delivers native image bytes on send", async () => {
  const api = await mount();
  const user = userEvent.setup();
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File([bytes], "preview.png", { type: "image/png" }),
  );
  await screen.findByAltText("Preview of preview.png");
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Inspect synthetic image" },
  });
  await user.click(screen.getByRole("combobox", { name: "Repo agent model" }));
  await user.click(screen.getByRole("option", { name: "Fixture text (synthetic)" }));
  await screen.findByText(/Images are not supported by all selected agents/);
  expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByAltText("Preview of preview.png")).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "Repo agent model" }));
  await user.click(screen.getByRole("option", { name: "Fixture vision (synthetic)" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  await user.click(screen.getByRole("combobox", { name: "Repo agent effort" }));
  await user.click(screen.getByRole("option", { name: "High" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  const call = vi.mocked(api.send).mock.calls[0];
  expect(call[3]?.[0]).toMatchObject({ mediaType: "image/png", data });
  expect(call[4]).toEqual({ modelId: "fixture", effort: "high" });
  await screen.findByText("preview.png · Attached image");
});

it("does not leak a delayed model preference failure into another thread", async () => {
  const api = await mount();
  let reject!: (cause: Error) => void;
  api.setThreadModelSelection = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<NonNullable<typeof api.setThreadModelSelection>>>>(
        (_resolve, failure) => {
          reject = failure;
        },
      ),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Repo agent effort" }));
  fireEvent.click(screen.getByRole("option", { name: "High" }));
  await waitFor(() => expect(api.setThreadModelSelection).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  await act(async () => {
    reject(Error("delayed preference failure"));
  });
  expect(screen.queryByText(/Model preference was not saved/)).toBeNull();
  expect(screen.queryByText(/delayed preference failure/)).toBeNull();
});

it.each(["missing", "failed", "no-conversation"] as const)(
  "keeps %s composer capabilities text-only and blocks dropped images before submission",
  async (mode) => {
    const api = createFixtureApi();
    const capabilities = await api.capabilities();
    api.capabilities = vi.fn(async () => {
      if (mode === "failed") throw new Error("Capabilities unavailable");
      return {
        ...capabilities,
        composer:
          mode === "missing" ? undefined : { ...capabilities.composer!, conversation: false },
      };
    });
    api.send = vi.fn(api.send);
    render(<App api={api} demo />);
    await screen.findByText("Show the work behind a change, from delegation to review.");
    const input = screen.getByLabelText("Choose attachments");
    expect(input.getAttribute("accept")).toContain(".md");
    expect(input.getAttribute("accept")).not.toContain(".png");
    expect(screen.getByRole("button", { name: "Attach files" }).title).toContain(
      "Images are unavailable",
    );
    fireEvent.change(screen.getByLabelText("Message your crew"), {
      target: { value: "Preserve this draft" },
    });
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const image = new File(
      [Uint8Array.from(atob(data), (char) => char.charCodeAt(0))],
      "drop.png",
      {
        type: "image/png",
      },
    );
    fireEvent.drop(screen.getByLabelText("Message your crew").closest("form")!, {
      dataTransfer: { files: [image] },
    });
    await screen.findByText(/Images are not supported by all selected agents/);
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
    expect(api.send).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Preserve this draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove drop.png" }));
    const user = userEvent.setup();
    await user.upload(input, new File(["Text reference"], "reference.md", { type: "text/plain" }));
    await waitFor(() =>
      expect(screen.getByText("Text reference").textContent).toBe("Text reference"),
    );
    fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
    expect(api.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Set up a provider" })).toBeTruthy();
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Preserve this draft",
    );
    expect(screen.getByText("Text reference")).toBeTruthy();
  },
);

it("offers images only after conversation capabilities are confirmed", async () => {
  const api = createFixtureApi();
  const capabilities = await api.capabilities();
  let resolve!: (capabilities: LandingCapabilities) => void;
  api.capabilities = vi.fn(() => new Promise<LandingCapabilities>((ready) => (resolve = ready)));
  render(<App api={api} demo />);
  await screen.findByText("Show the work behind a change, from delegation to review.");
  expect(screen.getByLabelText("Choose attachments").getAttribute("accept")).not.toContain(".png");
  await act(async () => resolve(capabilities));
  expect(screen.getByLabelText("Choose attachments").getAttribute("accept")).toContain(".png");
  expect(screen.getByRole("button", { name: "Attach files" }).title).toContain("Static PNG/JPEG");
});
