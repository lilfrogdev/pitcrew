import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { LocalRecognition } from "./useDictation";

class Recognition implements LocalRecognition {
  static instances: Recognition[] = [];
  static available = vi.fn().mockResolvedValue("available");
  static install = vi.fn().mockResolvedValue(true);
  declare processLocally: boolean;
  lang = "";
  continuous = false;
  interimResults = true;
  onstart: LocalRecognition["onstart"] = null;
  onend: LocalRecognition["onend"] = null;
  onerror: LocalRecognition["onerror"] = null;
  onresult: LocalRecognition["onresult"] = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    Recognition.instances.push(this);
  }
}
Object.defineProperty(Recognition.prototype, "processLocally", { value: false, writable: true });
beforeEach(() => {
  Recognition.instances = [];
  Recognition.available = vi.fn().mockResolvedValue("available");
  Recognition.install = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("SpeechRecognition", Recognition);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function mount() {
  const api = createFixtureApi();
  api.send = vi.fn(api.send);
  const view = render(<App api={api} demo />);
  await screen.findByText("Show the work behind a change, from delegation to review.");
  return { api, view };
}
async function start() {
  fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
  await waitFor(() => expect(Recognition.instances).toHaveLength(1));
  return Recognition.instances[0];
}
function result(recognition: Recognition, transcript: string, isFinal = true) {
  act(() => recognition.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] }));
}
it("keeps a simple composer and compact attachments above the draft", async () => {
  await mount();
  expect(screen.queryByText("Repository model defaults")).toBeNull();
  expect(screen.queryByText("Attachments", { exact: true })).toBeNull();
  expect(screen.queryByText(/Enter to send|Send queues a repository agent reply/)).toBeNull();
  expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Repo agent model" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Repo agent effort" })).toBeTruthy();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  fireEvent.change(screen.getByLabelText("Choose attachments"), {
    target: {
      files: [
        new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "fixture.png", {
          type: "image/png",
        }),
      ],
    },
  });
  const image = await screen.findByAltText("Preview of fixture.png");
  const textarea = screen.getByLabelText("Message your crew");
  expect(image.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove fixture.png" })).toBeTruthy();
});
it("starts only on click, forces local processing, appends editable final text once and never sends", async () => {
  const { api } = await mount();
  expect(Recognition.available).not.toHaveBeenCalled();
  expect(Recognition.instances).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Existing draft" },
  });
  const recognition = await start();
  expect(recognition.processLocally).toBe(true);
  expect(recognition.start).toHaveBeenCalledTimes(1);
  expect(Recognition.available).toHaveBeenCalledWith({
    langs: [navigator.language],
    processLocally: true,
    quality: "dictation",
  });
  result(recognition, "interim", false);
  expect(screen.getByLabelText("Message your crew")).toHaveProperty("value", "Existing draft");
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Edited draft" },
  });
  result(recognition, "dictated words");
  result(recognition, "dictated words");
  expect(screen.getByLabelText("Message your crew")).toHaveProperty(
    "value",
    "Edited draft dictated words",
  );
  fireEvent.keyDown(screen.getByLabelText("Message your crew"), { key: "Enter" });
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
  expect(api.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
  expect(recognition.stop).toHaveBeenCalledTimes(1);
  act(() => recognition.onend?.());
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false);
  expect(api.send).not.toHaveBeenCalled();
});
it("cancels an active session on thread switch and rejects late results", async () => {
  await mount();
  const recognition = await start();
  const late = recognition.onresult!;
  result(recognition, "Thread A draft");
  fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  expect(recognition.abort).toHaveBeenCalledTimes(1);
  act(() =>
    late({
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: "Thread A draft" } },
        { isFinal: true, 0: { transcript: "late words" } },
      ],
    }),
  );
  expect(screen.getByLabelText("Message your crew")).toHaveProperty("value", "");
  fireEvent.click(screen.getByRole("button", { name: "Make agent work visible" }));
  expect(screen.getByLabelText("Message your crew")).toHaveProperty("value", "Thread A draft");
});
it("does not start after a pending capability check loses its originating thread", async () => {
  let resolve!: (value: string) => void;
  Recognition.available = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
  fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await act(async () => resolve("available"));
  expect(Recognition.instances).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Dictate message" })).toBeTruthy();
});
it("aborts when leaving Work or unmounting, without clearing the editable draft", async () => {
  const { view } = await mount();
  const recognition = await start();
  result(recognition, "Keep words");
  fireEvent.click(screen.getByRole("button", { name: "Account" }));
  expect(recognition.abort).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  expect(screen.getByLabelText("Message your crew")).toHaveProperty("value", "Keep words");
  const next = await start();
  view.unmount();
  expect(next.abort).toHaveBeenCalledTimes(1);
});
it("reports microphone denial without remote fallback or draft loss", async () => {
  const { api } = await mount();
  fireEvent.change(screen.getByLabelText("Message your crew"), { target: { value: "Keep draft" } });
  const recognition = await start();
  act(() => recognition.onerror?.({ error: "not-allowed" }));
  expect(screen.getByRole("alert").textContent).toContain("Microphone permission was denied");
  expect(recognition.abort).toHaveBeenCalledTimes(1);
  expect(recognition.processLocally).toBe(true);
  expect(screen.getByLabelText("Message your crew")).toHaveProperty("value", "Keep draft");
  expect(api.send).not.toHaveBeenCalled();
});
it("offers an explicit language download, never starts after installation until another mic click", async () => {
  Recognition.available.mockResolvedValue("downloadable");
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
  const download = await screen.findByRole("button", { name: "Download dictation language" });
  expect(Recognition.install).not.toHaveBeenCalled();
  expect(Recognition.instances).toHaveLength(0);
  fireEvent.click(download);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Download dictation language" })).toBeNull(),
  );
  expect(Recognition.install).toHaveBeenCalledWith({
    langs: [navigator.language],
    processLocally: true,
    quality: "dictation",
  });
  expect(Recognition.instances).toHaveLength(0);
  Recognition.available.mockResolvedValue("available");
  await start();
});
it("refuses a browser with only remote recognition capability", async () => {
  class RemoteRecognition {
    start = vi.fn();
  }
  vi.stubGlobal("SpeechRecognition", RemoteRecognition);
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
  expect(screen.getByRole("alert").textContent).toContain("On-device dictation is unavailable");
  expect(Recognition.instances).toHaveLength(0);
  expect(Recognition.available).not.toHaveBeenCalled();
});
