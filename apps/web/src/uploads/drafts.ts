import { UPLOAD_LIMITS, validUploadName } from "@pitcrew/protocol";
import type { AttachmentDraft } from "../Composer";
import type { UploadApi } from "./api";
export class UploadDrafts {
  private entries = new Map<
    string,
    {
      thread: string;
      file: File;
      url?: string;
      controller?: AbortController;
      attempt: number;
      expiryTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private api: UploadApi,
    private update: (
      thread: string,
      mutate: (items: AttachmentDraft[]) => AttachmentDraft[],
    ) => void,
  ) {}
  add(thread: string, files: File[], current: AttachmentDraft[]) {
    if (current.length + files.length > UPLOAD_LIMITS.count)
      throw Error("Attach at most four files.");
    if (
      current.reduce((total, item) => total + (item.size ?? 0), 0) +
        files.reduce((total, file) => total + file.size, 0) >
      UPLOAD_LIMITS.totalBytes
    )
      throw Error("Attachments exceed the 16 MiB combined limit.");
    for (const file of files)
      if (!validUploadName(file.name) || !file.size || file.size > UPLOAD_LIMITS.fileBytes)
        throw Error("Choose files with valid names, from 1 byte to 8 MiB each.");
    const drafts = files.map((file): AttachmentDraft => {
      const id = crypto.randomUUID();
      const video = ["video/mp4", "video/webm", "video/ogg"].includes(file.type);
      const preview =
        (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || video) &&
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      this.entries.set(id, { thread, file, url: preview, attempt: 0 });
      return {
        id,
        name: file.name,
        size: file.size,
        preview,
        video,
        status: "uploading",
        progress: 0,
      };
    });
    this.update(thread, (items) => [...items, ...drafts]);
    // The authenticated local relay has a single mutation slot. Serialize uploads.
    void this.runBatch(drafts.map((item) => item.id));
  }
  private queue = Promise.resolve();
  private runBatch(ids: string[]) {
    this.queue = this.queue.then(async () => {
      for (const id of ids) await this.upload(id);
    });
    return this.queue;
  }
  retry(id: string) {
    void this.runBatch([id]);
  }
  freezeExpiry(ids: string[]) {
    // A send can commit even when its response is lost. Preserve its unchanged
    // idempotent replay; the server still enforces expiry for unlinked stages.
    for (const id of ids) clearTimeout(this.entries.get(id)?.expiryTimer);
  }
  private async upload(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    const attempt = ++entry.attempt;
    entry.controller?.abort();
    clearTimeout(entry.expiryTimer);
    entry.controller = new AbortController();
    const patch = (value: Partial<AttachmentDraft>) => {
      if (this.entries.get(id) === entry && entry.attempt === attempt)
        this.update(entry.thread, (items) =>
          items.map((item) => (item.id === id ? { ...item, ...value } : item)),
        );
    };
    patch({ status: "uploading", progress: 0, error: undefined });
    try {
      const receipt = await this.api.put(
        entry.thread,
        id,
        entry.file,
        entry.controller.signal,
        (progress) => patch({ progress }),
      );
      if (this.entries.get(id) !== entry) {
        void this.api.remove(entry.thread, id).catch(() => {});
        return;
      }
      entry.expiryTimer = setTimeout(
        () => patch({ status: "error", error: "Upload expired. Retry to upload it again." }),
        Math.max(0, receipt.expiresAt - Date.now()),
      );
      patch({ status: "ready", progress: 100, upload: receipt, attachment: { uploadId: id } });
    } catch {
      patch({ status: "error", error: "Upload failed. Retry or remove the file." });
    }
  }
  remove(id: string, deleteRemote = true) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.controller?.abort();
    clearTimeout(entry.expiryTimer);
    if (entry.url) URL.revokeObjectURL(entry.url);
    if (deleteRemote) void this.api.remove(entry.thread, id).catch(() => {});
  }
  dispose() {
    for (const id of this.entries.keys()) this.remove(id);
  }
}
