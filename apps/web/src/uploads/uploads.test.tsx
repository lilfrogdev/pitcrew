import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { TEXT_ATTACHMENT_CAPABILITIES, UPLOAD_LIMITS, type UploadReceipt } from "@pitcrew/protocol";
import { UploadDrafts } from "./drafts";
import { uploadInputs } from "./input";
import { App } from "../App";
import { createFixtureApi } from "../fixtures";
import type { AttachmentDraft } from "../Composer";
import type { UploadApi } from "./api";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const receipt = (
  id: string,
  file: File,
  input: UploadReceipt["input"] = "storage",
): UploadReceipt => ({
  uploadId: id,
  name: file.name,
  mediaType: file.type || "application/octet-stream",
  size: file.size,
  input,
  expiresAt: Date.now() + UPLOAD_LIMITS.ttlMs,
});
function harness(api: UploadApi) {
  const rows: Record<string, AttachmentDraft[]> = {};
  const drafts = new UploadDrafts(api, (thread, mutate) => {
    rows[thread] = mutate(rows[thread] ?? []);
  });
  return { rows, drafts };
}
it("keeps the same bytes, thread and ID across failure/retry and makes expiry retryable", async () => {
  vi.useFakeTimers();
  const file = new File(["synthetic"], "notes.txt", { type: "text/plain" });
  const put = vi
    .fn<UploadApi["put"]>()
    .mockRejectedValueOnce(Error("offline"))
    .mockImplementation(async (_thread, id, selected, _signal, progress) => {
      progress(75);
      return { ...receipt(id, selected, "text"), expiresAt: Date.now() + 1000 };
    });
  const api = { put, remove: vi.fn<UploadApi["remove"]>().mockResolvedValue(undefined) };
  const { drafts, rows } = harness(api);
  drafts.add("thread-a", [file], []);
  await vi.advanceTimersByTimeAsync(0);
  expect(rows["thread-a"][0].status).toBe("error");
  const id = rows["thread-a"][0].id;
  drafts.retry(id);
  await vi.advanceTimersByTimeAsync(0);
  expect(put.mock.calls[1].slice(0, 3)).toEqual(["thread-a", id, file]);
  expect(rows["thread-a"][0]).toMatchObject({ status: "ready", progress: 100 });
  await vi.advanceTimersByTimeAsync(1001);
  expect(rows["thread-a"][0]).toMatchObject({
    status: "error",
    error: "Upload expired. Retry to upload it again.",
  });
  drafts.dispose();
  expect(api.remove).toHaveBeenCalledWith("thread-a", id);
});
it("aborts removed files, revokes previews and ignores completion after removal/account disposal", async () => {
  const NativeURL = URL;
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = () => "blob:synthetic";
      static revokeObjectURL = revoke;
    },
  );
  let resolve!: (row: UploadReceipt) => void;
  const put = vi.fn<UploadApi["put"]>(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const api = { put, remove: vi.fn<UploadApi["remove"]>().mockResolvedValue(undefined) };
  const { drafts, rows } = harness(api);
  const file = new File(["synthetic"], "image.png", { type: "image/png" });
  drafts.add("thread-a", [file], []);
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  const id = rows["thread-a"][0].id;
  drafts.dispose();
  rows["thread-a"] = [];
  expect(put.mock.calls[0][3].aborted).toBe(true);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic");
  resolve(receipt(id, file));
  await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(2));
  expect(rows["thread-a"]).toEqual([]);
});
it("accounts for legacy drafts and history before explicitly choosing storage-only inputs", () => {
  const file = new File(["x".repeat(65536)], "notes.txt", { type: "text/plain" });
  const upload = (id: string): AttachmentDraft => ({
    id,
    name: file.name,
    size: file.size,
    status: "ready",
    upload: receipt(id, file, "text"),
  });
  const legacy: AttachmentDraft = {
    id: "legacy",
    name: "legacy.txt",
    status: "ready",
    attachment: {
      id: "legacy",
      name: "legacy.txt",
      mediaType: "text/plain",
      text: "x".repeat(65536),
    },
  };
  const result = uploadInputs(
    [legacy, upload("one"), upload("two")],
    [],
    TEXT_ATTACHMENT_CAPABILITIES,
    true,
  );
  expect(result.slice(1).map((item) => item.modelInput)).toEqual(["text", "storage"]);
  expect(
    uploadInputs(
      [upload("one")],
      [legacy.attachment as never],
      TEXT_ATTACHMENT_CAPABILITIES,
      false,
    )[0].attachment,
  ).toEqual({ uploadId: "one", modelInput: "storage" });
});
it("rejects an entire invalid selection before starting upload work", () => {
  const api = { put: vi.fn<UploadApi["put"]>(), remove: vi.fn<UploadApi["remove"]>() };
  const { drafts, rows } = harness(api);
  expect(() =>
    drafts.add("a", [new File(["ok"], "ok.txt"), new File([], "empty.txt")], []),
  ).toThrow();
  expect(() =>
    drafts.add(
      "a",
      Array.from({ length: 5 }, () => new File(["x"], "a.txt")),
      [],
    ),
  ).toThrow();
  expect(rows).toEqual({});
  expect(api.put).not.toHaveBeenCalled();
});
it("replays an uncertain send unchanged after polling, expiry and sending in another thread", async () => {
  const api = createFixtureApi();
  const capabilities = await api.capabilities();
  api.capabilities = async () => ({ ...capabilities, uploads: UPLOAD_LIMITS });
  api.uploads = {
    put: vi.fn(async (_thread, id, file) => ({
      ...receipt(id, file, "text"),
      expiresAt: Date.now() + 300,
    })),
    remove: vi.fn(async () => {}),
  };
  const read = api.snapshot;
  let committed = false;
  api.snapshot = async (thread) => {
    const snapshot = await read(thread);
    if (thread !== "welcome") return snapshot;
    return {
      ...snapshot,
      messages: [
        ...snapshot.messages,
        {
          id: "history",
          threadId: thread,
          role: "user",
          createdAt: "2026-10-07T00:00:00Z",
          content: "Initial reference",
          attachments: [
            {
              id: "history",
              name: "history.txt",
              mediaType: "text/plain",
              text: "x".repeat(65536),
            },
          ],
        },
        ...(committed
          ? [
              {
                id: "committed",
                threadId: thread,
                role: "user" as const,
                createdAt: "2026-10-07T00:00:01Z",
                content: "Commit observed after lost response",
                attachments: [
                  {
                    id: "committed",
                    name: "synthetic.txt",
                    mediaType: "text/plain" as const,
                    text: "x".repeat(65536),
                  },
                ],
              },
            ]
          : []),
      ],
    };
  };
  api.send = vi
    .fn()
    .mockImplementationOnce(async () => {
      committed = true;
      throw Error("Synthetic response lost");
    })
    .mockResolvedValue(undefined);
  render(<App api={api} demo />);
  await screen.findByText("Initial reference");
  fireEvent.click(screen.getByRole("button", { name: "Agent" }));
  fireEvent.change(screen.getByLabelText("Choose attachments"), {
    target: { files: [new File(["x".repeat(65536)], "synthetic.txt", { type: "text/plain" })] },
  });
  await screen.findByText("Text available to crew");
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Use synthetic reference" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Synthetic response lost");
  const first = vi.mocked(api.send).mock.calls[0];
  fireEvent(window, new Event("online"));
  await screen.findByText("Commit observed after lost response");
  await act(async () => {
    await new Promise((done) => setTimeout(done, 350));
  });
  expect(screen.getByText("Text available to crew")).toBeTruthy();
  expect(screen.queryByText("Upload expired. Retry to upload it again.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Other thread note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Make agent work visible" }));
  await screen.findByText("Text available to crew");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(3));
  expect(vi.mocked(api.send).mock.calls[2]).toEqual(first);
});
it("accepts image/video/PDF/text through one picker, preserves drafts across threads and sends exact input choices", async () => {
  const NativeURL = URL;
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = (file: File) => `blob:${file.name}`;
      static revokeObjectURL = revoke;
    },
  );
  const api = createFixtureApi();
  const capabilities = await api.capabilities();
  api.capabilities = async () => ({ ...capabilities, uploads: UPLOAD_LIMITS });
  api.uploads = {
    put: vi.fn(async (_thread, id, file) =>
      receipt(
        id,
        file,
        file.type === "text/plain" ? "text" : file.type === "image/png" ? "image" : "storage",
      ),
    ),
    remove: vi.fn(async () => {}),
  };
  api.send = vi.fn(async () => {});
  render(<App api={api} demo />);
  await screen.findByText("Show the work behind a change, from delegation to review.");
  fireEvent.click(screen.getByRole("button", { name: "Agent" }));
  const input = screen.getByLabelText("Choose attachments");
  expect(input.hasAttribute("accept")).toBe(false);
  const files = [
    new File(["png"], "synthetic.png", { type: "image/png" }),
    new File(["mp4"], "synthetic.mp4", { type: "video/mp4" }),
    new File(["pdf"], "synthetic.pdf", { type: "application/pdf" }),
    new File(["text"], "synthetic.txt", { type: "text/plain" }),
  ];
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(api.uploads!.put).toHaveBeenCalledTimes(4));
  await screen.findByAltText("Preview of synthetic.png");
  expect(screen.getByLabelText("Preview of synthetic.mp4").tagName).toBe("VIDEO");
  expect(screen.getAllByText("Stored only · crew cannot read this content")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  expect(screen.queryByRole("button", { name: "Remove synthetic.pdf" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Make agent work visible" }));
  await screen.findByRole("button", { name: "Remove synthetic.pdf" });
  fireEvent.click(screen.getByRole("button", { name: "Remove synthetic.pdf" }));
  expect(api.uploads.remove).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Message your crew"), {
    target: { value: "Use synthetic files" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
  const choices = vi.mocked(api.send).mock.calls[0][3];
  expect(choices?.map((item) => "uploadId" in item && item.modelInput)).toEqual([
    "image",
    "storage",
    "text",
  ]);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Remove synthetic.png" })).toBeNull(),
  );
  expect(revoke).toHaveBeenCalledWith("blob:synthetic.png");
  expect(revoke).toHaveBeenCalledWith("blob:synthetic.mp4");
  expect(api.uploads.remove).toHaveBeenCalledTimes(1);
});
